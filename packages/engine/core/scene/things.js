// Object registry behind engine.thing: every root handed to engine.add gets a small entry saying what it is called, where it was made, who manages
// it and how much a save keeps. Why a table and not a scene walk: "what is this, will a save keep it?" must work for a plain three.js object too, and a
// release build may pay only two table writes per add (WeakMap entry + id -> WeakRef), no traversal and no per-frame cost.
// The WeakMap does not keep objects alive and the id map holds only WeakRefs, so a game that drops an object without engine.remove leaks nothing.
// Overrides (thing.set / thing.remove on objects the game's code rebuilds each start) live here too and are the 'scene' save part (version 1):
//   { set: { id: { position?, rotation?, scale?, visible? } }, removed: [id] }; ids a save names before the object exists wait in pending.
import { DEV, warnOnce } from '../base/validate.js';
import { codedError, coded } from '../base/errorHints.js';
import { stackFrames, frameText } from '../ops/stackFrames.js';
import { isPlainObject } from '../base/util.js';
import { refuseSave } from '../base/saveValues.js';

/** Throw save-bad-record when the 'scene' part is not { set: { id: { prop: value } }, removed: [id] } (same refusal as the world part, world/persist.js) */
function checkSceneSave(d) {
  const bad = (path, want, got) => refuseSave('scene', path, `must be ${want}`, got);
  if (d == null) return;
  if (!isPlainObject(d)) bad('the scene part', 'a plain object', d);
  if (d.set !== undefined && !isPlainObject(d.set)) bad('set', 'a plain object of id -> properties', d.set);
  for (const [id, p] of Object.entries(d.set ?? {})) if (!isPlainObject(p)) bad(`set.${id}`, 'a plain object of properties', p);
  if (d.removed !== undefined && !(Array.isArray(d.removed) && d.removed.every(id => typeof id === 'string'))) bad('removed', 'an array of ids', d.removed);
}

/** Stacks taken per session in dev: bullets or debris added every frame must not slow dev builds down for a file:line nobody reads */
const STACK_CAP = 2000;
const KEYS = ['position', 'rotation', 'scale', 'visible'];
/** 'main.js:50' from a captured Error: frame 0 is captureStack, 1 engine.add (or the scene.add hook), 2 its caller; the host part of a URL is dropped */
function stackAt(err) { const f = stackFrames(err?.stack)[2]; return f ? frameText(f) : null; }

/**
 * Objects an engine module puts in the scene itself (sky dome, terrain chunks, default lights): owner name per object. A plain scene.add is
 * adopted as a game object, so a module that adds with scene.add (often before engine.add exists, at construction) marks its objects here
 * and they are registered under their module instead of showing up as the game's. A WeakMap: nothing is held after the object is dropped.
 */
const MODULE_OWNER = new WeakMap();
/**
 * Mark objects as an engine module's before scene.add (returns the first, so it fits in the call). For module code; a game never needs it.
 * @example scene.add(engineOwned('sky', this.dome));
 * @template {import('three').Object3D} T @param {string} module @param {[T, ...import('three').Object3D[]]} objs @returns {T}
 */
export function engineOwned(module, ...objs) { for (const o of objs) MODULE_OWNER.set(o, `engine:${module}`); return objs[0]; }
/** The module owner engineOwned gave obj, else undefined @param {any} obj */
export const moduleOwnerOf = obj => MODULE_OWNER.get(obj);

/** One registered root. `at` parses the stack the first time it is read (V8 formats a stack only when .stack is read) */
class Entry {
  constructor(id, stable, owner, phase, op, tick, save, stack) {
    this.id = id; this.stable = stable; this.owner = owner; this.phase = phase; this.op = op; this.tick = tick; this.save = save; this._stack = stack;
    this._at = stack ? undefined : null;
  }
  get at() { if (this._at === undefined) { this._at = stackAt(this._stack); this._stack = null; } return this._at; }
}

