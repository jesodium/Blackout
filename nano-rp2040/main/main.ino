// Nano RP2040 Connect — sensor hub. Reads sensors, broadcasts CSV over BLE notify.
// Ported from the Uno R4 WiFi build (arduino-uno-r4/main). BLE goes through the
// onboard u-blox NINA (ESP32) module via the SAME ArduinoBLE API, so the service/
// characteristic setup is unchanged and the dashboard connects with no edits.
//
// Two deltas vs the R4:
//   1. No onboard LED matrix — the "BLACKOUT" scroll is gone (R4-only hardware).
//   2. RP2040 is 3.3V, NOT 5V-tolerant. DHT11 + L298N logic are fine at 3.3V,
//      but the two 5V sensors below MUST NOT be wired direct — see the NOTE at
//      their pin defs. Leave them unwired until you have resistor dividers.
//
// Same "S:" line format the server parses (temp,humid,dist,smoke,airq,roll,pitch,
// yaw,co,co_alert,pressure) — pressure is a trailing optional field, sent as 0
// here since the DHT11 (which replaced the BME280) has no pressure sensor.
#include <ArduinoBLE.h>
#include <Servo.h>
#include <DHT11.h>

// IMPORTANT NOTE: 5V sensor — HC-SR04 ECHO and MQ-9 AO swing to ~5V. On this 3.3V
// board they need a divider (e.g. 1k/2k: 5V*2/3 ≈ 3.3V) before the pin, or they
// can damage the input. TRIG (output) and MQ9_DO (open-collector, add pullup to
// 3.3V) are fine. Don't wire ECHO_PIN / MQ9_AO direct.
#define MQ9_AO A3
#define MQ9_DO 13
#define TRIG_PIN 11
#define ECHO_PIN 12
#define SERVO_PIN 9
#define DHT_PIN 8               // DHT11 single-wire data (3.3V-safe, no divider)
// L298N dual motor driver. Motor A = left, Motor B = right (swap OUT pairs if
// a wheel spins the wrong way). ENA/ENB on PWM pins (D3/D6) for speed control.
// L298N logic triggers fine at 3.3V. DRIVE_SPEED 0-255; below ~60 it stalls.
#define ENA 3
#define IN1 2
#define IN2 4
#define IN3 5
#define IN4 7
#define ENB 6
#define DRIVE_SPEED 110
#define SONAR_ITER 3            // pings per reading; median drops spikes
#define SONAR_TIMEOUT_US 25000UL // ~430cm round-trip + margin; no echo = timeout
#define DIST_ALPHA 0.6 // EMA smoothing on distance — ultrasonic is already clean
                        // (median-of-3 kills spikes), so light smoothing is enough.

// Burst-average kills per-sample ADC noise, EMA across cycles smooths the stream.
#define GAS_SAMPLES 8
#define GAS_ALPHA 0.15
#define SEND_INTERVAL 100

BLEService sensorService("19b10000-e8f2-537e-4f6c-d104768a1214");
BLEStringCharacteristic sensorChar("19b10001-e8f2-537e-4f6c-d104768a1214", BLERead | BLENotify, 100);
// Command channel: server (via the browser's Web Bluetooth) writes here to
// trigger actions. "scan" = slow look-around pan; anything else = quick sweep check.
BLEStringCharacteristic cmdChar("19b10002-e8f2-537e-4f6c-d104768a1214", BLEWrite, 20);

Servo servo;
DHT11 dht(DHT_PIN); // temp/humid over single-wire; no pressure (unlike the old BME280)

unsigned long lastSend = 0;
int dhtTemp = 0, dhtHumid = 0; // last good DHT11 reading (1°C / 1% resolution)
unsigned long lastDht = 0;
float coF = -1;   // EMA state, -1 = uninitialised
float distF = -1; // EMA state, -1 = uninitialised

void setup() {
  Serial.begin(9600);
  pinMode(MQ9_DO, INPUT);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  servo.attach(SERVO_PIN);

  for (int p : {ENA, IN1, IN2, IN3, IN4, ENB}) pinMode(p, OUTPUT);
  analogWrite(ENA, DRIVE_SPEED); // set both motor speeds (PWM)
  analogWrite(ENB, DRIVE_SPEED);
  stopMotors();

  dht.setDelay(0); // we throttle reads to 1Hz ourselves; skip the lib's blocking delay

  if (!BLE.begin()) {
    while (1) { Serial.println("BLE init failed"); delay(1000); }
  }
  // Filter by service UUID on the browser side, not name — keep it identical to
  // the R4 build so the dashboard's Web Bluetooth filter matches unchanged.
  BLE.setLocalName("BLACKOUT-V1");
  BLE.setAdvertisedService(sensorService);
  sensorService.addCharacteristic(sensorChar);
  sensorService.addCharacteristic(cmdChar);
  BLE.addService(sensorService);
  BLE.advertise();
  Serial.println("BLE advertising as BLACKOUT-V1");
}

