# BLACKOUT Sensor Hub v1.5

**v1.5** (2026-10-12): J32 `W1 GYRO I2C` (PH4: 3V3, GND, SCL1, SDA1) and J33 `MQ135 5V A1` (PH4: fused 5V, GND, DO not connected, AO through R12 10k / R13 15k to A1, max 3.15 V). F1, C1, C3, C4, R10/R11 and D1/D2 moved into free gaps; C5/C6 dropped. Built with `source/keep.sh <outdir>` (`DROP="net:+5V_FUSED" MP=100`), checked with `source/verify.py`, fab files from `source/fab.py`. The v1.4 board and schematic are in `kicad/archive_v1.4/`. Ordering notes: `../README.txt`. The rest of this file describes v1.4.

This is a **Giga R1 WiFi shield that turns the rover's sensors into plug-in modules.** Every sensor gets its own keyed JST-PH port, labelled on the silkscreen with bus, address, pin names and voltage.
The three I2C buses stay separate: `Wire` feeds the arm alone. Each of Wire1 and Wire2 gets Qwiic ports for new sensors. The ports for the LIDAR, IMU and L298N are already there.
**v1.1 adds two things:**
- Every Giga header pin is named on the silkscreen, and pins the shield already uses are printed inverted.
**v1.3** adds two spare JST-PH ports for sensors added later: J28 (3-pin: 3V3, A0, GND) and J29 (4-pin: 3V3, D44, D46, GND). J31 moved 3 mm right to make room. See PINOUT.md.
**v1.4** replaces the OLED port with J11, a JST-PH8 port for a 3.5" ILI9488 SPI display ("3.5in TFT SPI 480x320 V1.0").
  - Its pin order matches pins 1-8 of the display's header, so the cable crimps straight through.
  - It uses `SPI1` (D13 SCK, D11 MOSI), with D10 for CS and D1 for DC. It also carries fused 5V.
  - The port is turned 180° so CK, DI and CS sit in the same order as D13, D11 and D10.
  - The BME280 port (J12) moved to the bottom-left corner to make room, and C4-C6 moved up 4.3 mm. All other copper is kept from v1.3.
  - J30 is labelled "EXTRA PINS".

- A spare-GPIO breakout: a 2x7 header with PWM D10-D13, Serial2 D18/D19, A1-A4, A6 and A7, next to 3V3 and GND, plus a 3V3/GND rail by the D22-D53 block.

The board is 2 layers, 101.6 × 53.34 mm (the Mega/Giga outline). Parts are on the top side only, all SMD, 0805 or larger, except the Giga headers and the L298N header.

![top](docs/renders/top.png)

## Status

| Check | Result |
|---|---|
| ERC (KiCad 10.0.6, all severities) | **0 errors, 0 warnings** (`reports/erc.rpt`) — v1.1 |
| DRC (all severities, schematic parity on) | **0 violations, 0 unconnected, 0 parity issues** (`reports/drc.rpt`) |
| Routing | Freerouting 2.4.1, 100 % routed. It routes at 0.22 mm clearance as a safety margin, and the board is checked at 0.2 mm. GND pour on both layers with stitching vias |

One project rule relaxes a default (`kicad/blackout_sensor_hub.kicad_dru`): a GND thermal needs only 1 spoke, not 2.
That is safe because every GND pad is also routed to GND by a track. The pour is extra.

## Why it's built this way

- **Shield, not a separate hub board.** Every pin the robot uses is already on the Mega-layout headers except D72. That covers D2-D7, D8/D9, D20/D21, the D22-D53 block, SDA1/SCL1 by AREF, A5 and the power header.
  A shield has no ribbon or harness to the Giga that could come loose, and nothing to mis-wire. The outline, the six Ø3.2 holes and the header positions come from KiCad's official Arduino_Mega template.
  I checked them against the Giga datasheet (ABX00063 §15: 101.6 × 53.34 mm, the same six holes).
