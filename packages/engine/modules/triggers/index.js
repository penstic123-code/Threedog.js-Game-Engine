// Trigger zones: who enters, stays, leaves.
// Invisible regions in the world that notify you when the player, another actor or any position enters, leaves or stays inside.
// Use for: auto-opening a door, showing a place name on entering a village, traps, starting dialogue at a story spot, stopping music when leaving an area...
//
// const door = engine.triggers.add({
//   shape: 'box', position: { x: 4, y: 0, z: -2 }, size: [3, 3, 2],
//   tag: 'door', onEnter: t => openDoor(), onExit: t => closeDoor(),
// });
// door.remove();                                         // remove when no longer needed
// engine.events.on('trigger:enter', ({ tag }) => ...);   // or listen to the events globally
// engine.triggers.fromMarkers();                          // every trigger_xxx marker in the level becomes a trigger zone (tag = xxx)
//
// Parameters of add():
//   shape      'sphere' | 'box' (can rotate) | 'cylinder' (vertical, default)
//   position   center { x, y, z } / Vector3 / Object3D / [x, y, z]. For box and cylinder, y is the bottom height; if y is omitted, the ground height there is used
//   radius     sphere/cylinder radius (default 1.5); size [width, height, depth] (box, default [2,2,2]); height cylinder height (default 3)
//   volume     your own region instead of shape: { contains({x,y,z}) -> boolean, bounds?: { min, max } } (the same plain volume addWaterBody takes); bounds
//              (Box3-like) lets the zone be indexed and drawn by the debug view, without it the zone is checked every step
//   rotation   box rotation around the Y axis in radians (default 0)
//   onEnter(t, who, id) / onExit(t, who, id) / onStay(dt, t, who, id)   callbacks; who is the position that entered, id the world record id of who it is
//              (engine.actor for the default who, the id for an id in a custom who, object.userData.id for an Object3D, null for a bare position)
//   once       fire on the first enter only (default false; exit follows at once); t.used is true afterwards, and a new playthrough (engine.session) re-arms it
//   enabled    false pauses detection (handle.enabled can be changed any time)
//   tag        name carried in events, for shared handling
//   who        what can trigger: default is engine.actor and every seat's actor (engine.actorPosition(): the player, or what engine.actor names; engine.focus without a player); or an
//              actor id, a Vector3 / Object3D, or a function returning an array of those () => [e.actor, ...peerIds] (several actors)
//              (a zone with a function / object `who` is checked every step; zones with the default `who` cost nothing while the actor is far away)
//   cooldown   seconds after leaving during which enter will not fire again (stops edge jitter from re-triggering), default 0
// Returned handle: { tag, inside, enabled, used, remove(), contains(p) }
//
// Events: trigger:enter / trigger:exit with { tag, trigger, who, id }. On removal (remove / clear) and at the end of a playthrough, zones still occupied send exit first (who is null)
// Saved: the 'triggers' save part keeps each zone's used (once) and remaining cooldown, keyed by tag and order among zones of that tag
// ('door', 'door#1'; untagged: '(box)', '(cylinder)#2'). So a load restores them (a sprung trap stays sprung, a story zone never fires twice) and a
// new game re-arms them. Any load (newGame / session.load / saves.load) also exits occupied zones, so the zone around where the player stands fires
// enter again. Zones added during play belong to the game: wrap them in engine.session.track(h).
//
// Debug display: engine.debug.view('triggers') draws all trigger zones as wireframes, engine.debug.view('off') clears them. It is a debug view mode
//   (core/inspect/debugView.js) and not a triggers option, so it works like every other "show me the hidden thing": one call, owner-scoped, said in describe().render.
//   The debug lines take their color from triggers({ debugColor, debugOpacity }); neutral gray if absent.
//   The action triggersDebug toggles that view; it has no key of its own (presets.bindings.debug binds F4 with the debug panel's F3).
import { engineOwned } from '../../core/scene/things.js';
import { freeParts } from '../../core/base/freeParts.js';
import * as THREE from 'three';
import { readParams, keysSchema } from '../../core/base/params.js';
import { Cells } from '../../core/stream/cells.js';
import { codedError } from '../../core/base/errorHints.js';
import { placeY } from '../../core/scene/ground.js';
import { reportError } from '../../core/base/errors.js';

