// giga r1 wifi — sensor hub + motion routines. reads sensors, broadcasts csv over
// ble notify. same "s:" format the server already parses (temp,humid,dist,
// smoke,airq,roll,pitch,yaw,co,co_alert,pressure,routine). everything from co
// onward is optional, so older lines without them still parse.
// also emits "e:analyze" lines: routine events for the dashboard, not
// telemetry. the server ignores anything that isn't "s:".
#include <ArduinoBLE.h>
#include <DHT11.h>
#include <U8g2lib.h> // oled debug screen — spi, install "U8g2" (oliver) via library manager
#include "routines.h" // op/step + the presentation and run tables

#define DHT_PIN 2   // dht11 data pin. d2 = clean digital; not d13 (onboard led
                    // shares that line and glitches the timing).
#define TRIG_PIN 32
#define ECHO_PIN 34
// oled debug screen, bit-banged (sw) spi on the double-row header.
// IMPORTANT NOTE: giga has two spi buses — the arduino "SPI" object u8g2's hw-spi
// mode drives is pins 89-91 on the high-density connector, NOT the d11-d13 header
// pins (those are "SPI1", a separate object u8g2 can't target). sw spi bit-bangs
// digitalWrite on whatever pins you hand it, so it hits the header pins we
// actually wired. costs a little speed, doesn't matter for static debug text.
// cs tied straight to gnd on the panel (only spi device on the bus), so u8g2
// gets u8x8_pin_none instead of a pin to wiggle.
// assumes an ssd1306-compatible 128x64 panel — most cheap 1.54" white spi oleds
// are. if the screen shows noise/garbage (not just blank), it's probably really
// an sh1106 or ssd1309 — swap the constructor below for
// U8G2_SH1106_128X64_NONAME_F_4W_SW_SPI or U8G2_SSD1309_128X64_NONAME0_F_4W_SW_SPI.
// all four on the double-row header (even side, d22-d28) — keeps the whole panel
// on one connector and leaves d11/d13 and the analog pins free.
#define OLED_CLK 28
#define OLED_DATA 26
#define OLED_RST 24
#define OLED_DC 22
// panel's mounted portrait in the enclosure (64 wide x 128 tall as drawn), not
// landscape — U8G2_R1 rotates the buffer 90° to match. swap to U8G2_R3 if a
// remount ever flips which edge is "up".
U8G2_SSD1306_128X64_NONAME_F_4W_SW_SPI oled(U8G2_R1, /* clock=*/ OLED_CLK, /* data=*/ OLED_DATA, /* cs=*/ U8X8_PIN_NONE, /* dc=*/ OLED_DC, /* reset=*/ OLED_RST);
bool bleConnected = false;
String camState = "not connected"; // only the server/dashboard knows camera state — pushed via "cam,<state>" cmd
// operator override from the dashboard's oled panel: "oled,<text>" shows it in
// place of the auto link/cam status, "oled,clear" (the literal word) goes back
// to auto. empty = auto.
String customMsg = "";
// two independent cadences: the *redraw* runs fast (smooth sliding highlight,
// responsive input) but the *breathing-pulse phase* (spinner/dot animations,
// oledFrame % 8) stays slow — those are meant to read as a calm pulse, not
// vibrate at whatever fps the spi bus happens to allow.
uint8_t oledFrame = 0; // wraps freely — every pulse/spinner draw is frame % something
unsigned long lastOledDraw = 0;
unsigned long lastOledPhase = 0;
// measured on this board (micros() around clearBuffer+draw+sendBuffer): ~17.5ms/frame
// regardless of screen — bit-banged spi shoving the 1024-byte buffer over dominates,
// draw calls are noise by comparison. that's a hard ~57fps ceiling; 20ms keeps us
// pinned near it without spending every single loop() iteration in a blocking spi
// write (ble.poll/drive/routine ticks all wait behind an in-flight redraw).
#define OLED_DRAW_INTERVAL 20
#define OLED_PHASE_INTERVAL 120 // ~1s per breathing cycle (8 phase steps) — unrelated to draw fps

#define BOARD_NAME "BLACKOUT-V3" // shown on the status screen and the ble local
                                  // name/serial banner below — one literal, three
                                  // spots, so they can't drift out of sync again
