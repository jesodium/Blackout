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
#define ARM_SPAN_US 700    // default full-speed swing = neutral +/- this. 500 is
                           // nominal; the base carries the whole arm and had
                           // nothing left there. Per-joint in armSv[] below,
                           // because pulse width is speed AND torque at once and
                           // these six joints carry very different loads.
                           // Buzzing at rest = saturated, go back down.
#define ARM_JOG_MS 800     // a held 360 dies this long after the last command
#define ARM_HOLD_MAX 35    // biggest hold bias the trim will set. Above this it
                           // is a jog, not a hold, and an unheld joint that
                           // climbs is exactly what winds into the frame. Was 25,
                           // a guess: the elbow measured -20 against it, so a
                           // loaded joint had no headroom left.
#define ARM_TRAVEL_MS 2500 // default per-joint travel budget, in MILLISECONDS AT
                           // FULL SPEED, measured either way from wherever the
                           // arm was last zeroed — so a joint's usable range is
                           // 2x this wide. There is no encoder on any of these
                           // joints, so a limit cannot be an angle: the only
                           // thing that can be counted is how long the joint was
                           // driven and how hard, which is dead reckoning and
                           // DRIFTS. It is a stop against winding into the frame,
                           // never a position. MEASURE IT per joint: jog one way
                           // until it reaches the mechanical end, and take the
                           // seconds it took. 0 in the table = no limit.

// Every joint is a 360: an angle sent to one is full speed, not a position, so
// there is no "go to 45deg" — only "move while somebody holds the button", and
// only continuous channels get the deadman below. Neutral is MEASURED per
// servo, never assumed: each one creeps at its own nominal 1500.
// span is per joint: neutral +/- span must stay inside 500-2500us, so a joint
// on a 1500 neutral tops out at 1000. test-arm.mjs asserts that for every row.
//
// hold is in the same -100..100 the pad sends, and it is what the joint is left
// driving at once the button is released. A 360 outputs zero drive at neutral
// and free-wheels with the pulse cut, so a gravity-loaded joint sags either way
// — the only thing that holds it is a small pulse pushing back up. 0 keeps the
// old behaviour (cut the pulse outright) and is right for anything not loaded.
// MEASURE IT, never guess: jog the joint up at 3, then 5, then 8 until it stops
// sagging, and put that number here with the sign that lifts.
//
// limit is the travel budget above, per joint, and every one of them is a GUESS
// until it is measured on the bench (armrec.py prints the run-time of a take).
struct ArmJoint { uint8_t ch; bool cont; int neutral; int span; int hold; long limit; const char *name; };
ArmJoint armSv[] = {
  { 6,  true, 1490, ARM_SPAN_US, 0, ARM_TRAVEL_MS, "base"      },   // measured on the bench 2026-08-24
  { 5,  true, 1500, ARM_SPAN_US, 0, ARM_TRAVEL_MS, "shoulder"  },   // untrimmed; sags — needs a hold
  { 4,  true, 1500, ARM_SPAN_US, 0, ARM_TRAVEL_MS, "elbow"     },   // untrimmed; sags — needs a hold
  { 3,  true, 1500, ARM_SPAN_US, 0, ARM_TRAVEL_MS, "wrist"     },   // untrimmed
  { 12, true, 1500, 1000,        0, ARM_TRAVEL_MS, "gripwrist" },   // short of full travel at 700
  { 1,  true, 1500, ARM_SPAN_US, 0, 1200,          "gripper"   },   // 360, stripped pot — a gripper
                                                                    // closes on a thing and then stalls,
                                                                    // so it gets the shortest budget
};
const uint8_t ARM_N = sizeof(armSv) / sizeof(armSv[0]);

bool armOk = false;                  // false = chip never answered, all no-ops
unsigned long armLastCmd[ARM_N];     // 0 = that joint is not moving

// Dead-reckoned travel, in ms-at-full-speed, signed, from the last armZero().
// This is the ONLY thing standing between a 360 and the frame it is bolted to:
// no joint on this arm can report where it is, so the budget is integrated from
// what was commanded. It drifts (stall, sag, a hand moving the arm), which is
// why armZero() exists and why the operator re-homes by eye.
long armTravel[ARM_N];
int armSpeed[ARM_N];                 // what the joint is being driven at, for the integral
unsigned long armTravelT[ARM_N];     // when armTravel[i] was last brought up to date
bool armLimits = true;               // arml,0 turns the stops off — bench only

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

