"""Manual control for the PCA9685 bench test. python3 OUTDATED/pca_test/servo.py -> :5005

Mostly a serial pipe: every button sends one line to the sketch, the same
string you would type into the serial monitor. The exception is HAND CONTROL,
which runs the webcam and mediapipe in a background thread here and drives the
joints from what it sees (the maths lives in hand.py, which is also runnable on
its own).
"""
import json, os, sys, threading, time
import serial, serial.tools.list_ports
from flask import Flask, request, Response

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def find_port():
    return next((p.device for p in serial.tools.list_ports.comports()
                 if "usbmodem" in p.device or "ttyACM" in p.device), None)


# --selftest exercises the recorder maths only, so it must not need the board.
if not find_port() and "--selftest" not in sys.argv:
    raise SystemExit("no arduino found — plug it in")

# IMPORTANT NOTE: one global port, one user. The R4 drops off USB and
# re-enumerates (brownout, or a marginal cable), so every access goes through
# port() and a dead fd is reopened rather than 500ing the page.
ser = None


def port():
    global ser
    if ser is None:
        dev = find_port()
        if not dev:
            raise IOError("board not on usb")
        # write_timeout: a browned-out board stops draining the CDC buffer and
        # write() blocks forever, wedging the whole single-threaded server.
        ser = serial.Serial(dev, 9600, timeout=0.2, write_timeout=1)
        time.sleep(2)          # r4 bootloader
    return ser


def drop():
    global ser
    try:
        ser and ser.close()
    except Exception:
        pass
    ser = None


# The camera thread and the browser both write commands, so the port needs a
# lock — that is also why the server is threaded now, where it used to rely on
# one-request-at-a-time to keep writes from interleaving. A streaming response
# would have parked the single worker forever anyway.
LOCK = threading.Lock()


def write(cmd):
    with LOCK:
        _record(cmd)
        port().write((cmd + "\n").encode())


# ------------------------------------------------------------------- recording
# IMPORTANT NOTE: this records COMMANDS, not positions. Four of five joints are
# 360s with no encoder — nothing can read where the arm is, so there is no
# position to save and no "go to 0" to command. What can be captured is the wire
# traffic and its timing, replayed open-loop from wherever the arm happens to be
# sitting: dead reckoning, exactly like the Step tables in routines.h. Start it
# from the same place or it ends up somewhere else, and it drifts a little every
# time. A real "position 0" needs feedback the hardware does not have.
#
# The hook is inside write() because that is the one choke point every command
# already passes through — arrows, sliders, trims and hand control alike — so a
# recording is a faithful copy of the session rather than of one widget.
MOVES_F = os.path.join(os.path.dirname(os.path.abspath(__file__)), "arm_moves.json")
REC_MAX = 5000       # a recorder left on overnight must not eat the machine

REC = {"on": False, "t0": 0.0, "steps": []}
PLAY = {"on": False, "name": "", "at": 0, "n": 0, "err": ""}


def _record(cmd):
    """Called under LOCK, from write(). Timestamps are relative to the start of
    the take, so the gaps — which is what the deadman lives on — replay intact."""
    if REC["on"] and len(REC["steps"]) < REC_MAX:
        REC["steps"].append({"ms": int((time.time() - REC["t0"]) * 1000),
                             "cmd": cmd})


def load_moves():
    try:
        with open(MOVES_F) as f:
            return json.load(f)
    except (IOError, ValueError):
        return {}


def save_moves(m):
    with open(MOVES_F, "w") as f:
        json.dump(m, f, indent=1)


def clean(steps):
    """Whatever the editor posts, coerced. A hand-edited ms of "" or a cmd of
    None reaching the serial port is a hang, not a typo."""
    out = []
    for st in steps or []:
        cmd = st.get("cmd")
        # NB: str(None) is "None", which is truthy and would go down the wire.
        cmd = "" if cmd is None else str(cmd).strip()
        if not cmd:
            continue
        try:
            ms = max(0, int(st.get("ms", 0)))
        except (TypeError, ValueError):
            ms = 0
        out.append({"ms": ms, "cmd": cmd})
    out.sort(key=lambda st: st["ms"])
    return out


FEED_MS = 300        # the board stops a 360 after JOG_MS (800ms); stay well under


def segments(steps):
    """The take, rewritten as travel: [ch, speed, start_ms, end_ms] per burst.

    A jog is held by re-sending the same speed every FEED_MS, so a repeat of the
    value already running is a deadman refresh and not a new burst — merging
    those is what turns 40 recorded lines into the one movement they were.
    Trims (n12:1500), nudges (t4) and dumps (d4) are not travel and are skipped:
    a nudge goes out and comes back, so it has nothing to undo."""
    live, out, last = {}, [], 0
    for st in steps:
        ms, cmd = st["ms"], st["cmd"]
        last = max(last, ms)
        if cmd == "s":                       # stop all: close everything open
            for ch, (v, t0) in live.items():
                out.append([ch, v, t0, ms])
            live.clear()
            continue
        ch, _, val = cmd.partition(":")
        if not ch.isdigit():
            continue
        try:
            v = int(val)
        except ValueError:
            continue
        if live.get(ch, (None,))[0] == v:
            continue                         # deadman refresh, same burst
        if ch in live:
            pv, t0 = live.pop(ch)
            out.append([ch, pv, t0, ms])     # this burst ends where the next starts
        if v:
            live[ch] = (v, ms)
    for ch, (v, t0) in live.items():
        out.append([ch, v, t0, last])
    return out


