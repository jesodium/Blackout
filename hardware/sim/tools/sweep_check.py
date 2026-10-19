# Sweeps the MeArm through its joint ranges and reports any arm surface inside the roof-top parts
# (HW-170 box, cam pods, roof). Sim arm has no collisions, so this is the "does it hit" check.
import sys, json, numpy as np, mujoco, trimesh
HERE = __file__.rsplit('/', 2)[0]
V4 = '--v4' in sys.argv   # current rover: v4 drivetrain, body +15 mm, lidar on the roof
RAW = HERE + ('/tools/raw/' if V4 else '/tools/raw_rocker/')
m = mujoco.MjModel.from_xml_path(HERE + ('/blackout.xml' if V4 else '/blackout_rocker.xml')); d = mujoco.MjData(m)
f2m = lambda v: np.c_[-v[:, 0], v[:, 2], v[:, 1]]
def static(name):
    t = trimesh.load(RAW + name); t.vertices = f2m(t.vertices); return t
def hull(name):   # Fusion display meshes aren't watertight; these parts are boxy, so the hull is a fair stand-in
    j = json.load(open(RAW + name + '.json')); return trimesh.Trimesh(f2m(np.array(j['v']).reshape(-1, 3) * 10)).convex_hull
if V4:
    roof = trimesh.load(HERE + '/../cad/roof4h_bite_print.stl'); v = roof.vertices
    roof.vertices = f2m(np.c_[v[:, 0] - 110, 102 - v[:, 2], v[:, 1] - 81])   # print frame -> Fusion, roof top now Y 102
    OBST = {'hw170_box': hull('hw170_box_1'), 'lcd_box': hull('lcd_box_1'), 'cam_armor': hull('esp32cam_armor_1'), 'lidar': hull('rplidar_c1_1'), 'roof': roof}
else:
    OBST = {'hw170_box': static('hw170_box.stl'), 'lcd_box': static('lcd_box.stl'), 'cam_armor': static('esp32cam_armor.stl'), 'roof': static('roof4.stl')}
mimic = [(m.eq_obj1id[i], m.eq_obj2id[i], m.eq_data[i][:2]) for i in range(m.neq) if m.eq_type[i] == mujoco.mjtEq.mjEQ_JOINT and m.eq(i).name != 'diff_bar']
linked = []
for i in range(m.neq):
    if m.eq_type[i] == mujoco.mjtEq.mjEQ_TENDON:
        t = m.eq_obj1id[i]; a = m.tendon_adr[t]; n = m.tendon_num[t]
        linked.append((m.wrap_objid[a:a + n], m.wrap_prm[a:a + n], m.eq_data[i][0]))
arm_root = m.body('mearm').id
def under(b):
    while b:
        if b == arm_root: return True
        b = m.body_parentid[b]
    return False
geoms = []
for g in range(m.ngeom):
    if m.geom_type[g] == mujoco.mjtGeom.mjGEOM_MESH and m.geom_contype[g] != 2 and under(m.geom_bodyid[g]):   # skip the collision hulls, same parts twice
        mid = m.geom_dataid[g]; va, vn, fa, fn = m.mesh_vertadr[mid], m.mesh_vertnum[mid], m.mesh_faceadr[mid], m.mesh_facenum[mid]
        tm = trimesh.Trimesh(m.mesh_vert[va:va + vn] * 1000, m.mesh_face[fa:fa + fn])
        geoms.append((g, np.vstack([tm.vertices, tm.sample(400)])))
ch = m.body('chassis').id
def pose(q):
    d.qpos[:] = m.qpos0
    for n, v in zip(('joint_0', 'joint_1', 'joint_2'), q): d.qpos[m.jnt_qposadr[m.joint(n).id]] = v
    for _ in range(3):
        for j1, j2, (c0, c1) in mimic: d.qpos[m.jnt_qposadr[j1]] = c0 + c1 * d.qpos[m.jnt_qposadr[j2]]
        for js, cs, a0 in linked: d.qpos[m.jnt_qposadr[js[0]]] = a0 - sum(c * d.qpos[m.jnt_qposadr[j]] for j, c in zip(js[1:], cs[1:]))
    mujoco.mj_kinematics(m, d)
lo, hi = np.array([m.jnt_range[m.joint(n).id] for n in ('joint_0', 'joint_1', 'joint_2')]).T
hits = {}
N = (9, 13, 11) if '--fine' in sys.argv else (7, 9, 7)
for q in np.stack(np.meshgrid(*[np.linspace(a, b, k) for a, b, k in zip(lo, hi, N)]), -1).reshape(-1, 3):
    pose(q)
    R0, p0 = d.xmat[ch].reshape(3, 3), d.xpos[ch] * 1000
    for g, pts in geoms:
        R = d.geom_xmat[g].reshape(3, 3); w = (pts @ R.T + d.geom_xpos[g] * 1000 - p0) @ R0
        for k, ob in OBST.items():
            lo_, hi_ = ob.bounds
            sel = w[np.all((w > lo_) & (w < hi_), 1)]
            if len(sel) and ob.contains(sel).any():
                key = (k, m.body(m.geom_bodyid[g]).name); hits.setdefault(key, []).append(np.round(np.degrees(q)).astype(int).tolist())
print('poses', int(np.prod(N)), 'ranges deg', np.round(np.degrees(lo)), np.round(np.degrees(hi)))
for (k, b), qs in sorted(hits.items()):
    print(f'HIT {k:10s} by {b:18s} in {len(qs)} poses, e.g. base/shoulder/elbow {qs[0]} {qs[len(qs)//2]} {qs[-1]}')
print('no hits' if not hits else '')
