# Arduino Mega — Sensor Hub (Blackout V1)

Exploration rover inspired by Mars rovers. Reads environment sensors and prints data to Serial USB. Designed for exploring hazardous or inaccessible places (caves, unstable structures, disaster zones).

**Phase 1 — standalone sensor reading.** Serial communication to Uno will be added later.

## Sensors

| Sensor | Pin | Function |
|--------|-----|----------|
| DHT11/DHT22 | D23 | Temp + humidity |
| MPU6050 | SDA/SCL (20/21) | Gyro + accelerometer (roll, pitch, yaw) |
| HC-SR04 | A6/A5 (TRIG/ECHO) | Ultrasonic distance |
| MQ-2 | A0/D22 | Smoke/gas detection (analog + digital) |
| MQ-135 | A1/D26 | Air quality / CO2 (analog + digital) |
| Microphone | A2 | Sound level (MAX9814/KY-038) |

## Compile & Upload

```
cd arduino-mega/main
arduino-cli compile --fqbn arduino:avr:mega:cpu=atmega2560
arduino-cli upload --port /dev/cu.usbserial-140
```

## Output

Prints CSV to Serial (9600 baud) each cycle:

```
S:<temp>,<humid>,<dist_cm>,<smoke>,<airq>,<roll>,<pitch>,<yaw>
```

## Libraries

- DHT sensor library (Adafruit)
- MPU6050_light (ejoyneering)
- NewPing (Tim Eckel)
- MQUnifiedsensor (Miguel A. Califa)

## Power

Vin → 7–12V battery (or USB for dev). GND shared with Uno.
