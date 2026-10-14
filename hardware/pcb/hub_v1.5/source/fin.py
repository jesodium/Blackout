import pcbnew, sys, math
from pcbnew import FromMM, ToMM, VECTOR2I
b = pcbnew.LoadBoard(sys.argv[1])
print("ses", pcbnew.ImportSpecctraSES(b, sys.argv[2]))
# routed with 0.22 mm clearance (margin for Freerouting's rounded-pad approximation);
# the rule the board is checked against is JLC's 0.2 mm
ns = b.GetDesignSettings().m_NetSettings
ns.GetDefaultNetclass().SetClearance(FromMM(0.2))
for name in ("Power5V", "Power3V3"):
    ns.GetNetclasses()[name].SetClearance(FromMM(0.2))
gnd = b.FindNet("GND")
FromMM_ = FromMM
# ---- GND pours, both layers (exported to the router as planes)
for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
    z = pcbnew.ZONE(b)
    z.SetLayer(layer)
    z.SetNet(gnd)
    ol = z.Outline()
    ol.NewOutline()
    for (x, y) in [(100, 46.66), (201.6, 46.66), (201.6, 100), (100, 100)]:
        ol.Append(FromMM(x), FromMM(y))
    z.SetLocalClearance(FromMM(0.3))
    z.SetMinThickness(FromMM(0.25))
    z.SetThermalReliefGap(FromMM(0.3))
    z.SetThermalReliefSpokeWidth(FromMM(0.4))
    z.SetPadConnection(pcbnew.ZONE_CONNECTION_THT_THERMAL)
    z.SetAssignedPriority(0)
    z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
    b.Add(z)



# ---- obstacles for stitching vias
segs, circles, boxes, placed_gnd = [], [], [], []
for t in b.GetTracks():
    if t.GetNetCode() == gnd.GetNetCode():
        if t.GetClass() == "PCB_VIA":
            placed_gnd.append((ToMM(t.GetPosition().x), ToMM(t.GetPosition().y)))
        continue
    if t.GetClass() == "PCB_VIA":
        circles.append((ToMM(t.GetPosition().x), ToMM(t.GetPosition().y), ToMM(t.GetWidth(pcbnew.F_Cu)) / 2))
    else:
        s, e = t.GetStart(), t.GetEnd()
        segs.append((ToMM(s.x), ToMM(s.y), ToMM(e.x), ToMM(e.y), ToMM(t.GetWidth()) / 2))
for fp in b.GetFootprints():
    for p in fp.Pads():
        bb = p.GetBoundingBox()
        boxes.append((ToMM(bb.GetLeft()), ToMM(bb.GetTop()), ToMM(bb.GetRight()), ToMM(bb.GetBottom()),
                      p.GetNetCode() == gnd.GetNetCode() and p.GetAttribute() != pcbnew.PAD_ATTRIB_NPTH))

def dseg(px, py, x0, y0, x1, y1):
    dx, dy = x1 - x0, y1 - y0
    L = dx * dx + dy * dy
    t = 0 if L == 0 else max(0, min(1, ((px - x0) * dx + (py - y0) * dy) / L))
    return math.hypot(px - (x0 + t * dx), py - (y0 + t * dy))

VR = 0.3; CL = 0.25
def ok(x, y):
    # board: rect 100..199.06 (top-right notch region) / 201.6, 46.66..100
    if not (100.9 < x < 198.2 and 47.5 < y < 99.2):
        return False
    if x - y > 149.86 - 1.3:   # top-right chamfer
        return False
    for (x0, y0, x1, y1, w) in segs:
        if dseg(x, y, x0, y0, x1, y1) < w + VR + CL:
            return False
    for (cx, cy, r) in circles:
        if math.hypot(x - cx, y - cy) < r + VR + CL:
            return False
    for (x0, y0, x1, y1, same) in boxes:
        m = VR + (0.05 if same else CL + 0.1)
        if x0 - m < x < x1 + m and y0 - m < y < y1 + m:
            return False
    for (gx, gy) in placed_gnd:
        if math.hypot(x - gx, y - gy) < 1.3:
            return False
    for (hx, hy) in [(115.24, 49.2), (113.97, 97.46), (166.04, 64.44), (166.04, 92.38), (190.17, 49.2), (196.52, 97.46)]:
        if math.hypot(x - hx, y - hy) < 3.3:
            return False
    return True

