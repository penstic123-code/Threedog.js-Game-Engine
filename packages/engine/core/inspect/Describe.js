// Game state description: engine.describe() returns a plain object (JSON.stringify-able); engine.describeText() returns multi-line text.
// For AI and test scripts: learn "what time it is, what the weather is, where the player is, what is nearby, which windows are open" without a screenshot.
//
// The core fills in only what it knows (time in seconds, player position, camera, windows, performance); the rest comes from modules' optional hooks:
//   describe(e, ctx) {
//     ctx.out.time.clock = '18:30';                       // you may add info to the standard fields
//     ctx.near(obj3D or {x,z}, { name, kind: 'npc' });   // report a "nearby thing"; the core computes distance, bearing and ordering
//     return { ... };                                     // the return value goes into the result under the module name as key (omitted if nothing is returned)
//   }
//
// A small game that does not want a full module: engine.describe.add(name, fn) registers the game's own state in one line; the return value goes into describe().<name> (fn gets the same arguments as a module hook).
//   const h = engine.describe.add('range', () => ({ score, targets: targets.length }));   h.remove() to cancel
// A big game writes its systems as modules and uses the module's describe hook.
// ctx.near(at, info, weak): reports for the same `at` (same object) are merged; with weak = true only missing fields are filled (used by the interaction module).
// Display names (ground type, weather name) are not hard-coded here: they come from the string table, ground.<type> and weather.<name> (registered by the terrain and weather modules), and go into groundName / label.
// describeText, which turns this into text, lives in describeText.js.
import { Vector3 } from 'three';
import { describeText } from './describeText.js';
import { moduleRow } from '../engine/moduleTypes.js';
import { inspect, explain } from './Inspect.js';
import { inspectScene } from './InspectScene.js';
import { inspectMaterials } from './InspectMaterials.js';
import { inspectPerf } from './InspectPerf.js';
import { codedError, coded } from '../base/errorHints.js';
import { r1 } from '../base/math.js';
import { describeRender, describePicture, describeBackend } from './describeRender.js';
import { describeOwned, checkWrittenOnce } from '../ops/owned.js';
import { describeScene } from '../scene/thingOps.js';
import { describeHolds } from '../ops/holds.js';
import { warnOnce, warningsSaid } from '../base/validate.js';
import { stats, gpuMemoryMB, GPU_MEMORY } from '../../render/backend.js';
import { threePatches } from '../scene/threePatches.js';
import { describeSlots } from '../engine/plugins.js';
/** describe().perf's draw counters (render/backend.js reads them per renderer) @param {any} r */
const drawStats = r => { const s = stats(r); return { drawCalls: s.drawCalls, triangles: s.triangles }; };

const NEAR_RADIUS = 30, NEAR_MAX = 15;
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];           // north = -Z, east = +X
const RELATIVE = ['front', 'front-right', 'right', 'back-right', 'back', 'back-left', 'left', 'front-left'];   // relative to the camera heading
// the core's own fields
const STANDARD = new Set(['unhandled', 'warnings', 'holds', 'input', 'wraps', 'slots', 'threePatches', 'renderer', 'vars', 'ready', 'error', 'disabledModules', 'moduleStates', 'loading', 'audio', 'time', 'player', 'camera', 'nearbyRadius', 'nearby', 'actions', 'ui', 'cutscene', 'modules', 'perf', 'scene', 'render', 'picture', 'owned', 'shared', 'changed', 'control']);
const ACTIONS_MAX = 8;   // what the player can do now, with why not: saves the AI a guess for a few dozen characters
const sector = a => Math.round(((a % (Math.PI * 2)) + Math.PI * 2) / (Math.PI / 4)) % 8;

/** Display name from the string table (prefix + key); null if missing (the text then uses the raw name) */
const nameOf = (e, prefix, key) => (key != null && e.i18n.has(prefix + key) ? e.t(prefix + key) : null);

/**
 * The engine's state questions, assigned onto the engine: describe (call it for the state object; .add registers the game's own state),
 * describeText, inspect and explain (Inspect.js)
 * @param {any} e
 */
