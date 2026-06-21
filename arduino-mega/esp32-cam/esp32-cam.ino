#include <BluetoothSerial.h>

BluetoothSerial SerialBT;
unsigned long count = 0;

void setup() {
  Serial.begin(115200);
  SerialBT.begin("BLACKOUT-V1");
  pinMode(4, OUTPUT);
}

void loop() {
  String csv = "S:25.3,60.1,45,280,320,0,0,0,200,0";
  csv += "|seq:";
  csv += count++;
  Serial.println(csv);
  SerialBT.println(csv);
  digitalWrite(4, !digitalRead(4));
  delay(500);
}
