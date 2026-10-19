"""BLACKOUT sensor hub -- single source of truth for schematic + PCB.

Every net name here is what both the schematic labels and the PCB pads carry.
Giga pin facts: CLAUDE.md, giga-r1/main/main.ino, arm.h, GIGA variant
pins_arduino.h (Serial1 D0/D1, Serial2 TX D18/RX D19, Serial3 TX D16/RX D17,
Serial4 TX D14/RX D15) and the ABX00063 datasheet (outline, holes, J5/J6).
Parts plan (LD19 on Serial3, BNO086 RVC on Serial4, 5V straight from the Giga 5V pin)
from Blackout-Upgrades/parts/WIRING.md.

PCB coordinates are in KiCad's official Arduino_Mega template frame: board
corner (100, 46.66), 101.6 x 53.34 mm.
"""

PHF = "Connector_JST:JST_PH_B{n}B-PH-SM4-TB_1x{n:02d}-1MP_P2.00mm_Vertical"
QW_FP = "Connector_JST:JST_SH_BM04B-SRSS-TB_1x04-1MP_P1.00mm_Vertical"
PH = "Connector_PinHeader_2.54mm:PinHeader_1x{n:02d}_P2.54mm_Vertical"
R0805 = "Resistor_SMD:R_0805_2012Metric_Pad1.20x1.40mm_HandSolder"
C0805 = "Capacitor_SMD:C_0805_2012Metric_Pad1.18x1.45mm_HandSolder"
C1206 = "Capacitor_SMD:C_1206_3216Metric_Pad1.33x1.80mm_HandSolder"
LED0805 = "LED_SMD:LED_0805_2012Metric_Pad1.15x1.40mm_HandSolder"
F1206 = "Fuse:Fuse_1206_3216Metric_Pad1.42x1.75mm_HandSolder"
SJ2 = "Jumper:SolderJumper-2_P1.3mm_Open_RoundedPad1.0x1.5mm"
SJ3 = "Jumper:SolderJumper-3_P1.3mm_Bridged12_RoundedPad1.0x1.5mm"
SOT23 = "Package_TO_SOT_SMD:SOT-23"
TP = "TestPoint:TestPoint_Pad_2.0x2.0mm"
MH = "Blackout:MountingHole_3.2mm_M3_Shield"
GH8 = "Blackout:Giga_Header_1x08_P2.54mm"
GH10 = "Blackout:Giga_Header_1x10_P2.54mm"
GH36 = "Blackout:Giga_Header_2x18_P2.54mm"

LCSC = {
    "PH2": ("C160352", "JST B2B-PH-SM4-TB(LF)(SN)"),
    "PH3": ("C160353", "JST B3B-PH-SM4-TB(LF)(SN)"),
    "PH4": ("C160354", "JST B4B-PH-SM4-TB(LF)(SN)"),
    "PH5": ("C265085", "JST B5B-PH-SM4-TB(LF)(SN)"),
    "PH8": ("C495548", "JST B8B-PH-SM4-TB(LF)(SN)"),
    "QW": ("C160390", "JST BM04B-SRSS-TB(LF)(SN)"),
    "10k": ("C17414", "UNI-ROYAL 0805W8F1002T5E"),
    "15k": ("C17475", "UNI-ROYAL 0805W8F1502T5E"),
    "4k7": ("C17673", "UNI-ROYAL 0805W8F4701T5E"),
    "1k": ("C17513", "UNI-ROYAL 0805W8F1001T5E"),
    "100n": ("C49678", "YAGEO CC0805KRX7R9BB104"),
    "22u": ("C12891", "Samsung CL31A226KAHNNNE 25V 1206"),
    "LEDG": ("C2297", "KENTO KT-0805G"),
    "LEDR": ("C84256", "NATIONSTAR NCD0805R1"),
    "PTC": ("C523825", "PTTC SMD1206P110TF/16 1.1A hold"),
    "PFET": ("C15127", "AOS AO3401A"),
}

parts = []

