// giga r1 wifi — sensor hub + motion routines. reads sensors, broadcasts csv over
// ble notify. same "s:" format the server already parses (temp,humid,dist,
// smoke,airq,roll,pitch,yaw,co,co_alert,pressure,routine,lux). everything from co
// onward is optional, so older lines without them still parse.
// also emits "e:analyze" lines: routine events for the dashboard, not
// telemetry. the server ignores anything that isn't "s:".
#include <ArduinoBLE.h>
#include <Wire.h>
#include <SPI.h> // oled runs on SPI1 (d11/d13) — see the u8g2 setup below
#include <Adafruit_BME280.h> // pressure — install "Adafruit BME280 Library"
#include <DHT11.h> // temp/humidity — install "DHT11" (dhrubasaha08)
#include <U8g2lib.h> // oled debug screen — spi, install "U8g2" (oliver) via library manager
#include "routines.h" // op/step + the presentation and run tables
#include "blkvm.h"    // instruction set for uploaded blk workflows

// swapped from trig=47/echo=49 — the panel was wired the other way round.
// symptom of getting this backwards: pulseIn always times out, so dist reads the
// timeout fallback and never tracks an obstacle. swap these two back if so.
#define TRIG_PIN 50
#define ECHO_PIN 52
// dht11 (temp + humidity). a6 = normal gpio (digital 82), no conflict with the
// sonar (d47/d49), the oled (d11/d13 + d22/d24) or the motor pins (d2-d7).
// IMPORTANT NOTE: a8-a11 are pure-analog on the giga — pinMode/digitalWrite on
// them is a hard compile error from the core, so the dht can't go there.
#define DHT_PIN A6
// bme280 (pressure; the dht covers temp/humidity, so its temp/humidity
// registers go unread — altitude is a TODO, see CLAUDE.md).
// it's i2c, so it has no pins to pick: it goes on the giga's hardware bus,
// sda = d20, scl = d21, 3v3 + gnd. IMPORTANT NOTE: it can NOT sit on d44/d46 —
// those are pg_10/ph_15, neither has an i2c alternate function on the h747, so
// Wire can't be pointed at them (the other two buses are the dedicated sda1/scl1
// pins and d8/d9 = Wire2, free since enb moved off d8). bit-banging i2c there
// would need a soft-i2c
// library for no gain — move the two wires instead.
// oled debug screen, hardware spi. was bit-banged (sw) spi on d26/d28, which cost
// ~20ms a frame in digitalWrite calls — invisible for static debug text, the ceiling
// on anything animated, so clock + data moved onto a real spi peripheral.
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
// panel's mounted landscape — the ssd1306's native 128x64, so no rotation.
// swap to U8G2_R2 if a remount ever flips which edge is "up" (R1/R3 are the
// portrait mounts; every layout below is written against OLED_W/OLED_H, so a
// portrait remount means changing these two defines, not the drawing code).
#define OLED_W 128
#define OLED_H 64
U8G2_SSD1306_128X64_NONAME_F_4W_HW_SPI oled(U8G2_R0, /* cs=*/ U8X8_PIN_NONE, /* dc=*/ OLED_DC, /* reset=*/ OLED_RST);

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
// measured back when the panel was on sw-spi: ~17.5ms/frame regardless of screen —
// shoving the 1024-byte buffer over dominated, draw calls were noise by comparison.
// hardware spi1 (see the byte callback up top) cut that; 20ms is kept because ~50fps
// is plenty and every redraw still blocks ble.poll/drive/routine ticks behind it.
// re-measure with micros() around clearBuffer+draw+sendBuffer before trusting a number.
#define OLED_DRAW_INTERVAL 20
#define OLED_PHASE_INTERVAL 120 // ~1s per breathing cycle (8 phase steps) — unrelated to draw fps

/* matrix rain — operator toy, one of the screensavers picked from the console ("scr,1").
   ten 6px columns of 8px cells, each dropping at its own rate. contrast on a 1-bit panel
   has to be faked with density, so the tail fades in four tiers: the head is knocked out
   of a filled cell (the only way to read *brighter* than white), the two behind it are
   solid, the middle is dimmed by erasing every other scanline through the glyph and the
   end by erasing three in four. glyphs also re-roll in place so a column shimmers instead
   of just scrolling. costs nothing but the normal 20ms draw tick — no buffers, no link. */
#define MTX_CW 6                 // cell width: the 5x8 font plus a pixel of air
#define MTX_CH 8
#define MTX_COLS (OLED_W / MTX_CW)  // 21
#define MTX_ROWS (OLED_H / MTX_CH)  // 8
int8_t mtxY[MTX_COLS];      // head row; starts negative so a drop enters from off-screen
uint8_t mtxSpd[MTX_COLS];   // draw ticks per row of fall — bigger = slower
uint8_t mtxTick[MTX_COLS];
uint8_t mtxTail[MTX_COLS];
char mtxCell[MTX_COLS][MTX_ROWS];


#define BOARD_NAME "BLACKOUT-V3" // shown on the status screen and the ble local
                                  // name/serial banner below — one literal, three
                                  // spots, so they can't drift out of sync again
