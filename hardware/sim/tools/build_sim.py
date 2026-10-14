# Builds hardware/sim/blackout.xml (MuJoCo) from Fusion mesh dumps + MeArm URDF.
import json, glob, os, re, sys, numpy as np, trimesh, mujoco
import xml.etree.ElementTree as ET
ROCKER = '--rocker' in sys.argv   # old rocker drivetrain (raw_rocker dump) instead of the v4 swing arms
RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'raw_rocker' if ROCKER else 'raw'); OUT = os.path.expanduser('~/Documents/WRO 2026/Blackout-Explorations/hardware/sim')
MDIR = 'meshes_rocker' if ROCKER else 'meshes'; MESH = OUT + '/' + MDIR
os.makedirs(MESH, exist_ok=True)

# calibration knobs (real hardware drifts from datasheet)
SG90_TORQUE = 0.176      # N·m stall @4.8V (1.8 kgf·cm)
SG90_KP, SG90_KV = 2.0, 0.03
TT_STALL, TT_NOLOAD = 0.07, 19.0   # N·m, rad/s per TT 1:48 after L298N drop
TT_BACKDRIVE = 0.012     # N·m gearbox friction at the wheel, why a parked TT rover doesn't roll
M_CHASSIS, M_ROCKER, M_WHEEL = 0.90, 0.10, 0.04  # kg
M_TT = 0.03              # kg per TT gearmotor
V4_PLATE, V4_ARM = 0.143, 0.014   # kg printed (15% infill, 1.2mm walls) off the CAD volumes 192 / 12.2 cm³
V4_FRAMES = -0.020       # kg, side frames lost their rocker pivot bosses (2026-10-11)
V4_ARM_DAMP = 0.02       # N·m·s pivot friction, nothing else holds the arms (no springs in the v4 design)
ARM_DENSITY = 1190       # acrylic/PLA-ish
UPPER_ARM, FOREARM = 80, 100    # mm pivot to pivot, stock MeArm 80 / 81; from ARM_MOUNT the claw bottoms out ~10 cm above the floor
ARM_MOUNT = (137, 0, 75)         # mm, MeArm base_link in rover frame: on a wedge pedestal on the front armor (was roof, (68, 0, 91))
SPRING_K, SPRING_GAP = 400.0, 3.0   # N/m corner bump-stop springs, mm gap to the tyre at rest (photos IMG_3813-15)
GRIPPER_V2 = True        # gear claw + arm cam (hardware/cad/gripper_cam) instead of the stock MeArm claw
GV2_MASS = dict(housing=0.020, servo=0.009, jaw=0.008, colcam=0.032)   # kg printed (~70% solid PLA) + SG90; colcam = column pod + ESP32-CAM-MB

def fusion_to_mj(v): return np.c_[-v[:, 0], v[:, 2], v[:, 1]]   # Fusion Y-up mm -> MuJoCo Z-up mm
def load(name):
    if name.endswith('.stl'): m = trimesh.load(f'{RAW}/{name}'); m.vertices = fusion_to_mj(m.vertices); return m
    j = json.load(open(f'{RAW}/{name}.json'))
    return trimesh.Trimesh(fusion_to_mj(np.array(j['v']).reshape(-1, 3) * 10), np.array(j['i']).reshape(-1, 3))
def group(names, origin, out, faces=20000):
    m = trimesh.util.concatenate([load(n) for n in names]); m.apply_translation(-np.asarray(origin))
    if len(m.faces) > faces:
        try: m = m.simplify_quadric_decimation(face_count=faces)
        except Exception: pass
    m.export(f'{MESH}/{out}.stl'); return out

# ---- rover bodies (positions in mm, MuJoCo frame) ----
chassis = {'frames': ['side_frame_L_1', 'side_frame_R_1'],
           'shell': ['front_panel_1', 'front_armor_1', 'ultrasonic_visor_1', 'electronics_box_1', 'lower_plate_1',
                     'electronics_plate_1', *(['Pivot_cap-mk2_1', 'Pivot_cap-mk2_2', *[f'bracket_{i}.stl' for i in range(4)]] if ROCKER else ['v4_plate_1'])],
           'roof': ['roof4.stl' if ROCKER else 'roof2_1'], 'pedestal': ['arm_pedestal_1'],
           'pcb': ['giga_r1_1', 'blackout_shield_v1.4_1', 'giga_female_headers_1', 'L298N_1', 'HC-SR04_1']}