// l298n direction pins. d4-d7 = contiguous free block, no timer/peripheral
// conflict (d32/d34 sonar, d2 dht, d22-d28 oled, d13 onboard led all clear).
// d9, d11 and d12 are free — d9 drove the camera servo before the camera was fixed.
#define IN1 4  // motor a
#define IN2 5
#define IN3 6  // motor b
#define IN4 7
// enable pins = pwm speed control. d3/d10 are the free pwm-capable pins here.
// important note: pull the ena/enb jumpers off the l298n first — left on, they
// tie enable to 5v and these pins do nothing (motors stay full speed).
#define ENA 3  // motor a speed
#define ENB 10 // motor b speed
#define SONAR_ITER 3            // pings per reading, median drops spikes
#define SONAR_TIMEOUT_US 25000UL // ~430cm round-trip + margin, no echo = timeout
#define DIST_ALPHA 0.6 // ema smoothing on distance — ultrasonic is already clean
                        // (median-of-3 kills spikes), so light smoothing is enough.

#define DHT_INTERVAL 2000 // dht11 tops out ~1hz, read every 2s, cache between.
#define SEND_INTERVAL 100

BLEService sensorService("19b10000-e8f2-537e-4f6c-d104768a1214");
BLEStringCharacteristic sensorChar("19b10001-e8f2-537e-4f6c-d104768a1214", BLERead | BLENotify, 100);
// command channel: server (via the browser's web bluetooth) writes here to
// trigger actions. "go,<routine>" starts a motion routine, "stop" cuts motors.
// bumped 20->64 for "oled,<text>" operator messages — every other verb here
// still fits well under 20. IMPORTANT NOTE: assumes the ble link negotiates an
// att mtu >=67 bytes; if oled text arrives truncated on a given os/browser,
// that's the ceiling to check first, not a firmware bug.
BLEStringCharacteristic cmdChar("19b10002-e8f2-537e-4f6c-d104768a1214", BLEWrite | BLEWriteWithoutResponse, 64);

// the routine tables live in routines.h — edit that file to change what
// the robot does. everything here is the machinery that runs them: the board plays
// a routine standalone (the browser just writes "go,presentation"), so a ble
// dropout mid-run doesn't strand it. steps advance on a millis() stepper, never
// delay() — a blocking routine would freeze loop(), killing ble.poll() and the
// telemetry send for the whole run.
const Step* routine = nullptr; // null = idle
uint8_t stepIdx = 0;
unsigned long stepStart = 0;

DHT11 dht(DHT_PIN);
int dhtTemp = 0, dhtHumid = 0; // last good dht11 read, cached between polls

unsigned long lastSend = 0;
unsigned long lastDht = 0;
float distF = -1; // ema state, -1 = uninitialised

void oledCenter(const char* s, int y) {
  oled.drawStr((64 - oled.getStrWidth(s)) / 2, y, s);
}

// status screen: link state is icon-only now (spinner while pairing, pulsing
// dot once connected — motion is what sells "alive" on a panel this small),
// cam line + its own small pulse/x dot underneath.
void drawStatus() {
  oled.setFont(u8g2_font_4x6_tf);
  oledCenter(BOARD_NAME, 10);

  int cx = 32, cy = 54;
  if (!bleConnected) {
    float ang = (oledFrame % 8) * (2 * PI / 8); // one tick sweeping a hub, 8-frame cycle
    oled.drawDisc(cx, cy, 3);
    oled.drawLine(cx, cy, cx + (int)(10 * cos(ang)), cy + (int)(10 * sin(ang)));
  } else {
    uint8_t phase = oledFrame % 8;
    oled.drawDisc(cx, cy, 3 + (phase < 4 ? phase : 7 - phase)); // triangle-wave pulse
  }

  oled.setFont(u8g2_font_u8glib_4_tf);
  String camLine = camState;
  camLine.toUpperCase();
  oledCenter(camLine.c_str(), 90);

  bool camUp = camState.indexOf("not") < 0; // "connected" vs "not connected"
  int dx = 8, dy = 82;
  if (camUp) {
    uint8_t phase = (oledFrame + 4) % 8; // offset from the link pulse so they don't sync up
    oled.drawDisc(dx, dy, 1 + (phase < 4 ? phase : 7 - phase) / 2);
  } else {
    oled.drawLine(dx - 2, dy - 2, dx + 2, dy + 2);
    oled.drawLine(dx - 2, dy + 2, dx + 2, dy - 2); // static x — nothing to animate for "off"
  }
}

// operator message from the dashboard's oled panel, word-wrapped to the 64px
// panel width with a breathing frame + corner pulse so a static string still
// reads as "live", not frozen.
void drawCustom() {
  oled.setFont(u8g2_font_6x10_tf);
  String lines[6];
  uint8_t n = 0;
  String word, cur;
  String src = customMsg + " ";
  for (uint16_t i = 0; i < src.length() && n < 6; i++) {
    char c = src[i];
    if (c != ' ') { word += c; continue; }
    String trial = cur.length() ? cur + " " + word : word;
    if (oled.getStrWidth(trial.c_str()) > 58 && cur.length()) {
      lines[n++] = cur;
      cur = word;
    } else {
      cur = trial;
    }
    word = "";
  }
  if (cur.length() && n < 6) lines[n++] = cur;

  int lineH = 12;
  int startY = 64 - (n * lineH) / 2 + 10;
  for (uint8_t i = 0; i < n; i++) oledCenter(lines[i].c_str(), startY + i * lineH);

  int boxH = n * lineH + 6;
  if (boxH < 20) boxH = 20;
  int top = startY - 14;
  oled.drawRFrame(2, top, 60, boxH, 4);
  uint8_t phase = oledFrame % 8;
  oled.drawDisc(56, top + 6, 1 + (phase < 4 ? phase : 7 - phase) / 2); // "live message" pulse
}

