// part of main.ino, #included where this section used to be -- order matters
#pragma once

// ---- sonar ----
// median of a few pings: one stray echo off a corner is worse than a slow reading
float pingCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  blePump();
  unsigned long us = pulseIn(ECHO_PIN, HIGH, SONAR_TIMEOUT_US);
  blePump();       // pulseIn blocks to SONAR_TIMEOUT_US with nothing in range
  return us > 0 ? us / 58.0 : -1;
}

// one ping per call, median over the last SONAR_ITER of them. sends are already
// SEND_INTERVAL apart, so the ring-down gap is free -- it used to be 3 pings back to
// back with a 60ms panelDelay between, ~200ms of dead time every pass, which is both
// the telemetry cadence and the command latency.
float medianPingCm() {
  sonarRing[sonarIdx] = pingCm();
  sonarIdx = (sonarIdx + 1) % SONAR_ITER;

  float s[SONAR_ITER];
  uint8_t n = 0;
  for (uint8_t i = 0; i < SONAR_ITER; i++) if (sonarRing[i] >= 0) s[n++] = sonarRing[i];
  if (n == 0) return -1;
  for (uint8_t i = 1; i < n; i++) {
    float key = s[i];
    int j = i - 1;
    while (j >= 0 && s[j] > key) { s[j + 1] = s[j]; j--; }
    s[j + 1] = key;
  }
  return s[n / 2];
}
