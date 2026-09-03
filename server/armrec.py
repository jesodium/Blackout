"""Arm bench recorder. python3 server/armrec.py -> :5006

A serial pipe to the Giga, not to the Uno bench rig: main.ino reads the same
command strings off USB that it reads off BLE (`Serial.readStringUntil` in
loop()), so every line here is exactly what the dashboard would have written
over the link — `arm,<joint>,<speed>`, `armz,`, `arml,`, `stop`.

Why this exists at all: the dashboard's arrows and hold sliders are a live
control surface, and a live control surface is how a joint gets overdriven. The
point is to overdrive things HERE, once, on the bench, then save the take to
server/arm_moves/<name>.json — one file per take, which the dashboard turns
into one tap per move.

It talks to the board over USB **or** over BLE, operator's pick. USB is the
bench cable and is instant; BLE is the link the rover actually runs on, with a
with-response write round-trip bound at the ~15ms connection interval — so a take
recorded over BLE has comp-day timing baked into its gaps, which is the whole
reason the choice exists. Only one central can hold the peripheral, so the
dashboard has to let go of the link before this can take it.

IMPORTANT NOTE: this records COMMANDS, not positions. Every joint is a 360 with
no encoder, so there is nothing to read back and no "go to 0" to command; a take
is dead reckoning replayed from wherever the arm happens to be sitting. Start it
from the same pose or it ends up somewhere else. The board's travel budget
(ARM_TRAVEL_MS in arm.h) is the backstop, and it is dead reckoning too.
"""
import asyncio, io, json, os, re, sys, threading, time
import serial, serial.tools.list_ports
from flask import Flask, request

HERE = os.path.dirname(os.path.abspath(__file__))
MOVES_D = os.path.join(HERE, "arm_moves")   # one file per take, name = filename
JOINTS = ["base", "shoulder", "elbow", "wrist", "gripwrist", "gripper"]
REPEAT_MS = 300      # under the board's 800ms ARM_JOG_MS deadman
REC_MAX = 5000       # a recorder left on overnight must not eat the machine
NUDGE_MS = 120       # bench knob: a tap of the small arrows is this long at the
                     # row's set power. Fine control on a LOADED joint is a
                     # SHORTER burst, never a gentler one — pulse width is speed
                     # and torque at once, so a slow pulse on a 360 is a weak one.
SPEED_MIN = 20       # floor on the per-joint speed slider. Below roughly this the
                     # pulse is inside the servo's 100us+ deadband and the joint
                     # buzzes instead of turning. The slider is per joint because
                     # some moves want slow (lining the gripper up) and some want
                     # everything the joint has (lifting the shoulder); it scales
                     # the +/-100 the arrows send, so the speed rides into the
                     # recorded `arm,<j>,<speed>` and replays exactly as jogged.
BOARD_NAME = "BLACKOUT-V3"    # what BLE pairing matches on, same as the dashboard
BLE_CMD = "19b10002-e8f2-537e-4f6c-d104768a1214"   # cmdChar in main.ino
BLE_SVC = "19b10000-e8f2-537e-4f6c-d104768a1214"   # sensorService in main.ino

LINK = {"kind": "usb"}        # "usb" | "ble"


def wire(cmd, kind):
    """The one difference between the two transports, and it is easy to get
    backwards: over USB main.ino reads with readStringUntil('\n') and needs the
    terminator, over BLE cmdChar hands handleCmd() the whole written value and a
    trailing newline would ride along into the command string."""
    return (cmd + "\n").encode() if kind == "usb" else cmd.encode()


def find_port():
    return next((p.device for p in serial.tools.list_ports.comports()
                 if "usbmodem" in p.device or "ttyACM" in p.device), None)


ser = None
LOCK = threading.RLock()
DRAIN = [False]


def _drain():
    """Read the board's serial output and throw it away, forever.

    IMPORTANT NOTE: nothing here wants the telemetry, but nothing may ignore it
    either. main.ino prints its CSV line at 10Hz; with no reader the tty input
    buffer fills in a few seconds, the board's Serial.println() then blocks on a
    CDC endpoint the host has stopped draining, and loop() stalls inside it — so
    the command written a moment ago sits unread and every jog lags the button.
    Measured 2026-09-02: 60ms a command before this, ~1ms after.
    """
    while True:
        s = ser
        try:
            if s:
                s.read(4096)                # returns on `timeout`, data or not
                continue
        except Exception:
            pass                            # closed under us; port() reopens
        time.sleep(0.05)


def port():
    global ser
    if ser is None:
        dev = find_port()
        if not dev:
            raise IOError("giga not on usb")
        # write_timeout: a browned-out board stops draining the CDC buffer and
        # write() blocks forever, wedging the whole server.
        ser = serial.Serial(dev, 9600, timeout=0.2, write_timeout=1)
        if not DRAIN[0]:
            DRAIN[0] = True
            threading.Thread(target=_drain, daemon=True).start()
        time.sleep(2)
    return ser