if ROCKER:   # 2026-10-13: HW-170 box on the roof, ESP32-CAM pod on the armor hood (hardware/cad/hw170_box, gripper_cam)
    chassis['shell'] += ['hw170_box.stl', 'esp32cam_armor.stl', 'lcd_box.stl']; chassis['pcb'] += ['hw170_board.stl']   # + 3.5in LCD box (hardware/cad/lcd_box)
for k, v in chassis.items(): group(v, (0, 0, 0), 'ch_' + k)
# rockers: pivot axis along MuJoCo y. rockers-mk3_1 is Fusion Z- (MuJoCo y-)
piv = {'L': (-1.0, -96.7, 17.5), 'R': (0.0, 96.7, 17.5)}
wheels = {}
if ROCKER:
    for side, rk, motors in [('L', 'rockers-mk3_1', ['TTGearmotor-demo_3', 'TTGearmotor-demo_4']),
                             ('R', 'rockers-mk3_2', ['TTGearmotor-demo_1', 'TTGearmotor-demo_2'])]:
        group([rk], piv[side], f'rocker_{side}'); group(motors, piv[side], f'tt_{side}')
for i in (1, 2, 3, 4):
    f = load(f'foam on wheel_{i}'); c = f.bounds.mean(0)
    if ROCKER: c[1] = np.sign(c[1]) * 131  # hub centre
    wheels[i] = c
    group([f'wheel_core-mk2_{i}'], c, f'core_{i}'); group([f'foam on wheel_{i}'], c, f'foam_{i}')
# v4: each arm swings about its own pivot block axis (Fusion Z = MuJoCo y); pivot = arm local origin
arms = {}
if not ROCKER:
    lim = json.load(open(f'{RAW}/v4_limits.json'))   # travel to first chassis contact from the CAD pose, tools/v4_limits.py
    for k in (1, 2, 3, 4):
        p = fusion_to_mj(np.array([lim[str(k)]['pivot']]))[0]
        w = min(wheels, key=lambda i: np.linalg.norm(wheels[i][[0, 1]] - load(f'v4_arm_{k}').bounds.mean(0)[[0, 1]]))
        tt = min((1, 2, 3, 4), key=lambda i: np.linalg.norm(load(f'TTGearmotor-demo_{i}').bounds.mean(0) - wheels[w]))
        group([f'v4_arm_{k}', f'TTGearmotor-demo_{tt}'], p, f'swing_{k}')
        arms[k] = (p, w, lim[str(k)]['up'], lim[str(k)]['down'] or 60)
# corner springs: seat under each bracket (corner_springs.py), plunger hangs to SPRING_GAP above its tyre
springs = []
for i, c in (wheels.items() if ROCKER else ()):
    sx = -92.0 if c[0] > 0 else 95.0   # Fusion X of the spring axis, front / rear
    x = -sx; top = c[2] + np.sqrt(35 ** 2 - (x - c[0]) ** 2)
    springs.append((i, np.array([x, np.sign(c[1]) * 128, 30.0]), 30.0 - top - SPRING_GAP))
ground = -min(load(f'foam on wheel_{i}').bounds[0][2] for i in wheels)

# ---- MeArm URDF -> MJCF ----
u = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mearm.urdf')).read()
u = re.sub(r'<xacro:macro.*?</xacro:macro>', '', u, flags=re.S).replace('xmlns:xacro="http://www.ros.org/wiki/xacro"', '')
root = ET.fromstring(u)
mimic = []
for j in root.findall('joint'):
    mm = j.find('mimic')
    if mm is not None:
        mimic.append((j.get('name'), mm.get('joint'), float(mm.get('multiplier', 1)), float(mm.get('offset', 0)))); j.remove(mm)
