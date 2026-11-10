// engine.shadows: the shadow engineering in three.js shape: each entry takes a light the game hands it and returns a handle. cascades(light): 2-4 maps along the
// view. box(light): the one shadow map's box follows something. budget(light): the map redraws every N frames. mapSize(light, n): resolution after the first draw.
// enabled: the master switch. include(mat).
// Why in core: they work with no module installed, on any DirectionalLight, so a game that lights its world itself (createEngine({ lights: false })) has them all.
// What stays the game's: a light nobody handed in is never touched, and the light's color, intensity, castShadow, visible and shadow values are only read. Filter,
// bias, radius and the first map size are plain three.js (renderer.shadowMap.type, light.shadow.*). Cascades and a box have to move a light to place it, so while they
// are on the light's position and target hold the placement (WebGL; three's node moves stand-ins on WebGPU): a game's later write to light.position, or a new
// light.target, still sets the direction, and remove() puts both back as the game left them. light.target is swapped for a stand-in because the placement
// writes target.position, and a game's target is often its player (light.target = player).
// The engine's placeholder sun is the engine's own light: a sky holds a box on it (sunBox) with the real target, and a direct write to that target yields (owned.js).
import * as THREE from 'three';
import { codedError } from '../core/base/errorHints.js';
import { warnOnce, fmt } from '../core/base/validate.js';
import { readParams } from '../core/base/params.js';
import { defineOwned, dropOwned, ownedRow } from '../core/ops/owned.js';
import { isWebGPU, onRendererSwap, setShadowUpdate, shadowsOn, webgpuPart } from './backend.js';
import { onTierChange } from '../core/scene/tier.js';
import { CASCADE_DEFAULTS, CASCADE_SPLITS, createCascades, dropCascades, includeInCascades } from './cascades.js';

const WHERE = 'engine.shadows.cascades';
const PARAMS = {
  count: { type: 'int', default: 3, min: 1, max: 4, desc: 'shadow maps along the view; 1 = one map that follows the camera' },
  maxFar: { type: 'number', default: CASCADE_DEFAULTS.maxFar, min: 0.001, desc: 'meters from the camera they cover' },
  split: { type: 'any', default: CASCADE_DEFAULTS.split, desc: "'practical' | 'uniform' | 'logarithmic' | (count, near, far, out) => void" },
  fade: { type: 'bool', default: CASCADE_DEFAULTS.fade, desc: 'cross-fade at the borders' },
  lightMargin: { type: 'number', default: CASCADE_DEFAULTS.lightMargin, min: 0, desc: 'meters behind each cascade box toward the light still caught as casters' },
  low: { type: 'object', optional: true, desc: 'on low-tier devices: { count } (default 1, one map that follows the camera)' },
};
const STRINGS = {
  light: `${WHERE}(light): needs a three.js DirectionalLight (cascades split a parallel light's shadow); got {got}`,
  scene: `${WHERE}(light): the light must be a direct child of engine.scene first (cascades place it in world space): engine.scene.add(light)`,
  cast: `${WHERE}(light): set light.castShadow = true first; the engine does not write that on your light`,
  twice: `${WHERE}(light): this engine already has a cascades handle; change it with handle.set({ ... }) or call handle.remove() first (an engine draws one set)`,
  boxed: `${WHERE}(light): this light has a shadow box, and both place the light; call the box handle's remove() first`,
  other: `${WHERE}(light): {got} also casts a directional shadow; on WebGLRenderer the cascades must be the scene's only shadow-casting DirectionalLight. Set castShadow = false on it (engine.lights.sun.castShadow = false for the engine sun) or put the cascades on that light instead`,
  split: `${WHERE}: split must be ${CASCADE_SPLITS.map(s => `'${s}'`).join(' | ')} or a function (count, near, far, out) => void; got {got}`,
  low: `${WHERE}: low must be { count } with a whole number 1 to 4; got {got}`,
};
const fail = (k, got) => { throw codedError('shadow-cascades', fmt(STRINGS[k], { got: JSON.stringify(got) ?? String(got) })); };
const refuse = msg => { throw codedError('shadow-cascades', msg); };

