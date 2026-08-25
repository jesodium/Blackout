"""Drive the bench arm with your hand. python3 OUTDATED/pca_test/hand.py

Camera in, servo commands out. Talks to servo.py over HTTP rather than the
serial port, so the two never fight over /dev/cu.* — start servo.py first.

  c   recalibrate      space  stop everything      q  quit

Runs entirely on this machine: camera, tracking and serial, no browser and no
http in the loop. Pass --http to route commands through a running servo.py
instead (needed only if that has the serial port open).

Needs mediapipe 0.10.x — 1.0.1's macOS arm64 build dies in DrishtiMetalHelper
("Check failed: service_ Service is unavailable") before the first frame, on
the CPU delegate too. pip install "mediapipe==0.10.21"

WHY IT IS NOT ABSOLUTE POSITIONING: four of the five joints are 360s with no
encoder and no end stop, so the arm cannot be told "match my elbow angle" —
nothing knows where the elbow is. Hand position is therefore a VELOCITY: push
your hand left of centre and the base turns left for as long as you hold it
there, like a joystick that happens to be your arm. Only the gripper (an sg90)
is absolute, because a positional servo does know where it is.
"""
import json, math, os, sys, time, urllib.error, urllib.parse, urllib.request

import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "hand_landmarker.task")
CAL_F = os.path.join(HERE, "hand_cal.json")
SERVER = "http://127.0.0.1:5005"

# Joints, mirroring sv[] in pca_test.ino. Continuous ones take a signed speed,
# the gripper takes an angle.
BASE, SHOULDER, ELBOW, WRIST, GRIP = 0, 4, 6, 8, 15

DEAD = 0.14          # half-width of the centre square, as a fraction of frame
REFRESH = 0.30       # resend a live jog this often — the board's deadman is 0.8s
SPEED = 100          # always full power: on a loaded 360, slower is also weaker
GRIP_STEP = 4        # degrees of pinch change worth a command
TILT_DEAD = 18       # degrees of wrist roll before the wrist joint moves


# ---------------------------------------------------------------- transport
def find_port():
    import serial.tools.list_ports
    return next((p.device for p in serial.tools.list_ports.comports()
                 if "usbmodem" in p.device or "ttyACM" in p.device), None)


class Link:
    """Commands out to the board.

    Straight down the usb cable by default. The browser page routes the same
    commands through flask, which costs an http round trip per command on top of
    a jpeg round trip per frame — fine for buttons, needless here, since this
    window is already on the machine the board is plugged into. Falls back to
    http only when the port is taken, which means servo.py has it.

    Fire-and-forget: the last value per channel is remembered so an unchanged
    joint costs nothing, and a failure is counted rather than raised — the
    camera loop must not stall on a sulking board."""

    def __init__(self, prefer_http=False):
        self.last = {}          # ch -> value last sent
        self.at = {}            # ch -> when we sent it
        self.errors = 0
        self.ok = True
        self.ser = None
        self.how = "http"
        if not prefer_http:
            try:
                import serial
                dev = find_port()
                if dev:
                    self.ser = serial.Serial(dev, 9600, timeout=0.2, write_timeout=1)
                    time.sleep(2)          # r4 bootloader
                    self.how = dev
            except Exception:
                self.ser = None            # busy: servo.py is probably running

    def send(self, ch, val, force=False):
        now = time.time()
        if not force and self.last.get(ch) == val and now - self.at.get(ch, 0) < REFRESH:
            return
        self.last[ch], self.at[ch] = val, now
        self._write("%d:%d" % (ch, val))

    def stop(self):
        self.last.clear()
        self._write("s")

    def close(self):
        if self.ser:
            try:
                self.ser.close()
            except Exception:
                pass

    def _write(self, cmd):
        if self.ser is not None:
            try:
                self.ser.write((cmd + "\n").encode())
                self.ok = True
            except Exception:
                self.errors += 1
                self.ok = False
            return
        try:
            urllib.request.urlopen(SERVER + "/cmd?c=" + urllib.parse.quote(cmd),
                                   timeout=0.4).read()
            self.ok = True
        except (urllib.error.URLError, OSError):
            self.errors += 1
            self.ok = False


