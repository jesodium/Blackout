"""Offscreen mp4 clips of the sim.  ~/.venvs/cad/bin/python render.py [clip ...] [--still]
Clips land in renders/: drive (v4 + bump stop, forward then back), arm (parked, every joint), full (every joint + pick demo), jam (v4 as designed)."""
import sys, os, subprocess, numpy as np, mujoco
import drivetrain_test as T

HERE = os.path.dirname(os.path.abspath(__file__)); OUT = f'{HERE}/renders'; os.makedirs(OUT, exist_ok=True)
W, H, FPS = 1280, 720, 30


def clip(name, mode, script, az=135, el=-18, dist=0.9, fixed=None):
    x = T.variant('blackout.xml', mode)
    x.find('visual').find('global').set('offwidth', str(W)); x.find('visual').find('global').set('offheight', str(H))
    m, d = T.load(x)
    r = mujoco.Renderer(m, H, W)
    cam = mujoco.MjvCamera(); cam.type = mujoco.mjtCamera.mjCAMERA_TRACKING; cam.trackbodyid = m.body('chassis').id
    cam.azimuth, cam.elevation, cam.distance = az, el, dist
    if fixed: cam.type = mujoco.mjtCamera.mjCAMERA_FREE; cam.lookat[:] = fixed   # still camera so the motion reads
    if '--still' in sys.argv:
        mujoco.mj_step(m, d, 500); r.update_scene(d, cam); return __import__('PIL.Image', fromlist=['x']).fromarray(r.render()).save(f'{OUT}/{name}.png')
    ff = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                           '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', f'{OUT}/{name}.mp4'], stdin=subprocess.PIPE)
    per = round(1 / FPS / m.opt.timestep)
    for secs, ctrl in script(m):
        for _ in range(round(secs * FPS)):
            for k, v in ctrl(d.time).items(): d.ctrl[m.actuator(k).id] = v
            mujoco.mj_step(m, d, per)
            r.update_scene(d, cam); ff.stdin.write(r.render().tobytes())
    ff.stdin.close(); ff.wait(); print(name, 'done', flush=True)


still = lambda: {'drive_L': 0, 'drive_R': 0}
def drive(m):
    return [(1.5, lambda t: still()), (3.5, lambda t: {'drive_L': 1, 'drive_R': 1}), (1.0, lambda t: still()),
            (3.5, lambda t: {'drive_L': -1, 'drive_R': -1}), (1.5, lambda t: still())]


def arm(m):
    rng = {n: m.actuator_ctrlrange[m.actuator(n).id] for n in ('base', 'shoulder', 'elbow', 'claw')}
    def sweep(n, a, b, dur):
        def f(t, t0=[None]):
            if t0[0] is None: t0[0] = t
            s = min(1, (t - t0[0]) / dur); return {n: a + (b - a) * (0.5 - 0.5 * np.cos(np.pi * s)), **still()}
        return dur + 0.4, f
    lo = lambda n: rng[n][0] * 0.9; hi = lambda n: rng[n][1] * 0.9
    return [(1.0, lambda t: still()), sweep('base', 0, lo('base'), 1.5), sweep('base', lo('base'), hi('base'), 2.5), sweep('base', hi('base'), 0, 1.5),
            sweep('shoulder', 0, lo('shoulder'), 1.5), sweep('elbow', 0, hi('elbow'), 1.5), sweep('claw', 0, hi('claw'), 1.0),
            sweep('claw', hi('claw'), 0, 1.0), sweep('elbow', hi('elbow'), 0, 1.5), sweep('shoulder', lo('shoulder'), hi('shoulder'), 2.0),
            sweep('shoulder', hi('shoulder'), 0, 1.5), (1.0, lambda t: still())]


def jam(m):
    return [(2.0, lambda t: still()), (4.0, lambda t: {'drive_L': 1, 'drive_R': 1})]


def full():
    """every joint swept, then the pick demo from run.py (drive to plinth, grab, lift, swing), v4 + bump stop"""
    import run
    run.bumpstop(); m, d = run.m, run.d
    r = mujoco.Renderer(m, H, W)
    cam = mujoco.MjvCamera(); cam.type = mujoco.mjtCamera.mjCAMERA_FREE
    cam.lookat[:], cam.azimuth, cam.elevation, cam.distance = (0.22, 0, 0.16), 120, -14, 0.95
    ff = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                           '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', f'{OUT}/arm_full_v4.mp4'], stdin=subprocess.PIPE)
    per = round(1 / FPS / m.opt.timestep)
    def frame(): r.update_scene(d, cam); ff.stdin.write(r.render().tobytes())
    for secs, ctrl in arm(m):
        for _ in range(round(secs * FPS)):
            for k, v in ctrl(d.time).items(): d.ctrl[m.actuator(k).id] = v
            mujoco.mj_step(m, d, per); frame()
    demo, phase, k = run.demo(), '', 0
    while phase != 'done' or k < 60:
        for i in range(per):
            if int(d.time * 1000) % 10 == 0: phase = next(demo)
            mujoco.mj_step(m, d)
        k += phase == 'done'; frame()
    ff.stdin.close(); ff.wait(); print('arm_full_v4 done', flush=True)


CLIPS = {'drive': lambda: clip('drive_v4_bumpstop', 'stop', drive, az=95, el=-8, dist=1.5, fixed=(0.75, 0, 0.16)),
         'arm': lambda: clip('arm_v4', 'stop', arm, az=150, el=-20, dist=1.0),
         'full': full,
         'jam': lambda: clip('jam_v4_as_designed', 'free', jam, az=90, el=-5, dist=0.6)}
if __name__ == '__main__':
    for c in [a for a in sys.argv[1:] if a in CLIPS] or CLIPS: CLIPS[c]()
