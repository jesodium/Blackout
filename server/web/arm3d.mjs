// The dash's 3D arm: arm.glb (the MuJoCo MeArm, tools/export_arm_glb.py) posed from
// servo degrees. Renders on demand only — dash.js calls draw() while something moves.
import { AmbientLight, DirectionalLight, GridHelper, Group, HemisphereLight, Mesh, MeshStandardMaterial,
  PerspectiveCamera, PlaneGeometry, Quaternion, Scene, ShadowMaterial, Vector3, WebGLRenderer } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { armJoints } from "../public/js/armsim.mjs";

// rest quaternion * joint rotation, per body node. Rest is stashed on first use.
const tmp = new Quaternion(), ax = new Vector3();
export function poseArm(root, joints) {
  for (const [name, [axis, a]] of Object.entries(joints)) {
    const n = root.getObjectByName(name);
    if (!n) continue;
    n.userData.rest ??= n.quaternion.clone();
    n.quaternion.copy(n.userData.rest).multiply(tmp.setFromAxisAngle(ax.fromArray(axis), a));
  }
}

// the arm sits on the rover, not the floor: lowered, the gripper reaches ~3 cm below its base
const FLOOR = -0.06;

export function arm3d(canvas) {
  const gl = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  gl.setPixelRatio(devicePixelRatio);
  gl.shadowMap.enabled = true;
  const scene = new Scene();
  const cam = new PerspectiveCamera(35, 4 / 3, 0.01, 10);
  cam.position.set(0.42, 0.26, 0.48);
  const ctl = new OrbitControls(cam, canvas);
  ctl.target.set(0.09, 0.06, 0);
  ctl.enablePan = false;
  ctl.enableZoom = false;   // the wheel scrolls the dash, not the arm
  ctl.minPolarAngle = 0.15; ctl.maxPolarAngle = 1.5;
  ctl.update(); ctl.saveState();

  const hemi = new HemisphereLight(0xffffff, 0x444444, 1.6);
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(0.3, 0.8, 0.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -0.3, right: 0.3, top: 0.3, bottom: -0.3, near: 0.1, far: 2 });
  scene.add(hemi, sun, new AmbientLight(0xffffff, 0.2));
  const floor = new Mesh(new PlaneGeometry(2, 2), new ShadowMaterial({ opacity: 0.35 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR;
  floor.receiveShadow = true;
  let grid = null;
  scene.add(floor);

  const body = new MeshStandardMaterial({ roughness: 0.6, metalness: 0.05 });
  const jaws = new MeshStandardMaterial({ roughness: 0.5 });
  const ghostMat = new MeshStandardMaterial({ transparent: true, opacity: 0.22, depthWrite: false });
  let arm = null, ghost = null, ready = null;
  const zUp = (o) => { const g = new Group(); g.rotation.x = -Math.PI / 2; g.add(o); return g; };   // MuJoCo is Z-up

  ready = new GLTFLoader().loadAsync("models/arm.glb").then((gltf) => {
    arm = gltf.scene;
    ghost = arm.clone();
    arm.traverse((o) => { if (o.isMesh) { o.geometry.computeVertexNormals();   // trimesh exports none: unlit = black
      o.material = /^jaw_/.test(o.parent?.name) || /^jaw_/.test(o.name) ? jaws : body; o.castShadow = true; } });
    ghost.traverse((o) => { if (o.isMesh) o.material = ghostMat; });
    scene.add(zUp(arm), zUp(ghost));
  });

  let theme = "";
  const colors = () => {
    const css = getComputedStyle(document.documentElement), v = (k) => css.getPropertyValue(k).trim();
    const key = v("--ink") + v("--line");
    if (key === theme) return v;
    theme = key;
    if (grid) scene.remove(grid);
    grid = new GridHelper(0.6, 15, v("--line"), v("--line"));
    grid.position.y = FLOOR;
    scene.add(grid);
    return v;
  };

  const size = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return false;
    if (canvas.width !== Math.round(w * devicePixelRatio) || canvas.height !== Math.round(h * devicePixelRatio)) {
      gl.setSize(w, h, false);
      cam.aspect = w / h; cam.updateProjectionMatrix();
    }
    return true;
  };

  // deg: drawn angles; goal: where a glide is headed (null = none); dead: unpowered; limp: gripper unpowered
  let last = null;
  const draw = (deg = last?.deg, goal = last?.goal, dead = last?.dead, gripLimp = last?.gripLimp) => {
    last = { deg, goal, dead, gripLimp };
    if (!arm || !deg || !size()) return;
    const v = colors();
    body.color.set(dead ? v("--ink-2") : v("--ink"));
    jaws.color.set(gripLimp || dead ? v("--ink-2") : v("--go"));
    ghostMat.color.set(v("--warn"));
    poseArm(arm, armJoints(deg));
    ghost.visible = !!goal;
    if (goal) poseArm(ghost, armJoints(goal));
    gl.render(scene, cam);
  };
  ctl.addEventListener("change", () => draw());
  canvas.addEventListener("dblclick", () => { ctl.reset(); draw(); });
  ready.then(() => draw()).catch((e) => console.error("arm.glb", e));
  return { draw };
}
