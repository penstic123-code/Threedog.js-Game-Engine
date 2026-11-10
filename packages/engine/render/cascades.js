// Cascaded shadows of one DirectionalLight: 2-4 maps along the view (three's CSM addon), sharp near the camera, wide far away. The one copy of this
// engineering: engine.shadows.cascades(light) (render/shadows.js) builds them here, one set per engine (one 'csm' patch per material, and the cascade order
// is the order of the shadow-casting lights).
// Design choices, each one because the addon used as-is would break something:
// - The light handed in stays in charge and is the nearest cascade, so whoever writes it keeps its color / intensity / direction.
//   The other cascades are extra DirectionalLights that copy its color and intensity every frame.
// - Materials get the cascade lighting through one named patch, 'csm' (render/patches.js), never CSM.setupMaterial: that assigns
//   material.onBeforeCompile and would drop every other patch (wind, clouds, season, detail, lighting), and CSM.dispose deletes it.
// - The chunk swap is per material (the patch replaces <lights_fragment_begin>): CSM's constructor overwrites ShaderChunk globally and
//   never restores it, which would reach every material and every engine on the page; here _injectInclude does nothing.
// - Every lit material in the scene must carry the patch: without it the cascade lights would add up (N times the sunlight). So while
//   cascades are on, each frame visits only what entered the scene since the last one (core/scene/sceneDelta.js: an add at any depth, or
//   mesh.material = x) and patches lit materials it has not seen (one Map lookup per mesh); the whole scene is walked once, when they turn on.
// - Which materials (user decision 4, option A, 2026-11-02): every BUILT-IN lit type, the game's own `new` materials too. This is the one named
//   exception to "the engine does not change what it did not create": unpatched, a lit material is lit by every cascade light (N times as
//   bright, doubled shadows), so leaving it alone is not neutral, it is a wrong picture. describe().owned lists the game materials it patched.
//   A ShaderMaterial with lights: true is the game's own shader code, so it is never patched silently: one warning names
//   engine.shadows.include(mat), which opts it in.
// - csm.update() runs only on frames whose shadow maps re-render (engine.shadows.budget), else lights move while the maps stay old.
// On WebGPURenderer all of the above is replaced by three's CSMShadowNode on the light (cascades.tsl.js, registered by threedog/tsl): one light,
// so no patch, no scene walk, and engine.shadows.include() does nothing. This file only hands over to it, so WebGL bundles never load three/webgpu.
import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import { CSMShader } from 'three/addons/csm/CSMShader.js';
import { patchMaterial, unpatchMaterial, isEngineMade } from './patches.js';

import { warnOnce } from '../core/base/validate.js';
import { sceneVisitor } from '../core/scene/sceneDelta.js';
import { engineOwned } from '../core/scene/things.js';
import { drawOnly } from '../core/scene/drawOnly.js';
import { codedError } from '../core/base/errorHints.js';
import { setShadowUpdate, shadowUpdatePending, shadowsOn, isWebGPU, webgpuPart, projectionKey } from './backend.js';

export const CASCADE_SPLITS = ['practical', 'uniform', 'logarithmic'];
/** Fields of a cascade set besides its count; both entries start from these */
export const CASCADE_DEFAULTS = { maxFar: 120, fade: true, lightMargin: 100, split: 'practical' };

const LIT = new Set(['MeshLambertMaterial', 'MeshPhongMaterial', 'MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshToonMaterial']);
const _cam = new THREE.Vector3();
const litShader = m => m.isShaderMaterial && m.lights && m.fragmentShader.includes('#include <lights_fragment_begin>');
/** ShaderMaterials the game opted in with engine.shadows.include(mat), per engine */
const optedIn = e => e._csmInclude ??= new WeakSet();
/**
 * engine.shadows.include(material): let the cascades patch a ShaderMaterial (lights: true) of yours. Built-in lit materials need nothing.
 * @example engine.shadows.include(myLitShaderMaterial);
 */
export function includeInCascades(e, m) {
  if (!m?.isMaterial) throw codedError('shadow-cascades', `engine.shadows.include(material): needs a three.js Material; got ${m}. Example: engine.shadows.include(myShaderMaterial)`);
  if (m.isShaderMaterial && !litShader(m)) throw codedError('shadow-cascades', "engine.shadows.include(material): this ShaderMaterial has no lights: true + '#include <lights_fragment_begin>', so the cascades cannot reach it; build it on THREE.ShaderLib's lit shaders, or leave it out");
  if (isWebGPU(e.renderer)) {   // the cascades are the light's shadow node there: every material is lit once without opting in
    warnOnce('engine.shadows.include(mat) does nothing on WebGPURenderer: cascaded shadows there are one light (three CSMShadowNode) and patch no material');
    return m;
  }
  optedIn(e).add(m);
  if (e._cascades?.mats.has(m)) e._cascades.fit(m);   // already looked at and left alone: patch it now (fit is per material, so no scene walk)
  return m;
}
const lit = (c, m) => {
  if (LIT.has(m.type)) return true;
  if (!litShader(m)) return false;
  if (optedIn(c.engine).has(m)) return true;
  warnOnce(`cascaded shadows: engine.shadows.include(mat) opts ShaderMaterial '${m.name || m.uuid.slice(0, 8)}' in. Until then it has lights: true and is lit by all ` +
    `${c.lights.length} cascade lights (too bright, doubled shadows): the engine does not patch your own shader code unasked`);
  return false;
};

