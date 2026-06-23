#!/usr/bin/env python3
# Bluetooth -> dashboard bridge. node's serialport can't read the macOS BT SPP
# port, so this reads it with pyserial and POSTs each CSV line to the server's
# /api/mega/sensor endpoint. Spawned/killed by the server (BT Bridge button).
import os, sys, time, urllib.request
import serial

PORT = os.environ.get("BT_PORT", "/dev/cu.BLACKOUT-V1")
URL  = os.environ.get("SERVER_URL", "http://localhost:3000/api/mega/sensor")

def post(line):
    try:
        req = urllib.request.Request(URL, data=line.encode(),
                                     headers={"Content-Type": "text/plain"})
        urllib.request.urlopen(req, timeout=2).read()
    except Exception:
        pass

while True:
    try:
        s = serial.Serial(PORT, 9600, timeout=2)
        print("BRIDGE: BT open", flush=True)
        while True:
            ln = s.readline().decode(errors="replace").strip()
            if ln.startswith("S:"):
                post(ln)
                print("-> " + ln, flush=True)
    except Exception as e:
        print("BRIDGE reconnect: " + str(e), flush=True)
        time.sleep(3)
