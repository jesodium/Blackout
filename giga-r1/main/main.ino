// giga r1 wifi — sensor hub + motion routines. reads sensors, broadcasts csv over
// ble notify. same "s:" format the server already parses (temp,humid,dist,
// smoke,airq,roll,pitch,yaw,co,co_alert,pressure,routine). everything from co
// onward is optional, so older lines without them still parse.
// also emits "e:analyze" lines: routine events for the dashboard, not
// telemetry. the server ignores anything that isn't "s:".
#include <ArduinoBLE.h>
#include <Wire.h>
#include <SPI.h> // oled runs on SPI1 (d11/d13) — see the u8g2 setup below
#include <Adafruit_BME280.h> // pressure — install "Adafruit BME280 Library"
#include <DHT11.h> // temp/humidity — install "DHT11" (dhrubasaha08)
#include <U8g2lib.h> // oled debug screen — spi, install "U8g2" (oliver) via library manager
#include <SDRAM.h> // giga's 8MB external ram — holds an uploaded oled clip, see "operator video"
#include "routines.h" // op/step + the presentation and run tables

// swapped from trig=47/echo=49 — the panel was wired the other way round.
// symptom of getting this backwards: pulseIn always times out, so dist reads the
// timeout fallback and never tracks an obstacle. swap these two back if so.
#define TRIG_PIN 49
#define ECHO_PIN 47
// dht11 (temp + humidity). a6 = normal gpio (digital 82), no conflict with the
// sonar (d47/d49), the oled (d11/d13 + d22/d24) or the motor pwm pins (d3-d8).
// IMPORTANT NOTE: a8-a11 are pure-analog on the giga — pinMode/digitalWrite on
// them is a hard compile error from the core, so the dht can't go there.
#define DHT_PIN A6
// bme280 (pressure; the dht covers temp/humidity, so its temp/humidity
// registers go unread — altitude is a TODO, see CLAUDE.md).
// it's i2c, so it has no pins to pick: it goes on the giga's hardware bus,
// sda = d20, scl = d21, 3v3 + gnd. IMPORTANT NOTE: it can NOT sit on d44/d46 —
// those are pg_10/ph_15, neither has an i2c alternate function on the h747, so
// Wire can't be pointed at them (the other two buses are the dedicated sda1/scl1
// pins and d8/d9, and d8 is ENB). bit-banging i2c there would need a soft-i2c
// library for no gain — move the two wires instead.
// oled debug screen, hardware spi. was bit-banged (sw) spi on d26/d28, which cost
// ~20ms a frame in digitalWrite calls — invisible for static debug text, but it was
// the ceiling on oled video (below), so clock + data moved onto a real spi peripheral.
// IMPORTANT NOTE: giga has two spi buses and u8g2's *_4W_HW_SPI constructors are
// hardwired to the arduino "SPI" object, which on this board is d89-d91 — high-density
// connector pins, not header pins. the header d11/d13 are "SPI1", a separate object
// u8g2 has no constructor for, so oledSpi1() below is u8g2's own hw-spi byte callback
// with SPI1 swapped in, installed over byte_cb in setup(). ~25 lines to keep the panel
// on pins a jumper wire can actually reach.
// cs tied straight to gnd on the panel (only spi device on the bus), so u8g2
// gets u8x8_pin_none instead of a pin to wiggle.
// assumes an ssd1306-compatible 128x64 panel — most cheap 1.54" white spi oleds
// are. if the screen shows noise/garbage (not just blank), it's probably really
// an sh1106 or ssd1309 — swap the constructor below for
// U8G2_SH1106_128X64_NONAME_F_4W_HW_SPI or U8G2_SSD1309_128X64_NONAME0_F_4W_HW_SPI.
// clock and data are fixed by SPI1 (d13 = sck, d11 = copi); dc + reset stay on the
// double-row header where they already were.
#define OLED_RST 24
#define OLED_DC 22
#define OLED_SPI_HZ 8000000 // ssd1306 is spec'd to ~10MHz; drop this if the panel glitches
// panel's mounted portrait in the enclosure (64 wide x 128 tall as drawn), not
// landscape — U8G2_R1 rotates the buffer 90° to match. swap to U8G2_R3 if a
// remount ever flips which edge is "up".
U8G2_SSD1306_128X64_NONAME_F_4W_HW_SPI oled(U8G2_R1, /* cs=*/ U8X8_PIN_NONE, /* dc=*/ OLED_DC, /* reset=*/ OLED_RST);

