// PCA9685 (HW-170) driving a MeArm: four SG90 positional servos.
//
// Driven from the BLE `arm,<joint>,<speed>` command (handleCmd in main.ino),
// which the dashboard's ARM pad repeats every 300ms while a button is held.
// The wire format is the one the old six-360 arm used, so the pad, the
// recorder (server/tools/armrec.py) and Sage's take replay are unchanged —
// but `speed` now moves the joint's TARGET ANGLE at that rate, and a released
// joint holds its angle by itself. No hold bias, no sag trim, no dead reckoning:
// the SG90's own pot is the encoder.
//
// Bus is `Wire` (SDA d20 / SCL d21), the one bus with nothing else on it: a
// stalled servo browns the PCA9685 out and clamps SDA, and on a shared bus
// that would take the bme280 or the bh1750 down with it. VCC is 3V3 here, not
// the bench rig's 5V — the Giga drives 3.3V logic and a PCA9685 at VDD 5V
// wants 0.7*VDD = 3.5V to read a HIGH, which 3.3V does not clear.
// V+ IS THE SERVO RAIL, 5V for SG90s (6V absolute max), off its own buck.
// Never the 12V pack.
#pragma once
#include <Wire.h>

#define ARM_ADDR 0x40
#define ARM_MODE1 0x00
#define ARM_PRESCALE 0xFE
#define ARM_LED0_ON_L 0x06
#define ARM_OE_PIN 32      // active low: HIGH = all 16 channels off. NOT d8 —
                           // that is SCL2 on the Giga, unlike the bench rig.
#define ARM_HZ 50
#define ARM_US_0 500       // SG90 pulse at 0deg / 180deg. Clones vary: if 90 is
#define ARM_US_180 2500    // not mid-travel, or an end buzzes, trim these.
#define ARM_DEG_S 90       // how fast a held button moves a joint at speed 100
#define ARM_JOG_MS 1000    // a held joint stops moving this long after the last
                           // command. Stopping is safe now (it holds where it
                           // is), so this only has to outlast the pad's 300ms
                           // repeat with a dropped packet or two.

// lo/hi are the joint's travel in degrees and the ONLY thing keeping a MeArm
// from jamming itself: an SG90 driven into its own frame stalls at ~650mA,
// gets hot, and browns the rail. MEASURE THEM, never guess: jog the joint
// slowly until it just touches, release, read `arm <name> @ <deg>` off serial,
// and put that number here backed off 5deg. Until then they are conservative.
// home is 90 for every joint, and 90 means what the operator calls 90, not the
// servo's: trim is degrees added at the pulse only, for a horn that went on off
// centre. To set it: trim 0, jog until the joint sits where 90 should be, read
// `arm <name> @ <deg>`, trim = deg - 90. lo/hi/home and the readout stay in the
// operator's degrees, so lo/hi need re-measuring after a trim change.
// dir is which way a + jog turns the joint: -1 flips the arrows for a servo
// that went in mirrored. It flips the jog only, never the degrees.
struct ArmJoint { uint8_t ch; int lo, hi, home, trim, dir; const char *name; };
ArmJoint armSv[] = {
  { 4,  10, 170, 90, 0, -1, "base"     },   // untrimmed; arrows were backwards
  { 6,   0, 180, 90, 0,  1, "shoulder" },   // untrimmed; reach forward/back; full travel, unmeasured
  { 8,  45, 135, 90, 0,  1, "elbow"    },   // untrimmed; lift up/down
  { 10, 60, 120, 90, 0,  1, "gripper"  },   // untrimmed; open/close
};
const uint8_t ARM_N = sizeof(armSv) / sizeof(armSv[0]);

bool armOk = false;                  // false = chip never answered, all no-ops
bool armLive = false;                // pulses on. false after boot and any stop
bool armHoming = false;              // gliding every joint to home (armz,)
float armPos[ARM_N];                 // commanded angle, deg
int armSpeed[ARM_N];                 // -100..100, 0 = holding
unsigned long armLastCmd[ARM_N];     // 0 = that joint is not being jogged
unsigned long armT;                  // last armTick, for the rate integral

// Every Wire call is guarded on armOk: a browned-out PCA9685 clamps SDA low and
// then a blocking transaction looks exactly like a bricked board — silent from
// boot with USB still enumerated. Better to no-op than to hang the rover.
static void armWr(uint8_t r, uint8_t v) {
  if (!armOk) return;
  Wire.beginTransmission(ARM_ADDR);
  Wire.write(r); Wire.write(v);
  Wire.endTransmission();
}

// OE is the only stop that works with the bus dead: active-low straight into
// the chip's output stage, no i2c involved.
static void armOutputs(bool on) { digitalWrite(ARM_OE_PIN, on ? LOW : HIGH); }

// Kill the pulse outright — the full-off bit. A limp SG90 stays roughly where
// it was, so armPos[] is still a fair guess when the pulses come back.
static void armOff(uint8_t ch) {
  if (!armOk) return;
  Wire.beginTransmission(ARM_ADDR);
  Wire.write(ARM_LED0_ON_L + 4 * ch);
  Wire.write(0); Wire.write(0);
  Wire.write(0); Wire.write(0x10);
  Wire.endTransmission();
}

