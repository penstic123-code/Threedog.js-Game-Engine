// Light sources: what the game adds to the pool, and the handle it gets back. pool is the state lightPool() shares with slots.js.
import * as THREE from 'three';
import { fmt } from '../../core/base/validate.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { vec3 } from '../../core/base/math.js';
import { codedError } from '../../core/base/errorHints.js';
import { DUSK, nightOf } from '../../render/daylight.js';

const ADD_KEYS = ['name', 'type', 'color', 'intensity', 'distance', 'decay', 'priority', 'castShadow', 'angle', 'penumbra', 'target', 'flicker', 'glow', 'dusk'];
const SET_KEYS = ['position', ...ADD_KEYS.filter(k => k !== 'type' && k !== 'castShadow')];   // the kind of light a source needs is fixed when it is added
const STRINGS = {
  type: "lightPool.add(): type must be 'point' or 'spot', got ",
  noSlot: "lightPool.add(): a '{type}' source but lightPool({ {type}: 0 }) has no {type} lights; give lightPool() a count, e.g. lightPool({ {type}: 2 })",
  dusk: 'lightPool.add(): dusk is true (the glow default, {d}), false, or the daylight (0..1; 0 = on only while daylight is 0) below which the source fades in; got ',
};

/** The material a glow stand-in drives, and which of its numbers: emissiveIntensity when it has one (emissive mesh), else opacity (halo sprite) */
function glowOf(g) {
  if (!g) return null;
  let m = g.isMaterial ? g : null;
  if (!m) g.traverse?.(o => { if (!m && o.material && !Array.isArray(o.material)) m = o.material; });
  if (!m) return null;
  const key = 'emissiveIntensity' in m ? 'emissiveIntensity' : 'opacity';
  return { m, key, base: m[key], k: -1 };
}

// 1 for a source that ignores the time of day, else the night factor (0 by day, 1 at night) for its dusk
const nightK = (pool, src) => src.dusk === null ? 1 : nightOf(pool.daylight, src.dusk);
export const litOf = (pool, src) => src.intensity * nightK(pool, src);
/** Put a source's stand-in back as it was added */
export function restoreGlow(src) { const g = src.glow; if (g) { g.m[g.key] = g.base; g.k = -1; } }
export function setGlow(pool, src, k) {
  const g = src.glow;
  if (!g) return;
  k *= nightK(pool, src);   // a lamp that is off by day has its stand-in off too
  if (g.k === k) return;
  g.k = k; g.m[g.key] = g.base * k;
}

function apply(pool, src, o) {
  if ('color' in o) src.color.set(o.color);
  for (const k of ['intensity', 'distance', 'decay', 'priority', 'angle', 'penumbra', 'flicker', 'target', 'name']) if (k in o) src[k] = o[k];
  if ('dusk' in o) {
    const d = o.dusk === true ? DUSK : o.dusk === false || o.dusk == null ? null : o.dusk;
    if (d !== null && !(typeof d === 'number' && d >= 0 && d <= 1)) throw codedError('lightpool-dusk', fmt(STRINGS.dusk, { d: String(DUSK) }) + JSON.stringify(o.dusk), TypeError);
    src.dusk = d;
  }
  if ('glow' in o) { restoreGlow(src); src.glow = glowOf(o.glow); setGlow(pool, src, src.slot ? 1 - src.slot.w : 1); }
  pool.timer = Infinity;   // a changed source is reconsidered on the next frame, not after `every`
}

function handleOf(pool, src) {
  const h = {
    /** The real light lighting this source now (null while it has none) */
    get light() { return src.slot?.light ?? null; },
    /** How much of its light it has, 0-1 (fades when lights move between sources) */
    get weight() { return src.slot?.w ?? 0; },
    /** Change the source: { position, color, intensity, distance, decay, priority, angle, penumbra, target, flicker, glow, name } */
    set(patch) {
      readParams('lightPool.add().set()', keysSchema(SET_KEYS), patch);
      if ('position' in patch) { const p = patch.position; src.follow = p?.isObject3D ? p : null; src.pos = p?.isObject3D ? null : vec3(p); }
      apply(pool, src, patch);
      return h;
    },
    /** Unregister: its light fades out and goes to another source; the stand-in is put back as it was (safe to call twice) */
    remove() {
      if (src.removed) return;
      src.removed = true;
      const i = pool.sources.indexOf(src); if (i >= 0) pool.sources.splice(i, 1);
      if (src.slot) src.slot.want = 0;
      restoreGlow(src);
      pool.timer = Infinity;
    },
  };
  return h;
}

/** lightPool.add */
export function addSource(pool, position, o) {
  readParams('lightPool.add()', keysSchema(ADD_KEYS), o);
  const type = o.type ?? 'point';
  if (type !== 'point' && type !== 'spot') throw codedError('light-type', STRINGS.type + JSON.stringify(type), TypeError);
  if (!pool.groups.some(g => g.type === type)) throw codedError('light-type', fmt(STRINGS.noSlot, { type }), TypeError);
  const src = { index: pool.seq++, type, castShadow: !!o.castShadow, follow: position?.isObject3D ? position : null, pos: position?.isObject3D ? null : vec3(position),
    color: new THREE.Color(0xffffff), intensity: 1, distance: 10, decay: 2, priority: 1, angle: Math.PI / 4, penumbra: 0.3, target: null, flicker: null, name: null,
    glow: null, dusk: null, slot: null, score: 0, removed: false };
  apply(pool, src, o);
  pool.sources.push(src);
  return handleOf(pool, src);
}