const BOX = 'engine.shadows.box';
const BOX_PARAMS = {
  follow: { type: 'any', default: 'focus', desc: "what the box centers on: 'focus' (engine.focus) | 'camera' | an Object3D | () => Vector3 | false (it stays on the light's target)" },
  extent: { type: 'number', optional: true, min: 1, desc: "half size of the box in meters; left out: the light's own shadow camera stays as it is" },
  snap: { type: 'any', default: 0.5, desc: "center snap grid in meters, or 'texel' (one shadow pixel: no shimmer on a moving camera)" },
  ahead: { type: 'number', default: 0, desc: 'meters the center is shifted in front of the view' },
};
const BUDGET = 'engine.shadows.budget';
const MAP = 'engine.shadows.mapSize';
const CACHE = 'engine.shadows.cache';
const BUDGET_PARAMS = { every: { type: 'int', default: 1, min: 1, desc: 'redraw the shadow map every N frames; 1 = every frame' } };

function readBox(o) {
  const v = readParams(BOX, BOX_PARAMS, o), f = v.follow;
  if (!(f === false || f === 'focus' || f === 'camera' || f?.isObject3D || typeof f === 'function')) refuse(`${BOX}: follow must be 'focus' | 'camera' | an Object3D | () => Vector3 | false; got ${f?.root?.isObject3D ? 'a character: pass its .root' : String(f)}`);
  if (v.snap !== 'texel' && !(typeof v.snap === 'number' && v.snap >= 0)) refuse(`${BOX}: snap must be meters (a number, 0 = none) or 'texel'; got ${JSON.stringify(v.snap)}`);
  return v;
}

/** Where a light's box goes: the followed thing (and `ahead`), snapped. Shared by a game's light and the engine sun */
function boxCenter(e, light) {
  const f = new THREE.Vector3(), r = new THREE.Vector3(), u = new THREE.Vector3(), ahead = new THREE.Vector3(), last = new THREE.Vector3();
  let key = '', seen = false;
  /** @param {THREE.Vector3} at written with the center @param {THREE.Vector3} dir unit vector toward the light @param {any} o the box options */
  return (at, dir, o) => {
    const cam = e.camera, s = light.shadow;
    if (o.follow === 'camera') cam.getWorldPosition(at);   // world: a camera can hang on a rig or a player
    else if (o.follow?.isObject3D) o.follow.getWorldPosition(at);
    else if (typeof o.follow === 'function') at.copy(o.follow());
    else at.copy(e.focus);
    if (o.ahead) { cam.getWorldDirection(ahead); ahead.y = 0; if (ahead.lengthSq() > 1e-6) at.addScaledVector(ahead.normalize(), o.ahead); }
    let now;
    if (o.snap === 'texel') {
      // the light-space right and up axes (matching the shadow camera lookAt), rounded to one shadow pixel along each
      const sc = s.camera, texel = (sc.right - sc.left) / s.mapSize.x;
      f.copy(dir).negate();
      r.crossVectors(f, cam.up); if (r.lengthSq() < 1e-8) r.set(1, 0, 0); r.normalize();
      u.crossVectors(r, f);
      const a = Math.round(at.dot(r) / texel), b = Math.round(at.dot(u) / texel), c = at.dot(f);
      at.copy(r).multiplyScalar(a * texel).addScaledVector(u, b * texel).addScaledVector(f, c);
      now = a + ',' + b;
    } else {
      const g = o.snap || 1e-3;
      at.x = Math.round(at.x / g) * g; at.z = Math.round(at.z / g) * g;
      now = at.x + ',' + at.z;
    }
    // under a budget: redraw early only when the center left a quarter of the box (teleport, fast travel); otherwise the budget's own rhythm
    if (!seen) { last.copy(at); seen = true; }
    // a kept map is only good while the light stands still, so the box holds until the center left a quarter of it; moving things stay inside it meanwhile
    if (s.shadowNode?.isCachedShadowNode) { if (last.distanceToSquared(at) > (s.camera.right / 4) ** 2) last.copy(at); else at.copy(last); key = now; return; }
    if (!s.autoUpdate && now !== key && last.distanceToSquared(at) > (s.camera.right / 4) ** 2) s.needsUpdate = true;
    if (s.needsUpdate) last.copy(at);
    key = now;
  };
}