// Zones are indexed (core/stream/cells.js, the shared xz index) by the cells their bounding box covers, so a step looks at the zones near the actor instead of every
// zone. A zone with its own `who` (any position, unknown until it runs) or one covering more than MAX_CELLS cells goes to the always-checked `_global` list.
const CELL = 16, MAX_CELLS = 64, PAD = 0.01;   // PAD: contains() is inclusive, so a point exactly on the edge must still find the zone's cell
const DEBUG_GRAY = 0x9a9a9a;
const bySeqDesc = (a, b) => b._seq - a._seq;   // the order zones have always run in: newest first

const ADD_KEYS = ['shape', 'position', 'radius', 'size', 'height', 'rotation', 'onEnter', 'onExit', 'onStay', 'once', 'enabled', 'tag', 'who', 'cooldown', 'userData', 'occupancy', 'volume'];

const STRINGS = {
  'zh-CN': { 'module.triggers': '触发区', 'triggers.debug': '显示触发区' },
  en: { 'module.triggers': 'triggers', 'triggers.debug': 'Show triggers' },
};

export class Triggers {
  constructor(engine, { action = 'triggersDebug', debugColor = DEBUG_GRAY, debugOpacity = 0.8 } = {}, track) {
    this.engine = engine;
    this._list = [];
    this.action = action;
    /** @internal the debug wireframe's line color and opacity */ this._debugLine = { color: debugColor, opacity: debugOpacity, transparent: true, depthTest: false };
    this._one = [null];           // by default "who" is a single position: reuse this array to avoid per-frame allocation
    this._custom = [null];
    this._cps = []; this._cids = [];   // positions / ids of a custom who, resolved each visit
    this._ids = [null];            // id of each entry of the who list being checked (parallel to it; reused like _one)
    this._scan = [];               // zones update() visits this step (a snapshot: callbacks may add / remove zones)
    this._cells = new Cells(CELL); // zones by the cells their bounding box covers
    this._global = [];             // zones checked every step (custom `who`, or too large for the grid)
    this._busy = new Set();        // zones that need a visit even when nobody is near: occupied, or cooling down
    this._seq = 0; this._stamp = 0;
    /** @internal the wireframe group while the debug view 'triggers' is on (null otherwise) */ this._view = null;
    engine.i18n.add(STRINGS);
    track(engine.input.define(action, { label: 'triggers.debug', optional: true, owner: 'triggers' }));   // a dev tool: silent while unbound
    /** @internal */ this._viewDef = engine.debug.defineView('triggers', { what: 'every trigger zone drawn as a wireframe over the real picture (triggers({ debugColor }))', apply: scene => this._drawView(scene) });
  }

