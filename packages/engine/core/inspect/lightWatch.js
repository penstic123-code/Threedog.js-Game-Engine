// Dev-only check (called from loop.js after each render once the engine is ready): warn when three.js compiled new shader programs
// when the light layout also differs from the last observation (not proven to be the same frame: the layout is only reread when programs grow). Why: three.js builds one program per material for each light setup, so a light added,
// removed or hidden mid-play compiles again and freezes that frame (a dungeon game froze ~450 ms when a torch turned its light on).
// engine.start() already compiled everything for the startup lights; this names the cause when a game changes them afterwards.
// Cost: one array-length compare per frame; the scene walk that counts lights runs only in a frame whose program count went up (rare).
import { warnOnce, fmt } from '../base/validate.js';
import { coded } from '../base/errorHints.js';
import { programCount } from '../../render/backend.js';

export const MANY = 8;   // above this many real-time lights every material's fragment shader loops over all of them: mobile GPUs slow down first

const STRINGS = {
  many: '{n} real-time lights are in the scene (more than {max}, not counting lightPool lights). Every lit material pays for every light in every pixel. ' +
    'For torches, lamps and muzzle flashes use engine.use(lightPool({ point: 8 })) and engine.lightPool.add(torch, {...}): a fixed set of real lights lit for the nearest sources',
  changed: 'Shader programs were compiled during play ({from} -> {to}) and, compared with the last observation, the light layout also changed ({was} -> {now}). ' +
    'three.js compiles every material again for a new light setup, so adding, removing or hiding a light mid-game freezes a frame. ' +
    'Use engine.use(lightPool({ point: 8 })) and engine.lightPool.add(torch, {...}) for many lights, or fade a fixed set with intensity ' +
    '(recipes/09-materials-lights-models.md §1b)',
};

/** Visible lights by the kinds three.js counts in its light setup (ambient and probes do not change programs), as one comparable string */
export function lightSetup(scene) {
  let point = 0, spot = 0, dir = 0, hemi = 0, rect = 0;
  scene.traverseVisible(o => {
    if (!o.isLight) return;
    if (o.isPointLight) point++; else if (o.isSpotLight) spot++; else if (o.isDirectionalLight) dir++;
    else if (o.isHemisphereLight) hemi++; else if (o.isRectAreaLight) rect++;
  });
  return `point ${point}, spot ${spot}, directional ${dir}, hemisphere ${hemi}, rect ${rect}`;
}

/** Lights not kept at a fixed count. A module that holds a fixed set of lights and moves them around (a light pool: the recommended fix) marks
 * each with userData.fixedCount = true; core reads the mark, not a module's naming scheme, so any pool, built-in or the game's, counts the same */
function countLoose(scene) {
  let c = 0;
  scene.traverseVisible(o => { if (o.isLight && !o.isAmbientLight && !o.isLightProbe && !o.isLightProbeGrid && !o.userData.fixedCount) c++; });
  return c;
}

/** @param {any} e the engine (dev and ready only: the caller checks) */
export function watchLights(e) {
  const n = programCount(e.renderer);
  if (n == null) return;
  const first = !e._lightWatch;
  // changes and setup: the picture check reads them (packages/tools/picture/hints-scene.mjs 'light-layout')
  const w = /** @internal the picture check reads it */ e._lightWatch ??= { n, lights: lightSetup(e.scene), changes: [], setup: () => lightSetup(e.scene) };
  // the scene walk runs on the first observation and when programs grow (a light was added), never on a quiet frame
  if (!w.manyDone && (first || n > w.n)) {
    const c = countLoose(e.scene);
    if (c > MANY) { w.manyDone = true; warnOnce(coded('many-lights', fmt(STRINGS.many, { n: String(c), max: String(MANY) }))); }
  }
  if (n <= w.n) { w.n = n; return; }       // fewer programs (materials disposed) or none new: nothing to say
  const lights = lightSetup(e.scene);
  if (lights !== w.lights) {
    w.changes.push({ from: w.lights, to: lights, programs: n - w.n });
    // the layout is only reread when programs grow, so we say "since the last observation", never "in this frame"
    warnOnce(coded('light-recompile', fmt(STRINGS.changed, { from: String(w.n), to: String(n), was: w.lights, now: lights })));
  }
  w.n = n; w.lights = lights;
}
