#ifndef SENSORS_H
#define SENSORS_H

#include <Arduino.h>

// --- Pin assignments (fill actual pins) ---

// MQ-2 smoke
#define SMOKE_PIN A0
#define SMOKE_DIGITAL_PIN 22

// DHT11/DHT22 temp + humidity
#define DHT_PIN 23
#define DHT_TYPE DHT11   // or DHT22

// MPU6050 gyroscope — I2C pins 20 (SDA), 21 (SCL) fixed on Mega

// HC-SR04 ultrasonic
#define TRIG_PIN 24
#define ECHO_PIN 25

// MQ-135 air quality
#define AIRQ_PIN A1
#define AIRQ_DIGITAL_PIN 26

// Microphone
#define MIC_PIN A2

// --- Init ---
void sensorsInit();

// --- Reads ---
float readTemperature();
float readHumidity();
float readSmoke();
float readAirQuality();
float readDistance();
void  readGyroscope(float &roll, float &pitch, float &yaw);

#endif