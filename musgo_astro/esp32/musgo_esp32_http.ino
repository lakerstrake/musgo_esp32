#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
// Sensor ambiental por I2C con AUTO-DETECCION del chip:
//   - BME280 -> temperatura + presion + HUMEDAD del aire
//   - BMP280 -> temperatura + presion (sin humedad: no tiene ese sensor)
// Instala AMBAS librerias: "Adafruit BMP280" y "Adafruit BME280".
#include <Adafruit_BMP280.h>
#include <Adafruit_BME280.h>
Adafruit_BMP280 bmp;
Adafruit_BME280 bme;

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

// I2C para el sensor ambiental BMP280 (evita el GPIO22 del buzzer)
const int PIN_SDA = 21;
const int PIN_SCL = 19;

// true  = buzzer PASIVO  -> tonos reales (recomendado)
// false = buzzer ACTIVO  -> solo enciende/apaga (se distingue por el ritmo)
#define USAR_TONO true

// Calibración POR DEFECTO (para musgo). Se puede cambiar desde la web:
// el servidor devuelve dryRaw/wetRaw en cada respuesta y el ESP32 se reajusta solo.
const int CAL_SECO_DEF   = 2515; // ADC con musgo seco  -> 0 %
const int CAL_HUMEDO_DEF = 1128; // ADC con musgo mojado -> 100 %
int dryRaw = CAL_SECO_DEF;
int wetRaw = CAL_HUMEDO_DEF;

const int UMBRAL_SECO    = 30;
const int UMBRAL_HUMEDO  = 60;

// Estados: 0 = SECO, 1 = MEDIO, 2 = HUMEDO
int   humedad = 50;
int   crudoActual = 0;       // ultima lectura cruda del ADC
float humedadEMA = -1;       // filtro suavizado (evita saltos por ruido)
unsigned long tSensor = 0;
unsigned long tSerial = 0;
int  estadoAnterior = -1;
unsigned long tProxAlerta = 0;

// --- Sensor ambiental BMP280 / BME280 (auto-deteccion) ---
bool  bmpOK = false;
bool  usandoBme = false;   // true si el chip es BME280 (mide humedad del aire)
float tempC = 0, presionHpa = 0, airHumPct = 0;
unsigned long tBmp = 0;

// ===================== Sistema de sonido =====================
struct Nota { int freq; int dur; };  // freq 0 = silencio, dur 0 = fin

Nota sostHumedo[] = {{784, 90}, {0, 40}, {1175, 170}, {0, 0}};                               // "check" suave
Nota sostMedio[]  = {{988, 120}, {0, 90}, {988, 120}, {0, 0}};                               // doble beep medio
Nota sostSeco[]   = {{1568, 80}, {0, 45}, {2093, 80}, {0, 45}, {2637, 190}, {0, 0}};          // rafaga aguda urgente

Nota entradaHumedo[] = {{1318, 70}, {0, 45}, {1760, 70}, {0, 130}, {784, 90}, {0, 40}, {1175, 200}, {0, 0}};
Nota entradaMedio[]  = {{1318, 70}, {0, 45}, {1760, 70}, {0, 130}, {988, 130}, {0, 90}, {988, 130}, {0, 0}};
Nota entradaSeco[]   = {{1318, 70}, {0, 45}, {1760, 70}, {0, 130}, {1568, 80}, {0, 45}, {2093, 80}, {0, 45}, {2637, 220}, {0, 0}};

const unsigned long intervaloAlerta[3] = {4000, 12000, 30000}; // SECO, MEDIO, HUMEDO
Nota* entradaPorEstado[3]   = {entradaSeco, entradaMedio, entradaHumedo};
Nota* sostenidoPorEstado[3] = {sostSeco, sostMedio, sostHumedo};

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
    if (melodia[melIdx].dur <= 0) { buzzerOff(); melActiva = false; return; }
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
  // dryRaw -> 0 % ,  wetRaw -> 100 %  (mas seco = ADC mas alto en estos sensores)
  int h = map(crudo, dryRaw, wetRaw, 0, 100);
  return constrain(h, 0, 100);
}

