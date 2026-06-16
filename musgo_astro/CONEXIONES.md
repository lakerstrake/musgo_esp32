# Conexiones — Musgo que respira 🌿

Esquemático de cableado de la ESP32 con todos los periféricos.

## Esquemático general

```
                          ESP32 DevKit (38 pines)
                       ┌─────────────────────────┐
                       │                         │
   Sensor humedad      │                         │
   ┌──────────┐        │                         │
   │ VCC ─────┼────────┤ 3V3                     │
   │ GND ─────┼────────┤ GND                     │
   │ AOUT ────┼────────┤ GPIO34 (ADC, entrada)   │
   └──────────┘        │                         │
                       │                         │
   LED RGB             │                         │
   ┌──────────┐        │                         │
   │ R ──[330Ω]┼───────┤ GPIO25 (PWM)            │
   │ G ──[330Ω]┼───────┤ GPIO26 (PWM)            │
   │ B ──[330Ω]┼───────┤ GPIO27 (PWM)            │
   │ común ────┼───────┤ 3V3  (ánodo común)      │
   └──────────┘        │                         │
                       │                         │
   Buzzer              │                         │
   ┌──────────┐        │                         │
   │ + ───────┼────────┤ GPIO22                  │
   │ − ───────┼────────┤ GND                     │
   └──────────┘        │                         │
                       │                         │
   BMP280 (I²C)        │                         │
   ┌──────────┐        │                         │
   │ VCC ─────┼────────┤ 3V3                     │
   │ GND ─────┼────────┤ GND                     │
   │ SDA ─────┼────────┤ GPIO21 (I²C SDA)        │
   │ SCL ─────┼────────┤ GPIO19 (I²C SCL)        │
   │ SDO ─────┼────────┤ GND  → dirección 0x76   │
   │ CSB ─────┼────────┤ 3V3  → modo I²C         │
   └──────────┘        └─────────────────────────┘
```

## Tabla de pines

| Componente | Pin del componente | Pin ESP32 | Notas |
|---|---|---|---|
| Sensor de humedad | VCC | 3V3 | Capacitivo/resistivo de suelo |
| | GND | GND | |
| | AOUT (analógico) | **GPIO34** | Solo entrada (ADC1) |
| LED RGB | R | **GPIO25** | Resistencia 220–330 Ω |
| | G | **GPIO26** | Resistencia 220–330 Ω |
| | B | **GPIO27** | Resistencia 220–330 Ω |
| | común | 3V3 | Ánodo común (ver nota) |
| Buzzer | + | **GPIO22** | Pasivo (tonos) o activo |
| | − | GND | |
| BMP280 | VCC | 3V3 | No 5V salvo módulo con regulador |
| | GND | GND | |
| | SDA | **GPIO21** | I²C datos |
| | SCL | **GPIO19** | I²C reloj (evita el 22 del buzzer) |
| | SDO | GND | Dirección 0x76 (a 3V3 → 0x77) |
| | CSB | 3V3 | Selecciona modo I²C |

## Notas importantes

- **LED RGB — tipo de LED:**
  - *Ánodo común* (por defecto en el sketch): el pin común va a **3V3**. Deja `CATODO_COMUN = false`.
  - *Cátodo común*: el pin común va a **GND** y pon `CATODO_COMUN = true` en el sketch.
  - Usa **resistencias de 220–330 Ω** en cada color (R, G, B) para limitar corriente.

- **Buzzer — pasivo vs activo:**
  - *Pasivo* (recomendado, permite tonos): deja `#define USAR_TONO true`.
  - *Activo* (solo enciende/apaga): pon `#define USAR_TONO false`.

- **BMP280:**
  - Usa I²C en **GPIO21 (SDA)** y **GPIO19 (SCL)** a propósito, para no chocar con el buzzer (GPIO22).
  - Requiere librerías **Adafruit BMP280** + **Adafruit Unified Sensor**.
  - Si no lo detecta, prueba dirección 0x77 (SDO a 3V3) o sube un *I²C scanner*.
  - Para medir **humedad del aire** usa un **BME280** (mismo cableado; ver comentario en el sketch).

- **Alimentación:** todos los sensores a **3V3** y **GND común**. La ESP32 se alimenta por USB.

## Pines en uso (resumen rápido)

```
GPIO34 → Humedad (AOUT)      GPIO22 → Buzzer (+)
GPIO25 → LED R               GPIO21 → BMP280 SDA
GPIO26 → LED G               GPIO19 → BMP280 SCL
GPIO27 → LED B               3V3/GND → alimentación de todos
```
