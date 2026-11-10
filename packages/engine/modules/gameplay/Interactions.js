// Interactions module: a prompt appears near an object ("E · Talk"), and the interact key fires a callback (dialogue, pickup, fishing, chopping...).
//
// engine.interactions.add(npc, { label: 'Talk to the fisher', onUse: () => engine.dialogue.start('老渔夫') });
// Using one is the op interaction.use { id?, action? } (recipes/23-ops.md): the interact key (in fixed), a click on the prompt, the dev bridge and tests all
// run it,
// so every use is logged and checked by the same can (exists, enabled, in range, input not locked). Without id it uses the one the actor would pick now.
// Who interacts is engine.actor (core/ops/actor.js), measured with engine.actorPosition(): the player by default, a vehicle or squad member when the game says so.
// A seat (engine.input.seat) presses for its own seat.actor; the prompt and the options stay engine.actor's, since one screen shows one prompt;
// the op's ctx.actor (a net peer, an NPC) is handed to label / enabled / onUse as (object, { actor }).
// How the one in front of you is chosen is the pick option: 'nearest' | 'facing' | 'aim' | a function (see interactions()). Each action is picked on its own,
// so one object can carry "Open" and "Lock" as two interactions with different action names (each bound to the game's own key).
// The prompt is the UI part 'prompt' (default interactionPrompt.js, CSS class .threedog-prompt): replace it or turn it off with engine.ui.set('prompt', ...);
// prompt height interactions({ promptHeight }) (meters)
// hold: seconds turns the press into "keep it down": the engine counts progress on fixed steps and interrupts it on release, leaving reach, disabled or
// locked input, in one place, so no game re-writes a hold timer per verb; the prompt part gets progress 0-1 to draw.
// approach: true walks the actor's character there first (walkTo), then uses it: point-and-click, "talk to the shopkeeper across the room".
// once: true hides the object after a use that went through and it stays gone; counter: 'shells' adds 1 to that HUD counter (optional: engine.hud?.). So a
// mesh the game already built is a pick-and-count thing with no world record or bag; what was used is this module's save part, because a thing that comes
// back after a load while the count does not would be silently lost progress. Things that go in a bag, respawn or are decided by a net host: pickups.js.
// Finding candidates goes through one shared xz index (core/stream/cells.js) keyed by each item's actual world position, instead of measuring every interaction
// each frame. Before a pick pass reads it, items that follow an object are re-filed if they moved: for an object straight under the scene (models, pickups,
// hand-placed meshes) the check is its local position against the last one seen, so a still crowd costs a few compares; a nested one (a part of a vehicle)
// is measured. Why the actual position and not the world record's: a game may move a record's model away from its record, and the item must be found where
// it stands. Only items with an unbounded reach (radius Infinity) sit in a plain list, measured every pick. Candidates are then measured exactly and ties go
// to the earlier added, so a pick equals a full scan of every item.
import * as THREE from 'three';
import { worldToScreen } from '../../ui/UI.js';
import { promptPart } from './interactionPrompt.js';

import { readParams, keysSchema } from '../../core/base/params.js';
import { codedError, coded } from '../../core/base/errorHints.js';
import { reportError } from '../../core/base/errors.js';
import { failure } from '../../core/ops/opsFail.js';
import { refuseSave } from '../../core/base/saveValues.js';
import { isPlainObject } from '../../core/base/util.js';
import { DEV, warnOnce } from '../../core/base/validate.js';
import { vec3 } from '../../core/base/math.js';
import { Cells } from '../../core/stream/cells.js';
import { hintKey, keyed } from '../../core/input/inputPad.js';

const PICKS = ['nearest', 'facing', 'aim'];
// 'facing': within 60° either side of where the actor faces (wide enough for a gamepad stick, narrow enough that doors behind you stay dark)
const FACING_COS = 0.5;
const APPROACH_ARRIVE = 1.2;   // approach: meters from the target the walk stops at (inside the default 2.5 m reach, outside a body's radius)
const AIM_WIDTH = 0.75;   // 'aim': meters the object may sit off the screen-center ray (an object is a vertical segment from its base up to its prompt height)
const V = new THREE.Vector3(), W = new THREE.Vector3(), O = new THREE.Vector3(), D = new THREE.Vector3();
// index cell edge (m): a few times the usual reach, so a query circle touches one to four cells; a far larger reach still works (cells.js scans all cells
// when the circle covers more cells than exist)
const CELL = 8;

// The line that makes an action usable; the preset only for the action it covers. The message carries it because this fault looks like a working game to
// every other tool, so whoever hits it needs the fix on the spot.
const bindLine = action => action === 'interact' ? 'createEngine({ bindings: { ...presets.bindings.interact } }), or engine.input.bind(presets.bindings.interact) (E / gamepad X)'
  : `engine.input.bind('${action}', ['KeyX'])`;
const SETUP_FIX = "e.g. engine.use(interactions({ ...presets.interactions.nearest })) (import { presets } from 'threedog'), or interactions({ pick: 'nearest' | 'facing' | 'aim' | fn })";

