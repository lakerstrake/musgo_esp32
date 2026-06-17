# Conexiones — Musgo que respira 🌿

Esquemático de cableado de la ESP32 con todos los módulos.
Concepto: **cada caja de Petri con musgo** tiene su indicador LED; el sensor del musgo
mide la humedad del sustrato y los sensores ambientales (I²C) miden el aire alrededor.

## Esquemático general

```
                            ESP32 DevKit
                       ┌──────────────────────┐
  Sensor musgo 1321v   │                      │
   VCC ────────────────┤ 3V3                  │
   GND ────────────────┤ GND                  │
   AOUT ───────────────┤ D34  (ADC entrada)   │
                       │                      │
  RGB 1 (anodo comun)  │                      │
   R ──────────────────┤ D25                  │
   G ──────────────────┤ D26                  │
   B ──────────────────┤ D14                  │
   comun (+) ──────────┤ D27  (alimentacion)  │   *ver nota
                       │                      │
  RGB 2 (catodo comun) │                      │
   R ──────────────────┤ D2                   │
   G ──────────────────┤ D4                   │
   B ──────────────────┤ D16                  │
   comun (−) ──────────┤ GND                  │
                       │                      │
  Bicolor rojo/amar.   │                      │
   rojo ───────────────┤ D5                   │
   amarillo ───────────┤ D18                  │
   comun (−) ──────────┤ GND                  │
                       │                      │
  Buzzer               │                      │
   + ──────────────────┤ D22                  │
   − ──────────────────┤ GND                  │
                       │                      │
  I2C (bus compartido) │                      │
   SDA ────────────────┤ D19                  │   BMP280/BME280 (0x76/0x77)
   SCL ────────────────┤ D21                  │   + Si7021 (0x40)
   VCC ────────────────┤ 3V3                  │
   GND ────────────────┤ GND                  │
                       └──────────────────────┘
```

## Tabla de pines

| Módulo | Pin | ESP32 | Notas |
|---|---|---|---|
| Sensor musgo (1321v) | AOUT | **D34** | Entrada analógica (ADC) |
| | VCC / GND | 3V3 / GND | |
| **RGB 1** (ánodo común) | R / G / B | **D25 / D26 / D14** | Color por humedad del **musgo** |
| | común (+) | **D27** | Alimentación del módulo* |
| **RGB 2** (cátodo común) | R / G / B | **D2 / D4 / D16** | Color por humedad del **aire** |
| | común (−) | GND | |
| **Bicolor** rojo/amarillo | rojo / amarillo | **D5 / D18** | Semáforo de alerta |
| | común (−) | GND | |
| Buzzer | + / − | **D22** / GND | |
| **BMP280 / BME280** | SDA / SCL | **D19 / D21** | Presión (+temp) |
| **Si7021** | SDA / SCL | **D19 / D21** | Temperatura + humedad del aire |
| | VCC / GND | 3V3 / GND | I²C es un bus: ambos comparten SDA/SCL |

## Qué hace cada LED

| LED | Indica |
|---|---|
| **RGB 1** | Humedad del **musgo** (rojo seco → verde húmedo) |
| **RGB 2** | Humedad del **aire** (Si7021/BME280). Si no hay sensor de aire, espeja el musgo |
| **Bicolor** | **Alerta**: 🔴 seco · 🟡 medio · apagado húmedo |

## Notas importantes / posibles correcciones

- **⚠️ Temperatura corrupta (corregido):** el firmware ahora usa **SDA=D19, SCL=D21**
  para coincidir con tu cableado. Si SDA/SCL están cruzados, las lecturas salen
  basura (ej. 140 °C). Verifica que SDA vaya a **D19** y SCL a **D21**.

- **RGB 1 alimentado por D27 (*):** un pin GPIO entrega como máximo ~40 mA. Si el LED
  parpadea o la ESP32 se reinicia, **conecta el común del RGB 1 a 3V3** en vez de D27
  (y déjalo así; el código no necesita D27 para funcionar). Es lo más fiable.

- **Resistencias:** si un módulo RGB no las trae integradas, pon **220–330 Ω** en cada
  color (R/G/B) para no quemar el LED.

- **Tipo de común (si los colores salen invertidos):** RGB 1 es **ánodo común** y RGB 2
  **cátodo común** en el código. Si un módulo se ve “al revés”, cambia su `*_ANODO`
  en el sketch.

- **Pines sensibles (strapping):** D2 y D5 son pines de arranque del ESP32. Como aquí
  son salidas a LED suelen funcionar, pero si la placa no arranca, mueve ese color a
  otro pin libre (ej. D13, D15, D32, D33) y actualiza el sketch.

- **Si7021:** dirección I²C 0x40. **BMP280/BME280:** 0x76 o 0x77. No chocan (bus compartido).
  Instala las librerías: *Adafruit BMP280*, *Adafruit BME280*, *Adafruit Si7021*,
  *Adafruit Unified Sensor*.

## Resumen rápido de pines

```
D34 → Musgo (AOUT)       D2/D4/D16 → RGB2 (R/G/B)
D25/D26/D14 → RGB1 (R/G/B)  D5/D18 → Bicolor (rojo/amarillo)
D27 → RGB1 común (+)      D22 → Buzzer
D19/D21 → I2C (SDA/SCL): BMP280/BME280 + Si7021
```
