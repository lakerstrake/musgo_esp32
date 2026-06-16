#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

// ===================== Ajustes de red =====================
const char* ssid = "UNAL"; // red abierta
// Reemplaza por la URL real de tu Worker (la imprime `wrangler deploy`):
const char* serverUrl = "https://musgoesp32.jmlagos2003.workers.dev/api/data";
const char* deviceId  = "musgo-01"; // identificador de este dispositivo

// ===================== Pines y calibración =====================
const bool CATODO_COMUN = false;

const int PIN_SENSOR = 34;
const int PIN_R      = 25;
const int PIN_G      = 26;
const int PIN_B      = 27;
const int PIN_BUZZER = 22;

// true  = buzzer PASIVO  -> tonos reales (recomendado para este diseño)
// false = buzzer ACTIVO  -> solo enciende/apaga (se distingue por el ritmo)
#define USAR_TONO true

const int LECTURA_SECO   = 2515;
const int LECTURA_HUMEDO = 1128;
const int UMBRAL_SECO    = 30;
const int UMBRAL_HUMEDO  = 60;

// Estados: 0 = SECO, 1 = MEDIO, 2 = HUMEDO
int  humedad = 50;
unsigned long tSensor = 0;
unsigned long tSerial = 0;
int  estadoAnterior = -1;
unsigned long tProxAlerta = 0;

// ===================== Sistema de sonido =====================
// Una "nota" = frecuencia (Hz) y duracion (ms). freq 0 = silencio. dur 0 = fin.
struct Nota { int freq; int dur; };

// --- Patrones de "sostenido" (se repiten mientras el estado se mantiene) ---
// HUMEDO: "check" agradable y suave (quinta justa ascendente sol5->re6). Tranquiliza.
Nota sostHumedo[] = {{784, 90}, {0, 40}, {1175, 170}, {0, 0}};
// MEDIO: doble beep neutro de atencion (si5).
Nota sostMedio[]  = {{988, 120}, {0, 90}, {988, 120}, {0, 0}};
// SECO: rafaga aguda ascendente, urgente (sol6->do7->mi7).
Nota sostSeco[]   = {{1568, 80}, {0, 45}, {2093, 80}, {0, 45}, {2637, 190}, {0, 0}};

// --- Identificador de CAMBIO de estado: "ding-dong" ascendente (mi6->la6) ---
// Se reproduce ANTES de la alerta del nuevo estado, asi se nota que "cambio algo".
Nota entradaHumedo[] = {{1318, 70}, {0, 45}, {1760, 70}, {0, 130}, {784, 90}, {0, 40}, {1175, 200}, {0, 0}};
Nota entradaMedio[]  = {{1318, 70}, {0, 45}, {1760, 70}, {0, 130}, {988, 130}, {0, 90}, {988, 130}, {0, 0}};
Nota entradaSeco[]   = {{1318, 70}, {0, 45}, {1760, 70}, {0, 130}, {1568, 80}, {0, 45}, {2093, 80}, {0, 45}, {2637, 220}, {0, 0}};

// Cada cuanto se repite la alerta de cada estado (ms). SECO insiste; HUMEDO casi calla.
const unsigned long intervaloAlerta[3] = {4000, 12000, 30000}; // SECO, MEDIO, HUMEDO

Nota* entradaPorEstado[3]  = {entradaSeco, entradaMedio, entradaHumedo};
Nota* sostenidoPorEstado[3] = {sostSeco, sostMedio, sostHumedo};

// Reproductor NO bloqueante
Nota* melodia = nullptr;
int   melIdx = 0;
unsigned long melT = 0;
bool  melActiva = false;

void buzzerOn(int f) { if (USAR_TONO) tone(PIN_BUZZER, f); else digitalWrite(PIN_BUZZER, HIGH); }
void buzzerOff()     { if (USAR_TONO) noTone(PIN_BUZZER);   else digitalWrite(PIN_BUZZER, LOW); }

void tocar(Nota* m) {
  melodia = m; melIdx = 0; melActiva = true; melT = millis();
  if (m[0].freq > 0) buzzerOn(m[0].freq); else buzzerOff();
}

void actualizarSonido() {
  if (!melActiva) return;
  if (millis() - melT >= (unsigned long)melodia[melIdx].dur) {
    melIdx++;
    if (melodia[melIdx].dur <= 0) { buzzerOff(); melActiva = false; return; } // fin
    melT = millis();
    if (melodia[melIdx].freq > 0) buzzerOn(melodia[melIdx].freq); else buzzerOff();
  }
}

// ===================== LED RGB =====================
void color(int r, int g, int b) {
  if (!CATODO_COMUN) { r = 255 - r; g = 255 - g; b = 255 - b; }
  ledcWrite(PIN_R, r);
  ledcWrite(PIN_G, g);
  ledcWrite(PIN_B, b);
}

void colorPorHumedad(int h) {
  int r, g, b;
  if (h < 50) { r = 255; g = map(h, 0, 50, 0, 180); b = 0; }
  else        { r = map(h, 50, 100, 180, 0); g = 255; b = 0; }
  color(r, g, b);
}

