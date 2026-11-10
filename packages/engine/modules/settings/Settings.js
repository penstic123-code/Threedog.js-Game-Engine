// Settings menu module: the basic cancel key (Esc / pad B) opens it in game (when the UI focus stack is empty: no window, dialogue or cutscene open; see ui/Focus.js); tabs for graphics,
// audio, keys, language, saves (export / import save files).
// Changes apply at once and autosave to the browser (localStorage), restored on the next launch.
//
//   engine.use(settings());                        // install after other modules (so it sees terrain, audio, etc.)
//   engine.settings.open() / close() / toggle()
//   engine.settings.set('shadows', false)          // change a setting in code (also saved)
//   engine.settings.get('vol.music')               // → 0.5
//   engine.settings.preset('low')                  // graphics preset: 'low' | 'medium' | 'high'
//
// Tabs: default graphics, audio, keys, language, saves. Optional built-ins, off unless asked for: 'game' (resume / load / back to title) and
// 'camera' (mouse sensitivity, invert Y, field of view): settings({ sections: ['game', 'graphics', 'audio', 'controls', 'camera'] }) or addSection('camera').
// An entry { id: 'graphics', omit: ['pixelRatio', 'antialias'] } in that list leaves rows out of the graphics tab.
// The whole menu is replaceable: skip this module and build your own (register it as the Esc root with uiFocus(engine).setRoot(() => myMenu.open())).
//
// A game's own settings (each one a menu row the engine draws, in the 'options' tab unless menu names another; label is an i18n key or text, else the key):
//   engine.settings.define('subtitles', true, on => game.subtitles = on);   // custom setting: default value + apply function, autosaved
//   engine.settings.define('volfog', true, { limits: 'post.volfog.enabled', menu: 'graphics' });   // off holds the game's own effect off, like the shadows row
//   engine.settings.define('difficulty', 'normal', { options: ['easy', 'normal', 'hard'], label: 'my.difficulty', apply });   // number rows: { min, max, step? }
// The bloom and ao rows follow post effects by the role they declare (about.acts "glow" / "ao"), whatever the effect is named; every effect with the role follows its row, and the shadows row shows only while a light casts.
// A tab that draws its rows itself (menu: false on those rows, or the engine draws them a second time):
//   engine.settings.define('subtitles', true, { menu: false, apply: on => game.subtitles = on });
//   engine.settings.addSection('gameplay', {
//     title: e => e.t('my.gameplay'),
//     render: (tools, e, s) => tools.row(tools.t('my.subtitles'), tools.toggle('subtitles', s.get('subtitles'))),
//     bind: (el, e, s) => {},                       // optional: called after every redraw, to wire events on custom controls
//     order: 50,
//   });
//
// Picture:
//   CSS classes  .threedog-win-settings .threedog-tabs .threedog-tab .threedog-set-row .threedog-set-label .threedog-set-ctl .threedog-seg .threedog-range
//           .threedog-set-val .threedog-key(.is-waiting/.is-conflict) .threedog-set-note .threedog-set-foot .is-active — override with ui.css
//   Replace it whole: ui.templates.settings({ sections, current, body, values }, { esc, t, icon }) returns HTML;
// controls just carry the attributes data-tab / data-set+data-value / data-range / data-rebind / data-reset / data-locale / data-save-export / data-save-import
// (see sections.js)
import { makeWindow, injectUICSS, uiFocus } from '../../ui/UI.js';
import { BUILTIN_SECTIONS, rowKindProblem } from './sections.js';
import { STRINGS, CSS } from './strings.js';
import { SettingsView } from './view.js';
import { applySetting, allowed, checkLimits, releaseLimits, releaseRow, ROLE_ROWS, roleEffects } from './apply.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { codedError, coded } from '../../core/base/errorHints.js';
import { warnOnce } from '../../core/base/validate.js';
import { pixelSizeOn } from '../../core/scene/pixelRatio.js';
import { trackForModule } from '../../core/engine/moduleTypes.js';

