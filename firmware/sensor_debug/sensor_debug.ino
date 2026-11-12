#include <Wire.h>
#include <Adafruit_BME280.h>
#include <DHT11.h>

#define TRIG_PIN 52
#define ECHO_PIN 50
#define DHT_PIN A5
#define MQ_PIN A1
#define BH1750_ADDR 0x23

Adafruit_BME280 bme;
DHT11 dht(DHT_PIN);
bool bmeOk = false, luxOk = false;
uint32_t gpsBytes = 0, lidarBytes = 0;

float sonarCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long us = pulseIn(ECHO_PIN, HIGH, 30000);
  return us > 0 ? us / 58.0 : -1;
}

float luxRead() {
  if (Wire2.requestFrom(BH1750_ADDR, 2) < 2) return -1;
  uint16_t raw = (Wire2.read() << 8) | Wire2.read();
  return raw / 1.2;
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  analogReadResolution(12);
  Wire1.begin();
  bmeOk = bme.begin(0x76, &Wire1) || bme.begin(0x77, &Wire1);
  Wire2.begin();
  Wire2.beginTransmission(BH1750_ADDR);
  Wire2.write(0x10);
  luxOk = (Wire2.endTransmission() == 0);
  dht.setDelay(0);
  Serial2.begin(9600);
  Serial3.begin(230400);
}

void loop() {
  unsigned long t0 = millis();
  while (millis() - t0 < 1000) {
    while (Serial2.available()) { Serial2.read(); gpsBytes++; }
    while (Serial3.available()) { Serial3.read(); lidarBytes++; }
  }

  int dt = -1, dh = -1;
  int r = dht.readTemperatureHumidity(dt, dh);
  if (r != 0) { dt = -1; dh = -1; }

  bool bmeUp = bmeOk;
  if (!bmeOk) bmeOk = bme.begin(0x76, &Wire1) || bme.begin(0x77, &Wire1);
  float bt = bmeOk ? bme.readTemperature() : -1;
  float bp = bmeOk ? bme.readPressure() / 100.0F : -1;

  Serial.print("sonar="); Serial.print(sonarCm());
  Serial.print(",dht_t="); Serial.print(dt);
  Serial.print(",dht_h="); Serial.print(dh);
  Serial.print(",bme_t="); Serial.print(bt);
  Serial.print(",bme_p="); Serial.print(bp);
  Serial.print(",lux="); Serial.print(luxOk ? luxRead() : -1);
  Serial.print(",mq="); Serial.print(analogRead(MQ_PIN));
  Serial.print(",gps="); Serial.print(gpsBytes);
  Serial.print(",lidar="); Serial.println(lidarBytes);
}
