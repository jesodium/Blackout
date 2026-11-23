// part of main.ino, #included where this section used to be -- order matters
#pragma once

// ---- panel ----
// 3.5" ILI9488 480x320 on shield J11 (spi1: d13 sck, d11 mosi), cs d10, dc d1.
// Four screens: boot -> pairing (until a central connects) -> "connected" for HELLO_MS -> info
// (sensor cards, hud level along the bottom). A drop goes straight back to pairing.
// What the bench sessions settled (2026-11-18):
//  - Arduino_GFX's Arduino_HWSPI never drives the panel on the giga: plain white screen at any
//    speed, on SPI or SPI1. Raw SPI1.transfer() does, so GigaBus below buffers bytes and pushes
//    them through SPI1 itself; the library still does all the drawing.
//  - J11 ties the panel's RST to 3v3, so there is no reset pin: the driver's swreset does it.
//  - 20MHz held on the J11 cable. 40M is untested; drop to 8M if pixels glitch.
// Speed: the ILI9488 only takes 18-bit colour over spi (3 bytes/px), so a full clear is ~500ms
// and is only done on a screen change, in strips with blePump() between. Everything else is
// drawn into a RAM canvas and sent as one block: text straight to the bus goes one fillRect per
// font pixel, ~370ms for a two-word label.
// Text: u8g2 fonts at their native size (U8g2 lib only has to be installed, Arduino_GFX picks
// it up). The built-in 5x7 font scaled 2-6x is what made the old screens look 8-bit.
// IMPORTANT NOTE: still 1-bit glyphs, no anti-aliasing; smooth edges would need a blending
// renderer and ~3x the canvas RAM.
// Touch (XPT2046) is not on J11 and not used.
#define LCD_DC 1
#define LCD_CS 10
#define LCD_SPI_HZ 20000000
#define PAIR_DOTS_MS 400
#define INFO_REFRESH_MS 250
#define LCD_SHIFT_MAX 40   // px either way; past that the far edge is what gets cut instead

extern int blkPc;   // vm.h, included after this

#include "kvstore_global_api.h"

class GigaBus : public Arduino_DataBus {
  int8_t dc, cs;
  uint8_t buf[1440];
  uint16_t n = 0;
  SPISettings set;

  void flush() { if (n) { SPI1.transfer(buf, n); n = 0; } }
  void cmd(uint8_t c) { flush(); digitalWrite(dc, LOW); SPI1.transfer(c); digitalWrite(dc, HIGH); }

public:
  GigaBus(int8_t dc, int8_t cs) : dc(dc), cs(cs) {}

  bool begin(int32_t speed, int8_t) override {
    pinMode(dc, OUTPUT); digitalWrite(dc, HIGH);
    pinMode(cs, OUTPUT); digitalWrite(cs, HIGH);
    set = SPISettings(speed == GFX_NOT_DEFINED ? LCD_SPI_HZ : speed, MSBFIRST, SPI_MODE0);
    SPI1.begin();
    return true;
  }
  void beginWrite() override { SPI1.beginTransaction(set); digitalWrite(cs, LOW); }
  void endWrite() override { flush(); digitalWrite(cs, HIGH); SPI1.endTransaction(); }
  void writeCommand(uint8_t c) override { cmd(c); }
  void writeCommand16(uint16_t c) override { cmd(c >> 8); cmd(c); }
  void writeCommandBytes(uint8_t *d, uint32_t len) override { while (len--) cmd(*d++); }
  void write(uint8_t b) override { buf[n++] = b; if (n == sizeof(buf)) flush(); }
  void write16(uint16_t d) override { write(d >> 8); write(d); }
  void writeRepeat(uint16_t p, uint32_t len) override { while (len--) write16(p); }
  void writeBytes(uint8_t *d, uint32_t len) override { while (len--) write(*d++); }
  void writePixels(uint16_t *d, uint32_t len) override { while (len--) write16(*d++); }
  void writePattern(uint8_t *d, uint8_t len, uint32_t repeat) override {
    while (repeat--) for (uint8_t i = 0; i < len; i++) write(d[i]);
  }
};

Arduino_DataBus *lcdBus = new GigaBus(LCD_DC, LCD_CS);
Arduino_GFX *lcd = new Arduino_ILI9488_18bit(lcdBus, GFX_NOT_DEFINED, 1 /*landscape*/);