export function describeApi(e) {
  const extras = new Map();
  /**
   * Current game state (plain object, JSON.stringify-able). radius: how far counts as "nearby" (meters), default 30
   * @param {string | string[] | { radius?: number, center?: { x: number, z: number }, only?: string[] }} [opts] center: measure "nearby" from here instead
   *   of the player (inspect uses it); only: just these top-level sections (a name or an array is short for { only }), e.g. describe('picture')
   *   or describe({ only: ['picture', 'shared'] }). Why: the whole object is ~40 KB on a mid-size world, most of it engine tables (shared, slots)
   *   that a question about one part does not need, and only the asked sections are built. An unknown section name is reported in the result as unknownSections, never a silent {}
   * @example engine.describe('player').player.x
  */
  const api = opts => {
    const o = typeof opts === 'string' || Array.isArray(opts) ? { only: [opts].flat() } : opts ?? {};
    const part = describe(e, o, extras);
    if (part) return part;
    // a name that is not a section this time: build everything once to say which sections exist
    const all = describe(e, { ...o, only: undefined }, extras);
    const out = Object.fromEntries(o.only.filter(k => k in all).map(k => [k, all[k]])), unknown = o.only.filter(k => !(k in all));
    return { ...out, unknownSections: unknown, sections: Object.keys(all) };
  };
  /** @internal engine.catalog() reads which names were added (and by which module) */ api._extras = extras;
  /**
   * Register the game's own state: the return value of fn(engine, ctx) (must be JSON-able) goes into describe().<name>; undefined is omitted
   * @param {string} name key in the result; must not match an existing field or module name
   * @param {(e: any, ctx: any) => any} fn
   * @returns {{ remove(): void }}
   * @example engine.describe.add('range', () => ({ score: vars.get('score'), targets: targets.length }));
  */
  api.add = (name, fn) => {
    if (extras.has(name) || STANDARD.has(name) || e.modules.has(name)) throw codedError('describe-name', `describe.add('${name}'): this name is already taken; pick another (existing fields, module names and previously registered names cannot be reused)`);
    extras.set(name, fn);
    // by identity: a handle that was removed (or whose name was registered again) must not delete the newer registration of the same name
    return { remove: () => { if (extras.get(name) === fn) extras.delete(name); } };
  };
  /** Text of describe(): a summary by default; { path: 'world' } one part as JSON; { full: true } everything (see describeText.js) */
  // game: the describe.add names, so the summary lists the game's own state before engine tables (it is what the game author asked to see)
  const text = ({ full, path, ...opts } = {}) => describeText(api(opts), { full, path, game: [...extras.keys()] });
  const inspectApi = Object.assign((at, opts) => inspect(e, at, opts), { scene: opts => inspectScene(e, opts),
    materials: opts => inspectMaterials(e, opts), perf: opts => inspectPerf(e, opts) });
  return { describe: api, describeText: text, inspect: inspectApi, explain: q => explain(e, q) };
}

/** Only the modules that are not running normally (initializing / failed / blocked) appear in describe, so the common case adds nothing (null); engine.explain({ module }) has all of them */
function pendingModules(e) {
  const out = {};
  for (const [name, st] of e._modState) if (st === 'initializing' || st === 'failed') out[name] = st;
  for (const [name, by] of e._modBlocked) if (e._modState.get(name) !== 'failed') out[name] = `blocked by ${by.map(b => `${b.module} (${b.state})`).join(', ')}`;
  return Object.keys(out).length ? out : null;
}

// Engine tables no module hook writes into (hooks add to time / player / camera / ui / perf / cutscene / nearby): a describe({ only }) that asks
// for nothing else skips the hooks, describe.add and the action list
const TABLES = new Set(['ready', 'error', 'warnings', 'disabledModules', 'loading', 'audio', 'holds', 'input', 'control', 'shared', 'modules', 'slots', 'scene', 'threePatches', 'owned', 'render', 'picture', 'renderer', 'spatial']);
const NONE = Symbol('none');   // a conditional section that is absent this time

/**
 * Build the state object. radius: how far counts as "nearby"; extras: those registered by describe.add; only: build just these top-level
 * sections (the other core sections are built on first touch, so a hook that writes ctx.out.time still works). Returns null when a requested
 * name is not a section this time: api() then builds everything to name the sections that exist
 */
