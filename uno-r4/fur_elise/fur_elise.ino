// Beethoven, Bagatelle in A minor "Für Elise" (1810) — 3-pin buzzer, Uno R4.
// I/O -> D8, VCC -> 5V, GND -> GND.
//
// Public domain, so the whole shape is here: the A theme both times through,
// the lyrical middle, and the tension + chromatic descent that leads back into
// the theme.
//
// IMPORTANT NOTE: the A theme is solid; the middle and the descent are by ear
// and APPROXIMATE, and this is a monophonic buzzer so the left hand is simply
// gone — what you get is the melody line, not the piece. The arrays are the
// whole tune: fix an entry, reflash, nothing else moves.
//
// IMPORTANT NOTE: IDLE_HIGH stays true. LOW is this module's sounding state;
// writing LOW as "silence" is what caused the constant tone.

const int PIN_BUZZ = 8;
const int BPM = 200;              // tempo knob; the opening runs in sixteenths
const bool IDLE_HIGH = true;      // this module's silent level

// Pitch knob, in semitones. 12 = one octave up, 7 = a fifth, -12 = back down.
// IMPORTANT NOTE: raising pitch also makes it LOUDER — a piezo resonates around
// 2-4kHz and is loudest there. Push this far and it goes shrill and thin.
const int TRANSPOSE = 12;

// n-prefixed: bare D5/A5 collide with the core's own pin macros on the R4.
const int nC4=262, nE4=330, nF4=349, nFS4=370, nG4=392, nGS4=415, nA4=440,
          nAS4=466, nB4=494, nC5=523, nCS5=554, nD5=587, nDS5=622, nE5=659;

const int melody[] = {
  // A theme, first time
  nE5, nDS5, nE5, nDS5, nE5, nB4, nD5, nC5,  nA4,
  nC4, nE4,  nA4, nB4,
  nE4, nGS4, nB4, nC5,
  nE4,
  // A theme, second time, with its closing turn
  nE5, nDS5, nE5, nDS5, nE5, nB4, nD5, nC5,  nA4,
  nC4, nE4,  nA4, nB4,
  nE4, nC5,  nB4, nA4,  0,
  // lyrical middle
  nC5, nD5,  nC5, nAS4, nA4, nG4, nF4, 0,
  nF4, nG4,  nA4, nAS4, nC5, nD5, nC5, 0,
  // tension, then the chromatic descent back into the theme
  nA4, nA4,  nA4, nA4,
  nE5, nDS5, nD5, nCS5, nC5, nB4, nAS4, nA4,
  nGS4, nG4, nFS4, nF4, nE4, 0,
  // theme returns to close
  nE5, nDS5, nE5, nDS5, nE5, nB4, nD5, nC5, nA4, 0
};
// beats x2: 1 = sixteenth-ish, 2 = longer, 3 = held, 4 = long
const int duration[] = {
  1, 1, 1, 1, 1, 1, 1, 1,   2,
  1, 1, 1,                  2,
  1, 1, 1,                  2,
  1,
  1, 1, 1, 1, 1, 1, 1, 1,   2,
  1, 1, 1,                  2,
  1, 1, 1,                  4, 2,
  1, 1, 1, 1, 1, 1, 3,      2,
  1, 1, 1, 1, 1, 1, 3,      2,
  1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 4,            2,
  1, 1, 1, 1, 1, 1, 1, 1, 4, 4
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
  else
    Serial.print("notes: "), Serial.println(N);
}

void loop() {
  const int eighth = 30000 / BPM;
  Serial.println("Fur Elise");
  for (int i = 0; i < N; i++) {
    int ms = duration[i] * eighth;
    if (melody[i]) { tone(PIN_BUZZ, pitch(melody[i])); delay(ms * 0.9); silence(); delay(ms * 0.1); }
    else           { silence(); delay(ms); }
  }
  silence();
  delay(2000);
}
