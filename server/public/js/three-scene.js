const Scene3D = {};

function initScene3D() {
  const canvas = document.getElementById('vis-canvas');
  let width = canvas.parentElement ? canvas.parentElement.clientWidth : 600;
  let height = 395;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050810);
  scene.fog = new THREE.Fog(0x050810, 7, 14);

  Scene3D.targetCamX = 3.2; Scene3D.targetCamY = 2.4; Scene3D.targetCamZ = 4.8;
  Scene3D.camX = 3.2; Scene3D.camY = 2.4; Scene3D.camZ = 4.8;

  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 30);
  camera.position.set(Scene3D.camX, Scene3D.camY, Scene3D.camZ);
  camera.lookAt(0, 0.2, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene.add(new THREE.AmbientLight(0xdbeafe, 0.8));
  const dir = new THREE.DirectionalLight(0xffffff, 1.4);
  dir.position.set(4, 8, 3);
  dir.castShadow = true;
  dir.shadow.mapSize.width = 1024; dir.shadow.mapSize.height = 1024;
  dir.shadow.camera.near = 0.5; dir.shadow.camera.far = 15;
  dir.shadow.bias = -0.001;
  scene.add(dir);

  const starCount = 70;
  const starGeo = new THREE.BufferGeometry();
  const starPos = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount * 3; i += 3) {
    starPos[i] = (Math.random() - 0.5) * 14;
    starPos[i+1] = Math.random() * 4.5;
    starPos[i+2] = (Math.random() - 0.5) * 14;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x3b82f6, size: 0.035, transparent: true, opacity: 0.3 }));
  scene.add(stars);

  scene.add(new THREE.GridHelper(10, 20, 0x1d4ed8, 0x0f1629));

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.95 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  for (let i = 1; i <= 4; i++) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(i - 0.03, i + 0.03, 32),
      new THREE.MeshStandardMaterial({ color: 0x1d4ed8, transparent: true, opacity: 0.12, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.02, 0.5);
    scene.add(ring);
  }

  const coneMat = new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.04, wireframe: true, side: THREE.DoubleSide });
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.8, 3.2, 16, 2, true), coneMat);
  cone.rotation.x = Math.PI / 2;
  cone.position.set(0, 0.14, 2.1);
  scene.add(cone);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0xef4444, transparent: true, opacity: 0.2, roughness: 0.1, metalness: 0.9, emissive: 0xef4444, emissiveIntensity: 0.25 });
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.1, 0.06), wallMat);
  wall.position.set(0, 0.55, 3);
  wall.visible = false;
  wall.add(new THREE.LineSegments(new THREE.EdgesGeometry(wall.geometry), new THREE.LineBasicMaterial({ color: 0xef4444, linewidth: 2 })));
  scene.add(wall);

  const glowRing = new THREE.Mesh(
    new THREE.RingGeometry(0.2, 0.6, 24),
    new THREE.MeshStandardMaterial({ color: 0xef4444, transparent: true, opacity: 0.1, side: THREE.DoubleSide })
  );
  glowRing.rotation.x = -Math.PI / 2;
  glowRing.position.set(0, 0.02, 3);
  glowRing.visible = false;
  scene.add(glowRing);

  const cameraPresets = {
    isometric: { x: 3.2, y: 2.4, z: 4.8 },
    front:     { x: 0,   y: 0.7, z: 3.4 },
    top:       { x: 0.01,y: 6.2, z: 0.01 },
    side:      { x: 4.4, y: 0.6, z: 0   }
  };

  function setCameraPreset(preset) {
    if (!cameraPresets[preset]) return;
    Scene3D.targetCamX = cameraPresets[preset].x;
    Scene3D.targetCamY = cameraPresets[preset].y;
    Scene3D.targetCamZ = cameraPresets[preset].z;
    document.querySelectorAll('.hud-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById('cam-' + preset);
    if (btn) btn.classList.add('active');
    addLog(`Camera: ${preset}`, 'system');
  }

  document.getElementById('cam-isometric').addEventListener('click', () => setCameraPreset('isometric'));
  document.getElementById('cam-front').addEventListener('click', () => setCameraPreset('front'));
  document.getElementById('cam-top').addEventListener('click', () => setCameraPreset('top'));
  document.getElementById('cam-side').addEventListener('click', () => setCameraPreset('side'));

  Scene3D.roll = 0; Scene3D.pitch = 0; Scene3D.yaw = 0;
  Scene3D.targetRoll = 0; Scene3D.targetPitch = 0; Scene3D.targetYaw = 0;
  Scene3D.targetDist = 0; Scene3D.currentDist = 0;
  Scene3D.lastDist = 0;
  Scene3D.isTelemetryReceived = false;
  Scene3D.pingActive = false; Scene3D.pingTime = 0;
  Scene3D.SENSOR_Z = 0.55;
  Scene3D.rover = null;

  const loader = new THREE.GLTFLoader();
  loader.load(
    'models/rover.glb',
    (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const scale = 0.9 / Math.max(size.x, size.z);

      const group = new THREE.Group();
      group.rotation.y = Math.PI / 2;

      model.scale.set(scale, scale, scale);
      model.position.sub(center.clone().multiplyScalar(scale));
      model.position.y += 0.28;
      const roverMat = new THREE.MeshStandardMaterial({
        color: 0x6b7280,
        roughness: 0.55,
        metalness: 0.35,
      });
      model.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          child.material = roverMat;
        }
      });
      group.add(model);
      scene.add(group);
      Scene3D.rover = model;
      addLog('Rover model loaded', 'system');
    },
    undefined,
    (err) => {
      console.error('GLB load error:', err);
      addLog('Failed to load 3D model', 'danger');
    }
  );

  function animate() {
    requestAnimationFrame(animate);

    Scene3D.camX += (Scene3D.targetCamX - Scene3D.camX) * 0.05;
    Scene3D.camY += (Scene3D.targetCamY - Scene3D.camY) * 0.05;
    Scene3D.camZ += (Scene3D.targetCamZ - Scene3D.camZ) * 0.05;
    camera.position.set(Scene3D.camX, Scene3D.camY, Scene3D.camZ);
    camera.lookAt(0, 0.22, 0);

    if (Scene3D.rover && !isNaN(Scene3D.targetRoll)) {
      Scene3D.roll  += (Scene3D.targetRoll  - Scene3D.roll)  * 0.1;
      Scene3D.pitch += (Scene3D.targetPitch - Scene3D.pitch) * 0.1;
      Scene3D.yaw   += (Scene3D.targetYaw   - Scene3D.yaw)   * 0.1;
      Scene3D.rover.rotation.set(Scene3D.roll, Scene3D.yaw, Scene3D.pitch, 'YXZ');
    }

    const pitchDeg = Scene3D.pitch * (180 / Math.PI);
    const rollDeg  = Scene3D.roll  * (180 / Math.PI);
    const yawDeg   = Scene3D.yaw   * (180 / Math.PI);

    const hudHorizon = document.getElementById('hud-horizon-pitch');
    if (hudHorizon && !isNaN(pitchDeg) && !isNaN(rollDeg)) {
      hudHorizon.style.transform = `translateY(${pitchDeg * 1.8}px) rotate(${-rollDeg}deg)`;
    }

    const compassRose = document.getElementById('compass-rose');
    if (compassRose && !isNaN(yawDeg)) {
      compassRose.style.transform = `rotate(${-yawDeg}deg)`;
    }

    if (Scene3D.isTelemetryReceived && !isNaN(Scene3D.targetDist)) {
      Scene3D.currentDist += (Scene3D.targetDist - Scene3D.currentDist) * 0.25;
      const maxVis = 4.2, hideDist = 4.0;
      wall.position.z  = Math.min(Scene3D.currentDist, maxVis);
      glowRing.position.z = Math.min(Scene3D.currentDist, maxVis);

      if (Scene3D.currentDist > hideDist || Scene3D.currentDist < 0.02) {
        wall.visible = glowRing.visible = false;
      } else {
        wall.visible = glowRing.visible = true;
        const ratio = Math.min(Scene3D.currentDist / hideDist, 1);
        const hue = ratio * 120;
        wall.material.color.setHSL(hue/360, 0.9, 0.45);
        wall.material.emissive.setHSL(hue/360, 0.9, 0.35);
        wall.children[0].material.color.setHSL(hue/360, 0.9, 0.55);
        glowRing.material.color.setHSL(hue/360, 0.9, 0.45);
        glowRing.material.opacity = 0.04 + (1 - ratio) * 0.14;
        const scale = 0.35 + (1 - ratio) * 0.8;
        wall.scale.set(scale, scale, 1);
        wall.position.y = 0.25 + (1 - ratio) * 0.35;
        glowRing.scale.set(scale * 1.8, scale * 1.8, 1);
      }
    }

    const posAttr = starGeo.getAttribute('position');
    if (posAttr) {
      const a = posAttr.array;
      for (let i = 1; i < a.length; i += 3) { a[i] -= 0.002; if (a[i] < 0) a[i] = 4.5; }
      posAttr.needsUpdate = true;
    }

    if (Scene3D.pingActive) {
      Scene3D.pingTime += 0.04;
      const p = Math.sin(Scene3D.pingTime * 4) * 0.5 + 0.5;
      cone.material.opacity = 0.01 + p * 0.08;
      if (Scene3D.pingTime > Math.PI) {
        Scene3D.pingActive = false;
        cone.material.opacity = 0.04;
      }
    }

    renderer.render(scene, camera);
  }
  animate();

  function updateDimensions() {
    const p = canvas.parentElement;
    if (p) {
      width = p.clientWidth || width;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
  }
  updateDimensions();
  setTimeout(updateDimensions, 100);
  setTimeout(updateDimensions, 400);
  window.addEventListener('resize', updateDimensions);

  Scene3D.camera = camera;
  Scene3D.wall = wall;
  Scene3D.glowRing = glowRing;
  Scene3D.cone = cone;
}

initScene3D();