n = 0
placed = []
step = 2.2
y = 47.8
while y < 99.2:
    x = 101.0
    while x < 198.2:
        if ok(x, y) and all(math.hypot(x - a, y - c) > 1.9 for a, c in placed):
            v = pcbnew.PCB_VIA(b)
            v.SetPosition(VECTOR2I(FromMM(x), FromMM(y)))
            v.SetWidth(FromMM(0.6)); v.SetDrill(FromMM(0.3))
            v.SetNet(gnd)
            b.Add(v); placed.append((x, y)); n += 1
            circles.append((x, y, VR))
        x += step
    y += step
print("stitch vias", n)
# fan-out: every GND SMD pad gets its own via so no pour fragment is orphaned
def ok_near(x, y, own):
    if not (100.9 < x < 198.2 and 47.5 < y < 99.2) or x - y > 149.86 - 1.3:
        return False
    for (x0, y0, x1, y1, w) in segs:
        if dseg(x, y, x0, y0, x1, y1) < w + VR + CL:
            return False
    for (cx, cy, r) in circles:
        if math.hypot(x - cx, y - cy) < r + VR + CL:
            return False
    for bx in boxes:
        x0, y0, x1, y1, same = bx
        if bx is own:
            continue
        m = VR + (0.05 if same else CL + 0.1)
        if x0 - m < x < x1 + m and y0 - m < y < y1 + m:
            return False
    return True
def stub_ok(cx, cy, x, y, own):
    for k in range(11):
        px, py = cx + (x - cx) * k / 10, cy + (y - cy) * k / 10
        for (x0, y0, x1, y1, w) in segs:
            if dseg(px, py, x0, y0, x1, y1) < w + 0.15 + CL:
                return False
        for bx in boxes:
            if bx is own or bx[4]:
                continue
            m = 0.15 + CL
            if bx[0] - m < px < bx[2] + m and bx[1] - m < py < bx[3] + m:
                return False
    return True
fan = 0
for fp in ([] if "--fanout" not in sys.argv else b.GetFootprints()):
    for p in fp.Pads():
        if p.GetNetCode() != gnd.GetNetCode() or p.GetAttribute() != pcbnew.PAD_ATTRIB_SMD:
            continue
        bb = p.GetBoundingBox()
        x0, y0, x1, y1 = ToMM(bb.GetLeft()), ToMM(bb.GetTop()), ToMM(bb.GetRight()), ToMM(bb.GetBottom())
        own = next(bx for bx in boxes if abs(bx[0] - x0) < 1e-6 and abs(bx[1] - y0) < 1e-6 and abs(bx[2] - x1) < 1e-6)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        cands = []
        for d in (0.35, 0.6, 0.9, 1.2):
            cands += [(cx, y0 - d), (cx, y1 + d), (x0 - d, cy), (x1 + d, cy),
                      (x0 - d, y0 - d), (x1 + d, y0 - d), (x0 - d, y1 + d), (x1 + d, y1 + d)]
        for (x, y) in cands:
            if ok_near(x, y, own) and stub_ok(cx, cy, x, y, own):
                v = pcbnew.PCB_VIA(b)
                v.SetPosition(VECTOR2I(FromMM(x), FromMM(y)))
                v.SetWidth(FromMM(0.6)); v.SetDrill(FromMM(0.3)); v.SetNet(gnd)
                b.Add(v); placed.append((x, y)); circles.append((x, y, VR)); fan += 1
                # short stub pad->via on F.Cu so the pad never depends on the pour alone
                t = pcbnew.PCB_TRACK(b)
                t.SetStart(VECTOR2I(FromMM(cx), FromMM(cy))); t.SetEnd(VECTOR2I(FromMM(x), FromMM(y)))
                t.SetWidth(FromMM(0.3)); t.SetLayer(pcbnew.F_Cu); t.SetNet(gnd); b.Add(t)
                break
        else:
            print("no fanout for", fp.GetReference(), p.GetNumber())
print("fanout vias", fan)
f = pcbnew.ZONE_FILLER(b); f.Fill(b.Zones())
b.Save(sys.argv[3]); print("saved")