# URDF chains two coaxial mimic joints through an empty link (arm_1a, arm_1_support_1a); in MuJoCo that massless
# link spins freely in the constraint null space. Merge each pair into one joint tied to both servos by a tendon.
combo = []
J = {j.get('name'): j for j in root.findall('joint')}
M = {c: (p, mul, off) for c, p, mul, off in mimic}
for mid in ('arm_1a', 'arm_1_support_1a'):
    ja = next(j for j in J.values() if j.find('child').get('link') == mid)
    jb = next(j for j in J.values() if j.find('parent').get('link') == mid)
    jb.find('parent').set('link', ja.find('parent').get('link'))
    o = ja.find('origin'); jb.remove(jb.find('origin')); jb.append(o)
    root.remove(ja); root.remove(next(l for l in root.findall('link') if l.get('name') == mid))
    (pa, ma, oa), (pb, mb, ob) = M.pop(ja.get('name')), M.pop(jb.get('name'))
    combo.append((jb.get('name'), {pa: ma} | {pb: mb} if pa != pb else {pa: ma + mb}, oa + ob))
mimic = [(c, p, mul, off) for c, (p, mul, off) in M.items()]
for l in root.findall('link'):
    if l.get('name') == 'base_link':   # flat MeArm base plate replaced by printed pedestal
        for e in list(l):
            g = e.find('geometry/mesh')
            if g is not None and os.path.basename(g.get('filename')) in ('base.stl', 'base_top.stl'): l.remove(e)
            elif e.find('geometry/cylinder') is not None: l.remove(e)
    for c in l.findall('collision'): l.remove(c)
    if l.get('name') != 'world':
        ET.SubElement(l, 'inertial').extend([ET.Element('mass', value='0.001'),
            ET.Element('inertia', ixx='1e-8', iyy='1e-8', izz='1e-8', ixy='0', ixz='0', iyz='0')])
mj = ET.SubElement(root, 'mujoco'); ET.SubElement(mj, 'compiler', meshdir=MESH, discardvisual='false', fusestatic='false', strippath='true')
for f in glob.glob(os.path.expanduser('~/Downloads/MeArm/*.stl')): os.system(f'cp "{f}" "{MESH}/"')
spec_arm = mujoco.MjModel.from_xml_string(ET.tostring(root, encoding='unicode'))
mujoco.mj_saveLastXML('/tmp/_arm.xml', spec_arm) if False else None
tmp = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'arm_conv.xml'); mujoco.mj_saveLastXML(tmp, spec_arm)
arm = ET.parse(tmp).getroot()

# longer links (pivot to pivot). Shoulder stops at horizontal, so floor reach = shoulder height - forearm: the
# forearm does the reaching, the upper arm only pushes the hanging forearm clear of the front armor.
B = {b.get('name'): b for b in arm.iter('body')}
B['connector'].set('pos', f'{UPPER_ARM / 1000} 0 0'); B['arm_1b'].set('pos', f'{UPPER_ARM / 1000} 0 0')
B['gripper'].set('pos', f'{FOREARM / 1000} 0.001 0')
def quat_mat(q): r = np.zeros(9); mujoco.mju_quat2Mat(r, np.array(q, float)); return r.reshape(3, 3)
for body, extra in [('arm_0', UPPER_ARM - 80), ('arm_0_support', UPPER_ARM - 80), ('arm_1_support_1b', UPPER_ARM - 80),
                    ('arm_1b', FOREARM - 81), ('gripper_support', FOREARM - 81)]:
    if not extra: continue
    for g in B[body].findall('geom'):
        mn = g.get('mesh'); m_ = trimesh.load(f'{MESH}/{mn}.stl')
        v = m_.vertices @ quat_mat([float(a) for a in g.get('quat', '1 0 0 0').split()]).T + np.array(g.get('pos').split(), float) * 1000
        ax = np.linalg.svd(v[:, :2] - v[:, :2].mean(0))[2][0]; ax = np.r_[ax, 0]   # bars lie in the joint plane
        t = v @ ax
        if t.max() < -t.min(): ax, t = -ax, -t   # point away from the joint
        if t.max() - t.min() < 60: continue   # horn/hub, not a bar
        cut = t.min() + 0.6 * (t.max() - t.min())   # one cut through the straight run, holes and necks keep their shape
        v = v + np.outer(extra * (t > cut), ax)
        new = f'{mn}_{body}'; trimesh.Trimesh(v, m_.faces).export(f'{MESH}/{new}.stl')
        ET.SubElement(arm.find('asset'), 'mesh', name=new, file=f'{new}.stl', scale='0.001 0.001 0.001')
        g.set('mesh', new); g.set('pos', '0 0 0'); g.set('quat', '1 0 0 0')

