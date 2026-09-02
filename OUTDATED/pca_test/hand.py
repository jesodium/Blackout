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
BASE, SHOULDER, ELBOW, WRIST, GRIP = 6, 5, 4, 3, 1   # rewired 2026-08-31; ch2 unused
# GRIP's servo is dead — the zones send, the claw does not move. Keep
# ch1 clear of anything else while it is typed positional: an angle into a 360 runs away.

DEAD = 0.14          # half-width of the centre square, as a fraction of frame
REFRESH = 0.30       # resend a live jog this often — the board's deadman is 0.8s
SPEED = 100          # always full power: on a loaded 360, slower is also weaker

# Speed is DUTY, never a gentler pulse. Pulse width is speed and torque at once
# on these 360s, so a slow command is a weak one — 35% could not lift the
# shoulder against gravity. Slow here means full power switched on and off:
# short bursts, the same trick the bench page's small arrows use. Starts slow,
# because an accidental run at full speed is what puts a joint into the frame.
SPEEDS = (("slow", 0.25), ("half", 0.50), ("full", 1.00))
DUTY_MS = 0.50       # one on/off cycle, seconds — below full the joint crawls
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
# your index fingertip, press E to run it — hovering alone never moves anything,
# so you can line up without committing. One table drives the hit test, the
# drawing and the page's tutorial, so they cannot drift apart.
#   kind "jog"  : runs while engaged, stops on E again or on drifting off
#   kind "grip" : sets the claw angle (unused — nothing on this arm knows where
#                 it is; kept for the day a positional servo goes back on)
#   kind "stop" : everything off
ZONES = [
    (0.02, 0.04, 0.20, 0.26, "CLAW +",     "jog", GRIP, +SPEED),
    (0.02, 0.37, 0.20, 0.26, "STOP",       "stop", None, 0),
    (0.02, 0.70, 0.20, 0.26, "CLAW -",     "jog", GRIP, -SPEED),

    (0.26, 0.04, 0.22, 0.26, "SHOULDER +", "jog", SHOULDER, +SPEED),
    (0.26, 0.70, 0.22, 0.26, "SHOULDER -", "jog", SHOULDER, -SPEED),
    (0.52, 0.04, 0.22, 0.26, "ELBOW +",    "jog", ELBOW, +SPEED),
    (0.52, 0.70, 0.22, 0.26, "ELBOW -",    "jog", ELBOW, -SPEED),
    (0.78, 0.04, 0.20, 0.26, "WRIST +",    "jog", WRIST, +SPEED),
    (0.78, 0.70, 0.20, 0.26, "WRIST -",    "jog", WRIST, -SPEED),

    (0.26, 0.37, 0.22, 0.26, "BASE <",     "jog", BASE, +SPEED),
    (0.52, 0.37, 0.22, 0.26, "BASE >",     "jog", BASE, -SPEED),
]

# Bench knobs, shared with the on-screen arrow buttons so the two ways of
# driving the arm agree. PULSE_MS is the coarse arrow's length, not the fine
# one: 140ms did not shift a loaded shoulder at all — the arm's weight eats a
# burst that short before it builds any speed. DUTY_MS above is the same idea
# applied continuously.
PULSE_MS = 420       # 360s: burst length per press
GRIP_STEP = 12       # sg90: degrees per press (unused while ch1 is a 360)

# The kill gesture: pinky alone, held. Long on purpose — it has to be
# impossible to hit by accident, and a hand passing through odd shapes on its
# way somewhere else must never switch the controls off mid-move.
KILL_FINGERS = [False, False, False, True]      # index, middle, ring, pinky
KILL_HOLD = 3.0

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


# IMPORTANT NOTE: the pinch used to be the press, and it misfired — a hand
# reaching across the frame reads as a pinch over whatever button it passes,
# and the joint runs. Engagement is now an explicit keypress that latches, so
# the hand only ever chooses WHICH button; it can never decide to press one.
# Aiming is therefore free: hover all you like, nothing moves until E.