# ---------------------------------------------------------------- geometry
def hand_metrics(lm):
    """Everything the controller needs, from one set of 21 landmarks.

    Sizes are normalised by the hand's own span (wrist to middle-finger MCP) so
    they mean the same thing whether you are near the camera or far from it —
    otherwise leaning in reads as a pinch."""
    wrist = np.array([lm[0].x, lm[0].y])
    mid_mcp = np.array([lm[9].x, lm[9].y])
    span = float(np.linalg.norm(mid_mcp - wrist)) or 1e-6

    thumb, index = np.array([lm[4].x, lm[4].y]), np.array([lm[8].x, lm[8].y])
    pinch = float(np.linalg.norm(thumb - index)) / span

    # Palm roll: the angle of the knuckle line. atan2 keeps it continuous
    # through vertical, where a slope would blow up.
    idx_mcp, pky_mcp = np.array([lm[5].x, lm[5].y]), np.array([lm[17].x, lm[17].y])
    d = idx_mcp - pky_mcp
    roll = math.degrees(math.atan2(d[1], d[0]))

    palm = (wrist + mid_mcp) / 2
    # The pointer is the index fingertip, not the palm: you aim with a finger,
    # and the pinch closes around the very point you were aiming with.
    return {"x": float(palm[0]), "y": float(palm[1]), "span": span,
            "pinch": pinch, "roll": roll, "fingers": fingers_up(lm),
            "point": (float(index[0]), float(index[1]))}


# On-screen buttons, in normalised frame coordinates (x, y, w, h). Hover with
# your index fingertip, pinch to press — hovering alone never moves anything, so
# you can line up without committing. One table drives the hit test, the drawing
# and the page's tutorial, so they cannot drift apart.
#   kind "jog"  : runs while pinched, stops when you let go
#   kind "grip" : sets the claw angle (the one joint that knows where it is)
#   kind "stop" : everything off
ZONES = [
    (0.02, 0.04, 0.20, 0.26, "CLAW +",     "grip", GRIP, +1),
    (0.02, 0.37, 0.20, 0.26, "STOP",       "stop", None, 0),
    (0.02, 0.70, 0.20, 0.26, "CLAW -",     "grip", GRIP, -1),

    (0.26, 0.04, 0.22, 0.26, "SHOULDER +", "jog", SHOULDER, +SPEED),
    (0.26, 0.70, 0.22, 0.26, "SHOULDER -", "jog", SHOULDER, -SPEED),
    (0.52, 0.04, 0.22, 0.26, "ELBOW +",    "jog", ELBOW, +SPEED),
    (0.52, 0.70, 0.22, 0.26, "ELBOW -",    "jog", ELBOW, -SPEED),
    (0.78, 0.04, 0.20, 0.26, "WRIST +",    "jog", WRIST, +SPEED),
    (0.78, 0.70, 0.20, 0.26, "WRIST -",    "jog", WRIST, -SPEED),

    (0.26, 0.37, 0.22, 0.26, "BASE <",     "jog", BASE, +SPEED),
    (0.52, 0.37, 0.22, 0.26, "BASE >",     "jog", BASE, -SPEED),
]

# One pinch, one nudge — the same step the on-screen arrow buttons give, so the
# two ways of driving the arm agree. A held pinch does NOT repeat: holding a
# gesture steady is exactly what a hand does while you think, and a joint with
# no end stop must not read that as "keep going".
# Bench knobs. PULSE_MS is the coarse arrow's length, not the fine one: a
# pinch is a deliberate act and wants a step you can see, and 140ms did not
# shift a loaded shoulder at all — the arm's weight eats a burst that short
# before it builds any speed.
PULSE_MS = 420       # 360s: burst length per pinch
GRIP_STEP = 12       # sg90: degrees per press