def P(ref, lib, val, fp, pins, at=None, **kw):
    parts.append(dict(ref=ref, lib=lib, value=val, fp=fp, pins=pins, at=at, **kw))

# ---------------------------------------------------------------- Giga headers
# Positions/rotations copied from KiCad's official Arduino_Mega shield template.
P("J1", "Connector_Generic:Conn_01x08", "GIGA_POWER", GH8,
  {1: None, 2: None, 3: None, 4: "+3V3", 5: "+5V", 6: "GND", 7: "GND", 8: None},
  at=(127.94, 97.46, 90), giga=True,
  names={1: "NC", 2: "IOREF", 3: "RESET", 4: "3V3", 5: "5V", 6: "GND", 7: "GND", 8: "VIN"})
P("J2", "Connector_Generic:Conn_01x10", "GIGA_D8-D13_I2C1", GH10,
  {1: "I2C1_SCL", 2: "I2C1_SDA", 3: None, 4: "GND", 5: "GPIO_D13", 6: "GPIO_D12", 7: "GPIO_D11",
   8: "LCD_CS", 9: "I2C2_SDA", 10: "I2C2_SCL"},
  at=(118.796, 49.2, 90), giga=True,
  names={1: "SCL1/D101", 2: "SDA1/D102", 3: "AREF", 4: "GND", 5: "D13", 6: "D12",
         7: "D11", 8: "D10", 9: "D9/SDA2", 10: "D8/SCL2"})
P("J3", "Connector_Generic:Conn_01x08", "GIGA_A0-A7", GH8,
  {1: None, 2: "MQ135_AO", 3: "GPIO_A2", 4: "GPIO_A3", 5: "GPIO_A4", 6: "DHT_DATA", 7: "GPIO_A6", 8: "GPIO_A7"},
  at=(150.8, 97.46, 90), giga=True, names={i: "A%d" % (i - 1) for i in range(1, 9)})
P("J4", "Connector_Generic:Conn_01x08", "GIGA_D0-D7", GH8,
  {1: "MOT_ENB", 2: "MOT_IN4", 3: "MOT_IN3", 4: "MOT_IN2", 5: "MOT_IN1", 6: "MOT_ENA", 7: "LCD_DC", 8: None},
  at=(145.72, 49.2, 90), giga=True,
  names={1: "D7", 2: "D6", 3: "D5", 4: "D4", 5: "D3", 6: "D2", 7: "D1/TX", 8: "D0/RX"})
P("J5", "Connector_Generic:Conn_01x08", "GIGA_A8-A11_DAC_CAN", GH8,
  {i: None for i in range(1, 9)}, at=(173.66, 97.46, 90), giga=True,
  names={1: "A8", 2: "A9", 3: "A10", 4: "A11", 5: "DAC0", 6: "DAC1", 7: "CANRX", 8: "CANTX"})
# silkscreen on the Giga says TX3/RX3/TX2/RX2/TX1/RX1 here (Mega legacy) --
# in code D14/15 = Serial4, D16/17 = Serial3, D18/19 = Serial2.
P("J6", "Connector_Generic:Conn_01x08", "GIGA_D14-D21", GH8,
  {1: "UART4_TX", 2: "UART4_RX", 3: "UART3_TX", 4: "UART3_RX", 5: "UART2_TX", 6: "UART2_RX",
   7: "I2C0_SDA", 8: "I2C0_SCL"},
  at=(168.58, 49.2, 90), giga=True,
  names={1: "D14 Serial4 TX", 2: "D15 Serial4 RX", 3: "D16 Serial3 TX", 4: "D17 Serial3 RX",
         5: "D18 Serial2 TX", 6: "D19 Serial2 RX", 7: "D20 SDA", 8: "D21 SCL"})
