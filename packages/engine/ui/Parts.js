// UI parts (engine.ui). Every piece of screen UI the engine or a module draws is a named part with a default implementation.
// A game swaps any part for its own DOM / canvas code, or turns it off, without touching the engine; the engine keeps the behavior
// (when to show it, the UI focus stack, Esc, input lock, i18n), the part only draws.
//
//   createEngine({ ui: { loading: false, title: { title: 'My Game' }, toast: (engine) => ({ show: d => myToast(d.text) }) } })
//   engine.ui.set('hud.counter', (engine) => {            // replace a part: a function returning { show, update, hide, dispose } (any may be omitted)
//     const el = document.createElement('div'); engine.uiRoot.appendChild(el);
//     return { update: d => { el.textContent = `${d.label} ${d.value}`; }, dispose: () => el.remove() };
//   });
//   engine.ui.set('hud.marker', false);                    // turn a part off
//   engine.ui.open('title') / engine.ui.close('title')     // full-screen parts (title): pushes the UI focus stack, locks input, emits ui:open / ui:close
//
// Value per name: false = off; true = the default; a plain object = the default with these options; a function (engine, options) => part = your own.
// The same option holds the picture of every default part: createEngine({ ui: { theme: { bg, accent }, css, fonts, templates, toast: false } }) (ui/theme.js).
// Names and the data each part receives are listed in `engine.ui.describe()` and in recipes/26-ui-parts.md.
import { uiFocus } from './Focus.js';
import { codedError } from '../core/base/errorHints.js';
import { fmt } from '../core/base/validate.js';
/** @import { Engine } from '../types/core' */
/** @import { UIPart, UIPartFactory, UIPartValue, UIPartDef } from '../types/core' */

const VERBS = ['show', 'update', 'hide', 'dispose'];
const noop = () => {};
const DEV = {
  badValue: "engine.ui.set('{name}', …): pass false (off), true (default), an options object, or a function (engine, options) => ({ show, update, hide, dispose }). Got {got}. A color or font goes in createEngine({ ui: { theme: { {name}: … } } }).",
  badPart: "ui part '{name}': the function must return an object { show, update, hide, dispose } (any may be omitted). Got {got}.",
  badVerb: "ui part '{name}': {verb} must be a function.",
  unknown: "engine.ui.set('{name}'): no UI part has that name. Known parts: {known}. (A module's parts exist only after engine.use(module).)",
  notModal: "engine.ui.open('{name}'): only full-screen parts can be opened ({known}).",
};
const kind = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

/** @internal Fill missing verbs with no-ops so callers never write ?. */
function normalize(name, p) {
  if (!p || typeof p !== 'object') throw codedError('ui-misuse', fmt(DEV.badPart, { name, got: kind(p) }));
  for (const v of VERBS) {
    if (p[v] == null) p[v] = noop;
    else if (typeof p[v] !== 'function') throw codedError('ui-misuse', fmt(DEV.badVerb, { name, verb: v }));
  }
  return p;
}

export class UIParts {
  /**
   * @param {Engine} engine
   * @param {import('../types/core').UIOptions} [ui]  createEngine({ ui }): theme and css are applied by ui/theme.js, every other key names a part
   * @internal
   */
  constructor(engine, { theme, css, fonts = [], templates = {}, ...parts } = {}) {
    this.engine = engine;
    /** Window content by name, read each time a window draws: (data, { esc, t, icon }) => HTML replaces the default layout. Plain and writable @type {Record<string, import('../types/core').UITemplate>} */
    this.templates = templates;
    /** @internal font asset names start() loads */ this.fonts = fonts;
    /** @internal name -> { factory, on, multi, modal } */ this.defs = new Map();
    /** @internal name -> value given by the game (wins over the default whatever the install order) */ this.values = new Map();
    /** @internal name -> live singleton */ this.live = new Map();
    /** @internal name -> { focus } while a full-screen part is open */ this.opened = new Map();
    /** @internal hide() promises still fading out (see settled) */ this._fading = new Set();
    /** @internal id -> title screen item a module added (titleItem) */ this.titleItems = new Map();
    for (const [k, v] of Object.entries(parts)) this.set(k, v);
  }

