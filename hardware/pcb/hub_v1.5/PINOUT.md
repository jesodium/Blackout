# BLACKOUT Sensor Hub v1.4: pinout

This is every port on the shield. For each one it gives: pin, then Giga pin, then signal, then voltage, then the name the firmware uses.
Pin 1 is the **left** pin as you read the silkscreen, except on J22 (see its note). PH = JST-PH 2.0 mm SMD (keyed). Qwiic = JST-SH 1.0 mm.
The UART ports name their pins **from the device's side**: plug the device's TX into `TX`.

> **The Giga's own UART silkscreen is off by one.** D18/D19 are printed TX1/RX1 but are `Serial2`.
> D16/D17 are printed TX2/RX2 but are `Serial3`. D14/D15 are printed TX3/RX3 but are `Serial4`.
> Wire by D-number (pins_arduino.h:198-211).

## I2C: three buses, kept apart

| Port | Pin | Giga pin | Signal | V | Firmware |
|---|---|---|---|---|---|
| **J10 ARM** (PH5) | 1 | GND | GND | – | – |
| `WIRE ARM 0x40 ONLY` | 2 | D32 | PCA9685 OE (active low) | 3V3 | `ARM_OE_PIN 32` (arm.h) |
| | 3 | D21 | SCL (`Wire`) | 3V3 | `Wire`, `ARM_ADDR 0x40` |
| | 4 | D20 | SDA (`Wire`) | 3V3 | `Wire` |
| | 5 | 3V3 | PCA9685 VCC (logic) | 3V3 | – |
| | | | *V+ (servo rail, 6 V max) does NOT come from this board* | | |
| **J12 BME280** (PH4) | 1/2/3/4 | 3V3 / GND / D101 / D102 | VIN, GND, SCL1, SDA1 | 3V3 | `bme.begin(0x76, &Wire1)` |
| **J13, J14** Qwiic W1 | 1/2/3/4 | GND / 3V3 / D102 / D101 | GND, 3V3, SDA1, SCL1 | 3V3 | `Wire1` |
| **J15 GY-302** (PH5) | 1/2/3/4/5 | 3V3 / GND / D8 / D9 / GND | VCC, GND, SCL2, SDA2, **ADDR tied to GND** | 3V3 | `BH1750_ADDR 0x23` on `Wire2` |
| **J16, J17, J27** Qwiic W2 | 1/2/3/4 | GND / 3V3 / D9 / D8 | GND, 3V3, SDA2, SCL2 | 3V3 | `Wire2`: ENS160+AHT21 (0x53/0x38), INA219 (0x41) |

Pull-ups: R1/R2 (Wire), R3/R4 (Wire1), R5/R6 (Wire2) are 4.7 kΩ to 3V3. They are fitted but **disconnected** until you blob JP1/JP2/JP3 (`PU` on silk). The modules already carry their own pull-ups.
Nothing else on the board touches D20/D21.

## GPIO sensors and actuators

| Port | Pin | Giga pin | Signal | V | Firmware |
|---|---|---|---|---|---|
| **J18 SONAR** (PH4) | 1 | 3V3 | VCC | 3V3 | RCWL-1601, never an HC-SR04 |
| | 2 | D52 | TRIG | 3V3 | `TRIG_PIN 52` |
| | 3 | D50 | ECHO | 3V3 | `ECHO_PIN 50` (INPUT_PULLDOWN) |
| | 4 | GND | GND | – | |
| **J19 DHT11** (PH3) | 1/2/3 | 3V3 / A5 / GND | VCC, DATA (10 kΩ R7 pull-up on board), GND | 3V3 | `DHT_PIN A5` |
| **J20 BUZZER** (PH3) | 1/2/3 | 3V3 / see JP5 / GND | VCC, SIG, GND | 3V3 | `BUZZ_PIN 72`, active low |
| **TP1 `D72`** | – | D72 (flying wire) | buzzer signal | 3V3 | D72 is **not** on a Mega header. See README. |
| **J21 RELAYS** (PH5) | 1 | GND | GND | – | |
| | 2 | D26 | IN1 (cam light) | 3V3 | `RELAY_CAM_LED 26` |
| | 3 | D28 | IN2 (LED strip) | 3V3 | `RELAY_STRIP 28` |
| | 4 | D30 | IN3 (spare LED) | 3V3 | `RELAY_LED 30` |
| | 5 | JP4 | relay module VCC | **5V** fused (default) / 3V3 | `RELAY_ON LOW` |
| **J22 L298N** (1x7, 2.54 mm THT) | 1 | D2 | ENA | 3V3 | `ENA 2` |
| **pin 1 is on the RIGHT** (under D2) | 2 | D3 | IN1 | 3V3 | `IN1 3` |
| | 3 | D4 | IN2 | 3V3 | `IN2 4` |
| | 4 | D5 | IN3 | 3V3 | `IN3 5` |
| | 5 | D6 | IN4 | 3V3 | `IN4 6` |
| | 6 | D7 | ENB | 3V3 | `ENB 7` |
| | 7 | GND | common ground (required) | – | |

