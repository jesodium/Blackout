#include "motors.h"

const int LEFT_SPEED  = 200;
const int RIGHT_SPEED = 200;  // temp: bumped back up to test if right side was stalling. retune after.

void setup() {
  motorsInit();
}

void loop() {
  // Forward 2s
  setMotors(FORWARD, LEFT_SPEED, FORWARD, RIGHT_SPEED);
  delay(2000);

  // Backward 2s
  setMotors(BACKWARD, LEFT_SPEED, BACKWARD, RIGHT_SPEED);
  delay(2000);
}