/** Write the half size on the light's shadow camera @param {any} light @param {number} ext */
function setExtent(light, ext) { const c = light.shadow.camera; c.left = c.bottom = -ext; c.right = c.top = ext; c.updateProjectionMatrix(); }

/**
 * A box on a game's light: position and target hold the placement, what the game writes stays the direction (see the header)
 * @param {any} e @param {any} light @param {object} first
 * @param {number} [back] meters the light stands behind the center, the shadow camera reaching extent past it; left out: where the game put it, its near / far as they are
 */
function gameBox(e, light, first, back) {
  let o = readBox(first), sized = false;
  const sc = light.shadow.camera, was = { left: sc.left, right: sc.right, top: sc.top, bottom: sc.bottom, near: sc.near, far: sc.far };
  const own = { position: light.position.clone(), target: light.target };
  const proxy = new THREE.Object3D(), placed = new THREE.Vector3(Infinity, 0, 0), at = new THREE.Vector3(), dir = new THREE.Vector3(), center = boxCenter(e, light);
  light.target = proxy;
  const size = ext => { setExtent(light, ext); sized = true; };
  if (back !== undefined) Object.assign(sc, { near: 1, far: back + o.extent });
  if (o.extent !== undefined) size(o.extent);
  const readGame = () => {
    if (light.target !== proxy) { own.target = light.target; light.target = proxy; }
    if (!light.position.equals(placed)) own.position.copy(light.position);
  };
  return {
    frame() {
      readGame();
      own.target.updateWorldMatrix(true, false);
      at.setFromMatrixPosition(own.target.matrixWorld);
      dir.copy(own.position).sub(at);
      const dist = dir.length();
      dir.normalize();
      if (o.follow !== false) center(at, dir, o);
      proxy.position.copy(at); proxy.updateMatrixWorld();   // not in the scene: nothing else refreshes it
      light.position.copy(at).addScaledVector(dir, back ?? dist); placed.copy(light.position);
    },
    set(next) { o = readBox({ ...o, ...next }); if (next.extent !== undefined) size(o.extent); },
    remove() {
      readGame();
      light.position.copy(own.position); light.target = own.target;
      if (sized) { Object.assign(sc, was); sc.updateProjectionMatrix(); }   // never sized: what the game wrote there is the game's
    },
  };
}

/**
 * The box on the engine's own sun: the real target moves, so engine.lights.sun.target.position reads as ever, and a direct write to it yields ('shadow.follow').
 * @param {any} e @param {any} light @param {object} first @param {(() => number)} [distance] how far the light sits from the center; left out: where it is now
 */
function sunBox(e, light, first, distance) {
  let o = readBox(first);
  const dir = new THREE.Vector3(), tp = light.target.position, center = boxCenter(e, light);
  const held = defineOwned(e, { id: 'shadow.follow', part: 'shadow', key: 'follow', read: () => tp.toArray(), objects: [light.target, tp],
    levels: { manual: 'engine.shadows.box(engine.lights.sun, { follow: false })', back: "engine.shadows.box(engine.lights.sun, { follow: 'focus' })" } });
  if (o.extent !== undefined) setExtent(light, o.extent);
  if (o.follow === false) held.manual(true);
  held.mark();
  return {
    frame() {
      if (e._cascades?.light === light) return;   // the cascades place it now; the box comes back with their remove()
      held.check();
      dir.subVectors(light.position, tp);
      const dist = distance?.() ?? dir.length();
      dir.normalize();
      if (held.on) center(tp, dir, o);
      light.position.copy(tp).addScaledVector(dir, dist);
      light.target.updateMatrixWorld();
      held.mark();
    },
    set(next) {
      o = readBox({ ...o, ...next });
      if (next.extent !== undefined) setExtent(light, o.extent);
      if ('follow' in next) held.manual(next.follow === false);   // the game said what it wants: a yield from before is over
    },
    get options() { return o; },
    remove() { dropOwned(e, [held]); },
  };
}