/** Plain-data transform of an object, in the shape the 'scene' part stores */
export const snap = o => ({ position: o.position.toArray(), rotation: [o.rotation.x, o.rotation.y, o.rotation.z], scale: o.scale.toArray(), visible: o.visible });
/** Write a (normalised) patch onto an object */
export function write(o, p) {
  if (p.position) o.position.fromArray(p.position);
  if (p.rotation) o.rotation.set(p.rotation[0], p.rotation[1], p.rotation[2]);
  if (p.scale) o.scale.fromArray(p.scale);
  if (p.visible !== undefined) o.visible = p.visible;
}
const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));

/**
 * Ids are one space shared by engine.add objects and world records, checked from both sides. obj = the object engine.add is registering; null when
 * world.add asks (record ids such as 'crate#3' may hold '#', and the world does not know the object). Only an explicit { id } is a stable id: obj.name is
 * never one (GLB roots are all called 'Scene' / 'Cube', so a save would follow creation order). @internal
 */
export function claimId(e, id, obj = null) {
  const T = e._things, who = obj ? `engine.add(obj, { id: '${id}' })` : `world.add({ id: '${id}' })`;
  if (obj && (typeof id !== 'string' || !id || id.includes('#'))) throw codedError('thing-id', `engine.add(obj, { id: ${JSON.stringify(id)} }): an id is a non-empty string without '#' ('#' marks runtime ids such as obj#3), e.g. { id: 'windmill' }`);
  if (obj && T.source(id)) throw codedError('thing-id', `${who}: '${id}' is a world record id (engine.thing('${id}') shows it). Ids are shared with world records: pick another`);
  const other = T.live(id);
  if (other && other !== obj && T.byObj.get(other).owner !== 'world') {
    const at = T.byObj.get(other).at;
    throw codedError('thing-id', `${who}: '${id}' is already the id of ${obj ? 'another object' : 'an object added with engine.add'}${at ? ` (added at ${at})` : ''}. Ids are unique across engine.add and world records: pick another`);
  }
}

/** engine._things (internal): the registry. The public face is engine.thing (thingOps.js) and engine.add / remove (sceneMethods.js) @internal */
export class Things {
  constructor(e) {
    this.e = e;
    this.sources = [];              // record stores (world) registered with addSource; core knows only their shape
    this.byObj = new WeakMap();
    this.byId = new Map();          // id -> WeakRef(root)
    this.n = 0;                     // session ids obj#n
    this.stacks = 0;
    this.setup = false;             // true inside sessionStart hooks and session:start listeners: what they add is rebuilt by code every playthrough
    this.over = new Map();          // stable id -> { orig, cur }: thing.set overrides (orig = the code-built transform, for load / newGame / undo)
    this.removed = new Set();       // stable ids removed with thing.remove (saved)
    this.gone = new Map();          // id -> { obj, parent }: removed with thing.remove, detached and held so undo or a load can put it back
    this.pending = { set: {}, removed: new Set() };   // from a loaded save, objects not registered yet (orphans if they never come)
    this.unsaved = new Set();       // WeakRefs of session-tier objects someone expected to keep (save: true, or made inside an op)
    this.conflicts = [];            // dev: "two systems manage one object" findings, newest last
  }
  /** @internal step 4 of the session reset (session.js), before the modules' sessionStart hooks and the 'session:start' listeners: what they add is setup */
  setupTurn() { this.setup = true; queueMicrotask(() => { this.setup = false; }); }
  /**
   * A store of records that share the id space with engine.add objects (the world module registers itself at install). The shape core uses:
   * { has(id), get(id) -> { position, ... }, ids(), idOf(obj) -> id | null (model -> record), view(id) -> Object3D | null,
   *   explain(id) -> the record as a thing, set(id, patch) -> undo values, remove(id) -> restore token, restore(token) }
   * @param {any} src @returns {{ remove(): void }}
   */
  addSource(src) { this.sources.push(src); return { remove: () => { this.sources = this.sources.filter(s => s !== src); } }; }
  /** The source that has a record under id, else null */
  source(id) { return this.sources.find(s => s.has(id)) ?? null; }
  /** The record id whose model is obj, else null */
  idOf(obj) { for (const s of this.sources) { const id = s.idOf?.(obj); if (id) return id; } return null; }
  /** Every record id (for "did you mean") */
  recordIds() { return this.sources.flatMap(s => s.ids?.() ?? []); }
  /** Whether a dev stack should be taken for this add (cap reached = no) */
  wantStack() { return this.stacks < STACK_CAP && ++this.stacks > 0; }
  get atCapped() { return this.stacks >= STACK_CAP; }

