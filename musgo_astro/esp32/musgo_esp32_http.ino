#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
// Sensores ambientales por I2C (instala estas librerias):
//   "Adafruit BMP280", "Adafruit BME280", "Adafruit Si7021", "Adafruit Unified Sensor"
//   - Si7021 -> temperatura + HUMEDAD del aire
//   - BME280 -> temperatura + presion + humedad del aire
//   - BMP280 -> temperatura + presion (sin humedad)
#include <Adafruit_BMP280.h>
#include <Adafruit_BME280.h>
#include <Adafruit_Si7021.h>
Adafruit_BMP280 bmp;
Adafruit_BME280 bme;
Adafruit_Si7021 si;

// ===================== Ajustes de red =====================
const char* ssid = "UNAL";
const char* serverUrl = "https://musgoesp32.jmlagos2003.workers.dev/api/data";
const char* deviceId  = "musgo-01";

// ===================== Pines =====================
// Sensor de humedad del musgo (capacitivo 1321v) en pin de entrada analogica
const int PIN_SENSOR = 34;

// Modulo RGB 1 (ANODO comun, alimentado por D27): color por humedad del MUSGO
const int RGB1_R = 25, RGB1_G = 26, RGB1_B = 14, RGB1_PWR = 27;
const bool RGB1_ANODO = true;

// Modulo RGB 2 (CATODO comun a GND): color por humedad del AIRE (Si7021)
const int RGB2_R = 2, RGB2_G = 4, RGB2_B = 16;
const bool RGB2_ANODO = false;

// Modulo bicolor rojo/amarillo (comun a GND): semaforo de ALERTA
const int BI_ROJO = 5, BI_AMARILLO = 18;

// Buzzer
const int PIN_BUZZER = 22;

// I2C (BMP280/BME280 + Si7021):  SDA=D19, SCL=D21
const int PIN_SDA = 19;
const int PIN_SCL = 21;

#define USAR_TONO true   // buzzer pasivo (tonos). false = activo (solo on/off)

// ===================== Calibración del musgo =====================
const int CAL_SECO_DEF = 2515, CAL_HUMEDO_DEF = 1128;
int dryRaw = CAL_SECO_DEF, wetRaw = CAL_HUMEDO_DEF;
const int UMBRAL_SECO = 30, UMBRAL_HUMEDO = 60;

// Estados: 0 = SECO, 1 = MEDIO, 2 = HUMEDO
int   humedad = 50, crudoActual = 0, estadoAnterior = -1;
float humedadEMA = -1;
unsigned long tSensor = 0, tSerial = 0, tProxAlerta = 0, tBmp = 0;

// Sensores ambientales
bool  bmpOK = false, si7021OK = false, usandoBme = false, haveAir = false;
float tempC = 0, presionHpa = 0, airHumPct = 0;

// ===================== Sistema de sonido =====================
struct Nota { int freq; int dur; };
Nota sostHumedo[] = {{784, 90}, {0, 40}, {1175, 170}, {0, 0}};
Nota sostMedio[]  = {{988, 120}, {0, 90}, {988, 120}, {0, 0}};
Nota sostSeco[]   = {{1568, 80}, {0, 45}, {2093, 80}, {0, 45}, {2637, 190}, {0, 0}};
Nota entradaHumedo[] = {{1318, 70}, {0, 45}, {1760, 70}, {0, 130}, {784, 90}, {0, 40}, {1175, 200}, {0, 0}};
Nota entradaMedio[]  = {{1318, 70}, {0, 45}, {1760, 70}, {0, 130}, {988, 130}, {0, 90}, {988, 130}, {0, 0}};
Nota entradaSeco[]   = {{1318, 70}, {0, 45}, {1760, 70}, {0, 130}, {1568, 80}, {0, 45}, {2093, 80}, {0, 45}, {2637, 220}, {0, 0}};
const unsigned long intervaloAlerta[3] = {4000, 12000, 30000};
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