def invert(steps):
    """Drive the take backwards: mirror the timeline, negate every speed.

    Mirroring (new_start = T - old_end) rather than reversing a list is what
    keeps two joints that moved together moving together — the whole take runs
    in reverse, not each burst in turn.

    IMPORTANT NOTE: this is dead reckoning and it will not land exactly. Gravity
    is not symmetric — the same pulse that lowered the shoulder in 400ms does
    not lift it back in 400ms — so the inverse undershoots on every upward leg
    and the error accumulates each time you run it. It is a "roughly back where
    I started", not a home. A real position 0 needs a limit switch or an encoder
    per joint; with either, this function becomes unnecessary.
    """
    segs = [g for g in segments(steps) if g[1] and g[3] > g[2]]
    if not segs:
        return []
    T = max(g[3] for g in segs)
    out = []
    for ch, v, s0, e0 in segs:
        start, end = T - e0, T - s0
        t = start
        while t < end:                       # keep feeding the board's deadman
            out.append({"ms": int(t), "cmd": "%s:%d" % (ch, -v)})
            t += FEED_MS
        out.append({"ms": int(end), "cmd": "%s:0" % ch})
    out.sort(key=lambda st: st["ms"])
    return out


def _play(steps):
    t0 = time.time()
    try:
        for i, st in enumerate(steps):
            # Slice the wait so STOP lands within 50ms instead of at the end of
            # a long gap — an arm mid-swing cannot wait out a 4s pause.
            while PLAY["on"]:
                left = st["ms"] / 1000.0 - (time.time() - t0)
                if left <= 0:
                    break
                time.sleep(min(left, 0.05))
            if not PLAY["on"]:
                break
            PLAY["at"] = i + 1
            write(st["cmd"])
    except (serial.SerialTimeoutException, OSError, IOError) as e:
        PLAY["err"] = str(e)
        drop()
    finally:
        PLAY["on"] = False
        # Always land stopped, even on an exception or a half-played take: the
        # last recorded command is usually a jog, and a jog outliving the
        # program is the failure this whole rig is built to avoid.
        try:
            write("s")
        except (serial.SerialTimeoutException, OSError, IOError):
            pass


app = Flask(__name__)

