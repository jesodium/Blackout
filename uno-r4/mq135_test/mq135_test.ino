// MQ135 bench test — Uno R4 (Minima/WiFi). Analog only, DO pin unused.
//
// Wiring:  VCC -> 5V   GND -> GND   AO -> A0   DO -> (leave off)
// Heater pulls ~150mA at 5V; fine off USB, but it gets warm — that's normal.
//
// Pins: A0 chosen because it's plain ADC, no I2C/SPI/PWM conflict, and the R4's
// 5V-referenced ADC matches the module's 0-5V output directly (no divider).

const int PIN_AO = A0;

// Bench knobs — measure, don't trust the datasheet.
const float VREF     = 5.0;    // R4 ADC reference
const int   ADC_BITS = 14;     // R4 does 14-bit; 16383 counts
const float ADC_MAX  = 16383.0;
const float RL       = 10.0;   // kohm load resistor ON YOUR BOARD. Many MQ135
                               // breakouts fit 1k, not 10k — read it off the
                               // silkscreen before believing any ppm number.
// Ro = sensor resistance in clean air. MEASURED, never guessed: run the sketch,
// let it sit hot in clean air for 10+ min, send 'c' over serial, paste the
// number it prints in here. Boot-time auto-calibration was WRONG — at 20s the
// heater is still warming, Rs is 4x too high, and every ppm after it drifts up
// on its own. Sensor also wants 24h powered burn-in before this is stable.
float Ro = 2.9;                // kohm

// IMPORTANT NOTE: Rs/Ro -> ppm is the CO2 curve fit off the MQ135 datasheet.
// It is an estimate, not a measurement: no temp/humidity compensation, and the
// sensor needs 24h powered burn-in before Ro means anything. Add compensation
// only if the reading has to be a number someone acts on.
const float PPM_A = 116.6020682;
const float PPM_B = -2.769034857;
const float RO_CLEAN_AIR = 3.6;   // Rs/Ro in clean air, per datasheet

float readRs() {
  float v = analogRead(PIN_AO) * VREF / ADC_MAX;
  if (v < 0.01) return -1;                 // shorted / unplugged
  return RL * (VREF - v) / v;
}

void calibrate() {                          // run in clean outdoor-ish air
  float sum = 0;
  for (int i = 0; i < 50; i++) { sum += readRs(); delay(100); }
  Ro = (sum / 50.0) / RO_CLEAN_AIR;
}

void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 3000) {}
  analogReadResolution(ADC_BITS);
  Serial.print("MQ135. Ro = "); Serial.print(Ro);
  Serial.println(" kohm. Send 'c' in clean air (hot >10min) to recalibrate.");
  Serial.println("raw\tvolts\tRs(k)\tRs/Ro\tppm~");
}

void loop() {
  if (Serial.available() && Serial.read() == 'c') {
    Serial.println("calibrating 5s...");
    calibrate();
    Serial.print("Ro = "); Serial.print(Ro);
    Serial.println(" kohm  <- put this in the sketch");
  }

  int raw = analogRead(PIN_AO);
  float v  = raw * VREF / ADC_MAX;
  float rs = readRs();
  float ratio = rs / Ro;
  float ppm = PPM_A * pow(ratio, PPM_B);

  Serial.print(raw);   Serial.print('\t');
  Serial.print(v, 3);  Serial.print('\t');
  Serial.print(rs, 2); Serial.print('\t');
  Serial.print(ratio, 2); Serial.print('\t');
  if (rs < 0) Serial.println("NOT READING");
  else Serial.println(ppm, 0);

  delay(1000);
}
