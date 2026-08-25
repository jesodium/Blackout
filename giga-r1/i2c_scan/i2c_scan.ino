// bench-only. splits "mbed Wire2 can't drive these pins" from "the wiring is bad".
// Wire (d20/d21) sweep is the control — it must find the bme at 0x76, which proves
// the scan logic itself. then the same sweep on d8/d9 bit-banged by hand.
// IMPORTANT NOTE: soft-i2c is a DIAGNOSTIC only. it is slow and has no arbitration
// — if it turns out to be the only thing that works, move the sensor to a real bus
// rather than shipping this.
#include <Wire.h>

#define SDA2 9  // d9
#define SCL2 8  // d8
// the bit-bang runs on whichever pair is loaded here, so it can be pointed at the
// bme's bus as a positive control — "nothing" only means something once the same
// code has found 0x76 on d20/d21.
int sSda = SDA2, sScl = SCL2;

// open-drain by hand: release = INPUT (the bus pull-up lifts it), drive = OUTPUT LOW.
// never drive a line high — that's what makes it a bus.
static inline void rel(int p) { pinMode(p, INPUT); }
static inline void low(int p) { pinMode(p, OUTPUT); digitalWrite(p, LOW); }
static inline void tick()     { delayMicroseconds(5); } // ~100kHz

static void sStart() { rel(sSda); rel(sScl); tick(); low(sSda); tick(); low(sScl); tick(); }
static void sStop()  { low(sSda); tick(); rel(sScl); tick(); rel(sSda); tick(); }

static bool sBit(bool b) {          // write one bit, return the line we clocked out
  b ? rel(sSda) : low(sSda);
  tick(); rel(sScl); tick();
  // clock stretching: a slave may hold scl low until it's ready
  unsigned long t0 = millis();
  while (digitalRead(sScl) == LOW && millis() - t0 < 5) {}
  bool v = digitalRead(sSda);
  low(sScl); tick();
  return v;
}

// returns true if the slave pulled sda low on the 9th clock = ack
static bool sByte(uint8_t b) {
  for (int i = 7; i >= 0; i--) sBit(b & (1 << i));
  bool nack = sBit(1);              // release sda, let the slave answer
  return !nack;
}

static bool sProbe(uint8_t addr) {
  sStart();
  bool ack = sByte(addr << 1);      // write bit
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

// idle-state probe. a bare INPUT floats HIGH on the giga so it proves nothing;
// INPUT_PULLDOWN does — internal pulldown is ~40k, a bus pull-up is 4k7-10k.
void lines() {
  pinMode(SDA2, INPUT_PULLDOWN); pinMode(SCL2, INPUT_PULLDOWN);
  delay(5);
  Serial.print("pull-up check: sda(d9)="); Serial.print(digitalRead(SDA2) ? "yes" : "NO");
  Serial.print("  scl(d8)=");              Serial.println(digitalRead(SCL2) ? "yes" : "NO");
}

// drive each line low on its own and watch the other. they must move independently:
// if pulling sda also drags scl (or vice versa) the two are shorted somewhere, which
// nacks every address forever while both lines still read "pull-up present".
// also checks each line can actually be pulled to 0 and released back to 1 — a line
// that won't rise has a dead pull-up, one that won't fall is shorted to 3v3.
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
  // no Wire.begin(): the soft control drives d20/d21 by hand, and the hw peripheral
  // owning those pins at the same time is what wedged the board earlier.
}

void loop() {
  Serial.println("\n--- i2c scan ---");
  lines();
  Serial.println("integrity CONTROL (d20/d21, known-good bus):");
  integrity(20, 21);
  Serial.println("integrity TEST (d9/d8):");
  integrity(SDA2, SCL2);
  softSweep(20, 21, "soft CONTROL (d20 sda / d21 scl)"); // must find 0x76
  softSweep(SDA2, SCL2, "soft TEST    (d9 sda / d8 scl)"); // want 0x23
  delay(1500);
}