# gear claw: CAD is in the Fusion rover frame at the Fusion arm pose. ICP of the stock claw plates puts the URDF
# 'gripper' body there at body = (-X - 251.0, Y - 209.07, -Z) mm (axes flip, no tilt), so map straight across.
CAD = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'cad', 'gripper_cam')
GV2_PIVOT = {'A': np.array([34.0, -5.07, -10.5]), 'B': np.array([34.0, -5.07, 13.5])}   # jaw hinges, body frame mm
def to_gripper(v): return np.c_[-v[:, 0] - 251.0, v[:, 1] - 209.07, -v[:, 2]]
def to_column(v): return np.c_[-v[:, 0] - 137.0, v[:, 2], v[:, 1] - 99.0]   # URDF 'column' body, same ICP fit (exact)
if GRIPPER_V2:
    for out, srcs, origin in [('gv2_housing', ['gripper_bottom', 'gripper_top'], 0), ('gv2_servo', ['gripper_servo_dummy'], 0),
                              ('gv2_jaw_A', ['jaw_A'], GV2_PIVOT['A']), ('gv2_jaw_B', ['jaw_B'], GV2_PIVOT['B']), ('gv2_colcam', ['esp32cam_column_pod', 'dummy3'], 0)]:
        mm_ = trimesh.util.concatenate([trimesh.load(f'{CAD}/{n}.stl') for n in srcs])
        mm_.vertices = (to_column if out == 'gv2_colcam' else to_gripper)(mm_.vertices) - origin
        mm_.export(f'{MESH}/{out}.stl')

# ---- assemble scene ----
def mesh_geom(parent, mesh, cls): ET.SubElement(parent, 'geom', type='mesh', mesh=mesh, **{'class': cls})
x = ET.Element('mujoco', model='blackout')
ET.SubElement(x, 'compiler', angle='radian', meshdir=MDIR, autolimits='true')
ET.SubElement(x, 'option', timestep='0.001', integrator='implicitfast', cone='elliptic', impratio='10')
ET.SubElement(x, 'visual').append(ET.Element('global', offwidth='1600', offheight='1000'))
d = ET.SubElement(x, 'default')
for cls, rgba in [('frames', '.70 .22 .18 1'), ('shell', '.22 .23 .25 1'), ('roof', '.17 .17 .19 1'), ('pedestal', '.30 .31 .34 1'),
                  ('pcb', '.12 .35 .55 1'), ('tt', '.85 .75 .25 1'), ('rocker', '.15 .15 .16 1'), ('core', '.25 .25 .27 1'),
                  ('foam', '.08 .08 .08 1'), ('arm', '.93 .52 .25 1')]:
    ET.SubElement(ET.SubElement(d, 'default', **{'class': cls}), 'geom', rgba=rgba, contype='0', conaffinity='0', group='2', density='0' if cls != 'arm' else str(ARM_DENSITY))
cd = ET.SubElement(d, 'default', **{'class': 'col'}); ET.SubElement(cd, 'geom', group='3', rgba='.5 .5 .5 .3', density='0', friction='0.8 0.02 0.001', conaffinity='3')
# arm hulls hit the rover's col boxes (bit 2) and nothing else: not each other (the linkage overlaps by design), not the floor/cubes (pads do that)
ad = ET.SubElement(d, 'default', **{'class': 'armcol'}); ET.SubElement(ad, 'geom', group='3', rgba='.9 .5 .2 .3', density='0', contype='2', conaffinity='0', friction='0.5 0.02 0.001',
                                                         solref='0.002 1', solimp='0.99 0.999 0.0005', solmix='1000')   # stiff: servo stalls on the part, ~1 mm sink
