#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
// Librerias: "Adafruit BMP280", "Adafruit BME280", "Adafruit Si7021", "Adafruit Unified Sensor"
#include <Adafruit_BMP280.h>
#include <Adafruit_BME280.h>
#include <Adafruit_Si7021.h>
Adafruit_BMP280 bmp;
Adafruit_BME280 bme;
Adafruit_Si7021 si;

// ===================== Red =====================
const char* ssid = "UNAL";
const char* serverUrl = "https://musgoesp32.jmlagos2003.workers.dev/api/data";
const char* deviceId  = "musgo-01";

// ===================== Pines =====================
const int PIN_SENSOR = 34;                 // sensor humedad del musgo (AOUT)

// RGB 1  -> caja del MUSGO (humedad del suelo)
int RGB1_R = 25, RGB1_G = 26, RGB1_B = 14;
bool RGB1_ANODO = false;                    // false = catodo comun (comun a GND)

// RGB 2  -> caja del Si7021 (humedad del AIRE)
int RGB2_R = 2,  RGB2_G = 4,  RGB2_B = 16;
bool RGB2_ANODO = false;

// Bicolor rojo/amarillo -> caja del BMP280 (temperatura ambiente)
const int BI_ROJO = 5, BI_AMARILLO = 18;

// Buzzer de 3 patas:  S (signal) -> D22 ,  + (medio) -> 3V3 ,  − -> GND
const int PIN_BUZZER = 22;
#define USAR_TONO true                      // buzzer pasivo (tonos)

// I2C (bus compartido por BMP280/BME280 + Si7021):  SDA=D19, SCL=D21
// En I2C ambos conviven: BMP280=0x76/0x77, Si7021=0x40 (direcciones distintas).
const int PIN_SDA = 19, PIN_SCL = 21;

// ===================== Calibración del musgo =====================
const int CAL_SECO_DEF = 2515, CAL_HUMEDO_DEF = 1128;
int dryRaw = CAL_SECO_DEF, wetRaw = CAL_HUMEDO_DEF;
const int UMBRAL_SECO = 30, UMBRAL_HUMEDO = 60;

int   humedad = 50, crudoActual = 0, estadoAnterior = -1;
float humedadEMA = -1;
unsigned long tSensor = 0, tSerial = 0, tProxAlerta = 0, tBmp = 0;

// Sensores (cada uno con su medida por separado)
bool  bmpOK = false, si7021OK = false, usandoBme = false;
float tempSi = NAN, airHum = NAN;          // Si7021
float tempBmp = NAN, presionHpa = NAN;     // BMP280/BME280

// ===================== Sonido =====================
struct Nota { int freq; int dur; };
Nota sostHumedo[] = {{784,90},{0,40},{1175,170},{0,0}};
Nota sostMedio[]  = {{988,120},{0,90},{988,120},{0,0}};
Nota sostSeco[]   = {{1568,80},{0,45},{2093,80},{0,45},{2637,190},{0,0}};
Nota entradaSeco[]  = {{1318,70},{0,45},{1760,70},{0,130},{1568,80},{0,45},{2093,80},{0,45},{2637,220},{0,0}};
Nota entradaMedio[] = {{1318,70},{0,45},{1760,70},{0,130},{988,130},{0,90},{988,130},{0,0}};

// 🎵 Melodía famosa: Star Wars — Marcha Imperial (frase principal)
Nota imperial[] = {
  {392,350},{0,40},{392,350},{0,40},{392,350},{0,40},
  {311,260},{0,20},{466,110},{0,20},{392,420},{0,60},
  {311,260},{0,20},{466,110},{0,20},{392,560},{0,120},
  {587,350},{0,40},{587,350},{0,40},{587,350},{0,40},
  {622,260},{0,20},{466,110},{0,20},{370,420},{0,60},
  {311,260},{0,20},{466,110},{0,20},{392,560},{0,0}
};
const unsigned long intervaloAlerta[3] = {4000, 12000, 30000};
Nota* entradaPorEstado[3]   = {entradaSeco, entradaMedio, imperial}; // HUMEDO -> melodia famosa
Nota* sostenidoPorEstado[3] = {sostSeco, sostMedio, sostHumedo};

