// Himno Nacional de Colombia (coro) on the 3-pin buzzer — Uno R4.
// I/O -> D8, VCC -> 5V, GND -> GND.
//
// Music: Oreste Sindici, 1887. Public domain.
//
// IMPORTANT NOTE: needs a PASSIVE buzzer. An active one has its own oscillator
// and honks one fixed pitch through the whole thing — rhythm survives, melody
// doesn't. That's the module, not the sketch.
//
// IMPORTANT NOTE: this is the coro transcribed by ear into C major (it is
// normally sung in Eb). Expect to correct notes — the arrays are the knob:
// fix an entry in melody[] and reflash, no other code moves.

const int PIN_BUZZ = 8;
const int BPM = 80;                  // march tempo knob

// IMPORTANT NOTE: tone() has no volume — it's a full-swing square wave, the only
// knobs are pitch and hardware. A piezo resonates around 2-4kHz and is loudest
// there, so dropping an octave genuinely quietens it. That's what this does.
// For real volume control put a resistor in series with the buzzer: 1k is
// noticeably softer, 220R barely, a 10k pot is a proper knob. Software can't
// beat that here.
const int OCTAVE_DOWN = 1;           // 0 = as written, 1 = an octave down, 2 = two

// n-prefixed: bare D5/A5 collide with the core's own pin macros on the R4.
const int nG4=392, nB4=494, nC5=523, nD5=587, nE5=659, nF5=698, nG5=784;

// "Oh, glo-ria in-mar-ce-si-ble!  Oh, jú-bi-lo in-mor-tal!"
// "en sur-cos de do-lo-res  el bien ger-mi-na ya."   0 = rest.
const int melody[] = {
  nG4, nC5, nC5, nC5, nC5, nB4, nC5, nD5,
  nE5, nE5, nD5, nC5, nD5, nC5, nB4, nC5, 0,
  nE5, nE5, nF5, nG5, nG5, nF5, nE5, nD5,
  nE5, nD5, nC5, nB4, nC5, nD5, nC5, 0
};
// beats x2:  1 = eighth, 2 = quarter, 3 = dotted quarter, 4 = half
const int duration[] = {
  1, 2, 1, 2, 1, 1, 1, 2,
  2, 1, 1, 2, 1, 1, 1, 4, 2,
  1, 2, 1, 2, 1, 1, 1, 2,
  2, 1, 1, 2, 1, 1, 4, 2
};
const int N = sizeof(melody) / sizeof(melody[0]);

// noTone() does not guarantee the pin is left LOW on the Renesas core, and a pin
// parked HIGH is a DC drive into the buzzer — a constant tone between notes.
void silence() { noTone(PIN_BUZZ); digitalWrite(PIN_BUZZ, LOW); }

void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 3000) {}
  pinMode(PIN_BUZZ, OUTPUT);
  silence();
  // melody[] and duration[] must stay the same length or the tune walks off
  // the end of one of them — silent out-of-bounds read on a board with no MPU.
  if (N != (int)(sizeof(duration) / sizeof(duration[0])))
    Serial.println("BUG: melody/duration length mismatch");
}

void loop() {
  const int eighth = 30000 / BPM;                       // ms per half-beat
  Serial.println("Himno Nacional de Colombia - coro");
  for (int i = 0; i < N; i++) {
    int ms = duration[i] * eighth;
    if (melody[i]) tone(PIN_BUZZ, melody[i] >> OCTAVE_DOWN, ms * 0.9); // 10% gap separates notes
    delay(ms);
    silence();
  }
  silence();
  delay(3000);
}
