#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

// Ajustes de red
const char* ssid = "UNAL"; // red abierta
// Reemplaza por la URL real de tu Worker (la imprime `wrangler deploy`):
const char* serverUrl = "https://musgoesp32.jmlagos2003.workers.dev/api/data";
const char* deviceId  = "musgo-01"; // identificador de este dispositivo

// Pines y calibración (mismo código original)
const bool MODO_PRUEBA = false;
const bool CATODO_COMUN = false; 

const int PIN_SENSOR = 34;
const int PIN_R      = 25;
const int PIN_G      = 26;
const int PIN_B      = 27;
const int PIN_BUZZER = 22; 

const int LECTURA_SECO   = 2515;   
const int LECTURA_HUMEDO = 1128;   
const int UMBRAL_SECO    = 30;     
const int UMBRAL_HUMEDO  = 60;     

int  humedad = 50;                 
unsigned long tSensor = 0;         
unsigned long tSerial = 0;         
unsigned long tSiguienteRitmo = 0; 
int estadoAnterior = -1;

int* ritmoActual = nullptr;
int indicePaso = 0;
unsigned long tPaso = 0;
bool tocandoRitmo = false;
bool estadoBuzzer = false;

int ritmoFeliz[]   = {80, 80, 80, 80, 80, 0}; 
int ritmoNormal[]  = {150, 200, 150, 0};
int ritmoTriste[]  = {1000, 300, 1000, 300, 2000, 0};

void color(int r, int g, int b) {
  if (!CATODO_COMUN) { r = 255 - r; g = 255 - g; b = 255 - b; }
  ledcWrite(PIN_R, r);
  ledcWrite(PIN_G, g);
  ledcWrite(PIN_B, b);
}

int leerSensor() {
  long suma = 0;
  for (int i = 0; i < 16; i++) suma += analogRead(PIN_SENSOR);
  return suma / 16;
}

int calcularHumedad(int crudo) {
  int h = map(crudo, LECTURA_SECO, LECTURA_HUMEDO, 0, 100);
  return constrain(h, 0, 100);
}

void colorPorHumedad(int h) {
  int r, g, b;
  if (h < 50) { r = 255; g = map(h, 0, 50, 0, 180); b = 0; }
  else        { r = map(h, 50, 100, 180, 0); g = 255; b = 0; }
  color(r, g, b);
}

void iniciarRitmo(int* ritmo) {
  if (tocandoRitmo) return;
  ritmoActual = ritmo;
  indicePaso = 0;
  tocandoRitmo = true;
  estadoBuzzer = true;
  digitalWrite(PIN_BUZZER, HIGH);
  tPaso = millis();
}

void actualizarReproductor() {
  if (!tocandoRitmo) return;
  unsigned long ahora = millis();
  if (ahora - tPaso >= ritmoActual[indicePaso]) {
    indicePaso++;
    if (ritmoActual[indicePaso] == 0) { 
      tocandoRitmo = false;
      digitalWrite(PIN_BUZZER, LOW);
      estadoBuzzer = false;
    } else { 
      estadoBuzzer = !estadoBuzzer;
      digitalWrite(PIN_BUZZER, estadoBuzzer ? HIGH : LOW);
      tPaso = ahora;
    }
  }
}

void enviarDato(float h, int estado) {
  if (WiFi.status() != WL_CONNECTED) return;
  WiFiClientSecure client;
  client.setInsecure(); // *.workers.dev usa TLS válido; omitimos validar el certificado (sin ello fallaría)
  HTTPClient http;
  http.begin(client, serverUrl);
  http.addHeader("Content-Type", "application/json");

  String payload = "{";
  payload += "\"humidity\":" + String(h, 0) + ",";
  payload += "\"state\":" + String(estado) + ",";
  payload += "\"device\":\"" + String(deviceId) + "\",";
  payload += "\"ts\":" + String(millis());
  payload += "}";

  int httpCode = http.POST(payload);
  if (httpCode > 0) {
    // opcional: leer respuesta
    String resp = http.getString();
    Serial.println("POST OK: " + String(httpCode) + " -> " + resp);
  } else {
    Serial.println("POST fallo: " + String(httpCode));
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(300);

  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);

  ledcAttach(PIN_R, 5000, 8);
  ledcAttach(PIN_G, 5000, 8);
  ledcAttach(PIN_B, 5000, 8);

  Serial.println("=== Inicia la obra ===");
  color(255, 255, 255); 
  digitalWrite(PIN_BUZZER, HIGH); delay(100); digitalWrite(PIN_BUZZER, LOW);
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
    Serial.print("IP: "); Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nNo se conectó a WiFi");
  }
}

void loop() {
  unsigned long ahora = millis();
  actualizarReproductor();

  // Reconexión WiFi automática (sin bloquear el resto del loop)
  static unsigned long tReconexion = 0;
  if (WiFi.status() != WL_CONNECTED && ahora - tReconexion >= 5000) {
    tReconexion = ahora;
    WiFi.disconnect();
    WiFi.begin(ssid);
  }

  if (ahora - tSensor >= 50) {
    tSensor = ahora;
    int crudo = leerSensor();
    humedad = calcularHumedad(crudo);
    colorPorHumedad(humedad);

    int estadoActual = 0;
    if (humedad < UMBRAL_SECO)        estadoActual = 0;
    else if (humedad < UMBRAL_HUMEDO) estadoActual = 1;
    else                              estadoActual = 2;

    if (estadoActual != estadoAnterior) {
      estadoAnterior = estadoActual;
      tocandoRitmo = false;
      digitalWrite(PIN_BUZZER, LOW);
      tSiguienteRitmo = ahora;
    }

    // Enviar dato a servidor cada 2s (o cuando cambie)
    static unsigned long lastSend = 0;
    if (ahora - lastSend >= 500) {
      lastSend = ahora;
      enviarDato(humedad, estadoActual);
    }
  }

  if (!tocandoRitmo && ahora >= tSiguienteRitmo) {
    if (humedad < UMBRAL_SECO) {                        
      iniciarRitmo(ritmoTriste);
      tSiguienteRitmo = ahora + 5000;  
    } else if (humedad < UMBRAL_HUMEDO) {              
      iniciarRitmo(ritmoNormal);
      tSiguienteRitmo = ahora + 10000; 
    } else {                                           
      iniciarRitmo(ritmoFeliz);
      tSiguienteRitmo = ahora + 15000; 
    }
  }

  if (ahora - tSerial >= 1000) {
    tSerial = ahora;
    Serial.print("Humedad: "); Serial.print(humedad); Serial.print(" %  -> ");
    if      (humedad < UMBRAL_SECO)   Serial.println("SECO");
    else if (humedad < UMBRAL_HUMEDO) Serial.println("MEDIO");
    else                               Serial.println("HUMEDO");
  }
}