# JSIDE 2x18: top row 5V/5V at y=49.2, bottom row GND/GND at y=92.38; the inner
# column (x=193.98) carries the even D numbers, the outer (196.52) the odd ones
# (Giga silkscreen). PinHeader at rot 0 from the top: pad p (3..34) = D(p+19).
# 5V pins left NC: the Giga already ties them to J1-5, which is the one we use
j7 = {1: None, 2: None, 35: "GND", 36: "GND"}
j7names = {1: "5V", 2: "5V", 35: "GND", 36: "GND"}
for pad in range(3, 35):
    d = pad + 19
    j7names[pad] = "D%d" % d
    j7[pad] = {52: "SONAR_TRIG", 50: "SONAR_ECHO", 34: "BUZZ_D34", 32: "ARM_OE",
               30: "RLY_LED", 28: "RLY_STRIP", 26: "RLY_CAM",
               44: "GPIO_D44", 46: "GPIO_D46"}.get(d)
P("J7", "Connector_Generic:Conn_02x18_Odd_Even", "GIGA_D22-D53",
  GH36,
  j7, at=(193.98, 49.2, 0), giga=True, names=j7names)

# ---------------------------------------------------------------- ports
# SMD JST-PH (keyed, 2.0mm) everywhere: nothing pokes through the bottom, so
# the ports can sit over the Giga's USB-A / audio jack / camera headers.
R1Y, R2Y, R3Y, R4Y = 56.3, 67.9, 79.5, 91.1   # port rows (connector origin y)

def ph(ref, n, val, pins, x, y, label, legend, rot=0, **kw):
    P(ref, "Connector_Generic_MountingPin:Conn_01x%02d_MountingPin" % n, val, PHF.format(n=n),
      dict(pins, MP="GND"), at=(x, y, rot), lcsc=LCSC["PH%d" % n], label=label, legend=legend, **kw)

def qw(ref, bus, x, y, label):
    P(ref, "Connector_Generic_MountingPin:Conn_01x04_MountingPin", "Qwiic_" + bus, QW_FP,
      {1: "GND", 2: "+3V3", 3: bus + "_SDA", 4: bus + "_SCL", "MP": "GND"},
      at=(x, y, 0), lcsc=LCSC["QW"], label=label, legend=["G", "V", "D", "C"])

# row 1 -- WIRE1 (SDA1 D102 / SCL1 D101) and WIRE (D20/D21, arm only)
# v1.4: 3.5" ILI9488 SPI display (480x320 "TFT SPI V1.0") replaces the OLED. Pin order = the
# module's header 1-8, so the cable crimps straight through. Write-only: SDO (pin 9) and touch
# stay off the port, so nothing drives a Giga pin. RESET held high, the library resets in software.
# CS on D10 (next to D11/D13), DC on D1.
ph("J11", 8, "LCD_ILI9488_SPI", {1: "+5V_FUSED", 2: "GND", 3: "LCD_CS", 4: "+3V3", 5: "LCD_DC",
                                 6: "GPIO_D11", 7: "GPIO_D13", 8: "+3V3"},
   134.0, R1Y, "LCD ILI9488 SPI", ["5V", "G", "CS", "RS", "DC", "DI", "CK", "LE"], rot=180)   # pin 1 right: CK/DI/CS line up under D13/D11/D10
qw("J13", "I2C1", 149.6, R1Y - 1.8, "W1 QWIIC")
qw("J14", "I2C1", 157.7, R1Y - 1.8, "W1 QWIIC")
ph("J10", 5, "ARM_PCA9685", {1: "GND", 2: "ARM_OE", 3: "I2C0_SCL", 4: "I2C0_SDA", 5: "+3V3"},
   176.5, R1Y, "WIRE ARM 0x40 ONLY", ["G", "OE", "CL", "DA", "3V"])
# row 2 -- WIRE2 (D9 SDA2 / D8 SCL2) + IMU + LIDAR
ph("J15", 5, "GY-302_BH1750", {1: "+3V3", 2: "GND", 3: "I2C2_SCL", 4: "I2C2_SDA", 5: "GND"},
   108.3, R2Y, "W2 BH1750 0x23", ["3V", "G", "CL", "DA", "AD"])
