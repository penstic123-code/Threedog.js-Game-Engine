// The chaos driver: runs one action at a time against the composite game, on stepped time so a list replays the same, and checks the invariants after each.
// Node calls begin / act / end one action at a time (tests/specs/chaos.mjs), so a page that hangs is caught at the action that hung it.
// An error with a code is the engine refusing on purpose: it is counted, not failed. Anything else that throws is a failure.
import { MODS, NPCS, FX, WEATHER, RENDERER, buildGame, levelScene, makeCar } from './game.js';
import { sky, weather } from '../../index.js';
// the composite game itself, for a spec that drives one call by hand (tests/specs/chaos-picture-fixes.mjs): the page is a build, so game.js has no URL of its own
export { buildGame, FX } from './game.js';
import { SKIPS, line } from './plan.js';

const DT = 1 / 30;
const tick = () => new Promise(r => setTimeout(r, 0));
const WALKERS = ['player', 'npc-a', 'npc-b'];
const TARGETS = ['crate-a', 'crate-b', 'tilted-a', 'post-a', 'npc-a', 'player'];
const RATES = [null, 0, 60, 0.5];
const SIZES = [0.3, 0.8, 1.6];
// Values a game might hand the picture: 0-3 ordinary, 4-8 wild (zero, negative, huge, NaN, Infinity). A wild value the engine takes is marked in G.wild
// until something ordinary replaces it, and a black or white frame while one is marked is a note, not a failure: fog of density 1e6 is one color by right
const WILD = [0.5, 1, 2, 0.05, 0, -1, 1e6, NaN, Infinity], wild = v => v >= 4;
const FX_NAMES = Object.keys(FX), WEATHERS = ['clear', 'wet', 'white', 'storm'];
const TIMES = [0, 0.25, 0.5, 0.75, 0.99, -1, 2, NaN, Infinity], COUNTS = [1, 2, 3, 4, 0, -1, 99, NaN, Infinity];
const MAP_SIZES = [512, 1024, 2048, 256, 0, -1, 8192, NaN, Infinity], SECONDS = [0, 0.5, 5, -1, NaN, Infinity];
const FOG_FAR = [40, 120, 15, 400, 0, -1, 1e6, NaN, Infinity], FOG_DENSITY = [0.02, 0.05, 0.1, 0.005, 0, -1, 1e6, NaN, Infinity];
const EXPOSURE = [1, 0.6, 1.6, 1.2, 0, -1, 1e6, NaN, Infinity], PHOTO_SCALE = [0.5, 1, 0.25, 2, 0, -1, 64, NaN, Infinity];
const MAX_WAIT_FRAMES = 1500;   // 50 s of game time: longer than any walk across the level, its repaths and its stuck timer

/** Save fields that may differ between two saves of the same state, each with why. Everything else must come back equal */
const VOLATILE = { savedAt: 'wall-clock time of the save' };
/** The one slack left: Rapier renormalizes a turn it is given, in 32-bit floats, so a saved quaternion comes back up to one float step off. Everything else in a save returns exactly */
const QUATERNION = /^\/parts\/rigid\/[^/]+\/[3-6]$/, FLOAT_STEP = 1e-6;
const LEAK_SLACK = v => v * 0.25 + 6;   // "a bounded level": a warm cache may grow a little, a leak grows with every cycle

let G = null;

function fail(kind, detail) { if (G && G.fails.length < 8) G.fails.push({ kind, detail: `${detail} [during ${G.current}]` }); }
const coded = (e, where) => {
  if (e?.code) { G.refusals[e.code] = (G.refusals[e.code] ?? 0) + 1; return; }
  fail(`thrown: ${where}: ${String(e?.message ?? e).slice(0, 80)}`, String(e?.stack ?? e).split('\n').slice(0, 4).join(' | '));
};

const step = (n = 1, render = false) => {
  const E = G.E;
  for (let i = 0; i < n; i++) {
    if (E.disposed) return;
    try { E.step(DT, { render: render && i === n - 1, describe: false }); } catch (e) { fail(`step threw: ${String(e?.message ?? e).slice(0, 80)}`, String(e?.stack ?? e).split('\n').slice(0, 4).join(' | ')); return; }
    if (E.error) { fail(`engine.error: ${String(E.error?.message ?? E.error).slice(0, 80)}`, String(E.error?.stack ?? E.error).split('\n').slice(0, 4).join(' | ')); E.error = null; E.stacks.get('freeze').release('error'); }
  }
};