On J22 the pins keep the L298N header's order (ENA IN1 IN2 IN3 IN4 ENB), so the ribbon runs straight across. The header is mirrored so each pin sits directly under its Giga pin.

## v1.3: AUX ports (spare, for sensors added later)

| Port | Pin | Giga pin | Signal | V | Firmware |
|---|---|---|---|---|---|
| **J29 AUX D44/46** (PH4) | 1 | 3V3 | VCC | 3V3 | |
| | 2 | D44 | S1 | 3V3 | digital |
| | 3 | D46 | S2 | 3V3 | digital |
| | 4 | GND | GND | – | |

Same pin order as the other 3- and 4-pin sensor ports (DHT11/BUZZER, SONAR). Power and logic are 3V3 only, and **nothing on these pins is 5V tolerant**.
D44 and D46 are also on the stacking header sockets. Don't use the socket and the port for the same pin at once.

## v1.4: 3.5" SPI LCD (replaces the OLED)

**J11 LCD** (PH8, row 1, turned 180°: pin 1 is on the **right**). It is for the 3.5" "TFT SPI 480x320 V1.0" module (ILI9488, XPT2046 touch).
Pins 1-8 are in the same order as the module's 14-pin header, so the cable crimps straight through, pin 1 to pin 1.

| PH pin | Silk | Module pin | Giga pin | V |
|---|---|---|---|---|
| 1 | `5V` | VCC | +5V_FUSED | **5V** (module's own 3.3 V regulator) |
| 2 | `G` | GND | GND | – |
| 3 | `CS` | CS | D10 | 3V3 |
| 4 | `RS` | RESET | 3V3 (held high) | 3V3 |
| 5 | `DC` | DC/RS | D1 | 3V3 |
| 6 | `DI` | SDI (MOSI) | D11 (`SPI1` MOSI) | 3V3 |
| 7 | `CK` | SCK | D13 (`SPI1` SCK) | 3V3 |
| 8 | `LE` | LED (backlight) | 3V3 (always on) | 3V3 |

- **Module pins 9-14 (SDO and touch) are not on the port.** Every signal goes Giga → display, so nothing drives a Giga pin. Don't wire SDO to MISO later: the ILI9488 doesn't release it, so it would clash with touch.
- Touch, if you want it later, can go on J30 with jumpers: T_CLK to D13, T_DIN to D11, T_DO to D12 (`SPI1` MISO), T_CS to A3, T_IRQ to A4.
- **D10 is the LCD CS now, so never bridge JP7 2-3.** JP7's old D10 option (LD19 speed control) can't be used while the LCD is fitted.
- RESET is held high, so the library has to reset the panel in software (pass no reset pin). If the screen comes up garbled after a firmware upload, power-cycle the rover.
- Firmware sketch with Arduino_GFX (the panel takes 18-bit colour over SPI):
  ```cpp
  Arduino_DataBus *bus = new Arduino_HWSPI(1 /*DC*/, 10 /*CS*/, 13, 11, GFX_NOT_DEFINED, &SPI1);
  Arduino_GFX *gfx = new Arduino_ILI9488_18bit(bus, GFX_NOT_DEFINED /*RST*/, 1 /*rotation*/);
  ```

## UARTs, LIDAR (from `parts/WIRING.md`)

| Port | Pin | Giga pin | Signal | V | Firmware |
|---|---|---|---|---|---|
| **J23 LIDAR** (PH4) | 1 | +5V_FUSED | LD19 P5V | **5V** | 180 mA run / 300 mA start |
| `LIDAR 5V UART3` | 2 | GND | GND | – | |
| | 3 `TX` | D17 via 1 kΩ (R8) | LD19 Tx → Serial3 RX | 3V3 logic | `lidar.h` owns the USART. **Never call `Serial3.begin()`.** |
| | 4 `RX` | D16 | Serial3 TX (LD19 has no RX, leave open) | 3V3 | claimed by lidar.h |
| **J24 LIDAR PWM** (PH2) | 1 | JP7 | LD19 PWM: **GND, keep it** (D10 is the LCD CS since v1.4) | 3V3 | LD19 manual: ground it unless you run external speed control |
| | 2 | GND | GND | – | |
| **J25 IMU** (PH4) | 1 | 3V3 | BNO086 3V3 | 3V3 | |
| `IMU UART4 D15` | 2 | GND | GND | – | |
| | 3 `TX` | D15 via 1 kΩ (R9) | BNO086 TXO → Serial4 RX | 3V3 | `Serial4`, RVC 115200 |
| | 4 `RX` | D14 | Serial4 TX (unused in RVC) | 3V3 | |
| **J28 GPS** (PH4, v1.6, turned: pin 1 on **top**) | 1 | 3V3 | NEO-7M VCC | 3V3 | module LDO takes 3.3-5 V, u-blox IO is 3.3 V |
| `GPS UART2 D19` | 2 | GND | GND | – | |
| | 3 `TX` | D19 via 1 kΩ (R14) | NEO-7M TX → Serial2 RX | 3V3 | `Serial2.begin(9600)` (NEO-7M default) |
| | 4 `RX` | D18 | Serial2 TX → NEO-7M RX | 3V3 | |

J28 was the AUX A0 port until v1.6. The NEO-7M runs on 3V3 here, so the whole cable stays at 3.3 V and no level shifter is needed.

+5V_FUSED comes from the Giga's 5V pin through F1 (1.1 A PTC). There is no external 5V input.

## Solder jumpers (as shipped)

| JP | Default | Other position | What it does |
|---|---|---|---|
| JP1 / JP2 / JP3 | open | blob = on | 4.7 kΩ pull-ups on Wire / Wire1 / Wire2 |
| JP4 `RLY` | 1-2: fused 5 V | cut, bridge 2-3: 3V3 | relay module VCC |
| JP5 `BZ` | 1-2: TP1 (D72 wire) | cut, bridge 2-3: **D34** | buzzer signal. D34 needs `BUZZ_PIN 34` in main.ino |
| JP7 `PW` | 1-2: GND | **don't use since v1.4** (2-3 = D10 = LCD CS) | LD19 PWM pin |

## v1.1: spare GPIO breakout

**J30** is a 2x7 male header (2.54 mm) in the top-left corner. Every pin is **3V3 logic and NOT 5V tolerant**, and the silkscreen says so.

| Row | Col 1 | Col 2 | Col 3 | Col 4 | Col 5 | Col 6 | Col 7 |
|---|---|---|---|---|---|---|---|
| top (label above) | **3V3** | D10 (LCD CS) | D11 (LCD MOSI) | D12 (PWM) | D13 (LCD SCK) | D18 = Serial2 TX (GPS) | D19 = Serial2 RX (GPS) |
| bottom (label below) | **GND** | A1 | A2 | A3 | A4 | A6 | A7 |

- **D10, D11 and D13 have been the LCD lines since v1.4** (printed inverted). They're still on J30 for probing, but don't drive them from here while the LCD is plugged in.
- **D18/D19** are printed TX1/RX1 on the Giga, but in code they are `Serial2`. Since v1.6 they are the GPS (J28). Don't drive them from J30 while the GPS is plugged in.
- **A7** also feeds the Giga's 3.5 mm audio jack.
- Schematic pin numbers: odd pins are the bottom row (pin 1 = GND), even pins are the top row (pin 2 = 3V3).

**J31** is a 2x2 rail next to the JSIDE block (moved 3 mm right in v1.3), for anything hung off D22-D53: top row 3V3 3V3, bottom row GND GND.

**The rest of the Giga pins are reached through the stacking headers.** The shield is meant to use an Arduino Mega stacking-header set, so every Giga pin is also a female socket on top. Next to each socket the silkscreen gives its exact Giga name:
- D0-D21, SCL1/SDA1, AREF, the power header, A0-A11, DAC0/1 and CANRX/CANTX are labelled on the board-edge side of their rows.
- D22-D53 are labelled on both sides of the 2x18: even numbers to the left, odd numbers to the right (vertical text), and 5V/GND at the two ends.

**An inverted (white-box) label means the shield already uses that pin.** Plain labels are free, are a breakout, or are an unfitted option (D34 through JP5).
A8-A11 are ADC-only (a compile error as digital). The silkscreen under the rail says "A8-11 ANALOG".

## Giga pins the shield uses (inverted labels)

D2-D7, D8/D9 (Wire2), D1 + D10 + D11 + D13 (LCD, v1.4), D14-D19, D20/D21 (Wire), D26, D28, D30, D32, D50, D52, SCL1/SDA1 (Wire1), A5, D44 + D46 (AUX port, v1.3), D18/D19 (GPS, v1.6), 3V3, 5V, GND. D72 comes in by flying wire to TP1.
Optional: D34 (JP5).

## Still free after v1.4

- Broken out on J30: D12, A2-A4, A6, A7.
- Only at the stacking header: A0 (free since v1.6), D0 (D1 is the LCD DC, so Serial1 is gone), all of D22-D53 except D26, D28, D30, D32, D44, D46, D50 and D52, plus A8-A11 (analog only), DAC0/DAC1 and CANRX/CANTX.
- D34 is free unless JP5 is moved to D34.