// Graphics presets. Values are performance steps, not art; a game can override with settings({ presets: { low: {...} } })
// A preset never states a look. A switch is a permission (true lets the game's choice through), and pixelRatio, viewChunks and density are shares (0 to 1) of what this device and
// this game start with, so the top preset lets everything through and no preset raises anything. A fixed number is wrong on one game or the other: 5 chunks cuts a game built for 8,
// and a ratio of 1 is an upscaled picture on a 2x screen (core/scene/tier.js). tier: what engine.tier reads under this preset; null leaves it to the device
const PRESETS = {
  low: { pixelRatio: 0.75, shadows: false, antialias: false, bloom: false, ao: false, viewChunks: 0.6, density: 0.5, tier: 'low' },
  medium: { pixelRatio: 1, shadows: true, antialias: true, bloom: false, ao: false, viewChunks: 0.8, density: 0.75, tier: null },
  high: { pixelRatio: 1, shadows: true, antialias: true, bloom: true, ao: true, viewChunks: 1, density: 1, tier: 'high' },
};
// Preset rows that are shares, and how each share lands on its whole
const SHARES = { pixelRatio: n => +n.toFixed(2), viewChunks: n => Math.max(1, Math.round(n)), density: n => +n.toFixed(2) };
// Settings keys that switch a post effect of the same name; a key whose effect the game did not add is hidden and ignored
const POST_KEYS = Object.keys(ROLE_ROWS);
// settings.define's options: a typo (lable, men) throws in dev instead of silently drawing the key as the label
const DEFINE_KEYS = keysSchema(['apply', 'limits', 'menu', 'label', 'options', 'min', 'max', 'step']);

/**
 * The graphics rows a game left out: the { id: 'graphics', omit } entry of sections. An omitted row is the game's value: no control, and no preset or stored value moves it.
 * @param {any} sections @returns {Set<string>}
 */
function omittedRows(sections) {
  const entry = Array.isArray(sections) ? sections.find(s => typeof s === 'object') : null;
  if (!entry) return new Set();
  readParams('settings sections', keysSchema(['id', 'omit']), entry);
  const rows = ['quality', 'adaptive', ...Object.keys(PRESETS.low)], bad = (entry.omit ?? []).filter(k => !rows.includes(k));
  if (entry.id !== 'graphics' || bad.length) throw codedError('settings-tab', `settings({ sections }): an entry with omit is { id: 'graphics', omit: [...] } with rows from ${rows.join(', ')}; got ${JSON.stringify(entry)}`);
  return new Set(entry.omit);
}

/**
 * What a stored file says the player changed. A version 1 file held every value, so there only a value that differs from today's default can be
 * the player's, and 'quality' was a label worked out from the rest.
 * @param {any} stored @param {Record<string, any>} defaults @returns {Record<string, any>}
 */
function playerValues(stored, defaults) {
  const v = stored.values || {};
  if (stored.v >= 2) return { ...v };
  return Object.fromEntries(Object.entries(v).filter(([k, val]) => k !== 'quality' && val !== defaults[k]));
}