// u8g2 byte callback, identical to its arduino hw-spi one except it talks to SPI1.
// installed in setup() — see the note above for why there's no constructor for this.
extern "C" uint8_t oledSpi1(u8x8_t *u8x8, uint8_t msg, uint8_t arg_int, void *arg_ptr) {
  static uint8_t tx[256]; // arg_int is a byte, so one send never exceeds this
  switch (msg) {
    case U8X8_MSG_BYTE_SEND:
      // copied first: SPI1.transfer(buf, n) reads back into the buffer it's given, and
      // the buffer u8g2 hands over here is the live frame.
      memcpy(tx, arg_ptr, arg_int);
      SPI1.transfer(tx, arg_int);
      break;
    case U8X8_MSG_BYTE_INIT:
      if (u8x8->bus_clock == 0) u8x8->bus_clock = u8x8->display_info->sck_clock_hz;
      u8x8_gpio_SetCS(u8x8, u8x8->display_info->chip_disable_level);
      SPI1.begin();
      break;
    case U8X8_MSG_BYTE_SET_DC:
      u8x8_gpio_SetDC(u8x8, arg_int);
      break;
    case U8X8_MSG_BYTE_START_TRANSFER:
      SPI1.beginTransaction(SPISettings(u8x8->bus_clock, MSBFIRST, SPI_MODE0));
      u8x8_gpio_SetCS(u8x8, u8x8->display_info->chip_enable_level);
      break;
    case U8X8_MSG_BYTE_END_TRANSFER:
      u8x8_gpio_SetCS(u8x8, u8x8->display_info->chip_disable_level);
      SPI1.endTransaction();
      break;
    default: return 0;
  }
  return 1;
}
bool bleConnected = false;
String camState = "not connected"; // only the server/dashboard knows camera state — pushed via "cam,<state>" cmd
// operator override from the dashboard's oled panel: "oled,<text>" shows it in
// place of the auto link/cam status, "oled,clear" (the literal word) goes back
// to auto. empty = auto.
String customMsg = "";
// hud state, pushed by the server as "hud,<ok|warn|bad>,<metrics>". IMPORTANT NOTE:
// the board never derives either from its own sensors — it reads raw values and the
// server owns what "safe" means (same statuses() the agent uses), so the screen and
// the agent can't disagree. empty level = connected but nothing pushed yet.
String hudLevel = "";
String hudMetrics = "";
unsigned long connectAt = 0; // ble connect instant — the hud fades in after a blink
#define HUD_BLINK_MS 1500    // how long "CONNECTED" blinks on the splash before the hud
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

/* operator video: the dashboard dithers a clip to 1-bit 64x128 in the browser and
   uploads the *whole thing* into the giga's 8MB external sdram, then the board plays it
   back on its own clock. it used to stream frame-by-frame and draw whatever arrived,
   which capped out in single-digit fps: ble can't carry 1KB a frame at video rates
   (60fps would be ~61KB/s, and a with-response write is round-trip bound at the ~15ms
   connection interval). uploading first moves the link cost to a one-time wait and
   playback becomes a memcpy from ram — the panel's own ~1.1ms sendBuffer at 8MHz spi is
   then the only limit, so the clip's real frame rate is what plays.
   the load is one linear byte stream, not framed: the board appends chunks in arrival
   order until it has the byte count "vid,load" declared. so the chunk size is free to be
   whatever the link likes and doesn't have to divide into 1024.
   playback is autonomous — once loaded, a ble drop can't stutter or strand the clip. */
#define VID_W 64
#define VID_H 128
#define VID_BYTES (VID_W / 8 * VID_H) // 1024 — one full frame
/* one ATT write, not a long write. anything over (mtu - 3) makes the central split the
   write into prepare-write PDUs of (mtu - 5) bytes, each its own round trip, plus an
   execute — that's what made 512-byte chunks cost ~4 round trips instead of 1.
   ArduinoBLE takes its mtu from the controller's ACL packet length (utility/HCI.cpp,
   `ATT.setMaxMtu(pktLen - 9)`), ~240 here, so 224 stays comfortably inside it.
   IMPORTANT NOTE: writes stay *with response* — the board appends by arrival order and a
   silently dropped chunk would corrupt the rest of the clip. without-response would
   upload several times faster but needs a sequence number per chunk to be safe. */