// The addon's split / frustum / texel-snapped placement, with the given light as cascade 0 and the chunk swap left to the 'csm' patch
class LightCSM extends CSM {
  /** @param {any} e @param {any} light @param {{ cascades: number, maxFar: number, fade: boolean, lightMargin: number, split: any }} S */
  constructor(e, light, S) {
    const custom = typeof S.split === 'function';
    // parent: a Group, not the scene. three's constructor adds its lights itself, and a plain scene.add counts them as the game's (describe().scene, the "lights add up" warning)
    super({ camera: e.camera, parent: new THREE.Group(), cascades: S.cascades, maxFar: S.maxFar, mode: custom ? 'custom' : S.split, customSplitsCallback: custom ? S.split : undefined,
      shadowMapSize: light.shadow.mapSize.x, shadowBias: light.shadow.bias, lightMargin: S.lightMargin, lightNear: 1, lightFar: S.lightMargin + 2 * S.maxFar });
    this.parent = e.scene;
    this.lights[0].dispose();
    this.lights[0] = light;
    for (const l of this.lights) if (l !== light) { engineOwned('shadows', l, l.target); drawOnly('', l); e.scene.add(l, l.target); }   // copies of the sun: a scene copy keeps the sun alone
    // uniforms shared by every patched material: one write here reaches all of them
    this.uniforms = { CSM_cascades: { value: [] }, cameraNear: { value: 0 }, shadowFar: { value: 0 } };
    this.fade = S.fade;
    this.updateFrustums();
    // cacheKey is new for every build: three keeps a material's old programs and, when a key comes back (cascades off, then on again),
    // reuses that program with the uniforms map of the material's latest compile, which lacks these uniforms, so the GPU would keep the
    // old build's split and far values (shadows vanish where the old cascade 0 ended). One recompile per switch, which the light count
    // change costs anyway; each material keeps one program per switch until it is disposed, so switch on a settings screen, not per frame
    e._csmBuild = (e._csmBuild ?? 0) + 1;
    this.patch = { name: 'csm', cacheKey: `${S.cascades}${S.fade ? 'f' : ''}.${e._csmBuild}`, uniforms: this.uniforms, slot: 'lightingModel',
      pars: `#define USE_CSM 1\n#define CSM_CASCADES ${S.cascades}\n${S.fade ? '#define CSM_FADE\n' : ''}` +
        'uniform vec2 CSM_cascades[CSM_CASCADES];\nuniform float cameraNear;\nuniform float shadowFar;',
      glsl: CSMShader.lights_fragment_begin };
    /**
     * material -> the patch object it carries (null: looked at, left alone), and weak refs to walk them: switching off finds every material still alive.
     * Weak because streamed terrain makes a material per chunk with its own color map, and a strong table would keep them all for as long as cascades run. Not
     * a dispose listener: dispose() is also how a game forces a rebuild of a material it keeps on the mesh, and that one must still lose the patch at drop()
     */
    this.mats = new WeakMap();
    this.refs = [];
    this.sweepAt = 1024;
    this.engine = e;
    this.light = light;
    this.at = new THREE.Vector3(Infinity, 0, 0);   // camera position at the last placement
    this.proj = '';
    /** what entered the scene since the last frame (view.walks: how many full walks ran; tests read it) */
    this.view = sceneVisitor(e.scene, { enter: o => { if (!o.isMesh) return; const ms = o.material; if (Array.isArray(ms)) for (const m of ms) this.fit(m); else if (ms) this.fit(ms); } });
    const sc = light.shadow.camera;
    Object.assign(sc, { near: 1, far: this.lightFar }); sc.updateProjectionMatrix();
  }
  fit(m) {
    const was = this.mats.get(m);
    if (was === this.patch || (was === null && !optedIn(this.engine).has(m))) return;
    if (was === undefined) this.remember(m);
    if (!lit(this, m)) { this.mats.set(m, null); return; }   // null: looked at, left alone (no per-frame recheck / rewarn)
    patchMaterial(m, [this.patch], { strict: false }); this.mats.set(m, this.patch);
  }
  /** One weak ref per material; the dead ones go when the list has doubled, so a long walk through a streamed world keeps it at the size of what is alive */
  remember(m) {
    this.refs.push(new WeakRef(m));
    if (this.refs.length < this.sweepAt) return;
    this.refs = this.refs.filter(r => r.deref());
    this.sweepAt = Math.max(1024, this.refs.length * 2);
  }
  /** The materials looked at and still alive, with the patch each carries @returns {[any, any][]} */
  alive() { return this.refs.flatMap(r => { const m = r.deref(); return m ? [[m, this.mats.get(m)]] : []; }); }
  /** describe().owned row: the game's own materials the csm patch went on (the named exception, see the header) */
  gameMaterials() { return this.alive().filter(([m, p]) => p && !isEngineMade(m)).map(([m]) => m.name || m.type); }
  _injectInclude() {}
  _updateUniforms() {
    const U = this.uniforms;
    if (!U) return;   // the base constructor calls this before the uniforms exist
    this._getExtendedBreaks(U.CSM_cascades.value);
    U.cameraNear.value = this.camera.near; U.shadowFar.value = Math.min(this.camera.far, this.maxFar);
  }
  /** The light's shadow values reach the extra lights: what is written on the light is the one source */
  shadowParams() {
    const s = this.light.shadow;
    this.shadowMapSize = s.mapSize.x;   // the placement snaps to this texel size
    for (const l of this.lights) if (l !== this.light) {
      Object.assign(l.shadow, { bias: s.bias, normalBias: s.normalBias, radius: s.radius, blurSamples: s.blurSamples, intensity: s.intensity, autoUpdate: s.autoUpdate });
      if (s.needsUpdate) l.shadow.needsUpdate = true;   // a budget asks on the light handed in; every cascade redraws with it
      if (l.shadow.mapSize.x !== s.mapSize.x) { l.shadow.mapSize.copy(s.mapSize); l.shadow.map?.dispose(); l.shadow.map = null; }
    }
  }
  /**
   * Per frame: patch materials that entered the scene, follow the camera and the light, place on shadow frames
   * @param {any} lightDir unit vector toward the light @param {number} updateEvery 1 = the shadow maps redraw every frame
   */
  frame(lightDir, updateEvery) {
    const e = this.engine, cam = e.camera, light = this.light;
    this.view.sync();
    this.shadowParams();
    const proj = projectionKey(cam);
    let force = false;
    if (this.camera !== cam || proj !== this.proj) { this.camera = cam; this.proj = proj; this.updateFrustums(); force = true; }
    this.lightDirection.copy(lightDir).negate();   // CSM points from the light into the scene
    // with no shadow on the light the extra lights would only add light (the patch's bands need the shadow lights): hide them
    const show = light.visible && light.castShadow && !!light.parent && shadowsOn(e);
    for (const l of this.lights) if (l !== light) { l.color.copy(light.color); l.intensity = light.intensity; l.visible = show; }
    cam.updateMatrixWorld();
    _cam.setFromMatrixPosition(cam.matrixWorld);   // world: a camera on a rig keeps a small local position while it travels
    // not updating every frame: also place early when the camera left a quarter of the nearest cascade (teleport, fast travel)
    const near = this.breaks[0] * Math.min(cam.far, this.maxFar);
    if (updateEvery <= 1 || shadowUpdatePending(e.renderer, e.scene) || force || this.at.distanceToSquared(_cam) > (near / 4) ** 2) {
      this.update(); this.at.copy(_cam);
      if (updateEvery > 1) setShadowUpdate(e.renderer, e.scene, { now: true });
    }
  }
  /** Switch off: extra lights out, the 'csm' patch off every material it went on */
  drop() {
    for (const l of this.lights) if (l !== this.light) { this.parent.remove(l, l.target); l.dispose(); }
    this.view.remove();
    for (const [m, p] of this.alive()) if (p) unpatchMaterial(m, 'csm');
  }
}

