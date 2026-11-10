// "Who wrote this value": the file:line and frame that changed it, a short history, and a one-line hint when two places fight over it. Dev server only (npm run dev,
// threedog snap): the install line in Engine.js is the one test a bundler drops, so a release build has none of this. It observes; every write goes through.
//
// What is watched, and why these: picture values (a light, the fog, tone, environment, background, a material color), because nothing else stands between two picture
// files; values the engine writes on its own (core/ops/owned.js), because the engine yields quietly and "who took it" was the missing fact; shared points, which
// keep their owner and line anyway, so they need no hook at all; and whatever the game names with engine.debug.watch.
// What is not, on purpose: every other three.js property. An accessor on each would be the wrapper this engine promises not to be (docs/design.md 5.5), so
// an unwatched value says "not tracked", and no answer here ever says two writers do not exist (valueHistory.js LIMIT).
//
// Why accessors and a stack, not per-hook attribution: picture/index.js calls all its parts from one engine.onRender, so "which hook was running" names the
// wiring file for every value. Only the call stack of the write tells parts apart. Why own accessors on r / g / b and x / y / z: Color and Vector3 are
// changed in place (fog.color.lerp(...), light.position.copy(...)), so watching light.color alone would see nothing.
//
// Why not a stack on every write: a stack costs 10-40 us here, and a picture that moves 100 values would pay milliseconds each frame. So a write that
// changes nothing is ignored, and a value written every frame is looked at every EVERY frames (staggered). What still gets a stack at once: the first
// frames, a value that was not written last frame (a one-shot write), and a frame with more writes to a value than its last looked-at frame had (a
// new writer). So `framesAgo` says how old the answer is, and `writtenSince` says the value moved after that, unseen. An answer is never presented as
// fresher than it is. A close record (owned and game-named values) also looks at the first write of every frame: an owned value moves every frame by the engine's own
// hand, so a single outside write would otherwise pass as usual, and the yield would have no line to give. That costs one stack per frame per moving value, not one per write.
//
// Why also "taking turns": two writers that never share a frame (one on even frames, one in a timer) overwrite each other just the same. But one state handing a value to
// another is normal, so it takes TURNS changes of writer within WINDOW frames. Each change seen also asks for a look next frame, or sampling would rarely see the next one.
//
// Why two places in one function are not a fight: fog.color.copy(a) then fog.color.lerp(b, t) is a value computed in steps. A place is a file plus a
// function name, plus the part running it. shortcut: outside parts, two anonymous functions or two same-named methods in one file count as one place, so a fight between them goes unwarned;
// upgrade by comparing function start lines if an agent reports one.
//
// Parts (modules, core/scene/pictureSlots.js): a value in a slot a part holds has a declared owner, so a write from anyone else is reported at once, naming the holder and
// both lines, not only when the two land in one frame (a held value written by a stray in another state would never be a fight). Who wrote it: the module running
// now (install, its hooks: core/engine/moduleTypes.js ownHook), else any frame in a file that part's code ran from (an event listener, a timer). A file two parts share
// cannot say which of them it was, so it counts as the holder: a warning that accuses the owner would teach agents to ignore this one.
// What cannot be seen: a write made before the holder took the slot, and a part added under another object rather than the scene root (see added).
//
// Leftovers: three.js objects have no owner, so ctx.track only removes what it was handed. Each root a picture part adds and each post effect is remembered until it
// leaves; what is still there after the part is gone, and a hook that outlived it, is reported by name. It observes, like the rest: nothing is cleaned up for the part.
import { warnOnce, fmt } from '../base/validate.js';
import { coded } from '../base/errorHints.js';
import { notePatch } from '../scene/threePatches.js';
import { sceneVisitor, onSceneRoot } from '../scene/sceneDelta.js';
import { stackFrames, frameText, callerAt, engineFile } from '../ops/stackFrames.js';
import { slotOfValue, slotHolder } from '../scene/pictureSlots.js';
import { LIMIT, remember, historyText, partsOf, sharedAnswer } from './valueHistory.js';

