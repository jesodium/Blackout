// 3-pin buzzer bench test — Uno R4. Tells you which kind you have.
//
// Wiring:  VCC/+ -> 5V   GND/- -> GND   I/O (or S) -> D8
//
// D8 because it's a plain digital pin with nothing else on it: A0 is the MQ135,
// D0/D1 are the USB serial. tone() works on any digital pin on the R4, so a
// PWM-capable pin buys nothing here.

const int PIN_BUZZ = 8;

// IMPORTANT NOTE: 3-pin modules come both ways and the silkscreen rarely says.
// ACTIVE  = built-in oscillator, digitalWrite HIGH is a tone. tone() on one of
//           these does nothing useful, it just chops the same fixed pitch.
// PASSIVE = bare element, needs tone(); digitalWrite HIGH is a click, not a note.
// Some active modules are wired backwards (LOW = beep). The test below runs all
// three so you can hear which is yours, then set the flags and delete the rest.
const bool ACTIVE_LOW = false;

void beepOn()  { digitalWrite(PIN_BUZZ, ACTIVE_LOW ? LOW  : HIGH); }
void beepOff() { digitalWrite(PIN_BUZZ, ACTIVE_LOW ? HIGH : LOW);  }

void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 3000) {}
  pinMode(PIN_BUZZ, OUTPUT);
  beepOff();
}

void loop() {
  Serial.println("1) digitalWrite HIGH, 1s  (sound = ACTIVE buzzer)");
  beepOn();  delay(1000);
  beepOff(); delay(1000);

  Serial.println("2) digitalWrite LOW, 1s   (sound = ACTIVE, and ACTIVE_LOW)");
  digitalWrite(PIN_BUZZ, LOW); delay(1000);
  digitalWrite(PIN_BUZZ, HIGH); delay(1000);
  beepOff();

  Serial.println("3) tone() sweep 500-3000Hz (rising pitch = PASSIVE buzzer)");
  for (int f = 500; f <= 3000; f += 100) { tone(PIN_BUZZ, f); delay(60); }
  noTone(PIN_BUZZ);
  beepOff();

  Serial.println("--- silence 3s ---\n");
  delay(3000);
}
