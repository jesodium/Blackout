#include "motors.h"

void setup() {
  motorsInit();
}

void loop() {
  // Forward 2s
  setMotors(FORWARD, 200, FORWARD, 200);
  delay(2000);

  // Stop 1s
  motorsStop();
  delay(1000);

  // Backward 2s
  setMotors(BACKWARD, 200, BACKWARD, 200);
  delay(2000);

  // Stop 1s
  motorsStop();
  delay(1000);

  // Spin left 1.5s
  setMotors(BACKWARD, 200, FORWARD, 200);
  delay(1500);

  // Spin right 1.5s
  setMotors(FORWARD, 200, BACKWARD, 200);
  delay(1500);

  // Stop before repeating
  motorsStop();
  delay(500);
}