// the desktop dash's dark palette (server/public/css/dash.css :root), so the robot reads as the same app
#define C_BG    RGB565(11, 11, 12)      // --bg
#define C_CARD  RGB565(20, 20, 22)      // --raise
#define C_LINE  RGB565(35, 35, 38)      // --line
#define C_DIM   RGB565(138, 136, 131)   // --ink-2
#define C_TEXT  RGB565(232, 230, 225)   // --ink
#define C_GO    RGB565(74, 222, 128)    // --go
#define C_GLOW  RGB565(27, 64, 41)      // --go at 25% over --bg: the link dot's box-shadow
#define C_WARN  RGB565(250, 204, 21)    // --warn
#define C_BAD   RGB565(239, 68, 68)     // --stop

// info screen grid, like the dash's sensor tiles: 1px --line between cells, nothing rounded.
// Laid out on 474 not 480: with the bezel shift the last 6px fall off the right edge.
#define BAR_H 44                  // header and hud bar
#define TILE_W 157
#define TILE_H 114
#define GRID_Y (BAR_H + 1)        // tiles start under the header's line
#define LINE_W 320
#define LINE_H 64
Arduino_Canvas *lineCv = new Arduino_Canvas(LINE_W, LINE_H, nullptr);   // centred text lines
Arduino_Canvas *barCv  = new Arduino_Canvas(480, BAR_H, nullptr);    // header and hud bar
Arduino_Canvas *cardCv = new Arduino_Canvas(TILE_W, TILE_H, nullptr);   // one sensor tile

// Where the glass actually sits in the case: every widget is drawn shifted by this, so a
// panel the bezel crops on one side gets its picture slid back to centre. Tuned live with
// `lcd,<x>,<y>[,1]` (arm configurator's "screen" pane) and kept in flash across reflashes.
// IMPORTANT NOTE: a shift, not a resize -- moving right by N drops N px off the right edge,
// which is only background today (cards stop at 474, bars are flat colour past the text).
#define LCD_SHIFT_X 6       // this chassis: bezel eats ~6px on the left (bench, 2026-11-23)
struct { int16_t x, y; } lcdShift = {LCD_SHIFT_X, 0};
bool lcdFrame = false;   // test pattern up instead of the real screen

void blit(Arduino_Canvas *c, int16_t x, int16_t y) {
  lcd->draw16bitRGBBitmap(x + lcdShift.x, y + lcdShift.y, c->getFramebuffer(), c->width(), c->height());
  blePump();
}

#define F_HUGE  u8g2_font_logisoso42_tr   // splash title
#define F_BIG   u8g2_font_fub25_tr        // status lines
#define F_MID   u8g2_font_fub17_tr        // header / hud bar
#define F_SMALL u8g2_font_helvB12_tr      // labels, units
// info screen: Inconsolata, the closest u8g2 has to the dash's IBM Plex Mono
// Inconsolata 16 is ~13px a letter, too wide for a 157px tile ("PRESS" + "CAUTION" collide),
// so tiles use spleen's 8px pixel mono for their small text
#define F_K     u8g2_font_inr16_mr        // header / hud bar text
#define F_KB    u8g2_font_inb16_mr        // brand, hud chip, AUTO RUN
#define F_T     u8g2_font_spleen8x16_mr   // tile labels, chips, units, CLEAR / CALIBRATING
#define F_VAL   u8g2_font_inr30_mr        // sensor values (the dash's tile <b>), ~24px a digit
#define F_VAL_S u8g2_font_inr24_mr        // only when a value won't fit beside its unit (5-digit lux)

// y is the baseline, not the top: that's how u8g2 fonts are placed
void cvText(Arduino_GFX *c, int16_t x, int16_t y, const char *s, const uint8_t *font, uint16_t fg) {
  c->setFont(font);
  c->setTextColor(fg);
  c->setCursor(x, y);
  c->print(s);
}

// ink box of s in font: w wide, top sits `up` px above the baseline
void textBox(Arduino_GFX *c, const char *s, const uint8_t *font, uint16_t *w, int16_t *up) {
  int16_t x1, y1; uint16_t h;
  c->setFont(font);
  c->getTextBounds(s, 0, 0, &x1, &y1, w, &h);
  if (up) *up = -y1;
}