/** The update budget of one light: its own flags (three reads them on both renderers), so a light nobody handed in keeps redrawing */
function ownBudget(e, light, first) {
  const s = light.shadow, was = s.autoUpdate;
  let every = 1, n = 0, type = e.renderer.shadowMap.type;
  const set = o => { every = readParams(BUDGET, BUDGET_PARAMS, { every, ...o }).every; s.autoUpdate = every <= 1; s.needsUpdate = true; n = 0; };
  set(first);
  return {
    frame() {
      if (every <= 1) return;
      // a filter switch rebuilds the maps only of lights that draw that frame (WebGLShadowMap), so a light that skipped it would keep the old kind of map
      const t = e.renderer.shadowMap.type;
      if (t === type && ++n < every) return;
      type = t; n = 0; s.needsUpdate = true;
    },
    set,
    redraw() { s.needsUpdate = true; n = 0; },
    remove() { s.autoUpdate = was; s.needsUpdate = true; },
  };
}

/**
 * The master switch: the renderer's switch only. Both renderers stop drawing and sampling shadow maps when renderer.shadowMap.enabled is false (WebGL:
 * WebGLShadowMap.render returns and programs drop USE_SHADOWMAP; WebGPU: the shadow and light nodes check it), so no light's castShadow is touched: castShadow
 * stays the game's, and what the game set is what casts when they come back. Materials recompile once (the shadow define changes).
 * @param {any} e @param {boolean} on
 */
function switchShadows(e, on) {
  e.renderer.shadowMap.enabled = on;
  e.scene.traverse(o => { if (o.material) [].concat(o.material).forEach(m => { m.needsUpdate = true; }); });
  e.events.emit('settings:shadows', on);
}

/** The running handle's cascades. The WebGL half keeps what the game wrote apart from the placement; see the header */
function ownCascades(e, light, first, gameExtent = () => undefined) {
  let o = readOptions(first), c = null, key = '', own = null, box = null, sunSize = null;   // sunSize: puts the engine sun's box size back
  const proxy = new THREE.Object3D(), placed = new THREE.Vector3(), dir = new THREE.Vector3();
  const readGame = () => {
    if (light.target !== proxy) { own.target = light.target; light.target = proxy; }
    if (!light.position.equals(placed)) own.position.copy(light.position);
  };
  const off = () => {
    box?.remove(); box = null;
    sunSize?.(); sunSize = null;
    if (!c) return;
    if (own) { readGame(); light.position.copy(own.position); light.target = own.target; own = null; }
    dropCascades(e);
    c = null; key = '';
  };
  const sync = () => {
    const n = e.tier === 'low' ? o.low?.count ?? 1 : o.count;   // low tier: one map unless the game says so
    const want = (n > 1 ? [n, o.maxFar, o.fade, o.lightMargin, o.split] : [o.maxFar, o.lightMargin]).join('|');
    if (want === key) return;
    off();
    key = want;
    if (n <= 1) {
      // one map still has to cover what the cascades would: left alone it stays three's default 10 m box where the game put the light. Centered on the camera, as far
      // as maxFar each way and lightMargin behind, as the cascades reach. The engine sun is placed by a sky's box or the baseline follow (render/lights.js), so it only gets the size
      if (light !== e.lights?.sun) box = gameBox(e, light, { follow: 'camera', extent: o.maxFar, snap: 'texel' }, o.lightMargin + o.maxFar);
      else if (gameExtent() === undefined) {
        // the engine sun gets the same reach: its placement stays with the sky or the baseline follow, only the box grows from the 30 m baseline to maxFar (and goes back with remove).
        // Like gameBox: an extent the game set with engine.shadows.box(sun, { extent }) wins, and if it sets one meanwhile, remove leaves it as the game left it
        const sc = light.shadow.camera, was = { left: sc.left, right: sc.right, top: sc.top, bottom: sc.bottom }, ext = o.maxFar;
        setExtent(light, ext);
        sunSize = () => { if (sc.right !== ext) return; Object.assign(sc, was); sc.updateProjectionMatrix(); };
      }
      return;
    }
    c = createCascades(e, light, { ...o, cascades: n }, WHERE);
    if (c.isCascadeNode) return;
    own = { position: light.position.clone(), target: light.target };
    proxy.position.copy(light.target.position);
    placed.set(Infinity, 0, 0);
    light.target = proxy;
    e.scene.traverse(l => {   // on WebGL the cascade order is the order of the shadow-casting lights
      if (l.isDirectionalLight && l.castShadow && l.visible && !c.lights.includes(l)) warnOnce(`${WHERE}: DirectionalLight '${l.name || l.uuid.slice(0, 8)}' casts shadows too, which breaks the cascade order; set castShadow = false on it`);
    });
  };
  sync();   // first, so a request that throws (a bad split callback) returns no handle and leaves no listener behind
  const swap = onRendererSwap(e, () => { if (c?.isCascadeNode) { off(); sync(); } });   // fallback 'webgl': the shadow node has no meaning on the new renderer
  const tier = onTierChange(e, sync);   // the map count reads engine.tier: a preset switched while running rebuilds once (sync's key skips the rest)
  return {
    frame() {
      box?.frame();
      if (!c) return;
      const every = light.shadow.autoUpdate && e.renderer.shadowMap.autoUpdate ? 1 : 2;   // 2 = "not every frame": a budget, or a game's own autoUpdate = false
      if (c.isCascadeNode) { light.target.updateMatrixWorld(); c.frame(null, every); return; }
      readGame();
      own.target.updateWorldMatrix(true, false);
      dir.setFromMatrixPosition(own.target.matrixWorld).negate().add(own.position).normalize();
      c.frame(dir, every);
      placed.copy(light.position);
      proxy.updateMatrixWorld();   // not in the scene: nothing else refreshes it
    },
    set(next) { o = readOptions({ ...o, ...next }); sync(); },
    remove() { off(); swap.remove(); tier.remove(); },
    get csm() { return c; },
    /** the light while one map's box places it, else null */
    get boxed() { return box ? light : null; },
  };
}