fd = ET.SubElement(d, 'default', **{'class': 'finger'}); ET.SubElement(fd, 'geom', group='3', rgba='.9 .6 .3 .4', friction='2.0 0.05 0.001', condim='6', solref='0.004 1', density='0')
# TPU pad skin (2 mm): soft enough to flatten onto a face the jaws meet a few degrees off, so no edge pivot
td = ET.SubElement(d, 'default', **{'class': 'pad_tpu'}); ET.SubElement(td, 'geom', group='3', rgba='.2 .8 .4 .4', friction='1.5 0.05 0.005', condim='6', solref='0.02 1', solimp='0.8 0.95 0.003', density='0')
asset = ET.SubElement(x, 'asset')
ET.SubElement(asset, 'texture', name='grid', type='2d', builtin='checker', rgb1='.32 .30 .27', rgb2='.28 .26 .24', width='512', height='512')
ET.SubElement(asset, 'material', name='grid', texture='grid', texrepeat='8 8', reflectance='0')
ET.SubElement(asset, 'texture', name='sky', type='skybox', builtin='gradient', rgb1='.45 .5 .55', rgb2='.08 .09 .1', width='512', height='512')
for f in sorted(glob.glob(MESH + '/*.stl')):
    n = os.path.basename(f)[:-4]
    if n.startswith(('ch_', 'rocker_', 'tt_', 'core_', 'foam_', 'swing_', *(['gv2_'] if GRIPPER_V2 else []))): ET.SubElement(asset, 'mesh', name=n, file=n + '.stl', scale='0.001 0.001 0.001')
for m in arm.find('asset').findall('mesh'):
    m.set('file', os.path.basename(m.get('file'))); asset.append(m)

wb = ET.SubElement(x, 'worldbody')
ET.SubElement(wb, 'light', pos='0 -1 3', dir='0 .3 -1', directional='true', castshadow='true', diffuse='.8 .8 .8')
ET.SubElement(wb, 'geom', name='floor', type='plane', size='4 4 .05', material='grid', friction='0.9 0.02 0.001')
mm2 = lambda v: ' '.join(f'{a/1000:.5f}' for a in v)
ch = ET.SubElement(wb, 'body', name='chassis', pos=f'0 0 {ground/1000 + 0.003:.4f}')
ET.SubElement(ch, 'freejoint', name='root')
ET.SubElement(ch, 'inertial', pos='0 0 0.045', mass=str(M_CHASSIS if ROCKER else M_CHASSIS + V4_PLATE + V4_FRAMES), diaginertia='0.006 0.004 0.008')
ET.SubElement(ch, 'camera', name='follow', mode='trackcom', pos='-0.55 -0.45 0.4', xyaxes='0.63 -0.77 0 0.3 0.25 0.92')
for k in chassis: mesh_geom(ch, 'ch_' + k, 'frames' if k == 'frames' else k if k in ('roof', 'pedestal', 'pcb') else 'shell')
# collision boxes (MuJoCo mm coords): body, front armor, roof, pedestal
for nm, lo, hi in [('c_body', (-112, -104, 0), (110, 104, 71)), ('c_armor', (110, -82, 0), (158, 82, 69)),
                   ('c_roof', (-112, -81, 71), (110, 81, 87)), ('c_ped', (ARM_MOUNT[0] - 27, -27, 55), (ARM_MOUNT[0] + 16, 27, ARM_MOUNT[2] + 15)),
                   *([('c_hw170', (3.3, -20.7, 87), (84, 20.7, 125.4)), ('c_campod', (107.8, 38.5, 65), (130, 80, 98.2)), ('c_lcd', (-73.9, -51.8, 87), (-12, 51.8, 101.4))] if ROCKER else []),
                   *([] if ROCKER else [('c_plate', (-100, -82.5, -10), (100, 82.5, -4)),     # v4 plate + its 2 pivot blocks
                                        ('c_blk_L', (-25, -63, -50), (25, -53, -10)), ('c_blk_R', (-25, 53, -50), (25, 63, -10))])]:
    lo, hi = np.array(lo, float), np.array(hi, float)
    ET.SubElement(ch, 'geom', name=nm, type='box', pos=mm2((lo + hi) / 2), size=mm2((hi - lo) / 2), **{'class': 'col'})
