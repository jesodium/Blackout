// bench-only, like motor_test/ — proves the oled can flip frames fast enough to
// read as "video". not part of the real build. loops a 64x128 1-bit clip
// (760 frames = the whole 25s serial-killer meme, 760KB flash) packed by
// pack_xbm.py next door:
//   python3 pack_xbm.py <video.mp4> video_frames.h 30 64 128 0.60
// frames are extracted at the source's own 30fps; FRAME_US below is the playback
// pace, so a smaller value fast-forwards. serial prints the rate actually achieved.
// IMPORTANT NOTE: 1KB/frame is the hard wall either way round — ~25s at 30fps or
// ~12s at 60fps. longer clips mean fewer fps or an RLE decoder, not more flash.
#include <U8g2lib.h>
#include "video_frames.h"

// same pins as main.ino — these moved to the double-row header in dbb4bb6
#define OLED_CLK 28
#define OLED_DATA 26
#define OLED_RST 24
#define OLED_DC 22
U8G2_SSD1306_128X64_NONAME_F_4W_SW_SPI oled(U8G2_R0, /* clock=*/ OLED_CLK, /* data=*/ OLED_DATA, /* cs=*/ U8X8_PIN_NONE, /* dc=*/ OLED_DC, /* reset=*/ OLED_RST);

const uint32_t FRAME_US = 33333; // 30fps — bit-banged spi is the real ceiling, see serial

void setup() {
  Serial.begin(115200);
  oled.begin();
  oled.setDisplayRotation(U8G2_R1); // portrait 64x128 — the source is a pillarboxed vertical video
}

void loop() {
  unsigned long start = millis();
  uint32_t next = micros();
  for (uint16_t i = 0; i < VIDEO_FRAME_COUNT; i++) {
    oled.clearBuffer();
    oled.drawXBMP(0, 0, VIDEO_FRAME_W, VIDEO_FRAME_H, video_frames[i]);
    oled.sendBuffer();
    next += FRAME_US;
    if ((int32_t)(next - micros()) > 0) delayMicroseconds(next - micros()); // deadline pace: drop the wait when spi is the bottleneck
  }
  Serial.println(VIDEO_FRAME_COUNT * 1000UL / (millis() - start)); // actual fps for the pass
}
