// Tornado / civil-defence siren on the 3-pin buzzer — Uno R4.
// I/O -> D8, VCC -> 5V, GND -> GND.
//
// A slow wail: pitch climbs ~4s, holds, falls ~4s, pauses, repeats.
//
// IMPORTANT NOTE: IDLE_HIGH is true here, and that is the fix for the constant
// tone. Every earlier sketch wrote LOW as "silence" and the buzzer kept
// sounding through it, which means LOW is this module's SOUNDING state — either
// it's an active-low module, or the module's own "-" pin landed on D8 and 5V is
// across the element whenever D8 sinks. Same symptom, same fix: park the pin
// HIGH to shut it up.
//
// If it STILL whines after this, pull the signal wire off D8 completely. Noise
// with nothing connected to D8 means the buzzer is running off VCC/GND alone
// and no sketch can ever silence it — that's a wiring/module problem.

const int PIN_BUZZ = 8;

// Bench knobs.
const bool IDLE_HIGH  = true;    // this module's silent level
const int  F_LO       = 400;     // Hz, bottom of the wail
const int  F_HI       = 1000;    // Hz, top of the wail
const int  RISE_MS    = 4000;    // time to climb
const int  HOLD_MS    = 800;     // held at the top
const int  FALL_MS    = 4000;    // time to fall
const int  REST_MS    = 1500;    // silence between wails
const int  STEP_MS    = 20;      // sweep granularity

void silence() { noTone(PIN_BUZZ); digitalWrite(PIN_BUZZ, IDLE_HIGH ? HIGH : LOW); }

// Sweep f_from -> f_to over ms. Linear in frequency: a real siren is a spinning
// rotor, so its pitch tracks rpm, not a musical interval.
void sweep(int f_from, int f_to, int ms) {
  int steps = ms / STEP_MS;
  for (int i = 0; i <= steps; i++) {
    tone(PIN_BUZZ, f_from + (long)(f_to - f_from) * i / steps);
    delay(STEP_MS);
  }
}

void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 3000) {}
  pinMode(PIN_BUZZ, OUTPUT);
  silence();
  Serial.println("tornado siren: wail up, hold, wail down, rest, repeat");
}

void loop() {
  sweep(F_LO, F_HI, RISE_MS);
  tone(PIN_BUZZ, F_HI); delay(HOLD_MS);
  sweep(F_HI, F_LO, FALL_MS);
  silence();
  delay(REST_MS);
}