PAGE = r"""<!doctype html><title>arm</title>
<style>
 body{background:#111;color:#eee;font:16px/1.5 system-ui;margin:0;padding:1.5rem;
      display:grid;gap:1.2rem;place-content:start center;touch-action:manipulation}
 h2{margin:0;font-size:.95rem;color:#9ab;letter-spacing:.05em;text-transform:uppercase}
 button{font:inherit;padding:.9rem 1.3rem;background:#222;color:#eee;
        border:1px solid #444;border-radius:8px;min-width:4.5rem;user-select:none;
        touch-action:none}
 button.on{background:#5a5;color:#111}
 .stop{background:#611;border-color:#a44;font-weight:700}
 .row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
 button.nudge{min-width:3.4rem;padding:.9rem .6rem}
 small{color:#777}
 .neu{color:#fc6;font-family:ui-monospace;font-size:13px}
 #log{white-space:pre-wrap;color:#8f8;min-height:5rem;font-family:ui-monospace;font-size:13px}
 /* aspect-ratio keeps the box even if a frame fails to decode, so the page
    does not jump and a hiccup does not look like the preview vanishing. */
 #cam{display:none;width:min(90vw,44rem);aspect-ratio:16/9;object-fit:cover;
      background:#181818;border:1px solid #444;border-radius:8px}
 #hstat{color:#9ab;font-family:ui-monospace;font-size:13px}
 select{font:inherit;padding:.9rem .7rem;background:#222;color:#eee;
        border:1px solid #444;border-radius:8px}
 #tut{display:none;max-width:min(90vw,44rem);background:#181818;border:1px solid #444;
      border-radius:8px;padding:1rem 1.2rem}
 #tut.show{display:block}
 #tut table{border-collapse:collapse;width:100%}
 #tut td{padding:.45rem .3rem;border-top:1px solid #2c2c2c;vertical-align:top}
 #tut td:first-child{color:#fc6;white-space:nowrap;width:11rem}
 #tut p{margin:.2rem 0 .8rem;color:#9ab}
 /* The throttle is centre-sprung: it springs back on release, so its resting
    state is always "stopped" rather than "whatever you last dragged to". */
 input.thr{flex:1;min-width:14rem;accent-color:#5a5;height:2.6rem}
 .spd{color:#fc6;font-family:ui-monospace;font-size:13px;min-width:3.5rem;
      text-align:right}
 .rec{background:#611;border-color:#a44}
 .rec.on{background:#c33;border-color:#f66;color:#fff}
 input[type=text],input[type=number]{font:inherit;padding:.7rem;background:#181818;
      color:#eee;border:1px solid #444;border-radius:8px}
 #moves{display:grid;gap:.4rem}
 .mv{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
 .mv .nm{color:#fc6;font-family:ui-monospace;min-width:9rem}
 #edit{display:none;max-width:min(90vw,44rem)}
 #edit.show{display:block}
 #steps{width:100%;border-collapse:collapse;font-family:ui-monospace;font-size:13px}
 #steps td,#steps th{padding:.25rem;border-top:1px solid #2c2c2c;text-align:left}
 #steps input{padding:.35rem;width:7rem}
 #steps input.c{width:9rem}
</style>
<div class=row><button class=stop id=stopall>■ STOP ALL &nbsp;(space)</button>
 <button id=ver>build?</button></div>
<small>Drag a throttle off centre to run that joint; let go and it springs back
 to 0 and stops. Pulse width is speed <i>and</i> torque on a 360, so anything
 under ~40% is also weak — a loaded shoulder needs most of the bar.
 STOP ALL (or space) kills every channel and ends a playback.</small>
<h2>hand control</h2>
<div class=row>
 <select id=camsel></select>
 <button id=handon>▶ start camera</button>
 <button id=handcal>recalibrate</button>
 <button id=tutbtn>how it works</button>
 <span id=hstat></span>
</div>
<div id=tut>
 <p>The buttons are drawn on the video. <b>Point at one with your index
 finger</b> — it lights up when you are over it — then press <b>E</b> to run it.
 E again stops. Pointing never moves anything, so you can line up first, and the
 hand only ever chooses <i>which</i> button, never <i>when</i>.</p>
 <table>
  <tr><td>point</td><td>your index fingertip is the cursor; the ring around it shows where the camera thinks it is</td></tr>
  <tr><td>E</td><td>runs the button you are pointing at, and <b>latches</b> — press E again to stop. It also stops the moment your finger drifts off the button, or leaves the frame</td></tr>
  <tr><td>S</td><td>speed: <b>slow → half → full</b>, starting slow. Slow is short bursts at full power, not a weaker push — on these 360s a gentler pulse is just a weaker one</td></tr>
  <tr><td>SHOULDER / ELBOW / WRIST</td><td>+ and − along the top and bottom edges</td></tr>
  <tr><td>BASE &lt; &gt;</td><td>the two middle buttons turn the base</td></tr>
  <tr><td>CLAW + / −</td><td>runs while engaged, same as every other joint — ch1 is typed 360, so there is no angle to step to</td></tr>
  <tr><td>STOP</td><td>everything off, same as the red button below</td></tr>
  <tr><td>hand out of frame</td><td>everything <b>stops</b></td></tr>
  <tr><td>pinky only, 3 seconds</td><td><b>switches hand control off</b> — camera and all. A bar along the bottom counts it down</td></tr>
 </table>
 <p>Calibration teaches it the reach of your hand, so the cursor covers the
 whole frame. Redo it if the cursor cannot get to the far buttons.</p>
</div>
<img id=cam alt="">
<div id=joints></div>
<h2>recorded moves</h2>
<small>Records the <b>commands you send</b>, with their timing — not positions.
 Nothing on this arm can read where it is, so a take replays open-loop from
 wherever the arm is sitting <i>now</i>: start it from the same place, by eye,
 or it ends up somewhere else. It drifts a little every replay.
 <b>↩ reverse</b> saves the take driven backwards — the timeline mirrored, every
 speed negated — which walks the arm roughly back to where that take began.
 Roughly: gravity is not symmetric, so an upward leg undershoots the downward
 one it is undoing, and the error grows each run. For a real position 0 the arm
 needs a limit switch or an encoder per joint.</small>
<div class=row>
 <button class=rec id=recbtn>● record</button>
 <input type=text id=recname placeholder="name this take" size=16>
 <button id=recsave>save</button>
 <button id=reccancel>discard</button>
 <span id=recstat class=neu></span>
</div>
<div id=moves></div>
<div id=edit>
 <div class=row><b id=editname></b>
  <button id=editsave>save changes</button>
  <button id=editadd>+ step</button>
  <button id=editclose>close</button></div>
 <small>ms is time from the start of the take. cmd is the raw serial line —
  <code>6:100</code> is ch6 at full speed, <code>6:0</code> stops it,
  <code>s</code> stops everything. Rows re-sort by ms on save.</small>
 <table id=steps></table>
</div>
<div id=log></div>
<script>
// ch, name, is360, neutral-us — mirror of sv[] in pca_test.ino.
const J=[[6,'base',1,1490],[5,'shoulder',1,1500],[4,'elbow',1,1500],[3,'wrist',1,1500],
         [12,'gripwrist',1,1500],[1,'gripper',1,1500]];
const NEU={}; J.forEach(([c,n,k,u])=>NEU[c]=u);
// Where each sg90 was last told to sit. No readback on a servo, so this is the
// only thing that knows; a reload assumes centre until you nudge it.
// Every joint on this arm is a 360 now, so nothing tracks an angle: the wire
// value is a speed, -100..100, and 0 means kill the pulse.

// The throttle sends a SPEED, not a step, so the deadman has to be fed while
// you hold it off centre — 300ms against the board's 800ms JOG_MS, the same
// margin hand control uses.
const FEED_MS=300;
// A finger resting on the bar is never exactly 0, and a 3% pulse is a joint
// creeping all afternoon. Anything inside the detent IS zero.
const DETENT=8;

joints.innerHTML=J.map(([c,name,cont])=>`
 <h2>ch${c} ${name} ${cont?'· 360':'· sg90'}</h2>
 <div class=row>
  <input type=range class=thr data-ch=${c} min=-100 max=100 value=0 step=1
         aria-label="ch${c} ${name} throttle">
  <span class=spd id=spd${c}>0%</span>
  ${cont
    ? `<button class=trim data-ch=${c} data-d=-10>trim−</button>
       <button class=trim data-ch=${c} data-d=10>trim+</button>
       <span class=neu id=neu${c}>${NEU[c]}us</span>`
    : ``}
  <button class=tap data-cmd="t${c}">which?</button>
 </div>`).join('');

// A throttle per joint. Off centre it runs and keeps feeding the deadman;
// released it springs back to 0 and sends one explicit stop. The spring is the
// safety property: a slider left where you dragged it is a joint that keeps
// turning after you walk away, which is the one failure this rig cannot have.
// Every timer lands in held[] so panic() can kill the lot.
const held={};
function thrVal(s){ const v=+s.value; return Math.abs(v)<DETENT?0:v; }
function thrStop(c){
  if(held[c]){ clearInterval(held[c]); held[c]=null; }
  send(c+':0');
}
for(const s of document.querySelectorAll('input.thr')){
  const c=s.dataset.ch, lab=document.getElementById('spd'+c);
  const push=()=>{
    const v=thrVal(s);
    lab.textContent=v+'%';
    if(!v){ thrStop(c); return; }
    send(c+':'+v,1);
    // One interval for the whole hold: it re-reads the slider every tick, so
    // dragging changes speed live instead of restarting the feed.
    if(!held[c]) held[c]=setInterval(()=>{
      const n=thrVal(s);
      if(n) send(c+':'+n,1); else thrStop(c);
    },FEED_MS);
  };
  s.addEventListener('input',push);
  const home=()=>{ if(+s.value!==0){ s.value=0; } lab.textContent='0%'; thrStop(c); };
  for(const ev of ['pointerup','pointercancel','keyup','blur'])
    s.addEventListener(ev,home);
}
// Trim walks the joint's own neutral so it converges, instead of toggling
// between two fixed guesses. Write the value you settle on into sv[].
for(const b of document.querySelectorAll('button.trim')){
  const c=b.dataset.ch, d=+b.dataset.d;
  b.addEventListener('click',()=>{
    NEU[c]+=d;
    document.getElementById('neu'+c).textContent=NEU[c]+'us';
    send('n'+c+':'+NEU[c]);
  });
}
for(const b of document.querySelectorAll('button.tap'))
  b.addEventListener('click',()=>send(b.dataset.cmd));

// The stream is a multipart <img>: pointing it at the url starts it, and
// clearing src is what actually closes the connection — the server keeps
// yielding frames for as long as anyone is reading.
async function hand(action){
  // NB: not named `cam` — that is the <img id=cam>, and shadowing it here made
  // every preview update throw on a string instead of the element.
  const q=camsel.value?('?cam='+camsel.value):'';
  const r=await fetch('/hand/'+action+q), j=await r.json();
  hstat.textContent=j.err||j.status;
  handon.textContent=j.on?'■ stop camera':'▶ start camera';
  handon.classList.toggle('on',j.on);
  cam.style.display=j.on?'block':'none';
  if(j.on) { snap(); poll(); } else { cam.removeAttribute('src'); }
}
// Snapshot loop, not a multipart stream: each frame is its own request, so a
// dropped one costs a frame instead of the whole picture. onload chains the
// next fetch, which paces it to however fast the camera and the link actually
// are — no timer racing ahead of the decode.
let snapping=false;
// Double-buffered: fetch into an off-screen Image, and only put it on screen
// once it has decoded. Assigning straight to the visible <img> blanks it while
// the new jpeg decodes, and at frame rates that reads as constant flicker.
// The swap hits cache, so it is instant.
function snap(){
  if(snapping) return;
  snapping=true;
  const buf=new Image();
  const next=()=>{
    if(!handon.classList.contains('on')){ snapping=false; return; }
    buf.src='/hand/snap?'+Date.now();
  };
  buf.onload=()=>{ cam.src=buf.src; next(); };
  // Keep the last good picture on screen through a hiccup: clearing src is
  // what makes it visibly disappear. Just try again.
  buf.onerror=()=>{ if(handon.classList.contains('on')) setTimeout(next,300);
                    else snapping=false; };
  next();
}
let polling=false;
async function poll(){
  if(polling) return; polling=true;
  while(true){
    const j=await (await fetch('/hand/state')).json();
    hstat.textContent=j.err||j.status;
    if(!j.on){ polling=false; hand('state'); return; }
    await new Promise(r=>setTimeout(r,1000));
  }
}
handon.addEventListener('click',()=>hand(handon.classList.contains('on')?'off':'on'));
// E runs whatever the fingertip is pointing at, S cycles the speed — the same
// two keys hand.py's own window binds, so the two drivers feel identical. The
// hand chooses which button; the keyboard chooses when, which is the whole
// reason a hand reaching across the frame no longer presses things.
addEventListener('keydown',e=>{
  if(!handon.classList.contains('on')) return;
  if(e.target.closest('input,textarea,button')) return;
  const k=e.key.toLowerCase();
  if(k==='e'||k==='s'){ e.preventDefault(); hand(k==='e'?'engage':'speed'); }
});
addEventListener('focus',()=>{ if(handon.classList.contains('on')) fetch('/hand/resume'); });
document.addEventListener('visibilitychange',
  ()=>{ if(!document.hidden && handon.classList.contains('on')) fetch('/hand/resume'); });
handcal.addEventListener('click',()=>hand('cal'));
// Shown on the first visit, then remembered — a tutorial you cannot dismiss is
// worse than no tutorial.
tutbtn.addEventListener('click',()=>{
  const on=tut.classList.toggle('show');
  try{ localStorage.setItem('tut', on?'1':'0'); }catch(e){}
});
try{ if(localStorage.getItem('tut')!=='0') tut.classList.add('show'); }
catch(e){ tut.classList.add('show'); }
// Switching camera mid-run restarts the capture rather than pretending it took.
camsel.addEventListener('change',()=>{ if(handon.classList.contains('on')) hand('on'); });
(async()=>{
  const j=await (await fetch('/hand/cams')).json();
  camsel.innerHTML=j.cams.map(c=>`<option value=${c.index}>${c.name}</option>`).join('');
  camsel.value=j.using;
  hand('state');
})();

stopall.addEventListener('click',()=>panic());
// Feedback: without it a stop that worked and a stop that was swallowed look
// identical, which is how you end up mashing it.
async function flash(p){ stopall.classList.add('on'); await p;
  setTimeout(()=>stopall.classList.remove('on'),150); }
ver.addEventListener('click',()=>send('v'));
addEventListener('keydown',e=>{if(e.code==='Space'){e.preventDefault();panic();}});
// Tab hidden, window blurred, page closing — the hand is off the controls.
addEventListener('blur',panic);
addEventListener('pagehide',panic);
document.addEventListener('visibilitychange',()=>document.hidden&&panic());

function panic(){
  gen++;
  // Pause, don't kill: the arm must stop, but the camera stays up so the
  // preview survives clicking away from the tab.
  if(handon.classList.contains('on')) fetch('/hand/pause');
  for(const c in held) if(held[c]){clearInterval(held[c]); held[c]=null;}
  for(const s of document.querySelectorAll('input.thr')) s.value=0;
  for(const e of document.querySelectorAll('.spd')) e.textContent='0%';
  move('stop');
  flash(send('s'));
}

// IMPORTANT NOTE: the log is capped. Uncapped it was the lag — a held arrow
// appends ~6 lines/s and every append rebuilt one ever-growing text node, so
// the page got slower the longer you drove it and taps arrived late.
function put(t){
  if(!t.trim()) return;
  log.textContent=(t+'\n'+log.textContent).split('\n').slice(0,40).join('\n');
}
// IMPORTANT NOTE: one request in flight, in order. Parallel fetches are why
// STOP ALL sometimes did nothing — a jog dispatched a few ms earlier could
// reach the single-threaded server *after* the stop and re-command the joint.
// gen++ on every stop, and anything queued from before it is dropped unsent.
let q=Promise.resolve(), gen=0;
function send(v,quiet){
  const g=gen, stop=(v==='s');
  q=q.then(async()=>{
    if(g<gen && !stop) return;                    // superseded by a stop
    const t=await (await fetch('/cmd?c='+encodeURIComponent(v))).text();
    if(!quiet || t[0]==='!') put(t);              // repeats stay silent, errors never do
  }).catch(e=>put('!! '+e));
  return q;
}
// ------------------------------------------------------------------ moves
// One route, one response shape, one render — the same convention /hand uses.
let editing=null;
async function move(action,name,body){
  const q='/move/'+action+(name?('?name='+encodeURIComponent(name)):'');
  const r=await fetch(q, body?{method:'POST',headers:{'content-type':'application/json'},
                               body:JSON.stringify(body)}:undefined);
  paintMoves(await r.json());
}
function paintMoves(j){
  recbtn.classList.toggle('on',j.rec);
  recbtn.textContent=j.rec?('● recording — '+j.steps+' steps'):'● record';
  recstat.textContent=j.err?('!! '+j.err)
    :(j.playing?('playing '+j.playname+'  '+j.at+'/'+j.n):'');
  moves.innerHTML=Object.entries(j.moves).map(([n,k])=>`
   <div class=mv><span class=nm>${n}</span><span class=neu>${k} steps</span>
    <button data-p="${n}">▶ play</button>
    <button data-r="${n}">↩ reverse</button>
    <button data-e="${n}">edit</button>
    <button data-d="${n}">delete</button></div>`).join('')
   || '<small>nothing recorded yet</small>';
  for(const b of moves.querySelectorAll('[data-p]'))
    b.onclick=()=>move('play',b.dataset.p);
  for(const b of moves.querySelectorAll('[data-r]'))
    b.onclick=()=>move('reverse',b.dataset.r);
  for(const b of moves.querySelectorAll('[data-e]'))
    b.onclick=()=>openEdit(b.dataset.e);
  for(const b of moves.querySelectorAll('[data-d]'))
    b.onclick=()=>{ if(confirm('delete '+b.dataset.d+'?')) move('delete',b.dataset.d); };
}
recbtn.onclick=()=>move('rec');
recsave.onclick=()=>{ move('save',recname.value.trim()); recname.value=''; };
reccancel.onclick=()=>move('cancel');

function stepRow(st){
  const tr=document.createElement('tr');
  tr.innerHTML=`<td><input type=number value="${st.ms}"></td>
   <td><input type=text class=c value="${(st.cmd+'').replace(/"/g,'&quot;')}"></td>
   <td><button>✕</button></td>`;
  tr.querySelector('button').onclick=()=>tr.remove();
  return tr;
}
async function openEdit(name){
  const j=await (await fetch('/move/get?name='+encodeURIComponent(name))).json();
  editing=name; editname.textContent=name;
  steps.innerHTML='<tr><th>ms</th><th>cmd</th><th></th></tr>';
  for(const st of j.steps) steps.appendChild(stepRow(st));
  edit.classList.add('show');
}
editadd.onclick=()=>steps.appendChild(stepRow({ms:0,cmd:'s'}));
editclose.onclick=()=>{ edit.classList.remove('show'); editing=null; };
editsave.onclick=()=>{
  const out=[...steps.querySelectorAll('tr')].slice(1).map(tr=>{
    const i=tr.querySelectorAll('input');
    return {ms:+i[0].value||0, cmd:i[1].value};
  });
  move('put',editing,{steps:out});
  edit.classList.remove('show'); editing=null;
};
// Polls only while something is happening — a parked page costs nothing.
setInterval(()=>{ if(recbtn.classList.contains('on')||recstat.textContent)
                    move('state'); }, 500);
move('state');

setInterval(async()=>put(await (await fetch('/read')).text()),700);
</script>"""