export class Settings extends SettingsView {
  constructor(engine, { action = 'cancel', storageKey, presets = {}, sections = true, freezeWorld = false } = {}, track) {
    super();
    /** @internal the module's ctx.track: listeners the settings and its sections add leave with the module */ this._track = track;
    this.engine = engine;
    this.action = action;
    /** @internal */ this._leftOut = omittedRows(sections);
    this.presets = { ...PRESETS };
    for (const k in presets) {
      // loud, because a game's old fixed number (a ratio of 2, 5 chunks) would otherwise multiply the device's or the game's own
      for (const row of ['viewChunks', 'density']) if (presets[k][row] > 1) throw codedError('module-params', `settings({ presets: { ${k}: { ${row}: ${presets[k][row]} } } }): a preset's ${row} is a share from 0 to 1 of the game's own value`);
      if (presets[k].pixelRatio > 1) throw codedError('module-params', `settings({ presets: { ${k}: { pixelRatio: ${presets[k].pixelRatio} } } }): a preset's pixelRatio is a share from 0 to 1 of the ratio the engine picked for this device. For a fixed ratio call engine.setPixelRatio`);
      this.presets[k] = { ...(this.presets[k] || {}), ...presets[k] };
    }
    this.storageKey = storageKey || engine.saves.storageKey('settings');
    this.sections = new Map();
    this.custom = new Map();         // game's custom settings: key -> { def, apply }
    /** @internal keys set before start() with no row yet: init() reports the ones no row came for */ this._early = new Set();
    /** @internal the action waiting for a key press, and its focus entry: the menu cursor rests above it, or Space and Enter would press a control instead of being bound */ this._capturing = null;
    this.current = null;             // current tab
    this.freezeWorld = freezeWorld;

    engine.i18n.add(STRINGS);
    // the default opener is the basic cancel key (the UI focus stack hands it to the menu when nothing else is open); another action is the
    // game's, declared here and bound by the game (settings({ action: 'menu' }) + engine.input.bind('menu', ['Tab']))
    if (action !== 'cancel') track(engine.input.define(action, { label: 'settings.action', owner: 'settings' }));
    injectUICSS(CSS);

    const stored = this._read();
    // the player's saved keys: through input.rebind, the one way to rebind (the settings layer of 'input.keys'). It works before the module that
    // declares an action is installed, so nothing waits for "every action registered"
    for (const [a, k] of Object.entries(stored.bindings || {})) if (Array.isArray(k)) engine.input.rebind(a, k);   // [] is a saved choice (no key), only a missing entry means never saved
    this._defaults = this._currentValues();    // the engine's own values before the player's saved ones: what reset() goes back to
    // Only what the player changed is stored and applied, like input.rebound() for keys. The rest stays with whoever owns it (the tier, adaptive
    // resolution, the game), so one volume change no longer pins every graphics value for all later launches
    /** @internal key -> value; 'quality' names a chosen preset, the rows after it override it */ this._changed = playerValues(stored, this._defaults);
    /** @internal row key -> the shared points it holds off now (apply.js limitRow): what it gives back, never a fresh query */ this._held = new Map();
    this._values = { ...this._defaults, ...this._picked() };
    this._values.quality = this._matchPreset();
    for (const [k, v] of Object.entries(this._picked())) this._apply(k, v);
    // Tabs: true = the default set; a list picks built-in and optional tabs by name (optional ones register their own settings in setup)
    if (sections === true) for (const [id, s] of Object.entries(BUILTIN_SECTIONS)) this.sections.set(id, s);
    else if (sections) for (const s of sections) this._builtin(s.id ?? s);
    // whatever tabs the game picked: a defined row must have a place to show (the tab hides while it has none)
    if (sections) this._builtin('options');
    if (stored.locale && engine.i18n.languages.includes(stored.locale) && stored.locale !== engine.i18n.locale) engine.i18n.setLocale(stored.locale);

    this.win = makeWindow(engine, {
      id: 'settings', title: () => engine.t('settings.title'), hintAction: action,
      data: () => this._data(),
      render: (d, tools) => this._render(d, tools),
      onCancel: () => this._cancel(),
    });
    const baseRefresh = this.win.refresh;
    this.win.refresh = () => { baseRefresh(); this._afterRefresh(); };
    this._bindDOM(this.win.el);

    track(this.win);
    // The back key (Esc) has one entry point: with an empty focus stack it opens the menu; while the menu is open the window's onCancel handles it
    this.focus = uiFocus(engine);
    track(this.focus.setRoot(() => this.open()));   // unloaded, the back key must not open a window that left the page and hold the input behind it
    // The close button, the back key and code close() all go through the window's toggle, emitting ui:open / ui:close
    track(engine.events.on('ui:open', id => { if (id === 'settings') this._pause(true); }));
    track(engine.events.on('ui:close', id => { if (id === 'settings') this._pause(false); }));
    track(engine.events.on('i18n:change', () => { if (this._ready) this.save(); }));
    // an effect added after the player's choice was applied (the game adds its effects after settings installs) still gets it: a row follows an effect by role, so there is no point to wait on by name
    track(engine.events.on('post:add', name => { for (const k of POST_KEYS) if (this._values[k] === false && roleEffects(engine, k).some(h => h.name === name)) this._apply(k, false); }));
  }

