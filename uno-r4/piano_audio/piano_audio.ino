// Pitch-tracked from "MEGALOVANIA Piano Version.mp3" by uno-r4/tools/midi2tone.py
//   python3 midi2tone.py <file>.mp3 --audio --from 0 --dur 20 --fmin 250 --bpm 240
//
// First 20s only, 120-note cap — flash, not ambition. Re-run with a bigger
// --dur/--max for more.
//
// IMPORTANT NOTE: this came from AUDIO, not MIDI, so the notes are a guess and
// some are wrong. The tracker reports one pitch per frame; piano is polyphonic,
// so on a chord it picks whatever dominates. --fmin 250 puts the floor above the
// left hand, which cut the detected range from 43-86 down to 59-86 — that is
// the melody hand instead of the tracker flipping between the two. The MIDI path
// has no such problem: MIDIlovania.mid gave exact notes.
//
// IMPORTANT NOTE: IDLE_HIGH stays true. LOW is this module's sounding state.

const int PIN_BUZZ = 8;
const int BPM = 240;              // must match the --bpm the arrays were made at
const bool IDLE_HIGH = true;      // this module's silent level
const int  TRANSPOSE = 0;         // semitones; 12 = octave up, -12 = down

const int melody[] = {
    294,   440,     0,   415,   392,     0,   349,   294,
    349,   392,   262,   294,   440,     0,   415,   392,
      0,   349,   294,   349,   392,   247,   294,   440,
      0,   415,   392,     0,   349,   294,   349,   392,
    262,   294,   440,     0,   415,   988,   831,     0,
    740,   294,   349,   784,  1175,  1175,     0,  1175,
   1175,  1175,     0,  1175,     0,  1175,     0,   932,
   1175,     0,  1175,  1047,  1175,  1175,     0,  1175,
      0,   831,     0,   831,   880,     0,  1175,   622,
    440,  1175,     0,  1175,   932,     0,  1175,     0,
    988,     0,   932,  1175,  1175,   880,     0,   831,
    880,     0,   784,   740,   622,     0,   784,  1175,
   1047,  1175
};
const int duration[] = {
      4,     2,     1,     2,     2,     1,     2,     1,
      1,     1,     2,     2,     2,     1,     2,     2,
      1,     2,     1,     1,     1,     2,     2,     2,
      1,     2,     2,     1,     2,     1,     1,     1,
      2,     2,     2,     1,     1,     1,     1,     1,
      2,     1,     1,     1,     4,     1,     2,     2,
      2,     1,     1,     7,     1,     2,     2,     1,
      1,     4,     1,     1,     1,     1,     3,     2,
      3,     1,     5,     1,     1,     1,     2,     1,
      1,     2,     1,     1,     1,     1,     1,     4,
      1,     5,     1,     1,     1,     1,     1,     1,
      1,     1,     1,     1,     1,     1,     1,     1,
      1,     2
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
  Serial.println("megalovania piano (from audio)");
  for (int i = 0; i < N; i++) {
    int ms = duration[i] * eighth;
    if (melody[i]) { tone(PIN_BUZZ, pitch(melody[i])); delay(ms * 0.9); silence(); delay(ms * 0.1); }
    else           { silence(); delay(ms); }
  }
  silence();
  delay(1500);
}
