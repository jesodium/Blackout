#include <DHT.h>
#include <NewPing.h>

#define DHT_PIN 23
#define DHT_TYPE DHT11
#define TRIG_PIN A0
#define ECHO_PIN A1
#define SONAR_MAX 400
#define DHT_INTERVAL 2000
#define SONAR_INTERVAL 50

DHT dht(DHT_PIN, DHT_TYPE);
NewPing sonar(TRIG_PIN, ECHO_PIN, SONAR_MAX);

unsigned long lastDht = 0;
unsigned long lastSonar = 0;
float temp = 0, humid = 0;

void setup() {
  Serial.begin(9600);
  Serial1.begin(9600);
  dht.begin();
  temp = dht.readTemperature();
  humid = dht.readHumidity();
}

void loop() {
  unsigned long now = millis();

  if (now - lastDht >= DHT_INTERVAL) {
    lastDht = now;
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (!isnan(t)) temp = t;
    if (!isnan(h)) humid = h;
  }

  if (now - lastSonar >= SONAR_INTERVAL) {
    lastSonar = now;
    float dist = sonar.ping_cm();

    String line = "S:";
    line += temp; line += ",";
    line += humid; line += ",";
    line += dist; line += ",0,0,0,0,0";

    Serial.println(line);
    Serial1.println(line);
  }
}