# The kill gesture: pinky alone, held. Long on purpose — it has to be
# impossible to hit by accident, and a hand passing through odd shapes on its
# way somewhere else must never switch the controls off mid-move.
KILL_FINGERS = [False, False, False, True]      # index, middle, ring, pinky
KILL_HOLD = 3.0

PINCH_ON = 0.35      # fraction of your calibrated pinch range that counts as shut
PINCH_OFF = 0.50     # and where it lets go again — hysteresis, so a held pinch
                     # sitting near the threshold cannot chatter on and off


def zone_at(x, y):
    """Which button that point is over, or None. First match wins; the table
    does not overlap."""
    for z in ZONES:
        if z[0] <= x <= z[0] + z[2] and z[1] <= y <= z[1] + z[3]:
            return z
    return None


def fingers_up(lm):
    """Extended digits, index through pinky.

    Compares each fingertip's distance from the wrist against its own middle
    knuckle's — a curled finger pulls its tip back inside that. Distances, not
    "tip is above pip", so it still reads correctly with the hand rotated."""
    wrist = np.array([lm[0].x, lm[0].y])
    out = []
    for tip, pip in ((8, 6), (12, 10), (16, 14), (20, 18)):
        t = np.linalg.norm(np.array([lm[tip].x, lm[tip].y]) - wrist)
        p = np.linalg.norm(np.array([lm[pip].x, lm[pip].y]) - wrist)
        out.append(bool(t > p * 1.15))
    return out


def axis(value, centre, dead):
    """-1, 0 or +1: which way this axis is pushed, if it is pushed at all."""
    d = value - centre
    return 0 if abs(d) < dead else (1 if d > 0 else -1)


def pinching(m, cal, was):
    """Is the pinch shut? Hysteresis: it takes a firmer pinch to press than to
    keep holding, so a hand resting near the threshold does not chatter."""
    lo, hi = cal["pinch_closed"], cal["pinch_open"]
    span = max(hi - lo, 1e-6)
    t = (m["pinch"] - lo) / span
    return t < (PINCH_OFF if was else PINCH_ON)


