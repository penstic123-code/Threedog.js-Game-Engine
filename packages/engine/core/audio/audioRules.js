// Audio rule data: conditions and measures.
// The data side of audio rules: condition keys, measures (comparable numbers), data volumes, and the audio of content packs.
// Split out of Audio.js so the bus / playback side and the rule side each stay readable in one go.
//
// Why measures: a content pack is data, so `when: e => e.calendar.daylight > 0.15` cannot live in it. A module registers the number once
// (calendar: daylight; weather: rain, snow, wind; ambience: nearWater, altitude) and data compares it: `when: { daylight: { gt: 0.15 } }`,
// `volume: { base: 0.05, add: { wind: 0.08 }, max: 0.5 }`. Code may still pass functions (createEngine({ audio }), ambience.add).
import { codedError, coded } from '../base/errorHints.js';
import { DEV, fmt, missingText, warnOnce } from '../base/validate.js';
import { readParams, keysSchema } from '../base/params.js';
import { isObject } from '../base/util.js';

const COMPARE = { gt: (x, v) => x > v, gte: (x, v) => x >= v, lt: (x, v) => x < v, lte: (x, v) => x <= v };
const VOLUME_KEYS = ['base', 'add', 'min', 'max'];
/** Keys of a content pack's audio table */
const PACK_KEYS = ['sounds', 'ambience', 'music', 'footsteps'];
/** Looks like a file, not an asset name (same test as content models, plus audio extensions) */
const PATH = /[/\\]|\.(mp3|ogg|wav|m4a|aac|flac|webm|opus)$/i;

const STRINGS = {
  clash: "audio: '{name}' is both a condition key and a measure; one name is one thing. Rename one (measures are numbers compared with { gt, lt, gte, lte })",
  compare: "audio rule when.{key}: a measure is compared with { gt, lt, gte, lte } (e.g. { {key}: { gt: 0.15 } }), got {got}",
  noMeasure: 'audio volume add.{key}: no measure named {key}{known}. calendar() adds daylight, weather() rain / snow / wind, ambience() nearWater / altitude; '
    + 'or engine.audio.measure(name, e => number)',
  fn: 'content {from}: audio.{what} holds a function, so the rule was dropped. Content is data: compare a measure ({ daylight: { gt: 0.15 } }), '
    + 'write volume as { base, add: { rain: 0.22 }, min, max }, or register a value with engine.audio.measure(name, fn)',
  path: "content {from}: audio.{what} names the file \"{src}\". Content names sounds only: register the file in an asset pack "
    + "(engine.assets.manifest({ sounds: { {short}: '{src}' } })) and write '{short}'",
  codeToo: "audio.{table}.{name} is defined both in createEngine({ audio }) and in content {from}. One name, one place: keep it in the content pack "
    + '(data) or in code (when it needs a function), not both',
};
const hasFn = v => typeof v === 'function' || (v !== null && typeof v === 'object' && Object.values(v).some(hasFn));

/** Does a measure comparison hold? cmp = { gt: 0.15 } / { lt: 0.2, gte: 0 } (every key must hold) */
function compare(audio, key, cmp) {
  const ok = isObject(cmp) && Object.keys(cmp).length && Object.keys(cmp).every(k => k in COMPARE);
  if (!ok) { warnOnce(fmt(STRINGS.compare, { key, got: JSON.stringify(cmp) })); return false; }
  const x = audio.measures.get(key)(audio.engine);
  return Object.entries(cmp).every(([k, v]) => COMPARE[k](x, v));
}

/** audio.matches body: an object needs every key to hold (condition keys first, then measures); a function gets (engine, ...extra) */
export function matchesWhen(audio, when, extra) {
  if (when == null) return true;
  if (typeof when === 'function') return !!when(audio.engine, ...extra);
  for (const [k, v] of Object.entries(when)) {
    const test = audio.conditions.get(k);
    if (test) { if (!test(v, audio.engine)) return false; continue; }
    if (audio.measures.has(k)) { if (!compare(audio, k, v)) return false; continue; }
    warnOnce(coded('unknown-name', missingText('condition', k, [...audio.conditions.keys(), ...audio.measures.keys()])
      + '. time comes from calendar(), weather from weather(), zone from triggers(), measures (daylight, rain, nearWater...) from their modules; or write when: e => ...'));
    return false;
  }
  return true;
}

/** audio.volumeOf body: a number, a function of the moment, or data { base, add: { measure: factor }, min, max }; missing = 1 */
export function volumeOf(audio, v, extra) {
  if (v == null) return 1;
  if (typeof v === 'number') return v;
  if (typeof v === 'function') return v(audio.engine, ...extra);
  readParams('audio rule volume', keysSchema(VOLUME_KEYS), v);
  let x = v.base ?? 0;
  for (const [k, f] of Object.entries(v.add || {})) {
    const m = audio.measures.get(k);
    if (!m) { warnOnce(fmt(STRINGS.noMeasure, { key: k, known: audio.measures.size ? ` (measures: ${[...audio.measures.keys()].join(', ')})` : '' })); continue; }
    x += m(audio.engine) * f;
  }
  return Math.min(v.max ?? Infinity, Math.max(v.min ?? -Infinity, x));
}