// baseline that centres capitals in a box h tall, so every string in a font sits at the same height
int16_t midBase(Arduino_GFX *c, const uint8_t *font, int16_t h) {
  uint16_t w; int16_t up;
  textBox(c, "H", font, &w, &up);
  return (h + up) / 2;
}

// centred on y + 24 (the old 48px line's middle); `measure` centres a longer string instead,
// so text that grows (pairing dots) stays put
void line(int16_t y, const char *s, const uint8_t *font, uint16_t fg, const char *measure = nullptr) {
  uint16_t w; int16_t up;
  lineCv->fillScreen(C_BG);
  textBox(lineCv, measure ? measure : s, font, &w, &up);
  cvText(lineCv, (LINE_W - w) / 2, midBase(lineCv, font, LINE_H), s, font, fg);
  blit(lineCv, (480 - LINE_W) / 2, y + 24 - LINE_H / 2);
}

void clearScreen() {
  for (int16_t y = 0; y < 320; y += 32) { lcd->fillRect(0, y, 480, 32, C_BG); blePump(); }
}

void splash() {
  clearScreen();
  line(80, "BLACKOUT", F_HUGE, C_TEXT);
  line(240, BOARD_NAME, F_SMALL, C_DIM);
}

// ---- info screen ----
#define SEN_N 6
static const char *SEN_NAME[SEN_N] = {"TEMP", "HUMID", "DIST", "PRESS", "LIGHT", "GAS"};
static const char *SEN_UNIT[SEN_N] = {"C", "%", "cm", "hPa", "lx", "/100"};
// dash.js LIMITS: [danger below, caution below, caution above, danger above]
// IMPORTANT NOTE: copied, not shared -- retune both if the course changes them
static const float SEN_LIM[SEN_N][4] = {
  {0, 10, 30, 40}, {20, 30, 70, 85}, {15, 40, 1e9, 1e9},
  {950, 980, 1040, 1060}, {10, 100, 1e9, 1e9}, {50, 80, 1e9, 1e9},
};
enum { LV_NONE, LV_SAFE, LV_CAUTION, LV_DANGER, LV_WARM };
static const char *LV_NAME[] = {"", "SAFE", "CAUTION", "DANGER", "WARM"};
static const uint16_t LV_COL[] = {C_LINE, C_GO, C_WARN, C_BAD, C_WARN};
char shownSen[SEN_N][12];
int8_t shownLvl = -1, shownAuto = -1;

// what a dash tile shows: value text and level; CLEAR / CALIBRATING are words, not numbers
uint8_t senValue(uint8_t i, char *out) {
  bool ok = true;
  float v = 0;
  switch (i) {
    case 0: v = temp; break;
    case 1: v = humid; break;
    case 2: if (distCm >= 999) { strcpy(out, "CLEAR"); return LV_SAFE; } v = distCm; break;
    case 3: ok = bmeOk; v = pressure; break;
    case 4: ok = luxOk; v = lux; break;
    case 5: if (gasIdx < 0) { strcpy(out, "CALIBRATING"); return LV_WARM; } ok = gasIdx > 0; v = gasIdx; break;
  }
  if (!ok) { strcpy(out, "--"); return LV_NONE; }
  snprintf(out, 12, "%d", (int)lroundf(v));
  const float *l = SEN_LIM[i];
  return v < l[0] || v > l[3] ? LV_DANGER : v < l[1] || v > l[2] ? LV_CAUTION : LV_SAFE;
}

// the dash's .lvl: solid colour, dark bold text, top-right of x..right
void chip(Arduino_GFX *c, int16_t right, int16_t top, uint8_t lvl, const uint8_t *font) {
  uint16_t w; int16_t up;
  textBox(c, LV_NAME[lvl], font, &w, &up);
  c->fillRect(right - w - 12, top, w + 12, up + 10, LV_COL[lvl]);
  cvText(c, right - w - 6, top + 5 + up, LV_NAME[lvl], font, C_BG);
}