// Extrae un entero "clave":N de un texto JSON simple (sin libreria).
long extraerEntero(const String& s, const char* clave, long porDefecto) {
  String pat = String("\"") + clave + "\":";
  int i = s.indexOf(pat);
  if (i < 0) return porDefecto;
  i += pat.length();
  while (i < (int)s.length() && s[i] == ' ') i++;
  long sign = 1;
  if (i < (int)s.length() && s[i] == '-') { sign = -1; i++; }
  long val = 0; bool any = false;
  while (i < (int)s.length() && isDigit(s[i])) { val = val * 10 + (s[i] - '0'); i++; any = true; }
  return any ? sign * val : porDefecto;
}

// ===================== Envio a la nube =====================
void enviarDato(float h, int estado, int crudo) {
  if (WiFi.status() != WL_CONNECTED) { Serial.println("[POST] Saltado: WiFi NO conectado"); return; }
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(10000);

  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(8000);
  http.setTimeout(10000);
  if (!http.begin(client, serverUrl)) { Serial.println("[POST] http.begin() fallo. URL: " + String(serverUrl)); return; }
  http.addHeader("Content-Type", "application/json");

  String payload = "{";
  payload += "\"humidity\":" + String(h, 0) + ",";
  payload += "\"state\":" + String(estado) + ",";
  payload += "\"raw\":" + String(crudo) + ",";
  payload += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  if (bmpOK) {
    payload += "\"temp\":" + String(tempC, 1) + ",";
    payload += "\"pressure\":" + String(presionHpa, 1) + ",";
    if (usandoBme) payload += "\"airHum\":" + String(airHumPct, 0) + ",";
  }
  payload += "\"device\":\"" + String(deviceId) + "\",";
  payload += "\"ts\":" + String(millis());
  payload += "}";

  int httpCode = http.POST(payload);
  if (httpCode > 0) {
    String resp = http.getString();
    Serial.println("[POST] OK codigo=" + String(httpCode) + " -> " + resp);
    // El servidor devuelve la calibracion: el sensor se reajusta solo.
    long d = extraerEntero(resp, "dryRaw", -1);
    long w = extraerEntero(resp, "wetRaw", -1);
    if (d >= 0 && d <= 4095 && w >= 0 && w <= 4095 && abs((int)(d - w)) >= 200) {
      if ((int)d != dryRaw || (int)w != wetRaw) {
        dryRaw = (int)d; wetRaw = (int)w;
        Serial.println("[CAL] Calibracion actualizada desde la web: seco=" + String(dryRaw) + "  humedo=" + String(wetRaw));
      }
    }
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

  analogReadResolution(12);                       // ADC 0..4095
  analogSetPinAttenuation(PIN_SENSOR, ADC_11db);  // rango completo ~0..3.3V

  // Sensor ambiental BMP280 por I2C (SDA=21, SCL=19)
  Wire.begin(PIN_SDA, PIN_SCL);
  // Auto-deteccion: primero BME280 (con humedad del aire), si no BMP280.
  if (bme.begin(0x76) || bme.begin(0x77)) {
    usandoBme = true; bmpOK = true;
    Serial.println("BME280 detectado (temp + presion + humedad del aire)");
  } else if (bmp.begin(0x76) || bmp.begin(0x77)) {
    usandoBme = false; bmpOK = true;
    bmp.setSampling(Adafruit_BMP280::MODE_NORMAL, Adafruit_BMP280::SAMPLING_X2,
                    Adafruit_BMP280::SAMPLING_X16, Adafruit_BMP280::FILTER_X16,
                    Adafruit_BMP280::STANDBY_MS_500);
    Serial.println("BMP280 detectado (temp + presion; SIN humedad del aire por hardware)");
  } else {
    bmpOK = false;
    Serial.println("Sensor ambiental NO detectado (revisa cableado/direccion 0x76 o 0x77)");
  }

  ledcAttach(PIN_R, 5000, 8);
  ledcAttach(PIN_G, 5000, 8);
  ledcAttach(PIN_B, 5000, 8);

  Serial.println("=== Inicia la obra: Musgo que respira ===");

  color(255, 255, 255);
  Nota boot[] = {{523, 90}, {0, 30}, {784, 90}, {0, 30}, {1047, 160}, {0, 0}};
  tocar(boot);
  while (melActiva) { actualizarSonido(); delay(2); }
  color(0, 0, 0);

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid);
  Serial.print("Conectando a WiFi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) { Serial.print('.'); delay(500); }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi conectado");
    Serial.print("IP: ");      Serial.println(WiFi.localIP());
    Serial.print("RSSI: ");    Serial.println(WiFi.RSSI());
    Serial.println(">>> Prueba de envio inmediata (mira [POST]):");
    enviarDato(50, 1, leerSensor());
  } else {
    Serial.println("\nNo se conecto a WiFi (revisa el nombre de la red 'ssid')");
  }
}

