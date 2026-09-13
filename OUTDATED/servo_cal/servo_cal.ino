// Bench tool: sweeps 0-180 on its own. Type an angle (0-180) in the serial
// monitor to stop on it, type 's' to sweep again.
// Use it to find the gripper's real OPEN/CLOSE angles, then hardcode those.
// If typing 90 makes it keep spinning, it's a continuous-rotation servo —
// there 0/180 are full speed each way and the sweep just reverses it.
#include <Servo.h>

#define SERVOPIN 9
#define STEP_MS 15   // ~2.7s per sweep; slower servos need this bigger
Servo s;

bool sweeping = true;
int a = 90, dir = 1;
unsigned long last = 0;

void setup() {
  Serial.begin(9600);
  s.attach(SERVOPIN);
  s.write(a);
  Serial.println(F("sweeping. type an angle 0-180 to hold, 's' to sweep."));
}

void loop() {
  if (Serial.available()) {
    int c = Serial.peek();
    if (c == '\n' || c == '\r' || c == ' ') { Serial.read(); }
    else if (c == 's' || c == 'S') { Serial.read(); sweeping = true; Serial.println(F("sweep")); }
    else {
      // parseInt() reads a bare "\n" as 0 and slams the horn into the stop,
      // which stalls the servo — hence the terminator eating above.
      int v = Serial.parseInt();
      if (v >= 0 && v <= 180) { sweeping = false; a = v; s.write(a); Serial.println(a); }
    }
  }
  if (!sweeping || millis() - last < STEP_MS) return;
  last = millis();
  a += dir;
  if (a >= 180 || a <= 0) dir = -dir;
  s.write(a);
}