  // ---------- reading and writing settings ----------
  /** Every setting's value, read only. The render scale comes from the renderer: adaptive resolution and the game move it, and a stored copy was a second answer to describe().render.scale */
  /**
   * @internal Rows out of play now: the game's, and under pixelSize the two that would change the ratio, so no preset, stored value or slider reaches it
   * while it is on, and they come back with setPixelSize(null).
   */
  get _omit() { return pixelSizeOn(this.engine) ? new Set([...this._leftOut, 'pixelRatio', 'adaptive']) : this._leftOut; }
  get values() { return { ...this._values, pixelRatio: +this.engine.renderer.getPixelRatio().toFixed(2) }; }
  get(key) { return this.values[key]; }
  /** @internal Someone answers for this key: a built-in row, a defined one, or a bus's slider @param {string} key */
  _hasRow(key) { return key in this._defaults || this.custom.has(key) || (key.startsWith('vol.') && key.slice(4) in this.engine.audio.levels); }
  /**
   * Change a setting: applies at once and saves. Changing a graphics setting turns the preset into "custom". A key no row owns throws: storing it would read back a value nothing
   * applied. Before start() a module's row may still come, so an unknown key waits and init() reports it.
   */
  set(key, value, { save = true, apply = true } = {}) {
    if (key === 'quality') return this.preset(value);
    if (!this._hasRow(key)) {
      if (this._ready) throw codedError('settings-row', `settings.set('${key}'): no setting has this key. Known: ${Object.keys(this._values).join(', ')}. Add the row with settings.define('${key}', ...) or the tab that has it (settings({ sections }))`);
      this._early.add(key);
    }
    this._values[key] = value; this._changed[key] = value;
    if (apply) this._apply(key, value);
    if (key in (this.presets.low || {})) this._values.quality = this._matchPreset();
    if (save) this.save();
    this.win.refresh();
  }
  /** Graphics preset */
  preset(name) {
    if (!this.presets[name]) return;
    const p = this._presetValues(name);
    // the name is stored, not its numbers: the ratio is worked out again on the next launch, where the tier may differ
    for (const k in p) { this._values[k] = p[k]; delete this._changed[k]; this._apply(k, p[k]); }
    this._values.quality = this._changed.quality = name;
    this.save(); this.win.refresh();
  }
  /**
   * A game's custom setting: default value + apply function (called at once with the saved value), or { apply, limits }. limits names the shared
   * value(s) the row restricts on the settings layer, the same way the built-in shadows row does: off holds the value off (a cutscene or the
   * scene cannot turn it back on), on allows what the scene chose; a number row from 0 to 1 is a factor on a number value.
   * A row a module defines from its install, init or a hook leaves with that module and gives its limits back; the player's choice waits for its return.
   * The menu draws the row (a switch for true/false, a slider for a number with min/max, buttons for options) in the tab menu names, default
   * 'options'; label is an i18n key or text, else the key. menu: false = a tab of the game's own draws it.
   * @param {string} key @param {any} def
   * @param {((value: any, engine: any) => void) | { apply?: (value: any, engine: any) => void, limits?: string | string[], menu?: string | false, label?: string, options?: any[], min?: number, max?: number, step?: number }} [apply]
   * @example engine.settings.define('volfog', true, { limits: 'post.volfog.enabled' });   // after engine.post.add(volFog)
   */
  define(key, def, apply) {
    const o = readParams(`settings.define('${key}')`, DEFINE_KEYS, typeof apply === 'function' || apply == null ? { apply } : apply);
    const limits = o.limits == null ? null : [].concat(o.limits);
    if (limits) checkLimits(this, key, def, limits);
    if (o.menu !== undefined && o.menu !== false && typeof o.menu !== 'string') throw codedError('module-params', `settings.define('${key}', ..., { menu }): menu is a tab id ('options', 'graphics', your own) or false when your own tab draws the row; got ${JSON.stringify(o.menu)}`);
    // a limits number row is a factor from 0 to 1, so its slider has its ends already
    const factor = limits && typeof def === 'number';
    const row = { def, apply: o.apply, limits, label: o.label, options: o.options, min: o.min ?? (factor ? 0 : undefined), max: o.max ?? (factor ? 1 : undefined), step: o.step, menu: o.menu ?? 'options' };
    // a choice value is a string, number or boolean: a click and the saved file give back a JSON copy, and an object copy never equals the
    // option again, so its button would lose the selected state (no deep compare: a plain value is the whole rule)
    const odd = Array.isArray(o.options) ? o.options.map(x => Array.isArray(x) ? x[0] : x).find(v => !['string', 'number', 'boolean'].includes(typeof v)) : undefined;
    if (odd !== undefined) throw codedError('settings-row', `settings.define('${key}', ..., { options }): a choice value is a string, number or boolean; got ${JSON.stringify(odd) ?? typeof odd}. Name the choice ('large') and map it in apply`);
    const why = row.menu === false ? '' : rowKindProblem(row);
    if (why) { warnOnce(coded('settings-row', `settings.define('${key}', ${JSON.stringify(def)}): the menu cannot draw this row (${why}), so the player has no control for it. Or menu: false when your own tab draws it`)); row.menu = false; }
    this.custom.set(key, row);
    const picked = this._picked();   // a preset's share of this row is only known now that the row says what it is a share of
    if (key in picked) this._values[key] = picked[key];
    else if (!(key in this._values)) this._values[key] = def;
    this._apply(key, this._values[key]);
    if (this._ready) this._values.quality = this._matchPreset();
    this.win?.refresh();   // an open menu shows the new row now (the camera tab defines its rows before the window exists)
    this._leavesWithModule(() => {
      if (this.custom.get(key) !== row) return;   // the name was defined again: that row is someone else's
      this.custom.delete(key);
      if (limits) releaseRow(this, key);
      if (!(key in this._changed)) delete this._values[key];
    });
    return this;
  }
  /**
   * @internal A row or tab made while a module runs leaves with that module (trackForModule); one the game made, or an async callback, stays
   */
  _leavesWithModule(drop) { trackForModule(this.engine, { remove: () => { drop(); this.win?.refresh(); } }); }
  /** Add a tab */
  addSection(id, def) {
    if (def === undefined) { this._builtin(id); this.win.refresh(); return this; }
    const { title, render, bind, when, order = 100 } = def;
    const section = { title: typeof title === 'function' ? title : () => title, render, bind, when, order };
    this.sections.set(id, section);
    this._leavesWithModule(() => { if (this.sections.get(id) === section) this.sections.delete(id); });
    this.win.refresh();
    return this;
  }

