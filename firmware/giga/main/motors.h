// part of main.ino, #included where this section used to be -- order matters
#pragma once

// ---- motors ----
// tank() is the only primitive; the named verbs are its corners
void tank(int l, int r) {
  l = constrain(l, -255, 255); r = constrain(r, -255, 255);
  digitalWrite(IN1, l < 0); digitalWrite(IN2, l > 0);
  digitalWrite(IN3, r < 0); digitalWrite(IN4, r > 0);
  analogWrite(ENA, abs(l)); analogWrite(ENB, abs(r));
}

void forward(uint8_t speed) { tank(speed, speed); }
void back(uint8_t speed)    { tank(-speed, -speed); }

void left(uint8_t speed)    { tank(speed, -speed); }
void right(uint8_t speed)   { tank(-speed, speed); }

void halt() { tank(0, 0); }

void applyStep(const Step& s) {
  switch (s.op) {
    case FWD:   forward(s.pwm); break;
    case BACK:  back(s.pwm);    break;
    case LEFT:  left(s.pwm);    break;
    case RIGHT: right(s.pwm);   break;
    case ANALYZE:
      halt();

      sensorChar.writeValue("E:analyze");
      Serial.println("E:analyze");
      break;
    default:    halt();         break;
  }
}

unsigned long drvEnd = 0;