class Controller:
    """Turns a stream of hand observations into servo commands.

    Stateful on purpose: holding a pinch has to keep a joint fed, and letting go
    has to stop it, neither of which a pure function of one frame can express.
    Both drivers (this file's window and servo.py's thread) share it so the two
    behave identically."""

    def __init__(self):
        self.grip = 90
        self.down = False           # running state, for edge detection
        self.held = None            # (ch, val) currently being driven
        self.next = 0.0             # when that needs feeding again
        self.kill_since = None      # when the pinky-only gesture started
        self.engaged = False        # the latch: only a keypress sets this
        self.speed = 0              # index into SPEEDS

    def toggle(self):
        self.engaged = not self.engaged
        return self.engaged

    def cycle_speed(self):
        self.speed = (self.speed + 1) % len(SPEEDS)
        return SPEEDS[self.speed][0]

    def _duty(self, now):
        """Full power, switched on and off. Below full, the joint gets the
        first `frac` of every DUTY_MS cycle and nothing for the rest."""
        frac = SPEEDS[self.speed][1]
        return frac >= 1.0 or (now % DUTY_MS) < DUTY_MS * frac

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
            # Losing the hand drops the latch too, not just the joint: coming
            # back into frame must never resume a move you have stopped
            # watching.
            self.down = self.engaged = False
            self.kill_since = None
            self._release(sends)
            return {"sends": sends, "hover": None, "pressed": False,
                    "stop": True, "grip": self.grip, "mode": "no hand - stopped"}

        # Pinky alone, held: switch the whole thing off. Checked before anything
        # else so it works even mid-hold — that is the point of a kill gesture.
        if m["fingers"] == KILL_FINGERS:
            # Even a partial hold drops the latch: it already stops the joint,
            # and leaving it armed means the move resumes the moment the hand
            # changes shape again.
            self.engaged = False
            if self.kill_since is None:
                self.kill_since = now
            waited = now - self.kill_since
            if waited >= KILL_HOLD:
                self.kill_since = None
                self.down = self.engaged = False
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

        # Engaged is the latch; duty chops it into bursts. Everything below
        # reads self.down exactly as it did when a pinch set it.
        was, self.down = self.down, self.engaged and self._duty(now)
        edge = self.down and not was          # the moment it starts running
        z = zone_at(m["point"][0], m["point"][1])
        label = z[4] if z else None

        # Disengaging stops the joint, and so does the off half of a duty
        # cycle. So does sliding off the button you were driving — the
        # alternative is a joint that keeps running because your hand drifted,
        # which is the failure that matters here.
        if self.held and (not self.down or z is None or z[6] != self.held[0]
                          or z[7] != self.held[1]):
            self._release(sends)

        out = {"sends": sends, "hover": label, "pressed": bool(self.held),
               "stop": False, "grip": self.grip}

        if z is None:
            out["mode"] = ("ENGAGED (%s) - hover a button" % SPEEDS[self.speed][0]
                           if self.engaged else "hover a button, E to run")
            return out
        kind, ch, val = z[5], z[6], z[7]

        if kind == "jog":
            if self.down:
                # Feeding the board's deadman: it stops any 360 that has not
                # heard from us in JOG_MS, so a crash here cannot leave one on.
                if self.held is None or now >= self.next:
                    sends.append((ch, val))
                    self.held, self.next = (ch, val), now + REFRESH
            # Lit while engaged, not just on the on-half: a button that blinks
            # at the duty rate reads as a dropped press.
            out.update(pressed=self.engaged,
                       mode=("%s - RUNNING (%s)" % (label, SPEEDS[self.speed][0])
                             if self.engaged else "over %s - E to run" % label))
            return out

        # The claw is positional, so it steps once per pinch rather than
        # running: holding a position command just re-sends the same angle.
        if not edge:
            out["mode"] = ("engaged - E off, then E again to step" if self.down
                           else "over %s - E to step" % label)
            return out
        out["pressed"] = True
        if kind == "stop":
            self.engaged = False        # STOP drops the latch, or E re-arms it
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


def open_cam(i):
    """None if index i has no camera behind it. Opening is the only way to ask:
    probing the device list wakes a Continuity Camera, and a busy one reports
    as missing anyway."""
    c = cv2.VideoCapture(i)
    if not c.isOpened():
        c.release()
        return None
    c.set(cv2.CAP_PROP_FRAME_WIDTH, 960)
    c.set(cv2.CAP_PROP_FRAME_HEIGHT, 540)
    return c


