// Cascaded shadows on WebGPURenderer (the WebGPU half of cascades.js; loaded only through threedog/tsl, render/fx/index.js).
// Why three's CSMShadowNode and not the WebGL design: the cascades become the shadow node of the one light (light.shadow.shadowNode),
// so a material is lit by that light once and shadowed by whichever cascade covers it. Nothing is patched and the scene is never walked:
// the 'csm' patch, the per-frame scene visitor and engine.shadows.include() exist on WebGL only because there every cascade is a full
// DirectionalLight that would light an unpatched material N times (user decision 4, docs/plans/2026-11-03-webgpu-phase2.md).
// How it differs from the node used as-is, each one because the plain node would break something here:
// - The light's shadow camera gets near 1 / far lightMargin + 2 * maxFar before the node clones it into the cascades. The node only sizes
//   each cascade sideways and puts its light lightMargin behind the slice; with the old far kept, the far cascades' ground lies past far
//   and draws no shadow at all (what E2 saw). Three's WebGL CSM sets the same lightFar itself.
// - The cascades are built with engine.camera, never with whatever camera compiles first (a probe or photo render would own them).
// - Placement waits for frames whose cascade maps redraw (engine.shadows.budget): moving the cascade lights while the maps stay old
//   shifts every shadow, the same reason cascades.js only calls csm.update() on shadow frames.
// - Switching it on or off tells three's light node to rebuild its shadow (the light's 'dispose' event): the node caches the shadow it
//   built first and would keep drawing the old one.
import { Object3D } from 'three/webgpu';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { setShadowUpdate, shadowUpdatePending, registerWebGPUPart, rebuildShadow, projectionKey } from './backend.js';

class CascadeNode extends CSMShadowNode {
  /** @param {any} e @param {any} light @param {any} S the cascade fields */
  constructor(e, light, S) {
    const custom = typeof S.split === 'function';
    super(light, { cascades: S.cascades, maxFar: S.maxFar, mode: custom ? 'custom' : S.split, customSplitsCallback: custom ? S.split : undefined, lightMargin: S.lightMargin });
    this.isCascadeNode = true;
    this.fade = S.fade;
    this._engine = e;   // underscore names: three walks a node's public fields looking for child nodes
    this._at = { x: Infinity, y: 0, z: 0 };   // camera position at the last early update
    this._aim = new Object3D();   // the light's target in world space, for three's node (updateBefore)
    this._proj = '';
    const sc = light.shadow.camera;
    Object.assign(sc, { near: 1, far: S.lightMargin + 2 * S.maxFar }); sc.updateProjectionMatrix();
    light.shadow.shadowNode = this;
    rebuildShadow(light);
  }
  setup(builder) {
    // _init is the node's own first-build step (cascade stand-in lights, frustums); run it with the engine camera instead of builder.camera
    // (private to three, so not in @types/three)
    if (this.camera === null) /** @type {any} */ (this)._init({ camera: this._engine.camera, renderer: builder.renderer });
    // the game's filter (pcss from threedog/tsl, or its own) reaches every cascade: three's LightShadow.copy, which made them, leaves filterNode out
    for (const l of this.lights) l.shadow.filterNode = /** @type {any} */ (this.light).shadow.filterNode;
    return super.setup(builder);
  }
  /** @param {any} frame @returns {boolean} false would make three call it again this frame (NodeFrame) */
  updateBefore(frame) {
    if (this.lights.length && !this.lights.some(l => l.shadow.autoUpdate || l.shadow.needsUpdate)) return true;   // no cascade map redraws this frame
    // three's node aims with light.target.position, a local value: a target under a parent gave shadows another direction than the light's own shading
    // (and than WebGL). The light is a child of the scene (checked at the call), so its position needs no such step
    const light = /** @type {any} */ (this.light), target = light.target;
    target.updateWorldMatrix(true, false);
    this._aim.position.setFromMatrixPosition(target.matrixWorld);
    light.target = this._aim;
    try { return super.updateBefore(frame); } finally { light.target = target; }
  }
  fit() {}
  gameMaterials() { return []; }
  /** The light's shadow values reach the cascades (the node itself scales bias by cascade: bias x (i + 1), kept) */
  shadowParams() {
    const s = /** @type {any} */ (this.light).shadow;
    this.lights.forEach((l, i) => {
      Object.assign(l.shadow, { bias: s.bias * (i + 1), normalBias: s.normalBias, radius: s.radius, blurSamples: s.blurSamples, intensity: s.intensity, autoUpdate: s.autoUpdate });
      l.shadow.mapSize.copy(s.mapSize);
      if (s.needsUpdate) l.shadow.needsUpdate = true;   // a budget asks on the light handed in; every cascade redraws with it
    });
    if (this.lights.length) s.needsUpdate = false;   // with cascades the light's own map is never drawn, so nothing else clears it
  }
  /**
   * Per frame: follow a new camera / projection, update early after a jump. The node reads the light's direction itself, so the first argument (the WebGL
   * cascades' direction) is unused @param {any} _ @param {number} updateEvery 1 = the shadow maps redraw every frame
   */
  frame(_, updateEvery) {
    const e = this._engine, cam = e.camera;
    this.shadowParams();
    if (this.camera === null) return;   // not built yet: setup() takes engine.camera
    const proj = projectionKey(cam);
    let force = false;
    if (this.camera !== cam || proj !== this._proj) { this.camera = cam; this._proj = proj; this.updateFrustums(); force = true; }
    cam.updateMatrixWorld();
    if (updateEvery <= 1) return;
    // not updating every frame: also update early when the camera left a quarter of the nearest cascade (teleport, fast travel)
    const near = this.breaks[0] * Math.min(cam.far, this.maxFar), w = cam.matrixWorld.elements, p = { x: w[12], y: w[13], z: w[14] }, d = (p.x - this._at.x) ** 2 + (p.y - this._at.y) ** 2 + (p.z - this._at.z) ** 2;
    if (force || d > (near / 4) ** 2) { setShadowUpdate(e.renderer, e.scene, { now: true }); this._at = p; }
    else if (shadowUpdatePending(e.renderer, e.scene)) this._at = p;
  }
  /** Switch off: the cascade lights and maps go, the light gets its plain shadow back */
  drop() {
    const light = /** @type {any} */ (this.light);
    delete light.shadow.shadowNode;   // three tests `!== undefined`: null would count as a node
    for (const n of /** @type {any} */ (this)._shadowNodes) n.dispose();   // the node's own dispose() leaves the cascade maps on the GPU (private field)
    this.dispose();
    rebuildShadow(light);
  }
}

// cascades.js looks this up when the renderer is a WebGPURenderer (the WebGL bundle never imports three/webgpu); nothing to call
registerWebGPUPart('cascades', Object.freeze({ create: (e, light, S) => new CascadeNode(e, light, S) }));
