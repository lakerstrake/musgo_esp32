# 🌿 Musgo que respira

> Instalación de **bio-arte IoT**: un musgo que “respira”, cambia de color, emite sonidos
> y publica su estado **en vivo por internet**. Hecho por **Andrés Camilo Lagos Monroy**
> y **Juan Manuel Lagos Monroy**.

**🔴 En vivo:** https://musgoesp32.jmlagos2003.workers.dev

Un ESP32 mide la humedad del musgo (y la temperatura, presión y humedad del aire del
ambiente), le da una respuesta sensorial (LEDs de color + melodía/alertas en buzzer) y
envía todo a la nube. Un panel web muestra cada sensor en tiempo real, con una pestaña
por sensor, historial y calibración remota.

---

## 🧭 Arquitectura

```
   ┌────────────────────────────┐      HTTPS POST cada 2 s        ┌─────────────────────────┐
   │           ESP32            │  ───────────────────────────▶   │   Cloudflare Worker     │
   │  • Sensor humedad (musgo)  │   {humidity,tempSi,airHum,...}  │  (serverless, edge)     │
   │  • BMP280 (temp+presión)   │                                 │  • API REST  /api/*     │
   │  • HDC1080/Si7021 (aire)   │  ◀───────────────────────────   │  • Dashboard web  /     │
   │  • 3 LEDs + buzzer         │      respuesta: calibración     │  • Cache API + KV       │
   └────────────────────────────┘                                 └─────────────────────────┘
                                                                              ▲ GET /api/data cada 1 s
                                                                   ┌─────────────────────────┐
                                                                   │   Navegador (panel web) │
                                                                   └─────────────────────────┘
```

- **ESP32** (Arduino/C++): lee sensores, controla LEDs y buzzer, envía datos por WiFi.
- **Cloudflare Worker**: una sola URL sirve la **API** (`/api/*`) y el **dashboard** (`/`).
- **Almacenamiento**: telemetría en **Cache API** (sin gastar cuota); la **calibración** en
  **KV**. Así el uso de KV es casi nulo y todo es gratis.

```
esp32/musgo_esp32_http.ino   Firmware del ESP32
worker/index.js              Worker: API + dashboard embebido
worker/wrangler.toml         Config de despliegue
CONEXIONES.md                Esquemático completo de cableado
web/                         Versión Astro alternativa del panel (la web viva la sirve el Worker)
```

---

## 🔬 Sensores (cada uno mide por separado)

| Sensor | Mide | Pin / Bus | Pestaña web | LED asociado |
|---|---|---|---|---|
| **Humedad de suelo (1321v)** | humedad del **musgo** (0–100 %) | `D34` (analógico) | 🌱 Musgo | RGB 1 |
| **BMP280 / BME280** | temperatura + presión | I²C `D19/D21` (0x76) | 🌡️ Ambiente | Bicolor |
| **HDC1080 / Si7021 / HTU21D** | temperatura + **humedad del aire** | I²C `D19/D21` (0x40) | 💨 Aire | RGB 2 |

> El firmware **auto-detecta** el chip de aire (HDC1080 vs Si7021/HTU21D) y el de presión
> (BMP280 vs BME280), así funciona sin importar el modelo exacto del módulo.

---

## 💡 Respuesta física

**LEDs (1 por sensor):**
- **RGB 1 → musgo:** rojo (seco) → ámbar → verde (húmedo).
- **RGB 2 → aire:** color según la humedad del aire.
- **Bicolor → temperatura (BMP280):** 🟡 < 25 °C · 🔴 ≥ 25 °C.

**Buzzer (melodía + alertas, diseño psicoacústico):**
- 🟢 **Húmedo:** toca la **Marcha Imperial de Star Wars** 🎵 (celebración).
- 🟡 **Medio:** alerta media periódica.
- 🔴 **Seco:** súper-alerta aguda e insistente (¡necesita agua!).
- Al **cambiar de estado**, un “ding-dong” identificador antes de la alerta.