/** Follow a promise: its result is noted, a rejection without a code fails, and pending lists it until it settles (the audit says who never did) */
function follow(label, p) {
  const job = { label, done: false, value: undefined };
  G.jobs.push(job);
  Promise.resolve(p).then(v => { job.done = true; job.value = v; }, e => { job.done = true; coded(e, `rejected ${label}`); });
  return job;
}
/** Wait with the game running: a few macrotasks first, so a save's real IO finishes in the same frame on every run */
async function settle(jobs, frames) {
  for (let f = 0; f < frames && jobs.some(j => !j.done); f++) {
    for (let i = 0; i < 4 && jobs.some(j => !j.done); i++) await tick();
    if (jobs.some(j => !j.done)) step(1);
  }
}

/** After a provider leaves, any call into it is a reference someone kept. Its methods stay working, so one stale call does not hide the next finding */
function poison(old, label) {
  if (!old || typeof old !== 'object') return;
  const seen = new Set(['constructor']), run = G;
  for (let o = old; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) for (const k of Object.getOwnPropertyNames(o)) {
    if (seen.has(k) || k.startsWith('_')) continue; seen.add(k);   // an internal is reached through a method or a handle: a handle going back to its own issuer is the rule, not a stale call
    const f = Object.getOwnPropertyDescriptor(o, k).value;
    if (typeof f !== 'function') continue;
    try { old[k] = function (...a) { if (G === run) fail(`stale provider: ${label}.${k}()`, `${label}.${k}() was called after ${label} left: ${new Error().stack.split('\n').slice(2, 5).join(' | ')}`); return f.apply(this, a); }; } catch { /* a read-only method stays unwatched */ }
  }
}

const character = id => (id === 'player' ? G.E.player : G.E.npcs?.get?.(id)?.character ?? G.E.npcs?.get?.(id));
const recordIds = () => [...G.E.world.records.keys()].sort();
/** The records a save answers for: a content pack is game data, it stays through a load and is gone with the engine that loaded it */
const savedIds = () => recordIds().filter(id => !id.startsWith('pk-'));

/** The car lives on the rigid module: after a swap a game builds it again */
function car() {
  const E = G.E;
  if (!E.rigid) return null;
  if (G.carOn !== E.rigid) { G.car = makeCar(E); G.carOn = E.rigid; }
  return G.car;
}

