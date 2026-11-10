// Plain three.js lights are adopted (docs/plans/2026-11-03-slot-map.md, lights row): a `new THREE.PointLight` / `SpotLight` the game puts anywhere
// in the scene gets what a lightPool light gets, without the game naming it to the engine:
//   · counted: engine.budget categories `lights` (visible point + spot lights, pooled ones included: every one costs every lit pixel) and
//     `shadowLights` (those casting, 0 while renderer.shadowMap.enabled is off); `shadowMaps` (every map the renderer draws, sun and cascades included, a point
//     light six) and `shadowMapSize` (the largest side) carry no default limit: the game picks them, usually from engine.tier; describe().render.lights lists the game's lights with the file:line that added them
//   · the idle-shadow rule: a shadow-casting light at intensity 0 stops redrawing its shadow map (a point light is six shadow passes a frame
//     for a light that lights nothing) and redraws once it is lit again. This is the one setting of a game light the engine writes, so it is
//     kept to what it took: only a light whose shadow.autoUpdate was on is idled; only a light the engine idled gets autoUpdate back; a
//     game that writes autoUpdate itself while the light is idled (its own redraw plan) gets the light handed back and never idled again;
//     light.userData.idleShadow = false opts one light out; describe().render.lights says shadowIdled: true while the engine holds one.
//     Listed in threePatches as 'light-idle-shadow' (off() stops it for every light).
// What stays the game's: color, intensity, distance, castShadow (turning shadows off is the renderer's switch, render/shadows.js), the shadow map size and bias. The engine never writes them (P1).
// lightPool stays the optional helper for "many lamps, few real lights": that trade-off is a game decision the engine cannot guess.
// Cost: a scene visitor (no walk per frame); per frame one loop over the shadow-casting game lights, usually zero to three.
// RectAreaLight: three leaves its LTC tables (314 KB of numbers) to the game, and a game that forgets gets a failed shader build on WebGPU and a black
// light on WebGL. The first one to enter the scene loads them, once per page (three keeps them in statics too). The import is async and a frame may draw
// first, so WebGPU gets same-shaped stand-ins at once (an identity matrix: the diffuse part is exact, the shine is missing for that frame) that the real
// numbers are then copied into. Area lights have no shadows in three, and light only MeshStandard / MeshPhysical materials.
import { DataTexture, FloatType, HalfFloatType, RGBAFormat, UVMapping, ClampToEdgeWrapping, LinearFilter, NearestFilter } from 'three';
import { sceneVisitor } from './sceneDelta.js';
import { moduleOwnerOf } from './things.js';
import { notePatch, patchOn } from './threePatches.js';
import { shadowMaps, webgpuPartOrNull } from '../../render/backend.js';
import { warnOnce, fmt } from '../base/validate.js';
import { MANY } from '../inspect/lightWatch.js';
import { isShown } from '../base/util.js';


// Dev warning, once: three.js adds every light up (by design, the engine never changes that), so a game light next to the engine's still-lit
// placeholder sun and hemisphere is brighter than the game meant. Warning only; no warning when the placeholders are gone (lights: false or removed).
const ADDED_UP = "The game added its own light ('{what}') while the engine's placeholder lights (engine.lights.sun, engine.lights.hemi) are still in the scene, " +
  "so the two add up and the picture is brighter than your light alone. Fix: createEngine({ lights: false }) and write the whole picture yourself, " +
  "or keep the placeholders on purpose and ignore this. (three.js lights add up by design; nothing was changed.)";
const placeholderOn = e => ['sun', 'hemi'].some(k => { const l = e.lights?.[k]; return l?.parent && l.visible && l.intensity > 0; });

/** The engine module that owns o (it or an ancestor carries engineOwned), else null */
function engineOwner(o) { for (let p = o; p; p = p.parent) { const m = moduleOwnerOf(p); if (m) return m; } return null; }

let areaTables = false;   // page-wide, as three's own tables are (R29 ALLOW)
function loadAreaTables() {
  if (areaTables) return;
  areaTables = true;
  const node = webgpuPartOrNull('classes')?.RectAreaLightNode, size = 64 * 64 * 4;
  const standIn = (half, matrix) => {
    const data = half ? new Uint16Array(size) : new Float32Array(size);
    if (matrix) for (let i = 0; i < size; i += 4) data[i] = data[i + 3] = half ? 0x3c00 : 1;   // 0x3c00 is 1 as a half float
    const t = new DataTexture(data, 64, 64, RGBAFormat, half ? HalfFloatType : FloatType, UVMapping, ClampToEdgeWrapping, ClampToEdgeWrapping, LinearFilter, NearestFilter, 1);
    t.needsUpdate = true;
    return t;
  };
  /** @type {Record<string, any> | null} */
  const stand = node ? { LTC_FLOAT_1: standIn(false, true), LTC_FLOAT_2: standIn(false, false), LTC_HALF_1: standIn(true, true), LTC_HALF_2: standIn(true, false) } : null;
  if (stand) node.setLTC(stand);
  Promise.all([import('three/addons/lights/RectAreaLightUniformsLib.js'), import('three/addons/lights/RectAreaLightTexturesLib.js')]).then(([{ RectAreaLightUniformsLib }, { RectAreaLightTexturesLib: lib }]) => {
    RectAreaLightUniformsLib.init();   // WebGLRenderer reads them from UniformsLib, the WebGPU node from the stand-ins
    for (const k in stand) { stand[k].image.data.set(lib[k].image.data); stand[k].needsUpdate = true; }
  }, err => {
    areaTables = false;
    for (const k in stand) stand[k].dispose();
    warnOnce(`RectAreaLight: three's LTC tables did not load (${err?.message ?? err}): on WebGPU the light gives diffuse light only, no shine; on WebGL none. Loading is tried again when a RectAreaLight next enters the scene`);
  });
}