for i, seat, length in springs:
    pb = ET.SubElement(ch, 'body', name=f'spring_{i}', pos=mm2(seat))
    ET.SubElement(pb, 'joint', name=f'spring_{i}', type='slide', axis='0 0 1', range='0 0.014', stiffness=str(SPRING_K),
                  springref='0', damping='0.4')
    ET.SubElement(pb, 'geom', type='capsule', fromto=f'0 0 -0.002 0 0 {-length / 1000 + 0.004:.4f}', size='0.004', mass='0.003',
                  rgba='.75 .75 .78 1', friction='0.3 0.01 0.001', group='2')
def add_wheel(parent, i, c, origin):
    wbdy = ET.SubElement(parent, 'body', name=f'wheel_{i}', pos=mm2(c - np.asarray(origin)))
    ET.SubElement(wbdy, 'joint', name=f'wheel_{i}', axis='0 1 0', damping='0.0005', armature='2e-5', frictionloss=str(TT_BACKDRIVE))
    ET.SubElement(wbdy, 'inertial', pos='0 0 0', mass=str(M_WHEEL), diaginertia='1.5e-5 2.5e-5 1.5e-5')
    mesh_geom(wbdy, f'core_{i}', 'core'); mesh_geom(wbdy, f'foam_{i}', 'foam')
    ET.SubElement(wbdy, 'geom', name=f'tyre_{i}', type='cylinder', size='0.035 0.012', quat='0.7071 0.7071 0 0',
                  friction='1.1 0.02 0.001', condim='4', **{'class': 'col'})
for k, (p, i, up, down) in arms.items():
    ab = ET.SubElement(ch, 'body', name=f'swing_{k}', pos=mm2(p))
    # axis flipped per arm so +angle = wheel up for all four; 0 = CAD pose (20° droop)
    ET.SubElement(ab, 'joint', name=f'swing_{k}', axis='0 -1 0' if wheels[i][0] > p[0] else '0 1 0', damping=str(V4_ARM_DAMP),
                  range=f'{-np.radians(down):.3f} {np.radians(up):.3f}')
    ET.SubElement(ab, 'inertial', pos=mm2((wheels[i] - p) * 0.5), mass=str(V4_ARM + M_TT), diaginertia='2e-5 4e-5 4e-5')
    mesh_geom(ab, f'swing_{k}', 'tt')
    add_wheel(ab, i, wheels[i], p)
for side in ('LR' if ROCKER else ''):
    rb = ET.SubElement(ch, 'body', name=f'rocker_{side}', pos=mm2(piv[side]))
    ET.SubElement(rb, 'joint', name=f'rocker_{side}', axis='0 1 0', damping='0.02', range='-0.58 0.51')
    ET.SubElement(rb, 'inertial', pos='0 0 -0.02', mass=str(M_ROCKER), diaginertia='4e-4 1e-4 4e-4')
    mesh_geom(rb, f'rocker_{side}', 'rocker'); mesh_geom(rb, f'tt_{side}', 'tt')
    for i, c in wheels.items():
        if (c[1] > 0) == (side == 'R'): add_wheel(rb, i, c, piv[side])
# MeArm: URDF base_link frame in rover frame
ab = ET.SubElement(ch, 'body', name='mearm', pos=mm2(ARM_MOUNT))
for b in arm.find('worldbody'):
    ab.append(b)
for b in ab.iter('body'):
    if b.find('geom') is not None and b.find('inertial') is not None: b.remove(b.find('inertial'))
mimics = {c for c, *_ in mimic} | {c for c, *_ in combo}
for jt in ab.iter('joint'):
    if jt.get('name') in mimics: jt.attrib.pop('range', None); jt.attrib.pop('limited', None)  # URDF mimic limits contradict their own mimic maps