const EVERY = 30;   // frames between two looks at a value written every frame: a stale answer is at most half a second old
const DEPTH = 10;   // three's own frames above the writer: setter, Color.copy, lerpColors ... always fewer
const TURNS = 6, WINDOW = 240;   // changes of writer within 4 seconds at 60 frames: a state change makes one or two, a fight makes one per frame
const NOT = {
  before: 'not tracked: set before it entered the scene',
  start: 'not tracked: three.js default or set before the engine was made',
  own: 'not tracked: this object defines the property with its own accessor',
  none: 'not tracked: never written since tracking began',
  noFile: 'not tracked: the last write had no source file (console, eval or the picture check)',
  hidden: 'not tracked: it is no plain property a hook can sit on, so its writers cannot be seen',
};
// three.js and pre-bundled libraries are never "the writer": the line that called them is
const SKIP = /\/deps\/|\/node_modules\/|\/three(?:\.[a-z]+)*\.js$/;
const SELF = /core\/inspect\/pictureWriters\.js$/;
const CORE = /\/(?:core|render)\/(?:[^/]+\/)?[^/]+$/;   // with engineFile: core and render (and their folders: core/ops/x.js) write for the engine; modules/ count as parts, they hold slots like any other
const MATERIALS_MAX = 40;   // describe() stays small on a big scene; explain still answers any one of them
const SHARED_FIX = "make it a shared value: the owner defines it with engine.stacks.define(name, { base: 1 }) and reads it where it writes three.js, the others change it with ctx.mod(name, { mul: 0.5 }); for an amount that moves, take it once, const h = ctx.mod(name, { mul: 1 }), and call h.change(x) each frame (recipes/62-picture-code.md)";
const STRINGS = {
  conflict: "{value}: two writers {how}, {first} and {second}; the last write stands. engine.explain({ value: '{value}' }) has the history and the fix",
  fix: 'Fix, one of: (1) one place keeps the write, delete the other{claim}; (2) if both need a say, ' + SHARED_FIX,
  claim: ", and that part declares it with provides: ['{slot}']",
  held: "{value} is held by part '{holder}' (provides: ['{slot}'], {place}), but {at} ({who}) wrote it too. The later write is what is drawn, so one of them never shows. Fix, one of: (1) delete the write at {at}; " +
    "(2) if that code should own it, give it provides: ['{slot}'] and install it with engine.use(thatPart(), { replaces: '{slot}' }), which unloads '{holder}'; (3) if both need a say, " + SHARED_FIX,
  leftover: "part '{name}' is gone, but what it added is still there: {list}. Fix: in its install, hand each one to ctx.track, e.g. ctx.track({ remove() { e.scene.remove(obj); obj.geometry.dispose(); } }), or undo it in the part's dispose()",
};

const HOW = { frame: 'in one frame', turns: 'taking turns across frames' };

const page = { off: false, nextId: 0 };   // off: threePatches.off('picture-writers'), page-wide like the list

/** The writer of the running write: { at: 'picture/sky.js:12', key } or null when no frame names a source file */
function writerNow() {
  const E = /** @type {ErrorConstructor & { stackTraceLimit?: number }} */ (Error);   // stackTraceLimit is V8's (Chrome), not in the DOM typings
  const lim = E.stackTraceLimit; E.stackTraceLimit = DEPTH;
  const stack = new Error().stack; E.stackTraceLimit = lim;
  const all = stackFrames(stack ?? '').filter(x => !SELF.test(x.file)), i = all.findIndex(x => !SKIP.test(x.file));
  if (i < 0) return null;
  const f = all[i];
  // engine: the engine moved it for its own reasons (a debug view, the renderer fallback): no part's business. A frame skipped above can still be the engine's, in a game that has it in node_modules
  return { at: frameText(f), key: `${f.file}|${f.fn}`, file: f.file, frames: all.slice(i), engine: all.slice(0, i + 1).some(x => CORE.test(x.file) && engineFile(x.file)) };
}

