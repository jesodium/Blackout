#include "sensors.h"
#include <DHT.h>
#include <DHT_U.h>
#include <MPU6050_light.h>
#include <NewPing.h>
#include <MQUnifiedsensor.h>

// DHT
DHT dht(DHT_PIN, DHT_TYPE);

// MPU6050
MPU6050 mpu(Wire);

// HC-SR04
NewPing sonar(TRIG_PIN, ECHO_PIN, 200);

// MQ-2 smoke
MQUnifiedsensor mq2("Arduino Mega", 5.0, 10, SMOKE_PIN, "MQ-2");

// MQ-135 air quality
MQUnifiedsensor mq135("Arduino Mega", 5.0, 10, AIRQ_PIN, "MQ-135");

void sensorsInit() {
  dht.begin();

  Wire.begin();
  mpu.begin();
  mpu.calcOffsets(true, true);

  mq2.setRegressionMethod(1);
  mq2.setA(574.25); mq2.setB(-2.222);  // LPG curve
  mq2.init();

  mq135.setRegressionMethod(1);
  mq135.setA(102.2); mq135.setB(-2.473); // CO2 curve
  mq135.init();

  pinMode(SMOKE_DIGITAL_PIN, INPUT);
  pinMode(AIRQ_DIGITAL_PIN, INPUT);
}

float readTemperature() {
  return dht.readTemperature();
}

float readHumidity() {
  return dht.readHumidity();
}

float readSmoke() {
  mq2.update();
  return mq2.readSensor();
}

float readAirQuality() {
  mq135.update();
  return mq135.readSensor();
}

float readDistance() {
  return sonar.ping_cm();
}

void readGyroscope(float &roll, float &pitch, float &yaw) {
  mpu.update();
  roll  = mpu.getAngleX();
  pitch = mpu.getAngleY();
  yaw   = mpu.getAngleZ();
}