/*
 * HC-05 AT-command passthrough  (Arduino Mega 2560)
 * --------------------------------------------------
 * Bridges the PC (USB Serial) <-> HC-05 (Serial1) so you can send AT
 * commands and check/fix the module's config (ROLE, baud, name, etc).
 *
 * WIRING (same Serial1 pins as normal operation):
 *   HC-05 RX  -> Mega D18 (TX1)   [use 1k series / divider, 5V->3.3V]
 *   HC-05 TX  -> Mega D19 (RX1)
 *   HC-05 GND -> Mega GND
 *   HC-05 VCC -> Mega 5V
 *   HC-05 EN/KEY -> 3.3V          <-- REQUIRED for AT mode
 *
 * ENTER AT MODE:
 *   1. Connect EN/KEY to 3.3V (or hold the module's button) BEFORE power.
 *   2. Power on the HC-05.  LED must blink SLOWLY (~once every 2s) = AT mode.
 *      (Fast blink = NOT in AT mode -> EN wasn't high at power-up, redo.)
 *   3. Upload this sketch, open Serial Monitor @ 9600.
 *   4. Set line ending to "Both NL & CR".
 *
 * USEFUL COMMANDS (type into the monitor):
 *   AT              -> OK              (confirms link)
 *   AT+VERSION?     -> firmware
 *   AT+ROLE?        -> +ROLE:0  (0 = SLAVE, required for PC to connect)
 *   AT+ROLE=0       -> set to SLAVE if it was 1
 *   AT+UART?        -> +UART:9600,0,0 (data-mode baud the PC uses)
 *   AT+UART=9600,0,0-> force 9600 if different
 *   AT+CMODE?       -> +CMODE:0 connects to any address
 *   AT+ORGL         -> factory reset (last resort)
 *
 * After fixing config: remove EN-from-3.3V, power-cycle -> module returns to
 * DATA mode (fast blink until a host connects), reflash the real firmware.
 *
 * Note: AT mode runs at 38400 by default; data mode is whatever AT+UART set.
 */

void setup() {
  Serial.begin(9600);     // to PC (USB)
  Serial1.begin(38400);   // HC-05 default AT-mode baud

  Serial.println(F("HC-05 AT passthrough ready."));
  Serial.println(F("LED must be SLOW-blinking (~2s) = AT mode. Fast = not in AT mode."));
  Serial.println(F("Set line ending to 'Both NL & CR'."));
  Serial.println(F("Try: AT   then   AT+ROLE?   AT+UART?"));
  Serial.println(F("---"));
}

void loop() {
  if (Serial.available())  Serial1.write(Serial.read());   // PC  -> HC-05
  if (Serial1.available()) Serial.write(Serial1.read());   // HC-05 -> PC
}
