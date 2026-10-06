#include <ArduinoBLE.h>
#include <Wire.h>
#include <Adafruit_BME280.h>
#include <DHT11.h>
#include <U8g2lib.h>
#include "routines.h"
#include "blkvm.h"
#include "arm.h"

// ---- pins ----
// relays are active low, and they sit outside the d2-d13 pwm band on purpose:
// a relay can't be dimmed, pwm just chatters the coil.
#define TRIG_PIN 52
#define ECHO_PIN 50

#define DHT_PIN A5

#define RELAY_CAM_LED 26
#define RELAY_STRIP   28
#define RELAY_LED     30
#define RELAY_ON  LOW
#define RELAY_OFF HIGH
static const uint8_t RELAY_PINS[] = {RELAY_CAM_LED, RELAY_STRIP, RELAY_LED};

#define LOOP_STALL_MS 150   // ~10 connection intervals at 7.5-15ms

#define BUZZ_PIN 72
#define BUZZ_SOUND LOW
#define BUZZ_IDLE  HIGH
#define BUZZ_HZ 2400
#define BUZZ_BEEP_MS 120
#define BUZZ_GAP_MS 600

#define OLED_ADDR   0x3C
#define OLED_I2C_HZ 400000    // the specced clock. 1M is the usual overclock but the panel came
                              // up dark on it here (2026-09-02) -- it acks at 0x3C either way,
                              // so raise it again only with the panel in front of you.


#define OLED_W 128
#define OLED_H 64
U8G2_SSD1306_128X64_NONAME_F_SW_I2C oled(U8G2_R0, U8X8_PIN_NONE, U8X8_PIN_NONE, U8X8_PIN_NONE);

// u8g2's HW_I2C constructor only knows the `Wire` object, and `Wire` is the arm's PCA9685
// bus and nothing else on purpose (a stalled servo browns the chip out and it clamps SDA).
// so the panel gets its own byte callback on Wire1 (sda1 d102 / scl1 d101), next to the bme280.
// the SW_I2C constructor above is only there for its gpio/delay callback -- byte_cb is
// replaced in setup(), so no pin is ever bit-banged.
// Wire1's txBuffer is 256B and a tile row is 1 control byte + 128 data, so it fits.

// ---- ble pump ----
// ArduinoBLE on mbed runs the HCI transport in its own thread, parking received
// packets in a fixed buffer that the SKETCH thread has to drain by calling
// BLE.poll(). When that buffer fills the controller's packets are DROPPED, not
// queued (HCICordioTransport.cpp) — so a command never arrives and the link goes
// quiet for no visible reason, then comes back. Polling once a loop() pass is not
// enough here: an oled frame is ~23ms of i2c and pulseIn() can sit for
// SONAR_TIMEOUT_US, both longer than the 30-50ms connection interval.
// This is why the stall showed up in the dashboard and the Electron app too — it
// was never the host, and no host-side fix could have touched it.
// Anything added to loop() that blocks longer than a connection interval pumps.
bool bleReady = false;                 // poll() before begin() has no transport
inline void blePump() { if (bleReady) BLE.poll(); }

#include "blackbox.h"

// ---- ble ----
BLEService sensorService("19b10000-e8f2-537e-4f6c-d104768a1214");
BLEStringCharacteristic sensorChar("19b10001-e8f2-537e-4f6c-d104768a1214", BLERead | BLENotify, 100);

BLEStringCharacteristic cmdChar("19b10002-e8f2-537e-4f6c-d104768a1214", BLEWrite | BLEWriteWithoutResponse, 64);

const Step* routine = nullptr;
uint8_t stepIdx = 0;
unsigned long stepStart = 0;

// ---- sensors ----
// all on 3v3: the giga's pins are not 5v tolerant
Adafruit_BME280 bme;
bool bmeOk = false;

