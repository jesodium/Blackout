// bench-only, like motor_test/ — proves the oled can flip frames fast enough to
// read as "video". not part of the real build. loops a 128x64 1-bit clip
// packed by scratchpad/pack_xbm.py (ffmpeg -> pbm -> xbm bytes).
#include <U8g2lib.h>
#include "video_frames.h"

#define OLED_CLK 13
#define OLED_DATA 11
#define OLED_RST A0
#define OLED_DC A1
U8G2_SSD1306_128X64_NONAME_F_4W_SW_SPI oled(U8G2_R0, /* clock=*/ OLED_CLK, /* data=*/ OLED_DATA, /* cs=*/ U8X8_PIN_NONE, /* dc=*/ OLED_DC, /* reset=*/ OLED_RST);

const uint16_t FRAME_MS = 125; // 8fps, matches pack_xbm.py's extraction rate

void setup() {
  oled.begin();
  oled.setDisplayRotation(U8G2_R1); // panel's mounted portrait; try U8G2_R3 if this comes out upside-down
}

void loop() {
  for (uint16_t i = 0; i < VIDEO_FRAME_COUNT; i++) {
    oled.clearBuffer();
    oled.drawXBMP(0, 0, VIDEO_FRAME_W, VIDEO_FRAME_H, video_frames[i]);
    oled.sendBuffer();
    delay(FRAME_MS);
  }
}
