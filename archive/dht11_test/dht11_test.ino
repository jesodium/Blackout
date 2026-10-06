#include <DHT11.h>

#define DHTPIN 2   // D1 is TX0 on the Mega - unusable while Serial is up
DHT11 dht(DHTPIN);

void setup() {
  Serial.begin(9600);
  delay(1500);
}

void loop() {
  int t, h;
  if (dht.readTemperatureHumidity(t, h) == 0) {
    Serial.print("T="); Serial.print(t);
    Serial.print("C H="); Serial.print(h); Serial.println("%");
  } else {
    Serial.println("DHT11 read fail - check DATA pin/pullup");
  }
  delay(2000);  // DHT11 max ~1Hz; 2s is safe
}