  add(opts = {}) {
    readParams('triggers.add()', keysSchema(ADD_KEYS), opts);
    const { shape = 'cylinder', position: at = {}, radius = 1.5, size = [2, 2, 2], height = 3, rotation = 0, onEnter = null, onExit = null, onStay = null,
      once = false, enabled = true, tag = '', who = null, cooldown = 0, userData = {}, occupancy = 'zone', volume = null } = opts;
    if (volume && typeof volume.contains !== 'function') throw codedError('module-params', 'triggers.add({ volume }): needs volume.contains({ x, y, z }) -> boolean and optionally bounds { min, max }');
    if (occupancy !== 'zone' && occupancy !== 'each') throw codedError('module-params', `triggers.add({ occupancy }): 'zone' (default: one enter when the first actor arrives, one exit when the last leaves) or 'each' (an enter and an exit per actor); got ${JSON.stringify(occupancy)}`);
    if (!(radius >= 0 && Number.isFinite(radius))) throw codedError('module-params', `triggers.add({ radius }): must be a finite number >= 0, got ${radius}`);   // NaN never matched and sat in the cell index
    const position = at.isObject3D ? at.position : Array.isArray(at) ? { x: at[0], y: at[1], z: at[2] } : at;
    const e = this.engine, x = position.x ?? 0, z = position.z ?? 0;
    const y = position.y ?? (volume ? 0 : placeY(e, 'triggers.add()', x, z));   // a volume carries its own place
    // a volume with bounds is indexed and drawn as its bounding box (the shape of a box with rotation 0); contains() stays the volume's own
    const bb = volume?.bounds, box = bb ? { x: (bb.min.x + bb.max.x) / 2, y: bb.min.y, z: (bb.min.z + bb.max.z) / 2, size: [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z] } : null;
    const t = {
      shape: volume ? 'volume' : shape, volume, x: box?.x ?? x, y: box?.y ?? y, z: box?.z ?? z, radius, hx: (box?.size ?? size)[0] / 2, hy: (box?.size ?? size)[1] / 2, hz: (box?.size ?? size)[2] / 2, sy: (box?.size ?? size)[1], height, rotation,
      c: Math.cos(rotation), s: Math.sin(rotation), onEnter, onExit, onStay, once, enabled, tag, who, cooldown, userData, occupancy, _in: null,
      inside: false, used: false, _cool: 0, _mesh: null, _gone: false,
      remove: () => this._remove(t),
      contains: p => this._contains(t, p),
    };
    t._seq = this._seq++; t._span = null;
    this._list.push(t); this._register(t);
    if (this._view) this._addDebugMesh(t);   // a zone added while the view is on shows at once
    return t;
  }

  _remove(t) {   // remove only through the handle t.remove(); zones still occupied send exit first (so music areas and content onExit can clean up)
    if (t._gone) return;
    // leave the books first: onExit may call t.remove() again or add / remove other zones, so no index taken before the callback is used after it (M08)
    t._gone = true;
    const i = this._list.indexOf(t); if (i >= 0) this._list.splice(i, 1);
    this._unregister(t); this._busy.delete(t);
    try { if (t.inside) this._exit(t, null); }
    finally { if (t._mesh) { t._mesh.parent?.remove(t._mesh); t._mesh.geometry.dispose(); t._mesh = null; } }   // an onExit that throws still frees the debug mesh
  }
  /** @internal remove each zone in its own try: one onExit that throws must not leave the rest (nor their debug meshes) standing; the error is reported and the loop goes on */
  _removeEach(zones, what) { for (const t of zones) { try { t.remove(); } catch (err) { reportError(this.engine, err, what); } } }
  _register(t) {
    if (t.who || (t.volume && !t.volume.bounds)) { this._global.push(t); return; }
    const ex = (t.shape === 'box' || t.volume ? t.hx * Math.abs(t.c) + t.hz * Math.abs(t.s) : t.radius) + PAD;
    const ez = (t.shape === 'box' || t.volume ? t.hx * Math.abs(t.s) + t.hz * Math.abs(t.c) : t.radius) + PAD;
    t._span = this._cells.cover(t, t.x - ex, t.z - ez, t.x + ex, t.z + ez, MAX_CELLS);
    if (!t._span) this._global.push(t);
  }
  _unregister(t) {
    if (t._span) this._cells.uncover(t); else { const i = this._global.indexOf(t); if (i >= 0) this._global.splice(i, 1); }
  }
  /** All trigger zones (a new array) */
  list() { return [...this._list]; }
  clear() { this._removeEach([...this._list], 'triggers.clear'); }
  byTag(tag) { return this._list.filter(t => t.tag === tag); }