void drawCard(uint8_t i, const char *v, uint8_t lvl) {
  uint16_t w; int16_t up;
  cardCv->fillScreen(C_BG);
  cardCv->fillRect(0, 0, 3, TILE_H, LV_COL[lvl]);   // the 3px level stripe (inset box-shadow)
  textBox(cardCv, "H", F_T, &w, &up);
  cvText(cardCv, 14, 14 + up, SEN_NAME[i], F_T, C_DIM);
  if (lvl) chip(cardCv, TILE_W - 10, 9, lvl, F_T);
  int16_t base = TILE_H - 16;
  if (isdigit(v[0])) {
    uint16_t uw, vw;
    textBox(cardCv, SEN_UNIT[i], F_T, &uw, nullptr);
    textBox(cardCv, v, F_VAL, &vw, nullptr);
    const uint8_t *f = 14 + vw + 8 + uw <= TILE_W - 12 ? F_VAL : F_VAL_S;
    cvText(cardCv, 14, base, v, f, C_TEXT);
    cvText(cardCv, TILE_W - 12 - uw, base, SEN_UNIT[i], F_T, C_DIM);
  } else {
    cvText(cardCv, 14, base, v, isalpha(v[0]) ? F_T : F_VAL, lvl ? LV_COL[lvl] : C_DIM);
  }
  blit(cardCv, (i % 3) * (TILE_W + 1), GRID_Y + (i / 3) * (TILE_H + 1));
}

// static parts of the info screen: the 1px lines between header, tiles and hud bar
void drawGrid() {
  int16_t x = lcdShift.x, y = lcdShift.y, bot = GRID_Y + 2 * TILE_H + 1;
  lcd->fillRect(x, y + BAR_H, 480, 1, C_LINE);
  lcd->fillRect(x, y + GRID_Y + TILE_H, 480, 1, C_LINE);
  lcd->fillRect(x, y + bot, 480, 1, C_LINE);
  for (int16_t c = 1; c < 3; c++) lcd->fillRect(x + c * (TILE_W + 1) - 1, y + GRID_Y, 1, bot - GRID_Y, C_LINE);
}

void drawHeader() {
  uint16_t w;
  int16_t base = midBase(barCv, F_K, BAR_H), up;
  barCv->fillScreen(C_BG);
  cvText(barCv, 16, base, "BLACKOUT", F_KB, C_TEXT);
  textBox(barCv, "BLACKOUT", F_KB, &w, nullptr);
  cvText(barCv, 16 + w + 16, base, BOARD_NAME, F_K, C_DIM);
  textBox(barCv, "linked", F_K, &w, &up);
  int16_t tx = 474 - 16 - w;
  cvText(barCv, tx, base, "linked", F_K, C_TEXT);
  barCv->fillRect(tx - 22, BAR_H / 2 - 7, 14, 14, C_GLOW);   // the dot's glow
  barCv->fillRect(tx - 19, BAR_H / 2 - 4, 8, 8, C_GO);
  blit(barCv, 0, 0);
}

void drawBar(uint8_t lvl, bool autoRun) {
  static const uint8_t HUD[] = {LV_NONE, LV_SAFE, LV_CAUTION, LV_DANGER};
  uint16_t w; int16_t up;
  int16_t base = midBase(barCv, F_K, BAR_H);
  barCv->fillScreen(C_BG);
  cvText(barCv, 16, base, "HUD", F_K, C_DIM);
  textBox(barCv, "HUD", F_K, &w, &up);
  int16_t x = 16 + w + 12;
  if (lvl) {
    uint16_t cw; int16_t cup;
    textBox(barCv, LV_NAME[HUD[lvl]], F_KB, &cw, &cup);
    chip(barCv, x + cw + 12, BAR_H / 2 - (cup + 10) / 2, HUD[lvl], F_KB);   // chip() takes its right edge
  } else cvText(barCv, x, base, "standby", F_K, C_DIM);
  if (autoRun) {
    textBox(barCv, "AUTO RUN", F_KB, &w, nullptr);
    int16_t tx = 474 - 16 - w;
    cvText(barCv, tx, base, "AUTO RUN", F_KB, C_WARN);
    barCv->fillRect(tx - 19, BAR_H / 2 - 4, 8, 8, C_WARN);
  }
  blit(barCv, 0, 320 - BAR_H);
}

// ---- screens ----
enum { PS_BOOT, PS_PAIR, PS_HELLO, PS_INFO };
uint8_t pState = PS_BOOT;

void enterScreen(uint8_t s) {
  uint8_t was = pState;
  pState = s;
  if (s == PS_PAIR) { if (was != PS_BOOT) splash(); return; }   // boot is the same picture
  clearScreen();
  if (s == PS_HELLO) {
    line(110, "CONNECTED", F_BIG, C_GO);
    line(240, BOARD_NAME, F_SMALL, C_DIM);
    return;
  }
  drawGrid();
  drawHeader();
  for (uint8_t i = 0; i < SEN_N; i++) shownSen[i][0] = 0;
  shownLvl = shownAuto = -1;
}