function describe(e, { radius = NEAR_RADIUS, center: at, only } = {}, extras) {
  checkWrittenOnce(e);
  const p = e.player?.position, center = at || p || e.focus, cam = e.camera;
  let snap = null;   // one snapshot of the shared points' rows for both `changed` and `shared`
  const rows = () => (snap ??= e.stacks._rows());
  /** @type {Record<string, () => any>} the core's sections in output order; NONE = left out */
  const core = {
    ready: () => e.ready,
    error: () => e.error,                                    // gameplay error in dev / tests (gameplay is frozen)
    unhandled: () => e._unhandled || NONE,                   // dev: first promise rejection nobody caught, and how many followed (errors.js)
    warnings: () => warningsSaid() ?? NONE,                  // dev: what warnOnce said on this page (a fallback, a clamp, a misspelled name), { count, list: first 20 { code, text, fix } }
    disabledModules: () => Object.entries(e.moduleStates).filter(([, s]) => s === 'disabled').map(([n]) => n),   // picture / ui modules switched off after an error
    moduleStates: () => pendingModules(e) ?? NONE,           // while a module is initializing or failed
    loading: () => e.loading.view(),                         // what is pending / failed and whether it blocks the start (Loading.js)
    time: () => ({ tick: e.time.tick, real: r1(e.time.now('real')), ambient: r1(e.time.now('ambient')), calendar: r1(e.clock.now), halted: e.halted, frozen: e.frozen, ...(e.frozen ? { frozenBy: e.stacks.get('freeze').names() } : {}), headless: e.headless, run: e.runState,
      channels: e.time.describe(), rate: e.clock.rate }),
    audio: () => { const i = e.audio?.info; return i && (Object.values(i.ducks).some(v => v !== 1) || Object.keys(i.voices).length) ? { ducks: i.ducks, voices: i.voices, state: i.state } : NONE; },   // only while a duck or a voice is active; ducks = target level per bus (Audio.info)
    holds: () => describeHolds(e),                        // who holds halt / freeze / camera / input (holds.js)
    input: () => e.input.describe(),                      // context stack, declared actions nobody bound, the player's rebindings (Input.js)
    control: () => e.control.describe(),                  // who decides where each held character goes: { id: { owner, layer, waiting } } (control.js)
    changed: () => { const c = e.stacks.changed(5, rows()); return c.length ? c : NONE; },   // the few shared values off their base now (stacks.changed), the summary's own line
    shared: () => e.stacks.describe(rows()),                    // every shared value / slot with entries: value, writer, how it combined, who else wants it (stacks.js)
    wraps: () => { const w = e._wraps?.describe(); return w && Object.keys(w).length ? w : NONE; },   // engine.wrap: { 'inventory.add': [owners, outermost first] }
    vars: () => ({ flags: { ...e.vars.flags }, counters: { ...e.vars.counters } }),   // story state: without it a snapshot said "same" after a flag was set
    player: () => p ? {
      x: r1(p.x), y: r1(p.y), z: r1(p.z),
      ground: e.groundType(p.x, p.z),
      groundName: nameOf(e, 'ground.', e.groundType(p.x, p.z)),
      inWater: e.waterAt(p.x, p.z, p.y) > p.y,
      state: e.player.state ?? null,   // the character module's own state name ('walk', 'jump'...): core passes it on and never interprets it
    } : null,
    // who answers ground queries and what the world's water is, so "why is there no ground / water here" is one read (ground.js, compositeGround.js)
    spatial: () => ({ groundHolder: e.stacks.has('ground') ? e.stacks.get('ground').value() : null, voidY: e.ground.voidY(), waterLevel: e.ground.waterLevel,
      waterBodies: e.waterBodies.length, ownWater: e.waterBodies.filter(b => b.query).length,
      ...(p ? { under: { ground: r1(e.surface(p.x, p.z, p.y)), water: r1(e.waterAt(p.x, p.z, p.y)) } } : {}) }),
    camera: () => ({ type: null, projection: cam.isOrthographicCamera ? 'orthographic' : 'perspective', ...(cam.isOrthographicCamera ? { orthoSize: r1(cam.top - cam.bottom) } : {}), x: r1(cam.position.x), y: r1(cam.position.y), z: r1(cam.position.z),
      focus: { x: r1(e.focus.x), z: r1(e.focus.z) }, override: e.cameraOverride?.owner ?? null }),
    nearbyRadius: () => radius,
    nearby: () => [],
    ui: () => ({ windows: [...e._openWindows], inputLocked: !e.input.enabled, dialogue: null, parts: e.ui.describe() }),   // windows include full-screen UI parts (title); parts: default / custom / off
    cutscene: () => null,
    modules: () => [...e.modules.values()].map(moduleRow),   // { name, type, provides?, requires? } in install order (moduleTypes.js)
    slots: () => describeSlots(e),                           // what is plugged in where, from which file, what it affects (plugins.js)
    scene: () => describeScene(e),                           // engine.add / world things: counts by save tier and what will not survive a load (thingOps.js)
    threePatches: () => threePatches.list(),                 // page-wide changes to three.js classes still on (core/scene/threePatches.js)
    owned: () => describeOwned(e),                           // every property the engine writes on its own and who writes it now (owned.js)
    render: () => describeRender(e),                         // renderer / post / lights and who set each (describeRender.js)
    picture: () => describePicture(e),                       // tone, fog, environment, background, lights, shadows as three.js holds them now (describeRender.js)
    renderer: () => describeBackend(e),                      // asked for, drawing, why not WebGPU and what that backend can run (describeRender.js)
    // cpuMs: the median of the last cpuFrames real-time frames, the reading the perf notice, inspect.perf() and the F3 panel use (0 before the first, as in 1.1);
    // cpu: the last frame by phase (the 1.1 key)
    perf: (budget = e.budget.report(), fm = e.halted ? null : e.budget._frameMs()) => ({
      fps: e.halted ? null : Math.round(e.fps), cpuMs: e.halted ? null : fm?.ms ?? 0, cpuFrames: fm?.n ?? 0,
      cpu: e.halted ? null : Object.fromEntries(Object.entries(e._cpuPhases).map(([k, v]) => [k, r1(v)])),
      apply: e.budget.cost.report(),
      ...drawStats(e.renderer), pixelRatio: e.renderer.getPixelRatio(),
      ...(gpuMemoryMB(e.renderer) != null && { gpuMemory: { mb: gpuMemoryMB(e.renderer), is: GPU_MEMORY } }),   // WebGPU only: WebGL keeps no byte counts
      budget, notice: e.budget._notice(budget), startup: e.startup, stream: e.stream.stats, batching: e.batching.stats, jobs: e.jobs.pending, commits: { pending: e.commits.pending, ...e.commits.stats },
    }),
  };
  const out = {};
  if (!only) for (const k in core) { const v = core[k](); if (v !== NONE) out[k] = v; }
  else for (const k in core) {
    // built on first read; a hook's plain write (ctx.out.cutscene = ...) replaces it the same way
    const put = v => { if (v === NONE) delete out[k]; else Object.defineProperty(out, k, { value: v, writable: true, enumerable: true, configurable: true }); };
    Object.defineProperty(out, k, { get: () => (put(core[k]()), out[k]), set: put, enumerable: true, configurable: true });
  }
  if (!only || !only.every(k => TABLES.has(k) && !e.modules.has(k) && !extras.has(k))) hooks(e, out, radius, center, extras);
  if (!only) return out;
  const picked = {};
  for (const k of only) { const v = out[k]; if (!(k in out)) return null; picked[k] = v; }
  return picked;
}