- **SMD JST-PH ports everywhere, not through-hole.** Parts on the Giga poke up into the space under the shield: USB-A, the audio jack, the two camera/display headers (J5/J6), SPI and JTAG.
  An SMD port puts nothing through the board, so ports can sit anywhere. Their outlines are on the `User.Comments` layer, taken from the datasheet's top view.
  PH is keyed, and every port's pin order matches the module's own header, so each cable is crimped straight through. (A reversed VCC/GND cost the team a day on the GY-302.)
- **I2C isolation is enforced by copper.** D20/D21 go to J10 (the PCA9685) and nowhere else. A browned-out servo driver can only clamp its own bus.
  - Wire1 (SDA1/SCL1): BME280, 2× Qwiic. The OLED left in v1.4, replaced by the SPI LCD.
  - Wire2 (D9/D8): GY-302 with **ADDR hard-tied to GND** so it stays 0x23, plus 3× Qwiic for the ENS160/AHT21 and the INA219 (at 0x41).
  - The pull-ups are fitted but switched off by an open jumper, because the modules already carry their own.
- **3V3 everywhere, 5V only where it has to be.** 5V reaches only the LIDAR, the LCD (v1.4) and (by default) the relay modules' VCC.
  It comes straight from the Giga's 5V pin through a 1.1 A PTC. There is no external 5V input or MQ-2 port any more (removed in v1.2).
  The Giga's 5V pin current rating isn't published. The whole budget is LIDAR (~300 mA at start), LCD (~100 mA) and relay coils, roughly 0.8 A. That is under F1's 1.1 A hold, but more than a USB port gives, so run the rover from VIN. Nothing above 3.3 V ever reaches a Giga pin:
  - The UART inputs have 1 kΩ in series, which limits the current if a 5V-TX device is ever plugged in.
  - The LCD port is write-only. The display's SDO and touch pins aren't on it, so nothing on that cable drives a Giga pin.
    The ILI9488's logic runs at 3.3 V; only VCC is 5 V, and it feeds the module's own regulator.
- **Pinout follows the firmware, not the other way round.** The existing sensors land on exactly the pins in `main.ino` and `arm.h`: TRIG 52, ECHO 50, DHT A5, relays 26/28/30, OE 32, L298N 2-7, the three Wire objects. **No firmware change is needed.**
  The new ports follow `parts/WIRING.md`: LD19 on Serial3 (D17), BNO086 RVC on Serial4 (D15). The LD19's PWM pin is grounded by default, as its manual requires.
- **L298N header sits directly under D2-D7.** It's mirrored (pin 1 on the right) so each signal runs straight down. It keeps the L298N's own order, so the ribbon still runs straight across.

- **v1.1 pin names go on the outside of each header row.** The strip on the inside is hidden under the stacking-header housing.
  - Text is 0.8 mm tall with a 0.15 mm stroke, narrowed so a 5-letter name like `CANRX` fits the 2.54 mm pitch.
  - On the 2x18, odd numbers are printed vertically, because the board edge is only 1.7 mm from those pads.
- **v1.1 breakout: one compact 2x7 rather than servo-style rows.** Three rows of 12 would take about 34 × 12 mm, and there is no such space without dropping a port.
  - The 2x7 fits the corner where the logo used to sit. The logo moved to the edge strip and the back.
  - The top row is 3V3 + PWM/UART and the bottom row is GND + analog, so each group has a rail at its end.
  - The D22-D53 block, A8-A11, the DACs and CAN are reachable at the labelled stacking-header sockets, per the priority order. They get their own 3V3/GND rail (J31) next to JSIDE.

Not included, on purpose: a TVS/ESD array. The UART inputs are covered by the series resistors, and every other port runs to a module on the same chassis ground. Adding it would have cost board space the ports needed.
A Fritzing file was also skipped: its 2020 build can't import KiCad, and the KiCad files are the source of truth.

