// Objective markers and a simple HUD. World markers (an edge-of-screen arrow when the target is off-screen), counters, progress bars.
//   const m = engine.hud.marker(npc.root, { label: '店主' });  m.set({ label: '店主（关门了）' });  m.remove();
//   engine.hud.marker('river')                              // a place name (content places or a level marker point), { x, z }, an object or a character all work
//   engine.hud.marker({ nearest: 'berry' })                 // the nearest not-yet-picked pickup of a kind (hides itself once all are taken)
//   engine.hud.marker(() => targetOrNull)                   // function: resolves the target each frame, null hides it; m.setTarget(newTarget) swaps the target
//   engine.hud.addCounter('fish', { icon: '🐟', label: '鱼', value: 2, max: 5 });   // calling again with the same id = update
//   engine.hud.button('wave', { label: 'Start wave', run: startWave, anchor: 'bottom' });   // a click never reaches the game
//   engine.hud.bar('stamina', { value: 0.6, label: '体力', anchor: 'bottom' });   engine.hud.remove('stamina');
// Quests: a marker shows automatically when the current step has a target, and is removed on completion (turn off with hud({ questMarkers: false })).
//   Quest markers follow the quests' state: they are dropped when a playthrough ends and rebuilt when the next starts (engine.session) or a save loads.
//   Markers, counters and bars the game made itself stay; ones made during play go through engine.session.track(m) (counters / bars: hud.remove(id)).
// Drawing is done by UI parts (see parts.js): engine.ui.set('hud.marker' | 'hud.counter' | 'hud.bar' | 'hud.button', yourFactory | false) replaces or hides each kind;
//   this file keeps the logic (targets, projection, arrows, quest sync, describe) so a replaced part only draws the data it gets.
import * as THREE from 'three';
import { injectUICSS, worldToScreen } from '../../ui/UI.js';

import { readParams, keysSchema } from '../../core/base/params.js';
import { vec3 } from '../../core/base/math.js';
import { surfaceOr } from '../../core/scene/ground.js';
import { CSS, defineHudParts } from './parts.js';
import { codedError } from '../../core/base/errorHints.js';
import { hintKey } from '../../core/input/inputPad.js';
/** @import { ModuleDef } from '../../types/core' */
/** @import { Hud, HudOptions } from '../../types/gameplay' */

const STRINGS = {
  'zh-CN': { 'module.hud': '目标指示', 'hud.distance': '{m} 米' },
  en: { 'module.hud': 'objective markers', 'hud.distance': '{m} m' },
};
const MARKER_KEYS = ['label', 'icon', 'offscreen', 'distance', 'height'], ITEM_KEYS = ['label', 'icon', 'value', 'max', 'anchor'], BAR_KEYS = ['label', 'value', 'max', 'anchor'], BUTTON_KEYS = ['label', 'icon', 'run', 'anchor', 'action'], HINT_KEYS = ['label', 'action', 'anchor'];
const _size = new THREE.Vector2();
const EDGE = 28;   // how far the arrow sits from the screen edge (px)

const HUD_PARAMS = keysSchema(['questMarkers']);
/** Where a counter / bar column sits on screen (anchor option); default top-left */
const ANCHORS = ['top-left', 'top', 'top-right', 'left', 'right', 'bottom-left', 'bottom', 'bottom-right'];

/**
 * Objective markers, counters, progress bars -> engine.hud
 * @param {HudOptions} [opts]
 * @returns {ModuleDef<Hud>}
 */