/**
 * Build the cascades of a light. One set per engine, named at the second build: a material holds one 'csm' patch, and on WebGL the cascade
 * order is the order of the shadow-casting lights.
 * @param {any} e @param {any} light @param {{ cascades: number, maxFar: number, fade: boolean, lightMargin: number, split: any }} S
 * @param {string} who the entry, for the errors
 * @returns {any} LightCSM, or the shadow node on WebGPURenderer
 */
export function createCascades(e, light, S, who) {
  if (e._cascades) throw codedError('shadow-cascades', `${who}: cascaded shadows are already on for light '${e._cascades.light.name || e._cascades.light.type}', and an engine draws one set. Switch those off first (handle.remove())`);
  const sc = light.shadow.camera, box = { left: sc.left, right: sc.right, top: sc.top, bottom: sc.bottom, near: sc.near, far: sc.far };
  const c = isWebGPU(e.renderer) ? webgpuPart('cascades', `[shadows] cascaded shadows (${who})`).create(e, light, S) : new LightCSM(e, light, S);
  c._box = box;
  c.shadowParams();
  e.occlusion?.shadowLightsAdded();   // fresh shadow cameras: culling adds its layers to them now, or what it hides casts no shadow for a second
  return (e._cascades = c);
}

/** Remove the engine's cascades, if any: the light's shadow box comes back and the plain map redraws @param {any} e */
export function dropCascades(e) {
  const c = e._cascades;
  if (!c) return;
  c.drop();
  const sc = c.light.shadow.camera;
  Object.assign(sc, c._box); sc.updateProjectionMatrix();
  e._cascades = null;
  setShadowUpdate(e.renderer, e.scene, { now: true });
}