## Files

```
kicad/     blackout_sensor_hub.kicad_pro/.kicad_sch/.kicad_pcb/.kicad_dru, fp-lib-table,
           Blackout.pretty/ (Giga headers without silk, M3 hole without courtyard)
           archive_v1.3/ (the v1.3 board + schematic, with the OLED port)
fab/       blackout_sensor_hub_jlcpcb_v1.4.zip  <- upload this
           blackout_sensor_hub_jlcpcb_v1.3.zip  (OLED port instead of the LCD)
           blackout_sensor_hub_jlcpcb_v1.2.zip  (before the AUX ports)
           blackout_sensor_hub_jlcpcb_v1.zip    (previous revision, kept as-is)
           gerbers/ (the same files, unzipped, plus the drill map)
           bom.csv (all parts), bom_jlcpcb.csv + cpl_jlcpcb.csv (SMT assembly)
docs/      schematic.pdf, assembly_top.pdf (refdes on F.Fab), renders/ (top, bottom, iso PNG; layer SVGs)
reports/   erc.rpt, drc.rpt
source/    the generator (design.py is the single netlist+placement source) -- see "Regenerating"
PINOUT.md  every port, pin by pin, with the firmware names
```

## Ordering (JLCPCB)

1. Go to jlcpcb.com, then **Order now**, and upload `fab/blackout_sensor_hub_jlcpcb_v1.4.zip`. It should detect 2 layers, 101.6 × 53.34 mm.
2. Set: FR-4, 1.6 mm, **HASL lead-free**. **Black** solder mask with white silk suits the name (any colour works). "Remove order number": specify a location, or pay the small fee.
3. **Board only (hand-solder):** order 5 pcs, then buy the parts in `fab/bom.csv` from LCSC (every line has a C-number except the headers).
   **SMT assembly:** turn on PCB Assembly (Economic, top side). Upload `fab/bom_jlcpcb.csv` and `fab/cpl_jlcpcb.csv`.
   In the placement preview, **check the rotation of each JST connector** (JLC's footprint origins differ from KiCad's, so fix any that look wrong). The Giga headers and J22 are not in the assembly files. Solder those yourself.
4. Rough cost:
   - Five bare boards are about **US$5-10**. The board is just over 100 mm, so it misses the US$2 promo size.
   - Shipping to a Miami PO-box forwarder is about **US$15-25**.
   - Assembly for 2 boards adds roughly **US$40-60**. Most of that is a US$3 extended-part fee per unique connector/FET/PTC. The parts themselves are about US$4 per board.
   - Hand-solder parts from LCSC for 5 boards come to about **US$15-20**, plus headers.
  - v1.1 does not change the price. The board size, layer count and SMT parts are the same. It only adds a 2x7 and a 2x2 male header, about US$0.30 per board, hand-soldered.

## Assembly notes

- **Solder the SMD parts first, headers last.**
  - For the Giga headers, use an Arduino **Mega stacking-header set**, or plain male headers inserted from the bottom (J1-J7). Solder one pin per header, seat the board on the Giga, then finish, so the headers come out straight.
  - J22 (L298N) is a 1x7 male header on top. **Trim its pins flush underneath**, because it sits over the Giga.
  - J30 (the 2x7 breakout) and J31 (the 2x2 rail) are male headers on top. Trim them flush as well.
  - **Use stacking headers**, not plain male pins. That is what makes the labelled sockets usable for D22-D53, A8-A11, the DACs and CAN.
- **Buzzer:** D72 lives on the Giga's J5 display/camera header, not on any Mega header. Run a short wire from the Giga's D72 to the **TP1 `D72`** pad. JP5 ships bridged to TP1.
  To avoid the wire, cut JP5's 1-2 trace, bridge 2-3 (D34), and change `BUZZ_PIN` to 34.