# ------------------------------------------------------------------------ ble
# bleak is async and flask is not, so one event loop lives in a daemon thread and
# every call is handed to it. IMPORTANT NOTE: one loop, one client, one command
# at a time — write() already holds LOCK, which is what keeps writes from
# interleaving on a link that is round-trip bound.
BLE = {"loop": None, "client": None}


def ble_call(coro, timeout):
    if BLE["loop"] is None:
        threading.Thread(target=_ble_thread, daemon=True).start()
        while BLE["loop"] is None:
            time.sleep(0.01)
    return asyncio.run_coroutine_threadsafe(coro, BLE["loop"]).result(timeout)


def _ble_thread():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    BLE["loop"] = loop
    loop.run_forever()


def is_board(d, ad):
    """Match the SERVICE, not the name — the same rule the dashboard and the
    Electron picker use (`filters: [{ services: [BLE_SERVICE] }]`).

    IMPORTANT NOTE: main.ino only calls BLE.setLocalName(), so the GAP device
    name stays ArduinoBLE's default "Arduino" and only the *advertisement's*
    local name says BLACKOUT-V3. bleak's find_device_by_name() reads the former,
    so it never matched and the link read as "not advertising" with the board
    sitting right there advertising (2026-09-02). The name is the fallback.
    """
    return (BLE_SVC in [u.lower() for u in (getattr(ad, "service_uuids", None) or [])]
            or (getattr(ad, "local_name", None) or "") == BOARD_NAME)


async def _ble_connect():
    from bleak import BleakClient, BleakScanner
    dev = await BleakScanner.find_device_by_filter(is_board, timeout=12)
    if not dev:
        raise IOError(BOARD_NAME + " not advertising — is the dashboard holding "
                      "the link? only one central at a time")
    c = BleakClient(dev)
    await c.connect()
    BLE["client"] = c


async def _ble_write(cmd):
    c = BLE["client"]
    if c is None or not c.is_connected:
        await _ble_connect()
        c = BLE["client"]
    # with-response, same as the dashboard's writeValue: the round trip IS the
    # comp-day latency, and recording without it makes a take that plays faster
    # than it was taken.
    await c.write_gatt_char(BLE_CMD, wire(cmd, "ble"), response=True)


async def _ble_drop():
    c, BLE["client"] = BLE["client"], None
    if c and c.is_connected:
        await c.disconnect()


def ble_up():
    c = BLE["client"]
    return bool(c and c.is_connected)


def write(cmd):
    """The one choke point every command passes through — which is why the
    recorder hooks in here and not in a widget: a take is a faithful copy of the
    session, arrows and playback and panic stops alike."""
    with LOCK:
        if LINK["kind"] == "ble":
            ble_call(_ble_write(cmd), 8)    # reconnects itself if the link dropped
        else:
            try:
                port().write(wire(cmd, "usb"))
            except Exception:
                global ser
                try:
                    ser and ser.close()
                except Exception:
                    pass
                ser = None                  # reopen next time rather than 500
                raise
        _record(cmd)                        # after the write: a take is what the
                                            # arm actually did, not what was asked
                                            # of a board that had dropped off usb


# ------------------------------------------------------------------- recording
REC = {"on": False, "t0": 0.0, "steps": []}
PLAY = {"on": False, "name": ""}


def _record(cmd):
    if REC["on"] and len(REC["steps"]) < REC_MAX:
        REC["steps"].append({"ms": int((time.time() - REC["t0"]) * 1000), "cmd": cmd})


# A take is either a bare list of steps (everything recorded before the flags
# existed — those count as usable everywhere) or {"steps": [...],
# "sage_can_use": bool, "show_in_app": bool}. The bench fills up with debug
# takes, and a debug take is exactly what should not be one tap away on comp day
# or in Sage's hands, so each one carries its own two flags.
FLAGS = ("sage_can_use", "show_in_app")


def steps_of(v):
    return v.get("steps") if isinstance(v, dict) else v


def flags_of(v):
    return {f: bool(v.get(f, True)) if isinstance(v, dict) else True for f in FLAGS}


def wrap(steps, flags=None):
    return dict(steps=steps, **(flags or {f: True for f in FLAGS}))


def path_of(name):
    """A take is a file and its NAME is the filename, so a move can be opened,
    diffed, mailed to another rig or deleted in Finder without this tool running.
    That also makes the filename rules the naming rules: no separator (it would
    write outside the folder) and no leading dot (it would hide the take).
    Returns None for a name that cannot be a file — callers 400 on it."""
    name = (name or "").strip()
    if not name or "/" in name or "\\" in name or name.startswith(".") or len(name) > 100:
        return None
    return os.path.join(MOVES_D, name + ".json")


