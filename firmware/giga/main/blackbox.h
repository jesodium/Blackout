// part of main.ino, #included where this section used to be -- order matters
#pragma once

// ---- black box ----
// Why the link died, readable AFTER the fact. A BLE drop leaves the sketch
// running, so a RAM ring outlives every drop that is not a reset — and a reset
// is the one thing the ring can never hold, which is what RCC->RSR at boot is
// for: it names what reset the board (brownout / watchdog / pin / power-on)
// before setup() clears it. Together those split "the host lost the link" from
// "the board rebooted under you", which is the whole question.
// The dashboard asks for a dump on every connect, so the reason for the LAST
// drop is on screen before the next run starts.
// IMPORTANT NOTE: RAM only — a power cut takes the ring with it (the boot line
// survives regardless, it is a register). If a power cut ever turns out to be
// the common case, the upgrade is the RTC backup registers (32 words that
// survive reset), not a bigger ring.
#define LOG_N 48
enum LogCode : uint8_t { LOG_BOOT, LOG_BLE_UP, LOG_BLE_DOWN, LOG_STALL, LOG_NOTIFY_FAIL };
struct LogEvt { uint32_t ms; uint32_t arg; uint8_t code; };
LogEvt logRing[LOG_N];
uint8_t logHead = 0;          // next slot to write
uint16_t logCount = 0;        // total ever logged, so a full ring still says how many were lost
uint32_t resetBits = 0;

void logEvt(uint8_t code, uint32_t arg = 0) {
  logRing[logHead] = { millis(), arg, code };
  logHead = (logHead + 1) % LOG_N;
  logCount++;
}

// the reset flags are one register and a handful of bits; decoding them here
// keeps the dashboard free of a second copy that could drift.
String resetWhy(uint32_t r) {
  String s = "";
  if (r & RCC_RSR_LPWR1RSTF) s += "lowpower ";
  if (r & RCC_RSR_WWDG1RSTF) s += "windowdog ";
  if (r & RCC_RSR_IWDG1RSTF) s += "watchdog ";
  if (r & RCC_RSR_SFT1RSTF)  s += "software ";
  if (r & RCC_RSR_PORRSTF)   s += "poweron ";
  if (r & RCC_RSR_BORRSTF)   s += "brownout ";
  if (r & RCC_RSR_PINRSTF)   s += "pin ";
  return s.length() ? s : "unknown";
}

const char *logName(uint8_t c) {
  switch (c) {
    case LOG_BOOT:        return "boot";
    case LOG_BLE_UP:      return "ble up";
    case LOG_BLE_DOWN:    return "ble down";
    case LOG_STALL:       return "loop stall";
    case LOG_NOTIFY_FAIL: return "notify failed";
  }
  return "?";
}

extern "C" uint8_t oledI2c1(u8x8_t *u8x8, uint8_t msg, uint8_t arg_int, void *arg_ptr) {
  switch (msg) {
    case U8X8_MSG_BYTE_SEND:
      Wire1.write((const uint8_t *)arg_ptr, (int)arg_int);
      break;
    case U8X8_MSG_BYTE_INIT:
      Wire1.begin();
      break;
    case U8X8_MSG_BYTE_SET_DC:
      break;   // i2c carries d/c in the control byte, there is no pin
    case U8X8_MSG_BYTE_START_TRANSFER:
      Wire1.setClock(u8x8->bus_clock);
      Wire1.beginTransmission(u8x8_GetI2CAddress(u8x8) >> 1);
      break;
    case U8X8_MSG_BYTE_END_TRANSFER:
      Wire1.endTransmission();
      blePump();       // ~16 of these a frame: the 23ms blind spot becomes ~1.5ms
      break;
    default: return 0;
  }
  return 1;
}

bool bleConnected = false;
String camState = "not connected";
String customMsg = "";

String hudLevel = "";
String hudMetrics = "";
unsigned long connectAt = 0;
#define HUD_BLINK_MS 1500

uint8_t oledFrame = 0;
unsigned long lastOledDraw = 0;
unsigned long lastOledPhase = 0;

#define OLED_DRAW_INTERVAL 40   // ~23ms of i2c a frame at 400k; a shorter tick re-fires on itself
#define OLED_PHASE_INTERVAL 120
// There WAS a periodic re-init here (every 5s, re-sending the init sequence to
// recover a panel whose config had gone). It is deleted: its stated reason was "a
// glitch on a no-CS spi bus eating a command byte", and the panel moved to i2c on
// 2026-09-02 -- i2c is addressed and ACKed, so that failure mode left with the spi
// bus. What it cost was ~310ms of u8g2's own blocking delays every 5s, and those
// delays go via the gpio/delay callback rather than byte_cb, so blePump() in the
// transfer hook never runs inside them: ~20-40 missed connection events a pop,
// dropped inbound packets, a link that dies for no visible reason.
// If a panel ever comes up dark again, the way back is oled.initDisplay() +
// setPowerSave(0) + setContrast(255) ONCE on a trigger, never on a timer.

#define MTX_CW 6
#define MTX_CH 8
#define MTX_COLS (OLED_W / MTX_CW)
#define MTX_ROWS (OLED_H / MTX_CH)
int8_t mtxY[MTX_COLS];
uint8_t mtxSpd[MTX_COLS];
uint8_t mtxTick[MTX_COLS];
uint8_t mtxTail[MTX_COLS];
char mtxCell[MTX_COLS][MTX_ROWS];

#define BOARD_NAME "BLACKOUT-V3"

#define ENA 2
#define IN1 3
#define IN2 4
#define IN3 5
#define IN4 6

#define ENB 7
static const uint8_t MOTOR_PINS[] = {IN1, IN2, IN3, IN4};
#define SONAR_ITER 3
#define SONAR_TIMEOUT_US 25000UL

enum { SCR_OFF, SCR_MATRIX, SCR_BOUNCE, SCR_STARS, SCR_TETRIS, SCR_N };
uint8_t saver = SCR_OFF;

static const char BN_TEXT[] = "BLACKOUT";
int16_t bnX, bnY;
int8_t bnDX, bnDY;
uint8_t bnW;

#define ST_N 24
uint8_t stX[ST_N], stY[ST_N], stZ[ST_N];

#define TET_COLS 8
#define TET_ROWS 10
#define TET_CELL 6
#define TET_X0 ((OLED_W - TET_COLS * TET_CELL) / 2)
#define TET_Y0 ((OLED_H - TET_ROWS * TET_CELL) / 2)
#define TET_SPD 4

static const uint16_t TET_PIECES[7][4] = {
  { 0x000F, 0x1111, 0x000F, 0x1111 }, // I
  { 0x0033, 0x0033, 0x0033, 0x0033 }, // O
  { 0x0027, 0x0131, 0x0072, 0x0232 }, // T
  { 0x0036, 0x0231, 0x0036, 0x0231 }, // S
  { 0x0063, 0x0132, 0x0063, 0x0132 }, // Z
  { 0x0071, 0x0113, 0x0047, 0x0322 }, // J
  { 0x0074, 0x0311, 0x0017, 0x0223 }, // L
};
uint8_t tetWell[TET_ROWS];
uint16_t tetM;
int8_t tetX, tetY;
uint8_t tetTick;

#define ENV_INTERVAL 2000
#define SEND_INTERVAL 100

#define SAVER_ENV_INTERVAL 6000
#define SAVER_SEND_INTERVAL 500