- Cut or bridge the jumpers as listed in PINOUT.md. The default state matches today's firmware and the LD19 manual.
- Power-up check:
  - With the Giga on USB, **D1 green** (3V3) should light. **D2 red** (fused 5V) should light too.
  - Then run `giga-r1/i2c_scan/`. Expect 0x40 on Wire only, 0x76 on Wire1 (plus the known 0x60 ghost), and 0x23 on Wire2. The LCD isn't on I2C.
- top.png/iso.png come from a render-only copy made by `source/dress.py <board> <copy>`. It shows the Giga headers as stacking sockets and uses the through-hole PH housing to stand in for the SMD one (KiCad has no SM4-TB model). bottom.png comes from the real board. The copper is unchanged.

## Verify before ordering

1. **Print `docs/renders/top_layers.svg` at 100 % and lay the Giga on it.** Check each header row and the 2x18 JSIDE block.
   The positions come from KiCad's Mega template. The JSIDE column order was checked only against the datasheet drawing: even D-numbers on the inner column, 5V at the top, GND at the bottom. Nobody has measured it on a real board yet.
2. **Clearance above the Giga.** J5/J6 (camera/display), SPI and JTAG were placed by scaling the datasheet's top-view drawing, so they are approximate. Only the pins of J22, J30 and J31, plus the header joints, pass through the board.
   Check that J22's trimmed pins clear whatever sits under x≈43-58 mm, y≈45 mm from the board's top-left corner.
3. **Under the v1.1 breakout (0-18 mm in from the left edge, 6-13 mm down from the top edge)** the Giga has its USB-C receptacle (~3.2 mm tall) and the Wi-Fi module.
   There should be about 5 mm of clearance under trimmed pins, but check it with the board in hand. If the U.FL antenna lead is fitted, make sure it isn't pinched.
4. **The Giga's 3V3 budget.** All the 3V3 modules together (BME, BH1750, DHT, sonar, PCA logic, BNO086, ENS160, INA219) draw well under 150 mA. Arduino doesn't publish the 3V3 pin's limit, so keep that in mind before adding a power-hungry 3V3 module.
5. **Relay modules.** J21 gives the module 5V VCC and 3.3 V active-low inputs, which is the same arrangement as today. If your relay board needs its inputs at VCC level to release fully, put it on 3V3 with JP4, or use a 3.3V-logic board.
6. **LCSC part numbers were checked on lcsc.com** (each C-number resolves to that exact part), but not for stock or basic/extended status on the day you order.
7. The files are **KiCad 10** format and won't open in KiCad 9 or older.

## Regenerating

**Adding a part without re-routing everything (how v1.3 was made):** a full `build.sh` re-route no longer comes out clean (Freerouting leaves ~16 gaps), so v1.3 kept the v1.2 copper:
`gen_sch.py` + `mklib.py` + `gen_pcb.py` into an out dir, then `keep_route.py <old routed board> <new placed board> J28 J29 J31`, then DSN export + Freerouting + `fin.py` as in `route.sh`/`build.sh`. Only the copper around the new/moved parts changes.
v1.4 was made the same way from `kicad/archive_v1.3/` with `keep_route.py ... J11 J12 C4 C5 C6 J4` and Freerouting `-mp 100`. Runs at 150, 300 and 400 left gaps, so if it doesn't come out clean, try a few `MP` values.


`source/` rebuilds everything from `design.py`, which holds the netlist and the placement:
`build.sh` → schematic → footprint library → placed board → Freerouting → GND stitching and pour → ERC/DRC.

It needs:
- KiCad 10 at `~/Applications/KiCad/KiCad.app`, for its bundled python (`pcbnew`) and `kicad-cli`.
- An OpenJDK.
- `freerouting.jar` (v2.4.1) next to the scripts.
- KiCad's `Arduino_Mega` template, stripped down to `tmpl/base.kicad_pcb`.

Freerouting's result shifts with small placement changes, so re-check DRC after any edit.
