// Uno R4 WiFi — sensor hub. Reads sensors, broadcasts CSV over BLE notify.
// Same "S:" line format the server already parses (temp,humid,dist,smoke,
// airq,roll,pitch,yaw,co,co_alert) so server.js needs no protocol change.
// Order matters: ArduinoGraphics before Arduino_LED_Matrix.
#include <ArduinoGraphics.h>
#include <Arduino_LED_Matrix.h>
#include <TextAnimation.h>
#include <ArduinoBLE.h>
#include <Servo.h>
#include <Wire.h>
#include <Adafruit_BME280.h>

#define MQ9_AO A3
#define MQ9_DO 13
#define TRIG_PIN 11
#define ECHO_PIN 12
#define SERVO_PIN 9
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
ArduinoLEDMatrix matrix;
Adafruit_BME280 bme; // I2C: SDA/SCL, addr 0x76 (0x77 if BME280's SDO is pulled high)
bool bmeOk = false;
// Max frames ~= text length * font width (5px/char for Font_5x7) — 80 covers
// "  BLACKOUT  " with headroom.
TEXT_ANIMATION_DEFINE(matrixAnim, 80)
volatile bool matrixReplay = false;

unsigned long lastSend = 0;
float coF = -1;   // EMA state, -1 = uninitialised
float distF = -1; // EMA state, -1 = uninitialised

void setup() {
  Serial.begin(9600);
  pinMode(MQ9_DO, INPUT);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  servo.attach(SERVO_PIN);

  Wire.begin();
  bmeOk = bme.begin(0x76) || bme.begin(0x77);
  if (!bmeOk) Serial.println("BME280 not found (checked 0x76/0x77) — temp/humid will read 0");

  matrix.begin();
  matrix.beginDraw();
  matrix.stroke(0xFFFFFFFF);
  matrix.textFont(Font_5x7);
  matrix.textScrollSpeed(60);
  matrix.setCallback(matrixDone);
  matrix.beginText(0, 1, 0xFFFFFF);
  matrix.println("BLACKOUT ");
  matrix.endTextAnimation(SCROLL_LEFT, matrixAnim);
  matrix.loadTextAnimationSequence(matrixAnim);
  matrix.play();
  matrix.endDraw();

  if (!BLE.begin()) {
    while (1) { Serial.println("BLE init failed"); delay(1000); }
  }
  // Known ArduinoBLE/R4 WiFi bug: the advertised name always shows as
  // "Arduino" regardless of setLocalName() (the ESP32-S3 co-processor doesn't
  // honor it in the ad packet, only in the post-connect GATT device-name
  // characteristic). So the browser filters by this service UUID instead.
  BLE.setLocalName("BLACKOUT-V1");
  BLE.setAdvertisedService(sensorService);
  sensorService.addCharacteristic(sensorChar);
  sensorService.addCharacteristic(cmdChar);
  BLE.addService(sensorService);
  BLE.advertise();
  Serial.println("BLE advertising as BLACKOUT-V1");
}

void matrixDone() { matrixReplay = true; } // IRQ context — keep it fast

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
// Go non-blocking (millis stepper) if it bites the BLE supervision timeout.
void slowSweep() {
  for (int a = 0; a <= 180; a += 2) { servo.write(a); delay(45); }
  for (int a = 180; a >= 0; a -= 5) { servo.write(a); delay(10); }
}

int readAvg(int pin) {
  long sum = 0;
  for (uint8_t i = 0; i < GAS_SAMPLES; i++) sum += analogRead(pin);
  return sum / GAS_SAMPLES;
}

// One HC-SR04 ping in cm via plain pulseIn() — portable across cores, unlike
// NewPing's AVR-cycle-counted timing (wrong on this board's clock speed).
// Returns -1 on timeout (no echo / out of range).
float pingCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long us = pulseIn(ECHO_PIN, HIGH, SONAR_TIMEOUT_US);
  Serial.print("ping us="); Serial.println(us); // DEBUG: remove once wiring confirmed
  return us > 0 ? us / 58.0 : -1;
}

// Median of SONAR_ITER pings drops spikes, same intent as the old NewPing call.
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

  if (cmdChar.written()) {            // server said "time to move the servo"
    if (cmdChar.value() == "scan") slowSweep(); // Sage's look-around
    else sweepServo();                          // quick manual check
  }

  if (matrixReplay) { // loop the scroll forever
    matrixReplay = false;
    matrix.beginText(0, 1, 0xFFFFFF);
    matrix.println("BLACKOUT ");
    matrix.endTextAnimation(SCROLL_LEFT, matrixAnim);
    matrix.loadTextAnimationSequence(matrixAnim);
    matrix.play();
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

  float temp = bmeOk ? bme.readTemperature() : 0;
  float humid = bmeOk ? bme.readHumidity() : 0;

  // IMPORTANT NOTE: only BME280 + MQ-9 + HC-SR04 exist — no MQ-2/MQ-135.
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

  Serial.println(line);
  sensorChar.writeValue(line);
}
