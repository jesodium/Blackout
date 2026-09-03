"""Arm bench recorder. python3 server/armrec.py -> :5006

A serial pipe to the Giga, not to the Uno bench rig: main.ino reads the same
command strings off USB that it reads off BLE (`Serial.readStringUntil` in
loop()), so every line here is exactly what the dashboard would have written
over the link — `arm,<joint>,<speed>`, `armz,`, `arml,`, `stop`.

Why this exists at all: the dashboard's arrows and hold sliders are a live
control surface, and a live control surface is how a joint gets overdriven. The
point is to overdrive things HERE, once, on the bench, then save the take to
arm_moves.json — which the dashboard turns into one tap per move.

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
import asyncio, json, os, sys, threading, time
import serial, serial.tools.list_ports
from flask import Flask, request

HERE = os.path.dirname(os.path.abspath(__file__))
MOVES_F = os.path.join(HERE, "arm_moves.json")
JOINTS = ["base", "shoulder", "elbow", "wrist", "gripwrist", "gripper"]
REPEAT_MS = 300      # under the board's 800ms ARM_JOG_MS deadman
REC_MAX = 5000       # a recorder left on overnight must not eat the machine
NUDGE_MS = 120       # bench knob: a tap of the small arrows is this long at FULL
                     # power. Fine control on a loaded joint is a SHORTER burst,
                     # never a gentler one — pulse width is speed and torque at
                     # once, so a slow pulse on a 360 is a weak one.
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
body{background:#14110d;color:#ece5d6;font:13px ui-monospace,monospace;margin:0;padding:16px;max-width:640px}
h1{font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:#8a8072}
.row{display:grid;grid-template-columns:1fr auto auto;gap:6px;align-items:center;margin:6px 0}
button{background:#211d17;color:#ece5d6;border:1px solid #3a342b;border-radius:6px;
 min-height:44px;min-width:56px;font:inherit;cursor:pointer;touch-action:none}
button:active{background:#3a342b}
.wide{width:100%}.rec{border-color:#a33}.on{background:#a33}
#log{color:#8a8072;white-space:pre-wrap;margin-top:10px;min-height:2em}
.jrow{display:grid;grid-template-columns:1fr auto auto auto auto;gap:6px;
 align-items:center;margin:6px 0}
.mv{display:grid;grid-template-columns:1fr auto auto;gap:6px;margin:6px 0;align-items:center}
</style>
<h1>arm recorder</h1>
<div class=row><span id=linkst>link</span>
 <button id=usb onclick="link('usb')">usb</button>
 <button id=ble onclick="link('ble')">ble</button></div>
<div id=joints></div>
<div class=row style=grid-template-columns:1fr>
 <label><input type=checkbox id=parkchk checked> park on release (hold against gravity)</label></div>
<div class=row style=grid-template-columns:1fr><span style=color:#8a8072>
 ◀▶ jog while held &nbsp; ◂▸ tap = %NUDGE%ms at full power, then parked</span></div>
<div class=row style=grid-template-columns:1fr>
 <button class=wide onclick=send('stop')>■ PANIC STOP</button></div>
<div class=row>
 <button class=wide onclick=send('armz,')>zero travel (this is home)</button>
 <button onclick=send('arml,0')>limits off</button>
 <button onclick=send('arml,1')>limits on</button></div>
<h1>take</h1>
<div class=row><button class="wide rec" id=recbtn onclick=rec()>● record</button>
 <button onclick=save()>save as…</button></div>
<h1>moves</h1><div id=moves></div>
<div id=log></div>
<script>
const J=%JOINTS%;
let held=null;
setInterval(()=>{if(held)send('arm,'+held[0]+','+held[1],1)},%REP%);
// IMPORTANT NOTE: one request in flight, in order. Parallel fetches are why a
// release could land behind a pile of queued repeats and leave the joint
// turning. gen++ on every stop drops anything queued from before it, unsent.
let q=Promise.resolve(),gen=0;
function send(c,quiet){const g=gen,stop=(c==='stop'||c==='arm,'||/^arm,\d+,0$/.test(c));
 if(stop)gen++;
 q=q.then(async()=>{if(g<gen&&!stop)return;
  const t=await(await fetch('/cmd?c='+encodeURIComponent(c),{method:'POST'})).text();
  if(!quiet||t[0]!=='o')log.textContent=c+'  ->  '+t}).catch(e=>log.textContent='!! '+e);
 return q}
function hold(i,d){return e=>{e.preventDefault();held=[i,d];send('arm,'+i+','+d)}}
// Park, never bare `arm,` — that one is armStopAll(), a kill of all 16. Parking
// applies whatever hold bias armSv[]/armh, last set, and that pulse is the only
// thing holding a gravity-loaded 360 up: released, it free-wheels either way.
// Unchecked overrides the bias to 0 (limp) and there is no per-joint command to
// put the table's number back — reset the board for that.
function park(i){held=null;
 if(!parkchk.checked)send('armh,'+i+',0',1);
 send('arm,'+i+',0')}
function rel(i){return()=>{if(held&&held[0]===i)park(i)}}
// The small arrows are the big ones at full power for NUDGE ms and then parked,
// which is how a loaded joint gets moved a little without sagging back down —
// the two sizes differ in DURATION only. !held lets an arrow press win the
// pending auto-park; nb makes the last tap the one that parks.
const NUDGE=%NUDGE%; let nb=0;
function nudge(i,d){return e=>{e.preventDefault();const n=++nb;
 send('arm,'+i+','+d);
 setTimeout(()=>{if(n===nb&&!held)park(i)},NUDGE)}}
joints.innerHTML=J.map((n,i)=>`<div class=jrow><span>${n}</span>
 <button data-j=${i} data-d=-100>◀</button><button data-j=${i} data-d=100>▶</button>
 <button data-n=${i} data-d=-100>◂</button><button data-n=${i} data-d=100>▸</button></div>`).join('');
for(const b of joints.querySelectorAll('[data-j]')){
 const i=+b.dataset.j,d=+b.dataset.d;
 b.onpointerdown=hold(i,d);b.onpointerup=rel(i);b.onpointerleave=rel(i);b.onpointercancel=rel(i);
 b.oncontextmenu=e=>e.preventDefault()}
for(const b of joints.querySelectorAll('[data-n]'))
 b.onclick=nudge(+b.dataset.n,+b.dataset.d);
async function link(to){const r=await fetch('/link?to='+to,{method:'POST'});
 const j=await r.json();if(j.error)log.textContent=j.error;paint(j)}
async function rec(){const j=await(await fetch('/rec',{method:'POST'})).json();paint(j)}
async function save(){const n=prompt('name this move');if(!n)return;
 paint(await(await fetch('/rec?save='+encodeURIComponent(n),{method:'POST'})).json())}
async function paint(j){
 linkst.textContent='link: '+j.link+(j.up?' — up':' — DOWN');
 usb.classList.toggle('on',j.link==='usb');ble.classList.toggle('on',j.link==='ble');
 recbtn.textContent=j.rec?('● recording — '+j.steps+' steps'):'● record';
 recbtn.classList.toggle('on',j.rec);
 moves.innerHTML=Object.entries(j.moves).map(([n,c])=>
  `<div class=mv><span>${n} <small>(${c} steps)</small></span>
   <button data-p="${n}">▶ play</button><button data-x="${n}">✕</button></div>`).join('')
  ||'<small>nothing recorded yet</small>';
 for(const b of moves.querySelectorAll('[data-p]'))
  b.onclick=()=>fetch('/play/'+encodeURIComponent(b.dataset.p),{method:'POST'});
 for(const b of moves.querySelectorAll('[data-x]'))
  b.onclick=async()=>paint(await(await fetch('/moves/'+encodeURIComponent(b.dataset.x),
   {method:'DELETE'})).json())}
fetch('/rec').then(r=>r.json()).then(paint);
addEventListener('keydown',e=>{if(e.code==='Space'){e.preventDefault();held=null;send('stop')}});
</script>"""

