// ---- voice commands ----
const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[\u00a1\u00bf!?]/g, "").replace(/\s+/g, " ").trim();
const DRIVE_PWM = 140, DRIVE_MS = 501;

const ORDER = /^(?:sage[\s,]*)?(?:te (?:lo )?ordeno|te pido|orden|i order you|order)(?:\s+que)?\b\s*(.+)/;
const LEAD = "^(?:sage[\\s,]*)?(?:please\\s+|por favor\\s+)?(?:(?:can|could) you\\s+)?" +
  "(?:(?:go|move|drive|turn|head|ir|ve|vaya|vayas|gira|gires|anda|muevete|camina|sigue)\\s+)*" +
  "(?:(?:a la|al|hacia|para|to the)\\s+)*";
const drv = (words) => new RegExp(LEAD + `(?:${words})\\b`);

function driveMs(txt) {
  const m = txt.match(/(\d+(?:[.,]\d+)?)\s*(ms|milliseconds?|milisegundos?|s|secs?|seconds?|segundos?)\b/);
  if (!m) return DRIVE_MS;
  const n = parseFloat(m[1].replace(",", "."));
  return Math.min(5000, Math.max(50, Math.round(m[2][0] === "m" ? n : n * 1000)));
}

const DIRS = [
  { w: "stop|halt|freeze|alto|frena\\w*|deten\\w*|pare\\w*|parat\\w*|para(?!\\s+(?:atras|adelante|delante|la|el|de))",
    cmd: () => "stop", ackKey: "sage.stopAck" },
  { w: "back|backwards?|reverse|atras|reversa|retroced\\w*|retroces\\w*",
    cmd: (ms) => `drv,back,${DRIVE_PWM},${ms}`,  ackKey: "sage.backAck" },
  { w: "forward|ahead|straight|adelante|delante|avanz\\w*|avanc\\w*",
    cmd: (ms) => `drv,fwd,${DRIVE_PWM},${ms}`,   ackKey: "sage.fwdAck" },
  { w: "left|izquierda",  cmd: (ms) => `drv,left,${DRIVE_PWM},${ms}`,  ackKey: "sage.leftAck" },
  { w: "right|derecha",   cmd: (ms) => `drv,right,${DRIVE_PWM},${ms}`, ackKey: "sage.rightAck" },
].map(d => ({ ...d, bare: new RegExp(`\\b(?:${d.w})\\b`), re: drv(d.w) }));

// A trigger with `tape` plays a recorded run straight from here — no model round
// trip, so it fires instantly and works with the venue offline. "present
// yourself" is a tape and NOT the on-board PRESENTATION routine any more: the run
// talks, looks at the room and works the claw, and none of those exist in
// routines.h. The name has to match the file in server/data/tapes/.
const CMD_TRIGGERS = [
  { re: /present yourself|present urself|presentate/, tape: "PRESENT YOURSELF" },
  { re: /say hello|di hola/,                          tape: "SAY HELLO" },
  { re: /the mission|la mision/,                       tape: "NO CLAW DEMO" },
  { re: /about (your|the|its) arm|sobre (tu|el) brazo/,  tape: "PRESENT ARM" },
  ...DIRS,
];

function matchCmd(txt) {
  const ord = txt.match(ORDER);
  if (ord) return DIRS.find(d => d.bare.test(ord[1])) || null;
  return CMD_TRIGGERS.find(c => c.re.test(txt)) || null;
}

export { driveMs, matchCmd, norm };