Nota* melodia = nullptr; int melIdx = 0; unsigned long melT = 0; bool melActiva = false;
void buzzerOn(int f){ if(USAR_TONO) tone(PIN_BUZZER,f); else digitalWrite(PIN_BUZZER,HIGH); }
void buzzerOff(){ if(USAR_TONO) noTone(PIN_BUZZER); else digitalWrite(PIN_BUZZER,LOW); }
void tocar(Nota* m){ melodia=m; melIdx=0; melActiva=true; melT=millis(); if(m[0].freq>0) buzzerOn(m[0].freq); else buzzerOff(); }
void actualizarSonido(){
  if(!melActiva) return;
  if(millis()-melT >= (unsigned long)melodia[melIdx].dur){
    melIdx++;
    if(melodia[melIdx].dur<=0){ buzzerOff(); melActiva=false; return; }
    melT=millis();
    if(melodia[melIdx].freq>0) buzzerOn(melodia[melIdx].freq); else buzzerOff();
  }
}

// ===================== LEDs =====================
void pwm(int p){ ledcAttach(p,5000,8); }
void wr(int p,int v,bool anodo){ ledcWrite(p, anodo?255-v:v); }
void rgb1(int r,int g,int b){ wr(RGB1_R,r,RGB1_ANODO); wr(RGB1_G,g,RGB1_ANODO); wr(RGB1_B,b,RGB1_ANODO); }
void rgb2(int r,int g,int b){ wr(RGB2_R,r,RGB2_ANODO); wr(RGB2_G,g,RGB2_ANODO); wr(RGB2_B,b,RGB2_ANODO); }
void colorHumedad(int h,int &r,int &g,int &b){
  if(h<50){ r=255; g=map(h,0,50,0,180); b=0; } else { r=map(h,50,100,180,0); g=255; b=0; }
}
// Bicolor segun temperatura del BMP280 (siempre uno encendido si el sensor responde):
//   < 25 C -> amarillo ,  >= 25 C -> rojo
void bicolorTemp(float t){
  if(isnan(t)){ digitalWrite(BI_ROJO,LOW); digitalWrite(BI_AMARILLO,LOW); return; }
  bool hot = t >= 25;
  digitalWrite(BI_ROJO,     hot ? HIGH : LOW);
  digitalWrite(BI_AMARILLO, hot ? LOW  : HIGH);
}
// Test de color al arranque: cada modulo muestra ROJO, VERDE, AZUL (mira y compara)
void testColor(){
  Serial.println("[LED] Test: cada modulo hara ROJO -> VERDE -> AZUL");
  int paso = 500;
  Serial.println("[LED] RGB1 ROJO");  rgb1(255,0,0); delay(paso);
  Serial.println("[LED] RGB1 VERDE"); rgb1(0,255,0); delay(paso);
  Serial.println("[LED] RGB1 AZUL");  rgb1(0,0,255); delay(paso); rgb1(0,0,0);
  Serial.println("[LED] RGB2 ROJO");  rgb2(255,0,0); delay(paso);
  Serial.println("[LED] RGB2 VERDE"); rgb2(0,255,0); delay(paso);
  Serial.println("[LED] RGB2 AZUL");  rgb2(0,0,255); delay(paso); rgb2(0,0,0);
  Serial.println("[LED] Bicolor ROJO");     digitalWrite(BI_ROJO,HIGH);     delay(paso); digitalWrite(BI_ROJO,LOW);
  Serial.println("[LED] Bicolor AMARILLO"); digitalWrite(BI_AMARILLO,HIGH); delay(paso); digitalWrite(BI_AMARILLO,LOW);
}

// ===================== Sensor musgo =====================
int leerSensor(){ long s=0; for(int i=0;i<16;i++) s+=analogRead(PIN_SENSOR); return s/16; }
int calcularHumedad(int crudo){ return constrain(map(crudo,dryRaw,wetRaw,0,100),0,100); }

long extraerEntero(const String& s,const char* clave,long def){
  String pat=String("\"")+clave+"\":"; int i=s.indexOf(pat); if(i<0) return def;
  i+=pat.length(); while(i<(int)s.length()&&s[i]==' ')i++;
  long sign=1; if(i<(int)s.length()&&s[i]=='-'){sign=-1;i++;}
  long v=0; bool any=false; while(i<(int)s.length()&&isDigit(s[i])){v=v*10+(s[i]-'0');i++;any=true;}
  return any?sign*v:def;
}