// name: the value's writers name while it can be in a slot (null: a material); ownBy / ownAt: the holder's last write; last: the slot and whether its holder wrote last;
// same: another record already hooks this property and answers for this one; close: see the header; owned: the engine's modules write it, so they are no party to a fight;
// game: named by engine.debug.watch; turn*: the writer last seen, across frames
const newRec = (why, name = null) => ({ id: page.nextId++, at: null, why, seen: 0, wrote: -1, f: -1, n: 0, usual: 0, next: 0, sample: true, placeKey: null, placeAt: null, placeBy: null, fought: false, fight: null, name, ownBy: null, ownAt: null, last: null,
  history: [], same: null, close: false, owned: false, game: false, turnKey: null, turnAt: null, turnBy: null, turns: 0, turnFrom: -Infinity });
const real = r => r.same ?? r;
const who = name => name ? `part '${name}'` : 'code outside any part';

class Writers {
  constructor(e) {
    this.e = e;
    this.frame = 0;          // 0 = setup: every write gets a stack and nothing can fight yet (a game's setup overrides engine defaults on purpose)
    this.hooksRan = false;
    this.drawing = false;    // during the draw the engine swaps background / tone and puts them back: not a write to the picture
    this.stacks = 0;         // stacks taken, the whole cost of this file: read it to judge a slow dev frame
    this.fights = [];
    this.held = [];          // writes to a value another part holds
    this.leftovers = [];     // what removed parts left behind
    this.files = new Map();  // source file -> Set of the picture parts that ran from it
    this.homes = new Map();  // part -> a 'file:line' of its code once known, before that of the engine.use that installed it
    this.adds = new Map();   // part -> Map(thing -> { kind, name, at }), until the thing leaves
    this.addedBy = new WeakMap();   // thing -> part
    this.top = new Map();    // 'fog.far' -> record (scene, fog and renderer values)
    this.parts = new WeakMap();   // light or material -> { intensity: record, ... }
    this.hooked = new WeakMap();  // object -> Map(key -> record): one accessor per property, so a second record of it (a color two objects share, an owned value that is also a picture value) answers through the first
    this.shared = new Map();      // shared point -> its history (no record: nothing is hooked)
    const s = e.scene, r = e.renderer;
    this.number(r, 'toneMapping', this.named('renderer.toneMapping', NOT.start));
    this.number(r, 'toneMappingExposure', this.named('renderer.toneMappingExposure', NOT.start));
    this.number(r.shadowMap, 'enabled', this.named('renderer.shadowMap.enabled', NOT.start));   // the shared point is engine.shadows.enabled; a direct write here is reported like any other
    for (const k of ['environmentIntensity', 'backgroundIntensity']) this.number(s, k, this.named('scene.' + k, NOT.start));
    this.number(s, 'environment', this.named('scene.environment', NOT.none));
    const bg = this.named('scene.background', NOT.start);
    this.slot(s, 'background', bg, c => { if (c?.isColor) this.watch(c, 'rgb', bg); });
    if (s.background?.isColor) this.watch(s.background, 'rgb', bg);
    const fog = this.named('scene.fog', NOT.none);
    this.slot(s, 'fog', fog, f => this.fog(f, fog));
    if (s.fog) this.fog(s.fog, fog);
    this.roots = onSceneRoot(s, o => this.added(/** @type {any} */ (o).isLight ? 'light' : 'object', o, o.name || o.type), o => this.left(o));
    this.view = sceneVisitor(s, { enter: o => {
      if (/** @type {any} */ (o).isLight) this.light(o);
      const m = /** @type {any} */ (o).material;
      if (m) for (const x of [].concat(m)) this.material(x);
    } });
    for (const o of e._owned?.values() ?? []) this.owned(o);   // the view's values exist before this tool does
  }

