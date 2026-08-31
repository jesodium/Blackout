// i2c probe. d20/d21 runs first as a positive control: "nothing on the bus" means
// nothing until the same code has found the bme at 0x76.

#include <Wire.h>

#define SDA2 9
#define SCL2 8

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
}

void loop() {
  Serial.println("\n--- i2c scan ---");
  lines(20, 21, "CONTROL (d20/d21)");
  lines(SDA2, SCL2, "TEST (d9/d8)");
  Serial.println("integrity CONTROL (d20/d21, known-good bus):");
  integrity(20, 21);
  Serial.println("integrity TEST (d9/d8):");
  integrity(SDA2, SCL2);
  softSweep(20, 21, "soft CONTROL (d20 sda / d21 scl)");
  softSweep(21, 20, "soft CONTROL swapped (d21 sda / d20 scl)");
  softSweep(SDA2, SCL2, "soft TEST    (d9 sda / d8 scl)");
  delay(1500);
}