/** @param {any} e */
export function watchGameLights(e) {
  const all = new Set(), game = new Set(), idled = new WeakSet(), handed = new WeakSet();
  // The one place autoUpdate goes back to the game: only a light the engine idled, and only if the game has not written the value since (then it is the game's)
  const giveBack = l => { if (!idled.delete(l)) return; if (!l.shadow.autoUpdate) { l.shadow.autoUpdate = true; l.shadow.needsUpdate = true; } };
  const view = sceneVisitor(e.scene, {
    enter(o) {
      if (o.isLight && !o.isLightProbe && !o.isLightProbeGrid && o !== e.lights?.sun && o !== e.lights?.hemi && !o.userData.fixedCount && !engineOwner(o) && placeholderOn(e))
        warnOnce(fmt(ADDED_UP, { what: o.name || o.type }), 'game-light-adds-up');
      if (o.isRectAreaLight) loadAreaTables();
      if (!o.isPointLight && !o.isSpotLight) return;
      all.add(o);
      if (!o.userData.fixedCount && !engineOwner(o)) game.add(o);
    },
    leave(o) {
      all.delete(o); game.delete(o);
      giveBack(o);   // leaves as the game left it
    },
  });
  const count = (fn) => { view.sync(); let n = 0; for (const l of all) if (fn(l)) n++; return n; };
  e.budget.metric('lights', () => count(l => isShown(l) && l.intensity > 0), { limit: MANY });
  e.budget.metric('shadowLights', () => e.renderer.shadowMap.enabled ? count(l => isShown(l) && l.castShadow && l.intensity > 0) : 0);
  const maps = () => shadowMaps(e.renderer, e.scene);
  e.budget.metric('shadowMaps', () => maps().reduce((n, m) => n + m.faces, 0));
  e.budget.metric('shadowMapSize', () => maps().reduce((n, m) => Math.max(n, m.shadow.mapSize.x, m.shadow.mapSize.y), 0));
  e._gameLights = {
    /** The game's own point / spot lights (not a module's, not a pool's) */
    list() { view.sync(); return [...game]; },
    /** Every point / spot light in the scene, modules' and pools' too; a live set, for reading */
    all() { view.sync(); return all; },
    /** Catch up with what entered the scene: before a compile or a draw outside the loop, so a RectAreaLight has its tables first */
    sync() { view.sync(); },
    /** Before each render (loop.js): the idle-shadow rule */
    frame() {
      view.sync();
      for (const l of game) {
        if (!l.castShadow && !idled.has(l)) continue;
        const s = l.shadow;
        const opted = !patchOn('light-idle-shadow') || l.userData.idleShadow === false;
        if (idled.has(l)) {
          if (s.autoUpdate) { idled.delete(l); handed.add(l); }   // the game turned redraws on itself while idled: its light from now on
          else if (l.intensity > 0 || !l.castShadow || opted) giveBack(l);   // put back what was taken
        } else if (l.castShadow && l.intensity <= 0 && s.autoUpdate && !opted && !handed.has(l)) { s.autoUpdate = false; idled.add(l); }
      }
    },
    /** Engine dispose: stop watching the scene and hand every idled light back (a light may outlive the engine in another scene) */
    dispose() { view.remove(); for (const l of game) giveBack(l); },
    /** Whether the engine holds this light's shadow redraw now (describe) */
    idled: l => idled.has(l),
  };
}
/** @internal Every point / spot light in the scene (a live set, for reading; empty before the watch starts): for modules, which do not reach into e._gameLights */
export function pointSpotLights(e) { return e._gameLights?.all() ?? EMPTY; }
const EMPTY = new Set();

notePatch('light-idle-shadow', "shadow.autoUpdate of the game's own shadow-casting point / spot lights: off while intensity is 0, back on when lit (core/scene/gameLights.js)",
  () => {}, { scope: 'objects in the scene', lost: 'a casting light at intensity 0 redraws its shadow map every frame, as in plain three.js' });
