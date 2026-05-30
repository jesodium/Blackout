#include <DHT.h>
#include <NewPing.h>

#define DHT_PIN 23
#define DHT_TYPE DHT11
#define TRIG_PIN A0
#define ECHO_PIN A1

DHT dht(DHT_PIN, DHT_TYPE);
NewPing sonar(TRIG_PIN, ECHO_PIN, 400);

void setup() {
  Serial.begin(9600);
  Serial1.begin(9600);
  dht.begin();
}

void loop() {
  float temp = dht.readTemperature();
  float humid = dht.readHumidity();
  float dist = sonar.ping_cm();

  String line = "S:";
  line += temp; line += ",";
  line += humid; line += ",";
  line += dist; line += ",0,0,0,0,0";

  Serial.println(line);
  Serial1.println(line);
  delay(500);
}