// l298n on d2/d4/d6/d7 (direction) + d3/d10 (enable). the pin numbers follow the
// loom as it is actually wired, by colour — the connector is not a straight run
// and renumbering here is one edit against four wire moves. d5 is free.
// IMPORTANT NOTE: in1..in4 are no longer contiguous, so anything iterating them
// has to use MOTOR_PINS below, not a `for (p = IN1; p <= IN4)` range.
// IMPORTANT NOTE: the run has to stay inside d2-d13 — that's the giga's whole
// pwm band. the analog header (and d41+) can't do pwm at all, and a8-a11 can't
// even do digital (the core errors out on digitalWrite there).
#define ENA 3  // motor a speed (pwm), gris
#define IN1 2  // motor a, morado
#define IN2 7  //          azul
#define IN3 6  // motor b, verde
#define IN4 4  //          amarillo
// important note: pull the ena/enb jumpers off the l298n first — left on, they
// tie enable to 5v and these pins do nothing (motors stay full speed).
// IMPORTANT NOTE: enb was on d2 and motor b was dead or stuck in most verbs.
// d2 (PA_3) and d3 (PA_2) are both TIM15 in the core's PinMap_PWM, and the mbed
// core hands the second PwmOut on a shared timer a channel that never comes up —
// d3 (ena) claimed it first, so enb silently stayed low. d10 (PK_1) is TIM1, its
// own timer, so enb lives there — d5 (PA_7) is also TIM1 and works just as well
// if the wire ever goes back. only ena/enb need timers; d2 is fine for in1, the
// clash is between two PwmOuts, never a digital output.
#define ENB 10  // motor b speed (pwm), naranja
static const uint8_t MOTOR_PINS[] = {IN1, IN2, IN3, IN4};
#define SONAR_ITER 3            // pings per reading, median drops spikes
#define SONAR_TIMEOUT_US 25000UL // ~430cm round-trip + margin, no echo = timeout
#define DIST_ALPHA 0.6 // ema smoothing on distance — ultrasonic is already clean
                        // (median-of-3 kills spikes), so light smoothing is enough.

/* the other screensavers. same deal as the rain: the board animates them off the 20ms
   draw tick, the link only carries which one (`scr,<n>`, 0 = off). keep the order in
   step with SAVERS in app.js — the wire value is the index, nothing else. */
enum { SCR_OFF, SCR_MATRIX, SCR_BOUNCE, SCR_STARS, SCR_TETRIS, SCR_N };
uint8_t saver = SCR_OFF;
// bounce: the dvd-logo one. 1px per draw tick ≈ 50px/s, so a full crossing is ~1.3s.
static const char BN_TEXT[] = "BLACKOUT"; // 8 chars = 40px, leaves 88px of travel
                                           // on a 128px panel
int16_t bnX, bnY;   // int16 for headroom on the sums, not just the range
int8_t bnDX, bnDY;
uint8_t bnW;
// stars: sparse dots falling at three depths. on 1 bit, size is the only depth cue.
#define ST_N 24
uint8_t stX[ST_N], stY[ST_N], stZ[ST_N]; // z = 1..3 = px/tick and dot size
// tetris: it plays itself, badly on purpose — pieces drop into the deepest column with
// no lookahead, so the well tops out every minute or so and wipes. the well stays
// portrait (a 16-wide, 8-deep one isn't tetris) and is centred on the landscape panel,
// which also keeps a row one byte: one bit per cell, bit c = column c, full = 0xFF.
#define TET_COLS 8
#define TET_ROWS 10
#define TET_CELL 6
#define TET_X0 ((OLED_W - TET_COLS * TET_CELL) / 2) // 40
#define TET_Y0 ((OLED_H - TET_ROWS * TET_CELL) / 2) // 2
#define TET_SPD 4 // draw ticks per row of fall
// 7 tetrominoes x 4 rotations as 4x4 bitmaps: nibble r = row r, bit c = column c.
// rotating a bitmap at runtime is more code than just listing them.
static const uint16_t TET_PIECES[7][4] = {
  { 0x000F, 0x1111, 0x000F, 0x1111 }, // I
  { 0x0033, 0x0033, 0x0033, 0x0033 }, // O
  { 0x0027, 0x0131, 0x0072, 0x0232 }, // T
  { 0x0036, 0x0231, 0x0036, 0x0231 }, // S
  { 0x0063, 0x0132, 0x0063, 0x0132 }, // Z
  { 0x0071, 0x0113, 0x0047, 0x0322 }, // J
  { 0x0074, 0x0311, 0x0017, 0x0223 }, // L
};
uint8_t tetWell[TET_ROWS];
uint16_t tetM;              // the falling piece's bitmap
int8_t tetX, tetY;          // its top-left cell; y starts above the well
uint8_t tetTick;

// dht11 tops out around 1hz and its read blocks in the same loop as ble.poll;
// pressure doesn't move fast either — both on one 2s cadence, cached between.
#define ENV_INTERVAL 2000
#define SEND_INTERVAL 100
// the idle-under-a-screensaver cadences — see the note in loop()
#define SAVER_ENV_INTERVAL 6000
#define SAVER_SEND_INTERVAL 500

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

