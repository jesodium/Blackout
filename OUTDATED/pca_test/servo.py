"""Manual control for the PCA9685 bench test. python3 OUTDATED/pca_test/servo.py -> :5005

Nothing but a serial pipe: every button/slider sends one line to the sketch,
same strings you'd type in the serial monitor.
"""
import time
import serial, serial.tools.list_ports
from flask import Flask, request, Response

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
</style>
<div class=row><button class=stop id=stopall>■ STOP ALL &nbsp;(space)</button>
 <button id=ver>build?</button></div>
<small>Tap to nudge, hold to keep going — it stops when you let go. Both arrows
 pull full power; the double is just a longer burst.
 STOP ALL (or space) kills every channel.</small>
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
        port().write((c + "\n").encode())
        return Response("> " + c, mimetype="text/plain")
    except (serial.SerialTimeoutException, OSError, IOError) as e:
        drop()
        return Response("!! board gone (%s) — reconnecting" % e, mimetype="text/plain")


@app.get("/dbg")
def dbg():
    app.logger.warning("DBG %s", request.args.get("e", ""))
    return Response("", mimetype="text/plain")


@app.get("/read")
def read():
    try:
        p = port()
        return Response(p.read(p.in_waiting or 0).decode(errors="replace"),
                        mimetype="text/plain")
    except (OSError, IOError) as e:
        drop()
        return Response("!! board gone (%s)" % e, mimetype="text/plain")


if __name__ == "__main__":
    print("serial:", find_port(), "-> http://127.0.0.1:5005")
    app.run(port=5005, threaded=False)   # one serial port, don't interleave writes