#define VID_CHUNK 224
#define VID_MAX_FRAMES 6000 // 6MB of the 8MB sdram — 200s at 30fps, leaves room for everything else
#define VID_TIMEOUT 4000    // no chunk for this long *while loading* = link died, give the screen back
uint8_t *vidBuf = nullptr;  // SDRAM.malloc'd at "vid,load", freed at stop
uint32_t vidTotal = 0;      // bytes the clip declared
uint32_t vidGot = 0;        // bytes received so far
uint16_t vidFrames = 0;     // vidTotal / VID_BYTES
uint16_t vidAt = 0;         // frame currently on screen while playing
unsigned long vidFrameUs = 33333; // per-frame period, from the fps "vid,load" declared
unsigned long vidNextUs = 0;      // micros() deadline for the next frame
enum VidState { VID_IDLE, VID_LOADING, VID_PLAYING };
VidState vidState = VID_IDLE;
bool vidOn = false;         // loading or playing — the panel belongs to the clip either way
unsigned long vidLast = 0;  // last chunk arrival, for the loading-stall timeout

#define BOARD_NAME "BLACKOUT-V3" // shown on the status screen and the ble local
                                  // name/serial banner below — one literal, three
                                  // spots, so they can't drift out of sync again
// l298n on d3-d8, one run of six in connector order (ena in1 in2 in3 in4 enb),
// so the board's header maps straight across with no crossed wires.
// d13 is the onboard led, so d3 is as low as the run comfortably starts.
// IMPORTANT NOTE: the run has to stay inside d2-d13 — that's the giga's whole
// pwm band. the analog header (and d41+) can't do pwm at all, and a8-a11 can't
// even do digital (the core errors out on digitalWrite there).
#define ENA 3  // motor a speed (pwm)
#define IN1 4  // motor a
#define IN2 5
#define IN3 6  // motor b
#define IN4 7
// important note: pull the ena/enb jumpers off the l298n first — left on, they
// tie enable to 5v and these pins do nothing (motors stay full speed).
// IMPORTANT NOTE: d3 is bench-proven pwm, d8 is not yet — if motor b runs at
// one speed while motor a ramps, d8 has no timer channel: put ENB back on d10.
#define ENB 8  // motor b speed (pwm)
#define SONAR_ITER 3            // pings per reading, median drops spikes
#define SONAR_TIMEOUT_US 25000UL // ~430cm round-trip + margin, no echo = timeout
#define DIST_ALPHA 0.6 // ema smoothing on distance — ultrasonic is already clean
                        // (median-of-3 kills spikes), so light smoothing is enough.

// dht11 tops out around 1hz and its read blocks in the same loop as ble.poll;
// pressure doesn't move fast either — both on one 2s cadence, cached between.
#define ENV_INTERVAL 2000
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
// video channel: raw 1-bit frames for the oled, streamed live from the dashboard
// (see "oled video" in app.js). 512 is the att spec's max attribute size, so a
// 1024-byte frame is exactly two writes — chrome splits each one into prepared
// writes under the hood, we just memcpy them in arrival order.
// IMPORTANT NOTE: order/no-loss only holds for *with-response* writes. the browser
// must not send these without response or a dropped chunk shifts every later frame.
BLECharacteristic vidChar("19b10003-e8f2-537e-4f6c-d104768a1214", BLEWrite, VID_CHUNK);

// the routine tables live in routines.h — edit that file to change what
// the robot does. everything here is the machinery that runs them: the board plays
// a routine standalone (the browser just writes "go,presentation"), so a ble
// dropout mid-run doesn't strand it. steps advance on a millis() stepper, never
// delay() — a blocking routine would freeze loop(), killing ble.poll() and the
// telemetry send for the whole run.
const Step* routine = nullptr; // null = idle
uint8_t stepIdx = 0;
unsigned long stepStart = 0;

// env sensors: dht11 for temp/humidity, bme280 for pressure. either one missing
// (or a dead i2c bus) just leaves its own fields at 0; nothing blocks on them.
Adafruit_BME280 bme;
bool bmeOk = false;
DHT11 dht(DHT_PIN);
int temp = 0, humid = 0;  // °C, % — last good dht read, cached
float pressure = 0;       // hPa — last good bme read, cached

unsigned long lastSend = 0;
unsigned long lastEnv = 0;
float distF = -1; // ema state, -1 = uninitialised

