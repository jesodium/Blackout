// bench-only: the giga's real panel faces, on a 4-pin ssd1306 and an uno r4.
//
//   VCC -> 5V      GND -> GND
//   SDA -> A4      SCL -> A5     (same holes as the dedicated SDA/SCL pins by AREF)
//
// no reset pin on a 4-pin module -- the controller uses its own power-on reset,
// so U8X8_PIN_NONE. address is 0x3C unless the back is strapped for 0x3D.
//
// drawStatus/drawFace/drawHud below are COPIED VERBATIM from giga-r1/main/main.ino.
// that is the point of the mockup -- if they drift, this stops being a preview of
// the robot. only the constructor and the fake data at the bottom are local.
// IMPORTANT NOTE: copy, not a shared header. the giga's panel hangs off a custom
// Wire2 byte callback and half of main.ino's globals; extracting it into something
// both sketches include is a refactor of the robot, not of this bench test.
//
// dual-colour panels dye rows 0-15 yellow. nothing here can change that -- the
// tint is on the glass. the giga's own layout puts its title line up there anyway.

#include <U8g2lib.h>
#include <Wire.h>

#define OLED_W 128
#define OLED_H 64
U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE);

bool bleConnected = false;
String hudLevel = "";
String hudMetrics = "";
uint8_t oledFrame = 0;

// ---- everything from here to "fake data" is main.ino's, unchanged ----
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
// ---- end of main.ino's code ----

// fake data: walk the states the robot shows, 4s each, so every face gets seen
// without a dashboard. no ble, no sensors -- the panel is the whole test.
struct Scene { bool conn; const char* level; };
static const Scene SCENES[] = {
  {false, 0},        // pairing
  {true,  0},        // connected splash
  {true,  ""},       // hud, no verdict yet -> STANDBY
  {true,  "ok"},     // SAFE
  {true,  "warn"},   // CAUTION
  {true,  "bad"},    // DANGER
};
#define SCENE_N (sizeof(SCENES) / sizeof(SCENES[0]))
#define SCENE_MS 4000

void setup() {
  Serial.begin(9600);
  Wire.begin();
  // don't touch the panel until it acks: a 1KB write at a device that never
  // answers blocks forever, which reads as a hung sketch.
  while (true) {
    Wire.beginTransmission(0x3C);
    if (Wire.endTransmission() == 0) break;
    Serial.println("no 0x3C on the bus");
    delay(1000);
  }
  oled.begin();
  oled.setContrast(255);
  hudMetrics = "dist 24cm|22.4C 61%|1013 hPa|412 lx";
}

void loop() {
  static unsigned long lastPhase = 0;
  if (millis() - lastPhase >= 120) { lastPhase = millis(); oledFrame++; }

  const Scene& s = SCENES[(millis() / SCENE_MS) % SCENE_N];
  bleConnected = s.conn;

  oled.clearBuffer();
  if (!s.level) drawStatus();
  else { hudLevel = s.level; drawHud(); }
  oled.sendBuffer();
  delay(25);   // same OLED_DRAW_INTERVAL the giga uses
}