export class Interactions {
  constructor(engine, { action, promptHeight, radius, pick } = {}, ctx) {
    // No default pick and no default key: which object counts as "in front of you" and which key uses it are the game's choices (genericity rule:
    // core carries no preset). presets.interactions.* are the picks, presets.bindings.interact the keys (declared here, bound by the game).
    if (pick === undefined) throw codedError('interaction-setup', `interactions(): no pick given; ${SETUP_FIX}`);
    if (typeof pick !== 'function' && !PICKS.includes(pick)) throw codedError('interaction-setup', `interactions({ pick }): '${pick}' is not a pick mode. Use ${PICKS.map(p => `'${p}'`).join(' | ')} or a function (candidates, ctx) => candidate`);
    ctx.track(engine.input.define(action, { label: 'input.interact', owner: 'interactions' }));
    this.engine = engine;
    this.action = action;
    this.radius = radius;
    this.promptHeight = promptHeight ?? 2.4;
    /**
     * How the interaction in front of the actor is chosen; can be swapped at runtime (first person: 'aim', top-down: 'nearest') @type {'nearest' | 'facing' |
     * 'aim' | Function}
     */
    this.pickMode = pick;
    // id -> item, in the order added (a Map keeps it): get(id) and remove are O(1), where an array find on every add and a filter on every remove
    // made adding or unloading n interactions O(n^2). Ties still go to the earlier added (_n), the order a linear scan had
    /** @internal */ this._byId = new Map();
    /** @internal _cells: every item with a finite reach, at its world position; _wide: the unbounded ones; _moving: the indexed ones that follow an object */
    this._cells = new Cells(CELL); this._wide = new Set(); this._moving = [];
    /** @internal reach -> how many indexed items have it, so the query radius (the largest reach) drops back when the far-reaching one is removed */
    this._radii = new Map(); this._maxR = 0;
    /** @internal the pass the index was last brought up to date in */ this._fresh = 0;
    /** @internal candidates of the current query (reused) */ this._cand = [];
    this._onCell = en => { this._cand.push(en.it); };
    /** The interaction the prompt shows (best over all actions), null if none */
    this.current = null;
    /** One best interaction per action this frame ([{ action, id, label }]) for a prompt that lists several keys */
    this.options = [];
    /** @internal action -> how many items use it, kept on add / remove, so a pass does not walk every item to list them */ this._actions = new Map();
    this._seq = 0; this._order = 0;
    /** @internal non-zero during one fixed() / update() pass: each item's world position is computed once per pass, not once per action */ this._pass = 0;
    this._passes = 0;
    ctx.track(engine.input.touchButton(action, 'input.interact'));
    ctx.ui.define('prompt', promptPart);
    /** @internal clicking the prompt: the same op as the interact key */
    this._use = () => { if (this.current) engine.ops.run('interaction.use', { id: this.current.id }, { source: 'player' }); };
    this._shown = false;
    /** The hold in progress { id, action, seconds, progress (0-1) }, null when none. Read-only: releasing the key stops it @type {any} */
    this.holding = null;
    /** @internal dev: an add since the last key check */ this._keysDue = false;
    /** @internal ids of the once items already used; _counted: counter name -> what uses added. The saved state, so both follow a load and a new game */
    this._spent = new Set(); this._counted = new Map();
    /** @internal ids of the once items whose async onUse has not settled: not spent yet, but not usable twice either */ this._waiting = new Set();
    ctx.saves.define('interactions', { atomic: true, version: 1, save: () => ({ spent: [...this._spent], counted: Object.fromEntries(this._counted) }), load: d => this._load(d) });
  }

