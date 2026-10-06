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
    String l = "E:log,";
    l += logRing[i].ms;
    l += ",";
    l += logName(logRing[i].code);
    if (logRing[i].code == LOG_BOOT) { l += " ("; l += resetWhy(logRing[i].arg); l += ")"; }
    else if (logRing[i].arg) { l += " "; l += logRing[i].arg; l += "ms"; }
    Serial.println(l);
    if (bleConnected) sensorChar.writeValue(l);
    blePump();
  }
  Serial.println("E:logend");
  if (bleConnected) sensorChar.writeValue("E:logend");
}

void handleCmd(String c) {
  c.trim();
  if (c == "stop") stopRoutine();
  else if (c.startsWith("go,")) startRoutine(c.substring(3));
  else if (c.startsWith("drv,")) startDrive(c);
  else if (c.startsWith("blk,")) handleBlk(c);
  else if (c.startsWith("armh,")) {                // bench trim: armh,<j>,<hold>[,<sag>]
    int a = c.indexOf(',', 5);                     // sag is the same bias per 1000ms
    int b = a > 0 ? c.indexOf(',', a + 1) : -1;    // of travel — one flat number
    if (a > 0)                                     // cannot hold a joint at every pose
      armSetHold(c.substring(5, a).toInt(),
                 c.substring(a + 1, b > 0 ? b : c.length()).toInt(),
                 b > 0 ? c.substring(b + 1).toInt() : 0);
  }
  else if (c.startsWith("armz,")) {               // "this is home" — the travel
    String j = c.substring(5);                     // budget is dead reckoning and
    armZero(j.length() ? j.toInt() : -1);          // drifts; bare armz, = all joints
    Serial.println("arm travel zeroed");
  }
  else if (c.startsWith("arm,")) {
    int a = c.indexOf(',', 4);
    if (a < 0) armStopAll();                       // bare "arm," = all joints off
    else armJog(c.substring(4, a).toInt(), c.substring(a + 1).toInt());
  }

  else if (c.startsWith("hz,")) { tuneStep = PAIR_TUNE_N; buzzTone(c.substring(3).toInt()); }

  else if (c == "tune") { Serial.println("tune: replaying pairing tune"); startPairTune(); }
  else if (c.startsWith("buz,")) {
    buzzEnabled = c.substring(4).toInt() != 0;
    if (!buzzEnabled) { buzzHz = 0; tuneStep = PAIR_TUNE_N; buzzPark(); }

    else buzzLevel = "-";
  }
  else if (c.startsWith("cam,")) { camState = c.substring(4); if (!saver) updateOled(); }
  else if (c.startsWith("hud,")) {
    int sep = c.indexOf(',', 4);
    hudLevel = (sep < 0) ? c.substring(4) : c.substring(4, sep);
    hudMetrics = (sep < 0) ? "" : c.substring(sep + 1);
    if (!saver) updateOled();
  }

  else if (c.startsWith("log")) {                   // "log," dumps, "log,clear" wipes
    if (c.endsWith("clear")) { logHead = 0; logCount = 0; logEvt(LOG_BOOT, resetBits); }
    dumpLog();
  }
  else if (c.startsWith("scr,")) { startSaver(c.substring(4).toInt()); updateOled(); }
  else if (c.startsWith("oled,")) {
    String msg = c.substring(5);
    customMsg = (msg == "clear") ? "" : msg;
    updateOled();
  }
}