// The 480x320 the firmware thinks it has, outlined where it lands after the shift, plus a
// ruler at each side: a mark every 10px in from the edge, so the first one you can see is
// how much the bezel eats there.
void drawFrame() {
  clearScreen();
  int16_t x = lcdShift.x, y = lcdShift.y;
  lcd->drawRect(x, y, 480, 320, C_WARN);
  lcd->drawRect(x + 1, y + 1, 478, 318, C_WARN);
  for (int16_t t = 10; t <= 40; t += 10) {
    int16_t h = t == 20 || t == 40 ? 60 : 30;
    lcd->drawFastVLine(x + t, y + 160 - h / 2, h, C_TEXT);
    lcd->drawFastVLine(x + 479 - t, y + 160 - h / 2, h, C_TEXT);
    lcd->drawFastHLine(x + 240 - h / 2, y + t, h, C_TEXT);
    lcd->drawFastHLine(x + 240 - h / 2, y + 319 - t, h, C_TEXT);
  }
  char s[24];
  snprintf(s, sizeof s, "X %+d  Y %+d", lcdShift.x, lcdShift.y);
  line(100, "SCREEN ADJUST", F_MID, C_WARN);
  line(190, s, F_MID, C_TEXT);
}

void lcdAdjust(int16_t x, int16_t y, bool frame) {
  lcdShift.x = constrain(x, -LCD_SHIFT_MAX, LCD_SHIFT_MAX);
  lcdShift.y = constrain(y, -LCD_SHIFT_MAX, LCD_SHIFT_MAX);
  lcdFrame = frame;
  kv_set("/kv/lcdshift", &lcdShift, sizeof lcdShift, 0);
  Serial.print("lcd shift "); Serial.print(lcdShift.x); Serial.print(','); Serial.println(lcdShift.y);
  if (frame) drawFrame();
  else pState = 0xff;   // not a screen: the next tickPanel redraws whichever one is wanted
}

void panelBegin() {
  if (kv_get("/kv/lcdshift", &lcdShift, sizeof lcdShift, nullptr) != MBED_SUCCESS) lcdShift = {LCD_SHIFT_X, 0};
  for (Arduino_Canvas *c : {lineCv, barCv, cardCv}) c->begin(GFX_SKIP_OUTPUT_BEGIN);
  bool ok = lcd->begin(LCD_SPI_HZ);   // write-only bus: true means spi came up, not that a panel answered
  Serial.println(ok ? "LCD begin ok" : "LCD begin failed");
  splash();
  line(160, "BOOTING", F_BIG, C_DIM);
}

void tickPanel() {
  static unsigned long lastTick = 0;
  static uint8_t dots = 0;
  unsigned long now = millis();

  uint8_t want = !bleConnected ? PS_PAIR : now - connectAt < HELLO_MS ? PS_HELLO : PS_INFO;
  if (lcdFrame) return;   // test pattern holds until `lcd,x,y,0`
  if (want != pState) { enterScreen(want); lastTick = 0; }

  if (pState == PS_PAIR) {
    if (now - lastTick < PAIR_DOTS_MS) return;
    lastTick = now;
    char s[] = "PAIRING...";
    s[7 + dots] = 0;
    dots = (dots + 1) % 4;
    line(160, s, F_BIG, C_WARN, "PAIRING...");   // centred on the full width, so the word doesn't slide
    return;
  }
  if (pState != PS_INFO || now - lastTick < INFO_REFRESH_MS) return;
  lastTick = now;

  for (uint8_t i = 0; i < SEN_N; i++) {
    char v[12];
    uint8_t lvl = senValue(i, v);   // level follows the text, so the text alone says when to redraw
    if (strcmp(v, shownSen[i])) { strcpy(shownSen[i], v); drawCard(i, v, lvl); }
  }
  uint8_t lvl = hudLevel == "ok" ? 1 : hudLevel == "warn" ? 2 : hudLevel == "bad" ? 3 : 0;
  bool autoRun = routine || blkPc >= 0;
  if (lvl != shownLvl || autoRun != shownAuto) { shownLvl = lvl; shownAuto = autoRun; drawBar(lvl, autoRun); }
}
