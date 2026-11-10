// engine.describeText(): write describe() as plain English for an AI to read, summary first to save context.
//   describeText()                       summary (at most 30 lines): standard lines, the 5 nearest things, one line per module with its key counts and state
//   describeText({ path: 'world.byKind' }) one part of describe() as JSON (a dotted path)
//   describeText({ full: true })          every nearby thing and every module's full data
// describe() itself (the object) is always complete.
// Always English, whatever the locale: it is developer output, not player-facing. Ground and weather are named by their ids
// (ground / weather.name), not the translated groundName / weather.label: under a zh-CN game those printed "默认" in an English line.
const STRINGS = {
  head: '[Game state] running {s} s{flags}',
  actions: 'Can do (engine.ops): {list}',
  error: '[Error, gameplay frozen] {where}: {message}', errorAt: ' ({at})',
  errorHint: ' | Code: {code} | Fix: {fix} Read: {docs}', disabled: 'Disabled picture / ui modules (they threw): {list}', blockedModules: 'Blocked modules: {list}',
  halted: ', halted', headless: ', headless', notReady: ', still loading',
  waiting: 'Loading: {waiting} ({pending} pending, {done}/{total} done)', loadFailed: 'Load failed{blocked}: {list}', blocked: ' (start blocked)',
  loadWarn: 'Loaded with missing references: {list}',
  audio: 'Audio: {list}',
  time: 'Time: {clock}, day {day}{season}, {dayNight}',
  day: 'daytime', night: 'night',
  weather: 'Weather: {name}{changing} (rain {rain}, snow {snow}, fog {fog}){shown}',
  weatherShown: ', on screen: {what}', rainShown: 'raindrops', snowShown: 'snowflakes',
  changing: ', transitioning ({pct}%)',
  player: 'Player: ({x}, {y}, {z}), ground {ground}, {water}, state {state}',
  inWater: 'in water', dry: 'not in water', noPlayer: 'Player: none',
  pointerLock: 'Pointer lock: {state}',
  camera: 'Camera: {type}, position ({x}, {y}, {z}), focus ({fx}, {fz}){over}',
  override: ', taken over by "{owner}"',
  cutscene: 'Cutscene: {n} playing{skip}',
  cutsceneFailed: 'Cutscene failed: {why}',
  overrides: 'Diagnostic overrides active (the screen is not the real state): {list}',
  skippable: ' (skippable)',
  dialogue: 'Dialogue: {speaker}: "{text}"{choices}',
  choices: ' Choices: {list}',
  windows: 'Open windows: {list}', inputLocked: ' (game input locked)',
  nearHead: 'Within {r} m ({n}, by distance):',
  nearNone: 'Within {r} m: nothing',
  nearItem: '  - {name} [{kind}] {dist} m, {dir}, {rel}{use}',
  use: ', interact: {label}',
  modules: 'Modules: {list}',
  perf: 'Perf: fps {fps}, CPU {cpu} ms/frame{frames}, draw calls {calls}, triangles {tris}{chunks}',
  cpuFrames: ' (median of {n} frames)',
  chunks: ', chunks loaded {loaded} / visible {visible} / queued {queued}',
  extra: '{name}: {json}',
  changed: 'Values being changed now: {list}',
  tables: 'Engine tables (entries; describe <name> for one): {list}',
  more: '... {n} more modules: {names} (describe <name> for one)',
  nearMore: '  ... {n} more',
  expand: 'More: describeText({ path: \'<module>\' }) for one part, describeText({ full: true }) for everything (CLI: threedog describe <path> / --full)',
  noPath: 'describe() has no "{path}"; top-level keys: {keys}',
  none: 'none',
  state: { idle: 'standing', walk: 'walking', run: 'running', jump: 'jumping', fall: 'falling', swim: 'swimming' },
  kind: { npc: 'NPC', pickup: 'pickup', interactable: 'interactable', noKey: 'no key bound, the player cannot use it', trigger: 'trigger' },
  dir: { N: 'north', NE: 'northeast', E: 'east', SE: 'southeast', S: 'south', SW: 'southwest', W: 'west', NW: 'northwest' },
  rel: { front: 'ahead', 'front-right': 'ahead right', right: 'right', 'back-right': 'behind right', back: 'behind', 'back-left': 'behind left', left: 'left',
    'front-left': 'ahead left' },
  season: { spring: 'spring', summer: 'summer', autumn: 'autumn', winter: 'winter' },
  camType: { follow: 'follow camera', first: 'first person', fixed: 'fixed camera', rts: 'top-down strategy camera' },
};
import { fmt } from '../base/validate.js';
import { r1 } from '../base/math.js';
import { getPath } from '../base/util.js';

