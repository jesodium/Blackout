# Desktop app — hardware checklist

Everything below needs a real Giga R1, the ESP32-CAM, or the packaged build —
none of it could be verified while the app was built (no hardware attached).
Work top to bottom; the BLE items are the ones that can kill competition day.

Dev app: `cd server && npm run app` (one-time `npm install` in `electron/` first).
Packaged app: `cd electron && npm run dist` → `electron/dist/mac*/Blackout.app`.

## 1. BLE pairing (Giga R1 powered, dev app first)

- [ ] Click **Connect** → the in-app picker opens (not Chrome's chooser) and the
      Giga appears as a row.
- [ ] **What name does the Giga actually advertise?** ArduinoBLE on the R4
      always said "arduino" (bug); on the Giga it's untested. Either way is
      handled — a duplicated/empty name shows as `arduino · XXXX` (id tail).
      With two robots powered, confirm the rows are visibly distinct.
- [ ] Tap the row → GATT connects, lamp goes green, telemetry flows.
- [ ] `go,test` routine + `stop` round-trip from the Drive pad.
- [ ] Power-cycle the Giga mid-link → dashboard drops to disconnected, ⟳
      re-pick works.
- [ ] Cancel in the picker actually stops the scan (no ghost connect after).
- [ ] Scan feels too slow/fast at the venue → tune `TUNING` in
      `electron/main.js` (scan/poll timings) — that's what it's for.

## 2. Packaged build (`Blackout.app`)

- [ ] First launch: macOS asks for **Bluetooth permission** with the "pairs
      with the recon rover" text. If the prompt never appears, the Info.plist
      key didn't land — BLE will fail silently. (`plutil -p
      Blackout.app/Contents/Info.plist | grep Bluetooth` to confirm.)
- [ ] Pairing works in the packaged app, not just `npm run app`.
- [ ] API keys: menu **Blackout → Settings / API Keys…** opens
      `blackout.env` — fill in Cerebras/Deepgram keys, relaunch, Sage answers.
      (The packaged app ships **no** `.env` on purpose.)
- [ ] Save + reload a `.blk` workflow from the packaged app (writes inside
      `Blackout.app/Contents/Resources/server/workflows` — app must live
      somewhere user-writable, e.g. ~/Applications, not a read-only mount).
- [ ] Firmware updater: plug the Giga over USB → updater bar appears, flash
      works. If `arduino-cli` isn't found, the PATH append in
      `electron/main.js` needs your install dir added.

## 3. Camera

- [ ] `http://blackout-cam.local/stream` renders in the Electron window on the
      venue/hotspot network (mDNS uses the macOS resolver — should match
      Chrome, unverified with the real cam).
- [ ] FPV mode fullscreen with the live stream.

## 4. Mirror (judges' tablet)

- [ ] Tablet on the same LAN loads the dashboard → view-only pill, no drive.
- [ ] Grant from CONNECTED DEVICES in the Electron window → tablet gets
      control; revoke works.
- [ ] All at once: BLE link + camera + tablet mirroring — watch for jank.

## 5. App lifecycle

- [ ] Quit the app mid-BLE-link → does the robot get a `stop`? (It does not —
      routines run on-board by design; confirm that's acceptable.)
- [ ] Double-launch the app → second launch focuses the first, no port clash.
- [ ] Kill the server child (`kill <pid>` of the node child) → crash dialog
      with Relaunch appears, Relaunch recovers.
- [ ] Window position/size survives a relaunch.