  /**
   * Add an interaction. target is a three.js object (followed) or a fixed position (Vector3 / [x, y, z] / { x, y, z }). label is text or a function returning
   * text
   * (put state-dependent text here: () => locked ? 'Unlock' : 'Open'); enabled returning false hides the prompt entirely; action defaults to 'interact';
   * radius defaults to interactions({ radius }) (2.5 m; Infinity = from anywhere, usually with approach). Add two with different actions to give one object
   * two verbs. hold: seconds the key must stay down (progress goes to the prompt; release, leaving reach or disabled interrupts it: interaction:interrupt).
   * approach: true walks the player there first (walkTo, stops 1.2 m away), then uses it. Returns a handle { remove() }.
   * once: true hides the object after a use and it cannot be used again (onUse returning { ok: false } leaves it, also when an async onUse resolves to it or rejects: the use is judged
   * when it settles, and the item cannot be used again meanwhile); saved, and back on a new game. The save
   * knows it by id, else the object's name; development throws when it has neither. counter: name of a HUD counter that each use
   * adds 1 to (hud.bump; nothing without hud()); declare it once at setup with hud.addCounter(name, { label, value: 0, max }), not on session:start.
   * label, enabled and onUse are called with (object, { actor }): actor is the world record id of who asks / uses it (engine.actor for the local user,
   * a net peer's or an NPC's id when they run interaction.use), so per-actor rules never read engine.player.
   * @example engine.interactions.add(door, { label: (o, { actor }) => owns(actor) ? 'Open' : 'Knock', onUse: (o, { actor }) => engine.ops.run('door.open', { id: o.name }, { actor }) });
   * @example engine.interactions.add(door, { label: 'Open', onUse: open });
   * engine.interactions.add(door, { label: 'Lock', action: 'lock', enabled: () => hasKey, onUse: lock }); // a second verb: define the 'lock' action's key
   * first
   * @example engine.interactions.add(shell, { id: 'shell-1', label: 'Pick up', once: true, counter: 'shells' });   // a mesh you built: gone after E, counted
   * @example engine.interactions.add(well, { label: 'Pump', hold: 1.5, onUse: fill });                  // keep E down 1.5 s
   * engine.interactions.add(clerk, { label: 'Talk', radius: Infinity, approach: true, onUse: talk });   // from anywhere: walk over, then talk
   * @example // onUse may return a result; interaction.use hands it back as value. Returning { ok: false, code } (failure(code)) fails the op with that code:
   * const r = engine.ops.run('interaction.use'); if (!r.ok) say(r.code) // 'full' for a pickup in a full bag
   * @example // an async onUse: the op is ok once it started, and its value is a Promise of the answer (never a rejection: a throw answers { ok: false, code: 'error' })
   * const r = engine.ops.run('interaction.use', { id: 'shrine' }); const a = await r.value; if (a?.ok === false) say(a.code);
   */
  add(target, opts = {}) {
    readParams('interactions.add()', keysSchema(['id', 'label', 'radius', 'action', 'onUse', 'enabled', 'height', 'hold', 'approach', 'once', 'counter']), opts);
    const { label = '', radius = this.radius, action = this.action, onUse, enabled: allowed = () => true, height, hold = 0, approach = false, once = false, counter } = opts;
    if (!(typeof hold === 'number' && hold >= 0)) throw codedError('interaction-option', `interactions.add(): hold is the seconds the key stays down (hold: 1.5), got ${JSON.stringify(hold)}`, TypeError);
    if (!(radius > 0)) throw codedError('interaction-option', `interactions.add(): radius is meters > 0 (Infinity = from anywhere), got ${radius}`, TypeError);
    if (counter !== undefined && !(typeof counter === 'string' && counter)) throw codedError('interaction-option', `interactions.add(): counter is the name of a HUD counter (counter: 'shells'), got ${JSON.stringify(counter)}`, TypeError);
    // stable id for the interaction.use op: given, else the world record being built (pickup, NPC, entity), else (once: the save knows it by id) the mesh's
    // name, else a running number. The number counts adds over the page's life, so it means another thing after a rebuild: a once item kept under one
    // comes back after a load while its count stays, or hides the wrong thing. So once refuses it, and the fix is one word
    let id = opts.id ?? this.engine.world?.buildingId ?? (once && target?.name || null);
    if (once && (id == null || this.get(id))) throw codedError('interaction-option', `interactions.add(): a once item is saved by its id, and this one has ${id == null ? 'none' : `the same id as another ('${id}')`}. Give each a stable one: { id: 'shell-3', once: true }, or set mesh.name`, TypeError);
    id ??= 'interaction' + (++this._seq);
    if (this.get(id)) id += '#' + (++this._seq);
    let object = target;
    if (!target?.isObject3D) { object = new THREE.Object3D(); vec3(target, object.position); }
    // a fixed position never moves: its world position is known now; an object is measured once per pass (_at)
    // a used once item is simply not enabled: pick, the hold, describe and the op's can all ask enabled, so none of them needs a rule of its own
    const enabled = once ? (o, c) => !this._spent.has(id) && !this._waiting.has(id) && allowed(o, c) : allowed;
    const it = { id, object, label, radius, action, onUse, enabled, height, hold, approach: !!approach, once: !!once, counter, _p: new THREE.Vector3(), _at: target?.isObject3D ? -1 : Infinity,
      _n: this._order++, _en: null, _ix: null, _lx: NaN, _lz: NaN, _par: undefined };
    if (!target?.isObject3D) it._p.copy(object.position);
    if (once && this._spent.has(id)) object.visible = false;   // added again after a load (a level rebuilt): still gone
    this._byId.set(id, it);
    this._index(it);
    return { remove: () => { if (it._gone) return; it._gone = true; this._byId.delete(it.id); this._unindex(it); if (this.current === it) this.current = null; } };
  }
  /**
   * @internal Every use ends here (key, click, hold, approach, op), and is judged when onUse has settled, sync or async. An async one hands back a Promise of the same answer,
   * which never rejects: the key press that started it has nobody listening. A state replaced while it waited is not the state it was used in, so it spends nothing there
   */
  _run(it, actor) {
    const e = this.engine, r = it.onUse?.(it.object, { actor });
    if (typeof r?.then !== 'function') return this._judge(it, r);
    const state = e.saves.generation;
    this._waiting.add(it.id);   // an item removed (or replaced by a new one of the same id) while it waited spends nothing below: that one is gone
    return r.then(v => e.saves.generation === state && !it._gone ? e.ops.allow(() => this._judge(it, v)) : v, err => { reportError(e, err, `interaction '${it.id}' onUse`, { soft: true }); return failure('error'); })
      .finally(() => { if (e.saves.generation === state) this._waiting.delete(it.id); });
  }
  /** @internal once and counter count only a use that went through */
  _judge(it, r) {
    if (r?.ok === false) return r;
    if (it.counter && this.engine.hud) { this.engine.hud.bump(it.counter); this._counted.set(it.counter, (this._counted.get(it.counter) ?? 0) + 1); }
    // shortcut: once lives on the local peer (interaction.use is net: 'local'); a thing all peers share in a net game is a pickup (the host decides)
    if (it.once) { this._spent.add(it.id); it.object.visible = false; }
    return r;
  }
  /**
   * @internal Load or new game. A counter gets the difference, not a value: its base is the game's (hud.addCounter(name, { value })), this module only knows
   * what uses added. Only things whose state changed are shown or hidden: a once item the game hid itself stays hidden
   */
  _load(d) {
    const { spent, counted } = d ?? {};
    if (!Array.isArray(spent) || !spent.every(id => typeof id === 'string') || !isPlainObject(counted) || !Object.values(counted).every(Number.isFinite))
      refuseSave('interactions', 'the part', 'must be { spent: [id], counted: { id: number } }', d);
    const was = this._spent; this._spent = new Set(spent);
    if (this.engine.saves.replacing) this._waiting.clear();   // a load, not an atomic rollback: what was waiting belongs to the state just left
    for (const it of this._byId.values()) if (it.once && was.has(it.id) !== this._spent.has(it.id)) it.object.visible = !this._spent.has(it.id);
    for (const name of new Set([...this._counted.keys(), ...Object.keys(counted)])) {
      const d = (counted[name] ?? 0) - (this._counted.get(name) ?? 0);
      if (d) this.engine.hud?.bump(name, d);
    }
    this._counted = new Map(Object.entries(counted));
  }
  /** @internal File a new item: unbounded reach in the plain list, else in the cells (a followed one is placed for real on the next refresh) */
  _index(it) {
    this._actions.set(it.action, (this._actions.get(it.action) ?? 0) + 1);
    this._keysDue = true;
    if (it.radius === Infinity) { this._wide.add(it); return; }
    // a fixed one is filed at its position; a followed one at its own xz (_ix), apart from _p, the exact per-pass measurement
    it._en = { id: '#' + it._n, position: it._at === Infinity ? it._p : (it._ix = { x: NaN, z: NaN }), it };
    if (it._at === Infinity) this._cells.put(it._en); else { it._mi = this._moving.push(it) - 1; this._fresh = 0; }
    this._radii.set(it.radius, (this._radii.get(it.radius) ?? 0) + 1);
    if (it.radius > this._maxR) this._maxR = it.radius;
  }
  /** @internal */
  _unindex(it) {
    const a = this._actions.get(it.action) - 1;
    if (a) this._actions.set(it.action, a); else this._actions.delete(it.action);
    if (!it._en) { this._wide.delete(it); return; }
    this._cells.delete(it._en); it._en = null;
    if (it._at !== Infinity) { const m = this._moving, last = m.pop(); if (last !== it) { m[it._mi] = last; last._mi = it._mi; } }   // swap-remove by stored slot
    const n = this._radii.get(it.radius) - 1;
    if (n) this._radii.set(it.radius, n);
    else { this._radii.delete(it.radius); if (it.radius === this._maxR) { this._maxR = 0; for (const r of this._radii.keys()) if (r > this._maxR) this._maxR = r; } }
  }
  /**
   * @internal Bring followed items' index positions up to date, once per pass. An object straight under the scene root (or loose) whose local x / z are
   * what they were last time has not moved in the index: skipped after two compares (a pickup bobbing up and down costs nothing). Otherwise its world
   * xz is taken (through the parent's matrix when that parent is the root; measured for a nested one, whose ancestors may have moved, every pass) and it
   * is re-filed when its cell changed. Assumes the scene root itself is not moved or tilted (moving the whole scene moves nothing relative to the player).
   */
  _refresh() {
    if (this._fresh === this._pass) return;
    this._fresh = this._pass;
    const m = this._moving;
    for (let i = 0; i < m.length; i++) {
      const it = m[i], o = it.object, par = o.parent, l = o.position, ix = it._ix;
      const flat = o.matrixAutoUpdate && (!par || !par.parent);
      if (flat && par === it._par && l.x === it._lx && l.z === it._lz) continue;
      if (!flat) { o.getWorldPosition(V); ix.x = V.x; ix.z = V.z; }
      else if (!par) { ix.x = l.x; ix.z = l.z; }
      else { const e = par.matrixWorld.elements; ix.x = e[0] * l.x + e[4] * l.y + e[8] * l.z + e[12]; ix.z = e[2] * l.x + e[6] * l.y + e[10] * l.z + e[14]; }
      it._lx = l.x; it._lz = l.z; it._par = flat ? par : undefined;   // a nested one is measured again next pass
      this._cells.put(it._en);
    }
  }
  /** @internal Fill _cand with every item that may be within reach of pos (a superset; callers measure each exactly) */
  _gather(pos, action) {
    const C = this._cand, w = this._wide;
    C.length = 0;
    this._refresh();
    if (this._maxR) this._cells.forEach(pos, this._maxR, this._onCell);
    for (const it of w) C.push(it);
    if (action !== undefined) { let k = 0; for (let i = 0; i < C.length; i++) if (C[i].action === action) C[k++] = C[i]; C.length = k; }
    return C;
  }