  /**
   * Create trigger zones from level markers: each trigger_xxx becomes a zone with tag xxx.
   * Shape and size are read first from the marker's userData.shape / radius / size / height, otherwise derived from object scale:
   *   scale (sx, sy, sz) -> box [2sx, 2sy, 2sz] centered on the marker (matches Blender's default cube empty)
   * Callbacks etc. in opts are shared by every zone. Returns an array of created handles.
   * These zones belong to the current level: removed automatically on level change / unload (level.track)
   */
  fromMarkers(opts = {}) {
    const markers = this.engine.level?.markers || {};
    const out = [];
    for (const m of Object.values(markers)) {
      if (!/^trigger_/i.test(m.name)) continue;
      const u = m.userData || {}, s = m.scale, p = m.position;
      const shape = u.shape || opts.shape || 'box';
      const euler = new THREE.Euler().setFromQuaternion(m.quaternion, 'YXZ');
      const size = u.size || [2 * Math.abs(s.x), 2 * Math.abs(s.y), 2 * Math.abs(s.z)];
      const radius = u.radius ?? Math.max(Math.abs(s.x), Math.abs(s.z));
      const height = u.height ?? 2 * Math.abs(s.y);
      // box/cylinder y is the bottom: marker is the center, so shift down by half the height
      const half = shape === 'box' ? size[1] / 2 : shape === 'cylinder' ? height / 2 : 0;
      const t = this.add({ ...opts, shape, size, radius, height, rotation: euler.y, tag: m.name.slice(8), userData: u,
        position: { x: p.x, y: p.y - half, z: p.z } });
      this.engine.level?.track(t);
      out.push(t);
    }
    return out;
  }

  _contains(t, p) {
    if (t.volume) return !!t.volume.contains(p);
    const dx = p.x - t.x, dy = p.y - t.y, dz = p.z - t.z;
    if (t.shape === 'sphere') return dx * dx + dy * dy + dz * dz <= t.radius * t.radius;
    if (t.shape === 'box') {
      if (dy < 0 || dy > t.sy) return false;
      const lx = dx * t.c - dz * t.s, lz = dx * t.s + dz * t.c;    // same rotation convention as the collision module's rectangle
      return Math.abs(lx) <= t.hx && Math.abs(lz) <= t.hz;
    }
    return dy >= 0 && dy <= t.height && dx * dx + dz * dz <= t.radius * t.radius;
  }

  _defaultWho() {
    const e = this.engine;
    this._one[0] = e.actorPosition();   // engine.actor: the player by default, or the vehicle / squad member the game handed control to
    this._one.length = this._ids.length = 1; this._ids[0] = e.actor;
    for (const s of e.input.seats) if (s.actor && s.actor !== e.actor) { this._one.push(e.actorPosition(s.actor)); this._ids.push(s.actor); }   // every local player, as interactions and pickups
    return this._one;
  }

