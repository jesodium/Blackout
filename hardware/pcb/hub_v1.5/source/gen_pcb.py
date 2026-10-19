"""Build the PCB from design.py on top of KiCad's official Arduino_Mega template.
Run with KiCad's bundled python.  Stage 'place' writes an unrouted board."""
import os, sys
import pcbnew
from pcbnew import VECTOR2I, FromMM
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import design

HERE = os.path.dirname(os.path.abspath(__file__))
FP = os.path.expanduser("~/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints")
OUT = sys.argv[1]
PROJ = "blackout_sensor_hub"

def P(x, y):
    return VECTOR2I(FromMM(x), FromMM(y))

b = pcbnew.LoadBoard(os.path.join(HERE, "tmpl", "base.kicad_pcb"))
b.SetCopperLayerCount(2)

# ---- design rules: JLCPCB 2-layer defaults with margin
ds = b.GetDesignSettings()
ds.m_TrackMinWidth = FromMM(0.15)
ds.m_MinClearance = FromMM(0.2)
ds.m_ViasMinSize = FromMM(0.6)
ds.m_MinThroughDrill = FromMM(0.3)
ds.m_HoleToHoleMin = FromMM(0.5)
ds.m_CopperEdgeClearance = FromMM(0.3)
ds.m_SilkClearance = FromMM(0.0)
nc = ds.m_NetSettings.GetDefaultNetclass()
nc.SetClearance(FromMM(0.22))  # routing margin; fin.py sets 0.2 back
nc.SetTrackWidth(FromMM(0.2))
nc.SetViaDiameter(FromMM(0.6))
nc.SetViaDrill(FromMM(0.3))
def mkclass(name, w, via=0.6, drill=0.3):
    c = pcbnew.NETCLASS(name)
    c.SetClearance(FromMM(0.22)); c.SetTrackWidth(FromMM(w))
    c.SetViaDiameter(FromMM(via)); c.SetViaDrill(FromMM(drill))
    ds.m_NetSettings.SetNetclass(name, c)
mkclass("Power5V", 0.5, 0.8, 0.4)
mkclass("Power3V3", 0.25)
for n in ["+5V", "+5V_FUSED", "RLY_VCC"]:
    ds.m_NetSettings.SetNetclassPatternAssignment(n, "Power5V")
for n in ["+3V3", "GND"]:
    ds.m_NetSettings.SetNetclassPatternAssignment(n, "Power3V3")

import uuid
NS = uuid.UUID("6b1e8d52-0000-4000-8000-b1ac0b1ac0de")
def sym_uuid(ref):
    return str(uuid.uuid5(NS, "sym/" + ref))

# ---- nets
nets = {}
def net(name):
    if name not in nets:
        ni = pcbnew.NETINFO_ITEM(b, name)
        b.Add(ni)
        nets[name] = ni
    return nets[name]

def load(fpid):
    lib, name = fpid.split(":")
    d = os.path.join(OUT, lib + ".pretty") if lib == "Blackout" else os.path.join(FP, lib + ".pretty")
    return pcbnew.FootprintLoad(d, name)

def text(s, x, y, size=1.0, layer=pcbnew.F_SilkS, bold=False, angle=0, thick=None, just=0):
    t = pcbnew.PCB_TEXT(b)
    t.SetText(s)
    t.SetPosition(P(x, y))
    t.SetLayer(layer)
    t.SetTextSize(VECTOR2I(FromMM(size), FromMM(size)))
    t.SetTextThickness(FromMM(max(0.15, thick or 0, size * 0.16)))
    t.SetBold(bold)
    if angle:
        t.SetTextAngleDegrees(angle)
    if just < 0:
        t.SetHorizJustify(pcbnew.GR_TEXT_H_ALIGN_LEFT)
    elif just > 0:
        t.SetHorizJustify(pcbnew.GR_TEXT_H_ALIGN_RIGHT)
    b.Add(t)
    return t

def rect(x0, y0, x1, y1, layer, width=0.12):
    s = pcbnew.PCB_SHAPE(b)
    s.SetShape(pcbnew.SHAPE_T_RECT)
    s.SetStart(P(x0, y0)); s.SetEnd(P(x1, y1))
    s.SetLayer(layer); s.SetWidth(FromMM(width))
    b.Add(s)