class Controller:
    """Turns a stream of hand observations into servo commands.

    Stateful on purpose: holding a pinch has to keep a joint fed, and letting go
    has to stop it, neither of which a pure function of one frame can express.
    Both drivers (this file's window and servo.py's thread) share it so the two
    behave identically."""

    def __init__(self):
        self.grip = 90
        self.down = False           # pinch state, for edge detection
        self.held = None            # (ch, val) currently being driven
        self.next = 0.0             # when that needs feeding again
        self.kill_since = None      # when the pinky-only gesture started

    def _release(self, sends):
        if self.held:
            sends.append((self.held[0], 0))
            self.held = None

    def feed(self, m, cal, now=None):
        """One frame. m is None when no hand is visible. Returns the commands to
        send right now plus what to draw."""
        now = time.time() if now is None else now
        sends = []

        if m is None:
            self.down = False
            self.kill_since = None
            self._release(sends)
            return {"sends": sends, "hover": None, "pressed": False,
                    "stop": True, "grip": self.grip, "mode": "no hand - stopped"}

        # Pinky alone, held: switch the whole thing off. Checked before anything
        # else so it works even mid-hold — that is the point of a kill gesture.
        if m["fingers"] == KILL_FINGERS:
            if self.kill_since is None:
                self.kill_since = now
            waited = now - self.kill_since
            if waited >= KILL_HOLD:
                self.kill_since = None
                self.down = False
                self._release(sends)
                return {"sends": sends, "hover": None, "pressed": False,
                        "stop": True, "kill": True, "grip": self.grip,
                        "kill_progress": 1.0, "mode": "HAND CONTROL OFF"}
            self._release(sends)
            return {"sends": sends, "hover": None, "pressed": False,
                    "stop": False, "grip": self.grip,
                    "kill_progress": waited / KILL_HOLD,
                    "mode": "pinky held - off in %.1fs" % (KILL_HOLD - waited)}
        self.kill_since = None

        was, self.down = self.down, pinching(m, cal, self.down)
        edge = self.down and not was          # the moment of the pinch
        z = zone_at(m["point"][0], m["point"][1])
        label = z[4] if z else None

        # Letting go stops the joint. So does sliding off the button you were
        # holding — the alternative is a joint that keeps running because your
        # hand drifted, which is the failure that matters here.
        if self.held and (not self.down or z is None or z[6] != self.held[0]
                          or z[7] != self.held[1]):
            self._release(sends)

        out = {"sends": sends, "hover": label, "pressed": bool(self.held),
               "stop": False, "grip": self.grip}

        if z is None:
            out["mode"] = "pinch a button to move"
            return out
        kind, ch, val = z[5], z[6], z[7]

        if kind == "jog":
            if self.down:
                # Feeding the board's deadman: it stops any 360 that has not
                # heard from us in JOG_MS, so a crash here cannot leave one on.
                if self.held is None or now >= self.next:
                    sends.append((ch, val))
                    self.held, self.next = (ch, val), now + REFRESH
                out.update(pressed=True, mode="%s - holding" % label)
            else:
                out["mode"] = "over %s - pinch and hold" % label
            return out

        # The claw is positional, so it steps once per pinch rather than
        # running: holding a position command just re-sends the same angle.
        if not edge:
            out["mode"] = ("holding - release to press again" if self.down
                           else "over %s - pinch to step" % label)
            return out
        out["pressed"] = True
        if kind == "stop":
            self._release(sends)
            out.update(stop=True, mode="STOP")
            return out
        self.grip = max(0, min(180, self.grip + val * GRIP_STEP))
        sends.append((GRIP, self.grip))
        out.update(grip=self.grip, mode="%s -> %d deg" % (label, self.grip))
        return out


# ---------------------------------------------------------------- ui bits
# cv2's Hershey fonts are ASCII only — anything else draws as "???", which is
# how "no hand — stopped" reached the screen as "NO HAND ??? stopped". Only the
# drawn copy is folded; the same strings go to the browser with their real
# punctuation intact.
ASCII = {"\u2014": "-", "\u2013": "-", "\u00b7": "|", "\u2192": "->",
         "\u00b0": "deg", "\u2018": "'", "\u2019": "'"}


def ascii_only(t):
    for k, v in ASCII.items():
        t = t.replace(k, v)
    return t.encode("ascii", "replace").decode()


def banner(img, lines, y=30):
    for i, (text, col) in enumerate(lines):
        text = ascii_only(text)
        cv2.putText(img, text, (14, y + i * 26), cv2.FONT_HERSHEY_SIMPLEX,
                    0.62, (0, 0, 0), 4, cv2.LINE_AA)
        cv2.putText(img, text, (14, y + i * 26), cv2.FONT_HERSHEY_SIMPLEX,
                    0.62, col, 1, cv2.LINE_AA)


def draw_kill(img, progress):
    """A bar for the pinky hold. Five seconds with no feedback feels broken —
    you need to see that it is counting."""
    if not progress:
        return
    h, w = img.shape[:2]
    bw = int((w - 28) * min(1.0, progress))
    cv2.rectangle(img, (14, h - 30), (14 + bw, h - 14), (80, 80, 255), -1)
    cv2.rectangle(img, (14, h - 30), (w - 14, h - 14), (140, 140, 140), 1)