// ===================== LEDs =====================
void pwm(int pin) { ledcAttach(pin, 5000, 8); }
void wr(int pin, int v, bool anodo) { ledcWrite(pin, anodo ? 255 - v : v); }   // anodo comun = invertido
void rgb1(int r, int g, int b) { wr(RGB1_R, r, RGB1_ANODO); wr(RGB1_G, g, RGB1_ANODO); wr(RGB1_B, b, RGB1_ANODO); }
void rgb2(int r, int g, int b) { wr(RGB2_R, r, RGB2_ANODO); wr(RGB2_G, g, RGB2_ANODO); wr(RGB2_B, b, RGB2_ANODO); }
void bicolor(int estado) {       // 0 seco->rojo, 1 medio->amarillo, 2 humedo->apagado
  digitalWrite(BI_ROJO,     estado == 0 ? HIGH : LOW);
  digitalWrite(BI_AMARILLO, estado == 1 ? HIGH : LOW);
}
void colorHumedad(int h, int &r, int &g, int &b) {
  if (h < 50) { r = 255; g = map(h, 0, 50, 0, 180); b = 0; }
  else        { r = map(h, 50, 100, 180, 0); g = 255; b = 0; }
}

// ===================== Sensor del musgo =====================
int leerSensor() {
  long suma = 0;
  for (int i = 0; i < 16; i++) suma += analogRead(PIN_SENSOR);
  return suma / 16;
}
int calcularHumedad(int crudo) {
  int h = map(crudo, dryRaw, wetRaw, 0, 100);
  return constrain(h, 0, 100);
}

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
  if (si7021OK || bmpOK) payload += "\"temp\":" + String(tempC, 1) + ",";
  if (bmpOK)             payload += "\"pressure\":" + String(presionHpa, 1) + ",";
  if (haveAir)           payload += "\"airHum\":" + String(airHumPct, 0) + ",";
  payload += "\"device\":\"" + String(deviceId) + "\",";
  payload += "\"ts\":" + String(millis());
  payload += "}";

  int httpCode = http.POST(payload);
  if (httpCode > 0) {
    String resp = http.getString();
    Serial.println("[POST] OK codigo=" + String(httpCode) + " -> " + resp);
    long d = extraerEntero(resp, "dryRaw", -1);
    long w = extraerEntero(resp, "wetRaw", -1);
    if (d >= 0 && d <= 4095 && w >= 0 && w <= 4095 && abs((int)(d - w)) >= 200) {
      if ((int)d != dryRaw || (int)w != wetRaw) {
        dryRaw = (int)d; wetRaw = (int)w;
        Serial.println("[CAL] Calibracion actualizada: seco=" + String(dryRaw) + "  humedo=" + String(wetRaw));
      }
    }
  } else {
    Serial.println("[POST] ERROR codigo=" + String(httpCode) + " (" + http.errorToString(httpCode) + ")");
  }
  http.end();
}

