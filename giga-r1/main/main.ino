#include <ArduinoBLE.h>
#include <Wire.h>
#include <Adafruit_BME280.h>
#include <DHT11.h>
#include <U8g2lib.h>
#include "routines.h"
#include "blkvm.h"
#include "arm.h"

// ---- pins ----
// relays are active low, and they sit outside the d2-d13 pwm band on purpose:
// a relay can't be dimmed, pwm just chatters the coil.
#define TRIG_PIN 52
#define ECHO_PIN 50

#define DHT_PIN A5

#define RELAY_CAM_LED 26
#define RELAY_STRIP   28
#define RELAY_LED     30
#define RELAY_ON  LOW
#define RELAY_OFF HIGH
static const uint8_t RELAY_PINS[] = {RELAY_CAM_LED, RELAY_STRIP, RELAY_LED};

#define LOOP_STALL_MS 150   // ~10 connection intervals at 7.5-15ms

#define BUZZ_PIN 72
#define BUZZ_SOUND LOW
#define BUZZ_IDLE  HIGH
#define BUZZ_HZ 2400
#define BUZZ_BEEP_MS 120
#define BUZZ_GAP_MS 600

#define OLED_ADDR   0x3C
#define OLED_I2C_HZ 400000    // the specced clock. 1M is the usual overclock but the panel came
                              // up dark on it here (2026-09-02) -- it acks at 0x3C either way,
                              // so raise it again only with the panel in front of you.


#define OLED_W 128
#define OLED_H 64
U8G2_SSD1306_128X64_NONAME_F_SW_I2C oled(U8G2_R0, U8X8_PIN_NONE, U8X8_PIN_NONE, U8X8_PIN_NONE);

// u8g2's HW_I2C constructor only knows the `Wire` object, and `Wire` is the arm's PCA9685
// bus and nothing else on purpose (a stalled servo browns the chip out and it clamps SDA).
// so the panel gets its own byte callback on Wire1 (sda1 d102 / scl1 d101), next to the bme280.
// the SW_I2C constructor above is only there for its gpio/delay callback -- byte_cb is
// replaced in setup(), so no pin is ever bit-banged.
// Wire1's txBuffer is 256B and a tile row is 1 control byte + 128 data, so it fits.

// ---- ble pump ----
// ArduinoBLE on mbed runs the HCI transport in its own thread, parking received
// packets in a fixed buffer that the SKETCH thread has to drain by calling
// BLE.poll(). When that buffer fills the controller's packets are DROPPED, not
// queued (HCICordioTransport.cpp) — so a command never arrives and the link goes
// quiet for no visible reason, then comes back. Polling once a loop() pass is not
// enough here: an oled frame is ~23ms of i2c and pulseIn() can sit for
// SONAR_TIMEOUT_US, both longer than the 30-50ms connection interval.
// This is why the stall showed up in the dashboard and the Electron app too — it
// was never the host, and no host-side fix could have touched it.
// Anything added to loop() that blocks longer than a connection interval pumps.
bool bleReady = false;                 // poll() before begin() has no transport
inline void blePump() { if (bleReady) BLE.poll(); }

// ---- black box ----
// Why the link died, readable AFTER the fact. A BLE drop leaves the sketch
// running, so a RAM ring outlives every drop that is not a reset — and a reset
// is the one thing the ring can never hold, which is what RCC->RSR at boot is
// for: it names what reset the board (brownout / watchdog / pin / power-on)
// before setup() clears it. Together those split "the host lost the link" from
// "the board rebooted under you", which is the whole question.
// The dashboard asks for a dump on every connect, so the reason for the LAST
// drop is on screen before the next run starts.
// IMPORTANT NOTE: RAM only — a power cut takes the ring with it (the boot line
// survives regardless, it is a register). If a power cut ever turns out to be
// the common case, the upgrade is the RTC backup registers (32 words that
// survive reset), not a bigger ring.
#define LOG_N 48
enum LogCode : uint8_t { LOG_BOOT, LOG_BLE_UP, LOG_BLE_DOWN, LOG_STALL, LOG_NOTIFY_FAIL };
struct LogEvt { uint32_t ms; uint32_t arg; uint8_t code; };
LogEvt logRing[LOG_N];
uint8_t logHead = 0;          // next slot to write
uint16_t logCount = 0;        // total ever logged, so a full ring still says how many were lost
uint32_t resetBits = 0;

void logEvt(uint8_t code, uint32_t arg = 0) {
  logRing[logHead] = { millis(), arg, code };
  logHead = (logHead + 1) % LOG_N;
  logCount++;
}

