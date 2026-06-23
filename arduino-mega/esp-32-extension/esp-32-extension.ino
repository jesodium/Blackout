// Blackout V1 — ESP32-WROOM (NodeMCU-32S) Bluetooth relay
// Mega Serial3 (D14 TX3) --voltage divider--> ESP32 GPIO16 (RX2)
// Forwards Mega CSV over Bluetooth Classic SPP as "BLACKOUT-V1".
// PC reads /dev/cu.BLACKOUT-V1. USB UART0 stays free for debug.

#include <BluetoothSerial.h>

BluetoothSerial SerialBT;

const int MEGA_RX = 16;   // GPIO16 (RX2) <- Mega TX3 via 1k/2k divider
const int MEGA_TX = 17;   // GPIO17 (TX2) -> Mega RX3 (unused for now, future commands)
const int LED     = 2;    // onboard blue LED

void setup() {
  Serial.begin(115200);            // USB debug
  Serial2.begin(9600, SERIAL_8N1, MEGA_RX, MEGA_TX);  // Mega link, match Mega baud
  SerialBT.begin("BLACKOUT-V1");
  pinMode(LED, OUTPUT);
  Serial.println("Relay up: Mega(Serial2 9600) -> BT 'BLACKOUT-V1'");
}

void loop() {
  // Mega -> BT (+ USB echo, + LED on traffic)
  while (Serial2.available()) {
    int c = Serial2.read();
    SerialBT.write(c);
    Serial.write(c);
    digitalWrite(LED, !digitalRead(LED));
  }
  // BT -> Mega (PC commands, future use)
  while (SerialBT.available()) {
    Serial2.write(SerialBT.read());
  }
}
