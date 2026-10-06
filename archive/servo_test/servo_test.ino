#include <Servo.h>

#define SERVOPIN 9
Servo s;

void setup() {
  Serial.begin(9600);
  s.attach(SERVOPIN);
}

void loop() {
  for (int a = 60; a <= 120; a += 2) { s.write(a); Serial.println(a); delay(60); }
  for (int a = 120; a >= 60; a -= 2) { s.write(a); Serial.println(a); delay(60); }
}
