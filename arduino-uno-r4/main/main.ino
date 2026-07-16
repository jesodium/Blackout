// Uno R4 WiFi — sensor hub + motion routines. Reads sensors, broadcasts CSV over
// BLE notify. Same "S:" line format the server already parses (temp,humid,dist,
// smoke,airq,roll,pitch,yaw,co,co_alert,pressure,routine) — everything from co
// onward is a trailing optional field, so older lines without them still parse.
// Also emits "E:analyze" lines: routine-driven events for the dashboard, not
// telemetry. The server ignores anything that isn't "S:".
// Order matters: ArduinoGraphics before Arduino_LED_Matrix.
#include <ArduinoGraphics.h>
#include <Arduino_LED_Matrix.h>
#include <TextAnimation.h>
#include <ArduinoBLE.h>
#include <DHT11.h>
#include "routines.h" // Op/Step + the PRESENTATION and RUN tables

#define DHT_PIN 2   // DHT11 data pin. D2 = clean digital; NOT D13 (onboard LED
                    // shares that line and glitches the bit-banged timing).
#define TRIG_PIN 11
#define ECHO_PIN 12
// L298N direction pins. D4-D7 = contiguous free block, no timer/peripheral
// conflict (D11/D12 sonar, D2 DHT, D13 onboard LED all clear). D9 is free —
// it drove the camera servo before the camera was fixed in place.
#define IN1 4  // motor A
#define IN2 5
#define IN3 6  // motor B
#define IN4 7
// Enable pins = PWM speed control. D3/D10 are the free PWM-capable pins here.
// IMPORTANT NOTE: pull the ENA/ENB jumpers off the L298N first — left on, they
// tie enable to 5V and these pins do nothing (motors stay full speed).
#define ENA 3  // motor A speed
#define ENB 10 // motor B speed
#define SONAR_ITER 3            // pings per reading; median drops spikes
#define SONAR_TIMEOUT_US 25000UL // ~430cm round-trip + margin; no echo = timeout
#define DIST_ALPHA 0.6 // EMA smoothing on distance — ultrasonic is already clean
                        // (median-of-3 kills spikes), so light smoothing is enough.

#define DHT_INTERVAL 2000 // DHT11 tops out ~1Hz; read every 2s, cache between.
#define SEND_INTERVAL 100

BLEService sensorService("19b10000-e8f2-537e-4f6c-d104768a1214");
BLEStringCharacteristic sensorChar("19b10001-e8f2-537e-4f6c-d104768a1214", BLERead | BLENotify, 100);
// Command channel: server (via the browser's Web Bluetooth) writes here to
// trigger actions. "go,<routine>" starts a motion routine; "stop" cuts the motors.
BLEStringCharacteristic cmdChar("19b10002-e8f2-537e-4f6c-d104768a1214", BLEWrite, 20);

// The routine tables live in routines.h — that's the file to edit to change what
// the robot does. Everything here is the machinery that runs them: the board plays
// a routine standalone (the browser just writes "go,presentation"), so a BLE
// dropout mid-run doesn't strand it. Steps advance on a millis() stepper, never
// delay() — a blocking routine would freeze loop(), killing BLE.poll() and the
// telemetry send for the whole run.
const Step* routine = nullptr; // null = idle
uint8_t stepIdx = 0;
unsigned long stepStart = 0;

ArduinoLEDMatrix matrix;
DHT11 dht(DHT_PIN);
int dhtTemp = 0, dhtHumid = 0; // last good DHT11 read, cached between polls
// Max frames ~= text length * font width (5px/char for Font_5x7) — 80 covers
// "  BLACKOUT  " with headroom.
TEXT_ANIMATION_DEFINE(matrixAnim, 80)
volatile bool matrixReplay = false;

unsigned long lastSend = 0;
unsigned long lastDht = 0;
float distF = -1; // EMA state, -1 = uninitialised