static void armSetUs(uint8_t ch, int us) {
  if (!armOk) return;
  long ticks = (long)us * 4096 / (1000000L / ARM_HZ);
  Wire.beginTransmission(ARM_ADDR);
  Wire.write(ARM_LED0_ON_L + 4 * ch);
  Wire.write(0); Wire.write(0);
  Wire.write((uint8_t)(ticks & 0xFF)); Wire.write((uint8_t)((ticks >> 8) & 0x0F));
  Wire.endTransmission();
}

static void armWrite(uint8_t i) {
  long d = constrain(lround(armPos[i]) + armSv[i].trim, 0, 180);  // trim can't push past the servo's ends
  armSetUs(armSv[i].ch, map(d, 0, 180, ARM_US_0, ARM_US_180));
}

// Pulses on. Registers first, then OE: the first thing every joint sees is
// where it is believed to be. IMPORTANT NOTE: after boot nothing knows where
// the arm really is, so the first move snaps every joint to home at the
// servo's full speed — park the arm near home before powering up.
static void armLiveOn() {
  if (armLive) return;
  for (uint8_t i = 0; i < ARM_N; i++) armWrite(i);
  armOutputs(true);
  armLive = true;
}

void armStopAll() {
  armOutputs(false);                 // first: works even with the bus dead
  for (uint8_t c = 0; c < 16; c++) armOff(c);
  for (uint8_t i = 0; i < ARM_N; i++) { armSpeed[i] = 0; armLastCmd[i] = 0; }
  armLive = false;
  armHoming = false;
}

// Glide every joint to its home angle at ARM_DEG_S. A take recorded from home
// replays the same from home, which is the point.
void armHome() {
  if (!armOk) return;
  for (uint8_t i = 0; i < ARM_N; i++) { armSpeed[i] = 0; armLastCmd[i] = 0; }
  armLiveOn();
  armHoming = true;
}

// -100..100. Repeat to keep moving; silence stops the joint in ARM_JOG_MS.
void armJog(uint8_t i, int speed) {
  if (!armOk || i >= ARM_N) return;
  armLiveOn();
  armHoming = false;
  armSpeed[i] = constrain(speed, -100, 100) * armSv[i].dir;
  armLastCmd[i] = armSpeed[i] ? millis() : 0;
  if (!armSpeed[i]) {                // released: say where, for trimming lo/hi
    Serial.print("arm "); Serial.print(armSv[i].name);
    Serial.print(" @ "); Serial.println(lround(armPos[i]));
  }
}

// The PCA9685 keeps driving its last registers while the Giga reboots, so
// blanking all 16 comes before anything else can be asked of it.
void armBegin() {
  digitalWrite(ARM_OE_PIN, HIGH);    // level before pinMode, or the pin's
  pinMode(ARM_OE_PIN, OUTPUT);       // default low enables every channel
  armOutputs(false);
  for (uint8_t i = 0; i < ARM_N; i++) armPos[i] = armSv[i].home;
  armT = millis();

  Wire.begin();
  Wire.beginTransmission(ARM_ADDR);
  armOk = (Wire.endTransmission() == 0);
  Serial.println(armOk ? "PCA9685 ok" : "PCA9685 not found");
  if (!armOk) return;

  armWr(ARM_MODE1, 0x10);            // sleep: prescale is write-only asleep
  armWr(ARM_PRESCALE, 25000000L / (4096L * ARM_HZ) - 1);
  armWr(ARM_MODE1, 0x00);
  delay(1);                          // datasheet: 500us for the oscillator
  armWr(ARM_MODE1, 0xA1);            // restart + auto-increment
  armStopAll();
}

// Moves every jogged (or homing) joint toward its target, clamped to lo/hi.
// Writes only when the whole degree changes, so an idle arm is no bus traffic.
void armTick() {
  unsigned long now = millis();
  float lim = ARM_DEG_S * (now - armT) / 1000.0f;
  armT = now;
  if (!armOk || !armLive) return;
  bool away = false;                 // any homing joint not there yet
  for (uint8_t i = 0; i < ARM_N; i++) {
    if (armLastCmd[i] && now - armLastCmd[i] > ARM_JOG_MS) { armSpeed[i] = 0; armLastCmd[i] = 0; }
    float step;
    if (armSpeed[i]) step = lim * armSpeed[i] / 100;
    else if (armHoming) step = constrain(armSv[i].home - armPos[i], -lim, lim);
    else continue;
    long was = lround(armPos[i]);
    armPos[i] = constrain(armPos[i] + step, (float)armSv[i].lo, (float)armSv[i].hi);
    if (lround(armPos[i]) != was) armWrite(i);
    if (armHoming && !armSpeed[i] && fabsf(armPos[i] - armSv[i].home) > 0.01f) away = true;
  }
  // Arrived: say where, same line a jog release prints, so the recorder's
  // readout follows a home too. Clearing armHoming makes it print once.
  if (armHoming && !away) {
    armHoming = false;
    for (uint8_t i = 0; i < ARM_N; i++) {
      Serial.print("arm "); Serial.print(armSv[i].name);
      Serial.print(" @ "); Serial.println(lround(armPos[i]));
    }
  }
}