  /** The interaction with this id (undefined if none). @param {string} id */
  get(id) { return this._byId.get(id); }
  /** All interactions in the order added (a fresh array each read) */
  get items() { return [...this._byId.values()]; }

  /** The interaction actor would use now for action (any action when omitted), by the pick mode; null if none in range. @internal */
  pick(actor = this.engine.actor, action) {
    // outside a fixed / frame pass (an op from a test or the dev bridge): a pass of its own, so the index is brought up to date for this pick too
    if (!this._pass) { this._pass = ++this._passes; try { return this.pick(actor, action); } finally { this._pass = 0; } }
    const e = this.engine, p = e.actorPosition(actor);
    if (!p) return null;
    const pos = W.set(p.x, p.y ?? 0, p.z), mode = this.pickMode;
    if (typeof mode === 'function') return this._custom(mode, actor, pos, action);
    // 'aim' follows the camera, which only the local user looks through; anyone else aims where they face
    const aim = mode === 'aim' && actor === e.actor;
    // the actor's body, for its facing
    const obj = mode === 'nearest' || aim ? null : actor === 'player' && e.player ? e.player.root : e.control.characterOf(actor)?.root ?? e.world?.view(actor) ?? null;
    if (obj) { obj.getWorldDirection(D); D.y = 0; D.normalize(); }
    if (aim) { e.camera.getWorldPosition(O); e.camera.getWorldDirection(D); }
    let best = null, bestS = Infinity;
    const C = this._gather(pos, action);
    for (let i = 0; i < C.length; i++) {
      const it = C[i], q = this._where(it), d = q.distanceTo(pos);
      if (d >= it.radius || !it.enabled(it.object, { actor })) continue;
      let s = d;
      if (aim) s = this._offRay(q, it.height ?? this.promptHeight);
      else if (obj && d > 0.5 && Math.hypot(q.x - pos.x, q.z - pos.z) > 1e-6) {   // standing on top of it (also straight above or below: no horizontal direction to compare) counts as facing it
        const c = ((q.x - pos.x) * D.x + (q.z - pos.z) * D.z) / Math.hypot(q.x - pos.x, q.z - pos.z);
        if (c < FACING_COS) continue;
        s = d / it.radius + (1 - c);   // mostly "straight ahead", then "closer"
      }
      if (s < bestS || best && s === bestS && it._n < best._n) { best = it; bestS = s; }   // a tie goes to the earlier added (the order a full scan had)
    }
    return best;
  }
  /** @internal An item's world position: cached for the current pass, live outside one (ops run from a test or the dev bridge) */
  _where(it) {
    if (it._at === Infinity) return it._p;
    if (this._pass && it._at === this._pass) return it._p;
    it._at = this._pass;
    return it.object.getWorldPosition(it._p);
  }
  /** @internal 'aim': meters from the camera ray (O, D) to the object's vertical segment; Infinity when behind the camera or too far off */
  _offRay(q, h) {
    const t = (q.x - O.x) * D.x + (q.y - O.y) * D.y + (q.z - O.z) * D.z;
    if (t <= 0) return Infinity;
    const rx = O.x + D.x * t, ry = O.y + D.y * t, rz = O.z + D.z * t;
    const off = Math.hypot(rx - q.x, ry - Math.min(Math.max(ry, q.y), q.y + h), rz - q.z);
    return off <= AIM_WIDTH ? off : Infinity;
  }
  /** @internal A game's pick function gets the enabled ones in range, nearest first */
  _custom(fn, actor, pos, action) {
    const list = [], C = this._gather(pos, action);
    for (let i = 0; i < C.length; i++) {
      const it = C[i], distance = this._where(it).distanceTo(pos);
      if (distance < it.radius && it.enabled(it.object, { actor })) list.push({ id: it.id, object: it.object, action: it.action, label: it.label, distance, _n: it._n });
    }
    if (!list.length) return null;
    list.sort((a, b) => a.distance - b.distance || a._n - b._n);
    for (const c of list) delete c._n;
    const c = fn(list, { engine: this.engine, actor, position: pos, action });
    return c ? this.get(c.id) : null;
  }
  /** @internal The key went down and nothing was used: logged like a refused interaction.use, with the same codes. A record, not a warning: tapping E in a menu is normal play */
  _pressRefused(action, reason, actor = this.engine.actor) { const e = this.engine; e.ops.refused('interaction.use', { action, ...(reason === 'inputLocked' && { by: lockFacts(e).by }) }, { reason, actor, source: 'player' }); }
  /** Fixed step: each action's key fires that action's pick (input snapshot, frame-rate independent; picked on the spot, not from last frame). @internal */
  fixed(dt) {
    const inp = this.engine.input;
    if (!inp.enabled) {
      if (this._hold) this._interrupt('inputLocked');
      // a press that does nothing still leaves a trace: an open dialogue swallowed every E, and the game's test could only report "have 0"
      for (const a of this._actions.keys()) if (inp.pressedRaw(a)) this._pressRefused(a, 'inputLocked');
      return;
    }
    this._pass = ++this._passes;
    try {
      if (this._hold) this._tickHold(dt);
      this._presses(inp, this.engine.actor);
      for (const s of inp.seats) if (s.actor) this._presses(s, s.actor);
    } finally { this._pass = 0; }   // as update(): a throwing use must not leave the pass open (every later pick would reuse stale positions)
  }
  /** @internal The presses of one input, engine.input or a seat, for the actor it acts for. One hold at a time: a press during someone's hold waits for it to end */
  _presses(input, actor) {
    for (const a of this._actions.keys()) {
      if (!input.pressed(a) || this._hold) continue;
      const b = this.pick(actor, a);
      if (!b) { this._pressRefused(a, 'nothingNear', actor); continue; }
      if (b.hold > 0) { this._hold = { it: b, action: a, t: 0, input, actor }; this._holdView(); this.engine.events.emit('interaction:hold', { id: b.id, action: a, seconds: b.hold }); }
      else this.engine.ops.run('interaction.use', { id: b.id }, { source: 'player', actor });
    }
  }
  /** @internal One fixed step of the hold: released / removed / disabled / out of reach interrupts it, else it counts; complete = the op interaction.use */
  _tickHold(dt) {
    const h = this._hold, it = h.it, e = this.engine, p = e.actorPosition(h.actor);
    const why = !h.input.down(h.action) ? 'released' : it._gone ? 'removed' : !it.enabled(it.object, { actor: h.actor }) ? 'disabled'
      : !p || this._where(it).distanceTo(W.set(p.x, p.y ?? 0, p.z)) >= it.radius ? 'tooFar' : null;
    if (why) return this._interrupt(why);
    h.t += dt; this._holdView();
    if (h.t < it.hold) return;
    this._hold = this.holding = null;
    e.ops.run('interaction.use', { id: it.id }, { source: 'player', actor: h.actor });
  }
  /** @internal */
  _holdView() { const h = this._hold; this.holding = { id: h.it.id, action: h.action, seconds: h.it.hold, progress: Math.min(1, h.t / h.it.hold) }; }
  /** @internal */
  _interrupt(reason) {
    const h = this._hold; this._hold = this.holding = null;
    this.engine.events.emit('interaction:interrupt', { id: h.it.id, action: h.action, reason, progress: Math.min(1, h.t / h.it.hold) });
  }