uint8_t bmeMiss = 0;
const uint8_t BME_MISS_MAX = 5;
unsigned long lastBmeTry = 0;
const unsigned long BME_RETRY_MS = 5000;
DHT11 dht(DHT_PIN);
int temp = 0, humid = 0;
float pressure = 0;
float distCm = 999;

#define BH1750_ADDR 0x23
#define BH1750_CONT_HRES 0x10
bool luxOk = false;
float lux = 0;

float readLux() {
  if (Wire2.requestFrom(BH1750_ADDR, 2) < 2) return -1;
  uint16_t raw = (Wire2.read() << 8) | Wire2.read();
  return raw / 1.2f;
}

unsigned long lastSend = 0;
unsigned long lastEnv = 0;
float distF = -1;
float sonarRing[SONAR_ITER];
uint8_t sonarIdx = 0;


#include "panel.h"

#include "savers.h"

#include "buzzer.h"

// ---- setup ----
void setup() {
  resetBits = RCC->RSR;            // read before anything clears it
  RCC->RSR |= RCC_RSR_RMVF;        // and clear, or every later boot reads this one
  logEvt(LOG_BOOT, resetBits);
  Serial.begin(9600);
  Serial.setTimeout(50);
  pinMode(TRIG_PIN, OUTPUT);
  for (uint8_t i = 0; i < SONAR_ITER; i++) sonarRing[i] = -1;  // 0 would read as a wall at 0cm

  pinMode(ECHO_PIN, INPUT_PULLDOWN);

  // bme sits on SDA1/SCL1 (d102/d101 = Wire1), not the d20/d21 Wire bus.
  Wire1.begin();
  bmeOk = bme.begin(0x76, &Wire1) || bme.begin(0x77, &Wire1);
  Serial.println(bmeOk ? "BME280 ok" : "BME280 not found");

  armBegin();   // pca9685 on Wire (d20/d21); jogged by the ble arm, cmd

  // The DHT11 lib delay()s 500ms inside every read to enforce the sensor's ~1Hz
  // max rate. ENV_INTERVAL (2s) already paces it, so that delay is pure blind
  // spot -- 550ms with no BLE.poll(), ~40-70 missed connection events at a
  // 7.5-15ms interval, which drops inbound packets and reads as a dead link.
  // The black box logged it as "loop stall 550ms" every 2s, forever.
  dht.setDelay(0);

  Wire2.begin();
  Wire2.beginTransmission(BH1750_ADDR);
  Wire2.write(BH1750_CONT_HRES);
  luxOk = (Wire2.endTransmission() == 0);
  Serial.println(luxOk ? "BH1750 ok" : "BH1750 not found");

  oled.getU8x8()->byte_cb = oledI2c1;
  oled.setI2CAddress(OLED_ADDR << 1);
  oled.setBusClock(OLED_I2C_HZ);

  delay(100);   // panel's charge pump rail comes up slower than the h747; begin() into an
                // unsettled rail is half the dark-at-boot cases.
  oled.begin();
  oled.setContrast(255);
  updateOled();

  for (uint8_t p : RELAY_PINS) { digitalWrite(p, RELAY_OFF); pinMode(p, OUTPUT); }
  buzzPark();
  for (uint8_t p : MOTOR_PINS) { pinMode(p, OUTPUT); digitalWrite(p, LOW); }
  pinMode(ENA, OUTPUT); pinMode(ENB, OUTPUT);
  analogWrite(ENA, 0); analogWrite(ENB, 0);

  if (!BLE.begin()) {
    while (1) { Serial.println("BLE init failed"); delay(1000); }
  }

  BLE.setDeviceName(BOARD_NAME);   // GAP name: without it this stays "Arduino",
                                   //  which is what a name-matching central reads
  BLE.setLocalName(BOARD_NAME);    // advertisement name: what a scanner shows

  // 7.5-15ms. The old 30-50ms was picked off SEND_INTERVAL (100ms) -- but that is
  // the *telemetry* cadence, and telemetry is not what an operator feels. An
  // inbound command can only be delivered on a connection event, so the interval
  // IS the manual-drive latency floor: at 30-50ms a stick move waited up to a
  // frame before the board even saw it. This is a request, not a setting -- the
  // central picks the final value (macOS/Chrome usually honours it), so a busy
  // 2.4ghz venue can still land on the slower end by itself.
  BLE.setConnectionInterval(6, 12);
  BLE.setAdvertisedService(sensorService);
  sensorService.addCharacteristic(sensorChar);
  sensorService.addCharacteristic(cmdChar);
  BLE.addService(sensorService);
  BLE.advertise();
  bleReady = true;                     // blePump() is live from here
  Serial.println("BLE advertising as " BOARD_NAME);
  startPairTune();
}

