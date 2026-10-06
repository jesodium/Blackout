// part of main.ino, #included where this section used to be -- order matters
#pragma once

// ---- buzzer ----
// tone() on this core is ticker-driven, so no pwm pin and nothing blocks. re-issuing it
// while it already sounds leaks a DigitalOut, so only ever write on a change, and park the
// pin low by hand afterwards — noTone() drops it wherever the last toggle left it.
String buzzLevel = "";
uint16_t buzzHz = 0;
#define buzzOn (buzzHz != 0)
unsigned long buzzAt = 0;

bool buzzEnabled = true;

struct BuzzNote { uint16_t hz; uint16_t ms; };
const BuzzNote PAIR_TUNE[] = { {1568,80}, {0,40}, {2093,140} };
const uint8_t PAIR_TUNE_N = sizeof(PAIR_TUNE) / sizeof(PAIR_TUNE[0]);
uint8_t tuneStep = PAIR_TUNE_N;
unsigned long tuneAt = 0;

void buzzPark() {
  noTone(BUZZ_PIN);
  pinMode(BUZZ_PIN, OUTPUT);
  digitalWrite(BUZZ_PIN, BUZZ_IDLE);
}

void buzzTone(uint16_t hz) {
  if (!buzzEnabled) hz = 0;
  if (hz == buzzHz) return;
  buzzHz = hz;
  if (hz) { tone(BUZZ_PIN, hz); return; }
  buzzPark();
}

void buzzSet(bool on) { buzzTone(on ? BUZZ_HZ : 0); }

void startPairTune() {
  tuneStep = 0;
  tuneAt = millis();
  buzzTone(PAIR_TUNE[0].hz);
  Serial.print("pair tune: "); Serial.print(PAIR_TUNE_N); Serial.println(" notes");
}

bool tickTune() {
  if (tuneStep >= PAIR_TUNE_N) return false;
  if (millis() - tuneAt < PAIR_TUNE[tuneStep].ms) return true;
  tuneAt = millis();
  if (++tuneStep >= PAIR_TUNE_N) { buzzTone(0); return false; }
  buzzTone(PAIR_TUNE[tuneStep].hz);
  return true;
}

void tickBuzz() {
  if (tickTune()) return;
  if (hudLevel != buzzLevel) {
    buzzLevel = hudLevel;
    buzzAt = millis();
    buzzSet(hudLevel == "bad" || hudLevel == "warn");
    return;
  }
  if (hudLevel == "bad") return;
  if (hudLevel != "warn") return;
  if (millis() - buzzAt < (buzzOn ? BUZZ_BEEP_MS : BUZZ_GAP_MS)) return;
  buzzAt = millis();
  buzzSet(!buzzOn);
}

void tickPanel() {
  unsigned long now = millis();
  if (now - lastOledPhase >= OLED_PHASE_INTERVAL) { lastOledPhase = now; oledFrame++; }
  if (now - lastOledDraw >= OLED_DRAW_INTERVAL) {
    lastOledDraw = now;
    stepSaver();
    updateOled();
  }
}
