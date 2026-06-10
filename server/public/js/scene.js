// Imperative three.js rover scene, wrapped for React.
// Uses global THREE / THREE.GLTFLoader loaded via <script> in index.html.
// createRoverScene(canvas, { onLog }) -> { setData, setCamera, dispose }

const ACCENT = 0x778da9;
const ACCENT_DARK = 0x415a77;
const GRID2 = 0x1b263b;
const RED = 0xff5c4d;

export function createRoverScene(canvas, { onLog = () => {} } = {}) {
  const THREE = window.THREE;
  let width = canvas.parentElement?.clientWidth || 600;
  const height = 395;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1622);
  scene.fog = new THREE.Fog(0x0a1622, 7, 14);

  const cam = { x: 3.2, y: 2.4, z: 4.8, tx: 3.2, ty: 2.4, tz: 4.8 };
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 30);
  camera.position.set(cam.x, cam.y, cam.z);
  camera.lookAt(0, 0.2, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene.add(new THREE.AmbientLight(0xcdd8e6, 0.75));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(4, 8, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 15; key.shadow.bias = -0.001;
  scene.add(key);
  const rim = new THREE.DirectionalLight(ACCENT, 0.55);
  rim.position.set(-5, 2, -4);
  scene.add(rim);

  // Drifting dust motes
  const N = 60;
  const dustGeo = new THREE.BufferGeometry();
  const dustPos = new Float32Array(N * 3);
  for (let i = 0; i < N * 3; i += 3) {
    dustPos[i] = (Math.random() - 0.5) * 14;
    dustPos[i + 1] = Math.random() * 4.5;
    dustPos[i + 2] = (Math.random() - 0.5) * 14;
  }
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: ACCENT, size: 0.035, transparent: true, opacity: 0.35 }));
  scene.add(dust);

  scene.add(new THREE.GridHelper(10, 20, ACCENT_DARK, GRID2));

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.MeshStandardMaterial({ color: 0x0f1c2b, roughness: 0.95 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  for (let i = 1; i <= 4; i++) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(i - 0.03, i + 0.03, 48),
      new THREE.MeshStandardMaterial({ color: ACCENT_DARK, transparent: true, opacity: 0.14, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.02, 0.5);
    scene.add(ring);
  }

  // Obstacle marker
  const wallMat = new THREE.MeshStandardMaterial({
    color: RED, transparent: true, opacity: 0.25, roughness: 0.1, metalness: 0.9,
    emissive: RED, emissiveIntensity: 0.3,
  });
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.1, 0.06), wallMat);
  wall.position.set(0, 0.55, 3);
  wall.visible = false;
  wall.add(new THREE.LineSegments(new THREE.EdgesGeometry(wall.geometry), new THREE.LineBasicMaterial({ color: RED })));
  scene.add(wall);

  const presets = {
    isometric: { x: 3.2, y: 2.4, z: 4.8 },
    front: { x: 0, y: 0.7, z: 3.4 },
    top: { x: 0.01, y: 6.2, z: 0.01 },
    side: { x: 4.4, y: 0.6, z: 0 },
  };

  const state = {
    roll: 0, pitch: 0, yaw: 0, tRoll: 0, tPitch: 0, tYaw: 0,
    dist: 0, tDist: 0, lastDist: 0, hasData: false, ping: false, pingT: 0, rover: null,
  };
  const SENSOR_Z = 0.55;
  let compassEl = null;

  const loader = new THREE.GLTFLoader();
  loader.load(
    "models/rover.glb",
    (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const scale = 0.9 / Math.max(size.x, size.z);
      const group = new THREE.Group();
      group.rotation.y = Math.PI / 2;
      model.scale.setScalar(scale);
      model.position.sub(center.clone().multiplyScalar(scale));
      model.position.y += 0.28;
      const mat = new THREE.MeshStandardMaterial({ color: 0x8b97a8, roughness: 0.5, metalness: 0.4 });
      model.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; c.material = mat; } });
      group.add(model);
      scene.add(group);
      state.rover = model;
      onLog("Rover model loaded", "system");
    },
    undefined,
    () => onLog("Failed to load 3D model", "danger")
  );

  let raf;
  function animate() {
    raf = requestAnimationFrame(animate);
    cam.x += (cam.tx - cam.x) * 0.06; cam.y += (cam.ty - cam.y) * 0.06; cam.z += (cam.tz - cam.z) * 0.06;
    camera.position.set(cam.x, cam.y, cam.z);
    camera.lookAt(0, 0.22, 0);

    if (state.rover && !isNaN(state.tRoll)) {
      state.roll += (state.tRoll - state.roll) * 0.1;
      state.pitch += (state.tPitch - state.pitch) * 0.1;
      state.yaw += (state.tYaw - state.yaw) * 0.1;
      state.rover.rotation.set(state.roll, state.yaw, state.pitch, "YXZ");
    }

    const yawDeg = state.yaw * (180 / Math.PI);
    if (compassEl && !isNaN(yawDeg)) compassEl.style.transform = `rotate(${-yawDeg}deg)`;

    if (state.hasData && !isNaN(state.tDist)) {
      state.dist += (state.tDist - state.dist) * 0.25;
      const maxVis = 4.2, hide = 4.0;
      wall.position.z = Math.min(state.dist, maxVis);
      if (state.dist > hide || state.dist < 0.02) { wall.visible = false; }
      else {
        wall.visible = true;
        const ratio = Math.min(state.dist / hide, 1);
        const hue = ratio * 120;
        wall.material.color.setHSL(hue / 360, 0.9, 0.45);
        wall.material.emissive.setHSL(hue / 360, 0.9, 0.35);
        wall.children[0].material.color.setHSL(hue / 360, 0.9, 0.55);
        const s = 0.35 + (1 - ratio) * 0.8;
        wall.scale.set(s, s, 1);
        wall.position.y = 0.25 + (1 - ratio) * 0.35;
      }
    }

    const a = dustGeo.getAttribute("position").array;
    for (let i = 1; i < a.length; i += 3) { a[i] -= 0.002; if (a[i] < 0) a[i] = 4.5; }
    dustGeo.getAttribute("position").needsUpdate = true;

    renderer.render(scene, camera);
  }
  animate();

  function resize() {
    const w = canvas.parentElement?.clientWidth;
    if (w) { width = w; renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); }
  }
  resize();
  setTimeout(resize, 120); setTimeout(resize, 420);
  window.addEventListener("resize", resize);

  return {
    bindCompass(el) { compassEl = el; },
    setData(d) {
      state.hasData = true;
      if (d.roll != null && !isNaN(d.roll)) state.tRoll = (d.roll * Math.PI) / 180;
      if (d.pitch != null && !isNaN(d.pitch)) state.tPitch = (d.pitch * Math.PI) / 180;
      if (d.yaw != null && !isNaN(d.yaw)) state.tYaw = (d.yaw * Math.PI) / 180;
      if (d.dist != null && !isNaN(d.dist)) state.tDist = SENSOR_Z + Math.min(d.dist * 0.04, 4.0);
    },
    setCamera(preset) { const p = presets[preset]; if (p) { cam.tx = p.x; cam.ty = p.y; cam.tz = p.z; } },
    dispose() { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); renderer.dispose(); },
  };
}