@app.get("/")
def index():
    return PAGE


@app.get("/cmd")
def cmd():
    c = request.args.get("c", "")
    if c == "s":
        PLAY["on"] = False       # STOP ALL ends a playback, not just this pulse
    try:
        write(c)
        return Response("> " + c, mimetype="text/plain")
    except (serial.SerialTimeoutException, OSError, IOError) as e:
        drop()
        return Response("!! board gone (%s) — reconnecting" % e, mimetype="text/plain")


# ---------------------------------------------------------------- moves (rec)
def rec_state():
    """One shape for every rec/move call, so the page has a single code path for
    'what is it doing now' — same convention as /hand/<action>."""
    return {"rec": REC["on"], "steps": len(REC["steps"]),
            "playing": PLAY["on"], "playname": PLAY["name"],
            "at": PLAY["at"], "n": PLAY["n"], "err": PLAY["err"],
            "moves": {k: len(v) for k, v in sorted(load_moves().items())}}


@app.route("/move/<action>", methods=["GET", "POST"])
def move_ctl(action):
    name = (request.args.get("name") or "").strip()
    moves = load_moves()

    if action == "rec":
        # Refusing rather than nesting: recording a playback captures the take
        # twice and the copy is the one you would keep by accident.
        if not PLAY["on"]:
            REC.update(on=True, t0=time.time(), steps=[])
    elif action == "save":
        REC["on"] = False
        if name and REC["steps"]:
            moves[name] = REC["steps"]
            save_moves(moves)
    elif action == "cancel":
        REC.update(on=False, steps=[])
    elif action == "get":
        return {"name": name, "steps": moves.get(name, [])}
    elif action == "put":
        steps = clean((request.get_json(silent=True) or {}).get("steps"))
        if name and steps:
            moves[name] = steps
            save_moves(moves)
        elif name:
            moves.pop(name, None)          # editing every step away deletes it
            save_moves(moves)
    elif action == "reverse":
        inv = invert(clean(moves.get(name)))
        if inv:
            moves[name + " (back)"] = inv
            save_moves(moves)
    elif action == "delete":
        if moves.pop(name, None) is not None:
            save_moves(moves)
    elif action == "play":
        steps = clean(moves.get(name))
        if steps and not PLAY["on"] and not REC["on"]:
            PLAY.update(on=True, name=name, at=0, n=len(steps), err="")
            threading.Thread(target=_play, args=(steps,), daemon=True).start()
    elif action == "stop":
        PLAY["on"] = False
    # anything else ("state") just reports, which is what the page polls with
    return rec_state()


