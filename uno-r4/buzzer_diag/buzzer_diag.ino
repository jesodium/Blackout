// Buzzer diagnostic — finds out WHY it sounds when it shouldn't.
// Wiring unchanged: VCC -> 5V, GND -> GND, I/O -> D8.
//
// Four phases, 3s each, announced over serial. Listen and note which ones make
// noise. Each phase eliminates a different cause:
//
//  A INPUT (pin not driven at all, high-Z)
//      sound here  -> D8 does not control the buzzer. It is an ACTIVE module
//                     sounding off VCC alone, or the signal wire is on the
//                     wrong pin of the module. No sketch can fix that.
//      silent here -> D8 does control it, read on.
//  B LOW   sound here -> ACTIVE-LOW module. Idle state must be HIGH.
//  C HIGH  sound here -> ACTIVE-HIGH module (the normal kind). Idle is LOW.
//  D tone() rising sweep
//      rising pitch -> PASSIVE, melodies work.
//      flat honk    -> ACTIVE, it only ever makes its own one pitch.

const int PIN_BUZZ = 8;

void phase(const char *label) { Serial.println(label); delay(3000); }

void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 3000) {}
}

void loop() {
  pinMode(PIN_BUZZ, INPUT);              // no drive, no pullup
  phase("A: INPUT / high-Z  (sound = D8 is not the control pin)");

  pinMode(PIN_BUZZ, OUTPUT);
  digitalWrite(PIN_BUZZ, LOW);
  phase("B: LOW              (sound = ACTIVE-LOW module)");

  digitalWrite(PIN_BUZZ, HIGH);
  phase("C: HIGH             (sound = ACTIVE-HIGH module)");

  Serial.println("D: tone sweep 500-3000Hz (rising = PASSIVE, flat = ACTIVE)");
  for (int f = 500; f <= 3000; f += 100) { tone(PIN_BUZZ, f); delay(100); }
  noTone(PIN_BUZZ);
  digitalWrite(PIN_BUZZ, LOW);

  Serial.println("--- restarting ---\n");
  delay(2000);
}
