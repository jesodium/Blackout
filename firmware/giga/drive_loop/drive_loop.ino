// bench-only: slow forward 3s, turbo spin 5s, forever. not part of the build

#define ENA 2
#define IN1 3
#define IN2 4
#define IN3 5
#define IN4 6
#define ENB 7
#define ARM_OE_PIN 32  // PCA9685 OE, active low
#define SLOW 61        // drive.js MIN_PWM is 55: below ~that the L298N buzzes, no roll
#define TURBO 255

// same as tank() in main/motors.h, so forward here is forward there
void tank(int l, int r) {
  digitalWrite(IN1, l < 0); digitalWrite(IN2, l > 0);
  digitalWrite(IN3, r < 0); digitalWrite(IN4, r > 0);
  analogWrite(ENA, abs(l)); analogWrite(ENB, abs(r));
}

void setup() {
  // arm off: the PCA9685 keeps its last registers across a reflash, so the
  // claw would keep holding without this
  digitalWrite(ARM_OE_PIN, HIGH); pinMode(ARM_OE_PIN, OUTPUT);
  for (uint8_t p : {ENA, IN1, IN2, IN3, IN4, ENB}) pinMode(p, OUTPUT);
}

void loop() {
  tank(SLOW, SLOW);     delay(3000);
  tank(-TURBO, TURBO);  delay(5000);  // right() in motors.h
}
