// Built-in tabs of the settings menu: graphics, audio, keys, language, saves.
// Each tab is { title: engine => text, render: (tools, engine, settings) => HTML, bind?: (element, engine, settings) => void, when?: engine => show or not, order }
// Controls bind no events directly; they carry data-* attributes that view.js handles in one place (a game's whole-page template can use the same attributes):
//   data-tab="graphics"                   switch tab
//   data-set="shadows" data-value="true"  click sets the setting shadows to true (value parsed as JSON, falls back to a string)
//   data-range="vol.music"                slider <input type="range">; applies live while dragging, saves on release
//   data-rebind="interact"                click to enter the "press a key" state
//   data-reset="controls"                 restore default keys
//   data-locale="en"                      switch language

import { setFov, lensFov } from '../../core/scene/view.js';
import { roleEffects } from './apply.js';
import { someLight } from '../../core/inspect/pictureMenu.js';

const pct = v => Math.round(v * 100) + '%';
/** Value shown beside a slider */
export const formatValue = (key, v) => key.startsWith('vol.') || key === 'density' ? pct(v)
  : key === 'pixelRatio' || key === 'camera.sensitivity' ? '×' + (+v).toFixed(2) : key === 'camera.fov' ? v + '°' : String(v);

/** One row: text on the left, control on the right */
const row = (label, ctl, esc) => `<div class="threedog-row threedog-set-row"><span class="threedog-set-label">${esc(label)}</span><span class="threedog-set-ctl">${ctl}</span></div>`;

/** Toggle button */
const toggle = (key, on, { esc, t }) =>
  `<button type="button" class="threedog-btn threedog-set-toggle${on ? ' is-active' : ''}" aria-pressed="${!!on}" data-set="${esc(key)}" data-value="${!on}">${esc(t(on ? 'common.on' : 'common.off'))}</button>`;

/** Slider */
const range = (key, v, min, max, step, { esc }) =>
  `<input class="threedog-range" type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-range="${esc(key)}" aria-label="${esc(key)}"><span class="threedog-set-val" data-val="${esc(key)}">${esc(formatValue(key, v))}</span>`;

/** A group of mutually exclusive buttons: options = [[value, text], ...]; a disabled value is display-only (e.g. "custom") */
const segmented = (key, cur, options, { esc }, disabled = []) =>
  `<span class="threedog-seg">${options.map(([v, label]) => {
    const on = v === cur, off = disabled.includes(v);
    return `<button type="button" class="threedog-btn${on ? ' is-active' : ''}" aria-pressed="${on}"${off ? ' disabled' : ` data-set="${esc(key)}" data-value="${esc(JSON.stringify(v))}"`}>${esc(label)}</button>`;
  }).join('')}</span>`;

/** The tools argument of a tab's render(tools, e, s): esc / t plus the control helpers, already bound (return HTML) */
export function settingsTools(engine, esc) {
  const base = { esc, t: (k, p) => engine.t(k, p) };
  return {
    ...base,
    row: (label, ctl) => row(label, ctl, esc),
    toggle: (key, on) => toggle(key, on, base),
    range: (key, v, min, max, step) => range(key, v, min, max, step, base),
    segmented: (key, cur, options, disabled = []) => segmented(key, cur, options, base, disabled),
  };
}

