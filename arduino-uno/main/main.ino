#include "motors.h"

const int SPEED = 110;

bool done = false;

void setup() {
  motorsInit();
}

void loop() {
  if (done) { motorsStop(); return; }

  setMotors(FORWARD, SPEED, FORWARD, SPEED);   // forward 5s
  delay(5000);

  setMotors(BACKWARD, SPEED, BACKWARD, SPEED); // backward 3s
  delay(3000);

  setMotors(BACKWARD, SPEED, FORWARD, SPEED);  // turn left (spin) 3s
  delay(3000);

  // return to original position (dead reckoning, reverse the moves):
  setMotors(FORWARD, SPEED, BACKWARD, SPEED);  // turn right 3s, undo the turn
  delay(3000);
  setMotors(BACKWARD, SPEED, BACKWARD, SPEED); // backward 2s, undo net 2s forward (5 fwd - 3 back)
  delay(2000);

  motorsStop();
  done = true;
}