// ===================== Loop =====================
void loop() {
  unsigned long ahora = millis();
  actualizarSonido();

  static unsigned long tReconexion = 0;
  if (WiFi.status() != WL_CONNECTED && ahora - tReconexion >= 5000) {
    tReconexion = ahora; WiFi.disconnect(); WiFi.begin(ssid);
  }

  if (ahora - tSensor >= 250) {
    tSensor = ahora;
    int crudo = leerSensor();
    crudoActual = crudo;
    int hNueva = calcularHumedad(crudo);
    humedadEMA = (humedadEMA < 0) ? hNueva : (humedadEMA * 0.7f + hNueva * 0.3f); // suavizado
    humedad = (int)round(humedadEMA);
    colorPorHumedad(humedad);

    int estadoActual = (humedad < UMBRAL_SECO) ? 0 : (humedad < UMBRAL_HUMEDO ? 1 : 2);

    if (estadoActual != estadoAnterior) {                 // cambio: identificador + alerta
      estadoAnterior = estadoActual;
      tocar(entradaPorEstado[estadoActual]);
      tProxAlerta = ahora + intervaloAlerta[estadoActual];
    }

    static unsigned long lastSend = 0;
    if (ahora - lastSend >= 1500) { lastSend = ahora; enviarDato(humedad, estadoActual, crudo); } // muestreo mas rapido
  }

  // Lectura ambiental BMP280 (cambia lento: cada 1 s basta)
  if (bmpOK && ahora - tBmp >= 1000) {
    tBmp = ahora;
    if (usandoBme) {
      tempC = bme.readTemperature();
      presionHpa = bme.readPressure() / 100.0f;
      airHumPct = bme.readHumidity();
    } else {
      tempC = bmp.readTemperature();
      presionHpa = bmp.readPressure() / 100.0f;
    }
  }

  int estado = (humedad < UMBRAL_SECO) ? 0 : (humedad < UMBRAL_HUMEDO ? 1 : 2);
  if (!melActiva && ahora >= tProxAlerta) {                // se mantiene: repetir alerta
    tocar(sostenidoPorEstado[estado]);
    tProxAlerta = ahora + intervaloAlerta[estado];
  }

  if (ahora - tSerial >= 1000) {
    tSerial = ahora;
    Serial.print("Humedad: "); Serial.print(humedad); Serial.print(" %  (ADC ");
    Serial.print(crudoActual); Serial.print(")  -> ");
    Serial.print(estado == 0 ? "SECO" : (estado == 1 ? "MEDIO" : "HUMEDO"));
    if (bmpOK) {
      Serial.print("  T="); Serial.print(tempC, 1); Serial.print("C  P="); Serial.print(presionHpa, 1); Serial.print("hPa");
      if (usandoBme) { Serial.print("  Haire="); Serial.print(airHumPct, 0); Serial.print("%"); }
    }
    Serial.println();
  }
}
