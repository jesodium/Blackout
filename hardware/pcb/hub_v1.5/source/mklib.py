"""Project footprint library: Giga-side headers without silk (the Giga's own
header sits under them) and M3 holes without a courtyard (the Mega/Giga
layout puts the headers inside the screw-head circle by design)."""
import os, sys
from sx import parse, dump, find, Sym
FP = os.path.expanduser("~/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints")
out = os.path.join(sys.argv[1], "Blackout.pretty")
os.makedirs(out, exist_ok=True)
jobs = [("Connector_PinHeader_2.54mm", "PinHeader_1x08_P2.54mm_Vertical", "Giga_Header_1x08_P2.54mm", "F.SilkS", "F.Fab"),
        ("Connector_PinHeader_2.54mm", "PinHeader_1x10_P2.54mm_Vertical", "Giga_Header_1x10_P2.54mm", "F.SilkS", "F.Fab"),
        ("Connector_PinHeader_2.54mm", "PinHeader_2x18_P2.54mm_Vertical", "Giga_Header_2x18_P2.54mm", "F.SilkS", "F.Fab"),
        ("MountingHole", "MountingHole_3.2mm_M3", "MountingHole_3.2mm_M3_Shield", "F.CrtYd", "Cmts.User"),
        ("Connector_PinHeader_2.54mm", "PinHeader_2x07_P2.54mm_Vertical", "Breakout_2x07_P2.54mm", "F.SilkS", "F.Fab"),
        ("Connector_PinHeader_2.54mm", "PinHeader_2x02_P2.54mm_Vertical", "Breakout_2x02_P2.54mm", "F.SilkS", "F.Fab")]
for lib, name, new, strip, to in jobs:
    t = parse(open(os.path.join(FP, lib + ".pretty", name + ".kicad_mod")).read())
    t[1] = new
    for e in t:
        if isinstance(e, list) and e and str(e[0]).startswith("fp_"):
            L = find(e, "layer")
            if L and L[1] == strip:
                L[1] = to
        if isinstance(e, list) and e and e[0] == "descr":
            e[1] = "BLACKOUT sensor hub variant (%s removed) of %s:%s. %s" % (strip, lib, name, e[1])
        if isinstance(e, list) and e and e[0] == "model":
            pass
    open(os.path.join(out, new + ".kicad_mod"), "w").write(dump(t) + "\n")
print(sorted(os.listdir(out)))