  /** @internal Fixed step: enter / stay / exit for the zones that can change: those near the actor, always-checked ones, occupied or cooling ones */
  update(dt) {
    if (!this._list.length) return;
    const def = this._defaultWho(), scan = this._scan, st = ++this._stamp;
    scan.length = 0;
    for (const t of this._busy) { t._q = st; scan.push(t); }
    const g = this._global;
    for (let i = 0; i < g.length; i++) { const t = g[i]; if (t._q !== st) { t._q = st; scan.push(t); } }
    for (let k = 0; k < def.length; k++) {
      const p = def[k]; if (!p) continue;
      const c = this._cells.at(p.x, p.z);
      if (c) for (const t of c) if (t._q !== st) { t._q = st; scan.push(t); }
    }
    if (scan.length > 1) scan.sort(bySeqDesc);   // a callback removing an earlier zone must not make a later one run twice: scan is a snapshot, removed zones are skipped
    for (let i = 0; i < scan.length; i++) {
      const t = scan[i];
      if (t._gone) continue;
      this._visit(t, dt, def);
      if (t._gone) continue;
      if (t.inside || t._cool > 0) this._busy.add(t); else this._busy.delete(t);
    }
  }
  _visit(t, dt, def) {
    const e = this.engine;
    if (t._cool > 0) t._cool -= dt;
    if (!t.enabled || t.used) { if (t.inside) this._exit(t, null); return; }
    let ps = def, ids = this._ids;
    if (t.who) {
      // a custom who names positions, objects or actor ids: resolve each to (position, id), so callbacks always say who it was, not only where
      const list = typeof t.who === 'function' ? t.who() : (this._custom[0] = t.who, this._custom);
      ps = this._cps; ids = this._cids; ps.length = 0; ids.length = 0;   // reused: no allocation per zone per step
      if (list) for (const x of list) {
        if (typeof x === 'string') { ps.push(e.actorPosition(x)); ids.push(x); }
        else if (x?.isObject3D) { ps.push(x.position); ids.push(x.userData?.id ?? null); }
        else { ps.push(x); ids.push(null); }
      }
    }
    if (t.occupancy === 'each') return this._visitEach(t, dt, ps, ids);
    let hit = null, id = null;
    if (ps) for (let k = 0; k < ps.length; k++) { const p = ps[k]; if (p && this._contains(t, p)) { hit = p; id = ids[k] ?? null; break; } }
    if (hit && !t.inside) {
      if (t._cool > 0) return;
      t.inside = true; t._id = id;
      if (t.once) t.used = true;   // spent before any callback runs: a save made inside onEnter or a trigger:enter listener already records it
      t.onEnter?.(t, hit, id);
      if (t._gone) return;   // onEnter removed the zone: remove() already ran its exit, so no enter event may follow it
      e.events.emit('trigger:enter', { tag: t.tag, trigger: t, who: hit, id });
      if (t._gone) return;   // a trigger:enter listener removed it: its exit has run too
      if (t.once) this._exit(t, null);
    } else if (!hit && t.inside) this._exit(t, null);
    else if (hit && t.inside) t.onStay?.(dt, t, hit, id);
  }
  /** @internal occupancy 'each': every actor in the zone enters, stays and exits on its own; t.inside is true while anyone is in. Cooldown runs from when the zone empties */
  _visitEach(t, dt, ps, ids) {
    const e = this.engine, inn = t._in ??= new Map(), now = new Map();
    if (ps) for (let k = 0; k < ps.length; k++) { const p = ps[k]; if (p && this._contains(t, p)) now.set(ids[k] ?? p, { p, id: ids[k] ?? null }); }
    for (const [key, o] of inn) if (!now.has(key)) { inn.delete(key); this._left(t, null, o.id); if (t._gone) return; }
    if (t.inside && !inn.size) { t.inside = false; t._cool = t.cooldown; }
    for (const [key, o] of now) {
      if (inn.has(key)) { t.onStay?.(dt, t, o.p, o.id); if (t._gone) return; continue; }
      if (t._cool > 0 && !inn.size) return;
      inn.set(key, o); t.inside = true;
      if (t.once) t.used = true;   // spent before any callback (see _visit)
      t.onEnter?.(t, o.p, o.id);
      if (t._gone) return;   // as _visit: no enter event after the exit remove() ran
      e.events.emit('trigger:enter', { tag: t.tag, trigger: t, who: o.p, id: o.id });
      if (t._gone) return;
      if (t.once) { this._exit(t, null); return; }
    }
  }
  /** @internal one actor left: the callback and the event */
  _left(t, who, id) {
    t.onExit?.(t, who, id);
    this.engine.events.emit('trigger:exit', { tag: t.tag, trigger: t, who, id });
  }
  /** @internal each zone's save key: tag (or '(shape)') plus its order among zones with that label, so code that adds the same zones gets the same keys */
  _keys() {
    const n = new Map();
    return this._list.map(t => { const l = t.tag || `(${t.shape})`, i = n.get(l) ?? 0; n.set(l, i + 1); return i ? `${l}#${i}` : l; });
  }
  /** @internal the 'triggers' save part: only zones that differ from a fresh one (used, or cooling down) */
  _save() {
    const keys = this._keys(), out = {};
    this._list.forEach((t, i) => { if (t.used || t._cool > 0) out[keys[i]] = { used: t.used, cool: t._cool }; });
    return out;
  }
  /** @internal occupied zones exit (who is null; first: 1, after the level, so onExit and its effects run before the other parts restore and whatever they wrote is overwritten by the save), then used / cooldown come from the save; zones the save does not name start fresh */
  _load(d) {
    for (const t of [...this._list]) if (t.inside) this._exit(t, null);
    const keys = this._keys();
    this._list.forEach((t, i) => {
      const s = d?.[keys[i]];
      t.used = !!s?.used; t._cool = Number.isFinite(s?.cool) ? s.cool : 0;
      if (t._cool > 0) this._busy.add(t); else this._busy.delete(t);
    });
  }
  _exit(t, who) {
    // id: who was inside (remembered at enter), so an exit says who left even though the position that left is gone
    const id = t._id ?? null, all = t._in ? [...t._in.values()] : null;
    t.inside = false; t._cool = t.cooldown; t._id = null;
    if (all) {   // occupancy 'each': everyone leaves, each in its own try (the first throw is raised after the last exit has run)
      t._in.clear();
      let first, bad = false;
      for (const o of all) { try { this._left(t, who, o.id); } catch (err) { if (!bad) { bad = true; first = err; } } }
      if (bad) throw first;
      return;
    }
    this._left(t, who, id);
  }