void setup() {
  Serial.begin(9600);
  Serial.setTimeout(50); // readStringUntil on a partial line must not block the
                         // default 1s — that stalls BLE.poll + the routine stepper
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  for (int p = IN1; p <= IN4; p++) { pinMode(p, OUTPUT); digitalWrite(p, LOW); }
  pinMode(ENA, OUTPUT); pinMode(ENB, OUTPUT);
  analogWrite(ENA, 0); analogWrite(ENB, 0); // stopped until told otherwise

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

// Both motors forward at `speed` (0-255 PWM). If a motor spins backward, swap
// that motor's two output wires at the L298N screw terminals — don't flip the
// pin logic here or forward/back stop meaning the same thing.
void forward(uint8_t speed) {
  digitalWrite(IN1, LOW); digitalWrite(IN2, HIGH);
  digitalWrite(IN3, LOW); digitalWrite(IN4, HIGH);
  analogWrite(ENA, speed); analogWrite(ENB, speed);
}

void back(uint8_t speed) {
  digitalWrite(IN1, HIGH); digitalWrite(IN2, LOW);
  digitalWrite(IN3, HIGH); digitalWrite(IN4, LOW);
  analogWrite(ENA, speed); analogWrite(ENB, speed);
}

// Pivot turns: motors oppose, so the robot spins about its own centre rather
// than arcing. Turn *angle* is whatever `ms` buys you at this speed — open loop,
// no encoders, so it drifts with battery charge. Tune on the field, not the bench.
void left(uint8_t speed) {
  digitalWrite(IN1, LOW); digitalWrite(IN2, HIGH);
  digitalWrite(IN3, HIGH); digitalWrite(IN4, LOW);
  analogWrite(ENA, speed); analogWrite(ENB, speed);
}

void right(uint8_t speed) {
  digitalWrite(IN1, HIGH); digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW); digitalWrite(IN4, HIGH);
  analogWrite(ENA, speed); analogWrite(ENB, speed);
}

void halt() {
  analogWrite(ENA, 0); analogWrite(ENB, 0);
  digitalWrite(IN1, LOW); digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW); digitalWrite(IN4, LOW);
}

void applyStep(const Step& s) {
  switch (s.op) {
    case FWD:   forward(s.pwm); break;
    case BACK:  back(s.pwm);    break;
    case LEFT:  left(s.pwm);    break;
    case RIGHT: right(s.pwm);   break;
    case ANALYZE:
      halt(); // stand still — the camera grabs a frame and a moving one is a blurry one
      // Fire-and-forget on the notify channel the browser already listens to. If
      // the notify is dropped we just miss one analysis; the routine is unaffected.
      sensorChar.writeValue("E:analyze");
      Serial.println("E:analyze");
      break;
    default:    halt();         break; // WAIT + END both mean wheels still
  }
}

// Direct drive for the dashboard's motor-debug panel: "drv,<fwd|back|left|right>,<pwm>[,<ms>]".
// Always time-limited (default 800ms, cap 10s) so a dropped link or a missed stop
// can never leave the wheels spinning. Overrides any running routine.
unsigned long drvEnd = 0;

void stopRoutine() { routine = nullptr; drvEnd = 0; halt(); }

void startDrive(const String& c) {   // c = "drv,verb,pwm[,ms]"
  int a = c.indexOf(',', 4);
  if (a < 0) return;
  String verb = c.substring(4, a);
  int b = c.indexOf(',', a + 1);
  int pwm = constrain((b < 0 ? c.substring(a + 1) : c.substring(a + 1, b)).toInt(), 0, 255);
  long ms = b < 0 ? 800 : constrain(c.substring(b + 1).toInt(), 50, 10000);
  routine = nullptr;
  if      (verb == "fwd")   forward(pwm);
  else if (verb == "back")  back(pwm);
  else if (verb == "left")  left(pwm);
  else if (verb == "right") right(pwm);
  else { halt(); return; } // unknown verb: wheels stay still
  drvEnd = millis() + ms;
  Serial.print("drv: "); Serial.println(c);
}

