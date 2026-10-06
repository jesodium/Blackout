// part of main.ino, #included where this section used to be -- order matters
#pragma once

// ---- blk vm ----
// plays the instruction list the dashboard uploads. every move is still time-limited,
// and an inbound stop ends it.
Ins blkCode[BLK_MAX];
uint8_t blkLen = 0, blkWant = 0;
float blkVar[BLK_VARS];
int blkPc = -1;
uint8_t blkPwm = 140;
unsigned long blkUntil = 0;
bool blkWaitEvt = false;
bool blkLoading = false;

bool blkResume = false;
uint8_t blkResSlot = 0xFF;

float blkRead(uint8_t lhs) {
  if (lhs >= 100) return blkVar[(uint8_t)(lhs - 100) % BLK_VARS];
  if (lhs == 50) return blkPwm;
  switch (lhs) {
    case 0: return distCm;
    case 1: return temp;
    case 2: return humid;
    case 6: return pressure;
    case 10: return lux;
  }
  return 0;
}

bool blkTest(const Ins& i) {
  float l = blkRead(i.lhs), r = i.rhs;
  switch (i.cmp) {
    case 0: return l < r;
    case 1: return l > r;
    case 2: return l <= r;
    case 3: return l >= r;
    case 4: return l == r;
    default: return l != r;
  }
}

void blkDrive(uint8_t verb, uint8_t pwm) {
  switch (verb) {
    case 0: forward(pwm); break;
    case 1: back(pwm);    break;
    case 2: left(pwm);    break;
    default: right(pwm);  break;
  }
}

void blkHalt() { blkPc = -1; blkWaitEvt = false; blkLoading = false; blkResume = false; blkUntil = 0; halt(); }
void blkFinish() { blkHalt(); sensorChar.writeValue("E:blkend"); Serial.println("E:blkend"); }

void blkEnter() {
  for (uint8_t guard = 0; guard < 64; guard++) {
    if (blkPc < 0 || blkPc >= blkLen) { blkFinish(); return; }
    const Ins& i = blkCode[blkPc];
    switch (i.op) {
      case B_END: blkFinish(); return;
      case B_STOP: blkFinish(); return;
      case B_MOVE:  blkDrive(i.a, blkPwm); blkUntil = millis() + (uint16_t)i.c; return;
      case B_MOVEU:
        if (blkTest(i)) { halt(); break; }
        blkDrive(i.a, blkPwm);
        blkUntil = millis() + (i.c ? (uint16_t)i.c : 30000);
        return;
      case B_WAIT: halt(); blkUntil = millis() + (uint16_t)i.c; return;
      case B_WAITU:
        if (blkTest(i)) break;
        halt();
        blkUntil = i.c ? millis() + (uint16_t)i.c : 0;
        return;
      case B_SPEED: blkPwm = i.b; break;
      case B_SET: blkVar[i.a % BLK_VARS] = i.rhs; break;
      case B_ADD: blkVar[i.a % BLK_VARS] += i.rhs; break;
      case B_JMP: blkPc = i.c; continue;
      case B_JMPF: if (!blkTest(i)) { blkPc = i.c; continue; } break;
      case B_EVT: {
        halt();
        String e = "E:blk,"; e += i.b; e += ","; e += i.a;
        for (uint8_t v = 0; v < BLK_VARS; v++) { e += ","; e += blkVar[v]; }
        sensorChar.writeValue(e);
        Serial.println(e);
        if (i.a == 0) break;
        blkWaitEvt = true;
        blkResSlot = (i.a == 2) ? i.c : 0xFF;
        blkUntil = millis() + BLK_EVT_MS;
        return;
      }
    }
    blkPc++;
  }
  blkResume = true;
}

void tickBlk() {
  if (blkPc < 0) return;
  if (blkResume) { blkResume = false; blkEnter(); return; }
  const Ins& i = blkCode[blkPc];
  if (blkWaitEvt) {
    if (millis() < blkUntil) return;
    blkWaitEvt = false;
  } else if (i.op == B_MOVEU || i.op == B_WAITU) {
    if (!blkTest(i) && (!blkUntil || millis() < blkUntil)) return;
  } else if (blkUntil && millis() < blkUntil) return;
  halt();
  blkUntil = 0;
  blkPc++;
  blkEnter();
}

void blkStart() {
  if (!blkLen || blkLen != blkWant) {
    sensorChar.writeValue("E:blkerr");
    Serial.println("E:blkerr");
    return;
  }
  routine = nullptr;
  drvEnd = 0;
  for (uint8_t v = 0; v < BLK_VARS; v++) blkVar[v] = 0;
  blkPwm = 140;
  blkUntil = 0;
  blkWaitEvt = false;
  blkPc = 0;
  Serial.print("blk start: "); Serial.print(blkLen); Serial.println(" ins");
  blkEnter();
}

String blkFld(const String& s, uint8_t n) {
  int start = 0;
  for (uint8_t k = 0; k < n; k++) {
    start = s.indexOf(',', start);
    if (start < 0) return "";
    start++;
  }
  int end = s.indexOf(',', start);
  return end < 0 ? s.substring(start) : s.substring(start, end);
}

void handleBlk(const String& c) {
  String k = blkFld(c, 1);
  if (k == "n") {
    blkHalt();
    memset(blkCode, 0, sizeof(blkCode));
    blkLen = 0;
    blkWant = blkFld(c, 2).toInt();
    blkLoading = true;
    sensorChar.writeValue("E:blkrdy");
    Serial.println("E:blkrdy");     // the usb link waits on this too, or every program falls back to the browser
  } else if (k == "i") {
    int idx = blkFld(c, 2).toInt();
    if (idx < 0 || idx >= BLK_MAX) return;
    Ins& i = blkCode[idx];
    i.op  = blkFld(c, 3).toInt();
    i.a   = blkFld(c, 4).toInt();
    i.b   = blkFld(c, 5).toInt();
    i.c   = blkFld(c, 6).toInt();
    i.lhs = blkFld(c, 7).toInt();
    i.cmp = blkFld(c, 8).toInt();
    i.rhs = blkFld(c, 9).toFloat();
    if (idx + 1 > blkLen) blkLen = idx + 1;
  } else if (k == "go") {
    blkLoading = false;
    blkStart();
  } else if (k == "res" && blkWaitEvt) {
    if (blkResSlot < BLK_VARS) blkVar[blkResSlot] = blkFld(c, 2).toFloat();
    blkUntil = 0;
  }
}

void stopRoutine() { routine = nullptr; drvEnd = 0; blkHalt(); armStopAll(); }
