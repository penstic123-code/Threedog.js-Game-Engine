// Four game shapes on the real engine, each installing only what it needs (tests/specs/shapes.mjs): ?scene=explore | strategy | puzzle | procedural, plus ?scene=bare and ?scene=clear
// for what an engine adds by itself. Public names only: a private field in here is a finding, and so is a module a shape had to install without wanting it.
import { createEngine, presets, world, collision, followCamera, fixedCamera, characters, interactions, THREE } from '../../index.js';
import { vignette } from '@threedog/post-effects';

const scene = new URLSearchParams(location.search).get('scene');
const canvas = document.getElementById('view');
const base = { canvas, adaptiveResolution: false, antialias: false, pixelRatio: 1, ui: { loading: false }, urlState: false, saveKey: 'test-shapes-' + scene };
const box = (color, p, s = 1) => { const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), new THREE.MeshBasicMaterial({ color })); m.position.set(...p); return m; };
const floor = () => { const m = new THREE.Mesh(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x404040 })); m.name = 'floor'; return m; };
const toNdc = ev => { const b = canvas.getBoundingClientRect(); return [(ev.clientX - b.left) / b.width * 2 - 1, -((ev.clientY - b.top) / b.height) * 2 + 1]; };

const shapes = {
  /** Third person: walk with keys, follow camera, press E. A mover of the game's own can take over and every other part stays */
  async explore() {
    const engine = createEngine({ ...base, lights: false, bindings: { ...presets.bindings.walk, ...presets.bindings.interact }, audio: { footsteps: { default: 'step' } } });
    engine.use(world(), collision(), followCamera(), characters(), interactions({ ...presets.interactions.nearest }));
    engine.scene.add(floor(), new THREE.AmbientLight(0xffffff, 1));
    const p = engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: [0, 0, 0] });
    const used = [], sign = box(0xffcc00, [3, 0.5, 0]);
    engine.scene.add(sign);
    engine.interactions.add(sign, { label: 'sign', radius: 3, onUse: () => { used.push('sign'); } });
    let saved = 0;
    engine.saves.define('sign', { save: () => ({ used: used.length }), load: d => { saved = d.used; } });
    // a mover that goes up a wall: the body lies on its side and stays there, nothing pulls it upright or down to a ground height
    const wallMover = c => ({ name: 'wall', move(x, z, run, dt) {
      c.root.position.x += x * 4 * dt; c.root.position.y += z * 4 * dt; c.root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2); c.grounded = true;
    } });
    await engine.start();
    return { engine, p, used, wallMover, sign, saved: () => saved };
  },
  /** Top-down strategy: a real OrthographicCamera, click and box select, orders. No player, no character, no camera rig, no gameplay module */
  async strategy() {
    const engine = createEngine({ ...base, lights: false });
    const aspect = innerWidth / innerHeight, cam = new THREE.OrthographicCamera(-10 * aspect, 10 * aspect, 10, -10, 0.1, 100);
    cam.position.set(0, 30, 0); cam.up.set(0, 0, -1); cam.lookAt(0, 0, 0);
    engine.camera = cam;
    const ground = floor(), units = [[-6, -4], [-3, -4], [0, -4], [6, 5]].map(([x, z], i) => { const u = box(0x30a0ff, [x, 0.5, z]); u.name = 'unit' + i; u.userData.goal = null; return u; });
    engine.scene.add(ground, ...units);
    const selected = new Set(), mark = () => { for (const u of units) u.material.color.set(selected.has(u) ? 0xffff00 : 0x30a0ff); };
    let drag = null;
    canvas.addEventListener('pointerdown', ev => { if (ev.button === 0) drag = toNdc(ev); }, { signal: engine.signal });
    canvas.addEventListener('pointerup', ev => {
      if (ev.button !== 0 || !drag) return;
      const [x, y] = toNdc(ev), [a, b] = drag; drag = null;
      selected.clear();
      if (Math.hypot(x - a, y - b) < 0.02) { const h = engine.pick(x, y, { targets: units }); if (h) selected.add(h.object); }
      else for (const u of units) { const s = u.position.clone().project(engine.camera); if (s.x >= Math.min(a, x) && s.x <= Math.max(a, x) && s.y >= Math.min(b, y) && s.y <= Math.max(b, y)) selected.add(u); }
      mark();
    }, { signal: engine.signal });
    canvas.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      const h = engine.pick(...toNdc(ev), { targets: [ground] });
      if (h) [...selected].forEach((u, i) => { u.userData.goal = h.point.clone().setY(0.5).add(new THREE.Vector3(i * 1.5, 0, 0)); });
    }, { signal: engine.signal });
    engine.onFixed(dt => { for (const u of units) if (u.userData.goal) { const d = u.userData.goal.clone().sub(u.position), l = d.length(); if (l < 0.05) u.userData.goal = null; else u.position.addScaledVector(d, Math.min(1, 8 * dt / l)); } });
    await engine.start();
    return { engine, cam, units, selected, screen: u => { const s = u.position.clone().project(engine.camera), b = canvas.getBoundingClientRect(); return [(s.x + 1) / 2 * b.width + b.left, (1 - s.y) / 2 * b.height + b.top]; } };
  },
  /** Fixed camera puzzle: authored shots, no follow camera, no player, clicks */
  async puzzle() {
    const engine = createEngine({ ...base, lights: false });
    engine.use(fixedCamera({ shots: { hall: { position: [0, 3, 10], lookAt: [0, 1, 0], fov: 50 }, vault: { position: [12, 3, 0], lookAt: [20, 1, 0], fov: 40 } }, start: 'hall' }));
    const lever = box(0xff3030, [0, 1, 0], 2), door = box(0x30ff60, [20, 1, 0], 2);
    engine.scene.add(floor(), lever, door);
    engine.rays.addStatic([lever, door]);
    const log = [];
    canvas.addEventListener('click', ev => {
      const h = engine.pick(...toNdc(ev));
      if (h?.object === lever) { log.push('lever'); engine.cameraRig.cut('vault'); } else if (h?.object === door) { log.push('door'); door.visible = false; }
    }, { signal: engine.signal });
    await engine.start();
    return { engine, log, lever, door };
  },
  /** Procedural picture: nothing installed, plain three.js driven by onFrame, its own ShaderMaterial */
  async procedural() {
    const engine = createEngine({ ...base, lights: false });
    engine.scene.background = new THREE.Color(0x000000);
    const mat = new THREE.ShaderMaterial({ uniforms: { t: { value: 0 } }, vertexShader: 'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}', fragmentShader: 'uniform float t;void main(){gl_FragColor=vec4(1.,step(1e6,t),1.,1.);}' });
    const knot = new THREE.Mesh(new THREE.BoxGeometry(6, 6, 6), mat);
    engine.camera.position.set(0, 0, 20); engine.camera.lookAt(0, 0, 0);
    engine.scene.add(knot);
    engine.onFrame(dt => { knot.rotation.y += dt; mat.uniforms.t.value += dt; });
    await engine.start();
    return { engine, knot, mat };
  },
  /** What one engine adds by itself, next to plain three.js drawing the same scene on a second canvas */
  async bare() {
    const listeners = [], add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, o) { if (this === window || this === document) listeners.push({ type, signal: o?.signal ?? null }); return add.call(this, type, fn, o); };
    const engine = createEngine({ ...base, lights: false });
    EventTarget.prototype.addEventListener = add;
    await engine.start();
    return { engine, listeners, vignette };
  },
  /**
   * A transparent canvas over the page: the game's own renderer (alpha: true), the page shows where nothing is drawn. &mode= 'gpu' builds a WebGPURenderer
   * (its WebGL2 backend here), 'post' adds a post effect first: the clear colour, an empty background and the post chain must all keep the alpha
   */
  async clear() {
    const mode = new URLSearchParams(location.search).get('mode') ?? '';
    let renderer;
    if (mode.includes('gpu')) {
      if (mode.includes('swap')) Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });   // the fallback on every machine, a GPU or none
      await import('threedog/tsl');   // first: the WebGPU parts register here
      const { WebGPURenderer } = await import('three/webgpu');
      renderer = new WebGPURenderer({ canvas, alpha: true, antialias: false, ...(mode.includes('swap') ? {} : { forceWebGL: true }) });   // swap: no WebGPU, so fallback 'webgl' replaces it
    } else renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false });
    const { canvas: _, antialias: __, ...o } = base;
    const engine = createEngine({ ...o, renderer, lights: false, ...(mode.includes('swap') && { fallback: 'webgl' }) });
    renderer.setClearColor(0x000000, 0);
    engine.scene.background = null;
    engine.camera.position.set(0, 0, 20); engine.camera.lookAt(0, 0, 0);
    engine.scene.add(box(0xff0000, [0, 0, 0], 6));
    if (mode.includes('post')) engine.post.add(vignette());
    await engine.start();
    return { engine, renderer: engine.renderer };
  },
};

const made = await shapes[scene]();
window.engine = made.engine;
window.game = { ...made, THREE, presets, ready: true };