  /**
   * A removed watch gives its property back: the accessor answers to the next live record that shares it, and when none is left the plain value returns.
   * Why: the accessor stays with the first record that hooked it; without this a later watch on the same property, or another record sharing it, recorded nothing
   */
  release(rec) {
    rec.stopped = true;
    const at = rec.at3, live = (rec.sharers ?? []).filter(s => !s.stopped);
    if (!at || at.mine.get(at.key) !== rec) return;
    if (live.length) {
      const [next, ...rest] = live;
      next.same = null; next.at3 = at; next.sharers = rest; for (const s of rest) s.same = next;
      at.mine.set(at.key, next);
    } else {
      const v = at.o[at.key];   // no live record: back to a plain property
      at.mine.delete(at.key);
      Object.defineProperty(at.o, at.key, { value: v, writable: true, configurable: true, enumerable: true });
    }
  }

  named(label, why) { const r = newRec(why, () => label); this.top.set(label, r); return r; }

  /** Own accessor for one plain value; false when the object has none to replace. Reads and writes pass straight through */
  slot(o, key, rec, after) {
    let mine = this.hooked.get(o);
    const had = mine?.get(key);
    if (had) { if (had !== rec) { rec.same = had; (had.sharers ??= []).push(rec); } return true; }
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (!d || !('value' in d) || !d.configurable) { if (rec.why !== NOT.none || !d) rec.why = NOT.own; return false; }
    if (!mine) this.hooked.set(o, mine = new Map());
    mine.set(key, rec); rec.at3 = { o, mine, key };
    let v = d.value;
    const t = this;
    Object.defineProperty(o, key, { configurable: true, enumerable: d.enumerable, get: () => v,
      set(x) { if (x === v) return; v = x; t.wrote(mine.get(key) ?? rec); after?.(x); } });   // mine.get: whoever answers for the property now (release may hand it on)
    return true;
  }
  number(o, key, rec) { this.slot(o, key, rec); }
  /** The components of a Color or Vector3, all reporting to one record: to the game it is one value */
  watch(c, keys, rec) { for (const k of keys) this.slot(c, k, rec); }
  /** A value changed in place, or a plain property; false when there is nothing to hook */
  hook(rec, o, key) {
    const c = partsOf(o) ? o : key != null && partsOf(o?.[key]) ? o[key] : null;
    if (c) { this.watch(c, partsOf(c), rec); return true; }
    return key != null && !!o && this.slot(o, key, rec);
  }

  /** An engine-written value (core/ops/owned.js): spec.objects names what it lives on, and its key is the property where there is one (view.pixelRatio has none: the renderer keeps it private) */
  owned(o) {
    if (page.off) return;
    const rec = this.top.get(o.id) ?? this.named(o.id, NOT.start);   // a module reinstalled: same name, maybe new objects, and the history goes on
    let any = false;
    for (const x of o.objects) any = this.hook(rec, x, o.key) || any;
    if (!rec.at) rec.why = any ? NOT.start : NOT.hidden;
    real(rec).close = real(rec).owned = true;
  }
  /** The last line outside the engine that wrote this owned value, for the yield warning and describe().owned. Null when no look saw it @param {string} id */
  outside(id) {
    const r = this.top.get(id);
    return r ? real(r).history.findLast(x => !x.engine)?.at ?? null : null;
  }
  /** A take on a shared point (sharedPoint.js). No stack: the entry already holds its line @param {string} name @param {{ owner: string, where: string | null }} ent */
  sharedTook(name, ent) {
    if (page.off) return;
    let h = this.shared.get(name);
    if (!h) this.shared.set(name, h = []);
    remember(h, { at: ent.where, frame: this.frame, owner: ent.owner });
  }
  /** engine.debug.watch: a game's own value, the same record as any other. A name in use is refused: it would hide what that name answers @param {string} label @param {any} o @param {string} [key] */
  watchNamed(label, o, key) {
    const old = this.top.get(label);
    if (page.off || (old && !old.game)) return { watching: false, remove() {} };
    const rec = this.named(label, NOT.none);
    rec.game = true;
    const watching = this.hook(rec, o, key);
    if (!watching) rec.why = NOT.hidden;
    real(rec).close = true;
    // the accessors stay, like threePatches.off: they pass values through, and another record may be answering through them
    return { watching, remove: () => { if (this.top.get(label) === rec) this.top.delete(label); real(rec).close = false; this.release(rec); } };
  }
  /** A color held in a property: the components, and the property itself (light.color = other replaces the object the components were on) */
  color(o, key, rec) {
    if (!o[key]?.isColor) return false;
    this.watch(o[key], 'rgb', rec);
    this.slot(o, key, rec, c => { if (c?.isColor) this.watch(c, 'rgb', rec); });
    return true;
  }

