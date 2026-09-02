// HW-170 / PCA9685 bench test — 5-DOF arm, on an Uno R4.
//   ch6 base, ch5 shoulder, ch4 elbow, ch3 wrist, ch12 gripwrist, ch1 gripper
//   ALL SIX ARE 360 (continuous rotation). ch2 is unused.
//   ch12 is untested — it did not respond on ch2 either, so it may be the
//   servo and not the channel. Type is a guess: cont, because cont gets the
//   deadman and positional does not.
//   WRONG cont FLAG = A JOINT THAT NEVER STOPS: an angle sent to a 360 is
//   full speed, and only cont channels get the deadman. Check with t<ch>.
//
// A 360 in an arm joint has NO position feedback and NO end stop, so there is
// no "go to 45deg" — only "move while somebody is holding the button". Every
// continuous channel therefore runs on a short deadman: the browser repeats the
// command while held, and silence stops the joint in JOG_MS. That is the whole
// reason there is no demo mode any more — an unattended arm joint winds itself
// into its own frame.
//
// Serial 9600, one command per line:
//   <ch>:<val>   360 -> speed -100..100 (repeat to keep moving), sg90 -> angle 0..180
//   s            stop everything (kills the pulse, never just a neutral)
//
// WIRE OE (HW-170) TO D8. It is the only stop that works when the bus is down:
// a stalled servo drags the rail, the PCA9685 browns out, i2c dies, and every
// software stop is then talking to nothing while the chip keeps driving its
// last registers. OE is active-low output-enable straight into the chip's
// output stage — high kills all 16 channels with no bus involved. Unwired, the
// board's own pull-down leaves outputs on and everything below is a no-op.
//   v            build stamp
//   t<ch>        identify: one short nudge. positional servo steps and holds;
//                a 360 keeps creeping. that is how you tell them apart.
//   n<ch>:<us>   trim a 360's neutral
//   ?            dump every joint's live neutral (the page's copy is only a
//                guess — trims live on the board and a reload loses them)
//   T            sweep all 16 channels, one nudge each, printing the channel
//                first — the way to find a servo after a re-plug
//   t<ch>        nudge one channel, listed in sv[] or not
//   r            reboot back to the sv[] defaults, when a trim session has
//                wandered and you want a known state
// V+ IS THE SERVO RAIL, 6V MAX. VCC is logic. Never 12V on V+.
#include <Wire.h>

#define ADDR 0x40      // A0-A5 solder jumpers all open
#define MODE1 0x00
#define PRESCALE 0xFE
#define LED0_ON_L 0x06
// Full speed = neutral +/- this. 500 is the nominal 1000-2000us range; 700
// pushes to ~800-2200, which most 360s take as "harder still" — the base
// carries the whole arm and had nothing left at 500 (2026-08-25). If a servo
// buzzes or heats at rest instead of turning faster, it has saturated: put
// this back to 500 rather than chasing it higher.
#define SPAN_US 700
                       // Do not shrink it: a 360 has a deadband of 100us or
                       // more around its real (off-centre) neutral, so a small
                       // offset gets swallowed on one side only — which reads
                       // as "it moves one way but not the other".
#define ANG_MIN 500
#define ANG_MAX 2500
#define JOG_MS 800     // a held 360 dies this long after the last command
#define ID_MS 400      // 't' nudge length

// neutral is per-servo and MEASURED, not nominal — trim with 'n<ch>:<us>' until
// the joint sits still, then write the number here so a reflash keeps it.
// base: 1490, found on the bench 2026-08-24. shoulder/elbow still nominal.
struct Joint { uint8_t ch; bool cont; int neutral; const char* name; };
// Wiring as identified 2026-08-27, one channel at a time. ch11 is typed 360
// (jog), not sg90: whatever is on it now runs continuously on an angle command
// and never stops, which is either a real 360 or the original sg90 with its pot
// stripped (it was stalled to death against the jaws). Positional channels get
// no deadman in apply(), so a positional ch11 ran until STOP ALL — as cont it
// gets JOG_MS like every other joint. Retype it false the day a healthy sg90
// goes back on, and re-trim the neutral: no end stop means no clamp force, only
// "run the jaws until you let go".
Joint sv[] = {
  { 6,  true,  1490, "base"     },   // neutral measured 2026-08-24 on this servo
  { 5,  true,  1500, "shoulder" },   // untrimmed
  { 4,  true,  1500, "elbow"    },   // untrimmed
  { 3,  true,  1500, "wrist"    },   // untrimmed — 360, not an sg90
  { 12, true,  1500, "gripwrist"},   // added 2026-08-31, unconfirmed — see above
  { 1,  true,  1500, "gripper"  },   // 360/stripped pot, see above — untrimmed
};
const uint8_t NSV = sizeof(sv) / sizeof(sv[0]);

