# corner bump-stop springs (as built on the real rover, photos IMG_3813-15). Fusion coords mm, Y up.
from build123d import *
import json, numpy as np, trimesh
T = '/Users/jesus/Documents/WRO 2026/Blackout-Explorations/hardware/sim/tools/raw/'
def load(n):
    j = json.load(open(T + n + '.json')); return trimesh.Trimesh(np.array(j['v']).reshape(-1, 3) * 10, np.array(j['i']).reshape(-1, 3))
GAP, ZS, SEAT = 3.0, 128.0, 30.0
corners = []
for n, c in [('foam on wheel_1', -92), ('foam on wheel_4', 95), ('foam on wheel_3', -92), ('foam on wheel_2', 95)]:
    f = load(n); v = f.vertices; s = np.sign(v[:, 2].mean())
    cx, cy = f.bounds.mean(0)[:2]; r = (f.bounds[1][1] - f.bounds[0][1]) / 2
    top = cy + np.sqrt(r ** 2 - (c - cx) ** 2)
    corners.append((c, s, top + GAP))
def bz(Y, Z): return (-Z, Y)   # build y = -Fusion Z, build z = Fusion Y
brackets, springs = [], []
for c, s, yb in corners:
    zin, zout = 79.6, ZS + 5
    with BuildPart() as b:
        with Locations((c, *bz(31, s * (zin + 1.5)))): Box(14, 3, 26)
        with Locations((c, *bz(39, s * (zin + zout) / 2))): Box(12, zout - zin, 6)
        with Locations((c, *bz(36, s * ZS))): Cylinder(6, 12)
        with Locations((c, *bz(36, s * ZS))): Cylinder(1.6, 14, mode=Mode.SUBTRACT)
        with Locations((c, *bz(24, s * (zin + 1.5)))): Cylinder(1.6, 10, rotation=(90, 0, 0), mode=Mode.SUBTRACT)
    brackets.append(b.part)
    L = SEAT - yb
    h = Helix(pitch=L / round(L / 3), height=L, radius=4, center=(c, -s * ZS, yb))
    springs.append(sweep(Plane(h @ 0, z_dir=h % 0) * Circle(0.45), path=h))
    print('corner', c, s, 'spring', round(yb, 1), '->', SEAT, 'len', round(L, 1))
asm = Compound(children=[*(p.rotate(Axis.X, -90) for p in brackets), *(p.rotate(Axis.X, -90) for p in springs)])
export_step(asm, 'corner_springs.step')
for i, p in enumerate(brackets): export_stl(p.rotate(Axis.X, -90), f'bracket_{i}.stl')
for i, p in enumerate(springs): export_stl(p.rotate(Axis.X, -90), f'spring_{i}.stl')