void oledCenter(const char* s, int y) {
  oled.drawStr((64 - oled.getStrWidth(s)) / 2, y, s);
}

// status screen: wordmark + pairing state, nothing else. panel is 64px wide
// (portrait), so the name splits over two lines to get any real size.
// IMPORTANT NOTE: cam state is no longer drawn — the dashboard still sends
// "cam,<state>" and camState still tracks it, ready if it ever earns a line back.
void drawStatus() {
  oled.setFont(u8g2_font_7x13B_tr);
  oledCenter("BLACKOUT", 44);          // 8 chars x 7px = 56, fits 64 with margin
  oled.setFont(u8g2_font_logisoso20_tr);
  oledCenter("V3", 70);
  oled.drawHLine(8, 80, 48);

  // animated ellipsis while pairing — a stalled pair shouldn't look like a
  // frozen screen. oledFrame ticks every OLED_PHASE_INTERVAL (~120ms).
  oled.setFont(u8g2_font_6x10_tf);
  if (bleConnected) {
    // blink on the way in — the splash only stays up for HUD_BLINK_MS after a
    // connect, so this is the handoff animation, not a steady state.
    if ((millis() / 180) % 2) oledCenter("CONNECTED", 100);
  } else {
    static const char* dots[4] = {"PAIRING", "PAIRING.", "PAIRING..", "PAIRING..."};
    oledCenter(dots[(oledFrame / 4) % 4], 100);
  }
}

// the three status glyphs, drawn with primitives instead of an icon font — a
// hand-rolled xbm is more bytes to get wrong than a few circles and lines.
// each is a ~36x38 glyph hung off (x, y) = top-left, and
// every one is captioned in drawHud() so meaning never rests on the drawing.
void drawSmile(int x, int y) {
  int cx = x + 18, cy = y + 18;
  oled.drawCircle(cx, cy, 17);              // face
  oled.drawDisc(cx - 7, cy - 5, 2);         // eyes
  oled.drawDisc(cx + 7, cy - 5, 2);
  // mouth = lower half of two circles, one inside the other, so the arc reads as
  // a stroke instead of a hairline on a 128x64 panel.
  oled.drawCircle(cx, cy, 9, U8G2_DRAW_LOWER_LEFT | U8G2_DRAW_LOWER_RIGHT);
  oled.drawCircle(cx, cy, 8, U8G2_DRAW_LOWER_LEFT | U8G2_DRAW_LOWER_RIGHT);
}

// warning triangle. filled = danger (also blinks, see drawHud), hollow = caution:
// same sign, louder. the "!" is drawn in whichever colour the triangle isn't.
void drawWarn(int x, int y, bool filled) {
  int x0 = x, x1 = x + 44, apex = x + 22, base = y + 36;
  if (filled) oled.drawTriangle(apex, y, x0, base, x1, base);
  else {
    oled.drawLine(apex, y, x0, base);
    oled.drawLine(apex, y, x1, base);
    oled.drawLine(x0, base, x1, base);
  }
  oled.setDrawColor(filled ? 0 : 1);
  oled.drawBox(apex - 1, y + 12, 3, 13);
  oled.drawBox(apex - 1, y + 28, 3, 3);
  oled.setDrawColor(1);
}