// Auto-halt an expired debug drive. Called every loop(), non-blocking.
void tickDrive() {
  if (drvEnd && millis() >= drvEnd) { drvEnd = 0; halt(); }
}

void startRoutine(const String& name) {
  if (name == "presentation") routine = PRESENTATION;
  else if (name == "run") routine = RUN;
  else if (name == "test") routine = TEST;
  else if (name == "mission") routine = MISSION;
  else if (name == "test2") routine = TEST2;
  else return; // unknown name: stay idle rather than guess
  drvEnd = 0;  // kill any pending debug-drive auto-halt or it fires mid-step
  stepIdx = 0;
  stepStart = millis();
  applyStep(routine[0]);
  Serial.print("routine start: "); Serial.println(name);
}

// Advance the active routine if the current step has run out its time. Called
// every loop() — must stay non-blocking.
void tickRoutine() {
  if (!routine) return;
  if (routine[stepIdx].op == END) { stopRoutine(); Serial.println("routine done"); return; }
  if (millis() - stepStart < routine[stepIdx].ms) return;
  stepIdx++;
  stepStart = millis();
  applyStep(routine[stepIdx]);
}

// One parser for both transports: BLE cmdChar and USB serial. Serial parity means
// routines are testable at the bench with no BLE, no browser, no pairing.
void handleCmd(String c) {
  c.trim();
  if (c == "stop") stopRoutine();
  else if (c.startsWith("go,")) startRoutine(c.substring(3));
  else if (c.startsWith("drv,")) startDrive(c);
  // Unknown verb: ignore. The board only moves when explicitly told to.
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

  if (cmdChar.written()) handleCmd(cmdChar.value());
  if (Serial.available()) handleCmd(Serial.readStringUntil('\n'));

  tickRoutine(); // before the SEND_INTERVAL return below — that skips the rest
                 // of loop() most iterations, which would stall the routine.
  tickDrive();

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

  // Median-of-3 blocks ~180-250ms (60ms enforced between pings), which would cap
  // the routine stepper's resolution at that same figure — a 400ms turn could
  // overshoot 60%. During a routine take a single ~25ms ping instead: noisier
  // distance, but steps land on time and telemetry keeps flowing. Consecutive
  // pings still land SEND_INTERVAL (100ms) apart, clear of the 60ms ring-down.
  float raw = routine ? pingCm() : medianPingCm();
  if (raw >= 0) {
    distF = (distF < 0) ? raw : distF + DIST_ALPHA * (raw - distF);
  } else {
    distF = -1; // miss = out of range, don't hold a stale value
  }
  // Miss = no echo within ~430cm = CLEAR ahead. Send 999, never 0 — 0 reads as
  // "touching a wall" downstream (dashboard TOO CLOSE, server NEAR blurt).
  float dist = (distF < 0) ? 999 : distF;

  // DHT11 caps at ~1Hz — poll on its own slow cadence, hold last good value.
  if (now - lastDht >= DHT_INTERVAL) {
    lastDht = now;
    int t, h;
    if (dht.readTemperatureHumidity(t, h) == 0) { dhtTemp = t; dhtHumid = h; }
  }

  // IMPORTANT NOTE: only DHT11 + HC-SR04 exist now — no gas/pressure sensor.
  // smoke/airq/co/co_alert/pressure fields stay 0 until a real one lands.
  String line = "S:";
  line += dhtTemp;
  line += ",";
  line += dhtHumid;
  line += ",";
  line += dist;
  line += ",0,0,0,0,0,0,0,0";
  // Field 11: routine running? The server gates auto-analysis on this. Sent on
  // every line rather than as a start/end event on purpose — a dropped event
  // would strand the server thinking a routine runs forever; a flag self-heals.
  line += routine ? ",1" : ",0";

  Serial.println(line);
  sensorChar.writeValue(line);
}