  /** A fog assigned now: its values were set by whoever wrote scene.fog, so they start with that answer, not with "not tracked" */
  fog(f, slotRec) {
    for (const k of ['near', 'far', 'density', 'color']) this.top.delete('fog.' + k);
    if (!f) return;
    const seed = r => { r.at = slotRec.at; r.why = slotRec.why; r.seen = slotRec.seen; return r; };
    for (const k of f.isFogExp2 ? ['density'] : ['near', 'far']) this.number(f, k, seed(this.named('fog.' + k, NOT.before)));
    this.color(f, 'color', seed(this.named('fog.color', NOT.before)));
  }

  light(l) {
    if (this.parts.has(l) || page.off) return;
    const at = this.e._things?.entryOf(l)?.[0]?.at, why = NOT.before + (at ? ` (added at ${at})` : '');
    const rec = k => newRec(why, () => `light:${l.name}.${k}`);   // read at each write: a light can be named after it entered the scene
    const p = { intensity: rec('intensity'), color: rec('color'), position: rec('position') };
    this.parts.set(l, p);
    this.number(l, 'intensity', p.intensity);
    this.color(l, 'color', p.color);
    this.watch(l.position, 'xyz', p.position);
    if (l.groundColor) this.color(l, 'groundColor', p.groundColor = rec('groundColor'));
  }

  material(m) {
    if (this.parts.has(m) || page.off) return;
    const p = {};
    this.parts.set(m, p);
    for (const k of ['color', 'emissive']) if (m[k]?.isColor) this.color(m, k, p[k] = newRec(NOT.before));
    for (const k of ['opacity', 'emissiveIntensity']) if (typeof m[k] === 'number') this.number(m, k, p[k] = newRec(NOT.before));
  }

  /** The hot path: runs on every write that changed a value. No stack unless the header's rules ask for one */
  wrote(hit) {
    if (page.off || this.dead || hit.stopped || this.drawing || this.e._probing) return;   // stopped: its watch was removed; dead: the engine was disposed. The accessors stay, but do no tracking
    const rec = real(hit), fr = this.frame;
    rec.wrote = fr;
    if (rec.f !== fr) {
      const cold = fr - rec.f > 1;
      rec.sample = fr === 0 || cold || fr >= rec.next;
      if (rec.sample) { rec.next = fr + EVERY + (rec.id & 7); rec.usual = 0; }   // & 7: values written together do not all come due in one frame
      rec.f = fr; rec.n = 0; rec.placeKey = null;
    }
    rec.n++;
    if (!rec.sample) {
      const more = rec.n > rec.usual;
      if (!more && !(rec.close && rec.n === 1)) return;
      if (more) { rec.sample = true; rec.next = fr + 1; }   // more writes than usual: this one may be a new writer; next frame sees all of them from the first
    }
    rec.usual = Math.max(rec.usual, rec.n);
    this.stacks++;
    const w = writerNow();
    rec.seen = fr;
    if (!w) { rec.at = null; rec.why = NOT.noFile; rec.placeKey = null; return; }
    if (rec.owned && engineFile(w.file)) w.engine = true;   // a module's write to an engine-owned value is the engine's: yielding is the rule there, not a fight
    const by = this.partsOf(w);
    this.claim(rec, w, by);
    remember(rec.history, { at: w.at, frame: fr, part: by[0], engine: w.engine });
    rec.at = w.at; rec.why = null;
    if (w.engine) return;   // the engine is no party to a fight: it yields, or it is a debug view
    const place = `${w.key}|${by[0] ?? ''}`;   // the part too: two parts' anonymous hooks in one file are two places
    if (fr > 0 && rec.placeKey && rec.placeKey !== place && !rec.fought) this.fight(rec, rec.placeAt, rec.placeBy, w.at, by[0], 'frame');
    this.turn(rec, place, w.at, by[0] ?? null, fr);
    rec.placeKey = place; rec.placeAt = w.at; rec.placeBy = by[0] ?? null;
  }