  get isOpen() { return this.win.open; }
  /** Action name waiting for a key press, or null @type {string | null} */
  get capturing() { return this._capturing?.action ?? null; }
  set capturing(action) {
    this._capturing?.hold.remove();
    this._capturing = action ? { action, hold: this.focus.push('settings-key', { cancel: () => this._cancel() }) } : null;
  }
  open() { if (!this.win.open) this.win.toggle(true); }
  close() { this.capturing = null; if (this.win.open) this.win.toggle(false); }
  toggle(on = !this.win.open) { on ? this.open() : this.close(); }

  /**
   * Put one setting (or, with no key, every setting) back to its default: the value the engine or the game's define() started with, before the player's saved ones.
   * Keys stay as they are (resetBindings does those). Why here and not in the game: the built-in defaults (volumes, graphics) are known only to the engine,
   * and a graphics change leaves the quality on 'custom', which is no preset to go back to.
   * @param {string} [key]
   * @example engine.settings.reset('vol.music')  ·  engine.settings.reset()
   */
  reset(key) {
    const def = k => this.custom.has(k) ? this.custom.get(k).def : this._defaults[k];
    // 'quality' is no value of its own (it is the name of the preset the graphics values match): resetting it resets the graphics values the presets set
    const keys = key === undefined ? Object.keys(this._values).filter(k => k !== 'quality' && !this._omit.has(k)) : key === 'quality' ? Object.keys(this._presetValues('low')) : [key];
    if (key === undefined || key === 'quality') delete this._changed.quality;
    const preset = this._presetValues(this._changed.quality);   // a row a kept preset sets must stay stored, or the preset takes it back on the next launch
    for (const k of keys) {
      if (!(k in this._values) || def(k) === undefined) { if (key !== undefined) warnOnce(`settings.reset('${k}'): no setting with this key (known: ${Object.keys(this._values).join(', ')})`); continue; }
      this.set(k, def(k), { save: false });
      if (!(k in preset)) delete this._changed[k];
    }
    this.save();
  }
  /** Reset all keys to the game's (takes every player rebinding away) */
  resetBindings() {
    const inp = this.engine.input;
    for (const a of Object.keys(inp.rebound())) inp.rebind(a, null);
    this.save();
  }
  /** Replace an action's first key with code (spare keys are kept) */
  rebind(action, code) {
    const inp = this.engine.input, cur = inp.keysOf(action);
    inp.rebind(action, [code, ...cur.slice(1).filter(k => k !== code)]);
    this.save();
  }