def load_moves():
    """The folder IS the collection — no index file to fall out of step with it.
    A take that is half-written or hand-mangled is skipped, not fatal: the bench
    stays usable with one bad file in the folder."""
    out = {}
    try:
        names = os.listdir(MOVES_D)
    except OSError:
        return out                      # no folder yet = nothing recorded
    for f in sorted(names):
        if not f.endswith(".json"):
            continue
        try:
            with open(os.path.join(MOVES_D, f)) as fh:
                out[f[:-5]] = json.load(fh)
        except (IOError, ValueError):
            continue
    return out


def save_move(name, val):
    os.makedirs(MOVES_D, exist_ok=True)
    with open(path_of(name), "w") as f:
        json.dump(val, f, indent=1)


def del_move(name):
    try:
        os.remove(path_of(name) or "")
        return True
    except OSError:
        return False


def clean(steps):
    """Whatever gets posted, coerced. An ms of "" or a cmd of None reaching the
    serial port is a hang, not a typo. NB: str(None) is "None", and truthy."""
    out = []
    for st in steps or []:
        cmd = st.get("cmd")
        cmd = "" if cmd is None else str(cmd).strip()
        if not cmd or not cmd.startswith(("arm,", "armh,", "armz,", "stop")):
            continue                        # a take drives the arm and nothing else
        try:
            ms = max(0, int(st.get("ms", 0)))
        except (TypeError, ValueError):
            ms = 0
        out.append({"ms": ms, "cmd": cmd})
    out.sort(key=lambda st: st["ms"])
    # The clock starts at RECORD, not at the first jog, so a take carries the
    # operator's reaction time as dead air at the head — replayed faithfully,
    # that is a button that looks broken for two seconds. The GAPS are the take
    # (the deadman lives on them) and shifting every step by the same amount
    # keeps every one of them; only the lead-in goes.
    if out:
        lead = out[0]["ms"]
        for st in out:
            st["ms"] -= lead
    return out


def play(steps):
    """Replay a take with its original gaps. The gaps are the point: the board's
    deadman lives on them, so a take that is squashed flat drives further than
    the one that was recorded."""
    t0 = time.time()
    try:
        for st in steps:
            if not PLAY["on"]:
                break
            gap = st["ms"] / 1000.0 - (time.time() - t0)
            if gap > 0:
                time.sleep(gap)
            write(st["cmd"])
    finally:
        PLAY["on"] = False
        try:
            park()                          # always land stopped, even on a throw
        except Exception:
            pass


def park():
    """Land every joint on its hold bias. IMPORTANT NOTE: NOT bare `arm,` — that
    is armStopAll(), a true kill, and it drops the holding pulse the instant the
    take ends, which is a joint that lifts and then sags straight back down. Only
    the panic stop kills; the end of a take parks."""
    for i in range(len(JOINTS)):
        write("arm,%d,0" % i)               # armJog(i, 0) -> armPark() -> hold


# ------------------------------------------------------------------------ page
PAGE = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>arm recorder</title><style>
:root{--bg:#14110d;--pane:#1b1712;--line:#332d25;--fg:#ece5d6;--dim:#8a8072;
 --acc:#d9a441;--red:#c4483f;--grn:#6f9e5b}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);margin:0 auto;padding:18px 16px 76px;max-width:660px;
 font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;-webkit-font-smoothing:antialiased}