  /** The writer seen changed since the last look: often enough, in a short enough time, and it is a fight that never shares a frame */
  turn(rec, place, at, by, fr) {
    const was = rec.turnKey, wasAt = rec.turnAt, wasBy = rec.turnBy;
    rec.turnKey = place; rec.turnAt = at; rec.turnBy = by;
    if (rec.fought || fr === 0 || !was || was === place) return;
    rec.next = fr + 1;
    if (fr - rec.turnFrom > WINDOW) { rec.turnFrom = fr; rec.turns = 0; }
    if (++rec.turns >= TURNS) this.fight(rec, wasAt, wasBy, at, by, 'turns');
  }

  /** The parts this write can be from: the running module alone, else every part that ran from a file on the stack, nearest first */
  partsOf(w) {
    const m = this.e._curModule;
    if (m) { if (m.type === 'picture' && !engineFile(w.file)) this.noteFile(w.file, m.name, w.at); return [m.name]; }
    for (const f of w.frames) { const s = this.files.get(f.file); if (s) return [...s]; }
    return [];
  }
  noteFile(file, part, at) {
    let s = this.files.get(file);
    if (!s) this.files.set(file, s = new Set());
    if (!s.has(part)) this.homes.set(part, at);
    s.add(part);
  }

  /** A value in a slot someone holds: a write by the holder is noted, one by anyone else is reported, once per value and place */
  claim(rec, w, by) {
    const label = rec.name?.(), slot = label ? slotOfValue(label) : null, holder = slot && slotHolder(this.e, slot);
    if (!holder) { rec.last = null; return; }
    if (rec.ownBy !== holder) { rec.ownBy = holder; rec.ownAt = null; }
    if (w.engine) return;
    if (by.includes(holder)) { rec.ownAt = w.at; rec.last = { slot, holder, writer: 'holder' }; return; }
    rec.last = { slot, holder, writer: 'stray', by: by[0] ?? null };
    rec.fought = true;   // this says more than a fight would, and the holder's next write would raise one
    const key = `${w.key}\0${label}`;
    if (this.held.some(h => h.key === key)) return;
    const place = rec.ownAt ? `last written at ${rec.ownAt}` : `it has not changed this value yet; its code is at ${this.homes.get(holder) ?? 'an unknown line'}`;
    this.held.push({ key, value: label, slot, holder, holderAt: rec.ownAt ?? this.homes.get(holder) ?? null, by: by[0] ?? null, at: w.at });
    warnOnce(coded('picture-held', fmt(STRINGS.held, { value: label, holder, slot, place, at: w.at, who: who(by[0]) })), `picture-held\0${key}`);
  }

  /** engine.use is installing m: where, for a report that has no line of the holder's yet */
  installing(m) { if (m.provides?.length) this.homes.set(m.name, callerAt()); }

  /** ctx.track called by m's own code: the caller's file is the part's, which is how a timer or a listener of the part gets attributed later */
  learn(m) {
    if (page.off || m.type !== 'picture') return;
    const E = /** @type {ErrorConstructor & { stackTraceLimit?: number }} */ (Error), lim = E.stackTraceLimit;
    E.stackTraceLimit = DEPTH;
    const stack = new Error().stack; E.stackTraceLimit = lim;
    const f = stackFrames(stack ?? '').find(x => !SELF.test(x.file) && !/core\/engine\/modules\.js$/.test(x.file));
    if (f && !engineFile(f.file)) this.noteFile(f.file, m.name, frameText(f));
  }

