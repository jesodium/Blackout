// Megalovania opening motif — SHORT FRAGMENT — 3-pin buzzer, Uno R4.
// I/O -> D8, VCC -> 5V, GND -> GND.
//
// IMPORTANT NOTE: copyrighted composition (Toby Fox, 2015), so this is the
// opening hook only, not the track. Extend the arrays yourself if you want more.
//
// IMPORTANT NOTE: by ear in D and APPROXIMATE. It's also monophonic — the whole
// point of this riff live is the bassline under a lead, and a buzzer can only
// hold one note at a time, so you get the bass figure alone.
//
// IMPORTANT NOTE: IDLE_HIGH stays true. LOW is this module's sounding state;
// writing LOW as "silence" is what caused the constant tone.

const int PIN_BUZZ = 8;
const int BPM = 240;              // tempo knob; the riff is fast
const bool IDLE_HIGH = true;      // this module's silent level
const int  TRANSPOSE = 0;         // semitones; 12 = octave up, -12 = down

// n-prefixed: bare D5/A5 collide with the core's own pin macros on the R4.
const int nD4=294, nF4=349, nG4=392, nGS4=415, nA4=440, nD5=587;

const int melody[] = {
  nD4, nD4, nD5, nA4, 0, nGS4, 0, nG4, 0, nF4, nD4, nF4, nG4, 0,
  nD4, nD4, nD5, nA4, 0, nGS4, 0, nG4, 0, nF4, nD4, nF4, nG4, 0
};
// beats x2: 1 = eighth, 2 = quarter
const int duration[] = {
  1, 1, 2, 2, 1, 2, 1, 2, 1, 1, 1, 1, 1, 2,
  1, 1, 2, 2, 1, 2, 1, 2, 1, 1, 1, 1, 1, 2
};
const int N = sizeof(melody) / sizeof(melody[0]);

int pitch(int hz) { return (int)(hz * pow(2.0, TRANSPOSE / 12.0)); }

void silence() { noTone(PIN_BUZZ); digitalWrite(PIN_BUZZ, IDLE_HIGH ? HIGH : LOW); }

void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 3000) {}
  pinMode(PIN_BUZZ, OUTPUT);
  silence();
  // Same length or the tune walks off the end of one array — a silent
  // out-of-bounds read on a board with no MPU.
  if (N != (int)(sizeof(duration) / sizeof(duration[0])))
    Serial.println("BUG: melody/duration length mismatch");
}

void loop() {
  const int eighth = 30000 / BPM;
  Serial.println("megalovania riff (fragment)");
  for (int i = 0; i < N; i++) {
    int ms = duration[i] * eighth;
    if (melody[i]) { tone(PIN_BUZZ, pitch(melody[i])); delay(ms * 0.9); silence(); delay(ms * 0.1); }
    else           { silence(); delay(ms); }
  }
  silence();
  delay(1200);
}