const ACTS = {
  mod(i, how) {
    const E = G.E, m = MODS[i], has = E.has(m.name), old = E[m.name];
    if (how === 1) { if (has) { E.unuse(m.name); poison(old, m.name); } return; }
    if (how === 0) { E.use(m.make(), has ? { replaces: m.slot } : undefined); if (has) poison(old, m.name); return E[m.name]?.ready; }
    if (!has) { E.use(m.make()); return E[m.name]?.ready; }
  },
  save(s) { const ids = savedIds(), r = G.E.saves.save(`c${s}`); return Promise.resolve(r).then(ok => { if (ok) G.saved[s] = ids; return ok; }); },
  async load(s) {
    const ok = await G.E.saves.load(`c${s}`);
    if (ok && G.saved[s]) { const now = new Set(recordIds()), lost = G.saved[s].filter(id => !now.has(id)); if (lost.length) fail('record lost by load', `saved ${lost.join()} are gone`); }
    return ok;
  },
  async sessionLoad(s) {
    const ok = await G.E.session.load(`c${s}`);
    if (ok) { G.quit = false; afterSession(); if (G.saved[s]) sameIds(G.saved[s], 'session.load'); }
    return ok;
  },
  async newGame() {
    const ok = await G.E.session.newGame();
    if (ok !== false) { G.quit = false; afterSession(); sameIds(G.baseIds, 'newGame', true); }
    return ok;
  },
  async quit() { G.quit = true; await G.E.session.quit(); },
  contentPack(n) { G.E.content.load({ name: `pack-${n}`, items: { [`it${n}`]: { name: `It ${n}` } }, props: [{ id: `pk-${n}`, template: 'chaos-post', x: 12 - n * 4, z: 12 }] }); },
  levelLoad(n) { G.noLevel = false; return G.E.level?.load(levelScene(n)); },
  levelUnload() { G.noLevel = true; G.E.level?.unload(); },
  freeze() { if (G.held) { G.held.remove(); G.held = null; } else G.held = G.E.freeze('chaos'); },
  skip(s) { return G.E.skip({ seconds: s }); },
  timeRate(i) { G.rate?.remove(); G.rate = RATES[i] === null ? null : G.E.mod('clock.rate', { owner: 'chaos', set: RATES[i] }); },
  camera(i, ortho) {
    const E = G.E, projection = ortho ? { projection: 'orthographic', size: 14 } : {};
    if (!E.cameraRig) return;
    if (i === 0) E.setCamera('follow', { distance: 6, ...projection });
    if (i === 1) E.setCamera('firstPerson', { height: 1.7 });
    if (i === 2) E.setCamera('rts');
    if (i >= 3) E.setCamera('fixed', { shots: { hall: { position: [0, 6, 12], lookAt: [0, 0, 0], ...projection }, yard: { position: [10, 4, -6], lookAt: [0, 1, 0] } }, start: 'hall' });
  },
  shot(i) { const r = G.E.cameraRig; if (r?.kind === 'fixed') r.cut(i ? 'yard' : 'hall'); },
  enterVehicle(who) { const c = character(WALKERS[who]), v = car(); if (c && v) G.E.ops.allow(() => c.enter(v)); },
  exitVehicle(who) { const c = character(WALKERS[who]); if (c?.vehicle) G.E.ops.allow(() => c.exit()); },
  ragdoll(who) {
    if (G.limp) { const r = G.limp; G.limp = null; r.remove(); return; }
    const c = character(WALKERS[who]);
    if (c && G.E.rigid) G.limp = G.E.rigid.ragdoll(c, { impulse: [0, 30, -40] });
    G.refusals[G.limp ? 'note: went limp' : 'note: no ragdoll'] = (G.refusals[G.limp ? 'note: went limp' : 'note: no ragdoll'] ?? 0) + 1;
  },
  walkTo(who, x, z) { return character(WALKERS[who])?.walkTo({ x, z }); },
  findPath(size, x, z) {
    const E = G.E, p = E.player?.position;
    if (!p) return;
    const path = E.characters.findPath(p, { x, z }, { radius: SIZES[size] });
    if (path && !path.every(q => Number.isFinite(q.x) && Number.isFinite(q.z))) fail('findPath gave a bad point', JSON.stringify(path).slice(0, 200));
  },
  thingSet(t, x, z) {
    const args = { id: TARGETS[t], position: [x, 0, z] }, r = G.E.ops.run('thing.set', args);
    if (r.ok) G.undo.push([args, r.value]);
  },
  worldMove(t, x, z) { const E = G.E; E.ops.allow(() => E.world.move(TARGETS[t], { x, z })); },
  undo() { const u = G.undo.pop(); if (u) G.E.ops.undo('thing.set', u[0], u[1]); },
  post(i) {
    const E = G.E, name = i ? 'grain' : 'bloom', h = E.post.get(name);
    if (h) h.remove(); else E.post.add(i ? G.grain() : G.bloom(), { name });
  },
  cutscene(i) {
    const E = G.E, who = character('npc-a');
    const steps = i ? [{ fade: 0.2, to: 1 }, { wait: 0.5 }, { fade: 0.2, to: 0 }] : [{ wait: 0.3 }, { camera: { to: { position: [6, 5, 6], lookAt: [0, 1, 0] }, duration: 1 } }, ...(who ? [{ path: { object: who, points: [[-3, 0, -3], [-1, 0, -5]], duration: 1 } }] : []), { camera: { release: true } }];
    return E.timeline.play(steps);
  },
  cutsceneSkip() { G.E.timeline.skip(); },
  give(n) { const E = G.E; E.ops.allow(() => E.inventory.add('coin', n)); },
  quest(i) {
    const E = G.E, Q = E.quests;
    if (!Q) return;
    E.ops.allow(() => { if (i === 0 && !Q.isActive('fetch')) Q.start('fetch'); if (i === 1 && Q.isActive('fetch')) Q.advance('fetch'); });
  },
  particles() {
    const P = G.E.particles;
    if (!P) return;
    if (!P.has?.('chaos-puff')) P.define('chaos-puff', { rate: 0, max: 30, color: [0xffffff, 0xffeeaa], size: [0.6, 0.6], lifetime: [0.4, 0.4], speed: [0, 0] });
    P.emit('chaos-puff', { x: 0, y: 3, z: 0 }, { count: 10 });
  },
  pushBody(i) { const R = G.E.rigid, b = R?.bodies?.[i % Math.max(1, R.bodies.length)]; if (b) R.impulse(b, [2, 8, 2]); },
  weather(i) { G.E.weather?.set(i === 1 ? 'wet' : 'clear', { seconds: i === 2 ? 2 : 0 }); },
  frames(n) { step(n, true); },
  async recreate() {
    const held = G;
    held.E.dispose();
    const made = await buildGame({ saveKey: held.saveKey, seed: held.seed });
    Object.assign(held, made, { held: null, rate: null, limp: null, undo: [], quit: false, carOn: made.E.rigid, csm: null, csm2: null, env: null, lamp: null, skyOff: null });
    held.wild.clear(); watchErrors(held.E);
    held.jobs = held.jobs.filter(j => !j.done);
    for (const j of held.jobs) if (!j.done) j.dropped = true;   // whatever the old engine had in flight dies with it, and may fairly never settle
  },
  // ---- the picture: every call is one a game makes; a coded throw is a refusal (counted), the frame check after it is the real answer
  fx(k, how, order) {
    const E = G.E, name = FX_NAMES[k], h = E.post.get(name);
    if (how === 0) { if (h) { h.remove(); unwild(`fx.${name}`); } else E.post.add(FX[name](), { name }); }
    if (how === 1 && h) h.enabled = !h.enabled;
    if (how === 2) { if (h) { h.remove(); unwild(`fx.${name}`); } E.post.add(FX[name](), { name, order }); }
    if (how === 3) E.post.add(FX[name](), { name });
  },
  fxParam(k, key, v) {
    const E = G.E, name = FX_NAMES[k], h = E.post.get(name) ?? E.post.add(FX[name](), { name });
    const keys = Object.keys(h.params).filter(n => typeof h.params[n] === 'number');
    if (!keys.length) return;
    const p = keys[key % keys.length];
    h.set({ [p]: WILD[v] });
    markWild(`fx.${name}.${p}`, v);
    if (Number.isNaN(h.params[p])) note(`NaN kept: post ${name}.${p}`);
  },
  fxCombo(mask, salt) {
    const E = G.E;
    for (const name of FX_NAMES) if (E.post.get(name)) { E.post.get(name).remove(); unwild(`fx.${name}`); }
    FX_NAMES.forEach((name, i) => { if (mask & (1 << i)) E.post.add(FX[name](), { name, order: (salt * (i + 3)) % 97 - 10 }); });
  },
  tier(i) {
    const E = G.E;
    if (i < 3) E.settings.preset(['low', 'medium', 'high'][i]);
    else E.tier = i === 3 ? 'low' : 'high';
  },
  skyLook(i, v) {
    const E = G.E, S = E.sky, U = E.uniforms ?? {};
    if (i === 0) { const old = S; E.use(sky({ time: TIMES[v] }), S ? { replaces: 'sky' } : undefined); if (old) poison(old, 'sky'); markWild('sky.time', v); return E.sky?.ready; }
    if (!S) return;
    if (i === 1) S.backdrop = S.backdrop == null ? 0x335577 : null;
    if (i === 2) { if (G.skyOff === S) { S.replace(null); G.skyOff = null; } else { S.replace(false); G.skyOff = S; } }
    if (i === 3 && U.uSunBrightness) { U.uSunBrightness.value = WILD[v]; markWild('sky.sun', v); }
    if (i === 4 && U.uCloudCover) { U.uCloudCover.value = WILD[v]; markWild('sky.cloud', v); }
    if (i === 5) { if (G.env) { const h = G.env; G.env = null; h.remove(); } else G.env = S.environment({ into: E.scene }); }
  },
  // the wild mark only once the engine took the value: a refused call leaves nothing wild, so the frame check keeps watching
  weatherTo(t, s) { const W = G.E.weather; if (!W) return; const r = W.set(WEATHERS[t], { seconds: SECONDS[s] }); markWild('weather.seconds', s >= 3 ? 4 : 0); return r; },
  weatherWild(v) {
    const E = G.E, old = E.weather, x = WILD[v], had = E.has('weather');
    E.use(weather({ types: { ...WEATHER, wild: { rain: x, snow: x, fog: x, wind: x, cloud: x, lightning: x } } }), had ? { replaces: 'weather' } : undefined);
    if (had) poison(old, 'weather');
    markWild('weather.table', v);
    E.weather.set('wild', { seconds: 0 });
  },
  fog(i, v) {
    const E = G.E;
    if (i === 0) { E.scene.fog = null; unwild('fog'); return; }
    E.scene.fog = i === 1 ? new G.THREE.Fog(0x8899aa, 1, FOG_FAR[v]) : new G.THREE.FogExp2(0x8899aa, FOG_DENSITY[v]);
    markWild('fog', v);
  },
  exposure(v) { G.E.renderer.toneMappingExposure = EXPOSURE[v]; markWild('exposure', v); },
  shadowsPic(i, v) {
    const E = G.E, sun = E.lights?.sun;
    if (i === 0) E.shadows.enabled = !E.shadows.enabled;
    if (i === 1) { if (G.csm) { const h = G.csm; G.csm = null; h.remove(); } else if (sun) G.csm = E.shadows.cascades(sun, { count: COUNTS[v] }); }
    if (i === 2) { (G.csm ?? G.csm2)?.set({ count: COUNTS[v] }); markWild('cascades.count', v); }
    if (i === 3 && sun) { sun.shadow.mapSize.set(MAP_SIZES[v], MAP_SIZES[v]); sun.shadow.map?.dispose(); sun.shadow.map = null; markWild('sun.mapSize', v); }   // three.js rebuilds the map only once it is dropped
    if (i === 4) {
      if (G.lamp?.parent) { E.scene.remove(G.lamp); return; }   // a game may take the light out with its cascades still on: the engine's to cope or refuse
      G.lamp ??= Object.assign(new G.THREE.DirectionalLight(0xffeedd, 1.5), { castShadow: true }); G.lamp.position.set(-20, 30, 10); E.scene.add(G.lamp);
    }
    if (i === 5) { if (G.csm2) { const h = G.csm2; G.csm2 = null; h.remove(); } else if (G.lamp?.parent) G.csm2 = E.shadows.cascades(G.lamp, { count: COUNTS[v] }); }
  },
  photo(v) { const E = G.E; E.renderOnce(); return E.photo?.take({ scale: PHOTO_SCALE[v] }); },
  // Planted bugs for the self-test (never drawn by plan()): they show that the checks can fail and that shrinking keeps the cause
  fault() { G.fault = G.E.freeze('chaos-fault'); },
  faultStale() { const old = G.E.weather; ACTS.mod(4, 0); old.set('wet', { seconds: 0 }); },
  faultLeak() { for (let i = 0; i < 60; i++) G.E.scene.add(new G.THREE.Object3D()); },
  // everything drawn black behind the harness's back (no sky, a black background, a black override material): no wild mark, so the frame must fail
  faultBlack() { const E = G.E; E.sky?.replace(false); E.scene.background = new G.THREE.Color(0); E.scene.overrideMaterial = new G.THREE.MeshBasicMaterial({ color: 0 }); },
  faultLost() { const E = G.E; E.ops.allow(() => E.world.remove('post-a')); },
  async audit(final) { await audit(!!final); },
};

