#include "motors.h"

AF_DCMotor motorFL(1);  // M1 = front left
AF_DCMotor motorBL(2);  // M2 = back left
AF_DCMotor motorFR(3);  // M3 = front right
AF_DCMotor motorBR(4);  // M4 = back right

const int BL_BOOST = 40;  // back left motor weak, add to its speed. tune to even out.

void motorsInit() {
  motorFL.setSpeed(0);
  motorBL.setSpeed(0);
  motorFR.setSpeed(0);
  motorBR.setSpeed(0);
  motorFL.run(RELEASE);
  motorBL.run(RELEASE);
  motorFR.run(RELEASE);
  motorBR.run(RELEASE);
}

void setMotors(int dirA, int speedA, int dirB, int speedB) {
  if (dirA == STOP) {
    motorFL.run(RELEASE);
    motorBL.run(RELEASE);
  } else {
    motorFL.setSpeed(constrain(speedA, 0, 255));
    motorBL.setSpeed(constrain(speedA + BL_BOOST, 0, 255));
    motorFL.run(dirA == FORWARD ? FORWARD : BACKWARD);
    motorBL.run(dirA == FORWARD ? BACKWARD : FORWARD);  // M2 wired reverse polarity, invert in software
  }

  if (dirB == STOP) {
    motorFR.run(RELEASE);
    motorBR.run(RELEASE);
  } else {
    motorFR.setSpeed(constrain(speedB, 0, 255));
    motorBR.setSpeed(constrain(speedB, 0, 255));
    motorFR.run(dirB == FORWARD ? FORWARD : BACKWARD);
    motorBR.run(dirB == FORWARD ? FORWARD : BACKWARD);
  }
}

void motorsStop() {
  motorFL.run(RELEASE);
  motorBL.run(RELEASE);
  motorFR.run(RELEASE);
  motorBR.run(RELEASE);
}