  /** Per frame: pick per action for options, and the prompt follows the best one. @internal */
  update() {
    this._pass = ++this._passes;
    try { this._update(); } finally { this._pass = 0; }
  }
  /**
   * @internal Dev: an interaction whose action has no key is reached by no key press, and nothing else would say so. A warning, not a throw: a click-only or touch-only
   * game runs the op from its own code and is right, so this must not stop it (bind the action to [] to say so and the warning ends). Only once running: code right
   * after `await engine.start()` may still bind. describe() keeps the note for every build.
   */
  _checkKeys() {
    this._keysDue = false;
    for (const a of this._actions.keys()) {
      if (this.engine.input.isUnbound(a)) warnOnce(coded('interaction-no-key', `interactions: action '${a}' has no key, so no key press reaches what was added to it. Add: ${bindLine(a)}. Reached by a click or your own code? engine.input.bind('${a}', []) says so`), `interaction-no-key:${a}`);
    }
  }
  /** @internal */
  _update() {
    if (DEV && this._keysDue && this.engine.phase === 'running') this._checkKeys();
    this.options.length = 0;
    const best = this.current = this._actions.size > 1 ? this._perAction() : this.pick();
    if (best && this._actions.size === 1) this.options.push({ action: best.action, id: best.id, label: labelOf(best, this.engine.actor) });
    const input = this.engine.input;
    const part = this.engine.ui.get('prompt');
    if (!best || !input.enabled || !part) { if (this._shown) part?.hide(); this._shown = false; return; }
    const label = labelOf(best, this.engine.actor), key = hintKey(input, best.action);
    best.object.getWorldPosition(V); V.y += best.height ?? this.promptHeight;
    const s = worldToScreen(this.engine, V);
    // progress: the running hold on this one (0-1), 0 for a hold not started, null for a plain press
    const progress = this.holding?.id === best.id ? this.holding.progress : best.hold > 0 ? 0 : null;
    part.update({ id: best.id, action: best.action, key, label, text: keyed(key, label), x: s.x, y: s.y, onScreen: s.onScreen, use: this._use, options: this.options, progress });
    this._shown = true;
  }
  /** @internal Several actions: fill options, return the default action's pick (else the first found) for the prompt */
  _perAction() {
    let main = null, first = null;
    for (const a of this._actions.keys()) {
      const b = this.pick(undefined, a);
      if (!b) continue;
      this.options.push({ action: a, id: b.id, label: labelOf(b, this.engine.actor) });
      if (a === this.action) main = b;
      first ??= b;
    }
    return main ?? first;
  }
}

