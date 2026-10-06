// part of main.ino, #included where this section used to be -- order matters
#pragma once

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
