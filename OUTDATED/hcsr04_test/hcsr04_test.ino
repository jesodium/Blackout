#define TRIG 11
#define ECHO 12

void setup() {
  Serial.begin(9600);
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
}

void loop() {
  digitalWrite(TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG, LOW);

  long us = pulseIn(ECHO, HIGH, 30000);  // 30ms timeout ~ 5m max
  if (us == 0) {
    Serial.println("no echo (out of range / check wiring)");
  } else {
    Serial.print(us / 58.0);  // us -> cm
    Serial.println(" cm");
  }
  delay(300);
}