// env sensors: dht11 for temp/humidity, bme280 for pressure. either one missing
// (or a dead i2c bus) just leaves its own fields at 0; nothing blocks on them.
Adafruit_BME280 bme;
bool bmeOk = false;
DHT11 dht(DHT_PIN);
int temp = 0, humid = 0;  // °C, % — last good dht read, cached
float pressure = 0;       // hPa — last good bme read, cached
// the filtered ultrasonic reading, published so the blk vm can compare against it
// without waiting for the telemetry line. refreshed once per send_interval.
float distCm = 999;       // cm, 999 = nothing in range

// gy-302 (bh1750) ambient light. shares the bme's bus — i2c is a bus, and 0x23
// doesn't collide with 0x76/0x77, so it needs no pins of its own: sda d20, scl
// d21, vcc 3v3 (the module has a regulator, but 3v3 keeps sda/scl at the h747's
// level), addr left floating.
// IMPORTANT NOTE: no library. continuous h-res mode is one command byte out and
// two bytes back — the driver below is shorter than the #include would be.
#define BH1750_ADDR 0x23
#define BH1750_CONT_HRES 0x10 // 1 lx steps, ~120ms a conversion — well inside ENV_INTERVAL
bool luxOk = false;
float lux = 0;            // lx — last good read, cached

// -1 on a short read, so a yanked wire freezes the last value instead of
// reporting pitch dark. 1.2 is the datasheet's counts-per-lx at default mtreg.
float readLux() {
  if (Wire.requestFrom(BH1750_ADDR, 2) < 2) return -1;
  uint16_t raw = (Wire.read() << 8) | Wire.read();
  return raw / 1.2f;
}

unsigned long lastSend = 0;
unsigned long lastEnv = 0;
float distF = -1; // ema state, -1 = uninitialised

void oledCenter(const char* s, int y) {
  oled.drawStr((OLED_W - oled.getStrWidth(s)) / 2, y, s);
}

// centred inside a column, not the whole panel — landscape puts the hud glyph and its
// text side by side, so "centre" means "centre of my half".
void oledCenterIn(const char* s, int x0, int w, int y) {
  oled.drawStr(x0 + (w - oled.getStrWidth(s)) / 2, y, s);
}

