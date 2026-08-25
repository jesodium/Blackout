"""Manual control for the PCA9685 bench test. python3 OUTDATED/pca_test/servo.py -> :5005

Mostly a serial pipe: every button sends one line to the sketch, the same
string you would type into the serial monitor. The exception is HAND CONTROL,
which runs the webcam and mediapipe in a background thread here and drives the
joints from what it sees (the maths lives in hand.py, which is also runnable on
its own).
"""
import os, sys, threading, time
import serial, serial.tools.list_ports
from flask import Flask, request, Response

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def find_port():
    return next((p.device for p in serial.tools.list_ports.comports()
                 if "usbmodem" in p.device or "ttyACM" in p.device), None)


if not find_port():
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
        port().write((cmd + "\n").encode())


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
</style>
<div class=row><button class=stop id=stopall>■ STOP ALL &nbsp;(space)</button>
 <button id=ver>build?</button></div>
<small>Tap to nudge, hold to keep going — it stops when you let go. Both arrows
 pull full power; the double is just a longer burst.
 STOP ALL (or space) kills every channel.</small>
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
 finger</b> — it lights up when you are over it — then <b>pinch your thumb and
 index together</b> and hold. Hovering never moves anything, so you can line up
 first.</p>
 <table>
  <tr><td>point</td><td>your index fingertip is the cursor; the ring around it shows where the camera thinks it is</td></tr>
  <tr><td>pinch and hold</td><td>the joint <b>runs while you hold the pinch</b> and stops the moment you let go — or the moment your finger drifts off the button</td></tr>
  <tr><td>SHOULDER / ELBOW / WRIST</td><td>+ and − along the top and bottom edges</td></tr>
  <tr><td>BASE &lt; &gt;</td><td>the two middle buttons turn the base</td></tr>
  <tr><td>CLAW + / −</td><td>one step per pinch (it is positional, so holding would just re-send the same angle)</td></tr>
  <tr><td>STOP</td><td>everything off, same as the red button below</td></tr>
  <tr><td>hand out of frame</td><td>everything <b>stops</b></td></tr>
  <tr><td>pinky only, 3 seconds</td><td><b>switches hand control off</b> — camera and all. A bar along the bottom counts it down</td></tr>
 </table>
 <p>Calibration teaches it your own pinch: an open hand, then thumb and index
 touching. Redo it if pressing feels too eager or too stubborn.</p>
</div>
<img id=cam alt="">
<div id=joints></div>
<div id=log></div>
<script>
// ch, name, is360, neutral-us — mirror of sv[] in pca_test.ino.
const J=[[0,'base',1,1490],[4,'shoulder',1,1500],[6,'elbow',1,1500],[8,'wrist',1,1500],
         [15,'gripper',0,0]];
const NEU={}; J.forEach(([c,n,k,u])=>NEU[c]=u);
// Where each sg90 was last told to sit. No readback on a servo, so this is the
// only thing that knows; a reload assumes centre until you nudge it.
const ANG={}; J.forEach(([c,n,k])=>{if(!k)ANG[c]=90;});

// On a loaded 360 the pulse width sets speed AND torque together, so a "slow"
// command is also a weak one — at 35% the shoulder could not lift its own arm
// while gravity took it down fine. Every nudge therefore runs at full power and
// the arrows differ in DURATION only: fine control is a shorter burst, never a
// gentler one.
const PULSE_MS=140;   // 360s — the fine arrows; the coarse pair run 3x this
const STEP=8;         // sg90s — degrees per step
const HOLD_MS=250;    // press longer than this and an sg90 starts repeating
const REP_MS=200;     // how fast it repeats while held

joints.innerHTML=J.map(([c,name,cont])=>`
 <h2>ch${c} ${name} ${cont?'· 360':'· sg90'}</h2>
 <div class=row>
  <button class=nudge data-ch=${c} data-c=${cont?1:0} data-d=-1>◀◀</button>
  <button class=nudge data-ch=${c} data-c=${cont?1:0} data-d=-.35>◀</button>
  <button class=nudge data-ch=${c} data-c=${cont?1:0} data-d=.35>▶</button>
  <button class=nudge data-ch=${c} data-c=${cont?1:0} data-d=1>▶▶</button>
  ${cont
    ? `<button class=trim data-ch=${c} data-d=-10>trim−</button>
       <button class=trim data-ch=${c} data-d=10>trim+</button>
       <span class=neu id=neu${c}>${NEU[c]}us</span>`
    : ``}
  <button class=tap data-cmd="t${c}">which?</button>
 </div>`).join('');