qw("J16", "I2C2", 120.2, R2Y - 1.8, "W2 QWIIC")
qw("J17", "I2C2", 128.3, R2Y - 1.8, "W2 QWIIC")
qw("J27", "I2C2", 136.4, R2Y - 1.8, "W2 QWIIC")
ph("J25", 4, "IMU_UART4", {1: "+3V3", 2: "GND", 3: "UART4_TXO", 4: "UART4_TX"},
   154.1, R2Y, "IMU UART4 D15", ["3V", "G", "TX", "RX"])
ph("J23", 4, "LIDAR_UART3", {1: "+5V_FUSED", 2: "GND", 3: "LIDAR_TXO", 4: "UART3_TX"},
   176.5, R2Y, "LIDAR 5V UART3", ["5V", "G", "TX", "RX"])
# row 3 -- GPIO sensors, all 3V3
ph("J18", 4, "RCWL-1601", {1: "+3V3", 2: "SONAR_TRIG", 3: "SONAR_ECHO", 4: "GND"},
   107.3, R3Y, "SONAR D52/50", ["3V", "TR", "EC", "G"])
ph("J19", 3, "DHT11", {1: "+3V3", 2: "DHT_DATA", 3: "GND"},
   120.0, R3Y, "DHT11 A5", ["3V", "D", "G"])
ph("J20", 3, "BUZZER", {1: "+3V3", 2: "BUZZ", 3: "GND"},
   133.75, R3Y, "BUZZER", ["3V", "S", "G"])
ph("J24", 2, "LIDAR_PWM", {1: "LIDAR_PWM_PORT", 2: "GND"},
   150.1, R3Y, "LIDAR PWM", ["P", "G"])
# v1.6: NEO-7M GPS on Serial2 replaces the AUX A0 port. 3V3 power: the u-blox IO is 3.3V
# and the module's LDO takes 3.3-5V, so nothing on this cable can reach 5V. 1k on its TX like J23/J25.
ph("J28", 4, "GPS_NEO-7M", {1: "+3V3", 2: "GND", 3: "GPS_TXO", 4: "UART2_TX"},
   162.6, 81.0, "GPS UART2 D19", ["3V", "G", "TX", "RX"], rot=270, label_at=(162.6, 73.9, 0))
# spare port for sensors added later: D44/D46 digital
ph("J29", 4, "AUX_4P", {1: "+3V3", 2: "GPIO_D44", 3: "GPIO_D46", 4: "GND"},
   176.3, R3Y, "AUX D44/46", ["3V", "44", "46", "G"])
# row 4 -- actuators + power
# BME280 moved out of row 1 (v1.4) to make room for the display port
ph("J12", 4, "BME280", {1: "+3V3", 2: "GND", 3: "I2C1_SCL", 4: "I2C1_SDA"},
   105.3, 92.3, "W1 BME280", ["3V", "G", "CL", "DA"], rot=90)
# v1.5: I2C gyro on Wire1 (3V3 power so the module's pull-ups never see 5V) and the MQ135.
# MQ135 runs its heater on fused 5V; AO swings to ~5V, so 10k/15k divides it to <=3.0V on A1.
# DO stays off the board (it is a 5V comparator output).
ph("J32", 4, "GYRO_I2C1", {1: "+3V3", 2: "GND", 3: "I2C1_SCL", 4: "I2C1_SDA"},
   119.1, R4Y, "W1 GYRO I2C", ["3V", "G", "CL", "DA"])
ph("J33", 4, "MQ135", {1: "+5V_FUSED", 2: "GND", 3: None, 4: "MQ135_AO5V"},
   132.9, R4Y, "MQ135 5V A1", ["5V", "G", "NC", "AO"])
ph("J21", 5, "RELAYS", {1: "GND", 2: "RLY_CAM", 3: "RLY_STRIP", 4: "RLY_LED", 5: "RLY_VCC"},
   177.6, R4Y, "RELAYS D26/28/30", ["G", "1", "2", "3", "V"])