def main():
    cam = int(next((a.split("=")[1] for a in sys.argv if a.startswith("--cam=")), 0))
    cap = open_cam(cam)
    if cap is None:
        sys.exit("no camera %d. on macos, grant Terminal camera access in "
                 "System Settings > Privacy & Security > Camera" % cam)

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
    missing_since, ctl, readfail, camfail = None, Controller(), 0, 0
    while True:
        ok, frame = cap.read()
        if not ok:
            # IMPORTANT NOTE: avfoundation hands back one empty frame on its
            # own (device handoff, another app grabbing it). 30 in a row (~1s)
            # is a real disconnect; quitting on the first one is not.
            readfail += 1
            if readfail < 30:
                link.stop()
                time.sleep(0.03)
                continue
            break
        readfail = 0
        frame = cv2.flip(frame, 1)
        h, w = frame.shape[:2]
        lm = detect(frame)
        hint = ("cam %d%s · E run/stop · S speed · v switch · c recal · "
                "space stop · q quit") % (
            cam, " (only one)" if time.time() - camfail < 2 else "")

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
                           ("%s · speed %s" % ("ENGAGED" if ctl.engaged else "idle",
                                               SPEEDS[ctl.speed][0]),
                            (90, 220, 90) if ctl.engaged else (170, 170, 170)),
                           (hint, (170, 170, 170))])
        else:
            r = ctl.feed(None, cal)
            for ch, v in r["sends"]:
                link.send(ch, v, force=True)
            if missing_since is None:
                missing_since = time.time()
                link.stop()
            draw_zones(frame)
            banner(frame, [("NO HAND — stopped", (80, 80, 255)),
                           (hint, (170, 170, 170))])

        if not link.ok:
            banner(frame, [("board not answering (%s)" % link.how, (80, 80, 255))],
                   y=h - 20)

        cv2.imshow(win, frame)
        k = cv2.waitKey(1) & 0xFF
        if k in (ord('q'), 27):
            break
        if k == ord(' '):
            ctl.engaged = False       # panic drops the latch, not just the pulse
            link.stop()
        if k in (ord('e'), 13):
            if not ctl.toggle():
                link.stop()
        if k == ord('s'):
            ctl.cycle_speed()
        if k == ord('v'):
            # Cycling beats a menu: the picture in the window is the label.
            # Try the next index, wrap to 0, and keep the current camera if
            # neither opens — never end up with no camera at all.
            link.stop()
            camfail = time.time()
            for nxt in (cam + 1, 0):
                c = open_cam(nxt) if nxt != cam else None
                if c is not None:
                    cap.release()
                    cap, cam, camfail = c, nxt, 0
                    break
            readfail = 0
        if k == ord('c'):
            link.stop()
            keep = ctl.speed
            ctl = Controller()
            ctl.speed = keep
            new = calibrate(cap, detect, win)
            if new:
                cal = new

    link.stop()
    link.close()
    cap.release()
    cv2.destroyAllWindows()


