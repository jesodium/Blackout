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

bool bleConnected = false;
String camState = "not connected";

String hudLevel = "";
unsigned long connectAt = 0;
#define HELLO_MS 1500        // the "connected" screen, before the info screen takes over

#define BOARD_NAME "BLACKOUT-V4"

#define ENA 2
#define IN1 3
#define IN2 4
#define IN3 5
#define IN4 6

#define ENB 7
static const uint8_t MOTOR_PINS[] = {IN1, IN2, IN3, IN4};
#define SONAR_ITER 3
#define SONAR_TIMEOUT_US 25000UL

#define ENV_INTERVAL 2000
#define SEND_INTERVAL 100


// one ring slot as the E:log line the dashboard reads -- shared by the dump and the live echo
String logLine(const LogEvt &e) {
  String l = "E:log,";
  l += e.ms;
  l += ",";
  l += logName(e.code);
  if (e.code == LOG_BOOT) { l += " ("; l += resetWhy(e.arg); l += ")"; }
  else if (e.arg) { l += " "; l += e.arg; l += "ms"; }
  return l;
}

// Echoed live on usb too, so a cabled rover shows each drop/stall as it lands
// instead of only on the next "log," dump. Not over BLE: a notify from inside
// a "notify failed" or "ble down" is the one write guaranteed to go nowhere.
void logEvt(uint8_t code, uint32_t arg = 0) {
  logRing[logHead] = { millis(), arg, code };
  String l = logLine(logRing[logHead]);
  Serial.println(l);
  usbLog(l);
  logHead = (logHead + 1) % LOG_N;
  logCount++;
}