# ------------------------------------------------------------------ hand control
# Camera + mediapipe live in one background thread that owns the capture device
# and publishes annotated jpegs; the page just points an <img> at /hand/stream.
# Nothing here imports into the request path, so a missing opencv only breaks
# this feature instead of the whole bench page.
def cameras():
    """Names in the order macOS reports them, which is the order opencv indexes
    them. Asked rather than probed: opening a Continuity Camera to see if it
    exists wakes the phone, and a busy device would report as missing."""
    try:
        import subprocess
        out = subprocess.run(["system_profiler", "SPCameraDataType"],
                             capture_output=True, text=True, timeout=6).stdout
    except Exception:
        out = ""
    names = [ln.strip().rstrip(":") for ln in out.splitlines()
             if ln.strip().endswith(":") and ln.startswith("    ")
             and not ln.startswith("      ")]
    if not names:
        names = ["camera %d" % i for i in range(3)]
    return [{"index": i, "name": n} for i, n in enumerate(names)]


class Hand:
    def __init__(self):
        self.cam = 0
        self.on = False
        # Paused = camera still running, commands suppressed. Looking away must
        # stop the arm, but tearing the capture down to do it means the preview
        # dies every time the tab loses focus.
        self.paused = False
        self.frame = None            # latest annotated jpeg bytes
        self.cal = None
        self.calib = None            # a hand.Calibration while one is running
        self.status = "off"
        self.errors = 0
        self.missing = False
        self.ctl = None
        self.frames = 0              # heartbeat: a thread that is alive but not
        self.mode = ""               # counting is stuck, not merely idle
        self.err = None
        self.thread = None
        self.last = {}               # ch -> value last sent, so idle costs nothing
        self.at = {}

    # -- servo output -------------------------------------------------------
    def _send(self, ch, val, force=False):
        now = time.time()
        if not force and self.last.get(ch) == val and now - self.at.get(ch, 0) < H.REFRESH:
            return
        self.last[ch], self.at[ch] = val, now
        try:
            write("%d:%d" % (ch, val))
        except (serial.SerialTimeoutException, OSError, IOError):
            drop()

    def _stop(self):
        self.last.clear()
        try:
            write("s")
        except (serial.SerialTimeoutException, OSError, IOError):
            drop()

    # -- lifecycle ----------------------------------------------------------
    def start(self, recalibrate=False, cam=None):
        global H
        if H is None:
            self.err = "hand.py unavailable: %s" % IMPORT_ERR
            return False
        # Switching camera means a new capture device, so the old thread has to
        # let go of the current one first.
        if cam is not None and cam != self.cam and self.thread and self.thread.is_alive():
            self.on = False
            self.thread.join(timeout=3)
        if cam is not None:
            self.cam = cam
        self.cal = None if recalibrate else H.load_cal()
        self.calib = H.Calibration() if self.cal is None else None
        self.err = None
        self.on = True
        if not (self.thread and self.thread.is_alive()):
            self.thread = threading.Thread(target=self._loop, daemon=True)
            self.thread.start()
        return True

    def stop(self):
        self.on = False              # the loop closes the camera and stops the arm

    def pause(self, yes):
        if yes and not self.paused:
            self._stop()
        self.paused = yes

    def _loop(self):
        import cv2
        cam = self.cam
        cap = cv2.VideoCapture(cam)
        # 640x360 is plenty for landmarks and roughly half the jpeg of 800x450.
        # Every frame is an http round trip here, so pixels are latency.
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 360)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)      # newest frame, not a backlog
        if not cap.isOpened():
            self.err = ("camera %d would not open — is it in use, or does the "
                        "terminal lack camera access in System Settings > "
                        "Privacy & Security?" % cam)
            self.on, self.status = False, "no camera"
            return
        detect = H.make_detector()
        self.missing, self.ctl, self.readfail = False, H.Controller(), 0
        try:
            while self.on:
                try:
                    if not self._frame(cap, detect):
                        break
                except Exception as e:
                    # One bad frame must not end the session. Killing the thread
                    # here is what made the preview vanish rather than glitch,
                    # and the traceback went nowhere anyone would look.
                    import traceback
                    self.errors += 1
                    self.err = "%s: %s" % (type(e).__name__, e)
                    traceback.print_exc()
                    time.sleep(0.1)
        finally:
            cap.release()
            # on=False here too: the loop can end on its own (camera unplugged,
            # read failure), and leaving it True left the page polling forever
            # for frames that were never coming again.
            self.on, self.frame, self.status = False, None, "off"
            self._stop()

    def _frame(self, cap, detect):
        """One camera frame, start to finish. Returns False when the camera has
        stopped delivering and the session should end."""
        import cv2
        ok, frame = cap.read()
        if not ok:
            # IMPORTANT NOTE: avfoundation returns one empty frame on its own
            # (continuity camera handing off, another app grabbing the device,
            # a resolution renegotiation). Ending the session on the first one
            # is what makes the preview die out of nowhere. 30 in a row (~1s)
            # is a real disconnect; a retry loop that reopens the device would
            # be the next rung if it ever needs one.
            self.readfail += 1
            if self.readfail < 30:
                time.sleep(0.03)
                return True
            self.err = "camera stopped delivering frames"
            return False
        self.readfail = 0
        self.frames += 1
        frame = cv2.flip(frame, 1)
        h, w = frame.shape[:2]
        lm = detect(frame)
        m = None
        if lm:
            H.draw_hand(frame, lm, w, h)
            m = H.hand_metrics(lm)

        if self.paused:
            if not self.missing:
                self.missing = True
                self._stop()
            self.status = "paused — tab not focused"
            H.draw_zones(frame)
            H.banner(frame, [("PAUSED — click the page to drive", (90, 200, 255))])
        elif self.calib is not None:
            held = self.calib.feed(m)
            cv2.rectangle(frame, (14, h - 34),
                          (14 + int((w - 28) * held), h - 14), (90, 220, 90), -1)
            H.banner(frame, [("CALIBRATE %d/3" % min(self.calib.step + 1, 3),
                              (90, 220, 255)),
                             (self.calib.prompt(), (255, 255, 255))])
            self.status = "calibrating: " + self.calib.prompt()
            if self.calib.done:
                self.cal, self.calib = self.calib.done, None
        elif m and self.cal:
            self.missing = False
            r = self.ctl.feed(m, self.cal)
            H.draw_zones(frame, r["hover"], r["pressed"], m["point"])
            H.draw_kill(frame, r.get("kill_progress"))
            if r["stop"]:
                self._stop()
            for ch, v in r["sends"]:
                self._send(ch, v, force=True)
            self.mode = self.status = r["mode"]
            H.banner(frame, [(r["mode"], (90, 220, 255)),
                             ("claw %d deg" % r["grip"], (255, 255, 255))])
            if r.get("kill"):
                # The gesture switches the whole feature off, camera included:
                # "disable" that leaves the camera watching is not disabled.
                self.status = "switched off by the pinky gesture"
                self.on = False
        else:
            # IMPORTANT NOTE: no hand means stop, not carry on. A frozen camera
            # is indistinguishable from a hand held perfectly still, and these
            # joints have no end stop.
            if self.cal:
                for ch, v in self.ctl.feed(None, self.cal)["sends"]:
                    self._send(ch, v, force=True)
            if not self.missing:
                self.missing = True
                self._stop()
            self.status = "no hand — stopped"
            H.draw_zones(frame)
            H.banner(frame, [("NO HAND — stopped", (80, 80, 255))])

        enc, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 55])
        if enc:
            self.frame = buf.tobytes()
        return True