export function hud(opts = {}) {
  readParams('hud', HUD_PARAMS, opts);
  let e = null, root = null;
  const items = new Map();       // counters, bars: id -> { kind, o, part }
  const quest = new Map();       // quest id -> auto marker
  const v = new THREE.Vector3();
  // Containers of the default parts, built on first use (a game that replaced every part gets no empty HUD layer)
  const containers = () => {
    if (!root) {
      injectUICSS(CSS);
      const layer = document.createElement('div'); layer.className = 'threedog-ui threedog-hud';
      e.uiRoot.appendChild(layer);
      // one stats column per screen anchor, made when a counter / bar first asks for it
      const cols = new Map();
      const column = (anchor = 'top-left') => {
        let c = cols.get(anchor);
        if (!c) { c = document.createElement('div'); c.className = `threedog-hud-stats threedog-hud-${anchor}`; layer.appendChild(c); cols.set(anchor, c); }
        return c;
      };
      root = { layer, column };
    }
    return root;
  };

  // { nearest: itemId } -> the nearest not-yet-picked pickup (world data, so it is found even when far away with no model)
  const nearest = id => e.pickups?.nearest(id, e.actorPosition())?.position ?? null;
  // Target -> world position (written into v); null if not found
  const resolve = (target, height) => {
    if (typeof target === 'function') target = target();
    if (target?.nearest != null) target = nearest(target.nearest);
    if (target == null) return null;
    if (typeof target === 'string') {
      const p = e.content?.place(target) ?? e.level?.marker(target)?.position;
      if (!p) return null;
      return v.set(p.x, surfaceOr(e, p.x, p.z, p.y, p.y ?? 0) + height, p.z);   // a level marker's own height picks its storey
    }
    const obj = target.root?.isObject3D ? target.root : target;
    if (obj.isObject3D) { obj.getWorldPosition(v); v.y += height; return v; }
    vec3(target, v);
    if (target.y === undefined) v.y = surfaceOr(e, v.x, v.z);
    v.y += height;
    return v;
  };

  const hideMarker = m => { if (m.visible) { m.visible = false; m.part?.hide(); } };
  const updateMarker = m => {
    const p = resolve(m.target, m.o.height ?? 2.2);
    if (!p) { hideMarker(m); return; }
    const from = e.actorPosition() ?? e.focus;   // distance from whoever the user controls (engine.actor)
    m.dist = Math.round(p.distanceTo(from));
    const s = worldToScreen(e, p), { x: W, y: H } = e.renderer.getSize(_size);   // the canvas box, not the window
    m.onScreen = s.onScreen;
    if (!s.onScreen && m.o.offscreen === 'hide') { hideMarker(m); return; }
    m.visible = true;
    let x = s.x, y = s.y, angle = 0;
    m.arrow = !s.onScreen;
    if (m.arrow) {
      // Point from the screen center to the target (the projection is mirrored when behind, so flip it), clamped to the screen edge
      let dx = x - W / 2, dy = y - H / 2;
      if (s.behind) { dx = -dx; dy = -dy; }
      if (!dx && !dy) dy = 1;
      const k = Math.min((W / 2 - EDGE) / Math.abs(dx || 1e-6), (H / 2 - EDGE) / Math.abs(dy || 1e-6));
      x = W / 2 + dx * k; y = H / 2 + dy * k; angle = Math.atan2(dy, dx);
    }
    if (!m.part) return;
    const o = m.o, label = typeof o.label === 'function' ? o.label() : o.label ?? '';
    const distance = o.distance !== false && m.dist != null ? e.t('hud.distance', { m: m.dist }) : '';
    m.part.update({ x, y, onScreen: s.onScreen, arrow: m.arrow, angle, label, icon: o.icon ?? '', distance });
  };

  const item = (kind, id, o) => {
    if (o.anchor !== undefined && !ANCHORS.includes(o.anchor)) throw codedError('hud-option', `hud.${kind}('${id}'): anchor '${o.anchor}' is not one of ${ANCHORS.join(' | ')}`, TypeError);
    if (kind === 'counter' && o.value != null && typeof o.value !== 'number' && typeof o.value !== 'string') throw codedError('hud-option', `hud.addCounter('${id}'): value is a number (a count) or text (a time, a quest step); got ${typeof o.value}`, TypeError);
    if (kind === 'button' && typeof o.run !== 'function' && !items.get(id)?.o.run) throw codedError('hud-option', `hud.button('${id}'): run is the function a click calls`, TypeError);
    if (o.action !== undefined) {   // the shown key is input.label(action): it follows rebinding and keyboard / pad switching (see frame())
      if (!e.input.actions.has(o.action)) throw codedError('hud-option', `hud.${kind}('${id}'): action '${o.action}' is not an input action (engine.input.define declares it)`, TypeError);
      o = { ...o, key: hintKey(e.input, o.action) };
    }
    let it = items.get(id);
    if (!it) { it = { kind, o: {}, part: e.ui.create('hud.' + kind) }; items.set(id, it); }
    else if (Object.keys(o).every(k => it.o[k] === o[k])) return;   // value unchanged: leave the part alone (cheap even when called every frame)
    Object.assign(it.o, o);
    it.part?.update({ id, ...it.o });
  };

  // The current quest step's target -> marker; a parallel step marks each part not yet done (key 'quest#part')
  const syncQuests = () => {
    if (opts.questMarkers === false || !e.quests) return;
    const want = new Map();
    for (const q of e.quests.list()) {
      const s = q.steps.find(x => x.current);
      if (s?.parts) s.parts.forEach((p, k) => { if (!p.done && p.target != null) want.set(`${q.id}#${k}`, { target: p.target, label: p.text }); });
      else if (s?.target != null) want.set(q.id, { target: s.target, label: q.title });
    }
    for (const [id, m] of quest) if (want.get(id)?.target !== m.target) { m.remove(); quest.delete(id); }
    for (const [id, w] of want) if (!quest.has(id)) quest.set(id, api.marker(w.target, { label: w.label }));
  };

  const api = {
    /** All markers */
    markers: [],
    /** Add an objective marker (target: object, character, { x, z }, place name, { nearest: itemId }, or a function returning a target); returns { set(opts), setTarget(t), remove() } */
    marker(target, o = {}) {
      readParams('hud.marker()', keysSchema(MARKER_KEYS), o);
      const part = e.ui.create('hud.marker');
      const m = {
        target, o: { offscreen: 'arrow', distance: true, ...o }, part, el: part?.el ?? null, dist: null, onScreen: false, arrow: false, visible: false,
        set(p) { readParams('hud.marker().set()', keysSchema(MARKER_KEYS), p); Object.assign(m.o, p); },
        setTarget(t) { m.target = t; },
        remove() { part?.dispose(); api.markers = api.markers.filter(x => x !== m); },
      };
      api.markers.push(m);
      return m;
    },
    /**
     * Counter (calling again with the same id = update): { label, icon, value, max, anchor }; value: a number (with max: '2 / 5') or text (a plain
     * status: a clock, a quest step); no value = the label alone; anchor: 'top-left' (default) | 'top' | 'top-right' |
     * 'left' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right', the screen corner / edge its column sits at
     */
    addCounter(id, o) {
      readParams('hud.addCounter()', keysSchema(ITEM_KEYS), o); item('counter', id, o);
      // the handle names its own counter: set(value) changes what it shows, remove() takes it off (a newer counter under the id is not touched)
      // each call owns the counter until the next addCounter of the id takes it: a token per call, so an older handle is a no-op, never removes a newer owner's
      const mine = items.get(id), token = {}; mine.owner = token;
      const live = () => items.get(id) === mine && mine.owner === token;
      return { id, set: v => { if (live()) item('counter', id, typeof v === 'object' && v ? v : { value: v }); },
        remove: () => { if (!live()) return; mine.part?.dispose(); items.delete(id); } };
    },
    /**
     * Add n (default 1; negative takes away) to a number counter and return the new value. A counter not declared yet starts at 0 with its id as the label, so
     * declare it with addCounter() for a player-facing label and max
     * @example engine.hud.addCounter('shells', { label: 'Shells', value: 0, max: 4 }); engine.hud.bump('shells');
     */
    bump(id, n = 1) {
      const it = items.get(id), v = it?.o.value ?? 0;
      if (typeof v !== 'number') throw codedError('hud-option', `hud.bump('${id}'): this counter shows text (${JSON.stringify(v)}), not a number`, TypeError);
      item('counter', id, it ? { value: v + n } : { label: id, value: n });
      return v + n;
    },
    /** Current value of a counter or bar (a number or text); undefined when there is none. This is also where an interaction's `counter` total is read */
    value(id) { return items.get(id)?.o.value; },
    /** Progress bar (calling again with the same id = update): { value, max = 1, label, anchor } (anchor as for counter) */
    bar(id, o) { readParams('hud.bar()', keysSchema(BAR_KEYS), o); item('bar', id, o); },
    /**
     * Clickable button (calling again with the same id = update): { label, icon, run, anchor }. label is plain text or an i18n key (engine.t); run() is called on a click or tap.
     * The press never reaches the game (no shot, no look-drag, no pointer lock) and focus goes back to the game. In a pointer-locked view the cursor is hidden, so the player
     * frees the mouse first (Esc); the button is for menus-in-play, a touch layout, or a paused / between-waves moment.
     * @example engine.hud.button('wave', { label: 'wave.start', run: () => startWave(), anchor: 'bottom' });
     */
    button(id, o) { readParams('hud.button()', keysSchema(BUTTON_KEYS), o); item('button', id, o); },
    /**
     * Key hint "E · Talk" (calling again with the same id = update): { action, label, anchor }. The key text is engine.input.label(action), so it follows the player's rebinding
     * and the last used device (keyboard or pad); label is plain text or an i18n key. A hud.button with `action` shows its key the same way.
     * @example engine.input.define('jump', { label: 'Jump', keys: ['Space'] }); engine.hud.hint('jump', { action: 'jump', label: 'hint.jump', anchor: 'bottom-left' });
     */
    hint(id, o) {
      readParams('hud.hint()', keysSchema(HINT_KEYS), o);
      if (o.action == null && !items.get(id)?.o.action) throw codedError('hud-option', `hud.hint('${id}'): action is the input action whose key is shown`, TypeError);
      item('hint', id, o);
    },
    /** Remove a counter, bar, button or key hint */
    remove(id) { items.get(id)?.part?.dispose(); items.delete(id); },
  };

  return {
    name: 'hud', skipKind: 'none', type: 'ui', params: HUD_PARAMS, options: opts, label: 'Objective markers', optional: ['pickups', 'content', 'level', 'quests'], stage: 'effects', after: ['particles', 'settings'],
    install(engine, ctx) {
      e = engine;
      e.i18n.add(STRINGS);
      defineHudParts(e, ctx, containers);
      for (const ev of ['quest:start', 'quest:step', 'quest:part', 'quest:done', 'quest:fail', 'state:replaced', 'op:rolledBack']) ctx.track(e.events.on(ev, syncQuests));
      // quest markers are derived from the quests save part: they belong to the old quests, and session:start / save:loaded rebuild them; session:failed too, the quests stayed
      ctx.track(e.events.on('session:end', () => { for (const m of quest.values()) m.remove(); quest.clear(); }));
      ctx.track(e.events.on('i18n:change', () => { for (const [id, it] of items) it.part?.update({ id, ...it.o }); }));
      return api;
    },
    frame() {
      for (const m of api.markers) updateMarker(m);
      // input has no event for a device switch or bind(), so a hint compares its key text each frame and redraws only on a change. Not through item():
      // an action removed since (its module left, a failed content load put the actions back) must read as no key here, not throw every frame
      for (const [id, it] of items) if (it.o.action) { const key = hintKey(e.input, it.o.action); if (key !== it.o.key) { it.o.key = key; it.part?.update({ id, ...it.o }); } }
    },
    // unloaded: nothing updates these any more, so they leave the screen too
    dispose() {
      for (const m of api.markers) m.remove();
      for (const id of [...items.keys()]) api.remove(id);
      quest.clear(); root?.layer.remove(); root = null;
    },
    describe() {
      return {
        markers: api.markers.map(m => ({ label: typeof m.o.label === 'function' ? m.o.label() : m.o.label ?? null, distance: m.dist, onScreen: m.onScreen, visible: m.visible })),
        counters: Object.fromEntries([...items].map(([id, it]) => [id, it.o.value ?? null])),
      };
    },
  };
}

export const handRolled = 'none: a score line is ordinary DOM that the game owns';