  /** The live root registered under id, else null (a dead WeakRef or a re-registered object is cleaned up on the way) */
  live(id) {
    const ref = this.byId.get(id); if (!ref) return null;
    const o = ref.deref();
    if (o && this.byObj.get(o)?.id === id) return o;
    this.byId.delete(id); return null;
  }
  /** [entry, root] for obj or its nearest registered ancestor */
  entryOf(obj) { for (let o = obj; o; o = o.parent) { const en = this.byObj.get(o); if (en) return [en, o]; } return null; }
  /** Save tier, judged in order (recipe 40) */
  tier(en) { return en.owner === 'world' ? 'record' : en.owner !== 'game' ? 'engine' : en.stable && en.phase === 'setup' ? 'code' : 'session'; }

  /**
   * Register one root (engine.add). owner: 'game' (default) | 'world' | 'level' | 'stream' | 'engine:<module>'. Re-adding a detached object keeps its entry (one with a stable id; one without is forgotten once it leaves the scene, thingOps.js).
   * @param {any} obj @param {{ id?: string, owner?: string, save?: boolean } | null} opts @param {Error | null} stack
   */
  add(obj, opts, stack) {
    const owner = opts?.owner ?? 'game', old = this.byObj.get(obj);
    if (old && (opts?.id == null || opts.id === old.id)) return old;
    let id = opts?.id ?? null, stable = id != null;
    if (stable && owner !== 'world') claimId(this.e, id, obj);
    if (!stable) id = `obj#${++this.n}`;
    const e = this.e, play = e.ready && !this.setup;
    const en = new Entry(id, stable, owner, play ? 'play' : 'setup', play ? e.ops.running : null, play ? e.time.tick : null, opts?.save, stack);
    this.byObj.set(obj, en); this.byId.set(id, new WeakRef(obj));
    if (owner === 'game') this.adopt(obj, en);
    return en;
  }
  /** engine.remove, or a root without a stable id that left the scene (thingOps.js): forget the entry */
  forget(obj) {
    const en = this.byObj.get(obj); if (!en) return;
    this.byObj.delete(obj);
    if (this.byId.get(en.id)?.deref() === obj) this.byId.delete(en.id);
  }

  /** A game root just registered: dev warnings, and the loaded save's override / removal for its id */
  adopt(obj, en) {
    const tier = this.tier(en);
    if (tier === 'session' && (en.save === true || en.op)) {
      if (DEV) this.unsaved.add(new WeakRef(obj));   // only the dev reports read it, and they alone prune it
      if (DEV && en.save === true) warnOnce(coded('thing-unsaved', `engine.add(obj, { save: true })${en.at ? ` at ${en.at}` : ''}: this object cannot be saved (${en.stable ? 'it was made during play' : 'it has no stable id'}), so it will not come back after a load. Give it an id and add it at setup (engine.add(obj, { id: 'name' })), or make it a template and create it inside an op with engine.content.spawn(name, at)`));
    }
    if (tier === 'code') this.applySaved(obj, en.id);
  }
  /** The loaded save's override / removal for a code-tier id, now that its object exists */
  applySaved(obj, id) {
    const p = this.pending;
    if (id in p.set) { this.override(id, obj, p.set[id]); delete p.set[id]; }
    if (p.removed.has(id)) { p.removed.delete(id); this.hide(id, obj); }
  }