def draw_zones(img, hover=None, pressed=False, point=None):
    """The buttons, drawn from the same table the hit test reads."""
    h, w = img.shape[:2]
    overlay = img.copy()
    for x, y, bw, bh, label, kind, _ch, _v in ZONES:
        p1 = (int(x * w), int(y * h))
        p2 = (int((x + bw) * w), int((y + bh) * h))
        is_hover = (label == hover)
        if kind == "stop":
            edge = (80, 80, 255)
        elif kind == "grip":
            edge = (250, 200, 90)
        else:
            edge = (150, 220, 150)
        if is_hover:
            cv2.rectangle(overlay, p1, p2,
                          (60, 60, 200) if (pressed and kind == "stop")
                          else ((90, 200, 90) if pressed else (70, 70, 70)), -1)
        cv2.rectangle(overlay, p1, p2, edge, 3 if is_hover else 1, cv2.LINE_AA)
        tx, ty = p1[0] + 10, p1[1] + int((bh * h) / 2) + 6
        label = ascii_only(label)
        cv2.putText(overlay, label, (tx, ty), cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                    (0, 0, 0), 4, cv2.LINE_AA)
        cv2.putText(overlay, label, (tx, ty), cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                    (255, 255, 255) if is_hover else edge, 1, cv2.LINE_AA)
    # Light touch: the buttons are a heads-up display over the room, and you
    # need to see your own hand through them.
    cv2.addWeighted(overlay, 0.35, img, 0.65, 0, img)
    if point:
        c = (int(point[0] * w), int(point[1] * h))
        cv2.circle(img, c, 16 if pressed else 10,
                   (90, 220, 90) if pressed else (240, 240, 240), 2, cv2.LINE_AA)
        cv2.circle(img, c, 3, (240, 240, 240), -1, cv2.LINE_AA)


CONNS = vision.HandLandmarksConnections.HAND_CONNECTIONS


def draw_hand(img, lm, w, h):
    pts = [(int(p.x * w), int(p.y * h)) for p in lm]
    for c in CONNS:                         # Connection carries .start/.end
        cv2.line(img, pts[c.start], pts[c.end], (90, 200, 90), 2, cv2.LINE_AA)
    for p in pts:
        cv2.circle(img, p, 3, (240, 240, 240), -1, cv2.LINE_AA)


# ---------------------------------------------------------------- calibrate
STEPS = [("hold your hand still, palm to the camera", "rest"),
         ("open your hand wide", "open"),
         ("pinch thumb and index together", "closed")]
HOLD = 1.6      # seconds a pose must be held before it counts


class Calibration:
    """The three-pose sequence as a state machine, fed one frame at a time.

    hand.py drives it from its own cv2 window and servo.py drives it from the
    flask camera thread — same maths, same prompts, neither owning a loop."""

    def __init__(self):
        self.step, self.samples, self.since, self.out = 0, [], None, {}
        self.done = None

    def feed(self, m):
        """One frame's metrics (or None for no hand). Returns 0..1 hold progress."""
        if m is None:
            self.since = None
            return 0.0
        if self.since is None:
            self.since, self.samples = time.time(), []
        self.samples.append(m)
        held = (time.time() - self.since) / HOLD
        if held >= 1.0:
            self.out[STEPS[self.step][1]] = {
                k: float(np.mean([s[k] for s in self.samples]))
                for k in ("x", "y", "span", "pinch", "roll")}
            self.step, self.since = self.step + 1, None
            if self.step >= len(STEPS):
                self.done = finish(self.out)
            return 0.0
        return held

    def prompt(self):
        return STEPS[min(self.step, len(STEPS) - 1)][0]


def finish(out):
    """Averaged poses -> the calibration the mapping actually reads."""
    rest = out["rest"]
    cal = {"x": rest["x"], "y": rest["y"], "span": rest["span"], "roll": rest["roll"],
           "pinch_open": out["open"]["pinch"], "pinch_closed": out["closed"]["pinch"]}
    # A pinch range that never opened would make the gripper twitch on noise.
    if cal["pinch_open"] - cal["pinch_closed"] < 0.15:
        cal["pinch_open"] = cal["pinch_closed"] + 0.15
    json.dump(cal, open(CAL_F, "w"), indent=1)
    return cal


