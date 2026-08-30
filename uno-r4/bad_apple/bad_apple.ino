// "Bad Apple!!" main riff — SHORT FRAGMENT — 3-pin buzzer, Uno R4.
// I/O -> D8, VCC -> 5V, GND -> GND.
//
// IMPORTANT NOTE: copyrighted composition (ZUN / Alstroemeria Records), so this
// is the riff's opening hook only, not the song. Extend the arrays yourself.
//
// IMPORTANT NOTE: by ear in D minor and APPROXIMATE. The arrays are the whole
// tune — fix an entry, reflash, nothing else moves.
//
// IMPORTANT NOTE: IDLE_HIGH stays true, same as tornado and mario. LOW is this
// module's sounding state; writing LOW as "silence" caused the constant tone.

const int PIN_BUZZ = 8;
const int BPM = 138;              // tempo knob; the track sits around here
const bool IDLE_HIGH = true;      // this module's silent level

// n-prefixed: bare D5/A5 collide with the core's own pin macros on the R4.
const int nD4=294, nE4=330, nF4=349, nG4=392, nA4=440, nAS4=466, nC5=523, nD5=587;

const int melody[]   = { nA4, nA4, nD5, nC5, nAS4, nA4, nG4, nA4,
                         nF4, nG4, nA4, nG4, nF4,  nE4, nD4, 0 };
// beats x2: 1 = eighth, 2 = quarter, 4 = half
const int duration[] = {   1,   1,   2,   1,    1,   1,   1,   2,
                           1,   1,   2,   1,    1,   1,   4, 2 };
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
  Serial.println("bad apple riff (fragment)");
  for (int i = 0; i < N; i++) {
    int ms = duration[i] * eighth;
    if (melody[i]) { tone(PIN_BUZZ, melody[i]); delay(ms * 0.9); silence(); delay(ms * 0.1); }
    else           { silence(); delay(ms); }
  }
  silence();
  delay(1500);
}
