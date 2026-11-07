#include <Arduino_GFX_Library.h>

#ifdef ARDUINO_GIGA
// same pins as shield j11, reset tied to 3v3 so panel resets in software
Arduino_DataBus *bus = new Arduino_HWSPI(1 /*dc*/, 10 /*cs*/, &SPI1);
Arduino_GFX *gfx = new Arduino_ILI9488_18bit(bus, GFX_NOT_DEFINED, 1 /*rotation*/);
#else
// esp32 devkit bench test
Arduino_DataBus *bus = new Arduino_HWSPI(27 /*dc*/, 5 /*cs*/, 18 /*sck*/, 23 /*mosi*/, GFX_NOT_DEFINED);
Arduino_GFX *gfx = new Arduino_ILI9488_18bit(bus, 4 /*rst*/, 1 /*rotation*/);
#endif

void setup() {
  Serial.begin(115200);
  bool ok = gfx->begin(20000000); // drop to 10000000 if image glitches on long wires
  Serial.println(ok ? "lcd begin ok" : "lcd begin failed");
}

void loop() {
  uint16_t colors[] = {RGB565_RED, RGB565_GREEN, RGB565_BLUE, RGB565_WHITE};
  for (uint16_t c : colors) {
    uint32_t t = millis();
    gfx->fillScreen(c);
    Serial.println(millis() - t);
    delay(700);
  }
  gfx->fillScreen(RGB565_BLACK);
  gfx->drawRect(0, 0, gfx->width(), gfx->height(), RGB565_WHITE);
  gfx->setTextColor(RGB565_WHITE);
  gfx->setTextSize(4);
  gfx->setCursor(100, 130);
  gfx->print("BLACKOUT");
  gfx->setTextSize(2);
  gfx->setCursor(100, 180);
  gfx->print(gfx->width());
  gfx->print(" x ");
  gfx->print(gfx->height());
  delay(2000);
}