  /**
   * A scene root or a post effect just added: which picture part it belongs to, if any.
   * shortcut: only scene roots are seen. A light put under the camera or under another part's group is no root and goes unreported; upgrade through the visitor's
   * pending adds in core/scene/sceneDelta.js if an agent reports one.
   */
  added(kind, thing, name) {
    if (page.off) return;
    const m = this.e._curModule;
    if (m ? m.type !== 'picture' : !this.files.size) return;
    const w = m ? null : writerNow(), part = m?.name ?? (w && this.partsOf(w)[0]);
    if (!part) return;
    let mine = this.adds.get(part);
    if (!mine) this.adds.set(part, mine = new Map());
    mine.set(thing, { kind, name, at: callerAt() });
    this.addedBy.set(thing, part);
  }
  left(thing) { this.adds.get(this.addedBy.get(thing))?.delete(thing); }

  /** A module was unloaded, its tracked handles and dispose already run: name what stayed. swapping: the newcomer takes over the slots' values */
  partGone(m, swapping) {
    const mine = this.adds.get(m.name);
    this.adds.delete(m.name);
    if (page.off || m.type !== 'picture') return;
    const left = [];
    for (const [thing, r] of mine ?? []) if (!thing._removed) left.push(r);   // _removed: a post handle; a scene root that left is already out of the map
    const e = this.e;
    for (const list of [e._onRender.before, e._onRender.after, e._frame, e._animate, e._fixed, e._fixedLate]) for (const f of list) if (f.part === m.name) left.push({ kind: 'hook', name: 'frame callback', at: f.at });
    if (!swapping) for (const [name, on] of [['scene.fog', e.scene], ['scene.environment', e.scene], ['scene.background', e.scene]]) {
      const r = this.top.get(name), key = name.slice(6);
      if (r?.last?.holder === m.name && r.last.writer === 'holder' && on[key] != null) left.push({ kind: 'value', name, at: r.at });
    }
    if (!left.length) return;
    this.leftovers.push({ part: m.name, left });
    const list = left.map(r => `${r.kind} '${r.name}'${r.at ? ` (added at ${r.at})` : ''}`).join(', ');
    warnOnce(coded('picture-leftover', fmt(STRINGS.leftover, { name: m.name, list })), `picture-leftover\0${m.name}\0${list}`);
  }

  fight(rec, first, firstBy, second, secondBy, how) {
    rec.fought = true;
    const label = this.labelOf(rec) ?? 'a watched value';
    const said = (at, by) => by ? `${at} (part '${by}')` : at;
    this.fights.push(rec.fight = { value: label, how, first, second, ...(firstBy ? { firstBy } : {}), ...(secondBy ? { secondBy } : {}) });
    warnOnce(coded('picture-conflict', fmt(STRINGS.conflict, { value: label, how: HOW[how], first: said(first, firstBy), second: said(second, secondBy) })), `picture-conflict\0${rec.id}`);
  }

  /** Every value with a name, in one pass: lights and materials are found through the scene, so their names are the current ones */
  everyValue() {
    this.view.sync();
    const out = new Map(this.top), seen = new Map();
    const add = (prefix, o, name) => {
      const p = this.parts.get(o);
      if (!p) return;
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      const id = `${prefix}:${name}${n > 1 ? '#' + n : ''}`;
      for (const k in p) out.set(`${id}.${k}`, p[k]);
    };
    const mats = new Set();
    this.e.scene.traverse(o => {
      const x = /** @type {any} */ (o);
      if (x.isLight) add('light', x, x.name || x.type);
      if (x.material) for (const m of [].concat(x.material)) mats.add(m);
    });
    for (const m of mats) add('material', m, m.name || `${m.type}-${m.uuid.slice(0, 6)}`);
    return out;
  }
  labelOf(rec) { for (const [k, r] of this.everyValue()) if (real(r) === rec) return k; return null; }