for p in design.parts:
    fp = load(p["fp"])
    fp.SetFPID(pcbnew.LIB_ID(*p["fp"].split(":")))
    fp.SetPath(pcbnew.KIID_PATH("/" + sym_uuid(p["ref"])))
    fp.SetReference(p["ref"])
    fp.SetValue(p["value"])
    x, y, rot = p["at"]
    fp.SetPosition(P(x, y))
    fp.SetOrientationDegrees(rot)
    if p.get("lcsc"):
        for k, v in (("LCSC", p["lcsc"][0]), ("MPN", p["lcsc"][1])):
            f = pcbnew.PCB_FIELD(fp, pcbnew.FIELD_ID_USER if hasattr(pcbnew, "FIELD_ID_USER") else 0, k)
            f.SetText(v); f.SetVisible(False); f.SetLayer(pcbnew.F_Fab)
            fp.Add(f)
    for pad in fp.Pads():
        num = pad.GetNumber()
        key = int(num) if num.isdigit() else num
        if num == "":
            continue
        n = p["pins"].get(key, "__missing__")
        if n == "__missing__":
            raise KeyError("%s pad %s" % (p["ref"], num))
        if n is None:
            n = "unconnected-(%s-Pin_%s-Pad%s)" % (p["ref"], num, num)
        pad.SetNet(net(n))
    ref = fp.Reference()
    # silk: connectors get descriptive labels instead of refdes; small parts keep refdes
    # refdes live on F.Fab (assembly drawing + BOM); top silk is for the port legends
    ref.SetLayer(pcbnew.F_Fab)
    fp.Value().SetVisible(False)
    b.Add(fp)

    # port labels
    lab = p.get("label")
    if lab and p["ref"] != "TP1":
        leg = p.get("legend", [])
        n = len(leg)
        if p["fp"].startswith("Connector_JST:JST_PH") and rot == 90:   # pin 1 at the bottom
            lx, ly, la = p.get("label_at", (x + 6.7, y, 90))
            text(lab, lx, ly, 0.8, angle=la)
            for i, s in enumerate(leg):
                text(s, x + 4.7, y - (i - (n - 1) / 2) * 2.0, 0.8)
        elif p["fp"].startswith("Connector_JST:JST_PH") and rot == 270:   # pin 1 at the top
            lx, ly, la = p.get("label_at", (x - 6.7, y, 90))
            text(lab, lx, ly, 0.8, angle=la)
            for i, s in enumerate(leg):
                text(s, x - 4.1, y + (i - (n - 1) / 2) * 2.0, 0.8)
        elif p["fp"].startswith("Connector_JST:JST_PH") and rot == 180:   # pads face the Giga header
            text(lab, x, y + 5.3, 0.8)
            for i, s in enumerate(leg):
                text(s, x - (i - (n - 1) / 2) * 2.0, y - 4.5, 0.8)
        elif p["fp"].startswith("Connector_JST:JST_PH"):
            text(lab, x, y - 5.3, 0.8)
            for i, s in enumerate(leg):
                text(s, x + (i - (n - 1) / 2) * 2.0, y + 4.5, 0.8)
        elif "SRSS" in p["fp"]:
            text(lab, x, y - 3.5, 0.8)
            for i, s in enumerate(leg):
                text(s, x + (i - 1.5) * 1.0, y + 3.3, 0.8, thick=0.15)
        elif p["ref"] == "J22":   # rot 270: pin 1 on the right, straight under D2..D7
            text(lab, x - 7.62, y - 2.45, 0.8)
            for i, s in enumerate(leg):
                text(s, x - i * 2.54, y + 2.5, 0.8)
    if p["ref"] == "TP1":
        text("D72", x, y - 2.0, 0.8)

def lbl(s, x, y, w=0.6, angle=0, ko=False, just=0, layer=pcbnew.F_SilkS):
    """0.8 mm tall, 0.15 mm stroke; width narrowed so a Giga name fits a 2.54 pitch"""
    t = pcbnew.PCB_TEXT(b)
    t.SetText(s); t.SetPosition(P(x, y)); t.SetLayer(layer)
    t.SetTextSize(VECTOR2I(FromMM(w), FromMM(0.8)))
    t.SetTextThickness(FromMM(0.15))
    if angle:
        t.SetTextAngleDegrees(angle)
    if just < 0:
        t.SetHorizJustify(pcbnew.GR_TEXT_H_ALIGN_LEFT)
    elif just > 0:
        t.SetHorizJustify(pcbnew.GR_TEXT_H_ALIGN_RIGHT)
    t.SetIsKnockout(ko)
    b.Add(t)
    return t

byref = {p["ref"]: p for p in design.parts}

def used(ref, pad):
    n = byref[ref]["pins"].get(pad)
    return n is not None and n not in design.NOT_USED

# ---- every Giga header pin named, OUTSIDE the header rows (the stacking-header
# housing covers the strip inside). Inverted (knockout) label = the shield uses it.
for ref, names in design.GIGA_SILK.items():
    x0, y0, _ = byref[ref]["at"]
    ly = 47.45 if y0 < 60 else 99.17
    for i, s in enumerate(names):
        lbl(s, x0 + i * 2.54, ly, w=0.5 if len(s) >= 5 else 0.6, ko=used(ref, i + 1))
# JSIDE 2x18: even D (inner column) left of the header, odd D (outer) right of it,
# vertical -- the board edge is 1.7 mm from the outer pads there.
jx, jy, _ = byref["J7"]["at"]
jn = byref["J7"]["names"]
lbl("5V", jx + 1.27, 47.45)
for row in range(1, 18):
    y = jy + row * 2.54
    po, pe = 2 * row + 1, 2 * row + 2          # odd pad = inner column, even pad = outer
    lbl(jn[po], jx - 1.45, y, ko=used("J7", po), just=1)
    lbl(jn[pe], jx + 2.54 + 1.83, y, angle=90, ko=used("J7", pe))