const NEAR_SUMMARY = 5, LINE = 110, CHANGED_ROW = 120, CHANGED_LINE = 360;
const tr = (table, k) => (k != null && STRINGS[table][k]) || (k ?? STRINGS.none);
const n1 = v => (typeof v === 'number' ? r1(v) : v);
// Standard fields get sentences above; data from other modules is squeezed into one JSON line
const SHOWN = new Set(['nearbyRadius', 'ready', 'error', 'disabledModules', 'loading', 'audio', 'time', 'player', 'camera', 'nearby', 'actions', 'ui', 'cutscene',
  'modules', 'perf', 'changed', 'weather', 'render', 'threePatches']);   // threePatches: page-wide, the same every call; describe() JSON carries it, the text stays short
// engine bookkeeping in describe(): one count each in the summary, the content one describeText({ path }) away
const TABLES = new Set(['holds', 'input', 'control', 'shared', 'wraps', 'slots', 'scene', 'owned', 'picture', 'renderer']);
const argText = a => Object.entries(a || {}).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join(' ');

/** One module's data in a line: scalars as k=v, arrays as k[n], objects as k{n keys} (nested data is one describeText({ path }) away) */
function summary(v) {
  if (v == null || typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  const one = x => (typeof x === 'string' && x.length > 24 ? x.slice(0, 23) + '…' : x);
  const parts = Object.entries(v).map(([k, x]) => x == null || typeof x !== 'object' ? `${k}=${one(x)}`
    : Array.isArray(x) ? `${k}[${x.length}]` : `${k}{${Object.keys(x).length}}`);
  const s = parts.join(', ');
  return s.length > LINE ? s.slice(0, LINE - 1) + '…' : s;
}

/** describe() at a dotted path as JSON text, or why there is nothing there */
function atPath(d, path) {
  const v = getPath(d, path);
  return v === undefined ? fmt(STRINGS.noPath, { path, keys: Object.keys(d).join(', ') }) : `${path}: ${JSON.stringify(v, null, 1)}`;
}

/**
 * Write the describe() result as English text: a summary (at most maxLines lines), one part (path), or everything (full).
 * @param {any} d  a describe() result
 * @param {{ full?: boolean, path?: string, maxLines?: number, game?: string[] }} [opts] game: names added with describe.add (listed first)
 */
export function describeText(d, { full = false, path, maxLines = 30, game = [] } = {}) {
  if (path) return atPath(d, path);
  const L = [], t = d.time;
  const flags = (t.halted ? STRINGS.halted : '') + (t.headless ? STRINGS.headless : '') + (d.loading.done ? '' : STRINGS.notReady);
  if (d.error) L.push(fmt(STRINGS.error, d.error) + (d.error.at ? fmt(STRINGS.errorAt, d.error) : '')
    + (d.error.fix ? fmt(STRINGS.errorHint, { code: d.error.code, fix: d.error.fix, docs: d.error.docs.join(', ') }) : ''));
  L.push(fmt(STRINGS.head, { s: t.real, flags }));
  const ld = d.loading;
  if (!ld.done) L.push(fmt(STRINGS.waiting, { waiting: ld.waiting, pending: ld.counts.pending, done: ld.counts.done, total: ld.counts.total }));
  if (ld.failed.length) L.push(fmt(STRINGS.loadFailed,
    { blocked: ld.blocked ? STRINGS.blocked : '',
    list: ld.failed.map(f => `${f.kind} "${f.name}" ${f.error.url ?? ''} ${f.error.message}${f.fallback ? ` -> ${f.fallback}` : ''}`).join('; ') }));
  if (ld.warnings.length) L.push(fmt(STRINGS.loadWarn, { list: ld.warnings.map(w => `"${w.name}" missing ${w.missing.join(', ')}`).join('; ') }));
  if (d.audio) {   // only present while a bus is ducked or a voice plays; ducks are the target level, so a fade in progress already shows its end
    const low = Object.entries(d.audio.ducks).filter(([, v]) => v !== 1).map(([b, v]) => `${b} ducked to ${v}`), v = Object.entries(d.audio.voices).map(([k, n]) => `${k} x${n}`);
    L.push(fmt(STRINGS.audio, { list: [...low, v.length ? 'playing ' + v.join(', ') : null].filter(Boolean).join('; ') }));
  }
  if (d.disabledModules?.length) L.push(fmt(STRINGS.disabled, { list: d.disabledModules.join(', ') }));
  const blocked = Object.entries(d.moduleStates ?? {}).filter(([, s]) => s.startsWith('blocked')).map(([n, s]) => `${n} ${s}`);
  if (blocked.length) L.push(fmt(STRINGS.blockedModules, { list: blocked.join('; ') }));
  if (t.clock) L.push(fmt(STRINGS.time, { clock: t.clock, day: t.day, season: t.season ? ', ' + tr('season', t.season) : '', dayNight: t.isDay ? STRINGS.day
    : STRINGS.night }));
  const w = d.weather, wl = d.weatherDraw ?? {};   // weather state, and what of it is drawn (the drawing half)
  if (w) L.push(fmt(STRINGS.weather, { name: w.name, rain: n1(w.rain), snow: n1(w.snow), fog: n1(w.fog),
    changing: w.progress < 1 ? fmt(STRINGS.changing, { pct: Math.round(w.progress * 100) }) : '',
    shown: wl.rainVisible || wl.snowVisible ? fmt(STRINGS.weatherShown,
      { what: [wl.rainVisible && STRINGS.rainShown, wl.snowVisible && STRINGS.snowShown].filter(Boolean).join(', ') }) : '' }));
  const p = d.player;
  const water = p?.inWater ? STRINGS.inWater : STRINGS.dry;
  L.push(p ? fmt(STRINGS.player, { ...p, ground: p.ground, water, state: tr('state', p.state) }) : STRINGS.noPlayer);
  const c = d.camera;
  L.push(fmt(STRINGS.camera, { type: tr('camType', c.type) + (c.projection === 'orthographic' ? ` (orthographic, ${c.orthoSize} m tall)` : ''), x: c.x, y: c.y, z: c.z, fx: c.focus.x, fz: c.focus.z, over: c.override
    ? fmt(STRINGS.override, { owner: c.override }) : '' }));
  const pl = c.pointerLock;   // state machine from lockView (camera/common.js); only cameras with click-to-lock report a line
  if (pl?.configured) L.push(fmt(STRINGS.pointerLock, { state: pl.state + (pl.lastFailure ? ` (${pl.lastFailure.reason}, ${pl.lastFailure.agoSec} s ago)` : '')
    + (pl.covered ? `; canvas centre covered by ${pl.covered}` : '') + (pl.cameraOverride ? `; cameraOverride ${pl.cameraOverride} blocks locking` : '') }));
  if (d.scene?.overrides) L.push(fmt(STRINGS.overrides, { list: d.scene.overrides.map(o => `${o.owner}:${o.target}`).join(', ') }));
  if (d.cutscene?.count) L.push(fmt(STRINGS.cutscene, { n: d.cutscene.count, skip: d.cutscene.skippable ? STRINGS.skippable : '' }));
  if (d.cutscene?.failure) L.push(fmt(STRINGS.cutsceneFailed, { why: d.cutscene.failure }));
  const dl = d.ui.dialogue;
  if (dl) L.push(fmt(STRINGS.dialogue, { speaker: dl.speaker, text: dl.text, choices: dl.choices.length
    ? fmt(STRINGS.choices, { list: dl.choices.map((x, i) => `${i + 1}. ${x}`).join(' ') }) : '' }));
  if (d.ui.windows.length || d.ui.inputLocked) L.push(fmt(STRINGS.windows, { list: d.ui.windows.join(', ') || STRINGS.none })
    + (d.ui.inputLocked ? STRINGS.inputLocked : ''));
  const r = d.nearbyRadius;
  L.push(d.nearby.length ? fmt(STRINGS.nearHead, { r, n: d.nearby.length }) : fmt(STRINGS.nearNone, { r }));
  const near = full ? d.nearby : d.nearby.slice(0, NEAR_SUMMARY);
  for (const it of near) L.push(fmt(STRINGS.nearItem,
    { name: it.name, kind: tr('kind', it.kind), dist: it.dist, dir: tr('dir', it.dir), rel: tr('rel', it.rel), use: it.use ? fmt(STRINGS.use, { label: it.use })
    : '' }));
  if (near.length < d.nearby.length) L.push(fmt(STRINGS.nearMore, { n: d.nearby.length - near.length }));
  if (d.actions) L.push(fmt(STRINGS.actions,
    { list: d.actions.map(a => `${a.ok ? '✓' : '✗'} ${a.op}${a.args && Object.keys(a.args).length ? ' ' + argText(a.args) : ''}${a.ok ? '' : ` (${a.code})`}`).join(' · ') }));
  const pf = d.perf;
  L.push(fmt(STRINGS.perf, { fps: pf.fps ?? '-', cpu: pf.cpuMs ?? '-', frames: pf.cpuFrames ? fmt(STRINGS.cpuFrames, { n: pf.cpuFrames }) : '', calls: pf.drawCalls, tris: pf.triangles, chunks: pf.chunks
    ? fmt(STRINGS.chunks, pf.chunks) : '' }));
  if (pf.notice) L.push(pf.notice);   // over the game's budget, slower than its baseline, resolution lowered (engine.budget.notice)
  if (full && d.render?.text) L.push(d.render.text);   // render block only in the full text; the summary stays short (describe render shows it)
  if (d.changed) {   // bounded: names, values and how-chains are game data, so each row and the whole line are cut (the full rows are describe shared)
    const rows = d.changed.map(c => { const x = String(c.text).replace(/\s+/g, ' '); return x.length > CHANGED_ROW ? x.slice(0, CHANGED_ROW - 1) + '…' : x; });
    const all = rows.join('; ');
    L.push(fmt(STRINGS.changed, { list: all.length > CHANGED_LINE ? all.slice(0, CHANGED_LINE - 1) + '… (describe shared for all)' : all }));
  }
  L.push(fmt(STRINGS.modules, { list: d.modules.map(m => `${m.name} (${m.type})`).join(', ') }));
  if (full) {
    for (const k in d) if (!SHOWN.has(k)) L.push(fmt(STRINGS.extra, { name: k, json: JSON.stringify(d[k]) }));
    return L.join('\n');
  }
  // Summary order: the game's own describe.add sections first (what its author asked to see), then module lines, then the engine's bookkeeping
  // tables folded into one count line. Why: those tables (shared values, slots, owned properties...) took ~10 of the 30 lines and pushed
  // the game's own sections past the cut. A table with something wrong in it (scene conflicts / orphans / unsaved) keeps its own line.
  const rest = Object.keys(d).filter(k => !SHOWN.has(k)), tables = [], mods = [];
  for (const k of rest.filter(k => game.includes(k))) L.push(fmt(STRINGS.extra, { name: k, json: summary(d[k]) }));
  for (const k of rest.filter(k => !game.includes(k) && !TABLES.has(k))) mods.push([k, fmt(STRINGS.extra, { name: k, json: summary(d[k]) })]);
  for (const k of rest.filter(k => TABLES.has(k))) {
    const v = d[k];
    if (k === 'scene' && v && ['conflicts', 'orphans', 'unsaved'].some(x => v[x]?.length)) L.push(fmt(STRINGS.extra, { name: k, json: summary(v) }));
    else if (v != null) tables.push(k === 'renderer' ? `renderer ${v.backend ?? v.requested}${v.reason ? ` (asked ${v.requested}: ${v.reason})` : ''}` : `${k} ${typeof v === 'object' ? Object.keys(v).length : v}`);
  }
  // the cut falls on the module lines only: the standard lines, the game's sections and the tables line always stay; the cut ones are named
  const tail = tables.length ? [fmt(STRINGS.tables, { list: tables.join(', ') })] : [], room = Math.max(0, maxLines - 1 - L.length - tail.length);
  if (mods.length <= room) L.push(...mods.map(m => m[1]));
  else { const keep = Math.max(0, room - 1); L.push(...mods.slice(0, keep).map(m => m[1]), fmt(STRINGS.more, { n: mods.length - keep, names: mods.slice(keep).map(m => m[0]).join(', ') })); }
  L.push(...tail);
  L.push(STRINGS.expand);
  return L.join('\n');
}
