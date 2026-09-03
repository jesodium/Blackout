// Relay bench test: toggles D7 once a second. Builtin LED mirrors it.
// IMPORTANT NOTE: most relay boards are ACTIVE LOW (LOW = pulled in). Doesn't
// matter for a blink test — it clicks either way; flip if you want on-at-boot.
const int RELAY_PIN = 7;

void setup() {
  digitalWrite(RELAY_PIN, HIGH);   // level before pinMode, or it pulls in at boot
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(RELAY_PIN, LOW);
  digitalWrite(LED_BUILTIN, HIGH);
  delay(1000);
  digitalWrite(RELAY_PIN, HIGH);
  digitalWrite(LED_BUILTIN, LOW);
  delay(1000);
}
