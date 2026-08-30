// Titanic theme ("My Heart Will Go On") — SHORT FRAGMENT — 3-pin buzzer, Uno R4.
// I/O -> D8, VCC -> 5V, GND -> GND.
//
// IMPORTANT NOTE: copyrighted composition (James Horner, 1997), so this is only
// the opening motif, not the song. Extend the two arrays yourself if you want
// more of it.
//
// IMPORTANT NOTE: transcribed by ear in C and APPROXIMATE. The arrays are the
// whole tune — fix an entry, reflash, nothing else moves.

const int PIN_BUZZ = 8;
const int BPM = 100;                 // tempo knob
const int OCTAVE_DOWN = 1;           // 0 = as written, 1 = quieter, 2 = quieter still

// n-prefixed: bare D5/A5 collide with the core's own pin macros on the R4.
const int nD4=294, nE4=330, nF4=349, nG4=392, nA4=440, nC5=523, nD5=587;

const int melody[]   = { nE4, nF4, nG4, nG4, nF4, nE4, nD4, 0,
                         nE4, nF4, nG4, nA4, nG4, nF4, nE4, nC5, nD5, 0 };
// beats x2: 1 = eighth, 2 = quarter, 4 = half, 6 = dotted half
const int duration[] = { 1, 1, 4, 2, 1, 1, 6, 2,
                         1, 1, 4, 2, 1, 1, 4, 2, 6, 4 };
const int N = sizeof(melody) / sizeof(melody[0]);

// THE FIX: noTone() on the Renesas core does not guarantee the pin is left LOW,
// and a pin parked HIGH is a DC drive into the buzzer — an active module sits
// there screaming between notes, and a passive one whines. Every silence has to
// be an explicit digitalWrite LOW, not just the absence of a tone.
void silence() { noTone(PIN_BUZZ); digitalWrite(PIN_BUZZ, LOW); }

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
  Serial.println("Titanic theme (opening motif)");
  for (int i = 0; i < N; i++) {
    int ms = duration[i] * eighth;
    if (melody[i]) tone(PIN_BUZZ, melody[i] >> OCTAVE_DOWN, ms * 0.9);
    delay(ms);
    silence();
  }
  silence();
  delay(2000);
}
