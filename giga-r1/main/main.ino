// giga r1 wifi — sensor hub + motion routines. broadcasts csv over ble notify as
// "S:temp,humid,dist,smoke,airq,roll,pitch,yaw,co,co_alert,pressure,routine,lux"
// (trailing fields optional). "E:" lines are events for the dashboard, not telemetry.
#include <ArduinoBLE.h>
#include <Wire.h>
#include <SPI.h>
#include <Adafruit_BME280.h> // lib: "Adafruit BME280 Library"
#include <DHT11.h>           // lib: "DHT11" (dhrubasaha08)
#include <U8g2lib.h>         // lib: "U8g2" (oliver)
#include "routines.h"
#include "blkvm.h"

// sonar. backwards = pulseIn always times out and dist never tracks an obstacle.
#define TRIG_PIN 52
#define ECHO_PIN 50
// IMPORTANT NOTE: a8-a11 are pure-analog — pinMode/digitalWrite there is a compile error.
#define DHT_PIN A6
// three relay channels, NOT leds on pins: each pin is a low-current input to a
// relay module that switches the light's own supply. so the pin never sees lamp
// current, digitalWrite only (a relay can't be dimmed — pwm just chatters the
// coil), and these sit off the pwm block on purpose, d10 being the last one free.
// IMPORTANT NOTE: the common relay boards are ACTIVE LOW — HIGH releases, LOW
// pulls the coil in. RELAY_ON is that polarity in one place; flip it if the
// board turns out to be active-high (lights on at boot = flip it).
#define RELAY_CAM_LED 26   // cam light
#define RELAY_STRIP   28   // led strip
#define RELAY_LED     30   // spare led
#define RELAY_ON  LOW
#define RELAY_OFF HIGH
static const uint8_t RELAY_PINS[] = {RELAY_CAM_LED, RELAY_STRIP, RELAY_LED};
// bme280 is i2c on Wire (d20/d21). IMPORTANT NOTE: it can't move to d44/d46 —
// pg_10/ph_15 have no i2c alternate function on the h747.
// oled: ssd1306 128x64 on SPI1 (d13 sck, d11 copi), cs tied to gnd on the panel.
// noise instead of blank = it's really an sh1106/ssd1309, swap the constructor.
#define OLED_RST 24
#define OLED_DC 22
#define OLED_SPI_HZ 8000000 // ssd1306 spec'd to ~10MHz; drop if the panel glitches
// landscape mount. every layout is written against these two, so a remount is
// these defines plus the rotation arg, not the drawing code.
#define OLED_W 128
#define OLED_H 64
U8G2_SSD1306_128X64_NONAME_F_4W_HW_SPI oled(U8G2_R0, /* cs=*/ U8X8_PIN_NONE, /* dc=*/ OLED_DC, /* reset=*/ OLED_RST);