// the reset flags are one register and a handful of bits; decoding them here
// keeps the dashboard free of a second copy that could drift.
String resetWhy(uint32_t r) {
  String s = "";
  if (r & RCC_RSR_LPWR1RSTF) s += "lowpower ";
  if (r & RCC_RSR_WWDG1RSTF) s += "windowdog ";
  if (r & RCC_RSR_IWDG1RSTF) s += "watchdog ";
  if (r & RCC_RSR_SFT1RSTF)  s += "software ";
  if (r & RCC_RSR_PORRSTF)   s += "poweron ";
  if (r & RCC_RSR_BORRSTF)   s += "brownout ";
  if (r & RCC_RSR_PINRSTF)   s += "pin ";
  return s.length() ? s : "unknown";
}

const char *logName(uint8_t c) {
  switch (c) {
    case LOG_BOOT:        return "boot";
    case LOG_BLE_UP:      return "ble up";
    case LOG_BLE_DOWN:    return "ble down";
    case LOG_STALL:       return "loop stall";
    case LOG_NOTIFY_FAIL: return "notify failed";
  }
  return "?";
}

extern "C" uint8_t oledI2c1(u8x8_t *u8x8, uint8_t msg, uint8_t arg_int, void *arg_ptr) {
  switch (msg) {
    case U8X8_MSG_BYTE_SEND:
      Wire1.write((const uint8_t *)arg_ptr, (int)arg_int);
      break;
    case U8X8_MSG_BYTE_INIT:
      Wire1.begin();
      break;
    case U8X8_MSG_BYTE_SET_DC:
      break;   // i2c carries d/c in the control byte, there is no pin
    case U8X8_MSG_BYTE_START_TRANSFER:
      Wire1.setClock(u8x8->bus_clock);
      Wire1.beginTransmission(u8x8_GetI2CAddress(u8x8) >> 1);
      break;
    case U8X8_MSG_BYTE_END_TRANSFER:
      Wire1.endTransmission();
      blePump();       // ~16 of these a frame: the 23ms blind spot becomes ~1.5ms
      break;
    default: return 0;
  }
  return 1;
}

bool bleConnected = false;
String camState = "not connected";
String customMsg = "";

String hudLevel = "";
String hudMetrics = "";
unsigned long connectAt = 0;
#define HUD_BLINK_MS 1500

uint8_t oledFrame = 0;
unsigned long lastOledDraw = 0;
unsigned long lastOledPhase = 0;
unsigned long lastOledInit = 0;

#define OLED_DRAW_INTERVAL 40   // ~23ms of i2c a frame at 400k; a shorter tick re-fires on itself
#define OLED_PHASE_INTERVAL 120
// the panel is a full-buffer device redrawn every tick, so a dark screen is never a lost
// buffer -- it is the ssd1306's own config gone: begin() landing before the panel's rail
// settled, or a glitch on a no-CS spi bus eating a command byte. re-sending the init
// sequence (no reset pulse, ~25 bytes) puts it back; the next sendBuffer repaints.
#define OLED_REINIT_INTERVAL 5000

#define MTX_CW 6
#define MTX_CH 8
#define MTX_COLS (OLED_W / MTX_CW)
#define MTX_ROWS (OLED_H / MTX_CH)
int8_t mtxY[MTX_COLS];
uint8_t mtxSpd[MTX_COLS];
uint8_t mtxTick[MTX_COLS];
uint8_t mtxTail[MTX_COLS];
char mtxCell[MTX_COLS][MTX_ROWS];

#define BOARD_NAME "BLACKOUT-V3"

#define ENA 2
#define IN1 3
#define IN2 4
#define IN3 5
#define IN4 6

#define ENB 7
static const uint8_t MOTOR_PINS[] = {IN1, IN2, IN3, IN4};
#define SONAR_ITER 3
#define SONAR_TIMEOUT_US 25000UL

enum { SCR_OFF, SCR_MATRIX, SCR_BOUNCE, SCR_STARS, SCR_TETRIS, SCR_N };
uint8_t saver = SCR_OFF;

static const char BN_TEXT[] = "BLACKOUT";
int16_t bnX, bnY;
int8_t bnDX, bnDY;
uint8_t bnW;

#define ST_N 24
uint8_t stX[ST_N], stY[ST_N], stZ[ST_N];

#define TET_COLS 8
#define TET_ROWS 10
#define TET_CELL 6
#define TET_X0 ((OLED_W - TET_COLS * TET_CELL) / 2)
#define TET_Y0 ((OLED_H - TET_ROWS * TET_CELL) / 2)
#define TET_SPD 4

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
uint16_t tetM;
int8_t tetX, tetY;
uint8_t tetTick;

#define ENV_INTERVAL 2000
#define SEND_INTERVAL 100

#define SAVER_ENV_INTERVAL 6000
#define SAVER_SEND_INTERVAL 500

// ---- ble ----
BLEService sensorService("19b10000-e8f2-537e-4f6c-d104768a1214");
BLEStringCharacteristic sensorChar("19b10001-e8f2-537e-4f6c-d104768a1214", BLERead | BLENotify, 100);

BLEStringCharacteristic cmdChar("19b10002-e8f2-537e-4f6c-d104768a1214", BLEWrite | BLEWriteWithoutResponse, 64);