  // ---------- debug view 'triggers' ----------
  /**
   * @internal apply() of the debug view: build the wireframes from scratch and return the undo that removes and disposes all of them.
   * Added to the scene directly, not engine.add: a debug overlay is not a game thing (describe().scene and saves must not count it).
   */
  _drawView(scene) {
    const g = this._view = new THREE.Group();
    g.name = 'triggers-debug';
    this._mat = new THREE.LineBasicMaterial(this._debugLine);   // debug overlay only
    for (const t of this._list) this._addDebugMesh(t);
    scene.add(engineOwned('triggers', g));
    return () => {
      for (const t of this._list) t._mesh = null;
      freeParts(g, x => x.isBufferGeometry);   // each debug mesh's geometry is this overlay's; the one line material goes below
      g.removeFromParent(); this._mat.dispose();
      if (this._view === g) this._view = null;
    };
  }
  _addDebugMesh(t) {
    if (t.volume && !t.volume.bounds) return;   // nothing to draw without bounds
    let geo;
    if (t.shape === 'sphere') geo = new THREE.SphereGeometry(t.radius, 12, 8);
    else if (t.shape === 'box' || t.volume) geo = new THREE.BoxGeometry(t.hx * 2, t.sy, t.hz * 2).translate(0, t.sy / 2, 0);
    else geo = new THREE.CylinderGeometry(t.radius, t.radius, t.height, 16, 1, true).translate(0, t.height / 2, 0);
    const lines = new THREE.LineSegments(new THREE.WireframeGeometry(geo), this._mat);
    geo.dispose();
    lines.position.set(t.x, t.y, t.z); lines.rotation.y = t.rotation; lines.renderOrder = 999;
    this._view.add(lines);
    t._mesh = lines;
  }
}

const TRIGGER_PARAMS = {
  action: { type: 'string', default: 'triggersDebug', desc: "input action that toggles the debug view 'triggers' (engine.debug.view)" },
  debugColor: { type: 'color', default: DEBUG_GRAY, desc: "line color of the debug view 'triggers'" },
  debugOpacity: { type: 'number', default: 0.8, desc: "line opacity of the debug view 'triggers'" },
};

