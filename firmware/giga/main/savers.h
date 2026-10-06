// part of main.ino, #included where this section used to be -- order matters
#pragma once

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
