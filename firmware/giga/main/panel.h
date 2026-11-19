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
// Touch (XPT2046) is not on J11 and not used.
#define LCD_DC 1
#define LCD_CS 10
#define LCD_SPI_HZ 20000000
#define PAIR_DOTS_MS 400
#define INFO_REFRESH_MS 250

extern int blkPc;   // vm.h, included after this

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

#define C_BG    RGB565(0, 0, 0)
#define C_CARD  RGB565(24, 28, 32)
#define C_DIM   RGB565(120, 128, 136)
#define C_TEXT  RGB565(240, 240, 240)
#define C_GO    RGB565(40, 220, 100)
#define C_WARN  RGB565(255, 170, 0)
#define C_BAD   RGB565(240, 40, 40)

// one canvas per widget shape, all drawn at (0,0) and blitted wherever they belong
#define LINE_W 320
#define LINE_H 48
#define BAR_H 48
#define CARD_W 150
#define CARD_H 98
Arduino_Canvas *lineCv = new Arduino_Canvas(LINE_W, LINE_H, nullptr);   // centred text lines
Arduino_Canvas *barCv  = new Arduino_Canvas(480, BAR_H, nullptr);       // header and hud bar
Arduino_Canvas *cardCv = new Arduino_Canvas(CARD_W, CARD_H, nullptr);   // one sensor card

void blit(Arduino_Canvas *c, int16_t x, int16_t y) {
  lcd->draw16bitRGBBitmap(x, y, c->getFramebuffer(), c->width(), c->height());
  blePump();
}

void cvText(Arduino_GFX *c, int16_t x, int16_t y, const char *s, uint8_t size, uint16_t fg) {
  c->setTextSize(size);
  c->setTextColor(fg);
  c->setCursor(x, y);
  c->print(s);
}

void line(int16_t y, const char *s, uint8_t size, uint16_t fg) {
  lineCv->fillScreen(C_BG);
  cvText(lineCv, (LINE_W - (int)strlen(s) * 6 * size) / 2, (LINE_H - 8 * size) / 2, s, size, fg);
  blit(lineCv, (480 - LINE_W) / 2, y);
}

void clearScreen() {
  for (int16_t y = 0; y < 320; y += 32) { lcd->fillRect(0, y, 480, 32, C_BG); blePump(); }
}

void splash() {
  clearScreen();
  line(80, "BLACKOUT", 6, C_TEXT);
  line(240, BOARD_NAME, 2, C_DIM);
}

// ---- info screen ----
#define SEN_N 6
static const char *SEN_NAME[SEN_N] = {"TEMP", "HUMID", "DIST", "PRESS", "LIGHT", "GAS"};
static const char *SEN_UNIT[SEN_N] = {"C", "%", "cm", "hPa", "lx", "/100"};
char shownSen[SEN_N][8];
int8_t shownLvl = -1, shownAuto = -1;

void senValue(uint8_t i, char *out) {
  bool ok = true;
  int v = 0;
  switch (i) {
    case 0: v = temp; break;
    case 1: v = humid; break;
    case 2: ok = distCm < 999; v = distCm; break;
    case 3: ok = bmeOk; v = pressure; break;
    case 4: ok = luxOk; v = lux; break;
    case 5: ok = gasIdx > 0; v = gasIdx; break;
  }
  if (ok) snprintf(out, 8, "%d", v); else strcpy(out, "--");
}

void drawCard(uint8_t i, const char *v) {
  cardCv->fillScreen(C_BG);
  cardCv->fillRoundRect(0, 0, CARD_W, CARD_H, 8, C_CARD);
  cvText(cardCv, 12, 12, SEN_NAME[i], 2, C_DIM);
  cvText(cardCv, CARD_W - 12 - strlen(SEN_UNIT[i]) * 12, 12, SEN_UNIT[i], 2, C_DIM);
  cvText(cardCv, 12, 48, v, 4, strcmp(v, "--") ? C_TEXT : C_DIM);
  blit(cardCv, 8 + (i % 3) * 158, 56 + (i / 3) * 104);
}

void drawHeader() {
  barCv->fillScreen(C_CARD);
  cvText(barCv, 14, 12, "BLACKOUT", 3, C_TEXT);
  barCv->fillRoundRect(330, 10, 136, 28, 14, C_GO);
  cvText(barCv, 398 - 6 * 6, 17, "LINKED", 2, C_BG);
  blit(barCv, 0, 0);
}

void drawBar(uint8_t lvl, bool autoRun) {
  static const char *LBL[] = {"STANDBY", "SAFE", "CAUTION", "DANGER"};
  static const uint16_t COL[] = {C_CARD, C_GO, C_WARN, C_BAD};
  uint16_t fg = lvl ? C_BG : C_TEXT;
  barCv->fillScreen(COL[lvl]);
  cvText(barCv, 14, 12, LBL[lvl], 3, fg);
  if (autoRun) cvText(barCv, 480 - 14 - 8 * 18, 12, "AUTO RUN", 3, fg);
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
    line(110, "CONNECTED", 5, C_GO);
    line(240, BOARD_NAME, 2, C_DIM);
    return;
  }
  drawHeader();
  for (uint8_t i = 0; i < SEN_N; i++) shownSen[i][0] = 0;
  shownLvl = shownAuto = -1;
}

void panelBegin() {
  for (Arduino_Canvas *c : {lineCv, barCv, cardCv}) c->begin(GFX_SKIP_OUTPUT_BEGIN);
  bool ok = lcd->begin(LCD_SPI_HZ);   // write-only bus: true means spi came up, not that a panel answered
  Serial.println(ok ? "LCD begin ok" : "LCD begin failed");
  splash();
  line(160, "BOOTING", 4, C_DIM);
}

void tickPanel() {
  static unsigned long lastTick = 0;
  static uint8_t dots = 0;
  unsigned long now = millis();

  uint8_t want = !bleConnected ? PS_PAIR : now - connectAt < HELLO_MS ? PS_HELLO : PS_INFO;
  if (want != pState) { enterScreen(want); lastTick = 0; }

  if (pState == PS_PAIR) {
    if (now - lastTick < PAIR_DOTS_MS) return;
    lastTick = now;
    char s[] = "PAIRING   ";              // fixed length, so the word doesn't slide as dots grow
    for (uint8_t i = 0; i < dots; i++) s[7 + i] = '.';
    dots = (dots + 1) % 4;
    line(160, s, 4, C_WARN);
    return;
  }
  if (pState != PS_INFO || now - lastTick < INFO_REFRESH_MS) return;
  lastTick = now;

  for (uint8_t i = 0; i < SEN_N; i++) {
    char v[8];
    senValue(i, v);
    if (strcmp(v, shownSen[i])) { strcpy(shownSen[i], v); drawCard(i, v); }
  }
  uint8_t lvl = hudLevel == "ok" ? 1 : hudLevel == "warn" ? 2 : hudLevel == "bad" ? 3 : 0;
  bool autoRun = routine || blkPc >= 0;
  if (lvl != shownLvl || autoRun != shownAuto) { shownLvl = lvl; shownAuto = autoRun; drawBar(lvl, autoRun); }
}
