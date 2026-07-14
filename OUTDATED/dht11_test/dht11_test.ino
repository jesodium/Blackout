#include <DHT.h>

#define DHTPIN 2
#define DHTTYPE DHT11
DHT dht(DHTPIN, DHTTYPE);

void setup() {
  Serial.begin(9600);
  delay(1500);
  dht.begin();
}

void loop() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (isnan(t) || isnan(h)) {
    Serial.println("DHT11 read fail - check DATA pin/pullup");
  } else {
    Serial.print("T="); Serial.print(t);
    Serial.print("C H="); Serial.print(h); Serial.println("%");
  }
  delay(2000);  // DHT11 max ~1Hz; 2s is safe
}