// label / enabled / onUse all get (object, { actor }): who is asking is part of the question (a door that only its owner may open, a shop that greets each
// net peer by name), so a game never has to read engine.actor or engine.player inside them and they stay right for NPCs and peers
const labelOf = (it, actor) => typeof it.label === 'function' ? it.label(it.object, { actor }) : it.label;
// shortcut: approach walks only players (actor 'player' or a seat's); a squad / RTS game whose actor is an NPC gets 'cannotWalk' until NPC actors map to a Character
const walkerOf = (e, actor) => { const c = actor === 'player' ? e.player : e.input.seats.some(s => s.actor === actor) ? e.control.characterOf(actor) : null; return c?.walkTo ? c : null; };

const INTERACTION_PARAMS = {
  action: { type: 'string', default: 'interact', desc: 'input action that uses the interaction' },
  pick: { type: 'any', optional: true, desc: "which one counts as in front of you: 'nearest' | 'facing' | 'aim' | a function (required; checked with a fix hint on install)" },
  radius: { type: 'number', default: 2.5, min: 0, desc: 'reach in meters (add() can set its own)' },
  promptHeight: { type: 'number', optional: true, desc: 'prompt height above the target (meters)' },
};

/**
 * Interactions module. Installs engine.interactions.
 * pick is required (the engine picks none; presets.interactions.* name them); the game binds the action's keys (presets.bindings.interact: E / gamepad X). radius: default reach of add() in meters (2.5); pick: how the
 * interaction in front of the actor is chosen —
 * 'nearest' (top-down and third person), 'facing' (only what the actor faces, within 60°: souls-likes, the door behind you stays dark),
 * 'aim' (closest to the screen-center ray: first person and shooters), or a function (candidates, ctx) => one of candidates | null,
 * where candidates are the enabled ones in range ({ id, object, action, label, distance }, nearest first) and ctx is { engine, actor, position, action }.
 * @example engine.use(interactions({ ...presets.interactions.nearest }));   // + createEngine({ bindings: presets.bindings.interact }): E, the nearest one
 * engine.use(interactions({ pick: 'aim', radius: 2 }));                                       // first person
 * engine.use(interactions({ pick: (list) => list.find(c => c.id.startsWith('npc')) ?? list[0] }));   // people before things
 * @param {{ action?: string, promptHeight?: number, radius?: number, pick: 'nearest' | 'facing' | 'aim' | ((candidates: any[], ctx: any) => any) }} opts
 */