const Step* routine = nullptr;
uint8_t stepIdx = 0;
unsigned long stepStart = 0;

// ---- sensors ----
// all on 3v3: the giga's pins are not 5v tolerant
Adafruit_BME280 bme;
bool bmeOk = false;

uint8_t bmeMiss = 0;
const uint8_t BME_MISS_MAX = 5;
unsigned long lastBmeTry = 0;
const unsigned long BME_RETRY_MS = 5000;
DHT11 dht(DHT_PIN);
int temp = 0, humid = 0;
float pressure = 0;
float distCm = 999;

#define BH1750_ADDR 0x23
#define BH1750_CONT_HRES 0x10
bool luxOk = false;
float lux = 0;

float readLux() {
  if (Wire2.requestFrom(BH1750_ADDR, 2) < 2) return -1;
  uint16_t raw = (Wire2.read() << 8) | Wire2.read();
  return raw / 1.2f;
}

unsigned long lastSend = 0;
unsigned long lastEnv = 0;
float distF = -1;
float sonarRing[SONAR_ITER];
uint8_t sonarIdx = 0;


// ---- drawing ----
void oledCenter(const char* s, int y) {
  oled.drawStr((OLED_W - oled.getStrWidth(s)) / 2, y, s);
}

void oledCenterIn(const char* s, int x0, int w, int y) {
  oled.drawStr(x0 + (w - oled.getStrWidth(s)) / 2, y, s);
}

void drawStatus() {
  oled.setFont(u8g2_font_logisoso20_tr);
  oledCenter("BLACKOUT", 26);
  oled.setFont(u8g2_font_7x13B_tr);
  oledCenter("V3", 42);
  oled.drawHLine(24, 47, OLED_W - 48);

  oled.setFont(u8g2_font_6x10_tf);
  if (bleConnected) {
    if ((millis() / 180) % 2) oledCenter("CONNECTED", 61);
  } else {
    static const char* dots[4] = {"PAIRING", "PAIRING.", "PAIRING..", "PAIRING..."};
    oledCenter(dots[(oledFrame / 4) % 4], 61);
  }
}

enum { FACE_IDLE, FACE_SCANNING, FACE_CLEAR, FACE_CAUTION, FACE_ALERT, FACE_N };
static const char FACE_G[FACE_N][3] = {
  {'-', '_', '-'},
  {'o', '_', 'o'},
  {'^', '_', '^'},
  {':', 'O', 0},
  {'x', '_', 'x'},
};
#define FACE_CX 27
#define FACE_CY 42

static int8_t tri(uint16_t p, uint16_t period, int8_t amp) {
  int32_t x = (int32_t)p * 4 * amp / period;
  return (x <= 2 * amp) ? x - amp : 3 * amp - x;
}

static int8_t arc(uint16_t h, uint16_t dur, int8_t amp) {
  int16_t d = (int16_t)h - dur / 2;
  if (d < 0) d = -d;
  return amp - (int16_t)d * amp * 2 / dur;
}
#define FACE_CYCLE 3400

void drawFace(uint8_t mood) {
  const char* g = FACE_G[mood];
  unsigned long ms = millis();
  uint16_t ph = ms % FACE_CYCLE;
  int8_t dx = 0, dy = tri(ph, FACE_CYCLE, 1);
  if (mood == FACE_SCANNING) dx = tri(ph, FACE_CYCLE, 6);
  else if (mood == FACE_CLEAR) { uint16_t h = ms % 1200; if (h < 400) dy -= arc(h, 400, 4); }
  else if (mood == FACE_ALERT) dx = tri(ms % 320, 320, 3);
  else if (mood == FACE_IDLE) dy = tri(ph, FACE_CYCLE, 2);

  bool blink = ph >= 3240 && ph < 3360 && mood != FACE_CLEAR && mood != FACE_ALERT;
  char buf[4] = {0, 0, 0, 0};
  buf[0] = blink ? '-' : g[0];
  buf[1] = g[1];
  if (g[2]) buf[2] = blink ? '-' : g[2];
  oled.setFont(u8g2_font_10x20_tr);
  oled.drawStr(FACE_CX - oled.getStrWidth(buf) / 2 + dx, FACE_CY + dy, buf);
}

#define HUD_COL_X 54
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
  oled.drawDisc(OLED_W - 8, top + 6, 1 + (phase < 4 ? phase : 7 - phase) / 2);
}