def load_cal():
    try:
        return json.load(open(CAL_F))
    except Exception:
        return None


def calibrate(cap, detect, win):
    """The same sequence, blocking, for hand.py's own window."""
    c = Calibration()
    while c.done is None:
        ok, frame = cap.read()
        if not ok:
            return None
        frame = cv2.flip(frame, 1)
        h, w = frame.shape[:2]
        res = detect(frame)
        if res:
            draw_hand(frame, res, w, h)
        held = c.feed(hand_metrics(res) if res else None)
        cv2.rectangle(frame, (14, h - 34), (14 + int((w - 28) * held), h - 14),
                      (90, 220, 90), -1)
        banner(frame, [("CALIBRATE %d/%d" % (min(c.step + 1, len(STEPS)), len(STEPS)),
                        (90, 220, 255)),
                       (c.prompt(), (255, 255, 255)),
                       ("hold it steady — q aborts", (170, 170, 170))])
        cv2.imshow(win, frame)
        if cv2.waitKey(1) & 0xFF in (ord('q'), 27):
            return None
    return c.done


# ---------------------------------------------------------------- main
def make_detector(model=None):
    model = model or MODEL
    if not os.path.exists(model):
        sys.exit("missing %s — curl -O https://storage.googleapis.com/"
                 "mediapipe-models/hand_landmarker/hand_landmarker/float16/1/"
                 "hand_landmarker.task" % model)
    opts = vision.HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model),
        num_hands=1, min_hand_detection_confidence=0.6,
        min_tracking_confidence=0.5,
        running_mode=vision.RunningMode.VIDEO)
    lmk = vision.HandLandmarker.create_from_options(opts)
    t0 = time.time()

    def detect(bgr):
        img = mp.Image(image_format=mp.ImageFormat.SRGB,
                       data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
        r = lmk.detect_for_video(img, int((time.time() - t0) * 1000))
        return r.hand_landmarks[0] if r.hand_landmarks else None

    return detect


def main():
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        sys.exit("no camera. on macos, grant Terminal camera access in "
                 "System Settings > Privacy & Security > Camera")
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 960)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 540)

    win, detect = "arm - hand control", make_detector()
    link = Link(prefer_http="--http" in sys.argv)
    print("commands ->", link.how)
    cv2.namedWindow(win)

    cal = load_cal()
    if cal is None:
        cal = calibrate(cap, detect, win)
        if cal is None:
            return

    # IMPORTANT NOTE: no hand means STOP, not "carry on". A joint with no end
    # stop must never outlive the hand that was driving it — same rule as the
    # firmware's deadman, enforced up here too because a frozen camera looks
    # exactly like a hand held perfectly still.
    missing_since, ctl = None, Controller()
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frame = cv2.flip(frame, 1)
        h, w = frame.shape[:2]
        lm = detect(frame)

        if lm:
            missing_since = None
            m = hand_metrics(lm)
            r = ctl.feed(m, cal)
            draw_hand(frame, lm, w, h)
            draw_zones(frame, r["hover"], r["pressed"], m["point"])
            if r.get("kill"):
                link.stop()
                break
            if r["stop"]:
                link.stop()
            for ch, v in r["sends"]:
                link.send(ch, v, force=True)
            draw_kill(frame, r.get("kill_progress"))
            banner(frame, [(r["mode"], (90, 220, 255)),
                           ("claw %d deg" % r["grip"], (255, 255, 255)),
                           ("c recalibrate · space stop · q quit", (170, 170, 170))])
        else:
            r = ctl.feed(None, cal)
            for ch, v in r["sends"]:
                link.send(ch, v, force=True)
            if missing_since is None:
                missing_since = time.time()
                link.stop()
            draw_zones(frame)
            banner(frame, [("NO HAND — stopped", (80, 80, 255)),
                           ("c recalibrate · space stop · q quit", (170, 170, 170))])

        if not link.ok:
            banner(frame, [("board not answering (%s)" % link.how, (80, 80, 255))],
                   y=h - 20)

        cv2.imshow(win, frame)
        k = cv2.waitKey(1) & 0xFF
        if k in (ord('q'), 27):
            break
        if k == ord(' '):
            link.stop()
        if k == ord('c'):
            link.stop()
            ctl = Controller()
            new = calibrate(cap, detect, win)
            if new:
                cal = new

    link.stop()
    link.close()
    cap.release()
    cv2.destroyAllWindows()