for g in ab.iter('geom'):
    g.set('class', 'arm'); [g.attrib.pop(k, None) for k in ('contype', 'conaffinity', 'group', 'density', 'rgba', 'material')]
if not GRIPPER_V2:
    for nm in ('gripper_left', 'gripper_right'):   # finger pads that actually touch things
        fb = next(b for b in ab.iter('body') if b.get('name') == nm)
        # flat pad over the finger's distal 2/3 (body frame measured off the mesh: x along finger, z = 3mm plate)
        ET.SubElement(fb, 'geom', type='box', pos='0.021 0 -0.0024', size='0.014 0.0105 0.0025', **{'class': 'finger'})
else:
    gb = next(b for b in ab.iter('body') if b.get('name') == 'gripper')
    for g in gb.findall('geom'): gb.remove(g)
    for nm in ('gripper_left', 'gripper_right'): gb.remove(next(b for b in gb.findall('body') if b.get('name') == nm))
    mimic = [mm for mm in mimic if mm[0] != 'joint_3_mimic']
    for k in ('housing', 'servo'):
        ET.SubElement(gb, 'geom', type='mesh', mesh=f'gv2_{k}', mass=str(GV2_MASS[k]), **{'class': 'arm'})
    cb = next(b for b in ab.iter('body') if b.get('name') == 'column')   # cam 2 turns with the base, no shoulder/elbow load
    ET.SubElement(cb, 'geom', type='mesh', mesh='gv2_colcam', mass=str(GV2_MASS['colcam']), **{'class': 'arm'})
    for side in 'AB':   # jaws geared together: B mirrors A, both open with +angle
        jb = ET.SubElement(gb, 'body', name=f'jaw_{side}', pos=mm2(GV2_PIVOT[side]))
        ET.SubElement(jb, 'joint', name=f'jaw_{side}', axis='0 1 0' if side == 'A' else '0 -1 0', range='-0.035 0.52', damping='0.002', armature='1e-5')
        ET.SubElement(jb, 'geom', type='mesh', mesh=f'gv2_jaw_{side}', mass=str(GV2_MASS['jaw']), **{'class': 'arm'})
        # ridged pad, pre-angled 0.2 rad (parallel at ~24 mm grip): mid-face 3.24 mm off the centreline when shut, 14 tall
        sg = 1 if side == 'A' else -1
        ET.SubElement(jb, 'geom', type='box', pos=mm2((43.5, 0, sg * 7.78)), size=mm2((13.8, 7, 1)), euler=f'0 {-sg * 0.2005:.4f} 0', **{'class': 'pad_tpu'})
    next(b for b in gb.findall('body') if b.get('name') == 'tool').set('pos', mm2((77.5, -5.07, 1.5)))   # between the pads
# arm vs rover: convex hull of every moving part, so the arm stops on the roof/boxes instead of phasing through.
# column + its servo link skipped, they sit on the pedestal and only yaw
for b in ab.iter('body'):
    if b.get('name') in ('column', 'arm_1_support_0'): continue
    for g in [g for g in b.findall('geom') if g.get('type') == 'mesh']:
        ET.SubElement(b, 'geom', type='mesh', mesh=g.get('mesh'), **{k: g.get(k) for k in ('pos', 'quat') if g.get(k)}, **{'class': 'armcol'})
# targets
for i, (p, rgba) in enumerate([((0.45, 0.0, 0.1701), '.36 .74 .49 1'), ((0.38, 0.2, 0.0101), '.85 .7 .3 1'), ((0.36, -0.22, 0.0101), '.3 .55 .9 1')]):
    ob = ET.SubElement(wb, 'body', name=f'artifact_{i}', pos=' '.join(map(str, p)))
    ET.SubElement(ob, 'freejoint'); ET.SubElement(ob, 'geom', type='box', size='0.01 0.01 0.01', mass='0.012', rgba=rgba, friction='1.0 0.02 0.001', condim='4')