# ---- spare GPIO breakout (J30), top-left
bx, by = design.BRK_X, design.BRK_Y
top = ["3V3", "D10", "D11", "D12", "D13", "D18", "D19"]
bot = ["GND", "A1", "A2", "A3", "A4", "A6", "A7"]
for i in range(7):
    lbl(top[i], bx + i * 2.54, by - 4.34, ko=top[i] in ("D10", "D11", "D13"))
    lbl(bot[i], bx + i * 2.54, by + 1.81, ko=bot[i] == "A1")
lbl("EXTRA PINS", bx + 3 * 2.54, by - 5.39)
lbl("SERIAL2: D18 TX  D19 RX", bx + 3 * 2.54, by + 2.86, w=0.55)
lbl("3V3 LOGIC - NOT 5V TOLERANT", bx + 3 * 2.54, by + 3.86, w=0.55)
# ---- 3V3 / GND rail (J31) for the D22-D53 block
rx, ry = design.RAIL_X, design.RAIL_Y
lbl("3V3 RAIL", rx + 1.27, ry - 4.45)
lbl("GND", rx + 1.27, ry + 1.81)
lbl("A8-11 ANALOG", rx + 1.27, ry + 2.86, w=0.55)
# ---- branding on the edge strips
lbl("BLACKOUT", 100.913, 48.87, just=-1).SetTextSize(VECTOR2I(FromMM(1), FromMM(1)))
# jumper legends
R4 = design.R4Y
text("PU", 165.5, 53.7, 0.8); text("PU", 184.6, 58.5, 0.8); text("PU", 144.2, 65.2, 0.8)
text("RLY", 187.3, R4 - 3.1, 0.8)
text("BZ", 140.8, 76.5, 0.8)
text("PW", 156.25, 76.5, 0.8)
text("3V3", 125.9, 97.5, 0.8, angle=90); text("5V", 184.8, 63.0, 0.8)

# ---- back silk: legend card (faces the Giga once mounted, readable in hand)
BS = pcbnew.B_SilkS
for i, line in enumerate([
        "BLACKOUT",
        "ALL PORTS 3V3 POWER + 3V3 LOGIC - NOT 5V TOLERANT",
        "5V ONLY: LIDAR, RELAY VCC, LCD, MQ135 HEATER",
        "WIRE D20/21 = ARM PCA9685 ONLY",
        "W1 = SDA1 D102 / SCL1 D101   W2 = SDA2 D9 / SCL2 D8",
        "UART3 D16/D17 = LIDAR   UART4 D14/D15 = IMU",
        "GPS UART2 D18/D19   AUX D44/46   MQ135 A1   GYRO W1",
        "A7 ALSO FEEDS AUDIO JACK   A8-A11 ANALOG ONLY",
        "INVERTED PIN LABEL = USED BY THIS SHIELD",
        "JP1-3 PULLUPS OPEN   JP4 RLY 5V|3V3   JP5 BUZ D72|D34",
        "JP7 LIDAR PWM GND (D10 = LCD CS)"]):
    t = text(line, 139.5, 57.0 + i * 3.0, 1.2 if i == 0 else 1.0, layer=BS)
    t.SetMirrored(True)
text("30.000 LINES OF CODE LATER...", 125.0, 90.3, 0.8, layer=BS).SetMirrored(True)

# Giga-side tall parts under the shield (from ABX00063 topology drawing, approx)
for (x0, y0, x1, y1, s) in [(116.5, 59.0, 124.5, 88.5, "GIGA J6 CAM HDR"),
                            (180.5, 56.5, 188.5, 89.5, "GIGA J5 HDR"),
                            (162.5, 67.5, 170.0, 76.5, "GIGA SPI"),
                            (162.0, 79.0, 170.5, 87.0, "GIGA JTAG"),
                            (97.0, 69.0, 112.0, 83.0, "GIGA USB-A"),
                            (98.0, 86.5, 114.0, 94.0, "GIGA AUDIO")]:
    rect(x0, y0, x1, y1, pcbnew.Cmts_User, 0.1)
    text(s, (x0 + x1) / 2, (y0 + y1) / 2, 0.8, layer=pcbnew.Cmts_User)


# title block
tb = b.GetTitleBlock()
tb.SetTitle("BLACKOUT Sensor Hub")
tb.SetRevision("1.5")
tb.SetDate("2026-09-23")
tb.SetCompany("WRO 2026 - Blackout")

path = os.path.join(OUT, PROJ + ".kicad_pcb")
b.Save(path)
# SF Pro face on the front logo (no font setter in the python API)
import re
t = open(path).read()
t = re.sub(r'(\(gr_text "BLACKOUT"\s*\(at 100\.913[^\n]*\n(?:[^\n]*\n)*?\s*\(font)', r'\1\n\t\t\t\t(face "SF Pro")', t, count=1)
open(path, "w").write(t)
print("saved", path, len(nets), "nets")