  /** Write a normalised patch as an override; returns the values it replaced (undo puts them back) */
  override(id, obj, patch) {
    const keys = KEYS.filter(k => k in patch), now = snap(obj), before = { patch: pick(now, keys), had: this.over.has(id) };
    let o = this.over.get(id);
    if (!o) this.over.set(id, o = { orig: now, cur: {} });
    write(obj, patch); Object.assign(o.cur, pick(snap(obj), keys));
    return before;
  }
  /** thing.remove on a game object: detach, hold for undo / load; a stable id is remembered by the save */
  hide(id, obj, saved = true) {
    this.gone.set(id, { obj, parent: obj.parent ?? this.e.scene });
    obj.removeFromParent();
    if (saved) this.removed.add(id);
  }
  /** Put a held object back (undo of thing.remove, or a load that does not remove it) */
  unhide(id) {
    const g = this.gone.get(id); if (!g) return;
    this.gone.delete(id); this.removed.delete(id);
    g.parent.add(g.obj);
  }

  // ---------- the 'scene' save part ----------
  save() {
    const set = {}, removed = [...this.removed];
    for (const [id, o] of this.over) set[id] = o.cur;
    // orphans from the loaded save ride along: a later build that brings the object back still gets its data
    for (const id in this.pending.set) set[id] ??= this.pending.set[id];
    for (const id of this.pending.removed) if (!this.removed.has(id)) removed.push(id);
    if (DEV) this.warnLost('saves.save()');
    return { set, removed };
  }
  /** Replace overrides with the save's: undo the current ones first (newGame applies an empty part), then apply to live objects, keep the rest pending */
  load(d) {
    checkSceneSave(d);   // before anything is touched: a damaged save is refused (save-bad-record) like a damaged world part, not a code error that freezes the game
    for (const [id, o] of this.over) { const obj = this.live(id); if (obj) write(obj, pick(o.orig, Object.keys(o.cur))); }
    this.over.clear();
    for (const id of [...this.removed]) this.unhide(id);
    this.pending = { set: { ...d?.set }, removed: new Set(d?.removed ?? []) };
    for (const id of Object.keys(this.pending.set).concat([...this.pending.removed])) {
      const obj = this.live(id);
      if (obj && this.tier(this.byObj.get(obj)) === 'code') this.applySaved(obj, id);
    }
    if (this.e.ready) this.warnOrphans();
  }
  /** Saved ids no object claimed: kept in the save (the code may bring them back), said once */
  orphans() { return [...new Set([...Object.keys(this.pending.set), ...this.pending.removed])]; }
  warnOrphans() {
    const ids = this.orphans();
    if (DEV && ids.length) warnOnce(coded('thing-orphan', `scene save part: no object has id ${ids.slice(0, 8).map(i => `'${i}'`).join(', ')}${ids.length > 8 ? ', …' : ''} (the code that added it with engine.add(obj, { id }) changed or no longer runs). The saved changes are kept; rename the id back, or ignore if it was deleted on purpose`));
  }
  /** Session-tier objects someone expected to keep, still alive: [{ id, at, op }] */
  lost() {
    const out = [];
    for (const ref of this.unsaved) {
      const o = ref.deref(), en = o && this.byObj.get(o);
      if (!en || !o.parent) { this.unsaved.delete(ref); continue; }
      out.push(en);
    }
    return out;
  }
  warnLost(where) {
    const l = this.lost(); if (!l.length) return;
    warnOnce(coded('thing-unsaved', `${where}: ${l.length} object(s) added with engine.add during play will not come back after a load (${l.slice(0, 5).map(en => `${en.id}${en.at ? ` at ${en.at}` : ''}${en.op ? ` in op ${en.op}` : ''}`).join(', ')}). To keep such things, make them a template and create them inside the op with engine.content.spawn(name, at)`));
  }
  /** Dev finding: two systems manage one object (kept for describe().scene.conflicts, warned once per text) */
  conflict(text) {
    if (!this.conflicts.includes(text)) { this.conflicts.push(text); if (this.conflicts.length > 20) this.conflicts.shift(); }
    warnOnce(coded('thing-owned', text));
  }
}