// Tap = one nudge, hold = keeps going, release = stops. Same button either way,
// so there is nothing to choose. Bound on pointerdown/up with the pointer
// captured: without the capture, sliding a finger off the button fires
// pointerleave and the joint stops mid-move, which reads as a dropped press.
// Every timer lands in held[] so panic() can kill the lot.
const held={};
function release(c){
  if(!held[c]) return;
  clearInterval(held[c].iv); clearTimeout(held[c].to);
  const cont=held[c].cont, since=Date.now()-held[c].t0, min=held[c].min;
  held[c]=null;
  // A 360 needs an explicit stop, and a tap shorter than the arrow's own burst
  // length gets stretched to it — that burst is the whole step size.
  if(cont) setTimeout(()=>send(c+':0'), Math.max(0,min-since));
}
for(const b of document.querySelectorAll('button.nudge')){
  const c=b.dataset.ch, cont=b.dataset.c==='1', d=+b.dataset.d;
  const big=Math.abs(d)>.5;
  const step=()=>{
    ANG[c]=Math.max(0,Math.min(180,ANG[c]+Math.round(d*STEP*(big?2:1))));
    send(c+':'+ANG[c],1);
  };
  b.addEventListener('pointerdown',e=>{
    e.preventDefault(); b.setPointerCapture(e.pointerId); b.classList.add('on');
    release(c);
    held[c]={cont, t0:Date.now(), iv:null, to:null, min:PULSE_MS*(big?3:1)};
    if(cont){
      const spd=(d<0?-100:100);                            // full power, always
      send(c+':'+spd);
      held[c].iv=setInterval(()=>send(c+':'+spd,1),300);    // feed the deadman
    }else{
      step();                                              // one step on the tap
      held[c].to=setTimeout(()=>{ held[c].iv=setInterval(step,REP_MS); },HOLD_MS);
    }
  });
  const up=()=>{ b.classList.remove('on'); release(c); };
  for(const ev of ['pointerup','pointercancel','lostpointercapture'])
    b.addEventListener(ev, up);
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
  for(const c in held) if(held[c]){clearInterval(held[c].iv); clearTimeout(held[c].to); held[c]=null;}
  for(const b of document.querySelectorAll('button.nudge')) b.classList.remove('on');
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
setInterval(async()=>put(await (await fetch('/read')).text()),700);
</script>"""


@app.get("/")
def index():
    return PAGE


@app.get("/cmd")
def cmd():
    c = request.args.get("c", "")
    try:
        write(c)
        return Response("> " + c, mimetype="text/plain")
    except (serial.SerialTimeoutException, OSError, IOError) as e:
        drop()
        return Response("!! board gone (%s) — reconnecting" % e, mimetype="text/plain")


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
        self.missing, self.ctl = False, H.Controller()
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
            self.err = "camera stopped delivering frames"
            return False
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
    return {"on": HAND.on, "status": HAND.status, "err": str(HAND.err or ""),
            "cam": HAND.cam, "paused": HAND.paused, "mode": HAND.mode,
            "frames": HAND.frames, "hasframe": HAND.frame is not None,
            "errors": HAND.errors}


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


if __name__ == "__main__":
    # HTTP/1.1 so connections are reused. The dev server defaults to 1.0, which
    # closes the socket after every response — at one http request per camera
    # frame that is ~30 connection setups a second, and the resulting jitter is
    # what the preview showed as flicker and lag. (It also burns through
    # ephemeral ports fast enough to start failing outright.)
    from werkzeug.serving import WSGIRequestHandler
    WSGIRequestHandler.protocol_version = "HTTP/1.1"
    print("serial:", find_port(), "-> http://127.0.0.1:5005")
    app.run(port=5005, threaded=True)    # writes are serialised by LOCK instead