#include "motors.h"

#include "vm.h"

#include "commands.h"

#include "sonar.h"

// ---- loop ----
void loop() {
  // a pass longer than a couple of connection intervals is BLE.poll() starvation
  // — the thing that drops commands and can look exactly like a disconnect, so
  // the log has to name it or the ring only ever says "ble down" with no cause.
  static unsigned long lastPass = 0;
  unsigned long pass = millis();
  if (lastPass && pass - lastPass > LOOP_STALL_MS) logEvt(LOG_STALL, pass - lastPass);
  lastPass = pass;

  BLE.poll();

  bool nowConnected = BLE.central();
  if (nowConnected != bleConnected) {
    bleConnected = nowConnected;
    unsigned long was = connectAt;
    connectAt = millis();
    logEvt(bleConnected ? LOG_BLE_UP : LOG_BLE_DOWN, connectAt - was);
    Serial.println(bleConnected ? "BLE central connected" : "BLE central gone");

    if (!bleConnected) { hudLevel = ""; hudMetrics = ""; saver = SCR_OFF; startPairTune(); }
    updateOled();
  }

  if (cmdChar.written()) handleCmd(cmdChar.value());
  if (Serial.available()) handleCmd(Serial.readStringUntil('\n'));

  tickRoutine();
  tickDrive();
  tickBlk();

  tickPanel();
  tickBuzz();
  armTick();

  unsigned long now = millis();
  bool busy = routine || blkPc >= 0 || blkLoading || drvEnd;

  if (now - lastSend < (saver && !busy ? SAVER_SEND_INTERVAL : SEND_INTERVAL)) return;
  lastSend = now;

  distF = medianPingCm();
  float dist = (distF < 0) ? 999 : distF;
  distCm = dist;

  if (now - lastEnv >= (saver && !busy ? SAVER_ENV_INTERVAL : ENV_INTERVAL)) {
    lastEnv = now;
    int t = 0, h = 0;

    if (dht.readTemperatureHumidity(t, h) == 0) { temp = t; humid = h; }
    blePump();       // the dht bit-bangs its one-wire protocol for ~30ms
    if (bmeOk) {
      float p = bme.readPressure() / 100.0F;
      if (p > 300 && p < 1100) { pressure = p; bmeMiss = 0; }
      else if (++bmeMiss >= BME_MISS_MAX) { bmeOk = false; pressure = 0; }
    } else if (now - lastBmeTry >= BME_RETRY_MS) {
      lastBmeTry = now;
      bmeOk = bme.begin(0x76, &Wire1) || bme.begin(0x77, &Wire1);
      if (bmeOk) { bmeMiss = 0; Serial.println("BME280 back"); }
    }
    if (luxOk) {
      float l = readLux();
      if (l >= 0) lux = l;
    }
  }

  String line = "S:";
  line += temp;
  line += ",";
  line += humid;
  line += ",";
  line += dist;
  line += ",0,0,0,0,0,0,0,";
  line += pressure;

  line += (routine || blkPc >= 0) ? ",1" : ",0";
  line += ",";
  line += lux;

  Serial.println(line);
  if (!sensorChar.writeValue(line) && bleConnected) logEvt(LOG_NOTIFY_FAIL);
}
