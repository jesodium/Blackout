// i2c probe. d20/d21 runs first as a positive control: "nothing on the bus" means
// nothing until the same code has found the bme at 0x76.

#include <Wire.h>

#define SDA2 9
#define SCL2 8
#define SDA1 102
#define SCL1 101

int sSda = SDA2, sScl = SCL2;

static inline void rel(int p) { pinMode(p, INPUT); }
static inline void low(int p) { pinMode(p, OUTPUT); digitalWrite(p, LOW); }
static inline void tick()     { delayMicroseconds(5); }

static void sStart() { rel(sSda); rel(sScl); tick(); low(sSda); tick(); low(sScl); tick(); }
static void sStop()  { low(sSda); tick(); rel(sScl); tick(); rel(sSda); tick(); }

static bool sBit(bool b) {
  b ? rel(sSda) : low(sSda);
  tick(); rel(sScl); tick();

  unsigned long t0 = millis();
  while (digitalRead(sScl) == LOW && millis() - t0 < 5) {}
  bool v = digitalRead(sSda);
  low(sScl); tick();
  return v;
}

static bool sByte(uint8_t b) {
  for (int i = 7; i >= 0; i--) sBit(b & (1 << i));
  bool nack = sBit(1);
  return !nack;
}

static bool sProbe(uint8_t addr) {
  sStart();
  bool ack = sByte(addr << 1);
  sStop();
  return ack;
}

void softSweep(int sda, int scl, const char* name) {
  sSda = sda; sScl = scl;
  Serial.print(name); Serial.print(": ");
  int n = 0;
  for (uint8_t a = 8; a < 120; a++)
    if (sProbe(a)) { Serial.print("0x"); Serial.print(a, HEX); Serial.print(" "); n++; }
  Serial.println(n ? "" : "nothing");
}

void sweep(TwoWire& w, const char* name) {
  Serial.print(name); Serial.print(": ");
  int n = 0;
  for (uint8_t a = 8; a < 120; a++) {
    w.beginTransmission(a);
    if (w.endTransmission() == 0) { Serial.print("0x"); Serial.print(a, HEX); Serial.print(" "); n++; }
  }
  Serial.println(n ? "" : "nothing");
}

// bme280 reg 0xD0 = chip id: 0x60 bme280, 0x58 bmp280, 0x61 bme680.
void chipId(TwoWire& w, uint8_t addr) {
  w.beginTransmission(addr);
  w.write(0xD0);
  if (w.endTransmission(false) != 0) { Serial.println("    (no reg write)"); return; }
  if (w.requestFrom((int)addr, 1) != 1) { Serial.println("    (no reg read)"); return; }
  uint8_t id = w.read();
  Serial.print("    reg 0xD0 = 0x"); Serial.print(id, HEX);
  Serial.println(id == 0x60 ? "  BME280" : id == 0x58 ? "  BMP280" : id == 0x61 ? "  BME680" : "  unknown");
}

void reg(TwoWire& w, uint8_t addr, uint8_t r, const char* what) {
  w.beginTransmission(addr); w.write(r);
  if (w.endTransmission(false) != 0) return;
  if (w.requestFrom((int)addr, 1) != 1) return;
  Serial.print("    reg 0x"); Serial.print(r, HEX);
  Serial.print(" = 0x"); Serial.print(w.read(), HEX);
  Serial.print("   "); Serial.println(what);
}

void lines(int sda, int scl, const char* name) {
  pinMode(sda, INPUT_PULLDOWN); pinMode(scl, INPUT_PULLDOWN);
  delay(5);
  Serial.print("pull-up check "); Serial.print(name);
  Serial.print(": sda="); Serial.print(digitalRead(sda) ? "yes" : "NO");
  Serial.print("  scl=");  Serial.println(digitalRead(scl) ? "yes" : "NO");
}

void integrity(int sda, int scl) {
  pinMode(sda, INPUT); pinMode(scl, INPUT); delay(2);
  Serial.print("  released:  sda="); Serial.print(digitalRead(sda));
  Serial.print(" scl="); Serial.println(digitalRead(scl));

  pinMode(sda, OUTPUT); digitalWrite(sda, LOW); delay(2);
  Serial.print("  sda low:     sda="); Serial.print(digitalRead(sda));
  Serial.print(" scl="); Serial.print(digitalRead(scl));
  Serial.println(digitalRead(scl) ? "  ok (independent)" : "  SHORTED to sda");
  pinMode(sda, INPUT); delay(2);

  pinMode(scl, OUTPUT); digitalWrite(scl, LOW); delay(2);
  Serial.print("  scl low:   scl="); Serial.print(digitalRead(scl));
  Serial.print(" sda="); Serial.print(digitalRead(sda));
  Serial.println(digitalRead(sda) ? "  ok (independent)" : "  SHORTED to scl");
  pinMode(scl, INPUT); delay(2);

  Serial.print("  recovered: sda="); Serial.print(digitalRead(sda));
  Serial.print(" scl="); Serial.println(digitalRead(scl));
}

void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 3000);
  Wire1.begin();
}

TwoWire& w1 = Wire1;

void loop() {
  Serial.println("\n--- i2c scan ---");
  lines(20, 21, "CONTROL (d20/d21)");
  lines(SDA2, SCL2, "TEST (d9/d8)");
  lines(SDA1, SCL1, "ALT1 (d102/d101)");
  Serial.println("integrity CONTROL (d20/d21, known-good bus):");
  integrity(20, 21);
  Serial.println("integrity TEST (d9/d8):");
  integrity(SDA2, SCL2);
  softSweep(20, 21, "soft CONTROL (d20 sda / d21 scl)");
  softSweep(21, 20, "soft CONTROL swapped (d21 sda / d20 scl)");
  softSweep(SDA2, SCL2, "soft TEST    (d9 sda / d8 scl)");
  softSweep(SDA1, SCL1, "soft ALT1    (d102 sda1 / d101 scl1)");
  softSweep(SCL1, SDA1, "soft ALT1 swapped (d101 sda / d102 scl)");
  sweep(Wire1, "hw   ALT1    (Wire1)");
  for (uint8_t a : {0x60, 0x76, 0x77}) {
    Serial.print("  id probe 0x"); Serial.println(a, HEX);
    chipId(Wire1, a);
    reg(Wire1, a, 0x0C, "WHO_AM_I (mpl3115a2 = 0xC4)");
    reg(Wire1, a, 0x00, "reg 0x00");
    Serial.print("    dump 0x00-0x0F:");
    for (uint8_t r = 0; r < 0x10; r++) {
      w1.beginTransmission(a); w1.write(r);
      if (w1.endTransmission(false) != 0) { Serial.print(" --"); continue; }
      if (w1.requestFrom((int)a, 1) != 1) { Serial.print(" --"); continue; }
      uint8_t v = w1.read();
      Serial.print(v < 16 ? " 0" : " "); Serial.print(v, HEX);
    }
    Serial.println();
  }
  delay(1500);
}
