"""fab.py <routed board> <fab dir> : gerbers + drill + zip, BOMs (full, JLCPCB, PCBWay) and the placement file.
Run with KiCad's bundled python."""
import os, sys, csv, glob, zipfile, subprocess
import pcbnew
from pcbnew import ToMM
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import design

src, out = sys.argv[1], sys.argv[2]
KC = os.path.expanduser("~/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli")
g = os.path.join(out, "gerbers")
os.makedirs(g, exist_ok=True)
for f in glob.glob(os.path.join(g, "*")):
    os.remove(f)
layers = "F.Cu,B.Cu,F.Paste,B.Paste,F.Silkscreen,B.Silkscreen,F.Mask,B.Mask,Edge.Cuts"
subprocess.run([KC, "pcb", "export", "gerbers", "-l", layers, "--subtract-soldermask", "-o", g + "/", src], check=True)
subprocess.run([KC, "pcb", "export", "drill", "--generate-map", "--map-format", "gerberx2", "-o", g + "/", src], check=True)
zp = os.path.join(out, "blackout_sensor_hub_v1.5_gerbers.zip")
with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(os.listdir(g)):
        if "drl_map" not in f:
            z.write(os.path.join(g, f), f)

b = pcbnew.LoadBoard(src)
byref = {p["ref"]: p for p in design.parts}
rows = []
for fp in b.GetFootprints():
    r = fp.GetReference()
    p = byref[r]
    if r.startswith(("H", "JP", "TP")):
        continue
    smd = all(pad.GetAttribute() == pcbnew.PAD_ATTRIB_SMD for pad in fp.Pads() if pad.GetNumber())
    pos = fp.GetPosition()
    rows.append(dict(ref=r, value=p["value"], fp=p["fp"], lcsc=(p.get("lcsc") or ("", ""))[0],
                     mpn=(p.get("lcsc") or ("", ""))[1], smd=smd,
                     x=ToMM(pos.x), y=-ToMM(pos.y), rot=fp.GetOrientationDegrees() % 360))

def key(r):
    import re
    m = re.match(r"([A-Z]+)(\d+)", r)
    return (m.group(1), int(m.group(2)))

groups = {}
for r in sorted(rows, key=lambda r: key(r["ref"])):
    groups.setdefault((r["value"], r["fp"], r["lcsc"], r["mpn"], r["smd"]), []).append(r["ref"])

with open(os.path.join(out, "bom.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["Designator", "Value", "Footprint", "LCSC", "MPN", "Qty"])
    for (v, fpn, l, m, smd), refs in groups.items():
        w.writerow([",".join(refs), v, fpn, l, m or "hand solder (through-hole header)", len(refs)])

with open(os.path.join(out, "bom_jlcpcb.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["Comment", "Designator", "Footprint", "LCSC Part #"])
    for (v, fpn, l, m, smd), refs in groups.items():
        if smd:
            w.writerow([v, ",".join(refs), fpn.split(":")[1], l])

with open(os.path.join(out, "bom_pcbway.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["Item #", "Designator", "Qty", "Manufacturer", "Mfg Part #", "Description / Value", "Package/Footprint", "Type", "Your Instructions / Notes"])
    i = 0
    for (v, fpn, l, m, smd), refs in groups.items():
        if not smd:
            continue
        i += 1
        mfr, _, part = m.partition(" ")
        w.writerow([i, ",".join(refs), len(refs), mfr, part, v, fpn.split(":")[1], "SMD", "LCSC " + l + "; equivalent OK"])

with open(os.path.join(out, "cpl_centroid.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"])
    for r in sorted(rows, key=lambda r: key(r["ref"])):
        if r["smd"]:
            w.writerow([r["ref"], "%.6fmm" % r["x"], "%.6fmm" % r["y"], "Top", "%.6f" % r["rot"]])
print("fab ok:", zp, len(rows), "parts,", sum(len(v) for k, v in groups.items() if k[4]), "SMD placements")