app = Flask(__name__)


def state():
    return {"rec": REC["on"], "steps": len(REC["steps"]), "link": LINK["kind"],
            "up": ble_up() if LINK["kind"] == "ble" else bool(find_port()),
            "moves": {k: len(v) for k, v in sorted(load_moves().items())}}


@app.get("/")
def index():
    return (PAGE.replace("%JOINTS%", json.dumps(JOINTS))
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
        moves = load_moves()
        moves[name] = clean(REC["steps"])
        save_moves(moves)
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
    moves = load_moves()
    if moves.pop(name, None) is not None:
        save_moves(moves)
    return state()


@app.post("/play/<name>")
def run(name):
    steps = clean(load_moves().get(name))
    if not steps:
        return {"error": "no such move"}, 404
    if PLAY["on"]:
        return {"error": "already playing"}, 409
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
    assert clean([{"ms": "9", "cmd": " arm,1,50 "}]) == [{"ms": 9, "cmd": "arm,1,50"}]
    assert clean([{"ms": 0, "cmd": None}, {"ms": 0, "cmd": "drv,tank,100,100"}]) == [], \
        "a take must never drive the wheels"
    assert [s["ms"] for s in clean([{"ms": 5, "cmd": "arm,0,1"}, {"ms": 1, "cmd": "arm,0,2"}])] == [1, 5], \
        "steps replay out of order"
    assert clean([{"ms": -3, "cmd": "stop"}])[0]["ms"] == 0
    assert clean([{"ms": 0, "cmd": "armh,1,8"}]), "a take must be able to carry its hold"
    REC.update(on=True, t0=time.time(), steps=[])
    _record("arm,0,100")
    assert len(REC["steps"]) == 1 and REC["steps"][0]["cmd"] == "arm,0,100"
    REC["steps"] = [{"ms": 0, "cmd": "x"}] * REC_MAX
    _record("arm,0,0")
    assert len(REC["steps"]) == REC_MAX, "the cap is real, or a recorder eats the machine"
    REC.update(on=False, steps=[])
    global MOVES_F
    MOVES_F, old = MOVES_F + ".test", MOVES_F
    try:
        save_moves({"a": [{"ms": 1, "cmd": "arm,0,5"}]})
        assert load_moves()["a"][0]["cmd"] == "arm,0,5"
        os.remove(MOVES_F)
        assert load_moves() == {}, "a missing file reads as no moves, not a crash"
    finally:
        MOVES_F = old
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
