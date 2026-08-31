// bench-only wiring and direction check, not part of the build

#define ENA 3
#define IN1 2
#define IN2 7
#define IN3 6
#define IN4 4
#define ENB 10
#define SPEED 120

void setup() {
  for (uint8_t p : {IN1, IN2, IN3, IN4}) pinMode(p, OUTPUT);
  pinMode(ENA, OUTPUT); pinMode(ENB, OUTPUT);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(IN1, HIGH); digitalWrite(IN2, LOW);
  digitalWrite(IN3, HIGH); digitalWrite(IN4, LOW);
}

void loop() {
  analogWrite(ENA, SPEED); analogWrite(ENB, SPEED);
  digitalWrite(LED_BUILTIN, HIGH);
  delay(2000);

  analogWrite(ENA, 0); analogWrite(ENB, 0);
  digitalWrite(LED_BUILTIN, LOW);
  delay(2000);
}