def selftest():
    """The hit test, the latch and the burst timing are the whole feature — a
    hover that moves a joint, or an engaged joint that keeps running after the
    hand drifts off, is the kind of bug that only shows up with an arm
    swinging."""
    import types
    cal = {"x": .5, "y": .5, "span": .2, "roll": 0.,
           "pinch_open": 1.0, "pinch_closed": 0.2}

    def hand(x, y):
        return {"x": .5, "y": .5, "span": .2, "pinch": 0.9, "roll": 0.,
                "fingers": [True, False, False, False], "point": (x, y)}

    def centre(z):
        return z[0] + z[2] / 2, z[1] + z[3] / 2

    FULL = len(SPEEDS) - 1            # duty off, so the timings below are exact

    def armed(speed=None):
        c = Controller()
        c.engaged, c.speed = True, FULL if speed is None else speed
        return c

    joints = (BASE, SHOULDER, ELBOW, WRIST)
    jogs = [z for z in ZONES if z[5] == "jog"]

    # every button is reachable at its own centre and reports itself
    for z in ZONES:
        x, y = centre(z)
        assert zone_at(x, y) is z, z[4]
        assert Controller().feed(hand(x, y), cal, now=0)["hover"] == z[4]

    # hovering never sends anything, however long you hover — the latch is off
    for z in ZONES:
        c = Controller()
        for t in range(5):
            r = c.feed(hand(*centre(z)), cal, now=t)
            assert not r["pressed"] and not r["sends"], z[4]

    # E latches, E again drops it; the default is off and slow
    c = Controller()
    assert not c.engaged and SPEEDS[c.speed][0] == "slow", "must start off, slow"
    assert c.toggle() and c.engaged
    assert not c.toggle() and not c.engaged
    names = [c.cycle_speed() for _ in SPEEDS]
    assert names == [n for n, _ in SPEEDS][1:] + [SPEEDS[0][0]], names

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
    c = armed()
    c.feed(hand(*centre(z)), cal, now=0)
    k = c.feed(pinky(), cal, now=0.1)
    assert (z[6], 0) in k["sends"], "kill gesture must release a held joint"
    assert not c.engaged, "kill must drop the latch, not just the pulse"

    # a hand that is merely out of frame must not bank progress toward the kill
    c = Controller()
    c.feed(pinky(), cal, now=0)
    c.feed(None, cal, now=1)
    assert not c.feed(pinky(), cal, now=KILL_HOLD - 0.5).get("kill")

    # engaging starts the joint and staying there keeps it fed, at the refresh rate
    for z in jogs:
        c = Controller(); c.speed = FULL
        assert c.feed(hand(*centre(z)), cal, now=0)["sends"] == []   # hovering
        c.toggle()
        r = c.feed(hand(*centre(z)), cal, now=0.01)
        assert r["sends"] == [(z[6], z[7])], (z[4], r["sends"])
        # too soon to repeat: the board is already holding this value
        assert c.feed(hand(*centre(z)), cal, now=0.02)["sends"] == []
        # but the deadman must be fed before it expires
        assert c.feed(hand(*centre(z)), cal,
                      now=0.01 + REFRESH)["sends"] == [(z[6], z[7])]
        assert REFRESH < 0.8, "the board stops a 360 after JOG_MS (0.8s)"
        # E again stops it, once
        c.toggle()
        rel = c.feed(hand(*centre(z)), cal, now=1.0)
        assert rel["sends"] == [(z[6], 0)], rel["sends"]
        assert c.feed(hand(*centre(z)), cal, now=1.1)["sends"] == []

    # sliding off the button while still engaged stops it too
    z = jogs[0]
    c = armed()
    c.feed(hand(*centre(z)), cal, now=0)
    off = c.feed(hand(0.5, 0.5), cal, now=0.1)
    assert off["sends"] == [(z[6], 0)], "drifting off a held button must stop it"

    # moving from one button to another swaps cleanly: stop the old, start new
    a, b = jogs[0], jogs[1]
    c = armed()
    c.feed(hand(*centre(a)), cal, now=0)
    sw = c.feed(hand(*centre(b)), cal, now=0.1)
    assert (a[6], 0) in sw["sends"] and (b[6], b[7]) in sw["sends"], sw["sends"]

    # speed is duty, not a weaker pulse: the value sent is always full scale,
    # and below full the joint gets bursts with real gaps between them
    z = jogs[0]
    for i, (name, frac) in enumerate(SPEEDS):
        c = armed(i)
        on = [t for t in range(int(DUTY_MS * 1000))
              if c._duty(t / 1000.0)]
        assert abs(len(on) / (DUTY_MS * 1000) - frac) < 0.02, (name, len(on))
        r = c.feed(hand(*centre(z)), cal, now=0.0)      # start of a cycle: on
        assert r["sends"] == [(z[6], z[7])], (name, r["sends"])
    slow = armed(0)
    slow.feed(hand(*centre(z)), cal, now=0.0)           # burst starts
    gap = slow.feed(hand(*centre(z)), cal, now=DUTY_MS * 0.9)
    assert gap["sends"] == [(z[6], 0)], "the off half must actually stop it"
    assert gap["pressed"], "but the button stays lit, or it reads as a drop"

    # the claw is a jog like the rest — ch1 has no position feedback, so there
    # is no angle to step to and an angle command there never stops
    assert [z for z in ZONES if z[4] == "CLAW +"][0] in jogs

    # engaged off the buttons does nothing at all
    c = armed()
    assert c.feed(hand(0.5, 0.5), cal, now=0)["sends"] == []

    # losing the hand stops, releases, and drops the latch
    c = armed()
    z = jogs[0]
    c.feed(hand(*centre(z)), cal, now=0)
    gone = c.feed(None, cal, now=0.2)
    assert gone["stop"] and gone["sends"] == [(z[6], 0)]
    assert not c.engaged, "a hand out of frame must not stay armed"

    # STOP drops the latch too
    st = [z for z in ZONES if z[5] == "stop"][0]
    c = armed()
    r = c.feed(hand(*centre(st)), cal, now=0)
    assert r["stop"] and not c.engaged

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