  /** Key list (for the UI): [{ action, name, label, keys, conflict }] */
  actionList() {
    const inp = this.engine.input, all = [...inp.actions];
    const groups = {};
    for (const [, v] of all) groups[v.labelKey] = (groups[v.labelKey] || 0) + 1;
    const seen = {}, owner = {};
    for (const [a] of all) for (const k of inp.keysOf(a)) (owner[k] ||= []).push(a);
    // Conflict: one key shared by several actions because the player rebound one of them (the game's own sharing, W walks and moves the cursor, is not)
    const mine = inp.rebound(), isDefault = (a, k) => !mine[a]?.includes(k);
    const conflict = k => owner[k].length > 1 && !owner[k].every(a => isDefault(a, k));
    return all.map(([action, v]) => {
      let name = this.engine.t(v.labelKey);
      if (groups[v.labelKey] > 1) name += ' ' + (seen[v.labelKey] = (seen[v.labelKey] || 0) + 1);
      const keys = inp.keysOf(action);
      return { action, name, label: inp.label(action), keys, conflict: keys.some(conflict) };
    });
  }

  // ---------- storage ----------
  _read() {
    let why = 'not an object';
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw == null) return {};
      const d = JSON.parse(raw);
      if (d && typeof d === 'object') return d;
    } catch (e) { why = e.message; }
    warnOnce(coded('save-write', `[settings] the stored settings could not be read (${why}); the defaults are used, and the next change overwrites the stored entry`));
    return {};
  }
  save() {
    const bindings = this.engine.input.rebound();   // only the player's changes; restored through input.rebind on the next launch
    const data = { v: 2, values: { ...this._changed }, bindings, locale: this.engine.i18n.locale };
    let stored = true;
    try { localStorage.setItem(this.storageKey, JSON.stringify(data)); } catch (e) { stored = false; warnOnce(coded('save-write', `[settings] could not store the settings (${e.message}); the choice is applied but will not survive a reload`)); }
    this.engine.events.emit('settings:change', this.values);   // also when the write failed: the value is applied, listeners must follow it
    return stored;
  }

  // ---------- applying ----------
  _currentValues() {
    const e = this.engine, v = { pixelRatio: +e.adaptive.base.toFixed(2), shadows: allowed(e, 'shadows.enabled'), tier: null };
    v.antialias = e.post.authoredAA;   // the default, not what this launch runs with: a choice stored for this launch is the player's, and reset() must get past it
    for (const k of POST_KEYS) v[k] = roleEffects(e, k).every(h => allowed(e, `post.${h.name}.enabled`));   // a permission, true while no effect of the role exists yet: this runs at install, the game adds its effects after
    v.adaptive = !!e.adaptive.on;
    for (const [bus, level] of Object.entries(e.audio.levels)) v['vol.' + bus] = level;   // one slider per bus, the game's own buses too
    return v;
  }
  /** A preset's values in this game on this device: each share made a value. A share of a row nobody offered is left out. Nothing for 'custom' or no preset @param {string} [name] */
  _presetValues(name) {
    const out = {};
    for (const [k, v] of Object.entries(this.presets[name] ?? {})) {
      if (this._omit.has(k)) continue;
      if (!(k in SHARES)) { out[k] = v; continue; }
      const whole = k === 'pixelRatio' ? this.engine.adaptive.base : this.custom.get(k)?.def;
      if (whole != null) out[k] = SHARES[k](v * whole);
    }
    return out;
  }
  /** What the player chose: the preset, then the rows moved after it */
  _picked() {
    const { quality, ...rows } = this._changed;
    for (const k of this._omit) delete rows[k];
    return { ...this._presetValues(quality), ...rows };
  }
  // reads what was asked for (_values), not the live ratio: adaptive resolution lowering the scale is not the player picking 'custom'
  _matchPreset() {
    const v = this._values, e = this.engine;
    for (const name of Object.keys(this.presets)) {
      const ok = Object.entries(this._presetValues(name)).every(([k, val]) => {
        if (k === 'tier' || (POST_KEYS.includes(k) && !roleEffects(e, k).length)) return true;   // nothing the menu shows: no reason to call the picture custom
        return v[k] === val;
      });
      if (ok) return name;
    }
    return 'custom';
  }
  _apply(key, val) { applySetting(this, key, val); }

  // ---------- module hooks ----------
  init() {
    // At start() every module is installed, and the modules before this one have offered their rows (the view distance and density rows are the ground's)
    this._ready = true;
    const picked = this._picked(), e = this.engine;
    for (const k of this._early) if (!this._hasRow(k)) warnOnce(coded('settings-row', `settings.set('${k}') before start: no row came for this key, so nothing applied it`));
    // start() may have learned the real device on the WebGPU route and written its default ratio over the player's
    this._defaults.pixelRatio = +e.adaptive.base.toFixed(2);
    this._values.pixelRatio = picked.pixelRatio ?? this._defaults.pixelRatio;
    if ('pixelRatio' in picked) this._apply('pixelRatio', picked.pixelRatio);
    this._values.quality = this._matchPreset();
  }
  frame() {
    const inp = this.engine.input;
    if (this.capturing) {
      if (!this.win.open) { this.capturing = null; return; }   // closed by its close button: a focus entry left here would hold the back key
      if (this._capturing.hold.fresh) return;                  // the confirm press that opened it is not the new key
      const code = [...inp.justPressed][0];
      // The back key is routed to _cancel by the UI focus stack (cancels rebinding); nothing to do here
      if (code && !inp.keysOf('cancel').includes(code)) { const a = this.capturing; this.capturing = null; this.rebind(a, code); }
      return;
    }
    // When the menu key and the back key are the same (default Esc) the UI focus stack handles it all; with another key: close if open, open when the focus
    // stack is empty
    if (!inp.pressedRaw(this.action) || inp.pressedRaw('cancel')) return;
    if (this.win.open) this.close();
    else if (this.focus.top === null) this.open();
  }
  /** Back key: cancel rebinding if one is in progress, otherwise close the menu */
  _cancel() {
    if (this.capturing) { this.capturing = null; this.win.refresh(); return; }
    this.close();
  }
  /**
   * freezeWorld: gameplay pauses while the menu is open. Pausing has one entry point: with flow installed it switches to flow's 'paused' state (back to the
   * previous state on close),
   * without flow it calls engine.freeze('settings') directly (rendering continues)
   */
  _pause(on) {
    if (!this.freezeWorld) return;
    const e = this.engine, f = e.flow;
    if (!f) { if (on) this._frozen ??= e.freeze('settings'); else { this._frozen?.remove(); this._frozen = null; } return; }
    if (on) { this._flowBefore = f.state; f.go('paused'); }
    else { if (f.state === 'paused' && this._flowBefore) f.go(this._flowBefore); this._flowBefore = null; }
  }

}