/**
 * What the shadow pass draws, tested against what the game called static: a test on a mesh, or objects whose whole subtree is static. A batch hangs under the batching root, so it
 * answers for its originals, the objects the game knows: static when all of them are (one moving copy keeps the whole batch redrawing: slower, never a wrong shadow).
 * @param {any} e @param {any} v @returns {(object: any) => boolean}
 */
function staticTest(e, v) {
  const roots = new Set(typeof v === 'function' ? [] : [].concat(v ?? []));
  if (typeof v !== 'function' && (!roots.size || [...roots].some(o => !o?.isObject3D))) refuse(`${CACHE}(light, { static }): static is an Object3D, a list of them, or (mesh) => boolean; got ${v}. Example: engine.shadows.cache(sun, { static: mesh => mesh !== cars.mesh })`);
  const test = typeof v === 'function' ? v : o => { for (; o; o = o.parent) if (roots.has(o)) return true; return false; };
  return o => { const batch = e.batching?.byMesh.get(o); return batch ? batch.items.every(x => test(x.mesh)) : test(o); };
}

/** Kept shadows on one light. WebGLRenderer has no shadow node to reach, so there the light keeps drawing everything: same picture, no saving */
function ownCache(e, light, first) {
  const test = staticTest(e, first.static);
  if (!isWebGPU(e.renderer)) {
    warnOnce(`[threedog] ${CACHE}: works on WebGPURenderer only; on WebGLRenderer the light draws its full shadow every frame`);
    return { set() {}, redraw() {}, remove() {} };
  }
  const node = webgpuPart('shadowCache', CACHE).create(light, test);
  return { set: o => node.set(staticTest(e, o.static)), redraw: () => node.redraw(), remove: () => node.drop() };
}

function readOptions(o) {
  const v = readParams(WHERE, PARAMS, o);
  if (typeof v.split !== 'function' && !CASCADE_SPLITS.includes(v.split)) fail('split', v.split);
  const low = v.low?.count;
  if (v.low && (Object.keys(v.low).some(k => k !== 'count') || !(Number.isInteger(low) && low >= 1 && low <= 4))) fail('low', v.low);
  return v;
}