h1{font-size:15px;letter-spacing:.16em;text-transform:uppercase;margin:0}
.hd{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:0 0 8px;
 font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.pane{background:var(--pane);border:1px solid var(--line);border-radius:10px;padding:12px;margin:12px 0}
.top{display:flex;justify-content:space-between;align-items:center;gap:10px}
.dot{width:8px;height:8px;border-radius:999px;background:var(--red);display:inline-block}
.dot.up{background:var(--grn)}
button{background:#241f19;color:var(--fg);border:1px solid var(--line);border-radius:8px;
 min-height:44px;min-width:52px;font:inherit;cursor:pointer;touch-action:none;
 transition:background .12s,border-color .12s,color .12s}
button:hover{border-color:#4d453a}
button:active{background:#3a342b}
button:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
button[disabled]{opacity:.35;cursor:not-allowed}
.wide{width:100%}
.on{background:#2f2a13;border-color:var(--acc);color:var(--acc)}
.row{display:flex;gap:6px;align-items:center}
.row>.wide{flex:1}
.jrow{display:grid;grid-template-columns:1fr auto auto auto auto auto;gap:6px;align-items:center;
 padding:5px 0;border-top:1px solid var(--line)}
.jrow:first-child{border-top:0}
.jrow.live{color:var(--acc)}
.jrow small{color:var(--dim)}
.nudge{min-width:44px;font-size:11px;color:var(--dim)}
.spd{display:flex;gap:5px;align-items:center;color:var(--dim);font-size:11px}
.spd input{width:88px;accent-color:var(--acc);touch-action:none}
.spd b{font-weight:400;min-width:26px;text-align:right;color:var(--fg)}
.hint{color:var(--dim);font-size:11px;margin:8px 0 0}
.rec{border-color:var(--red);color:#e9b6b0}
.rec.on{background:var(--red);border-color:var(--red);color:#fff}
.mv{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;
 padding:8px 0;border-top:1px solid var(--line)}
.mv:first-child{border-top:0}
.nm{cursor:text;border-bottom:1px dotted transparent}
.nm:hover{border-bottom-color:var(--dim)}
.meta{color:var(--dim);font-size:11px}
input.ren{width:100%;background:#0f0d0a;border:1px solid var(--acc);border-radius:6px;
 color:var(--fg);font:inherit;padding:6px}
.acts{display:flex;gap:6px;align-items:center}
.chip{min-height:30px;min-width:0;padding:0 9px;border-radius:999px;font-size:11px;color:var(--dim)}
.warn{border-color:var(--red);color:#e9b6b0}
.bar{position:fixed;left:0;right:0;bottom:0;background:#0f0d0a;border-top:1px solid var(--line);
 padding:8px 12px;display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center}
#log{color:var(--dim);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#log.err{color:var(--red)}
.panic{background:#3a1512;border-color:var(--red);color:#f0c9c4}
</style>
<div class=top><h1>arm recorder</h1>
 <div class=row><span class=dot id=dot></span><span id=linkst class=meta>link</span>
  <button id=usb onclick="link('usb')">usb</button>
  <button id=ble onclick="link('ble')">ble</button></div></div>

<div class=pane>
 <div class=hd><span>joints</span><span id=jstate></span></div>
 <div id=joints></div>
 <p class=hint>&#9664;&#9654; jog while held &nbsp;·&nbsp; &#9666;&#9656; tap = %NUDGE%ms, then parked
  &nbsp;·&nbsp; the slider is that row's speed, and it is recorded with the take</p>
 <label class=hint><input type=checkbox id=parkchk checked> park on release (hold against gravity)</label>
</div>

<div class=pane>
 <div class=hd><span>travel</span></div>
 <div class=row><button class=wide onclick="send('armz,')">zero travel (this is home)</button>
  <button onclick="send('arml,0')">limits off</button>
  <button onclick="send('arml,1')">limits on</button></div>
</div>

<div class=pane>
 <div class=hd><span>take</span><span id=recmeta></span></div>
 <div class=row><button class="wide rec" id=recbtn onclick=rec()>&#9679; record</button>
  <button id=savebtn onclick=save()>save as&hellip;</button></div>
</div>

<div class=pane>
 <div class=hd><span>moves</span><span id=mvcount></span></div>
 <div id=moves></div>
</div>

<div class=bar><span id=log>ready</span>
 <button class=panic onclick="send('stop')">&#9632; PANIC STOP &nbsp;<small>space</small></button></div>
<script>
const J=%JOINTS%;
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const say=(t,err)=>{log.textContent=t;log.classList.toggle('err',!!err)};
let held=null;
setInterval(()=>{if(held)send('arm,'+held[0]+','+held[1],1)},%REP%);
// IMPORTANT NOTE: one request in flight, in order. Parallel fetches are why a
// release could land behind a pile of queued repeats and leave the joint
// turning. gen++ on every stop drops anything queued from before it, unsent.
let q=Promise.resolve(),gen=0;
function send(c,quiet){const g=gen,stop=(c==='stop'||c==='arm,'||/^arm,\\d+,0$/.test(c));
 if(stop)gen++;
 q=q.then(async()=>{if(g<gen&&!stop)return;
  const t=await(await fetch('/cmd?c='+encodeURIComponent(c),{method:'POST'})).text();
  if(t[0]!=='o')say(c+'  ->  '+t,1);else if(!quiet)say(c)}).catch(e=>say('!! '+e,1));
 return q}
// Per-joint speed. It scales the arrows' +/-100, so what goes on the wire is
// what gets recorded — no second field in the take, no playback that has to know
// about sliders. IMPORTANT NOTE: pulse width is speed AND torque, so a slow
// setting on a gravity-loaded joint may not lift it at all; that is the servo,
// not the slider. Kept per rig in localStorage, not in a file anyone reflashes.
const SPD=JSON.parse(localStorage.armSpd||'{}');
const spd=i=>SPD[i]||100;
function setspd(i,v){SPD[i]=v;localStorage.armSpd=JSON.stringify(SPD);
 joints.children[i].querySelector('.spd b').textContent=v+'%';
 if(held&&held[0]===i)held[1]=Math.sign(held[1])*v}   // mid-hold: felt on the next repeat
function hold(i,d){return e=>{e.preventDefault();d=Math.sign(d)*spd(i);
 held=[i,d];live(i,1);send('arm,'+i+','+d)}}
// Park, never bare `arm,` — that one is armStopAll(), a kill of all 16. Parking
// applies whatever hold bias armSv[]/armh, last set, and that pulse is the only
// thing holding a gravity-loaded 360 up: released, it free-wheels either way.
// Unchecked overrides the bias to 0 (limp) and there is no per-joint command to
// put the table's number back — reset the board for that.
function park(i){held=null;live(i,0);
 if(!parkchk.checked)send('armh,'+i+',0',1);
 send('arm,'+i+',0')}
function rel(i){return()=>{if(held&&held[0]===i)park(i)}}
const live=(i,on)=>joints.children[i]&&joints.children[i].classList.toggle('live',!!on);
// The small arrows are the big ones at full power for NUDGE ms and then parked,
// which is how a loaded joint gets moved a little without sagging back down —
// the two sizes differ in DURATION only. !held lets an arrow press win the
// pending auto-park; nb makes the last tap the one that parks.
const NUDGE=%NUDGE%; let nb=0;
function nudge(i,d){return e=>{e.preventDefault();const n=++nb;d=Math.sign(d)*spd(i);
 live(i,1);send('arm,'+i+','+d);
 setTimeout(()=>{if(n===nb&&!held)park(i)},NUDGE)}}
joints.innerHTML=J.map((n,i)=>`<div class=jrow><span>${n} <small>j${i}</small></span>
 <label class=spd title="speed for this joint — recorded with the take"><input type=range
  data-s=${i} min=%SPDMIN% max=100 step=5 value=${spd(i)}><b>${spd(i)}%</b></label>
 <button data-j=${i} data-d=-100 title="jog while held">&#9664;</button>
 <button data-j=${i} data-d=100 title="jog while held">&#9654;</button>
 <button class=nudge data-n=${i} data-d=-100 title="nudge">&#9666;</button>
 <button class=nudge data-n=${i} data-d=100 title="nudge">&#9656;</button></div>`).join('');
for(const b of joints.querySelectorAll('[data-j]')){
 const i=+b.dataset.j,d=+b.dataset.d;
 b.onpointerdown=hold(i,d);b.onpointerup=rel(i);b.onpointerleave=rel(i);b.onpointercancel=rel(i);
 b.oncontextmenu=e=>e.preventDefault()}
for(const b of joints.querySelectorAll('[data-n]'))
 b.onclick=nudge(+b.dataset.n,+b.dataset.d);
for(const r of joints.querySelectorAll('[data-s]'))
 r.oninput=()=>setspd(+r.dataset.s,+r.value);
const post=async(u)=>(await fetch(u,{method:'POST'})).json();
async function link(to){const j=await post('/link?to='+to);if(j.error)say(j.error,1);paint(j)}
async function rec(){const j=await post('/rec');if(j.error)say(j.error,1);paint(j)}
async function save(){const n=prompt('name this move');if(!n)return;
 paint(await post('/rec?save='+encodeURIComponent(n.trim())))}
const secs=ms=>(ms/1000).toFixed(1)+'s';
let armed=null;   // name of the take waiting on its second delete tap
function paint(j){
 dot.className='dot'+(j.up?' up':'');
 linkst.textContent=j.link+(j.up?' ready':' down');
 usb.classList.toggle('on',j.link==='usb');ble.classList.toggle('on',j.link==='ble');
 jstate.textContent=j.play?'playing '+j.play:'';
 recbtn.textContent=j.rec?'\\u25CF stop recording':'\\u25CF record';
 recbtn.classList.toggle('on',j.rec);
 recmeta.textContent=j.steps?j.steps+' steps · '+secs(j.ms):'';
 savebtn.disabled=!j.steps;
 const es=Object.entries(j.moves);
 mvcount.textContent=es.length?es.length+' saved':'';
 moves.innerHTML=es.map(([n,m])=>`<div class=mv>
  <div><span class=nm data-r="${esc(n)}" title="click to rename">${esc(n)}</span>
   <div class=meta>${m.n} steps · ${secs(m.ms)}</div></div>
  <div class=acts>
   <button class="chip${m.sage_can_use?' on':''}" data-f="${esc(n)}" data-k=sage_can_use
    title="sage may play this">sage</button>
   <button class="chip${m.show_in_app?' on':''}" data-f="${esc(n)}" data-k=show_in_app
    title="shown in the dashboard arm pad">app</button>
   <button data-p="${esc(n)}" title=play ${j.play?'disabled':''}>&#9654;</button>
   <button data-x="${esc(n)}" title=delete>&#10005;</button></div></div>`).join('')
  ||'<div class=meta>nothing recorded yet</div>';
 for(const b of moves.querySelectorAll('[data-f]'))
  b.onclick=async()=>paint(await post('/moves/'+encodeURIComponent(b.dataset.f)
   +'/flag?f='+b.dataset.k));
 for(const b of moves.querySelectorAll('[data-p]'))
  b.onclick=async()=>{const r=await post('/play/'+encodeURIComponent(b.dataset.p));
   say(r.error?r.error:'playing '+b.dataset.p,!!r.error);refresh()};
 // two-tap delete: a take is minutes on the bench and there is no undo, but a
 // modal on a bench tool is worse than one that asks in place.
 // IMPORTANT NOTE: the arming lives in `armed`, NOT on the button — the 1.5s
 // refresh rebuilds this list from scratch, so a class on the element was gone
 // before the second tap could land and nothing was ever deletable. The poll
 // holds off while one is armed, so the row cannot move out from under the tap.
 for(const b of moves.querySelectorAll('[data-x]')){
  const n=b.dataset.x;
  if(armed===n){b.classList.add('warn');b.textContent='sure?'}
  b.onclick=async()=>{if(armed!==n){armed=n;b.classList.add('warn');b.textContent='sure?';
    setTimeout(()=>{if(armed===n)armed=null;
     b.classList.remove('warn');b.innerHTML='&#10005;'},2500);return}
   armed=null;
   paint(await(await fetch('/moves/'+encodeURIComponent(n),
    {method:'DELETE'})).json())}}
 for(const s of moves.querySelectorAll('.nm'))s.onclick=()=>rename(s)}
// Rename in place. The name IS the filename in server/arm_moves/ and nothing
// caches it — the dashboard and Sage both re-read the folder per call — so it is
// safe to change mid-session.
function rename(span){const old=span.dataset.r,i=document.createElement('input');
 i.className='ren';i.value=old;span.replaceWith(i);i.focus();i.select();
 let done=0;
 const fin=async ok=>{if(done)return;done=1;
  const to=i.value.trim();
  if(!ok||!to||to===old)return refresh();
  const j=await post('/moves/'+encodeURIComponent(old)+'/rename?to='+encodeURIComponent(to));
  if(j.error)say(j.error,1);else say('renamed to '+to);
  paint(j)};
 i.onkeydown=e=>{e.stopPropagation();
  if(e.key==='Enter')fin(1);if(e.key==='Escape')fin(0)};
 i.onblur=()=>fin(1)}
const refresh=async()=>paint(await(await fetch('/rec')).json());
refresh();
// A poll, not a socket: the flags, the step count and the link state all change
// from elsewhere (a play finishing, the cable pulled). Skipped while a rename
// box is open, or the repaint eats what is being typed.
setInterval(()=>{if(document.activeElement.tagName!=='INPUT'&&!armed)refresh()},1500);
addEventListener('keydown',e=>{if(e.code==='Space'&&e.target.tagName!=='INPUT'){
 e.preventDefault();held=null;send('stop')}});
</script>"""

app = Flask(__name__)


def state():
    return {"rec": REC["on"], "steps": len(REC["steps"]), "link": LINK["kind"],
            "ms": dur(REC["steps"]),
            "play": PLAY["name"] if PLAY["on"] else "",
            "up": ble_up() if LINK["kind"] == "ble" else bool(find_port()),
            "moves": {k: dict(n=len(steps_of(v) or []), ms=dur(steps_of(v)),
                              **flags_of(v))
                      for k, v in sorted(load_moves().items())}}


def dur(steps):
    """How long a take runs, for the moves list. The last step's timestamp — a
    take ends on the `arm,<j>,0` that stops the joint, so there is nothing after
    it to wait for."""
    return max((st.get("ms", 0) for st in steps or []), default=0)


@app.get("/")
def index():
    return (PAGE.replace("%SPDMIN%", str(SPEED_MIN))
                .replace("%JOINTS%", json.dumps(JOINTS))
                .replace("%REP%", str(REPEAT_MS)).replace("%NUDGE%", str(NUDGE_MS)))


@app.post("/cmd")
def cmd():
    c = (request.args.get("c") or "").strip()
    if not c:
        return "empty", 400
    try:
        write(c)
    except Exception as e:
        return str(e), 503
    return "ok"


@app.get("/rec")
@app.post("/rec")
def rec():
    name = request.args.get("save")
    if name:
        if not path_of(name):
            return {"error": "a name cannot be blank, start with a dot, or hold "
                             "a slash — it is the filename", **state()}, 400
        # a re-record keeps whatever the flags were set to
        save_move(name, wrap(clean(REC["steps"]), flags_of(load_moves().get(name, {}))))
        REC["on"] = False
        REC["steps"] = []
    elif request.method == "POST":
        # Refusing rather than nesting: recording a playback captures the take
        # that is already playing and doubles it on the next replay.
        if PLAY["on"]:
            return {"error": "playing"}, 409
        REC["on"] = not REC["on"]
        if REC["on"]:
            REC["t0"], REC["steps"] = time.time(), []
    return state()


@app.post("/link")
def link():
    """Switch transport. Connecting eagerly rather than on the first jog: the
    operator needs to see "not advertising" before they are holding a button."""
    to = request.args.get("to")
    if to not in ("usb", "ble"):
        return {"error": "usb or ble"}, 400
    with LOCK:
        try:
            if to == "ble":
                ble_call(_ble_connect(), 20)
            else:
                if BLE["client"]:
                    ble_call(_ble_drop(), 10)
                port()
            LINK["kind"] = to
        except Exception as e:
            return {"error": str(e), **state()}, 503
    return state()


@app.delete("/moves/<name>")
def rm(name):
    del_move(name)                      # already gone reads the same as deleted
    return state()


@app.post("/moves/<name>/rename")
def rename(name):
    """A move's name IS its filename — there is no id underneath. Nothing caches
    it (the dashboard's /api/arm-moves and Sage's armLine() both re-read the
    folder per call), so a rename is safe mid-session; it only breaks a take Sage
    was told about in a prompt she is still answering.

    os.rename, not read-and-rewrite: the steps never pass through here, so a
    rename cannot mangle a take.
    """
    to = (request.args.get("to") or "").strip()
    src, dst = path_of(name), path_of(to)
    if not src or not os.path.exists(src):
        return {"error": "no such move", **state()}, 404
    if not dst:
        return {"error": "a name cannot be blank, start with a dot, or hold a "
                         "slash — it is the filename", **state()}, 400
    # case-only renames are a real rename on a case-insensitive volume, so
    # compare the resolved paths, not the names
    if os.path.exists(dst) and os.path.abspath(dst) != os.path.abspath(src):
        return {"error": '"%s" already exists' % to, **state()}, 409
    os.rename(src, dst)
    return state()


@app.post("/moves/<name>/flag")
def flag(name):
    """Mark a take usable by Sage / shown in the dashboard, or not. The bench
    plays anything regardless — this only gates the two places a take gets
    triggered with nobody watching the arm."""
    moves = load_moves()
    if name not in moves:
        return {"error": "no such move", **state()}, 404
    f = flags_of(moves[name])
    which = request.args.get("f")
    if which not in FLAGS:
        return {"error": "unknown flag", **state()}, 400
    f[which] = not f[which]
    save_move(name, wrap(steps_of(moves[name]) or [], f))
    return state()


@app.post("/play/<name>")
def run(name):
    steps = clean(steps_of(load_moves().get(name)))
    if not steps:
        return {"error": "no such move"}, 404
    if PLAY["on"]:
        return {"error": "already playing"}, 409   # the page shows it and greys play
    PLAY.update(on=True, name=name)
    threading.Thread(target=play, args=(steps,), daemon=True).start()
    return {"ok": True, "steps": len(steps)}


# ------------------------------------------------------------------- selftest
def selftest():
    # the one thing the two transports do differently, and it is easy to get
    # backwards: a newline riding into a BLE command string is a command the
    # board does not recognise
    assert wire("arm,0,50", "usb") == b"arm,0,50\n", "usb needs the terminator"
    assert wire("arm,0,50", "ble") == b"arm,0,50", "ble must not carry a newline"
    assert clean([{"ms": "9", "cmd": " arm,1,50 "}]) == [{"ms": 0, "cmd": "arm,1,50"}]
    # the head is dead air between RECORD and the first jog — trimmed, but every
    # gap after it survives, or the take drives further than the one recorded
    assert [s["ms"] for s in clean([{"ms": 2099, "cmd": "arm,5,100"},
                                    {"ms": 2220, "cmd": "arm,5,0"},
                                    {"ms": 2820, "cmd": "arm,5,100"}])] == [0, 121, 721], \
        "the recorder's lead-in is replayed as a dead pause"
    assert clean([{"ms": 0, "cmd": None}, {"ms": 0, "cmd": "drv,tank,100,100"}]) == [], \
        "a take must never drive the wheels"
    assert [(s["ms"], s["cmd"]) for s in clean([{"ms": 5, "cmd": "arm,0,1"},
                                                {"ms": 1, "cmd": "arm,0,2"}])] \
        == [(0, "arm,0,2"), (4, "arm,0,1")], "steps replay out of order"
    assert clean([{"ms": -3, "cmd": "stop"}])[0]["ms"] == 0
    assert clean([{"ms": 0, "cmd": "armh,1,8"}]), "a take must be able to carry its hold"
    # the speed slider is only a knob if its floor still turns the servo: below
    # roughly 100us off neutral the pulse is inside the deadband and the joint
    # buzzes. spans live in arm.h, so check against the narrowest one there.
    with io.open(os.path.join(HERE, os.pardir, "giga-r1", "main", "arm.h"),
                 encoding="utf-8") as f:
        h = f.read()
    dflt = int(re.search(r"#define ARM_SPAN_US\s+(\d+)", h).group(1))
    spans = [dflt if v.strip() == "ARM_SPAN_US" else int(v)
             for v in re.findall(r"\{\s*\d+,\s*\w+,\s*\d+,\s*([^,]+),", h)]
    assert spans and min(spans) * SPEED_MIN / 100 > 100, \
        "SPEED_MIN is inside the servo deadband — a slow jog would only buzz"
    with app.test_request_context("/"):
        page = index()
    assert "type=range" in page.split("joints.innerHTML")[1].split("`).join")[0], \
        "the speed slider has to be in the per-joint row template"
    assert "min=%d" % SPEED_MIN in page and "%SPDMIN%" not in page

    REC.update(on=True, t0=time.time(), steps=[])
    _record("arm,0,100")
    assert len(REC["steps"]) == 1 and REC["steps"][0]["cmd"] == "arm,0,100"
    REC["steps"] = [{"ms": 0, "cmd": "x"}] * REC_MAX
    _record("arm,0,0")
    assert len(REC["steps"]) == REC_MAX, "the cap is real, or a recorder eats the machine"
    REC.update(on=False, steps=[])
    global MOVES_D
    MOVES_D, old = os.path.join(HERE, "arm_moves.selftest"), MOVES_D
    try:
        save_move("a", [{"ms": 1, "cmd": "arm,0,5"}])
        assert os.path.exists(os.path.join(MOVES_D, "a.json")), "a take is its own file"
        assert steps_of(load_moves()["a"])[0]["cmd"] == "arm,0,5"
        # a take recorded before the flags existed is usable everywhere
        assert flags_of(load_moves()["a"]) == {f: True for f in FLAGS}
        save_move("a", wrap([{"ms": 1, "cmd": "arm,0,5"}], {"sage_can_use": False,
                                                            "show_in_app": True}))
        assert flags_of(load_moves()["a"]) == {"sage_can_use": False, "show_in_app": True}
        assert steps_of(load_moves()["a"])[0]["ms"] == 1, "steps lost behind the flags"
        # the filename is the name, so the two it cannot hold must be refused
        # BEFORE anything opens it — "../x" here writes outside the folder
        assert path_of("../escape") is None and path_of(" ") is None
        assert path_of(".hidden") is None, "a leading dot hides the take"
        assert path_of("Rotate Base [LEFT]"), "spaces and brackets are fine in a filename"
        # rename is a file rename — steps and flags ride along untouched
        save_move("b", [{"ms": 1, "cmd": "arm,0,1"}])
        with app.test_request_context("/?to=c"):
            rename("a")
        m = load_moves()
        assert sorted(m) == ["b", "c"] and "a" not in m
        assert flags_of(m["c"]) == {"sage_can_use": False, "show_in_app": True}
        assert dur(steps_of(m["c"])) == 1
        with app.test_request_context("/?to=b"):
            assert rename("c")[1] == 409, "renaming onto an existing move overwrites it"
        with app.test_request_context("/?to=  "):
            assert rename("c")[1] == 400, "a blank name is not a name"
        with app.test_request_context("/?to=../c"):
            assert rename("c")[1] == 400, "a rename must not write outside the folder"
        assert sorted(load_moves()) == ["b", "c"], "a refused rename must change nothing"
        with open(os.path.join(MOVES_D, "torn.json"), "w") as f:
            f.write("{ not json")
        assert sorted(load_moves()) == ["b", "c"], \
            "one unreadable take must not take the whole bench down"
        assert del_move("b") and not del_move("b")
        import shutil
        shutil.rmtree(MOVES_D)
        assert load_moves() == {}, "a missing folder reads as no moves, not a crash"
    finally:
        MOVES_D = old
    sent = []
    global write
    real, write = write, sent.append
    try:
        park()
    finally:
        write = real
    assert sent == ["arm,%d,0" % i for i in range(len(JOINTS))], \
        "a take must land parked on the hold, never on bare arm, (that is a kill)"
    assert "arm," not in sent, "bare arm, is armStopAll() and drops the hold"
    # a nudge longer than the jog repeat is not a nudge, it is a jog
    assert 0 < NUDGE_MS < REPEAT_MS, "NUDGE_MS must be a burst, not a hold"
    assert "%" not in index().split("<script>")[0].replace("100%", ""), \
        "an unsubstituted %PLACEHOLDER% renders as literal text"
    # the link matched on d.name for months and never found a board: that name is
    # "Arduino" until main.ino calls setDeviceName()
    class A:
        def __init__(self, u=(), n=None): self.service_uuids, self.local_name = list(u), n
    assert is_board(None, A([BLE_SVC.upper()])), "the service match is case-blind"
    assert is_board(None, A([], BOARD_NAME)), "the local name is the fallback"
    assert not is_board(None, A([], "Arduino")), "the GAP default is not a match"
    assert not is_board(None, A()), "an empty advertisement is not the board"
    print("armrec selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        raise SystemExit
    # Starting without the board on purpose: the page is worth having open while
    # the cable is being found, and port() reopens on the first command anyway,
    # so a mid-session unplug and a cold start are the same path. /cmd 503s until
    # it is there.
    if LINK["kind"] == "usb" and not find_port():
        print("no giga on usb yet — commands will 503 until it is plugged in "
              "(or pick BLE on the page)")
    if "--ble" in sys.argv:
        LINK["kind"] = "ble"               # the link picker on the page switches too
    # HTTP/1.1 so the socket is reused. The dev server defaults to 1.0 and closes
    # after every response; at one request per jog repeat that is a connection
    # setup each time, and the jitter reads as a joint lagging the button.
    from werkzeug.serving import WSGIRequestHandler
    WSGIRequestHandler.protocol_version = "HTTP/1.1"
    port_n = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 5006
    app.run(port=port_n, threaded=True)   # writes are serialised by LOCK instead