function afterSession() {
  // a playthrough ending drops play-time holds and undo history by design
  G.undo = []; G.limp = null;
}
function sameIds(want, how, baseOnly) {
  const now = new Set(savedIds()), lost = want.filter(id => !now.has(id));
  if (lost.length) fail(`record lost by ${how}`, `missing ${lost.join()}`);
  if (!baseOnly) { const had = new Set(want), extra = [...now].filter(id => !had.has(id)); if (extra.length) fail(`record left over by ${how}`, `extra ${extra.join()}`); }
}

const note = k => { G.refusals[`note: ${k}`] = (G.refusals[`note: ${k}`] ?? 0) + 1; };
function markWild(key, v) { if (wild(v)) G.wild.add(key); else G.wild.delete(key); }
function unwild(prefix) { for (const k of [...G.wild]) if (k === prefix || k.startsWith(`${prefix}.`)) G.wild.delete(k); }

/**
 * The frame just drawn, read in the task that drew it (no preserveDrawingBuffer on either renderer): all black or all white is a broken frame. Why only
 * those two: NaN in a shader reads back as black (or white on some drivers), while one flat color can be a wall in front of a first-person camera.
 * It is excused, and noted, while a wild value is in effect or nothing is there to see (no level, no sky, a quit playthrough).
 */