// speed -100..100 -> pulse. The one place the table's trim is applied.
static int armPulse(uint8_t i, int speed) {
  return armSv[i].neutral + (long)constrain(speed, -100, 100) * armSv[i].span / 100;
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

// Bring one joint's travel up to now. Idempotent: it advances the clock, so
// calling it twice in a row adds nothing the second time.
// IMPORTANT NOTE: the hold bias is deliberately NOT counted — armPark() sets
// armSpeed to 0. A hold that balances gravity moves the joint nowhere, and
// counting it would eat the whole budget off a parked arm overnight.
static void armAccum(uint8_t i, unsigned long now) {
  if (armSpeed[i]) armTravel[i] += (long)armSpeed[i] * (long)(now - armTravelT[i]) / 100;
  armTravelT[i] = now;
}

// "the arm is where I want home to be". The budget is dead reckoning, so after a
// stall, or after somebody moves the arm by hand, the count is wrong and this is
// the only way to fix it — there is nothing to read back.
void armZero(int i) {
  for (uint8_t k = 0; k < ARM_N; k++)
    if (i < 0 || i == (int)k) { armTravel[k] = 0; armTravelT[k] = millis(); }
}

// Where a released joint is left: holding itself up, or pulse cut. Anything
// with a hold keeps drawing current until armStopAll() or the next jog — that
// is the trade for an arm that does not fall over between moves.
static void armPark(uint8_t i) {
  armAccum(i, millis());
  armSpeed[i] = 0;
  if (armSv[i].hold) armSetUs(armSv[i].ch, armPulse(i, armSv[i].hold));
  else armOff(armSv[i].ch);
  armLastCmd[i] = 0;
}

void armStopAll() {
  armOutputs(false);                 // first: works even with the bus dead
                                     // no armPark() here on purpose: a panic
                                     // stop is a true kill, not a hold
  for (uint8_t c = 0; c < 16; c++) armOff(c);
  for (uint8_t i = 0; i < ARM_N; i++) {
    armAccum(i, millis());           // travel is NOT reset — stopping moves nothing
    armSpeed[i] = 0;
    armLastCmd[i] = 0;
  }
}

// Bench trim for the hold bias, off the slider in the dashboard's arm pad:
// turn it until the joint stops sagging, then copy the printed number into
// armSv[] above — this is RAM only and a reset takes it back to the table.
void armSetHold(uint8_t i, int v) {
  if (i >= ARM_N) return;
  armSv[i].hold = constrain(v, -ARM_HOLD_MAX, ARM_HOLD_MAX);
  Serial.print("arm hold "); Serial.print(armSv[i].name);
  Serial.print(" = "); Serial.println(armSv[i].hold);
  if (!armLastCmd[i]) armPark(i);    // idle: re-park so the change is felt now
}

// -100..100. Repeat to keep moving; silence stops the joint in ARM_JOG_MS.
// IMPORTANT NOTE: operator-held only — never from a routine or the blk vm.
void armJog(uint8_t i, int speed) {
  if (!armOk || i >= ARM_N) return;
  unsigned long now = millis();
  armAccum(i, now);
  speed = constrain(speed, -100, 100);
  // At the stop, this direction becomes a park and the other one still works —
  // refusing both would trap the arm at its own limit with no way back.
  if (armLimits && armSv[i].limit && speed &&
      (speed > 0 ? armTravel[i] >= armSv[i].limit : armTravel[i] <= -armSv[i].limit))
    speed = 0;
  armOutputs(true);                  // a stop latches OE off; moving lifts it
  if (speed == 0) { armPark(i); return; }
  armSetUs(armSv[i].ch, armPulse(i, speed));
  armSpeed[i] = speed;
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
  armZero(-1);                       // boot pose is home, by definition
}

// Deadman, per joint. Tab closed, link dropped, button stuck — an arm joint
// with no end stop must not outlive the hand on the button.
void armTick() {
  if (!armOk) return;
  unsigned long now = millis();
  for (uint8_t i = 0; i < ARM_N; i++) {
    if (armLastCmd[i] && now - armLastCmd[i] > ARM_JOG_MS) { armPark(i); continue; }
    if (!armSpeed[i]) continue;
    armAccum(i, now);                // a button held down has to hit the stop
    if (armLimits && armSv[i].limit &&                       // mid-hold, not only
        (armSpeed[i] > 0 ? armTravel[i] >= armSv[i].limit    // on the next repeat
                         : armTravel[i] <= -armSv[i].limit)) armPark(i);
  }
}
