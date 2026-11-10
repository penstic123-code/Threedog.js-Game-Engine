// Render layer 2 page (tests/specs/render-l2.mjs, docs/plans/2026-11-09-render-l2.md). One WebGPU engine: a ground, a metal ball with no environment
// (so the picture check 'metal-no-env' has something to say), the game's own shadow-casting sun. Each window function answers one finding.
import * as THREE from 'three';
import 'threedog/tsl';   // what a WebGPU game imports first (post chain, cascades)
import { createEngine } from '../../index.js';
import { backendName, swapWebGPUPart } from '../../render/backend.js';
import { pictureChecks } from '../../core/inspect/pictureChecks.js';

// ?route=webgl: the same page on WebGLRenderer, for what only its composer shows (targets freed by an antialias write)
const route = new URLSearchParams(location.search).get('route') ?? 'webgpu';
const engine = window.engine = createEngine({ canvas: document.getElementById('view'), renderer: route, lights: false, pixelRatio: 1, adaptiveResolution: false,
  ui: { loading: false }, saveKey: 'test-render-l2', urlState: false });
const sun = new THREE.DirectionalLight('#ffffff', 3);
sun.position.set(10, 20, 5); sun.castShadow = true;
const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xc8c8c8 }));
const ball = new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshStandardMaterial({ color: 0xaaaaaa, metalness: 1, roughness: 0.3 }));
ball.name = 'ball'; ball.position.y = 1; ball.castShadow = ground.receiveShadow = true;
engine.scene.add(sun, ground, ball);
await engine.start();
engine.haltLoop();
const ids = () => pictureChecks(engine).map(c => c.id);

/** 3: the checks wait for a drawn frame, and then speak on WebGPURenderer too */
window.checksOnWebGPU = () => {
  const before = ids();
  engine.step(1 / 30, { describe: false });
  return { webgpu: !!engine.renderer.isWebGPURenderer, backend: backendName(engine.renderer), before, after: ids() };
};
/** 2: a player's preset that changes engine.tier while running rebuilds the cascades once, the post chain follows the same notice */
window.tierFollow = () => {
  const count = () => engine.shadows.csm?.cascades ?? 1, out = {};   // the node makes its lights on its first frame; its count is set at once
  engine.tier = 'high';
  const h = engine.shadows.cascades(sun, { count: 3 });
  out.high = count();
  engine.mod('tier', { owner: 'test', set: 'low' });
  out.low = count();
  const lowCsm = engine.shadows.csm;
  engine.mod('tier', { owner: 'test', set: 'low' });   // the same tier again: nothing rebuilt
  out.sameKept = engine.shadows.csm === lowCsm;
  engine.stacks.get('tier').release('test');
  out.back = count();
  h.remove();
  engine.mod('tier', { owner: 'test', set: 'low' });   // a removed handle no longer follows
  out.afterRemove = engine.shadows.csm ?? null;
  engine.stacks.get('tier').release('test');
  return out;
};
/**
 * 4, 5, 6: what a chain change rebuilds. Each effect counts its node() builds; the heavy one stands for voxel GI / TRAA (state that a rebuild loses).
 * Same antialias rebuilds nothing; a final effect toggled rebuilds only itself; a new MRT buffer rebuilds the whole chain; nothing on frees the scene pass
 */
window.chainRebuilds = () => {
  const P = engine.post, built = { heavy: 0, cheap: 0, mrt: 0 }, n = () => ({ ...built });
  const step = () => engine.step(1 / 30, { describe: false });
  const heavy = P.add({ name: 'heavy', slot: 'hdr', node: c => { built.heavy++; return c; } });
  step();
  const out = { first: n() };
  const pass0 = P.object().scenePass;
  P.antialias = P.antialias;   // a settings sync writing the value it already has
  out.sameAA = { ...n(), pass: P.object().scenePass === pass0 };
  const cheap = P.add({ name: 'cheap', slot: 'final', node: c => { built.cheap++; return c; } });
  cheap.enabled = false; cheap.enabled = true; step();
  out.toggled = n();
  const mrt = P.add({ name: 'mrt', slot: 'hdr', order: 10, needsBuffers: ['normal'], node: c => { built.mrt++; return c; } });
  step();
  out.mrt = n();
  mrt.remove(); step();
  out.mrtGone = n();
  let freed = false;
  P.object().scenePass.renderTarget.addEventListener('dispose', () => { freed = true; });
  heavy.enabled = false; cheap.enabled = false; step();
  out.empty = { pipe: P.object(), freed };
  heavy.enabled = true; step();
  out.back = { ...n(), pipe: !!P.object()?.scenePass };
  // handed back after the game owned the chain: its edits are gone, every stage is built again from the list
  P.own(); P.object().pipeline.outputNode = P.object().scenePass.getTextureNode(); P.own(false); step();
  out.handBack = n();
  heavy.remove(); cheap.remove(); step();
  return out;
};
/** 2: a cascades request that throws at its first build returns no handle and leaves nothing following the tier */
window.cascadesThrow = () => {
  const part = swapWebGPUPart('cascades', { create() { throw new Error('test: build fails'); } });
  let threw = '';
  try { engine.shadows.cascades(sun, { count: 3 }); } catch (err) { threw = err.message; } finally { swapWebGPUPart('cascades', part); }
  engine.tier = 'high';
  let after = '';
  try { engine.mod('tier', { owner: 'test', set: 'low' }); engine.stacks.get('tier').release('test'); } catch (err) { after = err.message; }
  return { threw, after, csm: !!engine.shadows.csm };
};
/** 4 on WebGL: the same antialias value frees no composer target and touches no pass */
window.sameAAWebGL = () => {
  const P = engine.post, step = () => engine.step(1 / 30, { describe: false });
  let sized = 0;
  const h = P.add({ name: 'stub', slot: 'hdr', create: () => ({ enabled: true, needsSwap: false, render() {}, setSize() { sized++; }, dispose() {} }) });
  step();
  let freed = 0;
  for (const rt of [P.composer.renderTarget1, P.composer.renderTarget2]) rt.addEventListener('dispose', () => { freed++; });
  const s0 = sized;
  P.antialias = P.antialias;
  const same = { freed, sized: sized - s0 };
  P.antialias = !P.antialias;   // a real change frees them: the watch works
  const changed = freed;
  P.antialias = !P.antialias; h.remove(); step();
  return { webgl: !engine.renderer.isWebGPURenderer, same, changed };
};
window.ready = true;
