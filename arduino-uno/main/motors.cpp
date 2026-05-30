#include "motors.h"

AF_DCMotor motorL1(1);
AF_DCMotor motorL2(2);
AF_DCMotor motorR1(3);
AF_DCMotor motorR2(4);

void motorsInit() {
  motorL1.setSpeed(0);
  motorL2.setSpeed(0);
  motorR1.setSpeed(0);
  motorR2.setSpeed(0);
  motorL1.run(RELEASE);
  motorL2.run(RELEASE);
  motorR1.run(RELEASE);
  motorR2.run(RELEASE);
}

void setMotors(int dirA, int speedA, int dirB, int speedB) {
  if (dirA == STOP) {
    motorL1.run(RELEASE);
    motorL2.run(RELEASE);
  } else {
    motorL1.setSpeed(constrain(speedA, 0, 255));
    motorL2.setSpeed(constrain(speedA, 0, 255));
    motorL1.run(dirA == FORWARD ? FORWARD : BACKWARD);
    motorL2.run(dirA == FORWARD ? FORWARD : BACKWARD);
  }

  if (dirB == STOP) {
    motorR1.run(RELEASE);
    motorR2.run(RELEASE);
  } else {
    motorR1.setSpeed(constrain(speedB, 0, 255));
    motorR2.setSpeed(constrain(speedB, 0, 255));
    motorR1.run(dirB == FORWARD ? FORWARD : BACKWARD);
    motorR2.run(dirB == FORWARD ? FORWARD : BACKWARD);
  }
}

void motorsStop() {
  motorL1.run(RELEASE);
  motorL2.run(RELEASE);
  motorR1.run(RELEASE);
  motorR2.run(RELEASE);
}