ET.SubElement(wb, 'geom', name='plinth', type='box', pos='0.45 0.0 0.08', size='0.02 0.03 0.08', rgba='.45 .42 .38 1')
ET.SubElement(wb, 'geom', name='ramp', type='box', pos='-0.6 0 0.02', size='0.25 0.25 0.02', euler='0 0.12 0', rgba='.4 .38 .35 1')
for k, (px, py, r) in enumerate([(0.9, 0.12, 0.03), (1.0, -0.15, 0.025), (1.15, 0.05, 0.035)]):
    ET.SubElement(wb, 'geom', name=f'rock_{k}', type='ellipsoid', pos=f'{px} {py} {r*0.4}', size=f'{r*1.4} {r} {r}', rgba='.5 .47 .42 1')

# arm self-contact off, only fingers collide with world
contact = ET.SubElement(x, 'contact')
ET.SubElement(contact, 'exclude', body1='jaw_A' if GRIPPER_V2 else 'gripper_left', body2='jaw_B' if GRIPPER_V2 else 'gripper_right')
eq = ET.SubElement(x, 'equality')
# proposed roof diff bar (rockers forced opposite). Off = how the rover is built today; run.py --diffbar turns it on
if ROCKER: ET.SubElement(eq, 'joint', name='diff_bar', joint1='rocker_L', joint2='rocker_R', polycoef='0 -1 0 0 0', active='false')
if GRIPPER_V2: ET.SubElement(eq, 'joint', joint1='jaw_B', joint2='jaw_A', polycoef='0 1 0 0 0', solref='0.003 1')   # the gear mesh
for child, parent, mul, off in mimic:
    ET.SubElement(eq, 'joint', joint1=child, joint2=parent, polycoef=f'{off} {mul} 0 0 0', solref='0.002 1', solimp='0.99 0.999 0.0001')   # stiff: soft let the bars visibly drift off their pivots
tend = ET.SubElement(x, 'tendon')
for c, parents, off in combo:
    t = ET.SubElement(tend, 'fixed', name='link_' + c); ET.SubElement(t, 'joint', joint=c, coef='1')
    for p, mul in parents.items(): ET.SubElement(t, 'joint', joint=p, coef=str(-mul))
    ET.SubElement(eq, 'tendon', tendon1='link_' + c, polycoef=f'{off} 0 0 0 0', solref='0.002 1', solimp='0.99 0.999 0.0001')
act = ET.SubElement(x, 'actuator')
for side, ids in [('L', [i for i, c in wheels.items() if c[1] < 0]), ('R', [i for i, c in wheels.items() if c[1] > 0])]:
    t = ET.SubElement(tend, 'fixed', name=f'drive_{side}')
    for i in ids: ET.SubElement(t, 'joint', joint=f'wheel_{i}', coef='1')
    ET.SubElement(act, 'general', name=f'drive_{side}', tendon=f'drive_{side}', ctrlrange='-1 1', gainprm=str(TT_STALL), biastype='affine',
                  biasprm=f'0 0 {-TT_STALL / (2 * TT_NOLOAD):.5f}', forcerange=f'{-TT_STALL} {TT_STALL}')
for jn, lbl in [('joint_0', 'base'), ('joint_1', 'shoulder'), ('joint_2', 'elbow'), ('jaw_A' if GRIPPER_V2 else 'joint_3', 'claw')]:
    ET.SubElement(act, 'position', name=lbl, joint=jn, kp=str(SG90_KP), kv=str(SG90_KV), forcerange=f'{-SG90_TORQUE} {SG90_TORQUE}', inheritrange='1')
sens = ET.SubElement(x, 'sensor')
for lbl in ('base', 'shoulder', 'elbow', 'claw', 'drive_L', 'drive_R'): ET.SubElement(sens, 'actuatorfrc', name=lbl, actuator=lbl)
ET.SubElement(sens, 'framepos', name='claw_tip', objtype='body', objname='tool')
ET.indent(x)
open(OUT + ('/blackout_rocker.xml' if ROCKER else '/blackout.xml'), 'w').write(ET.tostring(x, encoding='unicode'))
print('ground', ground, 'wheels', {k: v.round(1).tolist() for k, v in wheels.items()}, 'mimic', len(mimic))