// u8g2's own hw-spi byte callback with SPI1 swapped in — its *_HW_SPI constructors
// only know the "SPI" object, which on the giga is d89-d91, not header pins.
// installed over byte_cb in setup().
extern "C" uint8_t oledSpi1(u8x8_t *u8x8, uint8_t msg, uint8_t arg_int, void *arg_ptr) {
  static uint8_t tx[256]; // arg_int is a byte, so one send never exceeds this
  switch (msg) {
    case U8X8_MSG_BYTE_SEND:
      // copy first: SPI1.transfer(buf, n) reads back into the buffer it's given,
      // and u8g2 hands over the live frame.
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
String camState = "not connected"; // pushed by the dashboard as "cam,<state>"
String customMsg = "";             // "oled,<text>" override; "oled,clear" = back to auto
// hud state, pushed as "hud,<ok|warn|bad>,<metrics>". IMPORTANT NOTE: the board never
// derives either — the server owns what "safe" means, so screen and agent can't disagree.
String hudLevel = "";
String hudMetrics = "";
unsigned long connectAt = 0;
#define HUD_BLINK_MS 1500    // "CONNECTED" blinks this long on the splash before the hud
// two cadences: redraw runs fast, the breathing-pulse phase stays slow so pulses
// read as calm instead of vibrating at whatever fps the bus allows.
uint8_t oledFrame = 0; // wraps freely — every pulse/spinner draw is frame % something
unsigned long lastOledDraw = 0;
unsigned long lastOledPhase = 0;
// a frame is ~1.3ms of spi (1KB at OLED_SPI_HZ) plus the draw, so the tick is not what
// caps this — the blocking sensor reads are (see panelDelay). 10ms is still the floor
// worth having: the ssd1306 refreshes itself at ~100Hz, so frames sent faster than that
// are never displayed, they just eat loop() time.
#define OLED_DRAW_INTERVAL 10
#define OLED_PHASE_INTERVAL 120 // ~1s per breathing cycle (8 steps)

/* matrix rain ("scr,1"). columns of cells, each dropping at its own rate. contrast on
   a 1-bit panel is density, so the tail fades in four tiers — see drawMatrix(). */
#define MTX_CW 6                 // cell width: the 5x8 font plus a pixel of air
#define MTX_CH 8
#define MTX_COLS (OLED_W / MTX_CW)  // 21
#define MTX_ROWS (OLED_H / MTX_CH)  // 8
int8_t mtxY[MTX_COLS];      // head row; starts negative so a drop enters from off-screen
uint8_t mtxSpd[MTX_COLS];   // draw ticks per row of fall — bigger = slower
uint8_t mtxTick[MTX_COLS];
uint8_t mtxTail[MTX_COLS];
char mtxCell[MTX_COLS][MTX_ROWS];


#define BOARD_NAME "BLACKOUT-V3" // status screen + ble local name + serial banner
// l298n. pins follow the loom's wire colours, not connector order — d10 is free.
// IMPORTANT NOTE: in1..in4 aren't contiguous — iterate MOTOR_PINS, never a range.
// IMPORTANT NOTE: keep the run inside d2-d13, the giga's whole pwm band.
#define ENA 3  // motor a speed (pwm), gris
#define IN1 2  // motor a, morado
#define IN2 7  //          azul
#define IN3 6  // motor b, verde
#define IN4 4  //          amarillo
// IMPORTANT NOTE: pull the ena/enb jumpers off the l298n — left on they tie enable
// to 5v and these pins do nothing.
// IMPORTANT NOTE: enb can't share a timer with ena. d2 and d3 are both TIM15, and the
// mbed core gives the second PwmOut on a shared timer a channel that never comes up
// (enb stayed silently low). d5 is PA_7, its own timer again; d10 (TIM1) also
// works and is the fallback if the right side ever comes up silently dead.
#define ENB 5  // motor b speed (pwm), naranja
static const uint8_t MOTOR_PINS[] = {IN1, IN2, IN3, IN4};
#define SONAR_ITER 3            // pings per reading, median drops spikes
#define SONAR_TIMEOUT_US 25000UL // ~430cm round-trip + margin, no echo = timeout
#define DIST_ALPHA 0.6          // ema on distance; median-of-3 already killed the spikes

/* the other screensavers. keep the order in step with SAVERS in app.js — the wire
   value (`scr,<n>`, 0 = off) is the index, nothing else. */
enum { SCR_OFF, SCR_MATRIX, SCR_BOUNCE, SCR_STARS, SCR_TETRIS, SCR_N };
uint8_t saver = SCR_OFF;
// bounce: the dvd-logo one. 1px per draw tick ≈ 50px/s.
static const char BN_TEXT[] = "BLACKOUT";
int16_t bnX, bnY;   // int16 for headroom on the sums, not just the range
int8_t bnDX, bnDY;
uint8_t bnW;
// stars: sparse dots falling at three depths. on 1 bit, size is the only depth cue.
#define ST_N 24
uint8_t stX[ST_N], stY[ST_N], stZ[ST_N]; // z = 1..3 = px/tick and dot size
// tetris: plays itself, badly on purpose. the well stays portrait and centred on the
// landscape panel, which also keeps a row one byte — bit c = column c, full = 0xFF.
#define TET_COLS 8
#define TET_ROWS 10
#define TET_CELL 6
#define TET_X0 ((OLED_W - TET_COLS * TET_CELL) / 2) // 40
#define TET_Y0 ((OLED_H - TET_ROWS * TET_CELL) / 2) // 2
#define TET_SPD 4 // draw ticks per row of fall
// 7 tetrominoes x 4 rotations, 4x4 bitmaps: nibble r = row r, bit c = column c.
// listing them is less code than rotating at runtime.
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

// dht11 tops out near 1hz and blocks in the same loop as ble.poll; pressure doesn't
// move fast either. both on one cadence, cached between.
#define ENV_INTERVAL 2000
#define SEND_INTERVAL 100
// the idle-under-a-screensaver cadences — see the note in loop()
#define SAVER_ENV_INTERVAL 6000
#define SAVER_SEND_INTERVAL 500

BLEService sensorService("19b10000-e8f2-537e-4f6c-d104768a1214");
BLEStringCharacteristic sensorChar("19b10001-e8f2-537e-4f6c-d104768a1214", BLERead | BLENotify, 100);
// command channel — the browser writes verbs here (see handleCmd). 64 bytes is for
// "oled,<text>"; everything else fits under 20. IMPORTANT NOTE: needs an att mtu >=67,
// so truncated oled text is the link's ceiling, not a firmware bug.
BLEStringCharacteristic cmdChar("19b10002-e8f2-537e-4f6c-d104768a1214", BLEWrite | BLEWriteWithoutResponse, 64);

// tables live in routines.h; this is the machinery. the board runs a routine
// standalone so a ble drop mid-run can't strand it, and steps advance on millis(),
// never delay() — blocking here would kill ble.poll() for the whole run.
const Step* routine = nullptr; // null = idle
uint8_t stepIdx = 0;
unsigned long stepStart = 0;

// either sensor missing (or a dead bus) just leaves its own fields at 0.
Adafruit_BME280 bme;
bool bmeOk = false;
// begin() only ever ran in setup(), so a bme rewired on a live board stayed dead
// until someone reset it — and a bus that wedged mid-run kept bmeOk true while every
// read failed the range gate, freezing the last good value on screen looking live.
// both are the same fix: re-probe on the env cadence.
uint8_t bmeMiss = 0;              // consecutive rejected reads
const uint8_t BME_MISS_MAX = 5;   // ~5s at ENV_INTERVAL before we call the bus gone
unsigned long lastBmeTry = 0;
const unsigned long BME_RETRY_MS = 5000; // don't hammer a bus with nothing on it
DHT11 dht(DHT_PIN);
int temp = 0, humid = 0;  // °C, % — last good dht read, cached
float pressure = 0;       // hPa — last good bme read, cached
float distCm = 999;       // filtered, 999 = nothing in range. the blk vm reads it
                          // directly rather than waiting on a telemetry line.

// gy-302 (bh1750) on its OWN bus, Wire2 (sda2 d9, scl2 d8), 3v3, addr 0x23.
// IMPORTANT NOTE: it would fit on Wire beside the bme — the separate bus is
// deliberate, so a shorted light sensor can't take the barometer with it.
// no library: continuous h-res is one byte out, two back.
#define BH1750_ADDR 0x23
#define BH1750_CONT_HRES 0x10 // 1 lx steps, ~120ms a conversion — well inside ENV_INTERVAL
bool luxOk = false;
float lux = 0;            // lx — last good read, cached

// -1 on a short read: a yanked wire freezes the last value instead of reporting
// pitch dark. 1.2 = datasheet counts-per-lx at default mtreg.
float readLux() {
  if (Wire2.requestFrom(BH1750_ADDR, 2) < 2) return -1;
  uint16_t raw = (Wire2.read() << 8) | Wire2.read();
  return raw / 1.2f;
}

unsigned long lastSend = 0;
unsigned long lastEnv = 0;
float distF = -1; // ema state, -1 = uninitialised

void oledCenter(const char* s, int y) {
  oled.drawStr((OLED_W - oled.getStrWidth(s)) / 2, y, s);
}

// centred inside a column — the hud sits glyph and text side by side.
void oledCenterIn(const char* s, int x0, int w, int y) {
  oled.drawStr(x0 + (w - oled.getStrWidth(s)) / 2, y, s);
}

// status screen: wordmark + pairing state. camState is tracked but not drawn.
void drawStatus() {
  oled.setFont(u8g2_font_logisoso20_tr);
  oledCenter("BLACKOUT", 26);
  oled.setFont(u8g2_font_7x13B_tr);
  oledCenter("V3", 42);
  oled.drawHLine(24, 47, OLED_W - 48);

  // animated ellipsis while pairing — a stalled pair shouldn't look frozen
  oled.setFont(u8g2_font_6x10_tf);
  if (bleConnected) {
    if ((millis() / 180) % 2) oledCenter("CONNECTED", 61); // handoff blink, not a steady state
  } else {
    static const char* dots[4] = {"PAIRING", "PAIRING.", "PAIRING..", "PAIRING..."};
    oledCenter(dots[(oledFrame / 4) % 4], 61);
  }
}

/* sage's face on the panel — the same ascii the dashboard draws, so the robot
   and the screen are one character and not two mascots. glyph table is a copy of
   FACES in server/public/js/sageface.js (`npm run test:face` diffs the two); the
   animation is here because the link only ever carries the safety level.
   IMPORTANT NOTE: self-clocked off millis(), not oledFrame — that counter steps
   every 120ms (8fps) and a shake at 8fps reads as a stutter. Offsets are whole
   pixels because the panel has no others: past ~50fps a 3px sweep gains timing
   accuracy, not smoothness. */
enum { FACE_IDLE, FACE_SCANNING, FACE_CLEAR, FACE_CAUTION, FACE_ALERT, FACE_N };
static const char FACE_G[FACE_N][3] = {  // left eye, mouth, right eye (0 = none)
  {'-', '_', '-'},
  {'o', '_', 'o'},
  {'^', '_', '^'},
  {':', 'O', 0},
  {'x', '_', 'x'},
};
#define FACE_CX 27  // centre of the glyph column, clear of HUD_COL_X
#define FACE_CY 42  // baseline
// triangle wave, -amp..amp..-amp over `period` ms. integers only — the draw path
// runs 100x a second and the h747's fpu is not free.
static int8_t tri(uint16_t p, uint16_t period, int8_t amp) {
  int32_t x = (int32_t)p * 4 * amp / period;
  return (x <= 2 * amp) ? x - amp : 3 * amp - x;
}
// 0 .. amp .. 0 over `dur` ms — a hop, which starts and ends where it stood.
static int8_t arc(uint16_t h, uint16_t dur, int8_t amp) {
  int16_t d = (int16_t)h - dur / 2;
  if (d < 0) d = -d;
  return amp - (int16_t)d * amp * 2 / dur;
}
#define FACE_CYCLE 3400  // ms, same as the css sf-bob
/* IMPORTANT NOTE: every move here travels several pixels, never one. a 1px or
   two-position animation on a 1-bit panel doesn't read as motion at all — it reads
   as two stills cutting between each other, however many times a second it is drawn.
   frame rate was never the fix for that; travel is. */
void drawFace(uint8_t mood) {
  const char* g = FACE_G[mood];
  unsigned long ms = millis();
  uint16_t ph = ms % FACE_CYCLE;
  int8_t dx = 0, dy = tri(ph, FACE_CYCLE, 1);  // nothing ever sits still — the css sf-bob
  if (mood == FACE_SCANNING) dx = tri(ph, FACE_CYCLE, 6);            // sweeping the room
  else if (mood == FACE_CLEAR) { uint16_t h = ms % 1200; if (h < 400) dy -= arc(h, 400, 4); }
  else if (mood == FACE_ALERT) dx = tri(ms % 320, 320, 3);           // shake, css sf-shake
  else if (mood == FACE_IDLE) dy = tri(ph, FACE_CYCLE, 2);           // breath
  // eyes already shut (^_^, x_x) have nothing to blink with.
  bool blink = ph >= 3240 && ph < 3360 && mood != FACE_CLEAR && mood != FACE_ALERT;
  char buf[4] = {0, 0, 0, 0};
  buf[0] = blink ? '-' : g[0];
  buf[1] = g[1];
  if (g[2]) buf[2] = blink ? '-' : g[2];
  oled.setFont(u8g2_font_10x20_tr);
  oled.drawStr(FACE_CX - oled.getStrWidth(buf) / 2 + dx, FACE_CY + dy, buf);
}

// connected screen: banner, then sage's face on the left with the server's
// verdict + metrics in the column beside it.
#define HUD_COL_X 54                  // clear of the face column
#define HUD_COL_W (OLED_W - HUD_COL_X)
void drawHud() {
  oled.setFont(u8g2_font_5x7_tr);
  oledCenter("BLACKOUT V3 - CONNECTED", 7);
  oled.drawHLine(6, 11, OLED_W - 12);

  const char* label = "STANDBY";
  uint8_t mood = FACE_SCANNING;
  if (hudLevel == "ok") { mood = FACE_CLEAR; label = "SAFE"; }
  else if (hudLevel == "warn") { mood = FACE_CAUTION; label = "CAUTION"; }
  else if (hudLevel == "bad") { mood = FACE_ALERT; label = "DANGER"; }
  drawFace(mood);
  oled.setFont(u8g2_font_7x13B_tr);
  oledCenterIn(label, HUD_COL_X, HUD_COL_W, 26);

  // pre-formatted by the server, "|" splits lines — the board doesn't decide
  // what's worth showing.
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

// operator message, word-wrapped, with a corner pulse so a static string still
// reads as live. IMPORTANT NOTE: 4 lines is all 64px holds — and the 64-char ble
// cap wraps to about that anyway.
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

// ascii only — a u8g2 japanese font is tens of KB of flash for shapes nobody can
// resolve at 5px.
static const char MTX_GLYPHS[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<>*+=-#$%&@?/\\|";
#define MTX_NGLYPHS (sizeof(MTX_GLYPHS) - 1)
static inline char mtxGlyph() { return MTX_GLYPHS[random(MTX_NGLYPHS)]; }

// fresh speed/length on re-entry, so columns never sync up.
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

// stepped from loop(), not from the draw — a hud push mid-frame must not speed it up.
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
      if (i == 0) { // head: knocked out of a solid cell — the panel's only "brighter"
        oled.drawBox(x - 1, top, MTX_CW, MTX_CH);
        oled.setDrawColor(0);
        oled.drawGlyph(x, top + MTX_CH - 1, mtxCell[c][r]);
        oled.setDrawColor(1);
        continue;
      }
      oled.drawGlyph(x, top + MTX_CH - 1, mtxCell[c][r]);
      // fake grey by erasing scanlines: keep 1 row in `keep`. 0 = solid, 2 = half,
      // 4 = quarter for the last third.
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

// random piece, deepest-landing column. a random column instead tops the well out
// every ~10 pieces and never clears a line.
void tetSpawn() {
  tetM = TET_PIECES[random(7)][random(4)];
  tetY = -3; // enters from off the top
  tetTick = 0;
  // real width, not a flat 0..4 — a 1-wide piece must be able to reach column 7.
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

// the whole screensaver layer is these three — adding one is a case in each.
void startSaver(uint8_t which) {
  randomSeed(micros()); // else every boot plays the identical pattern
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

// redrawn every tick, not on state change — a static screen doesn't read as alive.
// operator message beats the status screen, a screensaver beats everything.
void updateOled() {
  oled.clearBuffer();
  if (saver) drawSaver();
  else if (customMsg.length()) drawCustom();
  else if (bleConnected && millis() - connectAt >= HUD_BLINK_MS) drawHud();
  else drawStatus(); // splash, and the blinking handoff for the first HUD_BLINK_MS
  oled.sendBuffer();
}

// one panel tick: phase clock, one animation step, one redraw.
void tickPanel() {
  unsigned long now = millis();
  if (now - lastOledPhase >= OLED_PHASE_INTERVAL) { lastOledPhase = now; oledFrame++; }
  if (now - lastOledDraw >= OLED_DRAW_INTERVAL) {
    lastOledDraw = now;
    stepSaver(); // one animation step per drawn frame
    updateOled();
  }
}

// a blocking wait that still draws. the sonar's ring-down delays are ~180ms of dead
// time every send — that, not the draw interval, is what the panel's frame rate
// actually ran into, and a delay() there drops ~18 frames in a row. ble.poll() rides
// along so an inbound stop isn't queued behind a ping either.
// IMPORTANT NOTE: nothing called from here may block or ping, or this recurses.
void panelDelay(unsigned long ms) {
  unsigned long until = millis() + ms;
  while ((long)(millis() - until) < 0) { BLE.poll(); tickPanel(); }
}

void setup() {
  Serial.begin(9600);
  Serial.setTimeout(50); // the default 1s on a partial line stalls ble.poll + the stepper
  pinMode(TRIG_PIN, OUTPUT);
  // IMPORTANT NOTE: pulldown, not bare INPUT — a floating echo pin on the giga sits
  // HIGH, so pulseIn never sees an edge and every reading comes back -1.
  pinMode(ECHO_PIN, INPUT_PULLDOWN);

  // 0x76 on most breakouts, 0x77 on adafruit's. a miss here isn't fatal — bmeRetry()
  // re-probes on the env cadence, so a hotplug or a rewire recovers without a reset.
  Wire.begin();
  bmeOk = bme.begin(0x76) || bme.begin(0x77);
  Serial.println(bmeOk ? "BME280 ok" : "BME280 not found");

  // continuous mode doubles as the presence check — a missing chip won't ack.
  Wire2.begin();
  Wire2.beginTransmission(BH1750_ADDR);
  Wire2.write(BH1750_CONT_HRES);
  luxOk = (Wire2.endTransmission() == 0);
  Serial.println(luxOk ? "BH1750 ok" : "BH1750 not found");

  oled.getU8x8()->byte_cb = oledSpi1; // before begin(): SPI1, not the d89-d91 "SPI" bus
  oled.setBusClock(OLED_SPI_HZ);
  oled.begin();
  oled.setContrast(255); // it boots at ~0x7F
  updateOled();

  // relays off BEFORE output mode: an output pin defaults low, which on an
  // active-low board is ON — set the level first and nothing flashes at boot.
  for (uint8_t p : RELAY_PINS) { digitalWrite(p, RELAY_OFF); pinMode(p, OUTPUT); }
  for (uint8_t p : MOTOR_PINS) { pinMode(p, OUTPUT); digitalWrite(p, LOW); }
  pinMode(ENA, OUTPUT); pinMode(ENB, OUTPUT);
  analogWrite(ENA, 0); analogWrite(ENB, 0); // stopped until told otherwise

  if (!BLE.begin()) {
    while (1) { Serial.println("BLE init failed"); delay(1000); }
  }
  // known arduinoble bug: the ad packet says "arduino" whatever this is set to (the
  // co-processor only honours it post-connect), so the browser filters by service uuid.
  BLE.setLocalName(BOARD_NAME);
  // 7.5-15ms (units of 1.25ms). the default negotiates out past 30ms and every drive
  // burst waits a whole interval. more radio wakeups, worth it for manual drive.
  BLE.setConnectionInterval(6, 12);
  BLE.setAdvertisedService(sensorService);
  sensorService.addCharacteristic(sensorChar);
  sensorService.addCharacteristic(cmdChar);
  BLE.addService(sensorService);
  BLE.advertise();
  Serial.println("BLE advertising as " BOARD_NAME);
}

// the one motion primitive: signed per-side pwm, -255..255, motor a = l, b = r.
// the named verbs are its corners; the pad's arcade mix lands in between.
// a motor spinning backwards is a wire swap at the l298n terminals, not a flip here.
void tank(int l, int r) {
  l = constrain(l, -255, 255); r = constrain(r, -255, 255);
  digitalWrite(IN1, l < 0); digitalWrite(IN2, l > 0);
  digitalWrite(IN3, r < 0); digitalWrite(IN4, r > 0);
  analogWrite(ENA, abs(l)); analogWrite(ENB, abs(r));
}

void forward(uint8_t speed) { tank(speed, speed); }
void back(uint8_t speed)    { tank(-speed, -speed); }

// pivot turns: motors oppose, spins about its own centre. angle is whatever `ms`
// buys at this speed — open loop, drifts with battery charge, tune on the field.
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
      halt(); // the camera wants a clean frame
      // fire-and-forget: a dropped notify costs one analysis, the routine carries on
      sensorChar.writeValue("E:analyze");
      Serial.println("E:analyze");
      break;
    default:    halt();         break; // wait + end both mean wheels still
  }
}

// direct drive for the debug panel and the pad:
//   "drv,<fwd|back|left|right>,<pwm>[,<ms>]"
//   "drv,tank,<l>,<r>[,<ms>]"   signed per-side, -255..255
// always time-limited (800ms default, 10s cap), overrides any running routine.
unsigned long drvEnd = 0;

Ins blkCode[BLK_MAX];
uint8_t blkLen = 0, blkWant = 0; // received / declared — a short upload never runs
float blkVar[BLK_VARS];
int blkPc = -1;                  // -1 = idle
uint8_t blkPwm = 140;            // what `speed` last set; every move uses it
unsigned long blkUntil = 0;      // deadline for the instruction in flight (0 = none)
bool blkWaitEvt = false;         // parked on an evt the browser has to answer
bool blkLoading = false;         // upload in flight — keeps loop() off the ~200ms
                                 // median ping, else 40 instructions take 8s to land
bool blkResume = false;          // guard tripped: resume *at* blkpc, don't advance past it
uint8_t blkResSlot = 0xFF;       // slot an evt answer lands in (0xff = wants no value)

// lhs: 0-49 index into blk.mjs's SENSORS, 50 = our own speed, 100+ = a variable.
// sensors this board doesn't carry read 0, same as the telemetry line.
float blkRead(uint8_t lhs) {
  if (lhs >= 100) return blkVar[(uint8_t)(lhs - 100) % BLK_VARS];
  if (lhs == 50) return blkPwm;
  switch (lhs) {
    case 0: return distCm;
    case 1: return temp;
    case 2: return humid;
    case 6: return pressure;
    case 10: return lux;
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

// run from blkpc until something needs time to pass. never blocks: timed ops set
// blkUntil and tickBlk() finishes them. the guard stops a body-less `forever` from
// spinning loop() to death.
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
        halt(); // nothing should roll while sage thinks
        String e = "E:blk,"; e += i.b; e += ","; e += i.a;
        for (uint8_t v = 0; v < BLK_VARS; v++) { e += ","; e += blkVar[v]; } // so the browser can interpolate {name}
        sensorChar.writeValue(e);
        Serial.println(e);
        if (i.a == 0) break; // fire and forget
        blkWaitEvt = true;
        blkResSlot = (i.a == 2) ? i.c : 0xFF; // analyze answers "done", not a value
        blkUntil = millis() + BLK_EVT_MS;
        return;
      }
    }
    blkPc++;
  }
  blkResume = true; // guard tripped: pick up *at* this instruction next tick, not after it
}

// finish the instruction in flight if its time is up (or its condition tripped).
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

// one line per instruction, so a lost write is a short upload (caught by blkStart)
// rather than a corrupt program:
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

// one parser for both transports — serial parity means bench testing needs no ble.
void handleCmd(String c) {
  c.trim();
  if (c == "stop") stopRoutine();
  else if (c.startsWith("go,")) startRoutine(c.substring(3));
  else if (c.startsWith("drv,")) startDrive(c);
  else if (c.startsWith("blk,")) handleBlk(c);
  else if (c.startsWith("cam,")) { camState = c.substring(4); if (!saver) updateOled(); }
  else if (c.startsWith("hud,")) {
    int sep = c.indexOf(',', 4);
    hudLevel = (sep < 0) ? c.substring(4) : c.substring(4, sep);
    hudMetrics = (sep < 0) ? "" : c.substring(sep + 1);
    if (!saver) updateOled(); // under a screensaver the draw tick owns the panel
  }
  // a screensaver owns the panel until it's switched off (or the link drops)
  else if (c.startsWith("scr,")) { startSaver(c.substring(4).toInt()); updateOled(); }
  else if (c.startsWith("oled,")) {
    String msg = c.substring(5);
    customMsg = (msg == "clear") ? "" : msg; // the literal word reverts to auto
    updateOled();
  }
  // unknown verb: ignore. the board only moves when told to.
}

// one ping in cm, -1 on timeout. plain pulseIn: newping's avr-cycle-counted timing
// is wrong at this board's clock speed.
float pingCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long us = pulseIn(ECHO_PIN, HIGH, SONAR_TIMEOUT_US);
  return us > 0 ? us / 58.0 : -1;
}

float medianPingCm() {
  float s[SONAR_ITER];
  uint8_t n = 0;
  for (uint8_t i = 0; i < SONAR_ITER; i++) {
    float v = pingCm();
    if (v >= 0) s[n++] = v;
    panelDelay(60); // <60ms and the prior burst's ring-down latches a false ~20cm echo
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
    // a drop invalidates the hud, and the screensaver goes with it — nothing else can
    // switch one off, so it must never outlive the console that turned it on.
    if (!bleConnected) { hudLevel = ""; hudMetrics = ""; saver = SCR_OFF; }
    updateOled();
  }

  if (cmdChar.written()) handleCmd(cmdChar.value());
  if (Serial.available()) handleCmd(Serial.readStringUntil('\n'));

  tickRoutine(); // above the send-interval return below, which skips the rest of loop()
  tickDrive();
  tickBlk();

  tickPanel();

  unsigned long now = millis();
  bool busy = routine || blkPc >= 0 || blkLoading || drvEnd;
  // everything below this line blocks the panel — one ping is ~25ms of dead time in a
  // 10ms draw tick, and the dht11 read another ~30ms. the sonar's own waits draw
  // through panelDelay(), the rest can't, so an idle rover under a screensaver still
  // drops to 2hz telemetry; anything moving clears `busy` and puts 10hz back.
  if (now - lastSend < (saver && !busy ? SAVER_SEND_INTERVAL : SEND_INTERVAL)) return;
  lastSend = now;

  // median-of-3 takes ~200ms of wall clock, but it draws and polls its way through
  // (panelDelay), so it costs cadence and not the panel or an inbound stop. anything
  // moving takes a single ~25ms ping instead: noisier, but steps land on time. consecutive pings still land 100ms apart, clear of ring-down.
  float raw = busy ? pingCm() : medianPingCm();
  if (raw >= 0) {
    distF = (distF < 0) ? raw : distF + DIST_ALPHA * (raw - distF);
  } else {
    distF = -1; // miss = out of range, don't hold a stale value
  }
  // no echo = clear ahead. 999, never 0 — 0 reads as "touching a wall" downstream.
  float dist = (distF < 0) ? 999 : distF;
  distCm = dist;

  // own cadence, last good values held. the dht11 read blocks ~30ms (timed delays),
  // a visible hitch under a screensaver, so it backs off with the ping.
  if (now - lastEnv >= (saver && !busy ? SAVER_ENV_INTERVAL : ENV_INTERVAL)) {
    lastEnv = now;
    int t = 0, h = 0;
    // 0 = ok; an error leaves the cache alone, so a flaky wire goes stale, not wrong
    if (dht.readTemperatureHumidity(t, h) == 0) { temp = t; humid = h; }
    if (bmeOk) {
      // a glitched read compensates the registers' reset value into a real-looking
      // number, not nan, so gate on the datasheet range.
      float p = bme.readPressure() / 100.0F; // Pa -> hPa
      if (p > 300 && p < 1100) { pressure = p; bmeMiss = 0; }
      else if (++bmeMiss >= BME_MISS_MAX) { bmeOk = false; pressure = 0; }
    } else if (now - lastBmeTry >= BME_RETRY_MS) {
      // IMPORTANT NOTE: begin() on a bus with nothing on it is a handful of NACKed
      // transactions, not a hang — cheap at 0.2Hz. it blocks the panel like any other
      // i2c work, so if it ever grows past that it belongs behind panelDelay().
      lastBmeTry = now;
      bmeOk = bme.begin(0x76) || bme.begin(0x77);
      if (bmeOk) { bmeMiss = 0; Serial.println("BME280 back"); }
    }
    if (luxOk) {
      float l = readLux();
      if (l >= 0) lux = l;
    }
  }

  // IMPORTANT NOTE: no gas sensor, no imu — those fields stay 0 until one lands.
  String line = "S:";
  line += temp;
  line += ",";
  line += humid;
  line += ",";
  line += dist;
  line += ",0,0,0,0,0,0,0,"; // smoke,airq,roll,pitch,yaw,co,co_alert
  line += pressure;
  // field 11: routine running — the server gates auto-analysis on it. a flag on every
  // line, not a start/end event: a dropped event strands the server, a flag self-heals.
  line += (routine || blkPc >= 0) ? ",1" : ",0";
  line += ","; // field 12: lux
  line += lux;

  Serial.println(line);
  sensorChar.writeValue(line);
}
