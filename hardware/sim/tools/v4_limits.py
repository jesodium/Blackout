# arm travel before arm/motor/wheel hits chassis, Fusion coords (mm, Y up). python v4_limits.py <raw dir> <xf.json from Fusion> <out.json>
import json, glob, os, sys, numpy as np, trimesh
RAW = sys.argv[1]
def load(n):
    j = json.load(open(f'{RAW}/{n}.json')); return trimesh.Trimesh(np.array(j['v']).reshape(-1, 3) * 10, np.array(j['i']).reshape(-1, 3), process=False)
moving = ('v4_arm', 'TTGear', 'foam on', 'wheel_core')
fixed = [os.path.basename(f)[:-5] for f in glob.glob(RAW + '/*.json')
         if not os.path.basename(f).startswith(moving + ('mearm', 'rockers', 'Pivot_cap', 'corner_springs'))]
fixed = [f for f in fixed if f in ('side_frame_L_1','side_frame_R_1','front_panel_1','front_armor_1','electronics_box_1','lower_plate_1','v4_plate_1','ultrasonic_visor_1','HC-SR04_1')]
ch = trimesh.util.concatenate([load(f) for f in fixed])
P = 1.0
vox = set(map(tuple, np.floor(trimesh.sample.sample_surface_even(ch, 400000)[0] / P).astype(int)))
arms = {k: load(f'v4_arm_{k}') for k in (1, 2, 3, 4)}
parts = [load(f'TTGearmotor-demo_{i}') for i in (1, 2, 3, 4)] + [load(f'foam on wheel_{i}') for i in (1, 2, 3, 4)] + [load(f'wheel_core-mk2_{i}') for i in (1, 2, 3, 4)]
xf = json.load(open(sys.argv[2]))
res = {}
for k, a in arms.items():
    T = np.array(xf[f'v4_arm:{k}']).reshape(4, 4); piv = T[:3, 3] * 10
    grp = [a] + [p for p in parts if np.linalg.norm(p.bounds.mean(0)[[0, 2]] - a.bounds.mean(0)[[0, 2]]) < 75]
    pts = np.vstack([trimesh.sample.sample_surface_even(g, 30000)[0] for g in grp])
    pts = pts[np.linalg.norm(pts[:, :2] - piv[:2], axis=1) > 20]
    wheel = [p for p in grp if p.vertices.shape[0] < 400][0].bounds.mean(0)
    out = np.sign(wheel[0] - piv[0])   # wheel outboard side
    lim = {}
    for sgn in (1, -1):   # +1 = wheel up
        for deg in np.arange(0, 90, 0.5):
            th = np.radians(deg) * sgn * out   # CCW about +Z raises a +X wheel
            c, s = np.cos(th), np.sin(th); r = pts.copy() - piv
            r[:, 0], r[:, 1] = c * (pts[:, 0] - piv[0]) - s * (pts[:, 1] - piv[1]), s * (pts[:, 0] - piv[0]) + c * (pts[:, 1] - piv[1])
            q = np.floor((r + piv) / P).astype(int)
            hit = [tuple(v) for v in q if tuple(v) in vox]
            if deg > 0 and len(hit) > 3:
                lim[sgn] = deg; print(k, sgn, deg, np.unique(np.array(hit)[:, :], axis=0)[::max(1, len(hit)//6)][:6]); break
        else: lim[sgn] = None
    res[k] = dict(pivot=piv.round(1).tolist(), wheel=wheel.round(1).tolist(), up=lim[1], down=lim[-1])
    print(k, res[k], 'hit e.g.', np.array(hit[:3]) * P)
json.dump(res, open(sys.argv[3], 'w'))
