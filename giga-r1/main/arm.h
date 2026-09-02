// PCA9685 (HW-170) servo arm, ported off the OUTDATED/pca_test bench rig.
//
// Driven from the BLE `arm,<joint>,<speed>` command (handleCmd in main.ino),
// which the dashboard's ARM pad repeats every 300ms while a button is held.
// Nothing else may call armJog(): a 360 with no operator holding it winds
// itself into the frame, which is what happened the first time on the bench.
//
// Bus is `Wire` (SDA d20 / SCL d21), the one bus with nothing else on it: a
// stalled servo browns the PCA9685 out and clamps SDA, and on a shared bus
// that would take the bme280 or the bh1750 down with it. VCC is 3V3 here, not
// the bench rig's 5V — the Giga drives 3.3V logic and a PCA9685 at VDD 5V
// wants 0.7*VDD = 3.5V to read a HIGH, which 3.3V does not clear.
// V+ IS THE SERVO RAIL, 6V MAX, off its own buck. Never the 12V pack.
#pragma once
#include <Wire.h>

#define ARM_ADDR 0x40
#define ARM_MODE1 0x00
#define ARM_PRESCALE 0xFE
#define ARM_LED0_ON_L 0x06
#define ARM_OE_PIN 32      // active low: HIGH = all 16 channels off. NOT d8 —
                           // that is SCL2 on the Giga, unlike the bench rig.
#define ARM_HZ 50
#define ARM_SPAN_US 700    // full speed = neutral +/- this. 500 is nominal;
                           // the base carries the whole arm and had nothing
                           // left there. Buzzing at rest = saturated, go back.
#define ARM_JOG_MS 800     // a held 360 dies this long after the last command

// Every joint is a 360: an angle sent to one is full speed, not a position, so
// there is no "go to 45deg" — only "move while somebody holds the button", and
// only continuous channels get the deadman below. Neutral is MEASURED per
// servo, never assumed: each one creeps at its own nominal 1500.
struct ArmJoint { uint8_t ch; bool cont; int neutral; const char *name; };
ArmJoint armSv[] = {
  { 6,  true, 1490, "base"      },   // measured on the bench 2026-08-24
  { 5,  true, 1500, "shoulder"  },   // untrimmed
  { 4,  true, 1500, "elbow"     },   // untrimmed
  { 3,  true, 1500, "wrist"     },   // untrimmed
  { 12, true, 1500, "gripwrist" },   // untrimmed, never seen to move yet
  { 1,  true, 1500, "gripper"   },   // 360, stripped pot — untrimmed
};
const uint8_t ARM_N = sizeof(armSv) / sizeof(armSv[0]);

bool armOk = false;                  // false = chip never answered, all no-ops
unsigned long armLastCmd[ARM_N];     // 0 = that joint is not moving

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

// Kill the pulse outright — the full-off bit, not a neutral pulse. A neutral
// pulse is still a command, and an untrimmed 360 creeps on it forever.
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

void armStopAll() {
  armOutputs(false);                 // first: works even with the bus dead
  for (uint8_t c = 0; c < 16; c++) armOff(c);
  for (uint8_t i = 0; i < ARM_N; i++) armLastCmd[i] = 0;
}

// -100..100. Repeat to keep moving; silence stops the joint in ARM_JOG_MS.
// IMPORTANT NOTE: operator-held only — never from a routine or the blk vm.
void armJog(uint8_t i, int speed) {
  if (!armOk || i >= ARM_N) return;
  armOutputs(true);                  // a stop latches OE off; moving lifts it
  if (speed == 0) { armOff(armSv[i].ch); armLastCmd[i] = 0; return; }
  armSetUs(armSv[i].ch, armSv[i].neutral + (long)constrain(speed, -100, 100) * ARM_SPAN_US / 100);
  armLastCmd[i] = millis();
}

// The PCA9685 keeps driving its last registers while the Giga reboots, so
// blanking all 16 comes before anything else can be asked of it.
void armBegin() {
  digitalWrite(ARM_OE_PIN, HIGH);    // level before pinMode, or the pin's
  pinMode(ARM_OE_PIN, OUTPUT);       // default low enables every channel
  armOutputs(false);

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

// Deadman, per joint. Tab closed, link dropped, button stuck — an arm joint
// with no end stop must not outlive the hand on the button.
void armTick() {
  if (!armOk) return;
  unsigned long now = millis();
  for (uint8_t i = 0; i < ARM_N; i++) {
    if (armLastCmd[i] && now - armLastCmd[i] > ARM_JOG_MS) {
      armOff(armSv[i].ch);
      armLastCmd[i] = 0;
    }
  }
}
