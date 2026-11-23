// part of main.ino, #included where this section used to be -- order matters
#pragma once

// ---- commands ----
void startDrive(const String& c) {
  int a = c.indexOf(',', 4);
  if (a < 0) return;
  String verb = c.substring(4, a);
  int b = c.indexOf(',', a + 1);
  if (b < 0 && verb == "tank") return;
  routine = nullptr;
  long ms;
  if (verb == "tank") {
    int d = c.indexOf(',', b + 1);
    int l = c.substring(a + 1, b).toInt();
    int r = (d < 0 ? c.substring(b + 1) : c.substring(b + 1, d)).toInt();
    ms = d < 0 ? 800 : constrain(c.substring(d + 1).toInt(), 50, 10000);
    tank(l, r);
  } else {
    int pwm = constrain((b < 0 ? c.substring(a + 1) : c.substring(a + 1, b)).toInt(), 0, 255);
    ms = b < 0 ? 800 : constrain(c.substring(b + 1).toInt(), 50, 10000);
    if      (verb == "fwd")   forward(pwm);
    else if (verb == "back")  back(pwm);
    else if (verb == "left")  left(pwm);
    else if (verb == "right") right(pwm);
    else { halt(); return; }
  }
  drvEnd = millis() + ms;
  Serial.print("drv: "); Serial.println(c);
}

void tickDrive() {
  if (drvEnd && millis() >= drvEnd) { drvEnd = 0; halt(); }
}

void startRoutine(const String& name) {
  if (name == "presentation") routine = PRESENTATION;
  else if (name == "run") routine = RUN;
  else if (name == "test") routine = TEST;
  else if (name == "mission") routine = MISSION;
  else if (name == "test2") routine = TEST2;
  else return;
  drvEnd = 0;
  stepIdx = 0;
  stepStart = millis();
  applyStep(routine[0]);
  Serial.print("routine start: "); Serial.println(name);
}

void tickRoutine() {
  if (!routine) return;
  if (routine[stepIdx].op == END) { stopRoutine(); Serial.println("routine done"); return; }
  if (millis() - stepStart < routine[stepIdx].ms) return;
  stepIdx++;
  stepStart = millis();
  applyStep(routine[stepIdx]);
}

// one line per event, formatted HERE so the dashboard needs no second copy of
// the code table. Pumps between lines: a full ring is 48 notifies back to back.
void dumpLog() {
  uint16_t lost = logCount > LOG_N ? logCount - LOG_N : 0;
  uint8_t n = logCount < LOG_N ? logCount : LOG_N;
  uint8_t i = logCount < LOG_N ? 0 : logHead;
  String head = "E:log,0,up ";
  head += millis() / 1000;
  head += "s, last reset ";
  head += resetWhy(resetBits);
  if (lost) { head += ", "; head += lost; head += " older events lost"; }
  Serial.println(head);
  if (bleConnected) sensorChar.writeValue(head);
  for (uint8_t k = 0; k < n; k++, i = (i + 1) % LOG_N) {
    String l = logLine(logRing[i]);
    Serial.println(l);
    if (bleConnected) sensorChar.writeValue(l);
    blePump();
  }
  Serial.println("E:logend");
  if (bleConnected) sensorChar.writeValue("E:logend");
}

void handleCmd(String c) {
  c.trim();
  if (c.length()) usbLog("> " + c);
  if (c == "stop") stopRoutine();
  else if (c.startsWith("go,")) startRoutine(c.substring(3));
  else if (c.startsWith("drv,")) startDrive(c);
  else if (c.startsWith("blk,")) handleBlk(c);
  else if (c.startsWith("armen,")) armEnable(c.substring(6).toInt());   // armen,0 = lock off, armen,1 = allow
  else if (c.startsWith("armz,")) armHome();      // glide every joint to home
  else if (c.startsWith("armto,")) {               // armto,<joint>,<deg>[,1 = limp on arrival]: glide there
    int a = c.indexOf(',', 6), b = c.indexOf(',', a + 1);
    if (a > 0) armTo(c.substring(6, a).toInt(), c.substring(a + 1).toInt(), b > 0 && c.substring(b + 1).toInt());
  }
  else if (c.startsWith("arm,")) {
    int a = c.indexOf(',', 4);
    if (a < 0) armStopAll();                       // bare "arm," = all joints off
    else armJog(c.substring(4, a).toInt(), c.substring(a + 1).toInt());
  }

  else if (c.startsWith("lcd,")) {               // lcd,<x>,<y>[,1 = test pattern]
    int a = c.indexOf(',', 4), b = c.indexOf(',', a + 1);
    if (a > 0) lcdAdjust(c.substring(4, a).toInt(), c.substring(a + 1, b < 0 ? c.length() : b).toInt(),
              b > 0 && c.substring(b + 1).toInt());
  }

  else if (c.startsWith("hz,")) { tuneStep = PAIR_TUNE_N; buzzTone(c.substring(3).toInt()); }

  else if (c == "tune") { Serial.println("tune: replaying pairing tune"); startPairTune(); }
  else if (c.startsWith("buz,")) setBuzz(c.substring(4).toInt() != 0);
  else if (c.startsWith("cam,")) camState = c.substring(4);
  else if (c.startsWith("hud,")) {
    int sep = c.indexOf(',', 4);                   // the metrics after it are the panel's own sensors
    hudLevel = (sep < 0) ? c.substring(4) : c.substring(4, sep);
  }

  else if (c.startsWith("log")) {                   // "log," dumps, "log,clear" wipes
    if (c.endsWith("clear")) { logHead = 0; logCount = 0; logEvt(LOG_BOOT, resetBits); }
    dumpLog();
  }
}