/** Module describe hooks and describe.add, then the nearby list and the player's actions, into out */
function hooks(e, out, radius, center, extras) {
  const dir = e.camera.getWorldDirection(new Vector3()), camYaw = Math.atan2(dir.x, -dir.z);
  // Nearby things: collect first, then sort and truncate once at the end
  const found = new Map(), v = new Vector3();
  const ctx = {
    out, radius, center,
    near(at, info, weak = false) {
      const pos = at.isObject3D ? at.getWorldPosition(v) : at;
      const dx = pos.x - center.x, dz = pos.z - center.z, dist = Math.hypot(dx, dz);
      if (dist > radius) return;
      const old = found.get(at);
      if (old) { for (const k in info) if (!weak || old[k] == null) old[k] = info[k]; return; }
      const bearing = Math.atan2(dx, -dz);
      found.set(at, { ...info, dist: r1(dist), dir: COMPASS[sector(bearing)], rel: RELATIVE[sector(bearing - camYaw)], x: r1(pos.x), z: r1(pos.z) });
    },
  };
  // A module's hook that throws fills only its own entry: describe() runs at the end of every engine.step(), so letting one broken hook throw
  // would make step() throw after time has already advanced and lose every other module's state with it.
  for (const m of e.modules.values()) {
    if (!m.describe) continue;
    try { const part = m.describe(e, ctx); if (part !== undefined) out[m.name] = part; }
    catch (err) {
      const msg = String(err?.message || err);
      out[m.name] = { error: msg, code: 'describe-threw' };
      warnOnce(coded('describe-threw', `describe(): module '${m.name}' describe hook threw: ${msg}`), 'describe-threw:' + m.name);
    }
  }
  for (const [name, fn] of extras) {
    try { const part = fn(e, ctx); if (part !== undefined) out[name] = part; } catch (err) { out[name] = { error: String(err.message || err) }; }   // an error in the game's own description must not take down the whole describe
  }
  out.nearby = [...found.values()].sort((a, b) => a.dist - b.dist).slice(0, NEAR_MAX);
  // ops on offer for the player (engine.ops.list({ available: true })): possible ones first; omitted when the game has none
  const acts = e.ops.list({ available: true }).sort((a, b) => b.ok - a.ok).slice(0, ACTIONS_MAX);
  if (acts.length) out.actions = acts.map(a => ({ op: a.name, args: a.args, ok: a.ok, ...(a.ok ? {} : { code: a.code, facts: a.facts, nextActions: a.nextActions }) }));
}
