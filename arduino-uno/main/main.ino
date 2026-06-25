// L298N dual H-bridge. Left motors paralleled on OUT1/2, right on OUT3/4.

const int ENA = 5;   // left speed  (PWM ~)
const int IN1 = 9;   // left dir
const int IN2 = 4;   // left dir
const int IN3 = 10;  // right dir
const int IN4 = 13;  // right dir
const int ENB = 3;   // right speed (PWM ~)

// If a side spins the wrong way, flip its flag and re-upload.
const bool INV_LEFT  = false;
const bool INV_RIGHT = false;

const int SPEED = 200;  // 0-255

void side(int pwmPin, int dirA, int dirB, int speed, bool inv) {
  if (inv) speed = -speed;
  digitalWrite(dirA, speed >= 0 ? HIGH : LOW);
  digitalWrite(dirB, speed >= 0 ? LOW  : HIGH);
  analogWrite(pwmPin, constrain(abs(speed), 0, 255));
}

void drive(int left, int right) {
  side(ENA, IN1, IN2, left,  INV_LEFT);
  side(ENB, IN3, IN4, right, INV_RIGHT);
}

void setup() {
  pinMode(ENA, OUTPUT); pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(ENB, OUTPUT); pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT);
}

void loop() {
  drive(SPEED, SPEED);    // forward 2s
  delay(2000);
  drive(-SPEED, -SPEED);  // backward 2s
  delay(2000);
}