  answer(hit) {
    const r = real(hit);
    if (!r.at) return { at: null, note: r.why };
    return { at: r.at, framesAgo: this.frame - r.seen, ...(r.wrote > r.seen ? { writtenSince: true } : {}), ...(r.last ?? {}) };
  }
  /** describe('picture').writers: materials nobody wrote since they entered the scene are left out (each would say the same "not tracked") */
  list() {
    const values = {};
    let mats = 0, more = 0;
    for (const [k, r] of this.everyValue()) {
      if (k.startsWith('material:')) { if (!real(r).at) continue; if (++mats > MATERIALS_MAX) { more++; continue; } }
      values[k] = this.answer(r);
    }
    return { tracked: true, limit: LIMIT, frame: this.frame, stacks: this.stacks, values, conflicts: this.fights, held: this.held.map(({ key, ...h }) => h), leftovers: this.leftovers, ...(more ? { moreMaterials: more } : {}) };
  }
  /** One value by its describe name, a shared point's name or a name given to engine.debug.watch @param {string} label */
  why(label) {
    if (page.off) return { ok: false, text: `${label}: not tracked: threePatches.off('picture-writers') turned this off`, detail: null };
    const hit = this.everyValue().get(label);
    if (!hit && this.e.stacks.has(label)) return sharedAnswer(this.e, label, this.shared.get(label) ?? []);
    if (!hit) return { ok: false, text: `${label}: not tracked, so nothing is known about its writers. Names: describe('picture').picture.writers; any value: engine.debug.watch('${label}', object, 'key')`, detail: null };
    const r = real(hit), a = this.answer(hit), fight = r.fight, slot = slotOfValue(label);
    const owner = !a.slot ? '' : a.writer === 'holder' ? `, by part '${a.holder}', which holds ${a.slot}` : `, by ${who(a.by)}, a stray write: part '${a.holder}' holds ${a.slot}`;
    const age = a.framesAgo ? `, looked at ${a.framesAgo} frames ago${a.writtenSince ? ' (written since, not looked at)' : ''}` : '';
    const end = fight ? `Two writers ${HOW[fight.how]}: ${fight.first} and ${fight.second}. ${fmt(STRINGS.fix, { claim: slot ? fmt(STRINGS.claim, { slot }) : '' })}` : `No fight seen; ${LIMIT}`;
    const text = [`${label}: ${a.at ? `last changed at ${a.at}${owner}${age}` : a.note}`, historyText(r.history), end].filter(Boolean).join('. ');
    return { ok: !!a.at, text, detail: { ...a, history: r.history, ...(fight ? { conflict: fight } : {}) } };
  }

  /** Top of a frame's hooks. Two frame hooks with no draw between (engine.step many frames, one draw) are two frames: a state change between them is no fight */
  frameStart() { this.view.sync(); if (this.hooksRan) this.frame++; this.hooksRan = true; }
  /** After the draw. The fixed steps before the next hooks count with that next frame, which is what they lead to */
  frameEnd() { this.drawing = false; this.frame++; this.hooksRan = false; }
  dispose() { this.dead = true; this.view.remove(); this.roots.remove(); }
}

/** @param {any} e */
export function installPictureWriters(e) {
  notePatch('picture-writers', 'dev server only: intensity, color, position of lights, scene.fog and its values, renderer.toneMapping / toneMappingExposure, scene.environment / background and their intensities, material color / emissive / opacity, the camera and other values the engine writes on its own (describe().owned), and values named with engine.debug.watch: an own get / set on each, and on the components of a Color, Vector or rotation (core/inspect/pictureWriters.js)',
    () => { page.off = true; },   // accessors already placed stay and only pass values through; new objects get none
    { scope: 'objects in the scene', lost: "describe('picture').writers and explain({ value }) stop answering, engine.debug.watch watches nothing, and two writers are no longer warned about" });
  e._picture = new Writers(e);
}
