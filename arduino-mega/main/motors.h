#ifndef MOTORS_H
#define MOTORS_H

#include <Arduino.h>
#include <AFMotor.h>

#define FORWARD  1
#define BACKWARD 0
#define STOP    -1

void motorsInit();
void setMotors(int dirA, int speedA, int dirB, int speedB);
void motorsStop();

#endif
