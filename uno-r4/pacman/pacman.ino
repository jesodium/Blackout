// Pac-Man opening motif — SHORT FRAGMENT — 3-pin buzzer, Uno R4.
// I/O -> D8, VCC -> 5V, GND -> GND.
//
// IMPORTANT NOTE: copyrighted composition (Toshio Kai / Namco, 1980), so this
// is the opening hook only, not the theme. Extend the arrays yourself.
//
// IMPORTANT NOTE: by ear and APPROXIMATE. The arrays are the whole tune — fix
// an entry, reflash, nothing else moves.
//
// IMPORTANT NOTE: IDLE_HIGH stays true. LOW is this module's sounding state;
// writing LOW as "silence" is what caused the constant tone.

const int PIN_BUZZ = 8;
const int BPM = 240;              // tempo knob; the hook is fast
const bool IDLE_HIGH = true;      // this module's silent level

// n-prefixed: bare D5/A5 collide with the core's own pin macros on the R4.
const int nB4=494, nB5=988, nFS5=740, nDS5=622, nC6=1047, nG5=784, nE5=659;

const int melody[]   = { nB4, nB5, nFS5, nDS5, nB5, nFS5, nDS5, 0,
                         nC6, nG5, nE5,  nC6,  nG5, nE5,  0,    0 };
// beats x2: 1 = eighth, 2 = quarter
const int duration[] = {   1,   1,    1,    1,   1,    1,    2, 1,
                           1,   1,    1,    1,   1,    1,    2, 2 };
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
  Serial.println("pacman motif");
  for (int i = 0; i < N; i++) {
    int ms = duration[i] * eighth;
    if (melody[i]) { tone(PIN_BUZZ, melody[i]); delay(ms * 0.9); silence(); delay(ms * 0.1); }
    else           { silence(); delay(ms); }
  }
  silence();
  delay(1500);
}
