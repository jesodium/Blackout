#include <BluetoothSerial.h>

BluetoothSerial SerialBT;

// Mega serial data on UART0 (GPIO3 RX — programming header, no soldering).
#define MEGA_BAUD 9600

void setup() {
  Serial.begin(MEGA_BAUD);
  SerialBT.begin("BLACKOUT-V1"); // appears as Bluetooth device name
}

void loop() {
  // Pass Mega serial → Bluetooth
  if (Serial.available()) {
    SerialBT.write(Serial.read());
  }
  // Pass Bluetooth → Mega serial (optional, for future use)
  if (SerialBT.available()) {
    Serial.write(SerialBT.read());
  }
}
