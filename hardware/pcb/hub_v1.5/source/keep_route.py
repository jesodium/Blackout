"""keep_route.py <routed old board> <placed new board> <refs...>
Copies the old copper onto a freshly placed board so only the new/moved parts
get routed: drops what touches the listed footprints, prunes the dangling
leftovers, skips the old stitching vias (fin.py adds new ones)."""
import sys, math
import pcbnew
from pcbnew import ToMM
old = pcbnew.LoadBoard(sys.argv[1])
new = pcbnew.LoadBoard(sys.argv[2])
refs = {a for a in sys.argv[3:] if not a.startswith("net:")}
drop_nets = {a[4:] for a in sys.argv[3:] if a.startswith("net:")}   # re-route these nets whole
CL = 0.35

def xy(p):
    return (round(ToMM(p.x), 4), round(ToMM(p.y), 4))

# keep-out: pads of the new/moved parts on the new board, and their old spots
keep = []
for b in (old, new):
    for fp in b.GetFootprints():
        if fp.GetReference() in refs:
            for p in fp.Pads():
                bb = p.GetBoundingBox()
                keep.append((ToMM(bb.GetLeft()), ToMM(bb.GetTop()), ToMM(bb.GetRight()), ToMM(bb.GetBottom()),
                             p.IsOnLayer(pcbnew.F_Cu), p.IsOnLayer(pcbnew.B_Cu)))

def dseg(px, py, x0, y0, x1, y1):
    dx, dy = x1 - x0, y1 - y0
    L = dx * dx + dy * dy
    t = 0 if L == 0 else max(0, min(1, ((px - x0) * dx + (py - y0) * dy) / L))
    return math.hypot(px - (x0 + t * dx), py - (y0 + t * dy))

def hits(t):
    via = t.GetClass() == "PCB_VIA"
    w = ToMM(t.GetWidth(pcbnew.F_Cu) if via else t.GetWidth()) / 2
    (x0, y0), (x1, y1) = xy(t.GetStart()), xy(t.GetEnd())
    for (l, tp, r, bo, f, bk) in keep:
        if not via and not (f if t.GetLayer() == pcbnew.F_Cu else bk):
            continue
        # distance from the segment to the pad box, sampled
        for k in range(21):
            px, py = x0 + (x1 - x0) * k / 20, y0 + (y1 - y0) * k / 20
            dx = max(l - px, 0, px - r); dy = max(tp - py, 0, py - bo)
            if math.hypot(dx, dy) < w + CL:
                return True
    return False

pads = set()
padbox = []
for fp in new.GetFootprints():
    for p in fp.Pads():
        pads.add(xy(p.GetPosition()))
        bb = p.GetBoundingBox()
        padbox.append((ToMM(bb.GetLeft()), ToMM(bb.GetTop()), ToMM(bb.GetRight()), ToMM(bb.GetBottom()),
                       p.IsOnLayer(pcbnew.F_Cu), p.IsOnLayer(pcbnew.B_Cu), p.GetNetname()))

def on_pad(e, layer, net):
    return any(l <= e[0] <= r and tp <= e[1] <= bo and (f if layer == pcbnew.F_Cu else bk) and n == net
               for (l, tp, r, bo, f, bk, n) in padbox)

gnd_track_ends = set()
for t in old.GetTracks():
    if t.GetClass() != "PCB_VIA" and t.GetNetname() == "GND":
        gnd_track_ends |= {xy(t.GetStart()), xy(t.GetEnd())}

items = []
for t in old.GetTracks():
    if t.GetClass() == "PCB_VIA" and t.GetNetname() == "GND" and xy(t.GetPosition()) not in gnd_track_ends:
        continue   # stitching via
    if hits(t) or t.GetNetname() in drop_nets:
        continue
    items.append(t)

# prune dangling ends until stable
while True:
    ends = {}
    for t in items:
        if t.GetClass() == "PCB_VIA":
            continue
        for e in (xy(t.GetStart()), xy(t.GetEnd())):
            ends[(e, t.GetLayer())] = ends.get((e, t.GetLayer()), 0) + 1
    vias = {xy(t.GetPosition()) for t in items if t.GetClass() == "PCB_VIA"}
    keep_items = []
    for t in items:
        if t.GetClass() == "PCB_VIA":
            p = xy(t.GetPosition())
            n = ends.get((p, pcbnew.F_Cu), 0) + ends.get((p, pcbnew.B_Cu), 0)
            if n >= 2 or p in pads:
                keep_items.append(t)
            continue
        ok = True
        for e in (xy(t.GetStart()), xy(t.GetEnd())):
            if e in vias or ends[(e, t.GetLayer())] >= 2 or on_pad(e, t.GetLayer(), t.GetNetname()):
                continue
            ok = False
        if ok:
            keep_items.append(t)
    if len(keep_items) == len(items):
        break
    items = keep_items

for t in items:
    c = t.Duplicate()
    c.SetParent(new)
    n = new.FindNet(t.GetNetname())
    if n is None:   # net renamed: let the router redo it
        continue
    c.SetNet(n)
    new.Add(c)
new.Save(sys.argv[2])
print("kept", len(items), "of", len(list(old.GetTracks())))