// status screen: wordmark + pairing state, nothing else. 128px of width means the
// name fits on one line, so the 20px face is spent on it instead of on "V3".
// IMPORTANT NOTE: cam state is no longer drawn — the dashboard still sends
// "cam,<state>" and camState still tracks it, ready if it ever earns a line back.
void drawStatus() {
  oled.setFont(u8g2_font_logisoso20_tr);
  oledCenter("BLACKOUT", 26);
  oled.setFont(u8g2_font_7x13B_tr);
  oledCenter("V3", 42);
  oled.drawHLine(24, 47, OLED_W - 48);

  // animated ellipsis while pairing — a stalled pair shouldn't look like a
  // frozen screen. oledFrame ticks every OLED_PHASE_INTERVAL (~120ms).
  oled.setFont(u8g2_font_6x10_tf);
  if (bleConnected) {
    // blink on the way in — the splash only stays up for HUD_BLINK_MS after a
    // connect, so this is the handoff animation, not a steady state.
    if ((millis() / 180) % 2) oledCenter("CONNECTED", 61);
  } else {
    static const char* dots[4] = {"PAIRING", "PAIRING.", "PAIRING..", "PAIRING..."};
    oledCenter(dots[(oledFrame / 4) % 4], 61);
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

// the connected screen: a one-line banner across the top, then the server's safety
// glyph on the left and its verdict + metrics stacked in the column beside it —
// landscape has no room to stack all four, but plenty to sit them side by side.
#define HUD_COL_X 54                  // right column: starts clear of the 44px warn glyph
#define HUD_COL_W (OLED_W - HUD_COL_X)
void drawHud() {
  oled.setFont(u8g2_font_5x7_tr);
  oledCenter("BLACKOUT V3 - CONNECTED", 7);
  oled.drawHLine(6, 11, OLED_W - 12);

  const char* label = "STANDBY";
  if (hudLevel == "ok") { drawSmile(10, 16); label = "SAFE"; }
  else if (hudLevel == "warn") { drawWarn(4, 16, false); label = "CAUTION"; }
  else if (hudLevel == "bad") {
    // ~480ms blink (oledFrame ticks every OLED_PHASE_INTERVAL) — an alarm the
    // operator catches out of the corner of an eye.
    if ((oledFrame / 2) % 2) drawWarn(4, 16, true);
    label = "DANGER";
  }
  oled.setFont(u8g2_font_7x13B_tr);
  oledCenterIn(label, HUD_COL_X, HUD_COL_W, 26);

  // metrics arrive pre-formatted from the server, "|" splits lines. straight to
  // the glass — the board doesn't decide what's worth showing.
  oled.setFont(u8g2_font_4x6_tr);
  int y = 38;
  int from = 0;
  while (from <= (int)hudMetrics.length() && y < OLED_H) {
    int cut = hudMetrics.indexOf('|', from);
    if (cut < 0) cut = hudMetrics.length();
    oledCenterIn(hudMetrics.substring(from, cut).c_str(), HUD_COL_X, HUD_COL_W, y);
    y += 8;
    from = cut + 1;
  }
}

// operator message from the dashboard's oled panel, word-wrapped to the panel
// width with a breathing frame + corner pulse so a static string still reads as
// "live", not frozen. IMPORTANT NOTE: 4 lines max — 4 x 12px is all 64px of height
// holds, and the ble message cap is 64 chars, which wraps to ~4 lines at this width.
#define CUST_LINES 4
void drawCustom() {
  oled.setFont(u8g2_font_6x10_tf);
  String lines[CUST_LINES];
  uint8_t n = 0;
  String word, cur;
  String src = customMsg + " ";
  for (uint16_t i = 0; i < src.length() && n < CUST_LINES; i++) {
    char c = src[i];
    if (c != ' ') { word += c; continue; }
    String trial = cur.length() ? cur + " " + word : word;
    if (oled.getStrWidth(trial.c_str()) > OLED_W - 16 && cur.length()) {
      lines[n++] = cur;
      cur = word;
    } else {
      cur = trial;
    }
    word = "";
  }
  if (cur.length() && n < CUST_LINES) lines[n++] = cur;

  int lineH = 12;
  int startY = OLED_H / 2 - (n * lineH) / 2 + 9;
  for (uint8_t i = 0; i < n; i++) oledCenter(lines[i].c_str(), startY + i * lineH);

  int boxH = n * lineH + 6;
  if (boxH < 20) boxH = 20;
  int top = startY - 12;
  if (top < 1) top = 1;
  if (top + boxH > OLED_H - 1) boxH = OLED_H - 1 - top;
  oled.drawRFrame(2, top, OLED_W - 4, boxH, 4);
  uint8_t phase = oledFrame % 8;
  oled.drawDisc(OLED_W - 8, top + 6, 1 + (phase < 4 ? phase : 7 - phase) / 2); // "live message" pulse
}

// glyph pool. ascii only: the katakana in a u8g2 japanese font costs tens of KB of
// flash for characters nobody can resolve at 5px anyway.
static const char MTX_GLYPHS[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<>*+=-#$%&@?/\\|";
#define MTX_NGLYPHS (sizeof(MTX_GLYPHS) - 1)
static inline char mtxGlyph() { return MTX_GLYPHS[random(MTX_NGLYPHS)]; }

// a drop re-enters from above with a fresh speed/length, so columns never sync up.
void mtxRespawn(uint8_t c) {
  mtxY[c] = -(int8_t)random(MTX_ROWS);
  mtxSpd[c] = random(1, 5);
  mtxTail[c] = random(5, MTX_ROWS);
  mtxTick[c] = 0;
}

void startMatrix() {
  for (uint8_t c = 0; c < MTX_COLS; c++) {
    mtxRespawn(c);
    for (uint8_t r = 0; r < MTX_ROWS; r++) mtxCell[c][r] = mtxGlyph();
  }
}

// one step per draw tick (called from loop(), not from the draw — a hud push mid-frame
// must not make the rain run faster).
void stepMatrix() {
  for (uint8_t c = 0; c < MTX_COLS; c++) {
    if (++mtxTick[c] < mtxSpd[c]) continue;
    mtxTick[c] = 0;
    if (++mtxY[c] - mtxTail[c] >= MTX_ROWS) { mtxRespawn(c); continue; }
    if (mtxY[c] >= 0 && mtxY[c] < MTX_ROWS) mtxCell[c][mtxY[c]] = mtxGlyph(); // fresh glyph under the head
    mtxCell[c][random(MTX_ROWS)] = mtxGlyph(); // and one shimmer somewhere in the column
  }
}

void drawMatrix() {
  oled.setFont(u8g2_font_5x8_tr);
  for (uint8_t c = 0; c < MTX_COLS; c++) {
    int x = 1 + c * MTX_CW; // 21 columns = 126px, centred in 128
    for (uint8_t i = 0; i <= mtxTail[c]; i++) {
      int r = mtxY[c] - i;
      if (r < 0 || r >= MTX_ROWS) continue;
      int top = r * MTX_CH;
      if (i == 0) { // head: glyph knocked out of a solid cell — the panel's only "brighter"
        oled.drawBox(x - 1, top, MTX_CW, MTX_CH);
        oled.setDrawColor(0);
        oled.drawGlyph(x, top + MTX_CH - 1, mtxCell[c][r]);
        oled.setDrawColor(1);
        continue;
      }
      oled.drawGlyph(x, top + MTX_CH - 1, mtxCell[c][r]);
      // fake grey by erasing scanlines through the glyph: keep 1 row in `keep`.
      // 0 = solid (the two behind the head), 2 = half, 4 = quarter for the last third.
      uint8_t keep = i <= 2 ? 0 : (i * 3 <= mtxTail[c] * 2 ? 2 : 4);
      if (!keep) continue;
      oled.setDrawColor(0);
      for (uint8_t yy = 0; yy < MTX_CH; yy++)
        if (yy % keep) oled.drawHLine(x - 1, top + yy, MTX_CW);
      oled.setDrawColor(1);
    }
  }
}

void startBounce() {
  oled.setFont(u8g2_font_5x8_tr);
  bnW = oled.getStrWidth(BN_TEXT);
  bnX = random(OLED_W - bnW); bnY = random(8, OLED_H);
  bnDX = random(2) ? 1 : -1; bnDY = random(2) ? 1 : -1;
}

void stepBounce() {
  bnX += bnDX; bnY += bnDY;
  if (bnX <= 0 || bnX + bnW >= OLED_W) bnDX = -bnDX;
  if (bnY <= 8 || bnY >= OLED_H) bnDY = -bnDY; // y is the text baseline, hence the 8
}

void drawBounce() {
  oled.setFont(u8g2_font_5x8_tr);
  oled.drawStr(bnX, bnY, BN_TEXT);
}

void stRespawn(uint8_t i, bool anywhere) {
  stX[i] = random(OLED_W);
  stY[i] = anywhere ? random(OLED_H) : 0;
  stZ[i] = random(1, 4);
}

void startStars() { for (uint8_t i = 0; i < ST_N; i++) stRespawn(i, true); }

void stepStars() {
  for (uint8_t i = 0; i < ST_N; i++) {
    if (stY[i] + stZ[i] >= OLED_H) { stRespawn(i, false); continue; }
    stY[i] += stZ[i];
  }
}

void drawStars() {
  for (uint8_t i = 0; i < ST_N; i++) {
    if (stZ[i] >= 3) oled.drawBox(stX[i] > OLED_W - 2 ? OLED_W - 2 : stX[i], stY[i], 2, 2); // near: 2x2
    else if (stZ[i] == 2) oled.drawVLine(stX[i], stY[i], 2);                // mid: 2px streak
    else oled.drawPixel(stX[i], stY[i]);                                     // far: one dot
  }
}

// overlap test for the piece at (px, py): the floor, the right wall and the well.
bool tetHit(uint16_t m, int8_t px, int8_t py) {
  for (uint8_t r = 0; r < 4; r++) {
    uint8_t bits = (m >> (r * 4)) & 0xF;
    if (!bits) continue;
    int8_t y = py + r;
    if (y < 0) continue; // still above the well — nothing to hit up there
    if (y >= TET_ROWS) return true;
    uint16_t row = (uint16_t)bits << px;
    if (row > 0xFF) return true; // ran off the right edge
    if (tetWell[y] & row) return true;
  }
  return false;
}

// random piece, but not a random column: drop it wherever it lands deepest, ties
// broken by coin flip. one loop's worth of "ai" — with a purely random column the well
// tops out every ~10 pieces, which is a wipe every 15 seconds and no lines ever cleared.
void tetSpawn() {
  tetM = TET_PIECES[random(7)][random(4)];
  tetY = -3; // enters from off the top
  tetTick = 0;
  // width, not a flat 0..4: a 1-wide piece has to be able to reach column 7, or the
  // right of the well never fills and lines stop completing.
  uint8_t w = 0;
  for (uint8_t b = 0; b < 16; b++)
    if ((tetM >> b) & 1 && (b % 4) + 1 > w) w = (b % 4) + 1;
  int8_t bestX = 0, bestY = -100;
  for (int8_t x = 0; x + w <= TET_COLS; x++) {
    int8_t y = -3;
    while (!tetHit(tetM, x, y + 1)) y++;
    if (y > bestY || (y == bestY && random(2))) { bestY = y; bestX = x; }
  }
  tetX = bestX;
}

void startTetris() {
  memset(tetWell, 0, sizeof tetWell);
  tetSpawn();
}

// merge the landed piece, clear any full rows, and wipe if the stack reached the top.
void tetLand() {
  for (uint8_t r = 0; r < 4; r++) {
    uint8_t bits = (tetM >> (r * 4)) & 0xF;
    int8_t y = tetY + r;
    if (bits && y >= 0 && y < TET_ROWS) tetWell[y] |= bits << tetX;
  }
  for (int8_t y = TET_ROWS - 1; y >= 0; y--)
    while (tetWell[y] == 0xFF) { // while, not if: the row that drops in may be full too
      for (int8_t k = y; k > 0; k--) tetWell[k] = tetWell[k - 1];
      tetWell[0] = 0;
    }
  if (tetWell[0]) memset(tetWell, 0, sizeof tetWell); // topped out, start the well over
  tetSpawn();
}

void stepTetris() {
  if (++tetTick < TET_SPD) return;
  tetTick = 0;
  if (tetHit(tetM, tetX, tetY + 1)) tetLand();
  else tetY++;
}

void drawTetris() {
  // the well is narrower than the panel now, so it needs an outline or the pieces
  // look like they're falling through open space.
  oled.drawFrame(TET_X0 - 2, TET_Y0 - 1, TET_COLS * TET_CELL + 3, TET_ROWS * TET_CELL + 2);
  // stack hollow, falling piece solid — that's the readable contrast pair on 1 bit.
  for (uint8_t r = 0; r < TET_ROWS; r++)
    for (uint8_t c = 0; c < TET_COLS; c++)
      if (tetWell[r] & (1 << c)) oled.drawFrame(TET_X0 + c * TET_CELL, TET_Y0 + r * TET_CELL, TET_CELL - 1, TET_CELL - 1);
  for (uint8_t r = 0; r < 4; r++) {
    uint8_t bits = (tetM >> (r * 4)) & 0xF;
    int8_t y = tetY + r;
    if (!bits || y < 0 || y >= TET_ROWS) continue;
    for (uint8_t c = 0; c < 4; c++)
      if (bits & (1 << c)) oled.drawBox(TET_X0 + (tetX + c) * TET_CELL, TET_Y0 + y * TET_CELL, TET_CELL - 1, TET_CELL - 1);
  }
}

// the whole screensaver layer is these three calls — adding one is a case in each.
void startSaver(uint8_t which) {
  randomSeed(micros()); // otherwise every boot plays the identical pattern
  saver = which < SCR_N ? which : SCR_OFF;
  if (saver == SCR_MATRIX) startMatrix();
  else if (saver == SCR_BOUNCE) startBounce();
  else if (saver == SCR_STARS) startStars();
  else if (saver == SCR_TETRIS) startTetris();
}

void stepSaver() {
  if (saver == SCR_MATRIX) stepMatrix();
  else if (saver == SCR_BOUNCE) stepBounce();
  else if (saver == SCR_STARS) stepStars();
  else if (saver == SCR_TETRIS) stepTetris();
}

void drawSaver() {
  if (saver == SCR_MATRIX) drawMatrix();
  else if (saver == SCR_BOUNCE) drawBounce();
  else if (saver == SCR_STARS) drawStars();
  else if (saver == SCR_TETRIS) drawTetris();
}

// redrawn on every draw tick (see OLED_DRAW_INTERVAL in loop()), not just
// on state change — a static screen doesn't read as "alive" on a panel this size.
// an operator message beats the auto status screen, the rain beats everything.
void updateOled() {
  oled.clearBuffer();
  if (saver) drawSaver();
  else if (customMsg.length()) drawCustom();
  else if (bleConnected && millis() - connectAt >= HUD_BLINK_MS) drawHud();
  else drawStatus(); // splash, and the blinking handoff for the first HUD_BLINK_MS
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

  // both addresses: 0x76 on most breakouts, 0x77 on adafruit's. one try each at
  // boot only — a hotplugged bme won't be picked up until a reset, which beats
  // probing a dead bus in every loop.
  Wire.begin();
  bmeOk = bme.begin(0x76) || bme.begin(0x77);
  Serial.println(bmeOk ? "BME280 ok" : "BME280 not found");

  // same one-shot probe as the bme: putting it into continuous mode is also the
  // presence check, since a missing chip won't ack the command byte.
  Wire.beginTransmission(BH1750_ADDR);
  Wire.write(BH1750_CONT_HRES);
  luxOk = (Wire.endTransmission() == 0);
  Serial.println(luxOk ? "BH1750 ok" : "BH1750 not found");

  oled.getU8x8()->byte_cb = oledSpi1; // before begin(): SPI1, not the d89-d91 "SPI" bus
  oled.setBusClock(OLED_SPI_HZ);
  oled.begin();
  oled.setContrast(255); // ssd1306 boots at ~0x7F; full drive is the cheapest contrast win there is
  updateOled();

  for (uint8_t p : MOTOR_PINS) { pinMode(p, OUTPUT); digitalWrite(p, LOW); }
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

Ins blkCode[BLK_MAX];
uint8_t blkLen = 0, blkWant = 0; // received / declared by the upload — a short upload never runs
float blkVar[BLK_VARS];
int blkPc = -1;                  // -1 = idle
uint8_t blkPwm = 140;            // what `speed` last set; every move uses it
unsigned long blkUntil = 0;      // deadline for the instruction in flight (0 = none)
bool blkWaitEvt = false;         // parked on an evt the browser has to answer
// an upload is in flight. only used to keep loop() quick while it lands: the idle
// median ping blocks ~200ms, and every one of those is 200ms the browser's next
// write sits waiting on ble.poll() — 40 instructions would take 8s to upload.
bool blkLoading = false;
bool blkResume = false;          // guard tripped mid-run: resume *at* blkpc, don't advance past it
uint8_t blkResSlot = 0xFF;       // slot an evt answer lands in (0xff = the evt wants no value)

// lhs: 0-49 index into blk.mjs's SENSORS, 50 = our own speed, 100+ = a variable.
// sensors this board doesn't carry read 0 — same as the fields in the telemetry line.
float blkRead(uint8_t lhs) {
  if (lhs >= 100) return blkVar[(uint8_t)(lhs - 100) % BLK_VARS];
  if (lhs == 50) return blkPwm;
  switch (lhs) {
    case 0: return distCm;
    case 1: return temp;
    case 2: return humid;
    case 6: return pressure;
  }
  return 0;
}

bool blkTest(const Ins& i) { // cmp indexes match CMPS in blk.mjs
  float l = blkRead(i.lhs), r = i.rhs;
  switch (i.cmp) {
    case 0: return l < r;
    case 1: return l > r;
    case 2: return l <= r;
    case 3: return l >= r;
    case 4: return l == r;
    default: return l != r;
  }
}

void blkDrive(uint8_t verb, uint8_t pwm) {
  switch (verb) {
    case 0: forward(pwm); break;
    case 1: back(pwm);    break;
    case 2: left(pwm);    break;
    default: right(pwm);  break;
  }
}

void blkHalt() { blkPc = -1; blkWaitEvt = false; blkLoading = false; blkResume = false; blkUntil = 0; halt(); }
void blkFinish() { blkHalt(); sensorChar.writeValue("E:blkend"); Serial.println("E:blkend"); }

// run instructions from blkpc until one needs time to pass, then return. never
// blocks: timed ops set blkuntil and tickblk() finishes them. the guard stops a
// body-less `forever` from spinning loop() to death — it just resumes next tick.
void blkEnter() {
  for (uint8_t guard = 0; guard < 64; guard++) {
    if (blkPc < 0 || blkPc >= blkLen) { blkFinish(); return; }
    const Ins& i = blkCode[blkPc];
    switch (i.op) {
      case B_END: blkFinish(); return;
      case B_STOP: blkFinish(); return;
      case B_MOVE:  blkDrive(i.a, blkPwm); blkUntil = millis() + (uint16_t)i.c; return;
      case B_MOVEU:
        if (blkTest(i)) { halt(); break; }        // already true, don't move at all
        blkDrive(i.a, blkPwm);
        blkUntil = millis() + (i.c ? (uint16_t)i.c : 30000); // same cap as the browser's until
        return;
      case B_WAIT: halt(); blkUntil = millis() + (uint16_t)i.c; return;
      case B_WAITU:
        if (blkTest(i)) break;
        halt();
        blkUntil = i.c ? millis() + (uint16_t)i.c : 0; // no timeout = wait forever
        return;
      case B_SPEED: blkPwm = i.b; break;
      case B_SET: blkVar[i.a % BLK_VARS] = i.rhs; break;
      case B_ADD: blkVar[i.a % BLK_VARS] += i.rhs; break;
      case B_JMP: blkPc = i.c; continue;
      case B_JMPF: if (!blkTest(i)) { blkPc = i.c; continue; } break;
      case B_EVT: {
        halt(); // the camera wants a still frame, and nothing should roll while sage thinks
        String e = "E:blk,"; e += i.b; e += ","; e += i.a;
        for (uint8_t v = 0; v < BLK_VARS; v++) { e += ","; e += blkVar[v]; } // vars, so the browser can interpolate {name}
        sensorChar.writeValue(e);
        Serial.println(e);
        if (i.a == 0) break; // fire and forget
        blkWaitEvt = true;
        blkResSlot = (i.a == 2) ? i.c : 0xFF; // analyze answers "done", not a value — slot 0 isn't its

        blkUntil = millis() + BLK_EVT_MS;
        return;
      }
    }
    blkPc++;
  }
  blkResume = true; // guard tripped: pick up *at* this instruction next tick, not after it
}

// finish the instruction in flight if its time is up (or its condition tripped).
// called every loop() — must stay non-blocking.
void tickBlk() {
  if (blkPc < 0) return;
  if (blkResume) { blkResume = false; blkEnter(); return; }
  const Ins& i = blkCode[blkPc];
  if (blkWaitEvt) {
    if (millis() < blkUntil) return; // browser never answered — carry on rather than hang
    blkWaitEvt = false;
  } else if (i.op == B_MOVEU || i.op == B_WAITU) {
    if (!blkTest(i) && (!blkUntil || millis() < blkUntil)) return;
  } else if (blkUntil && millis() < blkUntil) return;
  halt(); // every instruction ends with the wheels still, like a timed "drv," burst
  blkUntil = 0;
  blkPc++;
  blkEnter();
}

void blkStart() {
  if (!blkLen || blkLen != blkWant) { // a truncated upload must never half-run
    sensorChar.writeValue("E:blkerr");
    Serial.println("E:blkerr");
    return;
  }
  routine = nullptr;
  drvEnd = 0; // kill any pending debug-drive auto-halt or it fires mid-instruction
  for (uint8_t v = 0; v < BLK_VARS; v++) blkVar[v] = 0;
  blkPwm = 140;
  blkUntil = 0;
  blkWaitEvt = false;
  blkPc = 0;
  Serial.print("blk start: "); Serial.print(blkLen); Serial.println(" ins");
  blkEnter();
}

// nth comma-separated field, "" past the end
String blkFld(const String& s, uint8_t n) {
  int start = 0;
  for (uint8_t k = 0; k < n; k++) {
    start = s.indexOf(',', start);
    if (start < 0) return "";
    start++;
  }
  int end = s.indexOf(',', start);
  return end < 0 ? s.substring(start) : s.substring(start, end);
}

// upload + control, one line per instruction so a lost write is just a short
// upload (caught by blkstart) rather than a corrupt program:
//   "blk,n,<count>"  begin, clears whatever was here
//   "blk,i,<idx>,<op>,<a>,<b>,<c>,<lhs>,<cmp>,<rhs>"
//   "blk,go"         run from 0
//   "blk,res,<v>"    answer the evt the program is parked on
void handleBlk(const String& c) {
  String k = blkFld(c, 1);
  if (k == "n") {
    blkHalt();
    memset(blkCode, 0, sizeof(blkCode)); // op 0 = b_end: a lost write ends the program, never runs stale
    blkLen = 0;
    blkWant = blkFld(c, 2).toInt();
    blkLoading = true;
    sensorChar.writeValue("E:blkrdy"); // the browser waits for this before uploading
  } else if (k == "i") {
    int idx = blkFld(c, 2).toInt();
    if (idx < 0 || idx >= BLK_MAX) return;
    Ins& i = blkCode[idx];
    i.op  = blkFld(c, 3).toInt();
    i.a   = blkFld(c, 4).toInt();
    i.b   = blkFld(c, 5).toInt();
    i.c   = blkFld(c, 6).toInt();
    i.lhs = blkFld(c, 7).toInt();
    i.cmp = blkFld(c, 8).toInt();
    i.rhs = blkFld(c, 9).toFloat();
    if (idx + 1 > blkLen) blkLen = idx + 1;
  } else if (k == "go") {
    blkLoading = false;
    blkStart();
  } else if (k == "res" && blkWaitEvt) {
    if (blkResSlot < BLK_VARS) blkVar[blkResSlot] = blkFld(c, 2).toFloat();
    blkUntil = 0; // resume on the next tick
  }
}

void stopRoutine() { routine = nullptr; drvEnd = 0; blkHalt(); }

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
  // uploaded blk workflow: instructions in, then "blk,go". see the blk vm above.
  else if (c.startsWith("blk,")) handleBlk(c);
  else if (c.startsWith("cam,")) { camState = c.substring(4); if (!saver) updateOled(); }
  else if (c.startsWith("hud,")) {
    int sep = c.indexOf(',', 4);
    hudLevel = (sep < 0) ? c.substring(4) : c.substring(4, sep);
    hudMetrics = (sep < 0) ? "" : c.substring(sep + 1);
    if (!saver) updateOled(); // under a screensaver the draw tick owns the panel
  }
  // a screensaver takes the whole panel until it's switched off (or the link drops).
  else if (c.startsWith("scr,")) { startSaver(c.substring(4).toInt()); updateOled(); }
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
    // the screensaver goes with it: nothing else can switch it off, so it must never outlive
    // the console that turned it on.
    if (!bleConnected) { hudLevel = ""; hudMetrics = ""; saver = SCR_OFF; }
    updateOled();
  }

  if (cmdChar.written()) handleCmd(cmdChar.value());
  if (Serial.available()) handleCmd(Serial.readStringUntil('\n'));

  tickRoutine(); // before the send_interval return below — that skips the rest
                 // of loop() most iterations, which would stall the routine.
  tickDrive();
  tickBlk();

  unsigned long nowAnim = millis();
  if (nowAnim - lastOledPhase >= OLED_PHASE_INTERVAL) { lastOledPhase = nowAnim; oledFrame++; }
  if (nowAnim - lastOledDraw >= OLED_DRAW_INTERVAL) {
    lastOledDraw = nowAnim;
    stepSaver(); // one animation step per drawn frame
    updateOled();
  }

  unsigned long now = millis();
  bool busy = routine || blkPc >= 0 || blkLoading || drvEnd;
  // a screensaver on an idle rover: the panel is the only thing anyone is looking at,
  // and everything below this line blocks it. one ping is ~25ms of dead time inside a
  // 20ms draw tick, so at 100ms it drops one frame in five — that's the stutter. back
  // the whole sensor cadence off to 2hz while the rover isn't doing anything, and the
  // rain runs smooth. anything that moves clears `busy` back to the full 10hz.
  if (now - lastSend < (saver && !busy ? SAVER_SEND_INTERVAL : SEND_INTERVAL)) return;
  lastSend = now;

  // median-of-3 blocks ~180-250ms (60ms forced between pings). nothing else runs
  // in that window — no ble.poll(), so an inbound drive/stop command just waits.
  // so while anything is moving (routine *or* live drive) take a single ~25ms ping:
  // noisier distance, but steps land on time and remote control stays responsive.
  // consecutive pings still land send_interval (100ms) apart, clear of the 60ms ring-down.
  // a screensaver counts as "busy" for the same reason a routine does: the median's ~200ms of
  // blocking pings is ~200ms of no redraw, which stutters it visibly.
  float raw = (busy || saver) ? pingCm() : medianPingCm();
  if (raw >= 0) {
    distF = (distF < 0) ? raw : distF + DIST_ALPHA * (raw - distF);
  } else {
    distF = -1; // miss = out of range, don't hold a stale value
  }
  // miss = no echo within ~430cm = clear ahead. send 999, never 0 — 0 reads as
  // "touching a wall" downstream (dashboard "too close", server "near" blurt).
  float dist = (distF < 0) ? 999 : distF;
  distCm = dist;

  // env sensor on its own slow cadence, hold last good values. the dht11 read blocks
  // ~30ms (its wire protocol is timed delays), which is a visible hitch under a
  // screensaver — same deal as the ping, so it slows down too.
  if (now - lastEnv >= (saver && !busy ? SAVER_ENV_INTERVAL : ENV_INTERVAL)) {
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
    if (luxOk) {
      float l = readLux();
      if (l >= 0) lux = l;
    }
  }

  // important note: only dht11 + bme280 + bh1750 + hc-sr04 exist — no gas sensor,
  // no imu. smoke/airq/roll/pitch/yaw/co/co_alert stay 0 until a real one lands.
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
  line += (routine || blkPc >= 0) ? ",1" : ",0";
  // field 12: lux. appended last and nothing reads it yet — recorded only.
  line += ",";
  line += lux;

  Serial.println(line);
  sensorChar.writeValue(line);
}