function frameCheck() {
  const E = G.E, c = E.renderer?.domElement;
  if (E.disposed || !c?.width) return;
  const k = G.probe ??= Object.assign(document.createElement('canvas'), { width: 24, height: 16 }).getContext('2d', { willReadFrequently: true });
  k.clearRect(0, 0, 24, 16); k.drawImage(c, 0, 0, 24, 16);
  const px = k.getImageData(0, 0, 24, 16).data;
  let lo = 765, hi = 0;
  for (let i = 0; i < px.length; i += 4) { const v = px[i] + px[i + 1] + px[i + 2]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const bad = hi <= 6 ? 'black' : lo >= 759 ? 'white' : null;
  G.frames++;
  if (!bad) return;
  const why = G.wild.size ? `wild ${[...G.wild].join()}` : G.noLevel ? 'no level' : (G.skyOff && G.skyOff === E.sky) ? 'no sky' : G.quit ? 'quit' : null;
  if (why) note(`${bad} frame under ${why.split(',')[0]}`);
  else fail(`frame all ${bad}`, `every sampled pixel ${bad} (sum ${lo}..${hi}) on ${RENDERER}; post ${E.post.list?.().map(x => `${x.name}${x.enabled ? '' : '(off)'}`).join(' ') ?? '?'}, tier ${E.tier}`);
}

/** The picture back to the calm state begin() measured: the harness's effects, cascades, light, fog, exposure, sky look and preset all go */
function calmPicture() {
  const E = G.E, U = E.uniforms ?? {};
  for (const name of FX_NAMES) E.post.get(name)?.remove();
  for (const k of ['csm', 'csm2', 'env']) { const h = G[k]; G[k] = null; h?.remove(); }
  if (G.lamp?.parent) E.scene.remove(G.lamp);
  E.scene.fog = null; E.renderer.toneMappingExposure = G.picBase.exposure;
  if (E.sky) { E.sky.backdrop = null; if (G.skyOff === E.sky) E.sky.replace(null); }
  G.skyOff = null;
  if (U.uSunBrightness) U.uSunBrightness.value = G.picBase.sun;
  if (U.uCloudCover) U.uCloudCover.value = G.picBase.cloud;
  const sun = E.lights?.sun;
  if (sun && sun.shadow.mapSize.x !== G.picBase.mapSize) { sun.shadow.mapSize.set(G.picBase.mapSize, G.picBase.mapSize); sun.shadow.map?.dispose(); sun.shadow.map = null; }
  E.shadows.enabled = G.picBase.shadows; E.tier = G.picBase.tier; E.settings.reset('quality');
  G.wild.clear();
}

/** Cheap checks after every action */
function quick(calm = false) {
  const E = G.E;
  if (E.disposed) return;
  const now = new Set(recordIds());
  if (!G.quit) { const lost = G.baseIds.filter(id => !now.has(id)); if (lost.length) fail('record lost', `missing ${lost.join()}`); }
  // one model per thing: a mesh too many or too few is a character or prop built twice or lost
  let skinned = 0, boxes = 0;
  E.scene.traverse(o => { if (o.isSkinnedMesh) skinned++; const q = o.isMesh && o.geometry?.parameters; if (q && q.width === 1 && q.height === 1 && q.depth === 1 && o.visible !== false) boxes++; });
  // a model may still be on its way, so one too few is read only at the audit; one too many is a duplicate at once
  if (!G.quit && (skinned > 1 + NPCS.length || (calm && skinned !== 1 + NPCS.length))) fail('character model count', `${skinned} skinned bodies in the scene, ${1 + NPCS.length} characters`);
  if (!G.quit) { const want = [...E.world.records.values()].filter(r => /chaos-(crate|post)/.test(r.kind ?? '')).length; if (boxes > want || (calm && boxes !== want)) fail('prop model count', `${boxes} models for ${want} records`); }
}

/** A save as the round trip compares it */
function strip(save) {
  const c = JSON.parse(JSON.stringify(save));
  for (const k of Object.keys(VOLATILE)) delete c[k];
  return c;
}
/** Paths where two plain values differ, at most `max` */
function diff(a, b, path = '', out = [], max = 4) {
  if (out.length >= max) return out;
  if (a === b || (a !== a && b !== b) || (QUATERNION.test(path) && Math.abs(a - b) < FLOAT_STEP)) return out;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) { out.push(`${path}: ${JSON.stringify(a)?.slice(0, 60)} -> ${JSON.stringify(b)?.slice(0, 60)}`); return out; }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${path}/${k}`, out, max);
  return out;
}

function measure() {
  const E = G.E, c = E.counts(), flat = {};
  const add = (k, v) => { if (typeof v === 'number') flat[k] = v; else if (v && typeof v === 'object') for (const [n, x] of Object.entries(v)) add(`${k}.${n}`, x); };
  for (const [k, v] of Object.entries(c)) add(k, v);
  let objects = 0; E.scene.traverse(() => { objects++; });
  const info = E.renderer.info?.render; flat.drawCalls = (E.renderer.isWebGPURenderer ? info?.drawCalls : info?.calls) ?? 0;
  flat.sceneObjects = objects; flat.domListeners = window.threedogChaosListeners(); flat.bodyChildren = document.body.children.length;
  return flat;
}

/** Everything back to a calm game, then the deep checks: this is where "settles", "not locked", "round trip" and "bounded" are read */
async function audit(final) {
  const E = G.E;
  // the harness's own holds end first, so what is left held is the engine's
  G.held?.remove(); G.held = null; G.rate?.remove(); G.rate = null;
  if (G.limp) { const r = G.limp; G.limp = null; r.remove(); }
  E.timeline.skip();
  for (const m of MODS) if (!E.has(m.name)) E.use(m.make());
  await E.loading.settled();   // rigid's solver loads over macrotasks: the steps below would run with no holder, and the first load would be what builds the bodies
  if (G.quit) { const j = follow('audit newGame', E.session.newGame()); await settle([j], 120); G.quit = false; afterSession(); }
  if (G.noLevel && E.level) { await settle([follow('audit level', E.level.load(levelScene(0)))], 120); G.noLevel = false; }
  await settle(G.jobs.filter(j => !j.dropped), MAX_WAIT_FRAMES);
  for (const j of G.jobs) if (!j.done && !j.dropped) fail(`never settled: ${j.label.split('(')[0]}`, `${j.label} still open after ${MAX_WAIT_FRAMES} frames`);
  G.jobs = G.jobs.filter(j => !j.done);
  if (E.frozen) fail('frozen after everything was released', `owners ${JSON.stringify(E.describe().runState?.owners ?? '?')}`);
  const before = E.clock.now; step(3);
  if (!E.frozen && !(E.clock.now > before) && E.clock.rate !== 0) fail('game time stopped', `clock.now stayed ${before}`);
  const locked = E.input.holders.filter(h => !h.pass).map(h => h.context);
  if (locked.length) fail('player input left locked', `held by ${locked.join()}`);
  // a car seat ride is control too: the audit is calm only with the player on foot and in charge
  const P = E.player;
  if (P?.vehicle) E.ops.allow(() => P.exit());
  if (P) { const who = E.control.of?.(P) ?? E.control.holder?.(P); if (who && who.layer && who.layer !== 'base') fail('player control left held', JSON.stringify({ owner: who.owner, layer: who.layer })); }
  // drawn frames: a copy notices a new rigid in its per-frame update and rebuilds on the frame after, finishing in a microtask no synchronous step reaches
  step(5); step(1, true); step(1, true); await tick(); quick(true);
  // save -> load -> save gives the same data
  // no frame runs between the two reads: what differs was changed by the save or the load itself
  const a = strip(E.saves.collect()), ok = await E.saves.save('audit') && await E.saves.load('audit');
  if (!ok) fail('audit save or load refused', 'save then load of the current game did not return true');
  const b = strip(E.saves.collect()), d = diff(a, b);
  if (d.length) fail(`save round trip: ${d[0].split(':')[0]}`, d.join(' ; '));
  if (final) {
    calmPicture();
    const j = follow('audit newGame', E.session.newGame()); await settle([j], 120); afterSession();
    step(10, true);
    const m = measure();
    for (const [k, v] of Object.entries(m)) { const base = G.base[k] ?? 0; if (v > base + LEAK_SLACK(base)) fail(`counter grew: ${k}`, `${k} ${base} -> ${v}`); }
  }
}

// ---- what Node calls ----
const hooks = {
  error: ev => { ev.preventDefault?.(); if (G) fail(`page error: ${String(ev.message).slice(0, 80)}`, String(ev.error?.stack ?? ev.message).split('\n').slice(0, 4).join(' | ')); },
  rejection: ev => { ev.preventDefault?.(); if (G && !ev.reason?.code) fail(`unhandled rejection: ${String(ev.reason?.message ?? ev.reason).slice(0, 80)}`, String(ev.reason?.stack ?? ev.reason).split('\n').slice(0, 4).join(' | ')); },
};
let consoleError = null;
/** engine:error is the engine saying a hook or a frame failed: always a failure (console.error and engine.error catch most of it too; this one names the site) */
function watchErrors(E) { const run = G; E.events.on('engine:error', info => { if (G === run) fail(`engine:error at ${info?.where ?? '?'}: ${String(info?.message).slice(0, 60)}`, JSON.stringify(info).slice(0, 400)); }); }

export async function begin({ seed, saveKey }) {
  if (G) await end();
  consoleError = console.error;
  console.error = (...a) => { const m = a.map(x => (x?.stack ?? String(x))).join(' '); if (G) fail(`console.error: ${m.slice(0, 80)}`, m.split('\n').slice(0, 4).join(' | ')); };
  window.addEventListener('error', hooks.error); window.addEventListener('unhandledrejection', hooks.rejection);
  G = { seed, saveKey, fails: [], refusals: {}, log: [], jobs: [], undo: [], saved: {}, held: null, rate: null, limp: null, quit: false, current: 'setup', baseIds: [], wild: new Set(), frames: 0, csm: null, csm2: null, env: null, lamp: null, skyOff: null };
  Object.assign(G, await buildGame({ saveKey, seed }));
  watchErrors(G.E);
  { const E = G.E; G.picBase = { exposure: E.renderer.toneMappingExposure, sun: E.uniforms?.uSunBrightness?.value, cloud: E.uniforms?.uCloudCover?.value, mapSize: E.lights?.sun?.shadow.mapSize.x, shadows: E.shadows.enabled, tier: E.tier }; }
  G.carOn = G.E.rigid;
  step(5, true);
  G.baseIds = recordIds();
  // the reference for "bounded": the same calm state the final audit measures
  await settle([follow('setup newGame', G.E.session.newGame())], 120);
  step(10, true);
  G.base = measure();
  return { base: G.base, ids: G.baseIds, fails: G.fails };
}

export async function act(x) {
  const key = `${x.a}:${x.p[0]}`, why = SKIPS[x.a] ?? SKIPS[key];
  if (why) { G.log.push(`skip ${line(x)}: ${why}`); return { fails: G.fails, skipped: true }; }
  G.current = line(x); G.log.push(G.current);
  try {
    const r = ACTS[x.a](...x.p);
    if (x.a === 'audit') await r;   // the audit waits for every job, so it cannot be one
    else if (r && typeof r.then === 'function') { const j = follow(line(x), r); if (!x.bg) await settle([j], 300); }
  } catch (e) { coded(e, x.a); }
  step(1, true);
  frameCheck();
  quick();
  return { fails: G.fails };
}

/** Which backend drew: webgl, webgpu, or webgpu's WebGL2 fallback (headless Chrome often has no adapter) */
const backendName = E => (E.renderer?.isWebGPURenderer ? (E.renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgpu-webgl2') : 'webgl');

/** What a run ended as, in parts: two runs of one list must give the same parts */
export function endState() {
  const E = G.E, parts = [G.log.join('\n'), JSON.stringify(recordIds()), JSON.stringify(G.refusals), E.player ? E.player.position.toArray().map(v => v.toFixed(3)).join() : '', String(E.random.state)];
  for (const r of E.world.records.values()) parts.push(`${r.id}:${(r.position?.x ?? 0).toFixed(2)},${(r.position?.z ?? 0).toFixed(2)}`);
  return parts;
}

export async function end() {
  const run = G, out = { fails: run?.fails ?? [], refusals: run?.refusals ?? {}, log: run?.log ?? [], state: run ? endState() : [], frames: run?.frames ?? 0, backend: run ? backendName(run.E) : '' };
  try { run?.E.dispose(); } catch (e) { out.fails.push({ kind: `dispose threw: ${e.message}`.slice(0, 90), detail: String(e.stack).split('\n').slice(0, 3).join(' | ') }); }
  G = null;
  if (consoleError) console.error = consoleError;
  window.removeEventListener('error', hooks.error); window.removeEventListener('unhandledrejection', hooks.rejection);
  return out;
}
