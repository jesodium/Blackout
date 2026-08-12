#!/usr/bin/env bash
set -euo pipefail

# prints the robot's pinout. reads the real #defines out of the firmware so it
# can't drift — LABELS below only supplies the human name for each symbol.
# IMPORTANT NOTE: a pin with no #define (i2c, power, cs-to-gnd) can't be parsed
# out of source, so those live in FIXED. add there if a wire has no symbol.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

ROOT="$ROOT" python3 - "$@" <<'PY'
import os, re, sys

ROOT = os.environ['ROOT']

# symbol -> (part, note). anything ending _PIN/_GPIO_NUM prints even if unlisted,
# so a new sensor shows up here the day it's wired.
LABELS = {
    'giga-r1/main/main.ino': {
        'TRIG_PIN':  ('HC-SR04 ultrasonic', 'trig (out)'),
        'ECHO_PIN':  ('HC-SR04 ultrasonic', 'echo (in, INPUT_PULLDOWN — floats HIGH bare)'),
        'OLED_CLK':  ('OLED SSD1306 128x64', 'sw-spi clock'),
        'OLED_DATA': ('OLED SSD1306 128x64', 'sw-spi data (mosi)'),
        'OLED_RST':  ('OLED SSD1306 128x64', 'reset'),
        'OLED_DC':   ('OLED SSD1306 128x64', 'data/command'),
        'ENA':       ('L298N motor driver', 'motor A speed (PWM) — pull the ENA jumper'),
        'IN1':       ('L298N motor driver', 'motor A dir'),
        'IN2':       ('L298N motor driver', 'motor A dir'),
        'IN3':       ('L298N motor driver', 'motor B dir'),
        'IN4':       ('L298N motor driver', 'motor B dir'),
        'ENB':       ('L298N motor driver', 'motor B speed (PWM, not bench-proven — D10 if no ramp)'),
    },
    'esp32-cam/main/main.ino': {
        'LED_PIN':   ('Flash LED', 'boot=slow blink, error=fast, connected=dim PWM 32'),
        'PWDN_GPIO_NUM':  ('OV2640 camera', 'power down'),
        'RESET_GPIO_NUM': ('OV2640 camera', 'reset (-1 = tied, unused)'),
        'XCLK_GPIO_NUM':  ('OV2640 camera', 'xclk'),
        'SIOD_GPIO_NUM':  ('OV2640 camera', 'sccb sda'),
        'SIOC_GPIO_NUM':  ('OV2640 camera', 'sccb scl'),
        'VSYNC_GPIO_NUM': ('OV2640 camera', 'vsync'),
        'HREF_GPIO_NUM':  ('OV2640 camera', 'href'),
        'PCLK_GPIO_NUM':  ('OV2640 camera', 'pixel clock'),
    },
}

# collapse the 8-wire DVP data bus into one row instead of eight
BUS = {'esp32-cam/main/main.ino': (re.compile(r'^Y(\d)_GPIO_NUM$'), 'OV2640 camera', 'data bus D0-D7')}

# wires with no symbol in source
FIXED = {
    'giga-r1/main/main.ino': [
        ('BME280 temp/humid/press', 'D20', 'SDA (hardware I2C — cannot move to D44/D46)'),
        ('BME280 temp/humid/press', 'D21', 'SCL'),
        ('OLED SSD1306 128x64',     'GND', 'CS tied low — only device on the bus'),
    ],
}

BOARDS = [
    ('Arduino Giga R1 WiFi', 'giga-r1/main/main.ino', 'D',
     'PWM only on D2-D13. A8-A11 are ADC-only (digitalWrite errors out).'),
    ('ESP32-CAM (AI-Thinker)', 'esp32-cam/main/main.ino', 'GPIO',
     'Standalone WiFi streamer, no BLE. GPIO0 jumper left on = looks like a dead board.'),
]

BOLD, DIM, CYAN, RESET = '\033[1m', '\033[2m', '\033[36m', '\033[0m'

for board, path, prefix, note in BOARDS:
    src = open(os.path.join(ROOT, path)).read()
    labels = LABELS.get(path, {})
    rows, bus_pins = [], []
    bus_re, bus_part, bus_note = BUS.get(path, (None, None, None))

    for name, val in re.findall(r'^#define\s+(\w+)\s+(-?\d+)\b', src, re.M):
        if bus_re and bus_re.match(name):
            bus_pins.append(int(val))
            continue
        if name in labels:
            part, why = labels[name]
        elif name.endswith(('_PIN', '_GPIO_NUM')):
            part, why = '(unlabelled — add to cmds/pins.sh)', ''
        else:
            continue  # not a pin: timings, speeds, sizes
        pin = f'{prefix}{val}' if int(val) >= 0 else '—'
        rows.append((part, pin, name, why))

    if bus_pins:
        pins = ', '.join(f'{prefix}{p}' for p in sorted(bus_pins))
        rows.append((bus_part, f'{len(bus_pins)} pins', 'Y2-Y9_GPIO_NUM', f'{bus_note}: {pins}'))
    for part, pin, why in FIXED.get(path, []):
        rows.append((part, pin, '', why))

    rows.sort(key=lambda r: (r[0], r[1]))
    w = [max(len(r[i]) for r in rows) for i in range(3)]

    print(f'\n{BOLD}{board}{RESET}  {DIM}{path}{RESET}')
    print(f'{DIM}{note}{RESET}')
    print(f'{CYAN}{"PART".ljust(w[0])}  {"PIN".ljust(w[1])}  {"SYMBOL".ljust(w[2])}  NOTE{RESET}')
    for part, pin, sym, why in rows:
        print(f'{part.ljust(w[0])}  {pin.ljust(w[1])}  {DIM}{sym.ljust(w[2])}{RESET}  {DIM}{why}{RESET}')
print()
PY
