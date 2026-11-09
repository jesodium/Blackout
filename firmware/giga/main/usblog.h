// part of main.ino, #included where this section used to be -- order matters
#pragma once
#include <Arduino_USBHostMbed5.h>
#include <FATFileSystem.h>

// ---- usb stick log ----
// A FAT stick on the USB-A port keeps the whole run (telemetry, commands, black
// box events) after the PC is gone -- the black box ring only holds 48 events and
// dies with power. A FAT write to a stick can take tens of ms, which loop() can't
// afford (BLE starves), so loop() only memcpy's into a RAM buffer and a low
// priority thread mounts the stick and flushes it once a second.
// Pull the stick any time: the writer drops the mount and waits for it to return.
// IMPORTANT NOTE: a full buffer drops lines (counted, written as a note once the
// stick is back). With no stick it fills in ~7s and keeps the boot lines, so
// the stick doesn't have to be in at power-up.
#define USBLOG_BUF 4096
#define USBLOG_FLUSH_MS 1000
#define USBLOG_PATH "/usb/blackout.log"

USBHostMSD msd;
mbed::FATFileSystem usbFs("usb");
rtos::Thread usbLogThread(osPriorityBelowNormal, 8192);   // FAT + usb host want stack
rtos::Mutex usbLogMx;
char usbLogBuf[USBLOG_BUF];
uint16_t usbLogLen = 0;
uint32_t usbLogDropped = 0;

// millis-stamped, since the S: line carries no time of its own
void usbLog(const String &l) {
  char ts[12];
  int tn = snprintf(ts, sizeof ts, "%lu ", (unsigned long)millis());
  usbLogMx.lock();
  if (usbLogLen + tn + l.length() + 1 <= USBLOG_BUF) {
    memcpy(usbLogBuf + usbLogLen, ts, tn); usbLogLen += tn;
    memcpy(usbLogBuf + usbLogLen, l.c_str(), l.length()); usbLogLen += l.length();
    usbLogBuf[usbLogLen++] = '\n';
  } else usbLogDropped++;
  usbLogMx.unlock();
}

void usbLogWriter() {
  static char out[USBLOG_BUF];
  FILE *f = nullptr;
  int mountErr = 0;
  for (;;) {
    delay(USBLOG_FLUSH_MS);                 // mbed core: sleeps this thread only
    if (f && !msd.connected()) {
      fclose(f); f = nullptr; usbFs.unmount();
      Serial.println("usb log: stick gone");
    }
    if (!f) {
      if (!msd.connected() && !msd.connect()) continue;
      int err = usbFs.mount(&msd);
      if (err) {                            // say it once per stick, not every second
        if (err != mountErr) { Serial.print("usb log: mount failed "); Serial.print(err); Serial.println(" (stick must be FAT32)"); }
        mountErr = err;
        continue;
      }
      mountErr = 0;
      f = fopen(USBLOG_PATH, "a");
      if (!f) { usbFs.unmount(); continue; }
      fprintf(f, "--- %lu mount ---\n", (unsigned long)millis());
      Serial.println("usb log: writing " USBLOG_PATH);
    }
    usbLogMx.lock();
    uint16_t n = usbLogLen; uint32_t lost = usbLogDropped;
    memcpy(out, usbLogBuf, n);
    usbLogLen = 0; usbLogDropped = 0;
    usbLogMx.unlock();
    if (lost) fprintf(f, "--- %lu lines dropped ---\n", (unsigned long)lost);
    if ((n && fwrite(out, 1, n, f) != n) || fflush(f)) {
      fclose(f); f = nullptr; usbFs.unmount();
      Serial.println("usb log: write failed, remounting");
    }
  }
}

void usbLogBegin() {
  pinMode(PA_15, OUTPUT);                   // 5V on the USB-A port is off until this
  digitalWrite(PA_15, HIGH);
  usbLogThread.start(usbLogWriter);
}