P("J22", "Connector_Generic:Conn_01x07", "L298N", PH.format(n=7),
  {1: "MOT_ENA", 2: "MOT_IN1", 3: "MOT_IN2", 4: "MOT_IN3", 5: "MOT_IN4", 6: "MOT_ENB", 7: "GND"},
  at=(158.42, R4Y + 0.6, 270), label="L298N D2-D7", legend=["ENA", "IN1", "IN2", "IN3", "IN4", "ENB", "G"])
P("TP1", "Connector:TestPoint", "D72_WIRE", TP, {1: "BUZZ_D72"}, at=(143.75, R3Y, 0),
  label="D72")

# ---------------------------------------------------------------- passives
def r(ref, val, a, b, key, at):
    P(ref, "Device:R", val, R0805, {1: a, 2: b}, at=at, lcsc=LCSC[key])

def c(ref, val, a, b, key, fp, at):
    P(ref, "Device:C", val, fp, {1: a, 2: b}, at=at, lcsc=LCSC[key])

# I2C pull-ups: populated but DISCONNECTED until the jumper is blobbed --
# the modules already carry their own.
PU = {"I2C0": [(187.0, 53.9, 0), (187.0, 56.2, 0), (187.0, 58.5, 0)],
      "I2C1": [(165.5, R1Y, 90), (167.6, R1Y, 90), (163.0, R1Y, 90)],
      "I2C2": [(144.2, R2Y, 90), (146.3, R2Y, 90), (141.75, R2Y, 90)]}
for i, bus in enumerate(["I2C0", "I2C1", "I2C2"]):
    a, b, j = PU[bus]
    P("JP%d" % (i + 1), "Jumper:SolderJumper_2_Open", "PU_" + bus, SJ2, {1: "+3V3", 2: bus + "_PU"}, at=j)
    r("R%d" % (2 * i + 1), "4k7", bus + "_PU", bus + "_SDA", "4k7", a)
    r("R%d" % (2 * i + 2), "4k7", bus + "_PU", bus + "_SCL", "4k7", b)
r("R7", "10k", "+3V3", "DHT_DATA", "10k", (126.75, R3Y, 90))
r("R8", "1k", "LIDAR_TXO", "UART3_RX", "1k", (184.5, R2Y, 90))   # current limit vs a 5V TX
r("R9", "1k", "UART4_TXO", "UART4_RX", "1k", (161.85, R2Y + 0.5, 90))
r("R14", "1k", "GPS_TXO", "UART2_RX", "1k", (168.5, 76.0, 90))
r("R10", "1k", "+3V3", "LED3V3_A", "1k", (119.0, 97.5, 0))
r("R11", "1k", "+5V_FUSED", "LED5V_A", "1k", (189.5, 66.0, 90))
r("R12", "10k", "MQ135_AO5V", "MQ135_AO", "10k", (123.0, 72.9, 0))   # MQ135 divider: 5V * 15/25 = 3.0V max
r("R13", "15k", "MQ135_AO", "GND", "15k", (127.0, 72.9, 0))
P("D1", "Device:LED", "3V3 green", LED0805, {1: "GND", 2: "LED3V3_A"}, at=(123.3, 97.5, 180), lcsc=LCSC["LEDG"])
P("D2", "Device:LED", "5V red", LED0805, {1: "GND", 2: "LED5V_A"}, at=(187.0, 63.0, 270), lcsc=LCSC["LEDR"])
# 5V path: Giga 5V pin -> F1 -> +5V_FUSED
P("F1", "Device:Polyfuse", "1.1A PTC", F1206, {1: "+5V", 2: "+5V_FUSED"}, at=(143.5, 87.5, 0), lcsc=LCSC["PTC"])
c("C1", "22u", "+5V_FUSED", "GND", "22u", C1206, (165.0, 70.0, 90))
c("C2", "100n", "+5V_FUSED", "GND", "100n", C0805, (186.8, R2Y, 90))
c("C3", "22u", "+3V3", "GND", "22u", C1206, (168.0, 70.5, 90))
c("C4", "100n", "+3V3", "GND", "100n", C0805, (115.0, 72.9, 0))   # v1.5: C5/C6 dropped for room, C3 22u + C4 cover 3V3
# relay VCC: default fused 5V (1-2 bridged). Cut, bridge 2-3 for 3V3 relay/SSR modules.
P("JP4", "Jumper:SolderJumper_3_Bridged12", "RLY_VCC_SEL", SJ3,
  {1: "+5V_FUSED", 2: "RLY_VCC", 3: "+3V3"}, at=(187.3, R4Y, 90))