---

## 🔌 Hardware y conexiones

| Módulo | ESP32 |
|---|---|
| Sensor musgo (1321v) AOUT · VCC/GND | `D34` · 3V3/GND |
| RGB 1 (musgo) R/G/B · común | `D25/D26/D14` · GND |
| RGB 2 (aire) R/G/B · común | `D2/D4/D16` · GND |
| Bicolor (temp) rojo/amarillo · común | `D5/D18` · GND |
| Buzzer 3 patas S / + / − | `D22` / 3V3 / GND |
| BMP280 + sensor de aire (I²C, mismo bus) SDA/SCL | `D19/D21` |

- **Todo comparte 3V3 y GND comunes** (los sensores necesitan su VCC a 3V3; los LEDs
  cátodo-común van a GND).
- **Polaridad de LED configurable** por módulo (`RGB1_ANODO`, `RGB2_ANODO`, `BI_ANODO`):
  el test de arranque tiene un paso “APAGADO” que revela si alguno está al revés.

📐 **Esquemático completo, tabla de pines, direcciones I²C y notas → [CONEXIONES.md](CONEXIONES.md)**
(también en el dashboard → *Info → Explicación técnica*).

**Librerías Arduino:** Adafruit BMP280, Adafruit BME280, Adafruit Unified Sensor.
*(El sensor de aire se lee por I²C directo, sin librería, para soportar cualquier chip.)*

---

## 🚀 Puesta en marcha

### 1) Worker (API + web)
```powershell
cd musgo_astro
npx wrangler login        # una sola vez
npx wrangler deploy
```
Imprime la URL del Worker (ej. `https://musgoesp32.<tu-subdominio>.workers.dev`).
El almacenamiento de telemetría usa **Cache API** (no requiere configurar KV).

### 2) ESP32
1. En `esp32/musgo_esp32_http.ino`, pon tu red WiFi (`ssid`) y la URL del Worker (`serverUrl` + `/api/data`).
2. Sube el sketch con Arduino IDE. Al arrancar verás en el Monitor Serie (115200 baudios):
   ```
   [I2C] Dispositivos: 0x40 0x76
   [AIRE] chip = HDC1080
   Musgo 71% (ADC 1057) HUMEDO | aire T=23C H=55% | BMP T=24C P=756hPa
   ```

### 3) Calibrar el musgo (desde la web)
En la pestaña **🌱 Musgo → Calibrar**: con el musgo **seco** pulsa *Capturar* en SECO; riégalo
y pulsa *Capturar* en HÚMEDO; *Guardar*. El ESP32 se reajusta solo en segundos (la calibración
viaja en la respuesta de cada POST).

---

## 🖥️ El dashboard

Minimalista, profesional y en vivo, con **una pestaña por sensor**:
- **🌱 Musgo** — orbe de humedad que “respira”, estado y calibración.
- **💨 Aire** — temperatura + humedad del aire, con gráficas.
- **🌡️ Ambiente** — temperatura + presión, con gráficas.
- **ℹ️ Info** — explicación básica y técnica + esquemático.

---

## 🔌 API

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/` | Dashboard web |
| `GET` | `/api/data` | Última lectura de todos los sensores |
| `POST` | `/api/data` | El ESP32 envía una lectura → responde la calibración |
| `GET` | `/api/history` | Serie temporal reciente |
| `GET·POST` | `/api/config` | Leer / fijar calibración `{dryRaw, wetRaw}` |
| `GET` | `/api/health` | Estado del servicio |

---

## 🧩 Tecnología

`ESP32` · `Arduino/C++` · `I²C` · `BMP280/BME280` · `HDC1080/Si7021` · `LED RGB ×2` ·
`LED bicolor` · `buzzer` · `Cloudflare Workers` · `Cache API` · `Workers KV` · `HTTPS` · `HTML/JS`

---

Hecho con 🌿 por **Andrés Camilo Lagos Monroy** y **Juan Manuel Lagos Monroy**.