// ===================== Envio =====================
void enviarDato(float h,int estado,int crudo){
  if(WiFi.status()!=WL_CONNECTED){ Serial.println("[POST] WiFi NO conectado"); return; }
  WiFiClientSecure client; client.setInsecure(); client.setTimeout(10000);
  HTTPClient http; http.setReuse(false); http.setConnectTimeout(8000); http.setTimeout(10000);
  if(!http.begin(client,serverUrl)){ Serial.println("[POST] begin fallo"); return; }
  http.addHeader("Content-Type","application/json");

  String p="{";
  p += "\"humidity\":"+String(h,0)+",";
  p += "\"state\":"+String(estado)+",";
  p += "\"raw\":"+String(crudo)+",";
  p += "\"rssi\":"+String(WiFi.RSSI())+",";
  if(si7021OK && !isnan(tempSi))     p += "\"tempSi\":"+String(tempSi,1)+",";
  if(si7021OK && !isnan(airHum))     p += "\"airHum\":"+String(airHum,0)+",";
  if(bmpOK && !isnan(tempBmp))       p += "\"tempBmp\":"+String(tempBmp,1)+",";
  if(bmpOK && !isnan(presionHpa))    p += "\"pressure\":"+String(presionHpa,1)+",";
  if(!si7021OK && usandoBme && !isnan(airHum)) p += "\"airHum\":"+String(airHum,0)+",";
  p += "\"device\":\""+String(deviceId)+"\",";
  p += "\"ts\":"+String(millis())+"}";

  int code=http.POST(p);
  if(code>0){
    String r=http.getString();
    Serial.println("[POST] "+String(code)+" -> "+r);
    long d=extraerEntero(r,"dryRaw",-1), w=extraerEntero(r,"wetRaw",-1);
    if(d>=0&&d<=4095&&w>=0&&w<=4095&&abs((int)(d-w))>=200){ if((int)d!=dryRaw||(int)w!=wetRaw){ dryRaw=d; wetRaw=w; Serial.println("[CAL] seco="+String(dryRaw)+" humedo="+String(wetRaw)); } }
  } else Serial.println("[POST] ERROR "+String(code)+" ("+http.errorToString(code)+")");
  http.end();
}

// Escanea el bus I2C e imprime las direcciones encontradas (diagnostico)
void escanearI2C(){
  Serial.print("[I2C] Dispositivos:");
  byte n=0;
  for(byte a=1;a<127;a++){ Wire.beginTransmission(a); if(Wire.endTransmission()==0){ Serial.print(" 0x"); Serial.print(a,HEX); n++; } }
  Serial.println(n==0 ? " NINGUNO (revisa SDA=D19, SCL=D21, GND y 3V3)" : "");
}

// (Re)intenta inicializar los sensores I2C que aun no respondan
void reintentarSensores(){
  if(!si7021OK) si7021OK = si.begin();
  if(!bmpOK){
    if(bme.begin(0x76)||bme.begin(0x77)){ usandoBme=true; bmpOK=true; }
    else if(bmp.begin(0x76)||bmp.begin(0x77)){ bmpOK=true;
      bmp.setSampling(Adafruit_BMP280::MODE_NORMAL,Adafruit_BMP280::SAMPLING_X2,
                      Adafruit_BMP280::SAMPLING_X16,Adafruit_BMP280::FILTER_X16,Adafruit_BMP280::STANDBY_MS_500); }
  }
}

// ===================== Setup =====================
void setup(){
  Serial.begin(115200); delay(300);

  pwm(RGB1_R); pwm(RGB1_G); pwm(RGB1_B);
  pwm(RGB2_R); pwm(RGB2_G); pwm(RGB2_B);
  pinMode(BI_ROJO,OUTPUT); pinMode(BI_AMARILLO,OUTPUT);
  pinMode(PIN_BUZZER,OUTPUT); digitalWrite(PIN_BUZZER,LOW);

  analogReadResolution(12); analogSetPinAttenuation(PIN_SENSOR,ADC_11db);

  pinMode(PIN_SDA, INPUT_PULLUP);       // pull-ups internos por si el modulo no los trae
  pinMode(PIN_SCL, INPUT_PULLUP);
  Wire.begin(PIN_SDA, PIN_SCL, 100000); // bus I2C compartido a 100 kHz
  escanearI2C();                        // diagnostico: imprime direcciones detectadas
  reintentarSensores();                 // BMP280 (0x76/77) + Si7021 (0x40)

  Serial.println("=== Musgo que respira ===");
  Serial.println(String("Si7021: ")+(si7021OK?"OK":"no")+"   Presion: "+(bmpOK?(usandoBme?"BME280":"BMP280"):"no"));

  testColor();                 // verifica colores de cada modulo
  tocar(imperial);             // 🎵 melodia famosa al encender
  while(melActiva){ actualizarSonido(); delay(2); }

  WiFi.mode(WIFI_STA); WiFi.begin(ssid);
  Serial.print("WiFi");
  unsigned long t0=millis(); while(WiFi.status()!=WL_CONNECTED && millis()-t0<10000){ Serial.print('.'); delay(500); }
  if(WiFi.status()==WL_CONNECTED){ Serial.println(" OK "+WiFi.localIP().toString()); enviarDato(50,1,leerSensor()); }
  else Serial.println(" sin conexion");
}