// ---- screensavers ----
static const char MTX_GLYPHS[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<>*+=-#$%&@?/\\|";
#define MTX_NGLYPHS (sizeof(MTX_GLYPHS) - 1)
static inline char mtxGlyph() { return MTX_GLYPHS[random(MTX_NGLYPHS)]; }

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

void stepMatrix() {
  for (uint8_t c = 0; c < MTX_COLS; c++) {
    if (++mtxTick[c] < mtxSpd[c]) continue;
    mtxTick[c] = 0;
    if (++mtxY[c] - mtxTail[c] >= MTX_ROWS) { mtxRespawn(c); continue; }
    if (mtxY[c] >= 0 && mtxY[c] < MTX_ROWS) mtxCell[c][mtxY[c]] = mtxGlyph();
    mtxCell[c][random(MTX_ROWS)] = mtxGlyph();
  }
}

void drawMatrix() {
  oled.setFont(u8g2_font_5x8_tr);
  for (uint8_t c = 0; c < MTX_COLS; c++) {
    int x = 1 + c * MTX_CW;
    for (uint8_t i = 0; i <= mtxTail[c]; i++) {
      int r = mtxY[c] - i;
      if (r < 0 || r >= MTX_ROWS) continue;
      int top = r * MTX_CH;
      if (i == 0) {
        oled.drawBox(x - 1, top, MTX_CW, MTX_CH);
        oled.setDrawColor(0);
        oled.drawGlyph(x, top + MTX_CH - 1, mtxCell[c][r]);
        oled.setDrawColor(1);
        continue;
      }
      oled.drawGlyph(x, top + MTX_CH - 1, mtxCell[c][r]);

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
  if (bnY <= 8 || bnY >= OLED_H) bnDY = -bnDY;
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
    if (stZ[i] >= 3) oled.drawBox(stX[i] > OLED_W - 2 ? OLED_W - 2 : stX[i], stY[i], 2, 2);
    else if (stZ[i] == 2) oled.drawVLine(stX[i], stY[i], 2);
    else oled.drawPixel(stX[i], stY[i]);
  }
}

bool tetHit(uint16_t m, int8_t px, int8_t py) {
  for (uint8_t r = 0; r < 4; r++) {
    uint8_t bits = (m >> (r * 4)) & 0xF;
    if (!bits) continue;
    int8_t y = py + r;
    if (y < 0) continue;
    if (y >= TET_ROWS) return true;
    uint16_t row = (uint16_t)bits << px;
    if (row > 0xFF) return true;
    if (tetWell[y] & row) return true;
  }
  return false;
}

void tetSpawn() {
  tetM = TET_PIECES[random(7)][random(4)];
  tetY = -3;
  tetTick = 0;

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

void tetLand() {
  for (uint8_t r = 0; r < 4; r++) {
    uint8_t bits = (tetM >> (r * 4)) & 0xF;
    int8_t y = tetY + r;
    if (bits && y >= 0 && y < TET_ROWS) tetWell[y] |= bits << tetX;
  }
  for (int8_t y = TET_ROWS - 1; y >= 0; y--)
    while (tetWell[y] == 0xFF) {
      for (int8_t k = y; k > 0; k--) tetWell[k] = tetWell[k - 1];
      tetWell[0] = 0;
    }
  if (tetWell[0]) memset(tetWell, 0, sizeof tetWell);
  tetSpawn();
}

void stepTetris() {
  if (++tetTick < TET_SPD) return;
  tetTick = 0;
  if (tetHit(tetM, tetX, tetY + 1)) tetLand();
  else tetY++;
}

void drawTetris() {
  oled.drawFrame(TET_X0 - 2, TET_Y0 - 1, TET_COLS * TET_CELL + 3, TET_ROWS * TET_CELL + 2);

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

void startSaver(uint8_t which) {
  randomSeed(micros());
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

void updateOled() {
  oled.clearBuffer();
  if (saver) drawSaver();
  else if (customMsg.length()) drawCustom();
  else if (bleConnected && millis() - connectAt >= HUD_BLINK_MS) drawHud();
  else drawStatus();
  oled.sendBuffer();
}

// ---- buzzer ----
// tone() on this core is ticker-driven, so no pwm pin and nothing blocks. re-issuing it
// while it already sounds leaks a DigitalOut, so only ever write on a change, and park the
// pin low by hand afterwards — noTone() drops it wherever the last toggle left it.
String buzzLevel = "";
uint16_t buzzHz = 0;
#define buzzOn (buzzHz != 0)
unsigned long buzzAt = 0;

bool buzzEnabled = true;

struct BuzzNote { uint16_t hz; uint16_t ms; };
const BuzzNote PAIR_TUNE[] = { {1568,80}, {0,40}, {2093,140} };
const uint8_t PAIR_TUNE_N = sizeof(PAIR_TUNE) / sizeof(PAIR_TUNE[0]);
uint8_t tuneStep = PAIR_TUNE_N;
unsigned long tuneAt = 0;

void buzzPark() {
  noTone(BUZZ_PIN);
  pinMode(BUZZ_PIN, OUTPUT);
  digitalWrite(BUZZ_PIN, BUZZ_IDLE);
}

void buzzTone(uint16_t hz) {
  if (!buzzEnabled) hz = 0;
  if (hz == buzzHz) return;
  buzzHz = hz;
  if (hz) { tone(BUZZ_PIN, hz); return; }
  buzzPark();
}

void buzzSet(bool on) { buzzTone(on ? BUZZ_HZ : 0); }

void startPairTune() {
  tuneStep = 0;
  tuneAt = millis();
  buzzTone(PAIR_TUNE[0].hz);
  Serial.print("pair tune: "); Serial.print(PAIR_TUNE_N); Serial.println(" notes");
}

bool tickTune() {
  if (tuneStep >= PAIR_TUNE_N) return false;
  if (millis() - tuneAt < PAIR_TUNE[tuneStep].ms) return true;
  tuneAt = millis();
  if (++tuneStep >= PAIR_TUNE_N) { buzzTone(0); return false; }
  buzzTone(PAIR_TUNE[tuneStep].hz);
  return true;
}

void tickBuzz() {
  if (tickTune()) return;
  if (hudLevel != buzzLevel) {
    buzzLevel = hudLevel;
    buzzAt = millis();
    buzzSet(hudLevel == "bad" || hudLevel == "warn");
    return;
  }
  if (hudLevel == "bad") return;
  if (hudLevel != "warn") return;
  if (millis() - buzzAt < (buzzOn ? BUZZ_BEEP_MS : BUZZ_GAP_MS)) return;
  buzzAt = millis();
  buzzSet(!buzzOn);
}

void tickPanel() {
  unsigned long now = millis();
  if (now - lastOledInit >= OLED_REINIT_INTERVAL) {
    lastOledInit = now;
    oled.initDisplay();
    oled.setPowerSave(0);
    oled.setContrast(255);
  }
  if (now - lastOledPhase >= OLED_PHASE_INTERVAL) { lastOledPhase = now; oledFrame++; }
  if (now - lastOledDraw >= OLED_DRAW_INTERVAL) {
    lastOledDraw = now;
    stepSaver();
    updateOled();
  }
}

// ---- setup ----
void setup() {
  resetBits = RCC->RSR;            // read before anything clears it
  RCC->RSR |= RCC_RSR_RMVF;        // and clear, or every later boot reads this one
  logEvt(LOG_BOOT, resetBits);
  Serial.begin(9600);
  Serial.setTimeout(50);
  pinMode(TRIG_PIN, OUTPUT);
  for (uint8_t i = 0; i < SONAR_ITER; i++) sonarRing[i] = -1;  // 0 would read as a wall at 0cm

  pinMode(ECHO_PIN, INPUT_PULLDOWN);

  // bme sits on SDA1/SCL1 (d102/d101 = Wire1), not the d20/d21 Wire bus.
  Wire1.begin();
  bmeOk = bme.begin(0x76, &Wire1) || bme.begin(0x77, &Wire1);
  Serial.println(bmeOk ? "BME280 ok" : "BME280 not found");

  armBegin();   // pca9685 on Wire (d20/d21); jogged by the ble arm, cmd

  Wire2.begin();
  Wire2.beginTransmission(BH1750_ADDR);
  Wire2.write(BH1750_CONT_HRES);
  luxOk = (Wire2.endTransmission() == 0);
  Serial.println(luxOk ? "BH1750 ok" : "BH1750 not found");

  oled.getU8x8()->byte_cb = oledI2c1;
  oled.setI2CAddress(OLED_ADDR << 1);
  oled.setBusClock(OLED_I2C_HZ);

  delay(100);   // panel's charge pump rail comes up slower than the h747; begin() into an
                // unsettled rail is half the dark-at-boot cases.
  oled.begin();
  oled.setContrast(255);
  updateOled();

  for (uint8_t p : RELAY_PINS) { digitalWrite(p, RELAY_OFF); pinMode(p, OUTPUT); }
  buzzPark();
  for (uint8_t p : MOTOR_PINS) { pinMode(p, OUTPUT); digitalWrite(p, LOW); }
  pinMode(ENA, OUTPUT); pinMode(ENB, OUTPUT);
  analogWrite(ENA, 0); analogWrite(ENB, 0);

  if (!BLE.begin()) {
    while (1) { Serial.println("BLE init failed"); delay(1000); }
  }

  BLE.setDeviceName(BOARD_NAME);   // GAP name: without it this stays "Arduino",
                                   //  which is what a name-matching central reads
  BLE.setLocalName(BOARD_NAME);    // advertisement name: what a scanner shows

  // 7.5-15ms. The old 30-50ms was picked off SEND_INTERVAL (100ms) -- but that is
  // the *telemetry* cadence, and telemetry is not what an operator feels. An
  // inbound command can only be delivered on a connection event, so the interval
  // IS the manual-drive latency floor: at 30-50ms a stick move waited up to a
  // frame before the board even saw it. This is a request, not a setting -- the
  // central picks the final value (macOS/Chrome usually honours it), so a busy
  // 2.4ghz venue can still land on the slower end by itself.
  BLE.setConnectionInterval(6, 12);
  BLE.setAdvertisedService(sensorService);
  sensorService.addCharacteristic(sensorChar);
  sensorService.addCharacteristic(cmdChar);
  BLE.addService(sensorService);
  BLE.advertise();
  bleReady = true;                     // blePump() is live from here
  Serial.println("BLE advertising as " BOARD_NAME);
  startPairTune();
}

// ---- motors ----
// tank() is the only primitive; the named verbs are its corners
void tank(int l, int r) {
  l = constrain(l, -255, 255); r = constrain(r, -255, 255);
  digitalWrite(IN1, l < 0); digitalWrite(IN2, l > 0);
  digitalWrite(IN3, r < 0); digitalWrite(IN4, r > 0);
  analogWrite(ENA, abs(l)); analogWrite(ENB, abs(r));
}

void forward(uint8_t speed) { tank(speed, speed); }
void back(uint8_t speed)    { tank(-speed, -speed); }

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
      halt();

      sensorChar.writeValue("E:analyze");
      Serial.println("E:analyze");
      break;
    default:    halt();         break;
  }
}

unsigned long drvEnd = 0;

// ---- blk vm ----
// plays the instruction list the dashboard uploads. every move is still time-limited,
// and an inbound stop ends it.
Ins blkCode[BLK_MAX];
uint8_t blkLen = 0, blkWant = 0;
float blkVar[BLK_VARS];
int blkPc = -1;
uint8_t blkPwm = 140;
unsigned long blkUntil = 0;
bool blkWaitEvt = false;
bool blkLoading = false;

bool blkResume = false;
uint8_t blkResSlot = 0xFF;

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

bool blkTest(const Ins& i) {
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

void blkEnter() {
  for (uint8_t guard = 0; guard < 64; guard++) {
    if (blkPc < 0 || blkPc >= blkLen) { blkFinish(); return; }
    const Ins& i = blkCode[blkPc];
    switch (i.op) {
      case B_END: blkFinish(); return;
      case B_STOP: blkFinish(); return;
      case B_MOVE:  blkDrive(i.a, blkPwm); blkUntil = millis() + (uint16_t)i.c; return;
      case B_MOVEU:
        if (blkTest(i)) { halt(); break; }
        blkDrive(i.a, blkPwm);
        blkUntil = millis() + (i.c ? (uint16_t)i.c : 30000);
        return;
      case B_WAIT: halt(); blkUntil = millis() + (uint16_t)i.c; return;
      case B_WAITU:
        if (blkTest(i)) break;
        halt();
        blkUntil = i.c ? millis() + (uint16_t)i.c : 0;
        return;
      case B_SPEED: blkPwm = i.b; break;
      case B_SET: blkVar[i.a % BLK_VARS] = i.rhs; break;
      case B_ADD: blkVar[i.a % BLK_VARS] += i.rhs; break;
      case B_JMP: blkPc = i.c; continue;
      case B_JMPF: if (!blkTest(i)) { blkPc = i.c; continue; } break;
      case B_EVT: {
        halt();
        String e = "E:blk,"; e += i.b; e += ","; e += i.a;
        for (uint8_t v = 0; v < BLK_VARS; v++) { e += ","; e += blkVar[v]; }
        sensorChar.writeValue(e);
        Serial.println(e);
        if (i.a == 0) break;
        blkWaitEvt = true;
        blkResSlot = (i.a == 2) ? i.c : 0xFF;
        blkUntil = millis() + BLK_EVT_MS;
        return;
      }
    }
    blkPc++;
  }
  blkResume = true;
}

void tickBlk() {
  if (blkPc < 0) return;
  if (blkResume) { blkResume = false; blkEnter(); return; }
  const Ins& i = blkCode[blkPc];
  if (blkWaitEvt) {
    if (millis() < blkUntil) return;
    blkWaitEvt = false;
  } else if (i.op == B_MOVEU || i.op == B_WAITU) {
    if (!blkTest(i) && (!blkUntil || millis() < blkUntil)) return;
  } else if (blkUntil && millis() < blkUntil) return;
  halt();
  blkUntil = 0;
  blkPc++;
  blkEnter();
}

void blkStart() {
  if (!blkLen || blkLen != blkWant) {
    sensorChar.writeValue("E:blkerr");
    Serial.println("E:blkerr");
    return;
  }
  routine = nullptr;
  drvEnd = 0;
  for (uint8_t v = 0; v < BLK_VARS; v++) blkVar[v] = 0;
  blkPwm = 140;
  blkUntil = 0;
  blkWaitEvt = false;
  blkPc = 0;
  Serial.print("blk start: "); Serial.print(blkLen); Serial.println(" ins");
  blkEnter();
}

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

void handleBlk(const String& c) {
  String k = blkFld(c, 1);
  if (k == "n") {
    blkHalt();
    memset(blkCode, 0, sizeof(blkCode));
    blkLen = 0;
    blkWant = blkFld(c, 2).toInt();
    blkLoading = true;
    sensorChar.writeValue("E:blkrdy");
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
    blkUntil = 0;
  }
}

void stopRoutine() { routine = nullptr; drvEnd = 0; blkHalt(); armStopAll(); }

// ---- commands ----
void startDrive(const String& c) {
  int a = c.indexOf(',', 4);
  if (a < 0) return;
  String verb = c.substring(4, a);
  int b = c.indexOf(',', a + 1);
  if (b < 0 && verb == "tank") return;
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
    else { halt(); return; }
  }
  drvEnd = millis() + ms;
  Serial.print("drv: "); Serial.println(c);
}

void tickDrive() {
  if (drvEnd && millis() >= drvEnd) { drvEnd = 0; halt(); }
}

void startRoutine(const String& name) {
  if (name == "presentation") routine = PRESENTATION;
  else if (name == "run") routine = RUN;
  else if (name == "test") routine = TEST;
  else if (name == "mission") routine = MISSION;
  else if (name == "test2") routine = TEST2;
  else return;
  drvEnd = 0;
  stepIdx = 0;
  stepStart = millis();
  applyStep(routine[0]);
  Serial.print("routine start: "); Serial.println(name);
}

void tickRoutine() {
  if (!routine) return;
  if (routine[stepIdx].op == END) { stopRoutine(); Serial.println("routine done"); return; }
  if (millis() - stepStart < routine[stepIdx].ms) return;
  stepIdx++;
  stepStart = millis();
  applyStep(routine[stepIdx]);
}

// one line per event, formatted HERE so the dashboard needs no second copy of
// the code table. Pumps between lines: a full ring is 48 notifies back to back.
void dumpLog() {
  uint16_t lost = logCount > LOG_N ? logCount - LOG_N : 0;
  uint8_t n = logCount < LOG_N ? logCount : LOG_N;
  uint8_t i = logCount < LOG_N ? 0 : logHead;
  String head = "E:log,0,up ";
  head += millis() / 1000;
  head += "s, last reset ";
  head += resetWhy(resetBits);
  if (lost) { head += ", "; head += lost; head += " older events lost"; }
  Serial.println(head);
  if (bleConnected) sensorChar.writeValue(head);
  for (uint8_t k = 0; k < n; k++, i = (i + 1) % LOG_N) {
    String l = "E:log,";
    l += logRing[i].ms;
    l += ",";
    l += logName(logRing[i].code);
    if (logRing[i].code == LOG_BOOT) { l += " ("; l += resetWhy(logRing[i].arg); l += ")"; }
    else if (logRing[i].arg) { l += " "; l += logRing[i].arg; l += "ms"; }
    Serial.println(l);
    if (bleConnected) sensorChar.writeValue(l);
    blePump();
  }
  Serial.println("E:logend");
  if (bleConnected) sensorChar.writeValue("E:logend");
}

void handleCmd(String c) {
  c.trim();
  if (c == "stop") stopRoutine();
  else if (c.startsWith("go,")) startRoutine(c.substring(3));
  else if (c.startsWith("drv,")) startDrive(c);
  else if (c.startsWith("blk,")) handleBlk(c);
  else if (c.startsWith("armh,")) {                // bench trim: armh,<j>,<hold>[,<sag>]
    int a = c.indexOf(',', 5);                     // sag is the same bias per 1000ms
    int b = a > 0 ? c.indexOf(',', a + 1) : -1;    // of travel — one flat number
    if (a > 0)                                     // cannot hold a joint at every pose
      armSetHold(c.substring(5, a).toInt(),
                 c.substring(a + 1, b > 0 ? b : c.length()).toInt(),
                 b > 0 ? c.substring(b + 1).toInt() : 0);
  }
  else if (c.startsWith("armz,")) {               // "this is home" — the travel
    String j = c.substring(5);                     // budget is dead reckoning and
    armZero(j.length() ? j.toInt() : -1);          // drifts; bare armz, = all joints
    Serial.println("arm travel zeroed");
  }
  else if (c.startsWith("arm,")) {
    int a = c.indexOf(',', 4);
    if (a < 0) armStopAll();                       // bare "arm," = all joints off
    else armJog(c.substring(4, a).toInt(), c.substring(a + 1).toInt());
  }

  else if (c.startsWith("hz,")) { tuneStep = PAIR_TUNE_N; buzzTone(c.substring(3).toInt()); }

  else if (c == "tune") { Serial.println("tune: replaying pairing tune"); startPairTune(); }
  else if (c.startsWith("buz,")) {
    buzzEnabled = c.substring(4).toInt() != 0;
    if (!buzzEnabled) { buzzHz = 0; tuneStep = PAIR_TUNE_N; buzzPark(); }

    else buzzLevel = "-";
  }
  else if (c.startsWith("cam,")) { camState = c.substring(4); if (!saver) updateOled(); }
  else if (c.startsWith("hud,")) {
    int sep = c.indexOf(',', 4);
    hudLevel = (sep < 0) ? c.substring(4) : c.substring(4, sep);
    hudMetrics = (sep < 0) ? "" : c.substring(sep + 1);
    if (!saver) updateOled();
  }

  else if (c.startsWith("log")) {                   // "log," dumps, "log,clear" wipes
    if (c.endsWith("clear")) { logHead = 0; logCount = 0; logEvt(LOG_BOOT, resetBits); }
    dumpLog();
  }
  else if (c.startsWith("scr,")) { startSaver(c.substring(4).toInt()); updateOled(); }
  else if (c.startsWith("oled,")) {
    String msg = c.substring(5);
    customMsg = (msg == "clear") ? "" : msg;
    updateOled();
  }
}

// ---- sonar ----
// median of a few pings: one stray echo off a corner is worse than a slow reading
float pingCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  blePump();
  unsigned long us = pulseIn(ECHO_PIN, HIGH, SONAR_TIMEOUT_US);
  blePump();       // pulseIn blocks to SONAR_TIMEOUT_US with nothing in range
  return us > 0 ? us / 58.0 : -1;
}

// one ping per call, median over the last SONAR_ITER of them. sends are already
// SEND_INTERVAL apart, so the ring-down gap is free -- it used to be 3 pings back to
// back with a 60ms panelDelay between, ~200ms of dead time every pass, which is both
// the telemetry cadence and the command latency.
float medianPingCm() {
  sonarRing[sonarIdx] = pingCm();
  sonarIdx = (sonarIdx + 1) % SONAR_ITER;

  float s[SONAR_ITER];
  uint8_t n = 0;
  for (uint8_t i = 0; i < SONAR_ITER; i++) if (sonarRing[i] >= 0) s[n++] = sonarRing[i];
  if (n == 0) return -1;
  for (uint8_t i = 1; i < n; i++) {
    float key = s[i];
    int j = i - 1;
    while (j >= 0 && s[j] > key) { s[j + 1] = s[j]; j--; }
    s[j + 1] = key;
  }
  return s[n / 2];
}

// ---- loop ----
void loop() {
  // a pass longer than a couple of connection intervals is BLE.poll() starvation
  // — the thing that drops commands and can look exactly like a disconnect, so
  // the log has to name it or the ring only ever says "ble down" with no cause.
  static unsigned long lastPass = 0;
  unsigned long pass = millis();
  if (lastPass && pass - lastPass > LOOP_STALL_MS) logEvt(LOG_STALL, pass - lastPass);
  lastPass = pass;

  BLE.poll();

  bool nowConnected = BLE.central();
  if (nowConnected != bleConnected) {
    bleConnected = nowConnected;
    unsigned long was = connectAt;
    connectAt = millis();
    logEvt(bleConnected ? LOG_BLE_UP : LOG_BLE_DOWN, connectAt - was);
    Serial.println(bleConnected ? "BLE central connected" : "BLE central gone");

    if (!bleConnected) { hudLevel = ""; hudMetrics = ""; saver = SCR_OFF; startPairTune(); }
    updateOled();
  }

  if (cmdChar.written()) handleCmd(cmdChar.value());
  if (Serial.available()) handleCmd(Serial.readStringUntil('\n'));

  tickRoutine();
  tickDrive();
  tickBlk();

  tickPanel();
  tickBuzz();
  armTick();

  unsigned long now = millis();
  bool busy = routine || blkPc >= 0 || blkLoading || drvEnd;

  if (now - lastSend < (saver && !busy ? SAVER_SEND_INTERVAL : SEND_INTERVAL)) return;
  lastSend = now;

  distF = medianPingCm();
  float dist = (distF < 0) ? 999 : distF;
  distCm = dist;

  if (now - lastEnv >= (saver && !busy ? SAVER_ENV_INTERVAL : ENV_INTERVAL)) {
    lastEnv = now;
    int t = 0, h = 0;

    if (dht.readTemperatureHumidity(t, h) == 0) { temp = t; humid = h; }
    blePump();       // the dht bit-bangs its one-wire protocol for ~30ms
    if (bmeOk) {
      float p = bme.readPressure() / 100.0F;
      if (p > 300 && p < 1100) { pressure = p; bmeMiss = 0; }
      else if (++bmeMiss >= BME_MISS_MAX) { bmeOk = false; pressure = 0; }
    } else if (now - lastBmeTry >= BME_RETRY_MS) {
      lastBmeTry = now;
      bmeOk = bme.begin(0x76, &Wire1) || bme.begin(0x77, &Wire1);
      if (bmeOk) { bmeMiss = 0; Serial.println("BME280 back"); }
    }
    if (luxOk) {
      float l = readLux();
      if (l >= 0) lux = l;
    }
  }

  String line = "S:";
  line += temp;
  line += ",";
  line += humid;
  line += ",";
  line += dist;
  line += ",0,0,0,0,0,0,0,";
  line += pressure;

  line += (routine || blkPc >= 0) ? ",1" : ",0";
  line += ",";
  line += lux;

  Serial.println(line);
  if (!sensorChar.writeValue(line) && bleConnected) logEvt(LOG_NOTIFY_FAIL);
}