unsigned long lastCmd[NSV];   // 0 = not moving
unsigned long idUntil = 0;
int idIdx = -1;

// False once the bus is found stuck. Every Wire call is gated on it: an
// unpowered PCA9685 clamps SDA low through its protection diodes, no amount of
// clocking frees that, and endTransmission() then blocks forever — which is
// what made a live board look bricked (and unflashable) all of 2026-08-25.
// Better to boot, say so, and stay reachable.
bool i2cOk = true;

#define OE_PIN 8              // HW-170 OE. Active low: HIGH = all 16 channels off.
void outputs(bool on) { digitalWrite(OE_PIN, on ? LOW : HIGH); }

void wr(uint8_t r, uint8_t v) {
  if (!i2cOk) return;
  Wire.beginTransmission(ADDR); Wire.write(r); Wire.write(v); Wire.endTransmission();
}

void setFreq(float hz) {
  uint8_t pre = (uint8_t)(25000000.0 / (4096 * hz) + 0.5) - 1;  // 50Hz -> 121
  wr(MODE1, 0x10);              // sleep: prescale is write-only while asleep
  wr(PRESCALE, pre);
  wr(MODE1, 0x00);
  delayMicroseconds(500);
  wr(MODE1, 0xA1);              // restart + auto-increment
}

void setUs(uint8_t c, uint16_t us) {
  if (!i2cOk) return;
  uint16_t off = (uint32_t)us * 4096 / 20000;   // 4.88us per count at 50Hz
  Wire.beginTransmission(ADDR);
  Wire.write(LED0_ON_L + 4 * c);
  Wire.write(0); Wire.write(0);                 // on at count 0
  Wire.write(off & 0xFF); Wire.write(off >> 8);
  Wire.endTransmission();
}

// Kill the pulse (LEDn_OFF_H bit 4 = full-off). THIS is what stop means for a
// 360: a neutral pulse is still a command and an untrimmed one creeps on it
// forever. The PCA9685 also holds its last registers while the Arduino reboots,
// so setup() must blank all 16 channels before anything else.
void off(uint8_t c) {
  if (!i2cOk) return;
  Wire.beginTransmission(ADDR);
  Wire.write(LED0_ON_L + 4 * c);
  Wire.write(0); Wire.write(0);
  Wire.write(0); Wire.write(0x10);
  Wire.endTransmission();
}

int find(int ch) {
  for (uint8_t i = 0; i < NSV; i++) if (sv[i].ch == ch) return i;
  return -1;
}

void apply(uint8_t i, int v) {
  outputs(true);                // a stop latches OE off; moving again lifts it
  if (sv[i].cont) {
    if (v == 0) { off(sv[i].ch); lastCmd[i] = 0; return; }
    setUs(sv[i].ch, sv[i].neutral + (long)constrain(v, -100, 100) * SPAN_US / 100);
    lastCmd[i] = millis();
  } else {
    setUs(sv[i].ch, map(constrain(v, 0, 180), 0, 180, ANG_MIN, ANG_MAX));
  }
}

// One nudge on a channel of unknown type. FULL power both ways, because on
// this rig a gentle pulse is a weak one: 300us off neutral moved an unloaded
// sg90 and nothing else, so four plugged-in joints identified as "nothing"
// (2026-08-27). Out and back leaves the joint roughly where it started, and a
// joint that is stuck against a bind one way still shows on the other.
void nudgeRaw(uint8_t c) {
  outputs(true);
  setUs(c, 2200); delay(ID_MS);
  setUs(c, 800);  delay(ID_MS);
  off(c);
}

void allStop() {
  outputs(false);               // first: works even with the bus dead
  for (uint8_t c = 0; c < 16; c++) off(c);
  for (uint8_t i = 0; i < NSV; i++) lastCmd[i] = 0;
  idIdx = -1;
}

