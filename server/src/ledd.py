#!/usr/bin/env python3
"""Steren SHOME-1282 strip, held open for the dashboard.

One-shot `led.py` calls are ~250ms each because every one reconnects and reads
status back; a pulse at 5fps needs the socket kept. Reads `H S V` frames on
stdin (hue 0-359, sat/val 0-1000) and writes dps 24 straight, ~50-250ms a write.

Frames are COALESCED: node pushes as fast as it likes, the reader thread keeps
only the newest, so a slow write drops frames instead of queueing lag.
"""
import os, sys, threading, time

sys.path.insert(0, os.path.dirname(os.path.expanduser(os.environ.get("LED_PY", "~/led.py"))))
import led  # device id, key, and the cached-ip/broadcast-scan connect

latest = [None]
alive = [True]


def reader():
    for line in sys.stdin:
        line = line.strip()
        latest[0] = line if line else None
    alive[0] = False


def main():
    threading.Thread(target=reader, daemon=True).start()
    d = None
    sent = None
    on = False
    while True:
        want = latest[0]
        if want is None or want == sent:
            # stdin closed and the last frame is on the strip: park it off and go
            if not alive[0]:
                if d is not None and on:
                    try: d.turn_off()
                    except Exception: pass
                return
            time.sleep(0.03)
            continue
        try:
            if d is None:
                d = led.connect()
                d.set_value(21, "colour")   # it may be parked in music/scene mode
                on = False
            h, s, v = (int(x) for x in want.split())
            if v <= 0:
                if on:
                    d.turn_off()
                on = False
            else:
                if not on:
                    d.turn_on()
                    on = True
                d.set_value(24, "%04x%04x%04x" % (h, s, v), nowait=True)
            sent = want
            print("ok", flush=True)
        except Exception as e:
            # a dropped strip must not take the dashboard with it: forget the
            # socket, back off, and let the next frame reconnect.
            d, sent, on = None, None, False
            print("err %s" % e, flush=True)
            time.sleep(2)


if __name__ == "__main__":
    main()
