// Generated from MIDIlovania.mid by uno-r4/tools/midi2tone.py
//   python3 midi2tone.py MIDIlovania.mid --track 10 --from 49 --dur 22 --bpm 240
//
// Track 10 ('Trumpet'), the 49-79s middle lead, first 22s of it. Found with
// --list: it's the only track in a high register (73-85) that starts mid-file,
// which is what a solo line looks like in a track listing.
//
// Other candidates if this is the wrong one:
//   --track 5  --from 31 --dur 16   'Square',    range 70-86, plays 31-47s
//   --track 7  --from 40 --dur  7   'Polysynth', range 65-86, plays 40-47s
//
// IMPORTANT NOTE: monophonic — one voice out of 19. The backing that makes a
// solo sound like a solo isn't here, and can't be on a single buzzer.
//
// IMPORTANT NOTE: IDLE_HIGH stays true. LOW is this module's sounding state.

const int PIN_BUZZ = 8;
const int BPM = 240;              // must match the --bpm the arrays were made at
const bool IDLE_HIGH = true;      // this module's silent level
const int  TRANSPOSE = 0;         // semitones; 12 = octave up, -12 = down

const int melody[] = {
    698,     0,   587,     0,   698,     0,   784,     0,
    831,     0,   784,     0,   698,     0,   587,     0,
    831,     0,   784,     0,   698,     0,   587,     0,
    698,     0,   784,   831,     0,   880,     0,  1047,
      0,   880,     0,   831,     0,   784,     0,   698,
      0,   587,     0,   659,   698,     0,   784,     0,
    880,     0,  1047,     0,  1109,   831,     0,   831,
    784,   698,   784,     0,   880,     0,   831,     0,
    784,     0,   740,     0,   698,     0,   659,     0,
    622,     0,   587,     0,   554,     0,   622,     0,
    698,     0,   587,     0,   698,     0,   784,     0,
    831,     0,   784,     0,   698,     0,   587,     0,
    831,     0,   784,     0,   698,     0,   587,     0,
    698,     0,   784,   831,     0,   880,     0,  1047,
      0,   880,     0,   831,     0,   784,     0,   698
};
const int duration[] = {
      1,     1,     1,     1,     1,     1,     1,     1,
      1,     1,     1,     1,     1,     1,     1,     1,
      1,     1,     1,     1,     1,     1,     1,     1,
      1,     1,    10,     1,     1,     1,     1,     1,
      1,     1,     1,     1,     1,     1,     1,     1,
      1,     1,     1,     1,     1,     1,     1,     1,
      1,     1,     1,     1,     2,     1,     1,     1,
      1,     1,     9,    40,     1,     1,     1,     1,
      1,     1,     1,     1,     1,     1,     1,     1,
      1,     1,     1,     1,     7,     1,     8,     8,
      1,     1,     1,     1,     1,     1,     1,     1,
      1,     1,     1,     1,     1,     1,     1,     1,
      1,     1,     1,     1,     1,     1,     1,     1,
      1,     1,    10,     1,     1,     1,     1,     1,
      1,     1,     1,     1,     1,     1,     1,     1
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
  Serial.println("MIDIlovania - solo (track 10)");
  for (int i = 0; i < N; i++) {
    int ms = duration[i] * eighth;
    if (melody[i]) { tone(PIN_BUZZ, pitch(melody[i])); delay(ms * 0.9); silence(); delay(ms * 0.1); }
    else           { silence(); delay(ms); }
  }
  silence();
  delay(1500);
}
