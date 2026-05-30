#include "motors.h"
#include "sensors.h"

void setup() {
  Serial.begin(9600);
  motorsInit();
  sensorsInit();
}

void loop() {
  float cm = readDistance();
  Serial.print("Dist: "); Serial.print(cm); Serial.println(" cm");
  delay(500);
}
