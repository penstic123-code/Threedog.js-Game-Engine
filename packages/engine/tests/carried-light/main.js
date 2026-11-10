// Carried light page (tests/specs/carried-light.mjs). First person hides the player's body but keeps its shadow; a lamp the player carries sits next
// to the eye, inside the body. Measured by pixels on the ground: the lamp pool's left and right halves (the hidden body must not cut a black wedge),
// and the sun's shadow of the body in front of the feet (the hidden body must still cast it). ?r=gpu runs on WebGPURenderer, else WebGLRenderer.
import * as THREE from 'three';
import * as TG from 'three/webgpu';
import 'threedog/tsl';
import { createEngine } from '../../index.js';
import { firstPersonCamera } from '../../modules/camera/FirstPersonCamera.js';

const W = 200, H = 150, gpu = location.search.includes('r=gpu');
const canvas = document.getElementById('view');
const renderer = gpu ? new TG.WebGPURenderer({ canvas, antialias: false, forceWebGL: true }) : new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
renderer.shadowMap.enabled = true;
const engine = window.engine = createEngine({ renderer, pixelRatio: 1, adaptiveResolution: false, lights: false, ui: { loading: false }, saveKey: 'test-carried-light', urlState: false });

const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xb0b0b0, roughness: 1 }));
ground.receiveShadow = true;
// the player: a capsule body (feet at y 0), what a character controller usually carries
const player = new THREE.Group(), body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.2, 4, 12), new THREE.MeshStandardMaterial({ color: 0xc08060 }));
body.position.y = 0.9; body.castShadow = true; player.add(body);
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 0.1, far: 30 });
sun.position.set(0, 6, 6); sun.target.position.set(0, 0, 0);   // behind the player (who faces -z): the body's shadow falls forward, in view
// the carried lamp, placed as a game does it: right and below the eye, every frame
const lamp = new THREE.SpotLight(0xffffff, 60, 0, 0.7, 0.3, 2);
lamp.castShadow = true; lamp.shadow.mapSize.set(512, 512); lamp.shadow.camera.near = 0.15;
engine.scene.add(ground, player, sun, sun.target, lamp, lamp.target, new THREE.AmbientLight(0xffffff, 0.02));
engine.scene.background = new THREE.Color(0x000000);
engine.use(firstPersonCamera({ height: 1.6, fov: 70, pointerLock: false, headBob: 0 }));

await engine.start();
engine.haltLoop();
engine.cameraRig.follow(player);
const cam = engine.camera, rt = gpu ? new TG.RenderTarget(W, H) : new THREE.WebGLRenderTarget(W, H);
cam.aspect = W / H; cam.updateProjectionMatrix();
const off = new THREE.Vector3(0.25, -0.25, 0), fwd = new THREE.Vector3();

async function shot() {
  for (let i = 0; i < 3; i++) {
    engine.step(1 / 60, { describe: false });
    lamp.position.copy(cam.position).add(off.clone().applyQuaternion(cam.quaternion));
    cam.getWorldDirection(fwd); lamp.target.position.copy(cam.position).addScaledVector(fwd, 4); lamp.target.updateMatrixWorld();
  }
  engine.renderOnce(rt);
  if (gpu) return new Uint8Array(await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H));
  const px = new Uint8Array(W * H * 4); renderer.readRenderTargetPixels(rt, 0, 0, W, H, px); return px;
}
// mean brightness of a block; x0..x1 are shares of the width, y0..y1 of the height measured from the top (WebGL rows run bottom-up, WebGPU top-down)
const mean = (px, x0, x1, y0, y1) => {
  let s = 0, n = 0;
  for (let y = Math.floor(y0 * H); y < y1 * H; y++) for (let x = Math.floor(x0 * W); x < x1 * W; x++) {
    const row = gpu ? y : H - 1 - y, i = (row * W + x) * 4; s += px[i] + px[i + 1] + px[i + 2]; n++;
  }
  return Math.round(s / n / 3);
};

window.carriedRun = async () => {
  const r = {};
  // the lamp alone, looking a little down: its pool on the ground ahead, left half against right half
  sun.intensity = 0; lamp.intensity = 60; engine.cameraRig.pitch = -0.45;
  const a = await shot();
  r.lamp = { left: mean(a, 0.2, 0.45, 0.45, 0.9), right: mean(a, 0.55, 0.8, 0.45, 0.9) };
  r.lampDropsBody = !lamp.shadow.camera.layers.isEnabled(engine.cameraRig.hideLayer);
  // the sun alone, looking down at the feet: the body's shadow is the dark strip in the middle
  sun.intensity = 3; lamp.intensity = 0; engine.cameraRig.pitch = -1.0;
  const b = await shot();
  r.sun = { middle: mean(b, 0.44, 0.56, 0.3, 0.7), sides: Math.round((mean(b, 0.05, 0.2, 0.3, 0.7) + mean(b, 0.8, 0.95, 0.3, 0.7)) / 2) };
  r.sunKeepsBody = sun.shadow.camera.layers.isEnabled(engine.cameraRig.hideLayer);
  r.bodyHidden = !body.layers.test(cam.layers);
  // third person (body seen): the lamp gets hideLayer back, so a body that is seen shadows every light as in plain three.js
  engine.cameraRig._unhide();
  r.backAfterUnhide = lamp.shadow.camera.layers.isEnabled(engine.cameraRig.hideLayer);
  engine.cameraRig._hide();
  // a game that redraws the lamp's shadow only on request (autoUpdate off): the switch itself asks for the redraw, or the old wedge stays
  const rig = engine.cameraRig, bit = rig.hideLayer;
  sun.intensity = 0; lamp.intensity = 60; rig.pitch = -0.45;
  rig._unhide();
  await shot();   // lit again first: the sun phase left the lamp at 0, so the engine idled its redraws and hands autoUpdate back on the first lit frame
  lamp.shadow.autoUpdate = false; lamp.shadow.needsUpdate = true;
  const seenBody = await shot();   // the map is drawn once with the (seen) body in it
  r.manualSeen = { left: mean(seenBody, 0.2, 0.45, 0.45, 0.9), right: mean(seenBody, 0.55, 0.8, 0.45, 0.9) };
  rig._hide();
  const c = await shot();
  r.manual = { left: mean(c, 0.2, 0.45, 0.45, 0.9), right: mean(c, 0.55, 0.8, 0.45, 0.9) };
  lamp.shadow.autoUpdate = true;
  // a carried lamp taken out of the scene gets the bit back (it may be put back, or into another scene, as the game left it)
  r.carriedBeforeRemove = !lamp.shadow.camera.layers.isEnabled(bit);
  engine.scene.remove(lamp); engine.step(1 / 60, { describe: false });
  r.removedGetsBack = lamp.shadow.camera.layers.isEnabled(bit) && !rig._lightTook.has(lamp);
  engine.scene.add(lamp);
  return r;
};
window.ready = true;