export function interactions(opts) {
  const o = readParams('interactions', INTERACTION_PARAMS, opts ?? {});
  let i = null;
  return { name: 'interactions', skipKind: 'none', type: 'rules', provides: ['interactions'], optional: ['hud'], label: 'Interactions', params: INTERACTION_PARAMS, options: o, noSkip: 'input and prompt state only', stage: 'gameplay',
    // o: the schema defaults are filled in, the class repeats none
    install(e, ctx) { e.i18n.add({ 'zh-CN': { 'module.interactions': '交互' }, en: { 'module.interactions': 'interactions' } }); i = new Interactions(e, o, ctx); defineUse(e, ctx, i); return i; },
    fixed(dt) { i.fixed(dt); }, frame() { i.update(); },
    // interactions are "weak" info: when an NPC, pickup or entity already reported the same object, only add "interactable: xxx"
    describe(e, ctx) {
      // no key: not "interactable", and no plain "interact: X" on an NPC's line, because no player input reaches it
      for (const it of i._byId.values()) if (it.enabled(it.object, { actor: e.actor })) {
        const name = labelOf(it, e.actor), noKey = e.input.isUnbound(it.action);
        ctx.near(it.object, { name, kind: noKey ? 'noKey' : 'interactable', use: noKey ? `${name} (no key bound for '${it.action}')` : name }, true);
      }
      if (i.current) return { current: labelOf(i.current, e.actor) };
    } };
}

/**
 * What keeps input locked, for the inputLocked result: a bare code sent a script through describe to learn that the title was still up.
 * by: the top opaque input context without its ui- / win- prefix ('title', 'settings', 'dialogue', 'cutscene', a game's own context).
 */
