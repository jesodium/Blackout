"""BLACKOUT rover + MeArm in MuJoCo.

  mjpython run.py              drive with arrow keys, arm via Control panel sliders (right side)
  mjpython run.py --demo       scripted: drive to plinth, grab artifact, lift, swing
  mjpython run.py --diffbar    same, with the proposed roof diff bar fitted (--rocker only)
  mjpython run.py --bumpstop   v4 arms held at the CAD pose (as designed they fold and jam the tyres)
  python run.py --demo --headless   no window, prints servo loads (CI / quick check)
"""
import sys, time, numpy as np, mujoco

HERE = __file__.rsplit('/', 1)[0] if '/' in __file__ else '.'
m = mujoco.MjModel.from_xml_path(f'{HERE}/blackout_rocker.xml' if '--rocker' in sys.argv else f'{HERE}/blackout.xml')
d = mujoco.MjData(m)
SG90 = m.actuator_forcerange[m.actuator('base').id][1]
ARM = ['joint_0', 'joint_1', 'joint_2']
_lo, _hi = m.jnt_range[m.actuator_trnid[m.actuator('claw').id][0]]
SHUT, OPEN = _lo, min(1.2, _hi)   # stock claw 0 / 1.2, gear claw squeezes a hair past touching
mimic = [(m.eq_obj1id[i], m.eq_obj2id[i], m.eq_data[i][:2]) for i in range(m.neq)
         if m.eq_type[i] == mujoco.mjtEq.mjEQ_JOINT and m.eq(i).name != 'diff_bar']
SUSP = [n for n in ('rocker_L', 'rocker_R', 'swing_1', 'swing_2', 'swing_3', 'swing_4') if mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, n) >= 0]
linked = []   # merged MeArm joints held by a tendon: q[first] + sum(coef * q[other]) = a0
for i in range(m.neq):
    if m.eq_type[i] == mujoco.mjtEq.mjEQ_TENDON:
        t = m.eq_obj1id[i]; a = m.tendon_adr[t]; n = m.tendon_num[t]
        linked.append((m.wrap_objid[a:a + n], m.wrap_prm[a:a + n], m.eq_data[i][0]))
def bumpstop():   # printed stop at the CAD pose: v4 arms as designed fold up onto their tyres
    for j in range(m.njnt):
        if m.joint(j).name.startswith('swing_'): m.jnt_range[j][1] = 0
if '--bumpstop' in sys.argv: bumpstop()
if '--diffbar' in sys.argv:
    d.eq_active[m.eq('diff_bar').id] = 1
scratch = mujoco.MjData(m)


def close_linkage(q):
    """put the MeArm's follower bars where the mimics/tendons want them (all-zero qpos0 starts them 90° off)"""
    for _ in range(3):
        for j1, j2, (c0, c1) in mimic: q[m.jnt_qposadr[j1]] = c0 + c1 * q[m.jnt_qposadr[j2]]
        for js, cs, a0 in linked: q[m.jnt_qposadr[js[0]]] = a0 - sum(c * q[m.jnt_qposadr[j]] for j, c in zip(js[1:], cs[1:]))
close_linkage(d.qpos)


def tip_for(q):
    """claw tip world position for arm angles q, rover frozen where it is now"""
    scratch.qpos[:] = d.qpos
    for n, v in zip(ARM, q): scratch.qpos[m.jnt_qposadr[m.joint(n).id]] = v
    close_linkage(scratch.qpos)
    mujoco.mj_kinematics(m, scratch)
    return scratch.body('tool').xpos.copy()


def ik(target):
    # IMPORTANT NOTE: coarse grid + shrinking local search, fine for 3 DOF; swap for Jacobian IK if it gets called per step
    lo, hi = np.array([m.jnt_range[m.joint(n).id] for n in ARM]).T
    best = min((np.linalg.norm(tip_for(q) - target), tuple(q)) for q in
               np.stack(np.meshgrid(*[np.linspace(a, b, 9) for a, b in zip(lo, hi)]), -1).reshape(-1, 3))
    q, step = np.array(best[1]), (hi - lo) / 8
    for _ in range(40):
        cands = [np.clip(q + s * step * e, lo, hi) for e in np.eye(3) for s in (-1, 1)]
        err, i = min((np.linalg.norm(tip_for(c) - target), i) for i, c in enumerate(cands))
        if err < np.linalg.norm(tip_for(q) - target): q = cands[i]
        else: step /= 2
    return q, np.linalg.norm(tip_for(q) - target)


def servo(name, v): d.ctrl[m.actuator(name).id] = v
def drive(l, r): servo('drive_L', l); servo('drive_R', r)
def pitch(): w, x, y, z = d.body('chassis').xquat; return np.degrees(np.arcsin(2 * (w * y - z * x)))


