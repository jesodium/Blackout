// Arm only: the main sketch's arm.h (symlinked, not copied) and nothing else in
// loop() — no BLE, no panel, no sonar. Same serial commands as main, so
// server/tools/armrec.py drives it unchanged. If the arm is snappy here and
// laggy in main, the lag is main's loop, not the I2C bus.
//
//   arm,<j>,<speed>   jog (-100..100, 0 = park)    armz,   home
//   arm,  / stop      all off                       t       time the bus
//   deg,<j>,<angle>   jump straight there, full servo torque, no glide
//
// Every second it prints `loop max <us>` — the longest loop() pass, i.e. the
// worst wait a command can have before armTick() sees it.
#include "arm.h"

String line;
unsigned long loopMax, lastRep;

// 100 full channel writes, the same 6-byte transaction armWrite() does.
static void timeBus() {
  unsigned long t = micros();
  for (int k = 0; k < 100; k++) armWrite(0);
  Serial.print("i2c write "); Serial.print((micros() - t) / 100); Serial.println(" us each");
  Wire.beginTransmission(ARM_ADDR);                // 0 = PCA9685 acked, else it's gone
  Serial.print("pca9685 ack "); Serial.println(Wire.endTransmission());
}

static void handle(String c) {
  c.trim();
  if (c == "t") timeBus();
  else if (c == "stop") armStopAll();
  else if (c.startsWith("armz,")) armHome();
  else if (c.startsWith("deg,")) {                 // deg,<j>,<angle>: jump, no glide
    int a = c.indexOf(',', 4), j = c.substring(4, a).toInt();
    if (a < 0 || j < 0 || j >= ARM_N) return;
    armLiveOn(); armHoming = false; armSpeed[j] = 0; armLastCmd[j] = 0;
    armPos[j] = constrain(c.substring(a + 1).toInt(), armSv[j].lo, armSv[j].hi);
    armWrite(j);
    Serial.print("arm "); Serial.print(armSv[j].name);
    Serial.print(" @ "); Serial.println(lround(armPos[j]));
  }
  else if (c.startsWith("arm,")) {
    int a = c.indexOf(',', 4);
    if (a < 0) armStopAll();
    else armJog(c.substring(4, a).toInt(), c.substring(a + 1).toInt());
  }
}

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 2000) {}
  armBegin();
  Serial.println("arm_test ready");
}

void loop() {
  unsigned long t = micros();
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n') { handle(line); line = ""; }
    else line += ch;
  }
  armTick();
  loopMax = max(loopMax, micros() - t);
  if (millis() - lastRep > 1000) {
    lastRep = millis();
    Serial.print("loop max "); Serial.print(loopMax); Serial.println(" us");
    loopMax = 0;
  }
}