function lockFacts(e) {
  const top = (e.input.holders ?? []).filter(h => !h.pass).at(-1)?.context ?? 'unknown', by = top.replace(/^(ui|win)-/, '');
  return by === 'title' ? { by, fix: "start a run: engine.applyState({ play: true }) or threedog state play=1 (session.newGame() alone leaves the title open)" } : { by };
}

/** The engine op interaction.use { id?, action? }: what the interact key, the prompt click, the dev bridge and tests all run */
function defineUse(e, ctx, i) {
  const find = (id, action, ctx) => id !== undefined ? i.get(id) : i.pick(ctx.actor, action);
  ctx.ops.define('interaction.use', {
    desc: 'Use an interaction (talk, pick up, open...); without id, the one the actor would pick now (optionally for one action)',
    args: { id: 'string?', action: 'string?' },
    net: 'local',   // the prompt and reach are this player's; game ops inside onUse are routed to the host (net: 'peer' ones) or refused
    can(e, { id, action }, ctx) {
      const it = find(id, action, ctx);
      if (!it) return id === undefined ? 'nothingNear' : 'unknown';
      if (!it.enabled(it.object, { actor: ctx.actor })) return 'disabled';
      if (ctx.actor === e.actor && !e.input.enabled) return { code: 'inputLocked', facts: lockFacts(e) };
      if (it.approach && !walkerOf(e, ctx.actor)) return 'cannotWalk';
      const p = e.actorPosition(ctx.actor);
      if (it.approach || !p) return true;
      // tooFar names the distance, the radius and where to stand: a bridge / test call (threedog op interaction.use) with the player elsewhere
      // got a bare 'tooFar' and the AI guessed; applyState({ pos }) next to `at` first
      const d = it.object.getWorldPosition(V).distanceTo(W.set(p.x, p.y ?? 0, p.z)), r1 = v => Math.round(v * 10) / 10;
      return d >= it.radius ? { code: 'tooFar', facts: { distance: r1(d), radius: it.radius, at: { x: r1(V.x), z: r1(V.z) } } } : true;
    },
    // onUse's return value is the op's value; { ok: false, code } fails the op (pickups: code 'full' when the bag is full). An async onUse: the value is a Promise of that answer.
    // approach from afar: the value is { approaching } (a Promise of onUse's result after arrival, or the walk's { status } when it did not arrive)
    run(e, { id, action }, ctx) {
      const it = find(id, action, ctx);
      if (!it.approach) return i._run(it, ctx.actor);
      const ch = walkerOf(e, ctx.actor), q = it.object.getWorldPosition(new THREE.Vector3());
      if (Math.hypot(q.x - ch.position.x, q.z - ch.position.z) <= APPROACH_ARRIVE + 0.3) return i._run(it, ctx.actor);
      // the game holds this character on the walk's layer: 'cannot walk now' is an answer, and from the key press in a fixed step a throw would freeze play
      let walk; try { walk = ch.walkTo(q, { arrive: APPROACH_ARRIVE }); } catch (err) { if (err?.code === 'control-conflict') return { ok: false, code: 'cannotWalk' }; throw err; }
      // used after arrival, so checked again then: removed or disabled while walking = not used
      // the op ended steps ago: the use is the same op again, now in reach, so it has its actor, source, checks and a line in the history
      const use = () => { const u = e.ops.run('interaction.use', { id: it.id }, { actor: ctx.actor, source: ctx.source }); return u.ok ? u.value : u; };
      // the handle of the task it started: remove() calls the walk off, and the walk's cancelled answer is what approaching settles with
      return { approaching: Object.assign(walk.then(r => r.status === 'arrived' && !it._gone && it.enabled(it.object, { actor: ctx.actor }) ? use() : r), { remove: () => walk.remove() }) };
    },
    // no key: the op still runs when code asks (a click-only game), but it is not offered, so `ops` shows no ✓ for what no key reaches; describe() says why
    offers(e, ctx) { const it = find(undefined, undefined, ctx); return it && !(ctx.actor === e.actor && e.input.isUnbound(it.action)) ? [{ id: it.id }] : []; },
    reasons: { unknown: 'No interaction with this id', nothingNear: 'No interaction in range', disabled: 'Its enabled() is false', tooFar: 'Actor is outside its radius', cannotWalk: 'approach walks the player; this actor has no character to walk', inputLocked: 'A title, window, dialogue or cutscene locks input; facts.by names it' },
  });
}

export const handRolled = [{ kind: 'reach', seen: 'a hand-made reach check for interacting', use: 'engine.interactions.add(target, { ... }): prompt, range and the interact action are handled (recipe 20)', quiet: /\b(engine|e|eng|ctx)\.interactions\b/, code: /(?:\bdistanceTo(?:Squared)?\(|\bMath\.hypot\(|\bdist(?:ance)?\w*)[^;]*<=?\s*\d/, near: [{ re: /KeyE|['"]e['"]|interact|press e\b|talk/i, lines: 3, on: 'raw' }] }];
