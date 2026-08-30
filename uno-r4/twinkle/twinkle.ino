// Twinkle Twinkle Little Star on the 3-pin buzzer — Uno R4.
// I/O -> D8, VCC -> 5V, GND -> GND.
//
// Melody is "Ah! vous dirai-je, maman" (1761), public domain, so this is the
// whole tune rather than a fragment.
//
// IMPORTANT NOTE: needs a PASSIVE buzzer. An active one honks one fixed pitch
// through the whole thing — rhythm survives, melody doesn't.

const int PIN_BUZZ = 8;
const int BPM = 100;                 // tempo knob
const int OCTAVE_DOWN = 1;           // 0 = as written, 1 = quieter, 2 = quieter still

// n-prefixed: bare D5/A5 collide with the core's own pin macros on the R4.
const int nC4=262, nD4=294, nE4=330, nF4=349, nG4=392, nA4=440;

const int melody[] = {
  nC4,nC4,nG4,nG4,nA4,nA4,nG4,          // twinkle twinkle little star
  nF4,nF4,nE4,nE4,nD4,nD4,nC4,          // how I wonder what you are
  nG4,nG4,nF4,nF4,nE4,nE4,nD4,          // up above the world so high
  nG4,nG4,nF4,nF4,nE4,nE4,nD4,          // like a diamond in the sky
  nC4,nC4,nG4,nG4,nA4,nA4,nG4,          // twinkle twinkle little star
  nF4,nF4,nE4,nE4,nD4,nD4,nC4, 0        // how I wonder what you are
};
// beats x2: 2 = quarter, 4 = half
const int duration[] = {
  2,2,2,2,2,2,4,
  2,2,2,2,2,2,4,
  2,2,2,2,2,2,4,
  2,2,2,2,2,2,4,
  2,2,2,2,2,2,4,
  2,2,2,2,2,2,4, 4
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
  // Same length or the tune walks off the end of one array — a silent
  // out-of-bounds read on a board with no MPU.
  if (N != (int)(sizeof(duration) / sizeof(duration[0])))
    Serial.println("BUG: melody/duration length mismatch");
}

void loop() {
  const int eighth = 30000 / BPM;                       // ms per half-beat
  Serial.println("Twinkle Twinkle Little Star");
  for (int i = 0; i < N; i++) {
    int ms = duration[i] * eighth;
    if (melody[i]) tone(PIN_BUZZ, melody[i] >> OCTAVE_DOWN, ms * 0.9);
    delay(ms);
    silence();
  }
  silence();
  delay(2000);
}
