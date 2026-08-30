// Test alarm on the 3-pin buzzer — Uno R4.  I/O -> D8, VCC -> 5V, GND -> GND.
//
// Works on either module type on purpose: it's tone() bursts, so a PASSIVE
// buzzer plays the two pitches and an ACTIVE one chops its own single pitch
// into the same rhythm. Either way it reads as an alarm.

const int PIN_BUZZ = 8;

// Bench knobs.
const int  TONE_HI      = 1200;   // Hz, the two alarm pitches
const int  TONE_LO      = 800;
const int  BEEP_MS      = 180;    // length of one beep
const int  GAP_MS       = 90;     // silence between beeps in a burst
const int  BEEPS        = 3;      // beeps per burst
const int  BURST_GAP_MS = 1200;   // silence between bursts
const bool IDLE_HIGH    = false;  // true if phase B of buzzer_diag was the
                                  // one that sounded (active-LOW module)

// Silence is written, never just assumed: noTone() does not guarantee the pin's
// resting level, and a pin parked at the sounding level is a DC drive into the
// buzzer that never stops.
void silence() { noTone(PIN_BUZZ); digitalWrite(PIN_BUZZ, IDLE_HIGH ? HIGH : LOW); }

void beep(int hz, int ms) { tone(PIN_BUZZ, hz); delay(ms); silence(); }

void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 3000) {}
  pinMode(PIN_BUZZ, OUTPUT);
  silence();
  Serial.println("alarm: 3 beeps, pause, repeat. Ctrl-C the monitor to stop reading.");
}

void loop() {
  for (int i = 0; i < BEEPS; i++) {
    beep(TONE_HI, BEEP_MS);  delay(GAP_MS);
    beep(TONE_LO, BEEP_MS);  delay(GAP_MS);
  }
  silence();
  delay(BURST_GAP_MS);
}
