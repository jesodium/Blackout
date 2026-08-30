// Beethoven, Symphony No. 5 in C minor — opening — 3-pin buzzer, Uno R4.
// I/O -> D8, VCC -> 5V, GND -> GND.
//
// This is Beethoven's own material (1808), public domain, so the whole opening
// is here rather than a fragment. The fast dance arrangement known as
// "Beethoven Virus" is a modern copyrighted track built on top of this — the
// tune underneath it is what's playing.
//
// IMPORTANT NOTE: IDLE_HIGH stays true. LOW is this module's sounding state;
// writing LOW as "silence" is what caused the constant tone.

const int PIN_BUZZ = 8;
const int BPM = 160;              // tempo knob; wound up, "virus" style
const bool IDLE_HIGH = true;      // this module's silent level

// n-prefixed: bare D5/A5 collide with the core's own pin macros on the R4.
const int nC4=262, nD4=294, nEb4=311, nF4=349, nG4=392, nAb4=415,
          nBb4=466, nC5=523, nEb5=622, nG5=784;

// The two famous phrases, then the same shape carried up.
const int melody[] = {
  0,   nG4, nG4, nG4, nEb4, 0,
  0,   nF4, nF4, nF4, nD4,  0,
  0,   nG4, nG4, nG4, nEb4, nAb4, nAb4, nAb4, nG4, 0,
  0,   nC5, nC5, nC5, nBb4, nG5,  nG5,  nG5,  nEb5, 0
};
// beats x2: 1 = eighth, 2 = quarter, 6 = long held note, 4 = rest
const int duration[] = {
  2,   1, 1, 1, 6, 4,
  2,   1, 1, 1, 6, 4,
  2,   1, 1, 1, 4, 1, 1, 1, 6, 4,
  2,   1, 1, 1, 4, 1, 1, 1, 6, 4
};
const int N = sizeof(melody) / sizeof(melody[0]);

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
  Serial.println("Beethoven 5th - opening");
  for (int i = 0; i < N; i++) {
    int ms = duration[i] * eighth;
    if (melody[i]) { tone(PIN_BUZZ, melody[i]); delay(ms * 0.9); silence(); delay(ms * 0.1); }
    else           { silence(); delay(ms); }
  }
  silence();
  delay(2000);
}