// the connected screen: wordmark and link state shrunk to the top, the server's
// safety verdict big in the middle, its metrics line(s) small at the bottom.
void drawHud() {
  oled.setFont(u8g2_font_5x7_tr);
  oledCenter("BLACKOUT V3", 9);
  oled.setFont(u8g2_font_4x6_tr);
  oledCenter("CONNECTED", 18);
  oled.drawHLine(6, 22, 52);

  const char* label = "STANDBY";
  if (hudLevel == "ok") { drawSmile(14, 38); label = "SAFE"; }
  else if (hudLevel == "warn") { drawWarn(10, 38, false); label = "CAUTION"; }
  else if (hudLevel == "bad") {
    // ~480ms blink (oledFrame ticks every OLED_PHASE_INTERVAL) — an alarm the
    // operator catches out of the corner of an eye.
    if ((oledFrame / 2) % 2) drawWarn(10, 38, true);
    label = "DANGER";
  }
  oled.setFont(u8g2_font_5x7_tr);
  oledCenter(label, 92);

  // metrics arrive pre-formatted from the server, "|" splits lines. straight to
  // the glass — the board doesn't decide what's worth showing.
  oled.setFont(u8g2_font_4x6_tr);
  int y = 110;
  int from = 0;
  while (from <= (int)hudMetrics.length() && y < 128) {
    int cut = hudMetrics.indexOf('|', from);
    if (cut < 0) cut = hudMetrics.length();
    oledCenter(hudMetrics.substring(from, cut).c_str(), y);
    y += 9;
    from = cut + 1;
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
// upload takes tens of seconds, so the panel says so rather than sitting on a stale hud.
void drawVidLoad() {
  oled.setFont(u8g2_font_5x7_tr);
  oledCenter("LOADING", 56);
  uint8_t pct = vidTotal ? (uint32_t)100 * vidGot / vidTotal : 0;
  oled.drawFrame(6, 62, 52, 8);
  oled.drawBox(8, 64, (uint32_t)48 * pct / 100, 4);
  oledCenter((String(pct) + "%").c_str(), 82);
}

void updateOled() {
  oled.clearBuffer();
  if (vidState == VID_PLAYING) oled.drawXBM(0, 0, VID_W, VID_H, vidBuf + (uint32_t)vidAt * VID_BYTES);
  else if (vidState == VID_LOADING) drawVidLoad();
  else if (customMsg.length()) drawCustom();
  else if (bleConnected && millis() - connectAt >= HUD_BLINK_MS) drawHud();
  else drawStatus(); // splash, and the blinking handoff for the first HUD_BLINK_MS
  oled.sendBuffer();
}

/* clip bytes, in arrival order — no sequence number: the browser writes with response,
   so ble delivers them in order or not at all. a stray chunk (board reset mid-upload,
   "vid,load" missed) is dropped by the state check, and the tail guard means a chunk
   that would overrun the allocation truncates instead of scribbling past it. */
void onVidWrite(BLEDevice, BLECharacteristic ch) {
  if (vidState != VID_LOADING) return;
  int n = ch.valueLength();
  if (n <= 0) return;
  uint32_t room = vidTotal - vidGot;
  if ((uint32_t)n > room) n = room;
  memcpy(vidBuf + vidGot, ch.value(), n);
  vidGot += n;
  vidLast = millis();
  if (vidGot >= vidTotal) { // whole clip is in ram — from here the link doesn't matter
    vidState = VID_PLAYING;
    vidAt = 0;
    vidNextUs = micros();
    Serial.print("video loaded, "); Serial.print(vidFrames); Serial.println(" frames");
  }
}

// "vid,load,<frames>,<fps>" — reserve sdram and start taking chunks. returns false (and
// tells the dashboard) if the clip won't fit, so the browser can stop rather than upload
// into nothing.
bool startVideoLoad(long frames, long fps) {
  stopVideo();
  if (frames < 1 || frames > VID_MAX_FRAMES || fps < 1 || fps > 60) return false;
  vidBuf = (uint8_t *)SDRAM.malloc((uint32_t)frames * VID_BYTES);
  if (!vidBuf) return false;
  vidFrames = frames;
  vidTotal = (uint32_t)frames * VID_BYTES;
  vidGot = 0;
  vidFrameUs = 1000000UL / fps;
  vidState = VID_LOADING;
  vidOn = true;
  vidLast = millis();
  return true;
}

// advance playback off micros(), not a per-frame delay: the deadline accumulates so a
// slow redraw is absorbed by the next frame instead of stretching the whole clip.
void tickVideo() {
  if (vidState != VID_PLAYING) return;
  if ((long)(micros() - vidNextUs) < 0) return;
  vidNextUs += vidFrameUs;
  updateOled();
  if (++vidAt >= vidFrames) stopVideo(); // played out — hand the screen back
}

void stopVideo() {
  if (vidBuf) { SDRAM.free(vidBuf); vidBuf = nullptr; } // a clip is megabytes — don't sit on it
  vidState = VID_IDLE;
  vidOn = false;
  vidGot = vidTotal = 0;
  vidFrames = vidAt = 0;
  updateOled(); // straight back to the hud/status screen, same frame
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

  // both addresses: 0x76 on most breakouts, 0x77 on adafruit's. one try each at
  // boot only — a hotplugged bme won't be picked up until a reset, which beats
  // probing a dead bus in every loop.
  Wire.begin();
  bmeOk = bme.begin(0x76) || bme.begin(0x77);
  Serial.println(bmeOk ? "BME280 ok" : "BME280 not found");

  oled.getU8x8()->byte_cb = oledSpi1; // before begin(): SPI1, not the d89-d91 "SPI" bus
  oled.setBusClock(OLED_SPI_HZ);
  oled.begin();
  oled.setContrast(255); // ssd1306 boots at ~0x7F; full drive is the cheapest win video has
  updateOled();

  SDRAM.begin(); // external ram, only ever used to hold an uploaded oled clip

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
  // event handler, not written() polling like cmdChar: video chunks arrive far
  // faster than one per loop() and a polled read would drop every one but the last.
  vidChar.setEventHandler(BLEWritten, onVidWrite);
  sensorService.addCharacteristic(vidChar);
  BLE.addService(sensorService);
  BLE.advertise();
  Serial.println("BLE advertising as " BOARD_NAME); // adjacent string literals fold at compile time
}

// the one motion primitive: signed per-side pwm, -255 (full reverse) to 255
// (full forward). motor a is `l`, motor b is `r`. everything below is a corner
// of it, and the pad's left-stick arcade mix lands on the in-between values —
// arcing while driving, which the four named verbs can't express.
// if a motor spins backward, swap that motor's two output wires at the l298n
// screw terminals — don't flip the pin logic here or forward/back stop meaning
// the same thing.
void tank(int l, int r) {
  l = constrain(l, -255, 255); r = constrain(r, -255, 255);
  digitalWrite(IN1, l < 0); digitalWrite(IN2, l > 0);
  digitalWrite(IN3, r < 0); digitalWrite(IN4, r > 0);
  analogWrite(ENA, abs(l)); analogWrite(ENB, abs(r));
}

void forward(uint8_t speed) { tank(speed, speed); }
void back(uint8_t speed)    { tank(-speed, -speed); }

// pivot turns: motors oppose, robot spins about its own centre rather
// than arcing. turn *angle* is whatever `ms` buys you at this speed — open loop,
// no encoders, so it drifts with battery charge. tune on the field, not the bench.
void left(uint8_t speed)    { tank(speed, -speed); }
void right(uint8_t speed)   { tank(-speed, speed); }

void halt() { tank(0, 0); }

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

// direct drive for the dashboard's motor-debug panel and the pad:
//   "drv,<fwd|back|left|right>,<pwm>[,<ms>]"  — one of the four verbs
//   "drv,tank,<l>,<r>[,<ms>]"                 — signed per-side, -255..255
// always time-limited (default 800ms, cap 10s) so a dropped link or missed stop
// never leaves the wheels spinning. overrides any running routine.
unsigned long drvEnd = 0;

void stopRoutine() { routine = nullptr; drvEnd = 0; halt(); }

void startDrive(const String& c) {
  int a = c.indexOf(',', 4);
  if (a < 0) return;
  String verb = c.substring(4, a);
  int b = c.indexOf(',', a + 1);
  if (b < 0 && verb == "tank") return;  // tank needs both sides, never one
  routine = nullptr;
  long ms;
  if (verb == "tank") {
    int d = c.indexOf(',', b + 1);
    int l = c.substring(a + 1, b).toInt();
    int r = (d < 0 ? c.substring(b + 1) : c.substring(b + 1, d)).toInt();
    ms = d < 0 ? 800 : constrain(c.substring(d + 1).toInt(), 50, 10000);
    tank(l, r);
  } else {
    int pwm = constrain((b < 0 ? c.substring(a + 1) : c.substring(a + 1, b)).toInt(), 0, 255);
    ms = b < 0 ? 800 : constrain(c.substring(b + 1).toInt(), 50, 10000);
    if      (verb == "fwd")   forward(pwm);
    else if (verb == "back")  back(pwm);
    else if (verb == "left")  left(pwm);
    else if (verb == "right") right(pwm);
    else { halt(); return; } // unknown verb, wheels stay still
  }
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
  else if (c.startsWith("hud,")) {
    int sep = c.indexOf(',', 4);
    hudLevel = (sep < 0) ? c.substring(4) : c.substring(4, sep);
    hudMetrics = (sep < 0) ? "" : c.substring(sep + 1);
    updateOled();
  }
  /* "vid,load,<frames>,<fps>" reserves sdram and hands the screen to the upload;
     "vid,off" gives it back. the board answers on serial either way — the browser waits
     for nothing, it just uploads, but a rejected load has to be visible somewhere. */
  else if (c.startsWith("vid,load,")) {
    int sep = c.indexOf(',', 9);
    bool ok = sep > 0 && startVideoLoad(c.substring(9, sep).toInt(), c.substring(sep + 1).toInt());
    Serial.println(ok ? "video load started" : "video load rejected");
  }
  else if (c == "vid,off") stopVideo();
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
  if (nowConnected != bleConnected) {
    bleConnected = nowConnected;
    connectAt = millis();
    Serial.println(bleConnected ? "BLE central connected" : "BLE central gone");
    // a drop invalidates the hud — the server's verdict is only as fresh as the link.
    if (!bleConnected) { hudLevel = ""; hudMetrics = ""; stopVideo(); }
    updateOled();
  }

  if (cmdChar.written()) handleCmd(cmdChar.value());
  if (Serial.available()) handleCmd(Serial.readStringUntil('\n'));

  tickRoutine(); // before the send_interval return below — that skips the rest
                 // of loop() most iterations, which would stall the routine.
  tickDrive();

  unsigned long nowAnim = millis();
  if (nowAnim - lastOledPhase >= OLED_PHASE_INTERVAL) { lastOledPhase = nowAnim; oledFrame++; }
  // an upload that dies half-way (link drop, browser tab closed) must not leave the panel
  // stuck on a progress bar — no chunk for VID_TIMEOUT and the hud comes back. only while
  // *loading*: once it's playing the clip is in ram and the link is irrelevant.
  if (vidState == VID_LOADING && nowAnim - vidLast > VID_TIMEOUT) {
    stopVideo();
    Serial.println("video upload stalled");
  }
  // playing: the clip's own frame clock drives the redraw (tickVideo). loading: the
  // progress bar only needs the normal slow tick.
  if (vidState == VID_PLAYING) {
    tickVideo();
  } else if (nowAnim - lastOledDraw >= OLED_DRAW_INTERVAL) {
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
  // a clip counts as "busy" for the same reason a routine does: the median's ~200ms of
  // blocking pings is ~200ms of neither ble.poll() nor tickVideo() — it stalls the
  // upload and, once playing, drops ~6 frames of the clip's own clock on the floor.
  float raw = (routine || drvEnd || vidOn) ? pingCm() : medianPingCm();
  if (raw >= 0) {
    distF = (distF < 0) ? raw : distF + DIST_ALPHA * (raw - distF);
  } else {
    distF = -1; // miss = out of range, don't hold a stale value
  }
  // miss = no echo within ~430cm = clear ahead. send 999, never 0 — 0 reads as
  // "touching a wall" downstream (dashboard "too close", server "near" blurt).
  float dist = (distF < 0) ? 999 : distF;

  // env sensor on its own slow cadence, hold last good values.
  if (now - lastEnv >= ENV_INTERVAL) {
    lastEnv = now;
    int t = 0, h = 0;
    // 0 = ok; a checksum/timeout error leaves the cached values alone, so a
    // flaky wire goes stale rather than wrong.
    if (dht.readTemperatureHumidity(t, h) == 0) { temp = t; humid = h; }
    if (bmeOk) {
      // a glitched i2c read hands the compensation the registers' reset value
      // instead of a sample, which comes out as a real-looking number, not nan,
      // so nothing downstream catches it. gate on the datasheet's range.
      // IMPORTANT NOTE: a wedged bus therefore goes quiet, not wrong — the
      // value freezes. re-begin() after n rejects if that ever needs to recover
      // without a reset.
      float p = bme.readPressure() / 100.0F; // Pa -> hPa
      if (p > 300 && p < 1100) pressure = p;
    }
  }

  // important note: only dht11 + bme280 + hc-sr04 exist — no gas sensor, no imu.
  // smoke/airq/roll/pitch/yaw/co/co_alert stay 0 until a real one lands.
  String line = "S:";
  line += temp;
  line += ",";
  line += humid;
  line += ",";
  line += dist;
  line += ",0,0,0,0,0,0,0,"; // smoke,airq,roll,pitch,yaw,co,co_alert
  line += pressure;
  // field 11: routine running? the server gates auto-analysis on this. sent on
  // every line rather than as a start/end event — a dropped event
  // would strand the server thinking a routine runs forever, a flag self-heals.
  line += routine ? ",1" : ",0";

  Serial.println(line);
  sensorChar.writeValue(line);
}
