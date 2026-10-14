"""Headless drivetrain test: v4 swing arms vs old rockers.  ~/.venvs/cad/bin/python drivetrain_test.py
Each variant runs: settle, flat drive, step climb, ramp climb, pivot turn, rock field."""
import sys, numpy as np, mujoco
import xml.etree.ElementTree as ET

HERE = __file__.rsplit('/', 1)[0] if '/' in __file__ else '.'
ARM_K = 3.0   # N·m/rad per arm for the "springs" variant (~5° sag under 1/4 of the rover)


def variant(xml, mode):
    x = ET.parse(f'{HERE}/{xml}').getroot()
    wb = x.find('worldbody')
    for e in list(wb):   # demo props out, tests add their own
        if e.get('name', '').startswith(('plinth', 'ramp', 'rock_', 'artifact')): wb.remove(e)
    for j in x.iter('joint'):
        if not j.get('name', '').startswith('swing_'): continue
        lo, hi = map(float, j.get('range').split())
        if mode == 'stop': j.set('range', f'{lo} 0')                          # printed bump stop at the CAD pose
        if mode == 'springs': j.set('stiffness', str(ARM_K)); j.set('springref', '-0.1')
        if mode == 'locked': j.set('range', '-0.001 0.001')
    return x


def load(x, extra=''):
    s = ET.tostring(x, encoding='unicode').replace('</worldbody>', extra + '</worldbody>', 1)
    m = mujoco.MjModel.from_xml_string(s.replace('meshdir="', f'meshdir="{HERE}/'))
    return m, mujoco.MjData(m)


def ids(m, pre): return {i for i in range(m.ngeom) if (m.geom(i).name or '').startswith(pre)}


def run(m, d, secs, l, r, every=None):
    n = int(secs / m.opt.timestep)
    for k in range(n):
        d.ctrl[m.actuator('drive_L').id], d.ctrl[m.actuator('drive_R').id] = l, r
        mujoco.mj_step(m, d)
        if every and k % 10 == 0: every()


def rub(m, d):
    """normal force (N) of tyres pressing on the chassis itself"""
    ty, ch = ids(m, 'tyre_'), ids(m, 'c_')
    f, tot = np.zeros(6), 0.0
    for i in range(d.ncon):
        c = d.contact[i]
        if {c.geom1, c.geom2} & ty and {c.geom1, c.geom2} & ch:
            mujoco.mj_contactForce(m, d, i, f); tot += abs(f[0])
    return tot


def bottomed(m, d):
    ch, ty = ids(m, 'c_'), ids(m, 'tyre_')
    return any((c.geom1 in ch) != (c.geom2 in ch) and not ({c.geom1, c.geom2} & ty) for c in d.contact[:d.ncon])


def at_stop(m, d):
    js = [j for j in range(m.njnt) if (m.joint(j).name or '').startswith(('swing_', 'rocker_'))]
    return sum(abs(d.qpos[m.jnt_qposadr[j]] - m.jnt_range[j][1]) < 0.01 or abs(d.qpos[m.jnt_qposadr[j]] - m.jnt_range[j][0]) < 0.01 for j in js)


def pitch(d, m):
    w, x, y, z = d.body('chassis').xquat; return np.degrees(np.arcsin(2 * (w * y - z * x)))


def settle(x):
    m, d = load(x); run(m, d, 3, 0, 0)
    low = min(d.geom_xpos[g][2] - m.geom_size[g][2] for g in ids(m, 'c_'))
    mass = sum(m.body_mass[b] for b in range(m.nbody) if m.body_rootid[b] == m.body('chassis').id)
    return dict(mass_kg=round(mass, 2), clearance_mm=round(low * 1000), pitch=round(pitch(d, m), 1),
                arms_on_stop=at_stop(m, d), tyre_rub_N=round(rub(m, d), 1))


def flat(x):
    m, d = load(x); run(m, d, 1, 0, 0); x0 = d.body('chassis').xpos[0]
    run(m, d, 3, 1, 1)
    return round((d.body('chassis').xpos[0] - x0) / 3 * 100, 1)   # cm/s


def step(x):
    best = 0
    for h in range(5, 80, 5):
        m, d = load(x, f'<geom name="step" type="box" pos="{0.30 + 0.5} 0 {h / 2000}" size="0.5 0.4 {h / 2000}"/>')
        run(m, d, 1, 0, 0); run(m, d, 8, 1, 1)
        if d.body('chassis').xpos[0] > 0.45 and d.body('chassis').xpos[2] > h / 1000 + 0.04: best = h
        else: break
    return best


def ramp(x):
    best = 0
    for a in range(5, 45, 5):
        r, L, t = np.radians(a), 1.2, 0.01
        c = np.array([0.25, 0, 0]) - np.array([-L / 2 * np.cos(r) - t * np.sin(r), 0, -L / 2 * np.sin(r) + t * np.cos(r)])
        m, d = load(x, f'<geom name="ramp" type="box" pos="{c[0]} 0 {c[2]}" size="{L / 2} 0.4 {t}" euler="0 {-r} 0" friction="0.9 0.02 0.001"/>')
        run(m, d, 1, 0, 0); run(m, d, 10, 1, 1)
        if d.body('chassis').xpos[0] > 0.25 + 0.35 * np.cos(r): best = a
        else: break
    return best


def turn(x):
    m, d = load(x); run(m, d, 1, 0, 0)
    yaw = lambda: np.degrees(np.arctan2(*d.body('chassis').xmat.reshape(3, 3)[[1, 0], 0]))
    tot, prev = 0.0, yaw()
    for _ in range(30):
        run(m, d, 0.1, 1, -1); y = yaw(); tot += (y - prev + 180) % 360 - 180; prev = y
    return round(abs(tot) / 3)   # deg/s


def rocks(x):
    rng = np.random.default_rng(1)
    g = ''.join(f'<geom name="rk{i}" type="ellipsoid" pos="{px:.3f} {py:.3f} 0" size="{r * 1.4:.3f} {r:.3f} {r * .8:.3f}" rgba=".5 .47 .42 1"/>'
                for i, (px, py, r) in enumerate(zip(rng.uniform(0.3, 1.3, 30), rng.uniform(-0.2, 0.2, 30), rng.uniform(0.012, 0.03, 30))))
    m, d = load(x, g); run(m, d, 1, 0, 0)
    hits, worst = [0], [0.0]
    def mon():
        hits[0] += bottomed(m, d); worst[0] = max(worst[0], abs(pitch(d, m)))
    run(m, d, 8, 1, 1, mon)
    return dict(dist_cm=round(d.body('chassis').xpos[0] * 100), belly_hits_ms=hits[0] * 10, max_pitch=round(worst[0]))


if __name__ == '__main__':
    variants = [('v4 as designed (free arms)', 'blackout.xml', 'free'), ('v4 + bump stop at CAD pose', 'blackout.xml', 'stop'),
                ('v4 + arm springs', 'blackout.xml', 'springs'), ('v4 arms locked rigid', 'blackout.xml', 'locked'),
                ('old rockers + corner springs', 'blackout_rocker.xml', 'free')]
    if len(sys.argv) > 1: variants = [v for v in variants if sys.argv[1] in v[0]]
    for name, xml, mode in variants:
        x = variant(xml, mode)
        print(f'\n== {name}\n settle {settle(x)}\n flat {flat(x)} cm/s | step {step(x)} mm | ramp {ramp(x)}° | pivot turn {turn(x)}°/s'
              f'\n rocks {rocks(x)}', flush=True)