def selftest():
    """The hit test, the edge trigger and the burst timing are the whole
    feature — a hover that moves a joint, or a held pinch that repeats, is the
    kind of bug that only shows up with an arm swinging."""
    import types
    cal = {"x": .5, "y": .5, "span": .2, "roll": 0.,
           "pinch_open": 1.0, "pinch_closed": 0.2}
    OPEN, SHUT = 0.9, 0.25            # well outside either threshold

    def hand(x, y, pinch=OPEN):
        return {"x": .5, "y": .5, "span": .2, "pinch": pinch, "roll": 0.,
                "fingers": [True, False, False, False], "point": (x, y)}

    def centre(z):
        return z[0] + z[2] / 2, z[1] + z[3] / 2

    joints = (BASE, SHOULDER, ELBOW, WRIST)
    jogs = [z for z in ZONES if z[5] == "jog"]

    # every button is reachable at its own centre and reports itself
    for z in ZONES:
        x, y = centre(z)
        assert zone_at(x, y) is z, z[4]
        assert Controller().feed(hand(x, y), cal, now=0)["hover"] == z[4]

    # hovering never sends anything, however long you hover
    for z in ZONES:
        c = Controller()
        for t in range(5):
            r = c.feed(hand(*centre(z)), cal, now=t)
            assert not r["pressed"] and not r["sends"], z[4]

    # the kill gesture: pinky alone, held for KILL_HOLD
    def pinky(**kw):
        return dict(hand(0.5, 0.5, **kw), fingers=[False, False, False, True])
    c = Controller()
    assert not c.feed(pinky(), cal, now=0).get("kill")
    assert not c.feed(pinky(), cal, now=KILL_HOLD - 0.1).get("kill"), "too early"
    assert c.feed(pinky(), cal, now=KILL_HOLD + 0.01)["kill"], "should have fired"

    # letting the gesture lapse restarts the clock — no accumulating credit
    c = Controller()
    c.feed(pinky(), cal, now=0)
    c.feed(hand(0.5, 0.5), cal, now=1)                  # any other hand shape
    assert not c.feed(pinky(), cal, now=KILL_HOLD - 0.5).get("kill")

    # and it drops whatever was being held, rather than leaving it running
    z = [z for z in ZONES if z[5] == "jog"][0]
    c = Controller()
    c.feed(hand(*centre(z), pinch=SHUT), cal, now=0)
    k = c.feed(pinky(pinch=SHUT), cal, now=0.1)
    assert (z[6], 0) in k["sends"], "kill gesture must release a held joint"

    # a hand that is merely out of frame must not bank progress toward the kill
    c = Controller()
    c.feed(pinky(), cal, now=0)
    c.feed(None, cal, now=1)
    assert not c.feed(pinky(), cal, now=KILL_HOLD - 0.5).get("kill")

    # a pinch starts the joint and HOLDING keeps it fed, at the refresh rate
    for z in jogs:
        c = Controller()
        c.feed(hand(*centre(z)), cal, now=0)                    # hovering, open
        r = c.feed(hand(*centre(z), pinch=SHUT), cal, now=0.01)
        assert r["sends"] == [(z[6], z[7])], (z[4], r["sends"])
        # too soon to repeat: the board is already holding this value
        assert c.feed(hand(*centre(z), pinch=SHUT), cal, now=0.02)["sends"] == []
        # but the deadman must be fed before it expires
        assert c.feed(hand(*centre(z), pinch=SHUT), cal,
                      now=0.01 + REFRESH)["sends"] == [(z[6], z[7])]
        assert REFRESH < 0.8, "the board stops a 360 after JOG_MS (0.8s)"
        # letting go stops it, once
        rel = c.feed(hand(*centre(z), pinch=OPEN), cal, now=1.0)
        assert rel["sends"] == [(z[6], 0)], rel["sends"]
        assert c.feed(hand(*centre(z), pinch=OPEN), cal, now=1.1)["sends"] == []

    # sliding off the button while still pinching stops it too
    z = jogs[0]
    c = Controller()
    c.feed(hand(*centre(z), pinch=SHUT), cal, now=0)
    off = c.feed(hand(0.5, 0.5, pinch=SHUT), cal, now=0.1)
    assert off["sends"] == [(z[6], 0)], "drifting off a held button must stop it"

    # moving from one button to another swaps cleanly: stop the old, start new
    a, b = jogs[0], jogs[1]
    c = Controller()
    c.feed(hand(*centre(a), pinch=SHUT), cal, now=0)
    sw = c.feed(hand(*centre(b), pinch=SHUT), cal, now=0.1)
    assert (a[6], 0) in sw["sends"] and (b[6], b[7]) in sw["sends"], sw["sends"]

    # claw steps by one notch per pinch, and clamps
    c = Controller()
    plus = [z for z in ZONES if z[4] == "CLAW +"][0]
    for i in range(1, 4):
        c.feed(hand(*centre(plus), pinch=OPEN), cal, now=i * 10)
        r = c.feed(hand(*centre(plus), pinch=SHUT), cal, now=i * 10 + 1)
        assert r["sends"] == [(GRIP, 90 + i * GRIP_STEP)], r["sends"]
    for i in range(40):
        c.feed(hand(*centre(plus), pinch=OPEN), cal, now=100 + i * 2)
        c.feed(hand(*centre(plus), pinch=SHUT), cal, now=101 + i * 2)
    assert c.grip == 180, "claw must clamp, not run past its travel"

    # a pinch off the buttons does nothing at all
    c = Controller()
    assert c.feed(hand(0.5, 0.5, pinch=SHUT), cal, now=0)["sends"] == []

    # losing the hand stops, and releases whatever was being held
    c = Controller()
    z = jogs[0]
    c.feed(hand(*centre(z), pinch=SHUT), cal, now=0)
    gone = c.feed(None, cal, now=0.2)
    assert gone["stop"] and gone["sends"] == [(z[6], 0)]

    # hysteresis: mid-range holds if already down, does not start if not
    mid = 0.2 + (PINCH_ON + PINCH_OFF) / 2 * 0.8
    c = Controller(); c.down = True
    assert pinching(hand(0, 0, mid), cal, True)
    assert not pinching(hand(0, 0, mid), cal, False)

    # buttons must not overlap, or the first in the table silently wins
    for i, a in enumerate(ZONES):
        for b in ZONES[i + 1:]:
            apart = (a[0] + a[2] <= b[0] or b[0] + b[2] <= a[0] or
                     a[1] + a[3] <= b[1] or b[1] + b[3] <= a[1])
            assert apart, "%s overlaps %s" % (a[4], b[4])
        assert 0 <= a[0] and a[0] + a[2] <= 1 and 0 <= a[1] and a[1] + a[3] <= 1, a[4]

    # overlay text must survive cv2's ascii-only fonts
    assert "?" not in ascii_only("no hand \u2014 stopped")
    print("selftest ok")


if __name__ == "__main__":
    (selftest if "--selftest" in sys.argv else main)()
