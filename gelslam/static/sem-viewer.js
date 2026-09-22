// SEM-shaded gallery viewer: applies the electron-microscope shader to GLBs.
// Usage: <div class="sem-viewer" data-src="model.glb"></div>
// Lazy-loads when near the viewport, idle auto-rotates, shows a rotate hint
// until first interaction.
// Chrome kills the oldest WebGL context once a page has ~16 live ones, so each
// viewer is torn down when it scrolls far off-screen and rebuilt (from the
// decoded-geometry cache, so it's instant) when it comes back.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';

const semMaterial = new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  vertexShader: `
    varying vec3 vN; varying vec3 vV;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalMatrix * normal; vV = -mv.xyz;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    varying vec3 vN; varying vec3 vV;
    void main() {
      float ndv = abs(dot(normalize(vN), normalize(vV)));
      float i = 0.10 + 0.95 * pow(1.0 - ndv, 0.85);
      gl_FragColor = vec4(vec3(i), 1.0);
    }`
});
const draco = new DRACOLoader();
draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
const loader = new GLTFLoader();
loader.setDRACOLoader(draco);

const UP = new THREE.Vector3(0, 1, 0);
const groups = {};   // data-sync pairs: leader-driven camera sync

const geomCache = new Map();   // src -> Promise<{geoms, r}>: survives viewer teardown
function loadGeoms(src) {
  if (!geomCache.has(src)) geomCache.set(src, new Promise((resolve) => {
    loader.load(src, (g) => {
      const scene = g.scene;
      scene.updateMatrixWorld(true);
      const geoms = [];
      scene.traverse((o) => {
        if (o.isMesh) {
          o.geometry.applyMatrix4(o.matrixWorld);      // flatten transforms
          if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
          geoms.push(o.geometry);
        }
      });
      // area-weighted surface centroid: the visual center, robust to lopsided shapes
      let area = 0; const cent = new THREE.Vector3();
      const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3(),
            ab = new THREE.Vector3(), ac = new THREE.Vector3(), tri = new THREE.Vector3();
      for (const geo of geoms) {
        const pos = geo.attributes.position, idx = geo.index;
        const n = idx ? idx.count : pos.count;
        for (let i = 0; i < n; i += 3) {
          const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i+1) : i+1, i2 = idx ? idx.getX(i+2) : i+2;
          pa.fromBufferAttribute(pos, i0); pb.fromBufferAttribute(pos, i1); pc.fromBufferAttribute(pos, i2);
          ab.subVectors(pb, pa); ac.subVectors(pc, pa);
          const a2 = tri.crossVectors(ab, ac).length();
          tri.copy(pa).add(pb).add(pc).multiplyScalar(1/3);
          cent.addScaledVector(tri, a2); area += a2;
        }
      }
      cent.multiplyScalar(1/area);
      for (const geo of geoms) geo.translate(-cent.x, -cent.y, -cent.z);  // pivot = centroid
      const box = new THREE.Box3();
      for (const geo of geoms) { geo.computeBoundingBox(); box.union(geo.boundingBox); }
      const r = box.getSize(new THREE.Vector3()).length() / 2;
      resolve({ geoms, r });
    });
  }));
  return geomCache.get(src);
}

function buildViewer(el) {
  const st = el._sem = el._sem || { alive: false, camPos: null, camUp: null, rootQuat: null };
  if (st.alive) return;
  st.alive = true;
  const groupName = el.dataset.sync || null;
  const group = groupName ? (groups[groupName] = groups[groupName] || { viewers: [], leader: null, lastTouch: 0 }) : null;
  const canvas = document.createElement('canvas');
  el.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);
  const camera = new THREE.PerspectiveCamera(35, 4/3, 0.1, 2000);
  const controls = new TrackballControls(camera, canvas);
  controls.rotateSpeed = 3.2;
  controls.noPan = true;
  controls.dynamicDampingFactor = 0.12;

  let root = null, lastTouch = 0, raf = 0, disposed = false;
  const clock = new THREE.Clock();
  const touch = () => { lastTouch = performance.now(); if (group) group.lastTouch = lastTouch; };
  canvas.addEventListener('pointerdown', touch);
  canvas.addEventListener('wheel', touch);
  canvas.addEventListener('pointermove', (e) => { if (e.buttons) touch(); });
  const me = { camera, controls, get root(){ return root; } };
  if (group) {
    group.viewers.push(me);
    if (!group.leader) group.leader = me;
    canvas.addEventListener('pointerenter', () => group.leader = me);
  }

  loadGeoms(el.dataset.src).then(({ geoms, r }) => {
    if (disposed) return;
    root = new THREE.Group();
    for (const geo of geoms) root.add(new THREE.Mesh(geo, semMaterial));
    if (st.rootQuat) root.quaternion.copy(st.rootQuat);
    scene.add(root);
    if (st.camPos) { camera.position.copy(st.camPos); camera.up.copy(st.camUp); }
    else camera.position.set(r*1.53, r*0.82, r*2.24);   // ~85% initial framing
    camera.near = r/100; camera.far = r*20; camera.updateProjectionMatrix();
    controls.update();
    el.classList.add('loaded');
    const chip = el.parentElement && el.parentElement.querySelector('.mv-hint');
    if (chip) chip.style.display = 'none';
  });

  const onScroll = () => controls.handleResize();
  window.addEventListener('scroll', onScroll, { passive: true });
  function tick() {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    const w = el.clientWidth || 500, h = el.clientHeight || Math.round(w*0.75);
    if (canvas.width !== w || canvas.height !== h) {
      renderer.setSize(w, h, false);
      camera.aspect = w/h; camera.updateProjectionMatrix();
      controls.handleResize();
    }
    const dt = clock.getDelta();
    if (group) {
      controls.enabled = group.leader === me;
      if (group.leader === me) {
        if (root && performance.now() - group.lastTouch > 3500) {
          // orbit the camera about the vertical axis so both panes stay aligned
          camera.position.applyAxisAngle(UP, dt * 8 * Math.PI / 180);
          camera.up.applyAxisAngle(UP, dt * 8 * Math.PI / 180);
          camera.lookAt(0, 0, 0);
        }
        controls.update();
        for (const o of group.viewers) if (o !== me) {
          o.camera.position.copy(camera.position);
          o.camera.up.copy(camera.up);
          o.camera.lookAt(0, 0, 0);
        }
      }
    } else {
      if (root && performance.now() - lastTouch > 3500) {
        root.rotateY(dt * 8 * Math.PI / 180);   // fixed axis on the object itself
      }
      controls.update();
    }
    renderer.render(scene, camera);
  }
  tick();

  st.dispose = () => {
    disposed = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('scroll', onScroll);
    st.camPos = camera.position.clone(); st.camUp = camera.up.clone();
    if (root) st.rootQuat = root.quaternion.clone();
    if (group) {
      const i = group.viewers.indexOf(me);
      if (i >= 0) group.viewers.splice(i, 1);
      if (group.leader === me) group.leader = group.viewers[0] || null;
    }
    controls.dispose();
    renderer.dispose();
    renderer.forceContextLoss();   // release the WebGL context now, not at GC time
    canvas.remove();
    st.alive = false;
  };
}

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) buildViewer(e.target);
    else if (e.target._sem && e.target._sem.alive) e.target._sem.dispose();
  }
}, { rootMargin: '600px 0px' });
document.querySelectorAll('.sem-viewer').forEach((el) => io.observe(el));