try:
    import hand as H
    IMPORT_ERR = None
except Exception as e:                    # opencv/mediapipe missing or broken
    H, IMPORT_ERR = None, e

HAND = Hand()


@app.get("/hand/<action>")
def hand_ctl(action):
    """on / off / cal / state — all four answer with the same shape, so the page
    has one code path for 'what is it doing now'."""
    cam = request.args.get("cam")
    cam = int(cam) if cam not in (None, "") else None
    if action == "on":
        HAND.start(cam=cam)
    elif action == "cal":
        HAND.start(recalibrate=True, cam=cam)
    elif action == "off":
        HAND.stop()
    elif action in ("pause", "resume"):
        HAND.pause(action == "pause")
    elif action == "cams":
        return {"cams": cameras(), "using": HAND.cam}
    elif action == "engage" and HAND.ctl:
        HAND.ctl.toggle()
    elif action == "speed" and HAND.ctl:
        HAND.ctl.cycle_speed()
    return {"on": HAND.on, "status": HAND.status, "err": str(HAND.err or ""),
            "cam": HAND.cam, "paused": HAND.paused, "mode": HAND.mode,
            "frames": HAND.frames, "hasframe": HAND.frame is not None,
            "errors": HAND.errors,
            "engaged": bool(HAND.ctl and HAND.ctl.engaged),
            "speed": H.SPEEDS[HAND.ctl.speed][0] if HAND.ctl else ""}