// ===================== Setup =====================
void setup() {
  Serial.begin(115200);
  delay(300);

  // LEDs
  pwm(RGB1_R); pwm(RGB1_G); pwm(RGB1_B);
  pwm(RGB2_R); pwm(RGB2_G); pwm(RGB2_B);
  pinMode(RGB1_PWR, OUTPUT); digitalWrite(RGB1_PWR, HIGH); // alimenta el RGB1 (anodo comun)
  pinMode(BI_ROJO, OUTPUT); pinMode(BI_AMARILLO, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT); digitalWrite(PIN_BUZZER, LOW);

  // ADC del sensor del musgo
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_SENSOR, ADC_11db);

  // I2C: SDA=19, SCL=21 (coincide con el cableado actual)
  Wire.begin(PIN_SDA, PIN_SCL);
  si7021OK = si.begin();
  if (bme.begin(0x76) || bme.begin(0x77)) {
    usandoBme = true; bmpOK = true;
  } else if (bmp.begin(0x76) || bmp.begin(0x77)) {
    bmpOK = true;
    bmp.setSampling(Adafruit_BMP280::MODE_NORMAL, Adafruit_BMP280::SAMPLING_X2,
                    Adafruit_BMP280::SAMPLING_X16, Adafruit_BMP280::FILTER_X16,
                    Adafruit_BMP280::STANDBY_MS_500);
  }
  haveAir = si7021OK || usandoBme;

  Serial.println("=== Musgo que respira ===");
  Serial.print("Si7021: "); Serial.println(si7021OK ? "OK (temp + humedad aire)" : "no");
  Serial.print("Presion: "); Serial.println(bmpOK ? (usandoBme ? "BME280" : "BMP280") : "no");

  // Test de LEDs + sonido de encendido
  rgb1(255, 255, 255); rgb2(255, 255, 255); bicolor(0);
  Nota boot[] = {{523, 90}, {0, 30}, {784, 90}, {0, 30}, {1047, 160}, {0, 0}};
  tocar(boot);
  while (melActiva) { actualizarSonido(); delay(2); }
  rgb1(0, 0, 0); rgb2(0, 0, 0); digitalWrite(BI_ROJO, LOW);

  // WiFi
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid);
  Serial.print("Conectando a WiFi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) { Serial.print('.'); delay(500); }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi OK  IP: " + WiFi.localIP().toString() + "  RSSI: " + String(WiFi.RSSI()));
    enviarDato(50, 1, leerSensor());
  } else {
    Serial.println("\nNo se conecto a WiFi");
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

  // Lectura de sensores ambientales (cambian lento: cada 1 s)
  if (bmpOK || si7021OK) {
    if (ahora - tBmp >= 1000) {
      tBmp = ahora;
      if (si7021OK) { tempC = si.readTemperature(); airHumPct = si.readHumidity(); }
      if (bmpOK) {
        if (usandoBme) { presionHpa = bme.readPressure() / 100.0f; if (!si7021OK) { tempC = bme.readTemperature(); airHumPct = bme.readHumidity(); } }
        else           { presionHpa = bmp.readPressure() / 100.0f; if (!si7021OK)   tempC = bmp.readTemperature(); }
      }
    }
  }

  if (ahora - tSensor >= 250) {
    tSensor = ahora;
    int crudo = leerSensor();
    crudoActual = crudo;
    int hNueva = calcularHumedad(crudo);
    humedadEMA = (humedadEMA < 0) ? hNueva : (humedadEMA * 0.7f + hNueva * 0.3f);
    humedad = (int)round(humedadEMA);

    int estadoActual = (humedad < UMBRAL_SECO) ? 0 : (humedad < UMBRAL_HUMEDO ? 1 : 2);

    // LEDs: RGB1 = musgo, RGB2 = aire (o espeja), bicolor = alerta
    int r, g, b; colorHumedad(humedad, r, g, b); rgb1(r, g, b);
    if (haveAir) { int r2, g2, b2; colorHumedad((int)airHumPct, r2, g2, b2); rgb2(r2, g2, b2); }
    else         { rgb2(r, g, b); }
    bicolor(estadoActual);

    if (estadoActual != estadoAnterior) {
      estadoAnterior = estadoActual;
      tocar(entradaPorEstado[estadoActual]);
      tProxAlerta = ahora + intervaloAlerta[estadoActual];
    }

    static unsigned long lastSend = 0;
    if (ahora - lastSend >= 2000) { lastSend = ahora; enviarDato(humedad, estadoActual, crudo); }
  }

  int estado = (humedad < UMBRAL_SECO) ? 0 : (humedad < UMBRAL_HUMEDO ? 1 : 2);
  if (!melActiva && ahora >= tProxAlerta) {
    tocar(sostenidoPorEstado[estado]);
    tProxAlerta = ahora + intervaloAlerta[estado];
  }

  if (ahora - tSerial >= 1000) {
    tSerial = ahora;
    Serial.print("Musgo: "); Serial.print(humedad); Serial.print("% (ADC "); Serial.print(crudoActual); Serial.print(") ");
    Serial.print(estado == 0 ? "SECO" : (estado == 1 ? "MEDIO" : "HUMEDO"));
    if (si7021OK || bmpOK) { Serial.print("  T="); Serial.print(tempC, 1); Serial.print("C"); }
    if (bmpOK)             { Serial.print("  P="); Serial.print(presionHpa, 1); Serial.print("hPa"); }
    if (haveAir)           { Serial.print("  Haire="); Serial.print(airHumPct, 0); Serial.print("%"); }
    Serial.println();
  }
}