// ===================== Sensor =====================
int leerSensor() {
  long suma = 0;
  for (int i = 0; i < 16; i++) suma += analogRead(PIN_SENSOR);
  return suma / 16;
}

int calcularHumedad(int crudo) {
  int h = map(crudo, LECTURA_SECO, LECTURA_HUMEDO, 0, 100);
  return constrain(h, 0, 100);
}

// ===================== Envio a la nube =====================
void enviarDato(float h, int estado) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[POST] Saltado: WiFi NO conectado");
    return;
  }
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(10000);

  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(8000);
  http.setTimeout(10000);
  if (!http.begin(client, serverUrl)) {
    Serial.println("[POST] http.begin() fallo. URL: " + String(serverUrl));
    return;
  }
  http.addHeader("Content-Type", "application/json");

  String payload = "{";
  payload += "\"humidity\":" + String(h, 0) + ",";
  payload += "\"state\":" + String(estado) + ",";
  payload += "\"device\":\"" + String(deviceId) + "\",";
  payload += "\"ts\":" + String(millis());
  payload += "}";

  int httpCode = http.POST(payload);
  if (httpCode > 0) {
    String resp = http.getString();
    Serial.println("[POST] OK codigo=" + String(httpCode) + " -> " + resp);
    if (httpCode >= 300 && httpCode < 400)
      Serial.println("[POST] AVISO: redireccion -> posible PORTAL CAUTIVO en la red WiFi");
  } else {
    Serial.println("[POST] ERROR codigo=" + String(httpCode) + " (" + http.errorToString(httpCode) + ")");
    Serial.println("       Causas tipicas: TLS fallido, sin salida a Internet, o portal cautivo.");
  }
  http.end();
}

// ===================== Setup =====================
void setup() {
  Serial.begin(115200);
  delay(300);

  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);

  ledcAttach(PIN_R, 5000, 8);
  ledcAttach(PIN_G, 5000, 8);
  ledcAttach(PIN_B, 5000, 8);

  Serial.println("=== Inicia la obra: Musgo que respira ===");

  // Sonido de encendido (do5 -> sol5 -> do6 ascendente)
  color(255, 255, 255);
  Nota boot[] = {{523, 90}, {0, 30}, {784, 90}, {0, 30}, {1047, 160}, {0, 0}};
  tocar(boot);
  while (melActiva) { actualizarSonido(); delay(2); }
  color(0, 0, 0);

  // Conectar a WiFi
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid);
  Serial.print("Conectando a WiFi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) {
    Serial.print('.');
    delay(500);
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi conectado");
    Serial.print("IP: ");      Serial.println(WiFi.localIP());
    Serial.print("Gateway: "); Serial.println(WiFi.gatewayIP());
    Serial.print("RSSI: ");    Serial.println(WiFi.RSSI());
    Serial.println(">>> Prueba de envio inmediata (mira [POST]):");
    enviarDato(50, 1);
  } else {
    Serial.println("\nNo se conecto a WiFi (revisa el nombre de la red 'ssid')");
  }
}

// ===================== Loop =====================
void loop() {
  unsigned long ahora = millis();
  actualizarSonido();

  // Reconexion WiFi automatica (no bloqueante)
  static unsigned long tReconexion = 0;
  if (WiFi.status() != WL_CONNECTED && ahora - tReconexion >= 5000) {
    tReconexion = ahora;
    WiFi.disconnect();
    WiFi.begin(ssid);
  }

  if (ahora - tSensor >= 250) {
    tSensor = ahora;
    int crudo = leerSensor();
    humedad = calcularHumedad(crudo);
    colorPorHumedad(humedad);

    int estadoActual = (humedad < UMBRAL_SECO) ? 0 : (humedad < UMBRAL_HUMEDO ? 1 : 2);

    // --- Cambio de estado: identificador + alerta del nuevo estado ---
    if (estadoActual != estadoAnterior) {
      estadoAnterior = estadoActual;
      tocar(entradaPorEstado[estadoActual]);
      tProxAlerta = ahora + intervaloAlerta[estadoActual];
    }

    static unsigned long lastSend = 0;
    if (ahora - lastSend >= 2000) {
      lastSend = ahora;
      enviarDato(humedad, estadoActual);
    }
  }

  // --- Mientras se MANTIENE el estado: repetir su alerta cada intervalo ---
  // (HUMEDO: "check" tranquilo y esporadico; MEDIO: medio; SECO: insistente)
  int estado = (humedad < UMBRAL_SECO) ? 0 : (humedad < UMBRAL_HUMEDO ? 1 : 2);
  if (!melActiva && ahora >= tProxAlerta) {
    tocar(sostenidoPorEstado[estado]);
    tProxAlerta = ahora + intervaloAlerta[estado];
  }

  if (ahora - tSerial >= 1000) {
    tSerial = ahora;
    Serial.print("Humedad: "); Serial.print(humedad); Serial.print(" %  -> ");
    Serial.println(estado == 0 ? "SECO" : (estado == 1 ? "MEDIO" : "HUMEDO"));
  }
}