/**
 * The triggers section of content data: fromLevel = the level's trigger_<tag> marker, otherwise placed by position. Enter / exit effects look up the merged table,
 * and the listener is attached only once. They act for whoever crossed the zone (a { give } lands in that actor's bag); a zone emptied by removal has no id: engine.actor
 */
function triggerContent() {
  const table = {};
  let subsTrack = null, fromLevel = [];
  return {
    desc: 'trigger zones (tag -> position / from level, enter/exit effects)',
    undo(d, { engine: e }) {
      const had = new Set(e.triggers._list), was = { ...table };
      return () => {
        for (const t of [...e.triggers._list]) if (!had.has(t)) t.remove();
        for (const tag of Object.keys(table)) delete table[tag];
        Object.assign(table, was);
      };
    },
    commit(d, { engine: e, content, where, bind, track }) {
      Object.assign(table, d);
      // one set per content commit: a second commit (the same level loaded twice) replaces its own zones, never the ones a game's own fromMarkers() made
      e.triggers._removeEach(fromLevel, 'triggers replace');
      fromLevel = Object.values(d).some(t => t.fromLevel) ? e.triggers.fromMarkers() : [];
      for (const [tag, t] of Object.entries(d)) if (!t.fromLevel) bind(e.triggers.add({ ...t, tag, position: where(t.position), onEnter: null, onExit: null }), t.position);
      if (subsTrack !== track) {   // a new content module has a new track: the old one's listeners were removed with it, so they are made again
        subsTrack = track;
        track(e.events.on('trigger:enter', ({ tag, id }) => content.run(table[tag]?.onEnter, { actor: id ?? e.actor })));
        track(e.events.on('trigger:exit', ({ tag, id }) => content.run(table[tag]?.onExit, { actor: id ?? e.actor })));
      }
    },
  };
}

/** Trigger zone module. Provides engine.triggers once installed. Optional dependency: level (used by fromMarkers) */
export function triggers(opts = {}) {
  const o = readParams('triggers', TRIGGER_PARAMS, opts);
  let tr = null;
  return {
    content: { triggers: triggerContent() },
    name: 'triggers', skipKind: 'none', type: 'rules', label: 'Triggers', params: TRIGGER_PARAMS, options: o, noSkip: 'zone enter/exit is re-evaluated on the next fixed step', optional: ['level'], stage: 'gameplay', after: ['interactions'],
    install(e, ctx) {
      tr = new Triggers(e, o, ctx.track);
      // audio rule condition { zone: 'cave' | ['cave', 'mine'] }: some trigger zone with that tag is occupied
      ctx.track(e.audio.condition('zone', v => [].concat(v).some(tag => tr.byTag(tag).some(t => t.inside))));
      ctx.saves.define('triggers', { notAtomic: 'bodies crossing a zone change it in the step, and its load fires exits', first: 1, save: () => tr._save(), load: d => tr._load(d) });
      return tr;
    },
    fixed(dt) { tr.update(dt); },
    // the key toggles the same debug view an AI calls: no second display path to keep in step
    frame(dt, e) { if (e.input.pressed(tr.action)) e.debug.view(e.debug.viewState().mode === 'triggers' ? 'off' : 'triggers'); },
    // turns the view off when it is the triggers one, drops the mode, and removes every zone as remove() does (exits fire; a level's zones too, so its later removal of the handles is a no-op)
    dispose() { tr._viewDef.remove(); tr._removeEach([...tr._list], 'triggers dispose'); },
    describe(e, ctx) {
      for (const t of tr._list) if (t.enabled && !t.used) ctx.near(t, { name: t.tag || t.shape, kind: 'trigger', inside: t.inside });
      return { inside: tr._list.filter(t => t.inside).map(t => t.tag || t.shape), used: tr._list.filter(t => t.used).map(t => t.tag || t.shape) };
    },
  };
}

export const handRolled = 'none: a zone check by hand is the same maths as any distance or box test';
