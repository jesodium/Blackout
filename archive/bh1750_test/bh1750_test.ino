// GY-302 (BH1750) on hardware I2C. Mega: SDA D20 / SCL D21. Uno R4: SDA A4 / SCL A5.
// Raw Wire, no library - the whole protocol is one command byte.
#include <Wire.h>

#define ADDR 0x23        // ADDR pin low/floating; 0x5C if tied high
#define CONT_HIRES 0x10  // continuous high-res, 1 lx, ~120ms per conversion

void setup() {
  Serial.begin(9600);
  delay(1500);

  // Idle bus must float HIGH. A pin stuck LOW is a short or a swapped pair,
  // and is what hangs Wire before it ever gets to talk.
  pinMode(SDA, INPUT); pinMode(SCL, INPUT);
  Serial.print("idle SDA(pin "); Serial.print(SDA); Serial.print(")=");
  Serial.print(digitalRead(SDA));
  Serial.print("  SCL(pin "); Serial.print(SCL); Serial.print(")=");
  Serial.println(digitalRead(SCL));

  Wire.begin();
#ifdef ARDUINO_ARCH_AVR
  Wire.setWireTimeout(25000, true);  // AVR Wire blocks forever on a held-low bus
#endif

  Serial.print("scan:");
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) { Serial.print(" 0x"); Serial.print(a, HEX); }
  }
  Serial.println();

  Wire.beginTransmission(ADDR);
  Wire.write(CONT_HIRES);
  if (Wire.endTransmission() != 0) Serial.println("no ack from 0x23 - check SDA/SCL/power");
  delay(200);
}

void loop() {
  if (Wire.requestFrom(ADDR, 2) != 2) {
    Serial.println("BH1750 read fail - no device on 0x23");
  } else {
    uint16_t raw = (Wire.read() << 8) | Wire.read();
    Serial.print(raw / 1.2);  // datasheet scale factor
    Serial.println(" lx");
  }
  delay(500);
}