// L298N: each motor is one IN pair. HIGH/LOW = one direction, LOW/HIGH = other,
// LOW/LOW = coast/stop. Motor A left, Motor B right.
void motorA(bool fwd) { digitalWrite(IN1, fwd); digitalWrite(IN2, !fwd); }
void motorB(bool fwd) { digitalWrite(IN3, fwd); digitalWrite(IN4, !fwd); }
void stopMotors()  { digitalWrite(IN1,LOW); digitalWrite(IN2,LOW); digitalWrite(IN3,LOW); digitalWrite(IN4,LOW); }
void forward()     { motorA(true);  motorB(true);  }
void reverse()     { motorA(false); motorB(false); }
void turnLeft()    { motorA(false); motorB(true);  } // spin in place
void turnRight()   { motorA(true);  motorB(false); }

// One full 0→180→0 sweep, ~1.1s. IMPORTANT NOTE: blocking — the loop (sensor
// sends + BLE poll) pauses for the duration. Fine under the BLE supervision
// timeout at once-per-30s cadence; go non-blocking (millis stepper) if it bites.
void sweepServo() {
  for (int a = 0; a <= 180; a += 5) { servo.write(a); delay(15); }
  for (int a = 180; a >= 0; a -= 5) { servo.write(a); delay(15); }
}

// Slow "look around": pan 0→180 over ~4s so the cam (mounted on this servo) gives
// clean, distinct stills for the server to grab, then snap back. IMPORTANT NOTE:
// blocking like sweepServo — sensor sends pause ~4-5s during this deliberate look.
void slowSweep() {
  for (int a = 0; a <= 180; a += 2) { servo.write(a); delay(45); }
  for (int a = 180; a >= 0; a -= 5) { servo.write(a); delay(10); }
}

int readAvg(int pin) {
  long sum = 0;
  for (uint8_t i = 0; i < GAS_SAMPLES; i++) sum += analogRead(pin);
  return sum / GAS_SAMPLES;
}

// One HC-SR04 ping in cm via plain pulseIn() — portable across cores.
// Returns -1 on timeout (no echo / out of range).
float pingCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long us = pulseIn(ECHO_PIN, HIGH, SONAR_TIMEOUT_US);
  return us > 0 ? us / 58.0 : -1;
}

// Median of SONAR_ITER pings drops spikes.
float medianPingCm() {
  float s[SONAR_ITER];
  uint8_t n = 0;
  for (uint8_t i = 0; i < SONAR_ITER; i++) {
    float v = pingCm();
    if (v >= 0) s[n++] = v;
    delay(60); // HC-SR04 needs >=60ms between pings or the transducer ring-down
               // from the prior burst latches a false ~20cm echo (datasheet spec)
  }
  if (n == 0) return -1;
  for (uint8_t i = 1; i < n; i++) { // insertion sort, n is tiny
    float key = s[i];
    int j = i - 1;
    while (j >= 0 && s[j] > key) { s[j + 1] = s[j]; j--; }
    s[j + 1] = key;
  }
  return s[n / 2];
}

void loop() {
  BLE.poll();

  if (cmdChar.written()) {            // server-issued command
    String c = cmdChar.value();
    if      (c == "scan")  slowSweep();     // Sage's look-around
    else if (c == "fwd")   forward();
    else if (c == "rev")   reverse();
    else if (c == "left")  turnLeft();
    else if (c == "right") turnRight();
    else if (c == "stop")  stopMotors();
    else sweepServo();                      // quick manual check
  }

  unsigned long now = millis();
  if (now - lastSend < SEND_INTERVAL) return;
  lastSend = now;

  int coRaw   = readAvg(MQ9_AO);
  int coAlert = digitalRead(MQ9_DO);
  coF = (coF < 0) ? coRaw : coF + GAS_ALPHA * (coRaw - coF);
  int co = (int)(coF + 0.5);

  float raw = medianPingCm();
  if (raw >= 0) {
    distF = (distF < 0) ? raw : distF + DIST_ALPHA * (raw - distF);
  } else {
    distF = -1; // miss = out of range, don't hold a stale value
  }
  float dist = (distF < 0) ? 0 : distF;

  // DHT11 tops out at 1 read/sec; sample once a second and reuse the cached value
  // on the faster send cadence. Keep the last good reading on a transient error.
  if (now - lastDht >= 1000) {
    lastDht = now;
    int t, h;
    if (dht.readTemperatureHumidity(t, h) == 0) { dhtTemp = t; dhtHumid = h; }
  }
  int temp = dhtTemp;
  int humid = dhtHumid;
  int pressure = 0; // DHT11 has no barometer; field kept 0 for CSV/parser compat

  // IMPORTANT NOTE: only DHT11 + MQ-9 + HC-SR04 exist — no MQ-2/MQ-135.
  // airq mirrors the MQ-9 (co) reading until a real air-quality sensor lands.
  String line = "S:";
  line += temp;
  line += ",";
  line += humid;
  line += ",";
  line += dist;
  line += ",0,";
  line += co;
  line += ",0,0,0,";
  line += co;
  line += ",";
  line += coAlert;
  line += ",";
  line += pressure;

  Serial.println(line);
  sensorChar.writeValue(line);
}