/** audio.measure / audio.condition share one namespace (a rule key is looked up in both) */
export function checkRuleName(audio, name, isMeasure) {
  if (isMeasure ? audio.conditions.has(name) : audio.measures.has(name)) throw codedError('audio-name-clash', fmt(STRINGS.clash, { name }));
}

/** Variants / src of a sounds entry, for the path check */
const srcsOf = v => typeof v === 'string' ? [v] : Array.isArray(v) ? v : v && typeof v === 'object' ? [v.src].flat().filter(Boolean) : [];
const trackSrcs = t => typeof t === 'string' ? [t] : t && typeof t === 'object' ? [t.url, ...(t.stems || []).map(s => s?.url)].filter(Boolean) : [];

/**
 * Normalize one content pack's audio table (engine.audio.contentPack): data only. A rule holding a function is dropped with a dev warning;
 * a file path warns (dev) and still plays; a sound / footstep name the game also defines in code is an error.
 * Returns { sounds, footsteps, ambience, music: { tracks, rules } } with the dropped rules gone.
 */
export function packAudio(audio, data, from) {
  readParams(`content ${from} audio`, keysSchema(PACK_KEYS), data);
  const music = data.music || {};
  readParams(`content ${from} audio.music`, keysSchema(['tracks', 'rules']), music);
  const tables = { sounds: data.sounds, footsteps: data.footsteps, tracks: music.tracks };
  for (const [table, map] of Object.entries(tables)) for (const name of Object.keys(map || {}))
    if (audio._code[table].has(name)) throw codedError('audio-name-clash', fmt(STRINGS.codeToo, { table: table === 'tracks' ? 'music.tracks' : table, name, from }));
  if (DEV) {
    const path = (what, src) => { if (typeof src === 'string' && PATH.test(src)) warnOnce(fmt(STRINGS.path, { from, what, src, short: src.split(/[/\\]/).pop().replace(/\.\w+$/, '') })); };
    for (const [n, v] of Object.entries(data.sounds || {})) for (const s of srcsOf(v)) path(`sounds.${n}`, s);
    for (const [n, t] of Object.entries(music.tracks || {})) for (const s of trackSrcs(t)) path(`music.tracks.${n}`, s);
  }
  // a dropped rule never plays: content is data, and a function there is a mistake the static check (content-check) reports as an error
  const dataOnly = (list, what) => (list || []).filter((r, i) => {
    if (!hasFn(r)) return true;
    warnOnce(fmt(STRINGS.fn, { from, what: `${what}[${i}]` })); return false;
  });
  const sounds = Object.fromEntries(Object.entries(data.sounds || {}).filter(([n, v]) => !hasFn(v) || (warnOnce(fmt(STRINGS.fn, { from, what: `sounds.${n}` })), false)));
  return { sounds, footsteps: { ...data.footsteps }, ambience: dataOnly(data.ambience, 'ambience'), music: { tracks: { ...music.tracks }, rules: dataOnly(music.rules, 'music.rules') } };
}

/** Re-apply every active duck to the bus duck nodes, fading over fade seconds (Audio._applyDucks) */
export function applyDucks(a, fade) {
  if (!a.ctx) return;
  const t = a.ctx.currentTime;
  for (const [bus, node] of Object.entries(a._duckNodes)) {
    let v = 1; for (const d of a._ducks) v *= d.levels[bus] ?? 1;
    const g = node.gain; g.cancelScheduledValues(t);
    if (fade > 0) { g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(v, t + fade); } else g.value = v;
  }
}

/** What is playing: bus levels, duck multipliers, live voices per sound name (Audio.info) */
export function audioInfo(a) {
  const ducks = {}, voices = {};
  // the TARGET multiplier (every active duck's level multiplied), not the node's gain right now: a duck with a fade ramps on the audio clock, which stands
  // still on a headless page, so the node would read 1 for ever there. The target is what the game asked for, and what the ramp ends at
  for (const b of Object.keys(a._duckNodes)) { let v = 1; for (const d of a._ducks) v *= d.levels[b] ?? 1; ducks[b] = +v.toFixed(3); }
  for (const [name, list] of a._voices) { const n = list.filter(v => v.playing).length; if (n) voices[name] = n; }
  return { running: a.running, state: a.state, levels: { ...a.levels }, ducks, voices, ...(a._reverb ? { reverb: a._reverb.info } : {}) };
}