# IMPORTANT NOTE: long boundary AND a Content-Length on every part. Without the
# length the browser has to hunt for the next boundary inside the jpeg's own
# bytes, and a short marker occurs in that binary constantly — each false hit
# truncates the frame, which renders as an image that is grey from some line
# down. Neither half is optional.
BOUNDARY = b"blkfrontier9e3f1a7c2d4b"


PLACEHOLDER = None


def placeholder(text):
    """A real jpeg saying why there is no picture. Serving an error status here
    instead makes the <img> fail, and a failed <img> collapses — which reads as
    the preview vanishing rather than as 'waiting for the camera'."""
    global PLACEHOLDER
    if PLACEHOLDER is None:
        try:
            import cv2, numpy as np
            img = np.full((450, 800, 3), 24, np.uint8)
            cv2.putText(img, text[:44], (30, 230), cv2.FONT_HERSHEY_SIMPLEX,
                        0.7, (170, 170, 170), 1, cv2.LINE_AA)
            PLACEHOLDER = cv2.imencode(".jpg", img)[1].tobytes()
        except Exception:
            PLACEHOLDER = b""
    return PLACEHOLDER


@app.get("/hand/snap")
def hand_snap():
    """One jpeg. The page uses this on a loop rather than /hand/stream: a
    multipart stream is one long-lived response that any proxy, tab throttle or
    aborted navigation can silently end, and when it does the picture just stops
    with nothing to retry. A snapshot that fails is one dropped frame."""
    f = HAND.frame or placeholder("waiting for the camera...")
    r = Response(f, mimetype="image/jpeg")
    r.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return r


@app.get("/hand/stream")
def hand_stream():
    def frames():
        last = None
        while HAND.on:
            f = HAND.frame
            if f is not None and f is not last:
                last = f
                yield (b"--" + BOUNDARY + b"\r\n"
                       b"Content-Type: image/jpeg\r\n"
                       b"Content-Length: " + str(len(f)).encode() + b"\r\n\r\n"
                       + f + b"\r\n")
            else:
                time.sleep(0.01)      # nothing new yet; don't respin the cpu
    r = Response(frames(), mimetype=("multipart/x-mixed-replace; boundary="
                                     + BOUNDARY.decode()))
    r.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    r.headers["X-Accel-Buffering"] = "no"
    return r


