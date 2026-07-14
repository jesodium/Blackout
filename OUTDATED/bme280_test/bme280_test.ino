#include <Wire.h>
#include <Adafruit_BME280.h>

Adafruit_BME280 bme;
bool ok = false;
unsigned long n = 0;

void setup() {
  Serial.begin(9600);
  delay(1500);
  // NOTE: heartbeat prints BEFORE any I2C call, so a hung bus (bad wiring)
  // still shows serial life instead of a silent freeze.
}

void loop() {
  Serial.print("hb "); Serial.println(n++);

  Wire.begin();
  Serial.print("  I2C:");
  for (byte a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) { Serial.print(" 0x"); Serial.print(a, HEX); }
  }
  Serial.println();

  if (!ok) ok = bme.begin(0x76) || bme.begin(0x77);
  if (ok) {
    Serial.print("  T="); Serial.print(bme.readTemperature());
    Serial.print("C H="); Serial.print(bme.readHumidity());
    Serial.print("% P="); Serial.print(bme.readPressure() / 100.0F); Serial.println("hPa");
  } else {
    Serial.println("  BME280 not found");
  }
  delay(1000);
}