  /**
   * Add a title screen button from a module (the settings menu adds 'settings'). The title shows it by default after continue / start, and a game's
   * own items list may name it by id. Why a registration and not the title knowing the module: ui/ names no module, and a game's module adds a
   * button ('credits') the same way. remove() takes it away again (ctx.track it in install).
   * @param {string} id
   * @param {{ label: string | ((e: Engine) => string), run(e: Engine): any }} item
   * @returns {{ remove(): void }}
   * @example ctx.track(engine.ui.titleItem('credits', { label: e => e.t('title.credits'), run: e => e.ui.open('credits') }));
   */
  titleItem(id, item) {
    this.titleItems.set(id, item);
    return { remove: () => { if (this.titleItems.get(id) === item) this.titleItems.delete(id); } };
  }

  /**
   * Declare a part and its default implementation (engine and modules call this in install; games use set).
   * @param {string} name
   * @param {UIPartFactory} factory  default implementation (engine, options) => part
   * @param {UIPartDef} [def]  on: shown unless the game asks (default true); multi: one part per item (markers, counters); modal: full-screen, opened with ui.open
   * @returns {{ remove(): void }}  remove() closes the part, disposes its live copy and takes the definition out (what a module's ctx.ui.define does when it leaves)
   * @example engine.ui.define('hud.ammo', (e, o) => ({ update: d => {...} }), { multi: true })
   */
  define(name, factory, { on = true, multi = false, modal = null } = {}) {
    const d = { factory, on, multi, modal };
    this.defs.set(name, d);
    return { remove: () => {
      if (this.defs.get(name) !== d) return;
      this.close(name);
      this.live.get(name)?.dispose?.();
      this.live.delete(name); this.defs.delete(name);
    } };
  }

  /**
   * Replace a part with your own, give the default options, or turn it off. Affects parts created after this call (set before engine.start()).
   * @param {string} name  e.g. 'loading' 'toast' 'title' 'hud.marker' 'hud.counter' 'hud.bar' 'hud.button'
   * @param {UIPartValue} value  false off · true default · { ...options } default with options · (engine, options) => ({ show, update, hide, dispose })
   * @returns {void}
   * @example engine.ui.set('toast', (engine) => ({ show: ({ text, kind }) => { if (kind !== 'quest') myToast(text); } }))
   */
  set(name, value) {
    const t = kind(value);
    if (t !== 'boolean' && t !== 'function' && t !== 'object') throw codedError('ui-misuse', fmt(DEV.badValue, { name, got: t }));
    this.values.set(name, value);
  }

  /** @internal value -> { factory, options } or null when off */
  _resolve(name) {
    const d = this.defs.get(name), v = this.values.has(name) ? this.values.get(name) : d?.on;
    if (!d || v === false || v === undefined) return null;
    if (typeof v === 'function') return { factory: v, options: {} };
    return { factory: d.factory, options: v === true ? {} : v };
  }
  /** @internal */
  _make(name) {
    const r = this._resolve(name);
    if (!r) return null;
    const p = normalize(name, r.factory(this.engine, r.options)), hide = p.hide;
    // a hide() that fades out may return a promise; track it so settled() knows when the screen is really clear
    p.hide = (...a) => {
      const out = hide.apply(p, a);
      if (out?.then) { this._fading.add(out); out.finally(() => this._fading.delete(out)); }
      return out;
    };
    return p;
  }

  /**
   * Resolves once every part that is hiding has finished fading out (a part's hide() may return a promise for its fade).
   * Screenshots wait for it so the loading screen is not captured half-transparent.
   * @example await engine.ui.settled(); renderer.domElement.toDataURL();
   * @returns {Promise<void>}
   */
  settled() { return Promise.all([...this._fading]).then(() => {}); }