export const BUILTIN_SECTIONS = {
  graphics: {
    order: 10, title: e => e.t('settings.graphics'),
    render(tools, e, s) {
      const { esc, t } = tools, v = s.values;
      const opts = ['low', 'medium', 'high', 'custom'].map(k => [k, t('settings.quality.' + k)]);
      let h = '';
      const add = (key, label, ctl) => { if (!s._omit.has(key)) h += row(label, ctl, esc); };   // a row the game left out: settings({ sections: [{ id: 'graphics', omit }] })
      add('quality', t('settings.quality'), segmented('quality', v.quality, opts, tools, ['custom']));
      add('pixelRatio', t('settings.pixelRatio'), range('pixelRatio', v.pixelRatio, 0.5, 2, 0.05, tools));
      if (someLight(e.scene, l => l.castShadow)) add('shadows', t('settings.shadows'), toggle('shadows', v.shadows, tools));   // like bloom and ao: no row for an effect nothing uses
      add('antialias', t('settings.antialias'), toggle('antialias', v.antialias, tools));
      if (roleEffects(e, 'bloom').length) add('bloom', t('settings.bloom'), toggle('bloom', v.bloom, tools));
      if (roleEffects(e, 'ao').length) add('ao', t('settings.ao'), toggle('ao', v.ao, tools));
      add('adaptive', t('settings.adaptive'), toggle('adaptive', v.adaptive, tools));
      // the ground's own rows: the slider reaches at least as far as the game's value and the share Low gave it
      const view = s.custom.get('viewChunks');
      if (view) add('viewChunks', t('settings.viewDistance'), range('viewChunks', v.viewChunks, Math.min(2, v.viewChunks), Math.max(8, view.def), 1, tools));
      if (s.custom.has('density')) add('density', t('settings.density'), range('density', v.density, 0.25, 1.5, 0.25, tools));
      if (v.antialias !== e.post.antialias) h += `<p class="threedog-set-note">${esc(t('settings.nextStart'))}</p>`;   // MSAA is fixed with the canvas: say why the picture did not change
      return h;
    },
  },
  audio: {
    order: 20, title: e => e.t('settings.audio'),
    render(tools, e, s) {
      const { esc, t } = tools;
      // every bus of engine.audio (master first); a game's own bus is labeled by its key settings.vol.<bus>, else by its name
      return Object.keys(e.audio.levels).map(b => row(e.i18n.has('settings.vol.' + b) ? t('settings.vol.' + b) : b,
        range('vol.' + b, s.values['vol.' + b] ?? 1, 0, 1, 0.05, tools), esc)).join('');
    },
  },
  controls: {
    order: 30, title: e => e.t('settings.controls'),
    render(tools, e, s) {
      const { esc, t } = tools;
      const rows = s.actionList().map(a => {
        const waiting = s.capturing === a.action;
        const keys = waiting ? t('settings.pressKey') : (a.label || t('settings.unbound'));
        return `<div class="threedog-row threedog-set-row threedog-set-bind"><span class="threedog-set-label">${esc(a.name)}</span>`
          + `<span class="threedog-set-ctl"><button type="button" class="threedog-btn threedog-key${waiting ? ' is-waiting' : ''}" data-rebind="${esc(a.action)}">${esc(keys)}</button></span></div>`;
      }).join('');
      return `<div class="threedog-list">${rows}</div><p class="threedog-set-note">${esc(t('settings.rebindHint'))}</p>`
        + `<div class="threedog-set-foot"><button type="button" class="threedog-btn" data-reset="controls">${esc(t('settings.resetKeys'))}</button></div>`;
    },
  },
  language: {
    order: 40, title: e => e.t('settings.language'), when: e => e.i18n.languages.length > 1,
    render(tools, e) {
      const { esc, t } = tools, cur = e.i18n.locale;
      const btns = e.i18n.languages.map(l => {
        const name = e.i18n.has('settings.langName.' + l) ? t('settings.langName.' + l) : l;
        return `<button type="button" class="threedog-btn${l === cur ? ' is-active' : ''}" aria-pressed="${l === cur}" data-locale="${esc(l)}">${esc(name)}</button>`;
      }).join('');
      return row(t('settings.language'), `<span class="threedog-seg">${btns}</span>`, esc);
    },
  },
  // Save backup: an "Export" per save slot (downloads .json, attachments included) and an "Import" at the bottom (pick a file to restore). A safety net for when mobile browsers clear site data
  saves: {
    order: 50, title: e => e.t('settings.saves'),
    render(tools, e) {
      const { esc, t } = tools, list = e.saves.list();
      const rows = list.map(s => row(`${s.slot}  ${new Date(s.savedAt).toLocaleString()}`,
        `<button type="button" class="threedog-btn" data-save-export="${esc(s.slot)}">${esc(t('settings.exportSave'))}</button>`, esc)).join('')
        || `<p class="threedog-set-note">${esc(t('settings.noSaves'))}</p>`;
      return `${rows}<p class="threedog-set-note">${esc(t('settings.saveHint'))}</p>`
        + `<div class="threedog-set-foot"><button type="button" class="threedog-btn" data-save-import>${esc(t('settings.importSave'))}</button></div>`;
    },
  },
};

// Optional tabs: not in the default menu (a game with no use for them should not show them). Turn on with
// settings({ sections: ['graphics', 'audio', 'controls', 'game', 'camera'] }) or engine.settings.addSection('camera').
// setup(s) runs once when the tab is added and registers the tab's own settings (saved like any other).
export const OPTIONAL_SECTIONS = {
  // Resume / load a slot / back to title (only when the game turned the title part on)
  game: {
    order: 5, title: e => e.t('settings.game'),
    render(tools, e) {
      const { esc, t } = tools;
      const btn = (act, label, extra = '') => `<button type="button" class="threedog-btn" data-game="${act}"${extra}>${esc(label)}</button>`;
      let h = row(t('settings.resume'), btn('resume', t('settings.resume')), esc);
      for (const s of e.saves.list()) {
        h += row(`${s.slot}  ${new Date(s.savedAt).toLocaleString()}`, btn('load', t('settings.load'), ` data-slot="${esc(s.slot)}"`), esc);
      }
      if (e.ui.describe().title !== 'off') h += row(t('settings.toTitle'), btn('title', t('settings.toTitle')), esc);
      return h;
    },
    bind(el, e, s) {
      for (const b of el.querySelectorAll('[data-game]')) b.onclick = async () => {
        const act = b.dataset.game;
        s.close();
        if (act === 'load') await e.session.load(b.dataset.slot);   // a clean playthrough from the save, not a quick load onto this one
        else if (act === 'title') await e.session.quit();
      };
    },
  },
  // Mouse sensitivity, invert Y, field of view: written to the current camera (engine.cameraRig)
  camera: {
    order: 25, title: e => e.t('settings.camera'), when: e => !!e.cameraRig,
    setup(s) {
      const e = s.engine, rig = () => e.cameraRig;
      s.define('camera.sensitivity', rig()?.sensitivity ?? 1, v => { if (rig() && 'sensitivity' in rig()) rig().sensitivity = v; });
      s.define('camera.invertY', rig()?.invertY ?? false, v => { if (rig() && 'invertY' in rig()) rig().invertY = v; });
      s.define('camera.fov', lensFov(e) ?? 50, v => setFov(e, v));   // the player's slider: yields to a fov the game took (engine.autoView.manual('fov'))
      // a new rig starts from its own defaults (and setCamera resets the fov): put the player's choices back on it
      s._track(e.events.on('camera:change', () => { for (const k of ['camera.sensitivity', 'camera.invertY', 'camera.fov']) s.custom.get(k)?.apply(s.values[k], e); }));
    },
    render(tools, e, s) {
      const { esc, t } = tools, v = s.values;
      return row(t('settings.sensitivity'), range('camera.sensitivity', v['camera.sensitivity'], 0.2, 3, 0.05, tools), esc)
        + row(t('settings.invertY'), toggle('camera.invertY', v['camera.invertY'], tools), esc)
        + row(t('settings.fov'), range('camera.fov', v['camera.fov'], 40, 100, 1, tools), esc);
    },
  },
};
