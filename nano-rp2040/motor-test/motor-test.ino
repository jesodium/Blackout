// Both motors, enables driven from GPIO (no dependence on board +5V terminal).
// ENA=6, ENB=7 held HIGH = both channels enabled. IN pins = direction.
#define IN1 2
#define IN2 3
#define IN3 4
#define IN4 5
#define ENA 6
#define ENB 6   // both enables tied to the same pin

void drive(bool fwd) {
  digitalWrite(IN1, fwd);  digitalWrite(IN2, !fwd);
  digitalWrite(IN3, fwd);  digitalWrite(IN4, !fwd);
}

void setup() {
  pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT);
  pinMode(ENA, OUTPUT); pinMode(ENB, OUTPUT);
  digitalWrite(ENA, HIGH);   // both channels enabled, full speed
  digitalWrite(ENB, HIGH);
}

void loop() {
  drive(true);  delay(2000);
  digitalWrite(IN1, LOW); digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW); digitalWrite(IN4, LOW); delay(500);
  drive(false); delay(2000);
  digitalWrite(IN1, LOW); digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW); digitalWrite(IN4, LOW); delay(500);
}