@app.get("/dbg")
def dbg():
    app.logger.warning("DBG %s", request.args.get("e", ""))
    return Response("", mimetype="text/plain")


@app.get("/read")
def read():
    try:
        with LOCK:
            p = port()
            data = p.read(p.in_waiting or 0)
        return Response(data.decode(errors="replace"), mimetype="text/plain")
    except (OSError, IOError) as e:
        drop()
        return Response("!! board gone (%s)" % e, mimetype="text/plain")


def selftest():
    """The recorder is a tape of wire traffic — what matters is that the
    timestamps survive, that a hand-edited step cannot reach the port as
    nonsense, and that a stop lands mid-take instead of after it."""
    global write
    real, sent = write, []

    def fake(cmd):
        sent.append((round(time.time() - t0, 2), cmd))
        _record(cmd)

    # a take keeps order and gaps, and stops recording when told
    write = fake
    t0 = time.time()
    REC.update(on=True, t0=t0, steps=[])
    fake("15:100"); time.sleep(0.05); fake("15:0")
    REC["on"] = False
    fake("12:100")                       # after the stop: must not be captured
    got = REC["steps"]
    assert [st["cmd"] for st in got] == ["15:100", "15:0"], got
    assert got[0]["ms"] == 0 and 30 <= got[1]["ms"] <= 200, got

    # the cap is real, or a recorder left on eats the machine
    REC.update(on=True, t0=time.time(), steps=[{"ms": 0, "cmd": "s"}] * REC_MAX)
    _record("15:100")
    assert len(REC["steps"]) == REC_MAX
    REC["on"] = False

    # clean(): junk from the editor never reaches the port, and rows re-sort
    c = clean([{"ms": "30", "cmd": " 15:100 "}, {"ms": None, "cmd": "s"},
               {"ms": 5, "cmd": ""}, {"ms": -9, "cmd": "12:50"}, {"cmd": None}])
    assert c == [{"ms": 0, "cmd": "s"}, {"ms": 0, "cmd": "12:50"},
                 {"ms": 30, "cmd": "15:100"}], c

    # playback replays in order, and always lands stopped
    sent[:] = []; t0 = time.time()
    PLAY.update(on=True, name="t", at=0, n=3, err="")
    _play([{"ms": 0, "cmd": "15:100"}, {"ms": 60, "cmd": "15:0"}])
    assert [x[1] for x in sent] == ["15:100", "15:0", "s"], sent
    assert sent[1][0] >= 0.05, "the gap between steps must be honoured"
    assert not PLAY["on"]

    # a stop mid-take ends it there, still stopped, without waiting out the gap
    sent[:] = []; t0 = time.time()
    PLAY.update(on=True, name="t", at=0, n=2, err="")
    threading.Timer(0.05, lambda: PLAY.update(on=False)).start()
    _play([{"ms": 0, "cmd": "15:100"}, {"ms": 5000, "cmd": "15:0"}])
    assert [x[1] for x in sent] == ["15:100", "s"], sent
    assert time.time() - t0 < 1.0, "stop must not wait out a 5s gap"

    # segments(): deadman refreshes merge into one burst, and non-travel is skipped
    take = [{"ms": 0, "cmd": "15:100"}, {"ms": 300, "cmd": "15:100"},
            {"ms": 600, "cmd": "15:100"}, {"ms": 800, "cmd": "15:0"},
            {"ms": 800, "cmd": "n12:1490"}, {"ms": 900, "cmd": "t4"},
            {"ms": 1000, "cmd": "12:-50"}, {"ms": 1400, "cmd": "s"}]
    segs = segments(take)
    assert segs == [["15", 100, 0, 800], ["12", -50, 1000, 1400]], segs

    # two joints moving at once stay together through the mirror
    both = segments([{"ms": 0, "cmd": "15:100"}, {"ms": 0, "cmd": "12:60"},
                     {"ms": 500, "cmd": "s"}])
    assert both == [["15", 100, 0, 500], ["12", 60, 0, 500]], both

    # invert(): mirrored timeline, negated speeds, still deadman-fed
    inv = invert(take)
    assert inv[0]["cmd"] == "12:50", inv[:2]       # last burst undone first
    assert inv[0]["ms"] == 0 and inv[-1] == {"ms": 1400, "cmd": "15:0"}, inv[-1]
    for ch in ("15", "12"):
        runs = [st for st in inv if st["cmd"].startswith(ch + ":")]
        assert runs[-1]["cmd"] == ch + ":0", runs[-1]
        # every burst re-sent inside the board's 800ms deadman
        for a, b in zip(runs, runs[1:]):
            assert b["ms"] - a["ms"] <= FEED_MS, (ch, a, b)
    assert FEED_MS < 800, "must stay inside the board's JOG_MS"

    # the inverse of a take that never moved is nothing, not a crash
    assert invert([]) == [] and invert([{"ms": 0, "cmd": "s"}]) == []
    assert invert([{"ms": 0, "cmd": "t4"}]) == []

    # saved takes round-trip through the file, and deleting removes it
    global MOVES_F
    keep, MOVES_F = MOVES_F, MOVES_F + ".selftest"
    try:
        save_moves({"a": c})
        assert load_moves() == {"a": c}
        os.remove(MOVES_F)
        assert load_moves() == {}, "a missing file reads as no moves, not a crash"
    finally:
        MOVES_F = keep
        write = real
    print("selftest ok")


if __name__ == "__main__":
    # HTTP/1.1 so connections are reused. The dev server defaults to 1.0, which
    # closes the socket after every response — at one http request per camera
    # frame that is ~30 connection setups a second, and the resulting jitter is
    # what the preview showed as flicker and lag. (It also burns through
    # ephemeral ports fast enough to start failing outright.)
    from werkzeug.serving import WSGIRequestHandler
    WSGIRequestHandler.protocol_version = "HTTP/1.1"
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    print("serial:", find_port(), "-> http://127.0.0.1:5005")
    app.run(port=5005, threaded=True)    # writes are serialised by LOCK instead