  /**
   * The live single part (loading, toast, title...), built on first use; null when the part is off.
   * @param {string} name
   * @returns {UIPart | null}
   * @example engine.ui.get('loading')?.update({ progress: 0.5, text: '' })
   */
  get(name) {
    if (this.live.has(name)) return this.live.get(name);
    const p = this._make(name);
    this.live.set(name, p);
    return p;
  }

  /**
   * A new part for one item of a multi part (a HUD marker, counter, bar); null when the part is off. The caller disposes it.
   * @param {string} name
   * @returns {UIPart | null}
   */
  create(name) { return this._make(name); }

  /**
   * Open a full-screen part (the title screen): shows it, pushes the UI focus stack (Esc goes to it; the choice cursor moves over the controls inside the
   * part's el), locks gameplay input, emits ui:open.
   * @param {string} name
   * @param {object} [data]  passed to the part's show()
   * @returns {boolean} false when the part is off
   * @example engine.ui.open('title')
   */
  open(name, data) {
    const d = this.defs.get(name);
    if (!d?.modal) throw codedError('ui-misuse', fmt(DEV.notModal, { name, known: [...this.defs].filter(([, x]) => x.modal).map(([n]) => n).join(', ') }));
    const p = this.get(name);
    if (!p) return false;
    if (this.opened.has(name)) return true;
    const e = this.engine, m = d.modal;
    const shown = { ...m.data?.(e, this._resolve(name).options), ...data };   // before the holds below: a title list that throws must not leave the game frozen behind nothing
    // Each modal part owns its own freeze ('ui-<name>') and its own input context, so closing help releases only help's hold, never a player pause or another part's.
    // m.freeze may be a function (inventory: pauseGame is switchable at runtime)
    // a string names the freeze kind engine.runState reads ('title' = waiting for start), so core never matches part names
    const fr = typeof m.freeze === 'function' ? m.freeze(e) : m.freeze;
    const freeze = fr ? e.freeze('ui-' + name, { kind: typeof fr === 'string' ? fr : undefined }) : null;
    this.opened.set(name, { freeze, focus: uiFocus(e).push('ui-' + name, { cancel: m.cancel ? () => m.cancel(e) : null, nav: () => p.el ?? null }), ctx: e.input.push('ui-' + name) });   // own opaque context: gameplay actions stop responding
    try { p.show(shown); } catch (err) { this.close(name); throw err; }
    e.events.emit('ui:open', name);
    return true;
  }

  /**
   * Close a full-screen part opened with open().
   * @param {string} name
   * @returns {void}
   */
  close(name) {
    const f = this.opened.get(name);
    if (!f) return;
    const e = this.engine;
    this.opened.delete(name);
    f.focus.remove(); f.ctx.remove(); f.freeze?.remove();
    this.live.get(name)?.hide();
    e.events.emit('ui:close', name);
  }

  /**
   * Whether a full-screen part is open
   * @param {string} name
   * @returns {boolean}
   */
  isOpen(name) { return this.opened.has(name); }

  /**
   * Each part: 'default' | 'custom' | 'off'
   * @returns {Record<string, string>}
   */
  describe() {
    const out = {};
    for (const [n, d] of this.defs) { const v = this.values.has(n) ? this.values.get(n) : d.on; out[n] = v === false ? 'off' : typeof v === 'function' ? 'custom' : 'default'; }
    return out;
  }

  /** @internal start(): every module is installed, so a name the game set but nobody defined is a typo */
  _check() {
    for (const n of this.values.keys()) if (!this.defs.has(n)) throw codedError('ui-misuse', fmt(DEV.unknown, { name: n, known: [...this.defs.keys()].join(', ') }));
  }
  /** @internal engine.dispose() */
  _dispose() {
    for (const n of [...this.opened.keys()]) this.close(n);
    for (const p of this.live.values()) p?.dispose();
    this.live.clear();
  }
}