// redrawn on every draw tick (see OLED_DRAW_INTERVAL in loop()), not just
// on state change — a static screen doesn't read as "alive" on a panel this size.
// an operator message beats the auto status screen.
void updateOled() {
  oled.clearBuffer();
  customMsg.length() ? drawCustom() : drawStatus();
  oled.sendBuffer();
}

void setup() {
  Serial.begin(9600);
  Serial.setTimeout(50); // readstringuntil on a partial line must not block the
                         // default 1s — that stalls ble.poll + the routine stepper
  pinMode(TRIG_PIN, OUTPUT);
  // IMPORTANT NOTE: pulldown, not bare INPUT. on the giga a floating echo pin sits
  // HIGH, so pulsein() never sees a rising edge, times out, and every reading comes
  // back -1 (999 on the dashboard) even with the sensor wired correctly.
  pinMode(ECHO_PIN, INPUT_PULLDOWN);

  oled.begin();
  updateOled();

  for (int p = IN1; p <= IN4; p++) { pinMode(p, OUTPUT); digitalWrite(p, LOW); }
  pinMode(ENA, OUTPUT); pinMode(ENB, OUTPUT);
  analogWrite(ENA, 0); analogWrite(ENB, 0); // stopped until told otherwise

  if (!BLE.begin()) {
    while (1) { Serial.println("BLE init failed"); delay(1000); }
  }
  // known arduinoble/r4 wifi bug: the advertised name always shows as
  // "arduino" regardless of setlocalname() (the esp32-s3 co-processor doesn't
  // honor it in the ad packet, only in the post-connect gatt device-name
  // characteristic). so the browser filters by this service uuid instead.
  BLE.setLocalName(BOARD_NAME);
  // 7.5-15ms connection interval (units of 1.25ms). the default negotiates out to
  // 30ms+, and every drive burst waits a whole interval before the radio sends it.
  // faster interval = more radio wakeups = more battery, worth it for manual drive.
  BLE.setConnectionInterval(6, 12);
  BLE.setAdvertisedService(sensorService);
  sensorService.addCharacteristic(sensorChar);
  sensorService.addCharacteristic(cmdChar);
  BLE.addService(sensorService);
  BLE.advertise();
  Serial.println("BLE advertising as " BOARD_NAME); // adjacent string literals fold at compile time
}

// both motors forward at `speed` (0-255 pwm). if a motor spins backward, swap
// that motor's two output wires at the l298n screw terminals — don't flip the
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

// pivot turns: motors oppose, robot spins about its own centre rather
// than arcing. turn *angle* is whatever `ms` buys you at this speed — open loop,
// no encoders, so it drifts with battery charge. tune on the field, not the bench.
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
      halt(); // stand still — camera needs a clean frame, not a blurry one
      // fire-and-forget on the notify channel the browser already listens to. if
      // notify drops we miss one analysis, routine keeps going.
      sensorChar.writeValue("E:analyze");
      Serial.println("E:analyze");
      break;
    default:    halt();         break; // wait + end both mean wheels still
  }
}

// direct drive for the dashboard's motor-debug panel: "drv,<fwd|back|left|right>,<pwm>[,<ms>]".
// always time-limited (default 800ms, cap 10s) so a dropped link or missed stop
// never leaves the wheels spinning. overrides any running routine.
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
  else { halt(); return; } // unknown verb, wheels stay still
  drvEnd = millis() + ms;
  Serial.print("drv: "); Serial.println(c);
}

// auto-halt an expired debug drive. called every loop(), non-blocking.
void tickDrive() {
  if (drvEnd && millis() >= drvEnd) { drvEnd = 0; halt(); }
}

void startRoutine(const String& name) {
  if (name == "presentation") routine = PRESENTATION;
  else if (name == "run") routine = RUN;
  else if (name == "test") routine = TEST;
  else if (name == "mission") routine = MISSION;
  else if (name == "test2") routine = TEST2;
  else return; // unknown name, stay idle rather than guess
  drvEnd = 0;  // kill any pending debug-drive auto-halt or it fires mid-step
  stepIdx = 0;
  stepStart = millis();
  applyStep(routine[0]);
  Serial.print("routine start: "); Serial.println(name);
}