const SETTINGS_PARAMS = keysSchema(['action', 'storageKey', 'presets', 'sections', 'freezeWorld']);

/**
 * Settings menu module. Installs engine.settings. Install it after the other modules.
 * @param opts action the action that opens the menu (default the basic 'cancel'; another one the game binds); storageKey storage key; presets override graphics presets;
 * sections which tabs: true (default) graphics, audio, controls, language, saves; a list picks by name, including the optional 'game' (resume, load, back to
 * title) and 'camera' (sensitivity, invert Y, field of view); false for none; an entry { id: 'graphics', omit: [...] } leaves rows out of that tab;
 * freezeWorld pause gameplay while the menu is open (with flow it switches to flow's 'paused', otherwise engine.freeze; rendering continues), default false
 */
export function settings(opts = {}) {
  readParams('settings', SETTINGS_PARAMS, opts);
  let s = null;
  return {
    name: 'settings', skipKind: 'none', type: 'ui', params: SETTINGS_PARAMS, options: opts, label: 'Settings', optional: ['flow', 'cameraRig'], stage: 'effects',
    install(e, ctx) {
      s = new Settings(e, opts, ctx.track);
      ctx.track(e.ui.titleItem('settings', { label: x => x.t('title.settings'), run: () => s.open() }));   // the title screen's Settings button
      return s;
    },
    init() { s.init(); },
    frame() { s.frame(); },
    // the tracked ui:close listener went first, so what an open menu holds is given back here
    dispose() { s.capturing = null; s._pause(false); releaseLimits(s); },
    // the values the player chose (quality preset, volumes, ...) explain a picture or a sound level; open / tab / capturing say the menu holds the input
    describe() { return { open: s.isOpen, tab: s.current, capturing: s.capturing, values: { ...s.values } }; },
  };
}

export const handRolled = [
  { kind: 'pause', seen: 'a pause or Esc handler of its own', use: 'settings({ freezeWorld: true }): Esc stops every system and opens the menu (recipe 63); engine.freeze(why) for a pause with no menu', quiet: /\bsettings\(|\bengine\.(freeze|flow|settings)\b|\buiFocus\(/, code: /\b(?:let|var)\s+(?:is|game)?paused\s*=/i, orRaw: /(?:\.key|\.code)\s*===?\s*['"]Escape['"]/, tags: false },
  { kind: 'settings', seen: 'a settings menu of its own', use: 'engine.settings (settings()): volume, keys, quality and language in one menu that remembers itself; engine.settings.define adds your own (recipe 26)', quiet: /\bsettings\(|\bengine\.settings\b/, code: /\b(createElement|innerHTML|className|classList|getElementById|querySelector|\.id)\b/, raw: /(?:createElement|innerHTML|className|classList|getElementById|querySelector|\.id\b)[^,;{}]*(?:settings|options-?(?:menu|panel|screen)|pause-?menu)|(?:settings|options|pause)-?(?:menu|panel|screen)[^,;{}]*(?:createElement|innerHTML|className|classList|getElementById|querySelector|\.id\b)/i },
];