// A browned-out PCA9685 clamps SDA low, and then every Wire call blocks
// forever — the board goes silent from boot with USB still enumerated, looking
// bricked, while the chip keeps driving whatever pulse it had last. Clocking
// SCL lets the stuck slave finish its byte and release the bus, so a sag costs
// a reset instead of an unplug. Cheap enough to do on every boot.
void i2cUnstick() {
  pinMode(SCL, INPUT_PULLUP);
  pinMode(SDA, INPUT_PULLUP);
  if (digitalRead(SDA) == HIGH) return;   // bus is fine
  for (uint8_t i = 0; i < 9 && digitalRead(SDA) == LOW; i++) {
    pinMode(SCL, OUTPUT); digitalWrite(SCL, LOW);
    delayMicroseconds(5);
    pinMode(SCL, INPUT_PULLUP);           // let the pull-up do the rise
    delayMicroseconds(5);
  }
  // stop condition, so the slave's state machine is back at idle
  pinMode(SDA, OUTPUT); digitalWrite(SDA, LOW);
  delayMicroseconds(5);
  pinMode(SDA, INPUT_PULLUP);
  delayMicroseconds(5);
  i2cOk = (digitalRead(SDA) == HIGH && digitalRead(SCL) == HIGH);
}

void setup() {
  // Before anything: the PCA9685 keeps driving its last pulse across an
  // Arduino reset, so a reset mid-move otherwise means a joint that never
  // stopped. OE high is the first instruction that runs.
  pinMode(OE_PIN, OUTPUT); outputs(false);
  Serial.begin(9600);
  i2cUnstick();
  Wire.begin();
  while (!Serial && millis() < 3000);

  setFreq(50);
  allStop();                    // before the banner: silence first, talk later
  outputs(true);                // registers are all off now, safe to enable

  if (!i2cOk) {
    Serial.println(F("!! i2c bus held low — PCA9685 has no power, or no common GND."));
    Serial.println(F("   check VCC (5V, logic) and V+ (servo rail). reset once fixed."));
  }
  Serial.println(F("i2c scan:"));
  bool found = i2cOk ? false : (Serial.println(F("  skipped, bus stuck")), true);
  for (uint8_t a = 1; i2cOk && a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) { Serial.print(F("  0x")); Serial.println(a, HEX); found = true; }
  }
  if (!found) Serial.println(F("  nothing. check SDA/SCL, VCC, and common GND."));

  for (uint8_t i = 0; i < NSV; i++) {
    Serial.print(F("  ch")); Serial.print(sv[i].ch); Serial.print(' ');
    Serial.print(sv[i].name); Serial.println(sv[i].cont ? F(" (360, jog)") : F(" (180, angle)"));
  }
  Serial.print(F("build ")); Serial.print(F(__DATE__)); Serial.print(' '); Serial.println(F(__TIME__));
  Serial.println(F("idle, no pulse anywhere. 360s stop 0.8s after the last command."));
}

