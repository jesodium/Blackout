#include <DHT.h>
#include <NewPing.h>

#define DHT_PIN 42
#define DHT_TYPE DHT11
#define TRIG_PIN A6
#define ECHO_PIN A5
#define SONAR_MAX 400
#define SONAR_ITER 3      // pings per reading; NewPing returns the median, drops spikes
                          // (~29ms between pings, so ~60-90ms blocking per reading)
#define DIST_ALPHA 0.25   // EMA smoothing on distance (lower = smoother, more lag)
#define DHT_INTERVAL 1000
#define SONAR_INTERVAL 50


#define MQ2_AO A0
#define MQ2_DO 22
#define MQ135_AO A1
#define MQ135_DO 26
#define MQ9_AO A3
#define MQ9_DO 29

// Gas sensors (MQ-2/135/9) are noisy. Burst-average each read, then run an EMA
// across cycles. Tune these: more samples / lower alpha = smoother but laggier.
#define GAS_SAMPLES 8
#define GAS_ALPHA 0.15

// --- MQ-9 CO calibration ---
// 1) MEASURE your module's load resistor (RL) with a multimeter, set it here (kΩ).
//    Cheap MQ-9 boards are often 10k, but verify — wrong RL = wrong ppm.
#define MQ9_RL 10.0
// 2) Rs/R0 in clean air, from the MQ-9 datasheet curve. ~9.8 is a common start; tune.
#define MQ9_CLEAN_RATIO 9.8
// 3) Warm-up before R0 is captured (ms). 3 min minimum; longer is better.
#define MQ9_WARMUP_MS 180000UL
// 3b) Clean-air baseline (kΩ). Leave at -1 to MEASURE: after warm-up it prints
//     "MQ9 MEASURED R0=..." — copy that number here and re-flash. Once set (>0),
//     this fixed value is used every boot (no re-calibration).
// TODO(mq9-cal): Option B not finished. The loop below STILL auto-cals every boot
//   (uses mq9Calibrated, ignores this #define). Next: rewrite the loop so MQ9_R0>0
//   means "use fixed value, no cal", and -1 means "measure once + print for me to
//   paste". Then flash with -1, warm up 5-10 min in clean air, capture R0, hardcode
//   it. Also still TODO: real MQ9_CURVE_M/B from datasheet, verify MQ9_RL. See TODO.md
#define MQ9_R0 -1.0
// 4) CO curve: log10(ppm) = M*log10(Rs/R0) + B. Derive M,B from TWO points on the
//    datasheet's CO line (see steps in chat). These are PLACEHOLDERS — replace them.
#define MQ9_CURVE_M -0.77
#define MQ9_CURVE_B 1.70

DHT dht(DHT_PIN, DHT_TYPE);
NewPing sonar(TRIG_PIN, ECHO_PIN, SONAR_MAX);

unsigned long lastDht = 0;
unsigned long lastSonar = 0;
float temp = 0, humid = 0;
float smokeF = -1, airqF = -1, coF = -1; // EMA state, -1 = uninitialised
float distF = -1;                        // EMA state for distance, -1 = uninitialised
float mq9_R0 = 0;                        // clean-air baseline, set after warm-up
bool mq9Calibrated = false;

// Average GAS_SAMPLES analogReads to kill per-sample ADC noise.
int readAvg(int pin) {
  long sum = 0;
  for (uint8_t i = 0; i < GAS_SAMPLES; i++) sum += analogRead(pin);
  return sum / GAS_SAMPLES;
}

// Sensor resistance (kΩ) from a 0-1023 ADC reading.
float mq9Rs(int adc) {
  if (adc <= 0) adc = 1; // guard divide-by-zero
  return MQ9_RL * (1023.0 - adc) / adc;
}

void setup() {
  Serial.begin(9600);
  Serial3.begin(9600);  // TX3 = D14 -> series 1k -> ESP32 GPIO16
  pinMode(MQ2_DO, INPUT);
  pinMode(MQ135_DO, INPUT);
  pinMode(MQ9_DO, INPUT);
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
    // Median of SONAR_ITER pings drops spikes; EMA on top smooths the stream.
    // ping_median returns microseconds (0 = no echo / out of range).
    unsigned int us = sonar.ping_median(SONAR_ITER);
    if (us > 0) {
      float raw = sonar.convert_cm(us);
      distF = (distF < 0) ? raw : distF + DIST_ALPHA * (raw - distF);
    }
    float dist = (distF < 0) ? 0 : distF;
    int smokeRaw = readAvg(MQ2_AO);
    int airqRaw  = readAvg(MQ135_AO);
    int coRaw    = readAvg(MQ9_AO);
    int coAlert  = digitalRead(MQ9_DO);

    // EMA across cycles: seed on first read, then low-pass.
    smokeF = (smokeF < 0) ? smokeRaw : smokeF + GAS_ALPHA * (smokeRaw - smokeF);
    airqF  = (airqF  < 0) ? airqRaw  : airqF  + GAS_ALPHA * (airqRaw  - airqF);
    coF    = (coF    < 0) ? coRaw    : coF    + GAS_ALPHA * (coRaw    - coF);
    int smoke = (int)(smokeF + 0.5);
    int airq  = (int)(airqF + 0.5);
    int co    = (int)(coF + 0.5);

    // One-shot clean-air calibration once warm-up has elapsed. KEEP THE SENSOR IN
    // FRESH AIR until you see the "MQ9 CALIBRATED" line.
    if (!mq9Calibrated && now >= MQ9_WARMUP_MS) {
      mq9_R0 = mq9Rs(co) / MQ9_CLEAN_RATIO;
      mq9Calibrated = true;
      Serial.print("MQ9 CALIBRATED  R0(kohm)="); Serial.println(mq9_R0, 2);
    }
    // Live CO ppm estimate (printed for verification; not yet in the BT packet).
    if (mq9Calibrated) {
      float ratio = mq9Rs(co) / mq9_R0;
      float ppm = pow(10.0, MQ9_CURVE_M * log10(ratio) + MQ9_CURVE_B);
      Serial.print("MQ9 raw="); Serial.print(co);
      Serial.print(" Rs/R0="); Serial.print(ratio, 2);
      Serial.print(" CO_ppm="); Serial.println(ppm, 0);
    }

    String line = "S:";
    line += temp;  line += ",";
    line += humid; line += ",";
    line += dist;  line += ",";
    line += smoke; line += ",";
    line += airq;  line += ",0,0,0,";
    line += co;    line += ",";
    line += coAlert;

    Serial.println(line);
    Serial3.println(line);
  }
}
