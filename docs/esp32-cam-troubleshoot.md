# ESP32-CAM Troubleshooting Reference

## Board Info
- **Chip**: ESP32-D0WD-V3 (rev v3.1)
- **MAC**: `e0:8c:fe:30:38:28`
- **Hostname**: `blackout-cam.local`
- **Flash**: 4MB

## Network Config (`main.ino:23-34`)
```
#define CAM_NETWORK   SECRET_SSID_HOTSPOT   // pick: _HOME, _SCHOOL, _HOTSPOT
#define CAM_USE_STATIC true                 // true for hotspot, false for DHCP
IPAddress CAM_IP (172, 20, 10, 10);         // hotspot static IP
IPAddress CAM_GW (172, 20, 10, 1);
IPAddress CAM_MASK(255, 255, 255, 240);     // /28
```

To switch networks: edit `CAM_NETWORK` and `CAM_USE_STATIC`, then re-upload.

## Credentials (`arduino_secrets.h`)
| Network | SSID | Password |
|---------|------|----------|
| Home | `TP-Link_B964` | `44880057` |
| School | `SCHOOL-WIFI` | `(removed)` |
| Hotspot | `JesuiPhone` | `12345678` |

## Known IPs
| Network | Cam IP | Notes |
|---------|--------|-------|
| JesuiPhone hotspot | `172.20.10.10` | Static, always same |
| TP-Link home (DHCP) | `192.168.1.111` | Reserved by MAC, but may get `.0.39` |
| School | DHCP | Use `blackout-cam.local` |

## Dashboard Host List (`app.js`)
```js
const CAM_HOSTS = ["172.20.10.10", "192.168.1.111", "blackout-cam.local"];
```
Default is now `172.20.10.10` (hotspot). Override via `localStorage.setItem("camHost", "x.x.x.x")`.

## Stream URLs
- **Stream**: `http://<host>:81/stream`
- **Capture**: `http://<host>/capture`
- **Control**: `http://<host>/control?var=<name>&val=<value>`

## Camera Sensor Controls (`/control?var=&val=`)
| Var | Values | Description |
|-----|--------|-------------|
| `brightness` | -2 to 2 | Image brightness |
| `contrast` | -2 to 2 | Image contrast |
| `saturation` | -2 to 2 | Color saturation |
| `sharpness` | -2 to 2 | Edge sharpness |
| `special_effect` | 0-6 | 0=no effect |
| `whitebal` | 0/1 | Auto white balance |
| `awb_gain` | 0/1 | AWB gain |
| `wb_mode` | 0-4 | White balance mode |
| `exposure_ctrl` | 0/1 | Auto exposure |
| `ae_level` | -2 to 2 | Auto exposure level |
| `aec_value` | 0-1200 | Manual exposure value |
| `gain_ctrl` | 0/1 | Auto gain |
| `agc_gain` | 0-30 | Manual gain |
| `gainceiling` | 0-6 | Max gain |
| `raw_gma` | 0/1 | Gamma correction |
| `lenc` | 0/1 | Lens correction |
| `dcw` | 0/1 | Downsize |
| `hmirror` | 0/1 | Horizontal mirror |
| `vflip` | 0/1 | Vertical flip |

## Flash LED (GPIO 4)
- PWM dim at boot (`ledcWrite(4, 15)` at 5kHz, 8-bit)
- Too bright → camera image washes out (purple tint)
- To turn off: change to `ledcWrite(4, 0)` or remove `ledcAttach` entirely

## Common Issues & Fixes

### 1. No serial output, cam not on network
**Fix**: Upload a blink sketch to confirm chip is alive. If blink works, flash was corrupted — upload the cam sketch with a full erase (done automatically when sketch binary doesn't match).

### 2. `st=6` printed a few times then silence (brownout)
**Cause**: CH340 USB adapter can't supply enough current when ESP32 WiFi radio activates. The 3.3V regulator browns out.

**Fix**: Power the cam separately (power bank, Uno 5V pin) and keep CH340 only on RX/TX/GND.

### 3. Cam connects but dashboard shows offline
**Fix**: 
- Open browser console: `localStorage.setItem("camHost", "172.20.10.10")` then refresh
- Or enter IP in the offline panel text field and press Enter

### 4. Camera won't connect to hotspot
- Ensure JesuiPhone is ON with "Allow Others to Join" enabled
- Keep cam near the phone (within ~5m)
- Wait ~15s for cam to complete its connection attempts (reboot cycle)

### 5. Camera image too bright/washed out
- Lower brightness: `curl "http://172.20.10.10/control?var=brightness&val=-1"`
- Lower contrast: `curl "http://172.20.10.10/control?var=contrast&val=-1"`
- Current defaults: brightness=-1, contrast=-1

### 6. TP-Link router poisons `.local` DNS
Do NOT rely on `blackout-cam.local` on the TP-Link network — the router intercepts ALL `.local` queries and returns `127.0.0.1`. Use raw IP instead.

## Upload Log (2026-07-15)
- Original cam sketch had corrupted flash → no boot, no serial, no WiFi
- Blink upload fixed it (full erase)
- Re-uploaded cam sketch → worked at `192.168.0.39` (DHCP)
- After multiple re-flashes, brownout issues emerged (CH340 power limit)
- Final working config: JesuiPhone hotspot, static `172.20.10.10`, brightness/contrast -1
