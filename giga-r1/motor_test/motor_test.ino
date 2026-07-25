// l298n test. both motors forward at speed for 2s, stop 2s, repeat.
// ena/enb jumper caps off, wires: ena -> d3, enb -> d10.
// d13 mirrors the drive phase — lit = motors should be turning.
#define IN1 4
#define IN2 5
#define IN3 6
#define IN4 7
#define ENA 3
#define ENB 10
#define SPEED 120 // 0-255. loaded/geared motors may need 150+ to break stiction.
                  // buzzing but not turning = raise this, not a wiring fault.

void setup() {
  for (int p = IN1; p <= IN4; p++) pinMode(p, OUTPUT);
  pinMode(ENA, OUTPUT); pinMode(ENB, OUTPUT);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(IN1, HIGH); digitalWrite(IN2, LOW);  // motor a forward
  digitalWrite(IN3, HIGH); digitalWrite(IN4, LOW);  // motor b forward
}

void loop() {
  analogWrite(ENA, SPEED); analogWrite(ENB, SPEED);
  digitalWrite(LED_BUILTIN, HIGH);
  delay(2000);

  analogWrite(ENA, 0); analogWrite(ENB, 0); // off phase also lets the rail recover
  digitalWrite(LED_BUILTIN, LOW);
  delay(2000);
}