// advance the active routine if the current step has run out its time. called
// every loop() — must stay non-blocking.
void tickRoutine() {
  if (!routine) return;
  if (routine[stepIdx].op == END) { stopRoutine(); Serial.println("routine done"); return; }
  if (millis() - stepStart < routine[stepIdx].ms) return;
  stepIdx++;
  stepStart = millis();
  applyStep(routine[stepIdx]);
}

// one parser for both transports: ble cmdchar and usb serial. serial parity means
// routines are testable at the bench with no ble, no browser, no pairing.
void handleCmd(String c) {
  c.trim();
  if (c == "stop") stopRoutine();
  else if (c.startsWith("go,")) startRoutine(c.substring(3));
  else if (c.startsWith("drv,")) startDrive(c);
  else if (c.startsWith("cam,")) { camState = c.substring(4); updateOled(); }
  else if (c.startsWith("oled,")) {
    String msg = c.substring(5);
    customMsg = (msg == "clear") ? "" : msg; // literal word "clear" reverts to auto status
    updateOled();
  }
  // unknown verb, ignore. the board only moves when explicitly told to.
}

// one hc-sr04 ping in cm via plain pulsein() — portable across cores, unlike
// newping's avr-cycle-counted timing (wrong on this board's clock speed).
// returns -1 on timeout (no echo / out of range).
float pingCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long us = pulseIn(ECHO_PIN, HIGH, SONAR_TIMEOUT_US);
  return us > 0 ? us / 58.0 : -1;
}

// median of sonar_iter pings drops spikes, same intent as the old newping call.
float medianPingCm() {
  float s[SONAR_ITER];
  uint8_t n = 0;
  for (uint8_t i = 0; i < SONAR_ITER; i++) {
    float v = pingCm();
    if (v >= 0) s[n++] = v;
    delay(60); // hc-sr04 needs >=60ms between pings or the transducer ring-down
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

  bool nowConnected = BLE.central();
  if (nowConnected != bleConnected) { bleConnected = nowConnected; updateOled(); }

  if (cmdChar.written()) handleCmd(cmdChar.value());
  if (Serial.available()) handleCmd(Serial.readStringUntil('\n'));

  tickRoutine(); // before the send_interval return below — that skips the rest
                 // of loop() most iterations, which would stall the routine.
  tickDrive();

  unsigned long nowAnim = millis();
  if (nowAnim - lastOledPhase >= OLED_PHASE_INTERVAL) { lastOledPhase = nowAnim; oledFrame++; }
  if (nowAnim - lastOledDraw >= OLED_DRAW_INTERVAL) {
    lastOledDraw = nowAnim;
    updateOled();
  }

  unsigned long now = millis();
  if (now - lastSend < SEND_INTERVAL) return;
  lastSend = now;

  // median-of-3 blocks ~180-250ms (60ms forced between pings). nothing else runs
  // in that window — no ble.poll(), so an inbound drive/stop command just waits.
  // so while anything is moving (routine *or* live drive) take a single ~25ms ping:
  // noisier distance, but steps land on time and remote control stays responsive.
  // consecutive pings still land send_interval (100ms) apart, clear of the 60ms ring-down.
  float raw = (routine || drvEnd) ? pingCm() : medianPingCm();
  if (raw >= 0) {
    distF = (distF < 0) ? raw : distF + DIST_ALPHA * (raw - distF);
  } else {
    distF = -1; // miss = out of range, don't hold a stale value
  }
  // miss = no echo within ~430cm = clear ahead. send 999, never 0 — 0 reads as
  // "touching a wall" downstream (dashboard "too close", server "near" blurt).
  float dist = (distF < 0) ? 999 : distF;

  // dht11 caps at ~1hz — poll on its own slow cadence, hold last good value.
  if (now - lastDht >= DHT_INTERVAL) {
    lastDht = now;
    int t, h;
    if (dht.readTemperatureHumidity(t, h) == 0) { dhtTemp = t; dhtHumid = h; }
  }

  // important note: only dht11 + hc-sr04 exist now — no gas/pressure sensor.
  // smoke/airq/co/co_alert/pressure fields stay 0 until a real one lands.
  String line = "S:";
  line += dhtTemp;
  line += ",";
  line += dhtHumid;
  line += ",";
  line += dist;
  line += ",0,0,0,0,0,0,0,0";
  // field 11: routine running? the server gates auto-analysis on this. sent on
  // every line rather than as a start/end event — a dropped event
  // would strand the server thinking a routine runs forever, a flag self-heals.
  line += routine ? ",1" : ",0";

  Serial.println(line);
  sensorChar.writeValue(line);
}