/** @param {any} e @param {{ owned: boolean }} o owned: the engine made the renderer (a game's own renderer keeps its shadow settings) */
export function defineShadows(e, { owned }) {
  let live = null, sky = null;
  const boxes = new Map(), budgets = new Map(), caches = new Map();
  if (owned) e.renderer.shadowMap.enabled = true;   // the placeholder sun casts, so things read as standing on the ground; the switch below turns it off
  // one point, because separate switches (an option, a method, the settings menu) each decided on their own and disagreed about what is on
  // `shown` = the value this switch last applied, compared instead of the renderer's flag: a direct write to renderer.shadowMap.enabled (the picture writers report it) is not undone by a change that left the shared value as it was; no change: no scene walk, no recompile
  let shown = shadowsOn(e);
  const point = e.stacks.define('shadows.enabled', { kind: 'value', base: shown, save: false, manual: "engine.mod('shadows.enabled', { owner, layer: 'system', set })",
    onChange: () => { const on = !!point.value(); if (on !== shown) switchShadows(e, shown = on); } });
  const hold = (map, light, h) => {
    const remove = () => { e.signal.removeEventListener('abort', remove); if (map.get(light) !== h) return; h.remove(); map.delete(light); };
    map.set(light, h);
    e.signal.addEventListener('abort', remove, { once: true });
    return remove;
  };
  e.shadows = {
    /**
     * Master shadow switch, true while shadows are drawn. Writes renderer.shadowMap.enabled only, never a light's castShadow; materials recompile once, so switch
     * on a menu, not per frame. A cutscene holds it with engine.mod('shadows.enabled', { owner, layer: 'system', set: false }); the settings menu restricts it.
     * @example engine.shadows.enabled = false;
     * @type {boolean}
     */
    get enabled() { return shadowsOn(e); },
    set enabled(v) {
      if (typeof v !== 'boolean') refuse(`engine.shadows.enabled: true or false; got ${JSON.stringify(v)}`);
      point.take({ owner: 'game', set: v });
    },
    /**
     * Cascaded shadows for a DirectionalLight: sharp near the camera, wide far away, following the camera. The light stays yours: color, intensity and shadow
     * values are read from it. Low-tier devices get one map, which follows the camera, unless `low: { count }` says otherwise. WebGPURenderer needs `import 'threedog/tsl'`.
     * @example
     * const sun = new THREE.DirectionalLight('#fff4e0', 3); sun.position.set(40, 80, 30); sun.castShadow = true; engine.scene.add(sun);
     * const shadows = engine.shadows.cascades(sun, { count: 3, maxFar: 150 });
     * shadows.set({ count: 2 }); shadows.remove();
     * @param {any} light a DirectionalLight in engine.scene, castShadow on (engine.lights.sun too)
     * @param {{ count?: number, maxFar?: number, split?: string | Function, fade?: boolean, lightMargin?: number, low?: { count: number } }} [options]
     * @returns {{ set(options: object): void, remove(): void, readonly light: any, readonly csm: any }}
     */
    cascades(light, options = {}) {
      if (!light?.isDirectionalLight) fail('light', light?.type ?? light);
      if (light.parent !== e.scene) fail('scene');
      if (!light.castShadow) fail('cast');
      if (live) fail('twice');
      if (caches.has(light)) refuse(`${WHERE}(light): this light keeps a cached shadow, which works on one plain map; call the cache handle's remove() first`);
      if (boxes.has(light) && light !== e.lights.sun) fail('boxed');
      // three's WebGL CSM shader (lights_fragment_begin) reads CSM_cascades[i] for every shadow-casting DirectionalLight, so one more than the cascades
      // indexes past the array and every patched material fails to compile. Refused here, by name, instead of a shader error on the first frame
      if (!e.renderer.isWebGPURenderer) {
        let other = null;
        e.scene.traverse(o => { if (!other && o.isDirectionalLight && o !== light && o.castShadow) other = o; });
        if (other) fail('other', other === e.lights.sun ? 'engine.lights.sun' : other.name || 'another DirectionalLight');
      }
      const set = ownCascades(e, light, options, () => boxes.get(light)?.options?.extent);
      live = set;
      const remove = () => { e.signal.removeEventListener('abort', remove); if (live !== set) return; set.remove(); live = null; };
      e.signal.addEventListener('abort', remove, { once: true });
      return { light, set: o => set.set(o), remove, get csm() { return set.csm; } };
    },
    /**
     * Keep a DirectionalLight's one shadow map around something that moves, so a wide world needs no giant map. The light keeps its direction: its position minus
     * its target, including what you write later. Nothing follows anything until you call this; remove() puts the light back. On engine.lights.sun under a sky it
     * changes the engine's own box, and remove() restores that.
     * @example
     * const box = engine.shadows.box(sun, { follow: player.root, extent: 40, snap: 'texel' });
     * box.set({ extent: 60 }); box.remove();
     * @param {any} light a DirectionalLight in engine.scene
     * @param {{ follow?: 'focus' | 'camera' | any | (() => any) | false, extent?: number, snap?: number | 'texel', ahead?: number }} [options]
     * @returns {{ set(options: object): void, remove(): void }}
     */
    box(light, options = {}) {
      if (!light?.isDirectionalLight) refuse(`${BOX}(light): needs a three.js DirectionalLight; got ${light?.type ?? light}`);
      if (light.parent !== e.scene) refuse(`${BOX}(light): the light must be a direct child of engine.scene first (the box is placed in world space): engine.scene.add(light)`);
      if (sky && light === e.lights.sun) {   // the engine's box under a sky: the game changes it, remove() gives its options back
        const h = sky, base = { ...h.options, extent: light.shadow.camera.right };   // the sky sized the camera itself, so its options may hold no extent
        h.set(options);
        return { set: o => h.set(o), remove: () => h.set(base) };
      }
      if (boxes.has(light)) refuse(`${BOX}(light): this light has a box already; change it with handle.set({ ... }) or call handle.remove() first`);
      if (e._cascades?.light === light || live?.boxed === light) refuse(`${BOX}(light): this light has cascades, and both place the light; call the cascades handle's remove() first`);
      const h = light === e.lights.sun ? sunBox(e, light, options) : gameBox(e, light, options);
      return { set: o => h.set(o), remove: hold(boxes, light, h) };
    },
    /**
     * Redraw a light's shadow map only every N frames: a third of the fill cost at every: 3. Other lights are not touched. A box or cascades on the same light
     * redraw early after a jump; call redraw() when something moved on a frame that matters. remove() puts light.shadow.autoUpdate back.
     * @example
     * const budget = engine.shadows.budget(sun, { every: 3 });
     * budget.redraw(); budget.set({ every: 1 }); budget.remove();
     * @param {any} light any three.js light with a shadow
     * @param {{ every?: number }} [options]
     * @returns {{ set(options: { every?: number }): void, redraw(): void, remove(): void }}
     */
    budget(light, options = {}) {
      if (!light?.isLight || !light.shadow) refuse(`${BUDGET}(light): needs a three.js light with a shadow; got ${light?.type ?? light}`);
      if (budgets.has(light)) refuse(`${BUDGET}(light): this light has a budget already; change it with handle.set({ every }) or call handle.remove() first`);
      const h = ownBudget(e, light, options);
      return { set: o => h.set(o), redraw: () => h.redraw(), remove: hold(budgets, light, h) };
    },
    /**
     * Keep the shadows of what does not move: static casters are drawn once into a second depth map, and each shadow frame copies it and draws only the rest. Off until
     * called; everything not named static keeps redrawing, so forgetting one costs time, never a wrong shadow. A static object that moves, hides or leaves needs redraw();
     * an InstancedMesh whose instances changed, or that left the scene (a batch too), redraws by itself.
     * A moving light redraws everything, so a turning sun saves nothing. One plain map on WebGPURenderer; WebGLRenderer and the WebGL2 backend draw everything, with a warning.
     * @example
     * const kept = engine.shadows.cache(sun, { static: mesh => mesh !== cars.mesh });
     * kept.redraw(); kept.set({ static: town }); kept.remove();
     * @param {any} light a DirectionalLight without cascades
     * @param {{ static: any }} options an Object3D (its whole subtree), a list of them, or (mesh) => boolean; a batch counts as static when all its originals do
     * @returns {{ set(options: { static: any }): void, redraw(): void, remove(): void }}
     */
    cache(light, options) {
      if (!light?.isDirectionalLight) refuse(`${CACHE}(light): needs a three.js DirectionalLight; got ${light?.type ?? light}`);
      if (caches.has(light)) refuse(`${CACHE}(light): this light has a cache already; change it with handle.set({ static }) or call handle.remove() first`);
      if (e._cascades?.light === light) refuse(`${CACHE}(light): this light has cascades, and the cache works on one plain map; call the cascades handle's remove() first`);
      const h = ownCache(e, light, options ?? {});
      return { set: o => h.set(o), redraw: () => h.redraw(), remove: hold(caches, light, h) };
    },
    /**
     * Change a light's shadow resolution at any time, with cascades every cascade's map: raise it for one shot, lower it from a settings menu. Before the first
     * draw light.shadow.mapSize.set() is all it takes; after it a map exists at the old size, and three allocates on WebGL only while shadow.map is null.
     * The cascades copied the light's size only when built, so a later change reached the nearest one at most. WebGPU's shadow node resizes its own map on every redraw.
     * @example engine.shadows.mapSize(sun, 4096);
     * @param {any} light any three.js light with a shadow
     * @param {number} width pixels @param {number} [height] pixels, default width
     * @returns {void}
     */
    mapSize(light, width, height = width) {
      if (!light?.isLight || !light.shadow) refuse(`${MAP}(light, width): needs a three.js light with a shadow; got ${light?.type ?? light}`);
      if (!(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0)) refuse(`${MAP}(light, width, height?): sizes are whole pixels above 0; got ${JSON.stringify([width, height])}`);
      const gpu = isWebGPU(e.renderer), c = e._cascades?.light === light ? e._cascades.lights.filter(l => l !== light) : [];
      let changed = false;
      for (const sh of [light.shadow, ...c.map(l => l.shadow)]) {
        if (sh.mapSize.x === width && sh.mapSize.y === height) continue;
        sh.mapSize.set(width, height); changed = true;
        if (!gpu) { sh.map?.dispose(); sh.map = null; }
      }
      if (changed) setShadowUpdate(e.renderer, e.scene, { now: true });   // a resized map is empty until redrawn (a budget)
    },
    /**
     * Let cascades patch a ShaderMaterial (lights: true) of yours. Built-in lit materials need nothing.
     * @example engine.shadows.include(myLitShaderMaterial);
     * @param {any} material @returns {any} the material
     */
    include(material) { return includeInCascades(e, material); },
    /** three's CSM object of the cascades on now (the shadow node on WebGPURenderer); null when off @type {any} */
    get csm() { return e._cascades ?? null; },
    /** @internal a sky's box on the engine's own sun: the engine calling its own entry on its own placeholder @param {object} options @param {() => number} distance */
    sunBox(options, distance) {
      const light = e.lights.sun, h = sky = sunBox(e, light, options, distance), remove = hold(boxes, light, h);
      return { remove() { sky = null; remove(); } };
    },
    /** @internal the render step, after every game hook of the frame. Budgets first: the placements read what they asked for */
    _frame() {
      for (const b of budgets.values()) b.frame();
      for (const b of boxes.values()) b.frame();
      live?.frame();
    },
  };
  // describe().owned shows which of the game's own materials carry the csm patch (built-in lit types the game made are patched too; render/cascades.js)
  ownedRow(e, 'shadow.csm', () => {
    const g = e._cascades?.gameMaterials();
    return g?.length ? { part: 'shadow', key: 'csm', writer: 'engine (csm patch on your built-in lit materials; recipes/45)', materials: g } : undefined;
  });
}