# buzzer: default D72 via flying wire to TP1 (what main.ino uses); 2-3 = D34 on the shield header
P("JP5", "Jumper:SolderJumper_3_Bridged12", "BUZZ_SEL", SJ3,
  {1: "BUZZ_D72", 2: "BUZZ", 3: "BUZZ_D34"}, at=(140.8, R3Y, 90))
# LIDAR PWM: default tied to GND (LD19 manual: PWM must be grounded without ext speed ctl).
# v1.4: D10 is the LCD CS now -- never bridge 2-3 while the LCD is fitted
P("JP7", "Jumper:SolderJumper_3_Bridged12", "LIDAR_PWM_SEL", SJ3,
  {1: "GND", 2: "LIDAR_PWM_PORT", 3: "LCD_CS"}, at=(156.25, R3Y, 90))
# ---------------------------------------------------------------- v1.1: spare GPIO
# 2x7 male breakout, top-left: top row 3V3 + PWM D10-D13 + Serial2 D18/D19,
# bottom row GND + A1-A4, A6, A7. Footprint at rot 90: odd pads = bottom row.
BRK_X, BRK_Y = 101.2, 57.74          # pad 1 (bottom-left)
P("J30", "Connector_Generic:Conn_02x07_Odd_Even", "GPIO_BREAKOUT",
  "Blackout:Breakout_2x07_P2.54mm",
  {1: "GND", 2: "+3V3", 3: "MQ135_AO", 4: "LCD_CS", 5: "GPIO_A2", 6: "GPIO_D11",
   7: "GPIO_A3", 8: "GPIO_D12", 9: "GPIO_A4", 10: "GPIO_D13", 11: "GPIO_A6", 12: "UART2_TX",
   13: "GPIO_A7", 14: "UART2_RX"}, at=(BRK_X, BRK_Y, 90), hand=True)
# 2x2 3V3/GND rail next to JSIDE, for anything hung off D22-D53
RAIL_X, RAIL_Y = 185.0, 80.9         # pad 1 (bottom-left)
P("J31", "Connector_Generic:Conn_02x02_Odd_Even", "3V3_GND_RAIL",
  "Blackout:Breakout_2x02_P2.54mm",
  {1: "GND", 2: "+3V3", 3: "GND", 4: "+3V3"}, at=(RAIL_X, RAIL_Y, 90), hand=True)

# Giga header silkscreen, pad order, exact Giga names (D-numbers for GPIO)
GIGA_SILK = {
    "J1": ["NC", "IOREF", "RST", "3V3", "5V", "GND", "GND", "VIN"],
    "J2": ["SCL1", "SDA1", "AREF", "GND", "D13", "D12", "D11", "D10", "D9", "D8"],
    "J3": ["A%d" % i for i in range(8)],
    "J4": ["D7", "D6", "D5", "D4", "D3", "D2", "D1", "D0"],
    "J5": ["A8", "A9", "A10", "A11", "DAC0", "DAC1", "CANRX", "CANTX"],
    "J6": ["D%d" % i for i in range(14, 22)],
}
# nets that are a breakout or an OPTION, not a function the shield performs
NOT_USED = {"BUZZ_D34"} | {n for n in
            ["GPIO_D12", "GPIO_A2", "GPIO_A3", "GPIO_A4", "GPIO_A6", "GPIO_A7"]}

MHS = [(115.24, 49.2), (113.97, 97.46), (166.04, 64.44), (166.04, 92.38), (190.17, 49.2), (196.52, 97.46)]
for i, (x, y) in enumerate(MHS):
    P("H%d" % (i + 1), "Mechanical:MountingHole", "M3", MH, {}, at=(x, y, 0))
