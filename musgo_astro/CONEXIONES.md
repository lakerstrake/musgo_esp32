# Conexiones — Musgo que respira 🌿

Cada **caja de Petri con musgo** tiene su sensor y su LED. Cada **módulo LED está
asociado a un solo sensor**:

| Caja / sensor | Mide | LED asociado |
|---|---|---|
| **Musgo** (sensor de suelo) | humedad del sustrato | **RGB 1** (color por humedad) |
| **Si7021** | temperatura + humedad del aire | **RGB 2** (color por humedad del aire) |
| **BMP280** | temperatura + presión | **Bicolor** (🔴 calor · 🟡 templado · ⚫ fresco) |

## Esquemático general

```
                            ESP32 DevKit
                       ┌──────────────────────┐
  Sensor musgo 1321v   │                      │
   AOUT ───────────────┤ D34                  │
   VCC / GND ──────────┤ 3V3 / GND            │
                       │                      │
  RGB 1 (catodo comun) │   -> caja MUSGO      │
   R / G / B ──────────┤ D25 / D26 / D14      │
   común (−) ──────────┤ GND                  │
                       │                      │
  RGB 2 (catodo comun) │   -> caja Si7021     │
   R / G / B ──────────┤ D2 / D4 / D16        │
   común (−) ──────────┤ GND                  │
                       │                      │
  Bicolor rojo/amar.   │   -> caja BMP280     │
   rojo / amarillo ────┤ D5 / D18             │
   común (−) ──────────┤ GND                  │
                       │                      │
  Buzzer (3 patas)     │                      │
   S (señal) ──────────┤ D22                  │
   + (medio) ──────────┤ 3V3                  │
   − ───────────────────┤ GND                  │
                       │                      │
  I2C (bus compartido) │                      │
   SDA ────────────────┤ D19                  │  BMP280/BME280 (0x76/0x77)
   SCL ────────────────┤ D21                  │  + Si7021 (0x40)
   VCC / GND ──────────┤ 3V3 / GND            │
                       └──────────────────────┘
```

## Tabla de pines

| Módulo | Pin | ESP32 |
|---|---|---|
| Sensor musgo (1321v) | AOUT · VCC/GND | **D34** · 3V3/GND |
| RGB 1 (musgo) | R / G / B · común(−) | **D25 / D26 / D14** · GND |
| RGB 2 (aire) | R / G / B · común(−) | **D2 / D4 / D16** · GND |
| Bicolor (temp BMP280) | rojo / amarillo · común(−) | **D5 / D18** · GND |
| Buzzer 3 patas | **S** / **+** / **−** | **D22** / 3V3 / GND |
| BMP280/BME280 + Si7021 | SDA / SCL | **D19 / D21** (I²C) |

## Notas / correcciones importantes

- **🔧 LED 1 (D25/26/14) mostraba azul (corregido):** ahora se trata como **cátodo
  común** (igual que el LED 2, que ya funcionaba). **Conecta su común a GND**, no a D27.
  Al arrancar, el firmware hace un **test de color** (ROJO→VERDE→AZUL en cada módulo):
  si algún color sale cambiado, abre el sketch y reordena `RGB1_R/G/B` (o `RGB2_*`)
  según lo que veas. Si un módulo enciende “al revés” (apagado = encendido), cambia su
  `RGB1_ANODO`/`RGB2_ANODO` a `true`.

- **🔧 Temperatura corrupta (corregido):** I²C ahora **SDA=D19, SCL=D21** (coincide con
  tu cableado). Si salía 140 °C era por SDA/SCL cruzados.

- **🔊 Buzzer de 3 patas:** S→**D22**, + (pata del medio)→**3V3**, −→**GND**. Es pasivo:
  reproduce tonos. Al encender toca la **Marcha Imperial de Star Wars** 🎵 (y también
  cuando el musgo llega a HÚMEDO). Para cambiar la melodía, edita el arreglo `imperial[]`.

- **Resistencias:** si un RGB no las trae, pon **220–330 Ω** en cada color.

- **Pines de arranque:** D2 y D5 son strapping pins. Como salidas a LED suelen ir bien;
  si la placa no arranca, mueve ese color a D13/D15/D32/D33 y actualiza el sketch.

- **Librerías Arduino:** Adafruit BMP280, Adafruit BME280, Adafruit Si7021, Adafruit Unified Sensor.

## Resumen de pines

```
D34 → Musgo (AOUT)         D2/D4/D16 → RGB2 (aire)
D25/D26/D14 → RGB1 (musgo)    D5/D18 → Bicolor (temp)
D22 → Buzzer (S)           D19/D21 → I2C: BMP280 + Si7021
comunes RGB/bicolor → GND  ·  buzzer + → 3V3
```