void handle(String ln) {
  ln.trim();
  if (!ln.length()) return;
  if (ln == "s" || ln == "S") { allStop(); Serial.println(F("stop")); return; }
  if (ln == "v" || ln == "V") {
    Serial.print(F("build ")); Serial.print(F(__DATE__)); Serial.print(' '); Serial.println(F(__TIME__));
    // the boot banner scrolls past before a client attaches; 'v' is the one
    // command anyone types when things look wrong, so it carries the bus state.
    Serial.print(F("OE ")); Serial.println(digitalRead(OE_PIN) ? F("HIGH (outputs off)") : F("LOW (outputs live)"));
    Serial.println(i2cOk ? F("i2c ok") : F("i2c STUCK — no pulses going out. check VCC/V+/GND, then reset"));
    return;
  }
  // Read the chip's own registers back. "no sound from the servo" cannot tell
  // a dead output from a dead lead, and every other test needs a plug pulled.
  // MODE1 bit4 = SLEEP: a browned-out PCA9685 comes back asleep and emits
  // nothing while still ACKing its address, so 'i2c ok' stays true and every
  // channel goes quiet at once.
  if (ln[0] == 'd' || ln[0] == 'D') {
    if (!i2cOk) { Serial.println(F("i2c stuck, nothing to read")); return; }
    int ch = constrain(ln.substring(1).toInt(), 0, 15);
    Wire.beginTransmission(ADDR); Wire.write(MODE1);
    Wire.endTransmission(false);
    Wire.requestFrom(ADDR, 1);
    uint8_t m1 = Wire.available() ? Wire.read() : 0xFF;
    Wire.beginTransmission(ADDR); Wire.write(LED0_ON_L + 4 * ch);
    Wire.endTransmission(false);
    Wire.requestFrom(ADDR, 4);
    uint8_t r[4] = {0xFF, 0xFF, 0xFF, 0xFF};
    for (uint8_t i = 0; i < 4 && Wire.available(); i++) r[i] = Wire.read();
    uint16_t offc = ((uint16_t)(r[3] & 0x0F) << 8) | r[2];
    Serial.print(F("MODE1 0x")); Serial.print(m1, HEX);
    Serial.println(m1 & 0x10 ? F("  SLEEP SET — no pwm on any channel") : F("  awake"));
    Serial.print(F("ch")); Serial.print(ch);
    Serial.print(F(" off=")); Serial.print(offc);
    Serial.print(F(" (")); Serial.print((uint32_t)offc * 20000 / 4096); Serial.print(F("us)"));
    Serial.println(r[3] & 0x10 ? F("  FULL-OFF — pulse killed") : F("  driving"));
    Serial.print(F("OE ")); Serial.println(digitalRead(OE_PIN) ? F("HIGH (all off)") : F("LOW (live)"));
    return;
  }
  if (ln == "?") {
    for (uint8_t i = 0; i < NSV; i++) {
      Serial.print(F("  ch")); Serial.print(sv[i].ch); Serial.print(' ');
      Serial.print(sv[i].name);
      if (sv[i].cont) { Serial.print(F("  neutral ")); Serial.print(sv[i].neutral); Serial.println(F("us")); }
      else Serial.println(F("  sg90"));
    }
    return;
  }
  if (ln == "r" || ln == "R") { Serial.println(F("reboot")); Serial.flush(); NVIC_SystemReset(); }
  // Sweep every channel, not just the five in sv[]. After a re-plug a servo
  // can sit on a channel no table knows about, and then 't' reports "no joint"
  // for the one thing you are trying to find.
  if (ln == "T") {
    for (uint8_t c = 0; c < 16; c++) {
      Serial.print(F("ch ")); Serial.print(c); Serial.println(F(" ..."));
      Serial.flush();
      nudgeRaw(c);
      delay(900);           // long enough to see which joint it was
    }
    allStop();
    Serial.println(F("sweep done"));
    return;
  }
  if (ln[0] == 't' || ln[0] == 'T') {
    int ch = ln.substring(1).toInt();
    int i = find(ch);
    if (i < 0) {
      // Unlisted channel: type is unknown, so use the pulse that is safe for
      // both — a 360 turns, an sg90 swings to ~117deg, neither runs away.
      if (ch < 0 || ch > 15) { Serial.println(F("? channel 0-15")); return; }
      Serial.print(F("nudge ch")); Serial.print(ch); Serial.println(F(" (not in sv[])"));
      nudgeRaw(ch);
      return;
    }
    idIdx = i; idUntil = millis() + ID_MS;
    apply(i, sv[i].cont ? 100 : 120);   // 35% could not shift a loaded joint
    Serial.print(F("nudge ")); Serial.println(sv[i].name);
    return;
  }

  bool trim = (ln[0] == 'n' || ln[0] == 'N');
  if (trim) ln = ln.substring(1);
  int colon = ln.indexOf(':');
  if (colon < 0) { Serial.println(F("? want <ch>:<val>")); return; }

  int i = find(ln.substring(0, colon).toInt());
  int v = ln.substring(colon + 1).toInt();
  if (i < 0) { Serial.println(F("? no joint on that channel")); return; }

  if (trim) {
    if (!sv[i].cont || v < 1000 || v > 2000) { Serial.println(F("? trim is 1000-2000, 360s only")); return; }
    sv[i].neutral = v;
    off(sv[i].ch);
    Serial.print(F("trim ")); Serial.println(v);
    return;
  }
  apply(i, v);
}

void loop() {
  if (Serial.available()) handle(Serial.readStringUntil('\n'));

  if (idIdx >= 0 && millis() > idUntil) { apply(idIdx, sv[idIdx].cont ? 0 : 90); idIdx = -1; }

  // Deadman per joint. Tab closed, wifi dropped, laptop asleep, button stuck —
  // an arm joint with no end stop must not outlive the hand on the button.
  for (uint8_t i = 0; i < NSV; i++) {
    if (lastCmd[i] && millis() - lastCmd[i] > JOG_MS) { off(sv[i].ch); lastCmd[i] = 0; }
  }
}