// ===================== Loop =====================
void loop(){
  unsigned long ahora=millis();
  actualizarSonido();

  static unsigned long tRec=0;
  if(WiFi.status()!=WL_CONNECTED && ahora-tRec>=5000){ tRec=ahora; WiFi.disconnect(); WiFi.begin(ssid); }

  // Diagnostico + reintento de sensores I2C cada 5s mientras falte alguno
  static unsigned long tDiag=0;
  if((!si7021OK || !bmpOK) && ahora-tDiag>=5000){
    tDiag=ahora;
    escanearI2C();
    reintentarSensores();
    Serial.println(String("[SENSORES] Si7021=")+(si7021OK?"OK":"NO")+"  BMP/BME="+(bmpOK?"OK":"NO"));
  }

  // Cada sensor toma su medida por separado (cada 1 s)
  if((bmpOK||si7021OK) && ahora-tBmp>=1000){
    tBmp=ahora;
    if(si7021OK){ tempSi=si.readTemperature(); airHum=si.readHumidity(); }
    if(bmpOK){
      if(usandoBme){ tempBmp=bme.readTemperature(); presionHpa=bme.readPressure()/100.0f; if(!si7021OK) airHum=bme.readHumidity(); }
      else        { tempBmp=bmp.readTemperature(); presionHpa=bmp.readPressure()/100.0f; }
    }
  }

  if(ahora-tSensor>=250){
    tSensor=ahora;
    int crudo=leerSensor(); crudoActual=crudo;
    int hN=calcularHumedad(crudo);
    humedadEMA=(humedadEMA<0)?hN:(humedadEMA*0.7f+hN*0.3f);
    humedad=(int)round(humedadEMA);
    int estadoActual=(humedad<UMBRAL_SECO)?0:(humedad<UMBRAL_HUMEDO?1:2);

    // 1 LED por sensor:
    int r,g,b; colorHumedad(humedad,r,g,b); rgb1(r,g,b);                              // RGB1 = musgo
    if(!isnan(airHum)){ int r2,g2,b2; colorHumedad((int)airHum,r2,g2,b2); rgb2(r2,g2,b2); } else rgb2(0,0,0); // RGB2 = aire
    bicolorTemp(tempBmp);                                                             // bicolor = temp BMP280

    if(estadoActual!=estadoAnterior){ estadoAnterior=estadoActual; tocar(entradaPorEstado[estadoActual]); tProxAlerta=ahora+intervaloAlerta[estadoActual]; }

    static unsigned long lastSend=0;
    if(ahora-lastSend>=2000){ lastSend=ahora; enviarDato(humedad,estadoActual,crudo); }
  }

  int estado=(humedad<UMBRAL_SECO)?0:(humedad<UMBRAL_HUMEDO?1:2);
  if(!melActiva && ahora>=tProxAlerta){ tocar(sostenidoPorEstado[estado]); tProxAlerta=ahora+intervaloAlerta[estado]; }

  if(ahora-tSerial>=1000){
    tSerial=ahora;
    Serial.print("Musgo "); Serial.print(humedad); Serial.print("% (ADC "); Serial.print(crudoActual); Serial.print(") ");
    Serial.print(estado==0?"SECO":(estado==1?"MEDIO":"HUMEDO"));
    if(si7021OK){ Serial.print(" | Si7021 T="); Serial.print(tempSi,1); Serial.print("C Haire="); Serial.print(airHum,0); Serial.print("%"); }
    if(bmpOK){ Serial.print(" | BMP T="); Serial.print(tempBmp,1); Serial.print("C P="); Serial.print(presionHpa,1); Serial.print("hPa"); }
    Serial.println();
  }
}