def demo():
    """generator: yields once per control tick (10 ms)"""
    servo('claw', OPEN)
    t0 = d.time
    while d.time - t0 < 1.0: drive(0, 0); yield 'settle'
    goal = d.body('artifact_0').xpos[0] - 0.235
    while (abs(goal - d.body('chassis').xpos[0]) > 0.004 or abs(d.qvel[0]) > 0.01) and d.time - t0 < 12:
        e = goal - d.body('chassis').xpos[0]
        u = float(np.clip(5 * e - 1.5 * d.qvel[0], -0.35, 0.35))
        if abs(e) > 0.004: u = np.sign(u) * max(abs(u), 0.3)   # below this the gearbox friction wins, same as MIN_PWM on the real L298N
        drive(u, u); yield 'drive'
    t1 = d.time
    while d.time - t1 < 1.0: drive(0, 0); yield 'stop'
    cube = d.body('artifact_0').xpos.copy()
    for label, offs, claw in [('line up', (-0.045, 0, 0.004), OPEN), ('reach in', (0.004, 0, 0.004), OPEN), ('grip', (0.004, 0, 0.004), SHUT),
                              ('lift', (0, 0, 0.05), SHUT), ('hold', (0, 0, 0.05), SHUT)]:
        q, err = ik(cube + offs)
        start = np.array([d.ctrl[m.actuator(n).id] for n in ('base', 'shoulder', 'elbow')])
        t2 = d.time
        while d.time - t2 < 1.2:
            a = min(1, (d.time - t2) / 0.8)
            for n, s, g in zip(('base', 'shoulder', 'elbow'), start, q): servo(n, s + (g - s) * a)
            servo('claw', claw if label != 'grip' else OPEN + (SHUT - OPEN) * a)
            yield f'{label} (ik err {err*1000:.0f} mm)'
    t3 = d.time
    while d.time - t3 < 2.0:
        servo('base', 0.5 * min(1, (d.time - t3) / 2.0)); yield 'swing'
    while True: yield 'done'


def hud():
    loads = '  '.join(f'{n} {abs(d.sensor(n).data[0]) / SG90 * 100:3.0f}%' for n in ('base', 'shoulder', 'elbow', 'claw'))
    susp = ' '.join(f'{n} {np.degrees(d.joint(n).qpos[0]):+.1f}°' for n in SUSP)
    return (f'SG90 load  {loads}\npitch {pitch():+.1f}°   {susp}   claw tip {d.sensor("claw_tip").data[2] * 1000:.0f} mm  '
            f'artifact {d.body("artifact_0").xpos[2] * 1000:.0f} mm')


speed = steer = 0.0
def key(k):
    global speed, steer
    if k == 265: speed = min(1, speed + 0.25)          # up
    elif k == 264: speed = max(-1, speed - 0.25)       # down
    elif k == 263: steer = max(-1, steer - 0.25)       # left
    elif k == 262: steer = min(1, steer + 0.25)        # right
    elif k == 32: speed = steer = 0.0                  # space


if __name__ == '__main__':
    script = demo() if '--demo' in sys.argv else None
    phase = ''
    if '--headless' in sys.argv:
        peak = {}
        while d.time < 25:
            if script and int(d.time * 1000) % 10 == 0: phase = next(script)
            mujoco.mj_step(m, d)
            if phase.startswith(('lift', 'hold', 'swing')):
                for n in ('base', 'shoulder', 'elbow', 'claw'):
                    peak[n] = max(peak.get(n, 0), abs(d.sensor(n).data[0]) / SG90 * 100)
            if int(d.time * 1000) % 1000 == 0: print(f"t={d.time:4.1f} {phase:28s} x={d.body('chassis').xpos[0]:.3f} {hud().splitlines()[1]} | {hud().splitlines()[0]}")
        print('peak SG90 load while carrying:', {k: f'{v:.0f}%' for k, v in peak.items()})
        print('artifact lifted' if d.body('artifact_0').xpos[2] > 0.19 else 'artifact NOT lifted')
    else:
        import mujoco.viewer
        with mujoco.viewer.launch_passive(m, d, key_callback=key) as v:
            if '--screen' in sys.argv:   # --screen 22B3HM: fill the monitor whose name contains that
                from AppKit import NSApp, NSScreen
                from PyObjCTools.AppHelper import callAfter
                want = sys.argv[sys.argv.index('--screen') + 1].lower()
                scr = next(s for s in NSScreen.screens() if want in s.localizedName().lower())
                def place():
                    for w in NSApp.windows(): w.setFrame_display_(scr.visibleFrame(), True)
                placed = False
            # orbit camera that follows the rover: mouse still rotates/zooms, Esc frees it
            v.cam.type, v.cam.trackbodyid = mujoco.mjtCamera.mjCAMERA_TRACKING, m.body('chassis').id
            v.cam.distance, v.cam.azimuth, v.cam.elevation = 0.9, 140, -22
            while v.is_running():
                t = time.time()
                if '--screen' in sys.argv and not placed and d.time > 0.5:   # window only exists once a few frames are drawn
                    callAfter(place); placed = True
                with v.lock():
                    for _ in range(10):
                        if script and int(d.time * 1000) % 10 == 0: phase = next(script)
                        elif not script and (speed or steer): drive(speed + steer, speed - steer)
                        mujoco.mj_step(m, d)
                    txt = (mujoco.mjtFontScale.mjFONTSCALE_150, mujoco.mjtGridPos.mjGRID_TOPLEFT, phase, hud())
                v.set_texts(txt)   # takes the viewer lock itself, deadlocks inside v.lock()
                v.sync()
                time.sleep(max(0, 0.01 - (time.time() - t)))
