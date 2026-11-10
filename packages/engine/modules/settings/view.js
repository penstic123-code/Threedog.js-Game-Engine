// UI part of the settings menu (tabs, redraw, click/slider events); Settings inherits it.
import { formatValue, BUILTIN_SECTIONS, OPTIONAL_SECTIONS, settingsTools, definedRows } from './sections.js';
import { esc } from '../../ui/UI.js';
import { codedError, coded } from '../../core/base/errorHints.js';
import { warnOnce } from '../../core/base/validate.js';
import { reportError } from '../../core/base/errors.js';

const CSS_ESC = s => (globalThis.CSS?.escape ? globalThis.CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));

export class SettingsView {
  /** @internal Add a built-in or optional tab by name; an optional tab registers its own settings once (setup) */
  _builtin(id) {
    const s = BUILTIN_SECTIONS[id] ?? OPTIONAL_SECTIONS[id];
    if (!s) throw codedError('settings-tab', `settings: no built-in tab '${id}'. Built-in: ${Object.keys(BUILTIN_SECTIONS).join(', ')}; optional: ${Object.keys(OPTIONAL_SECTIONS).join(', ')}. A tab of your own: engine.settings.addSection('${id}', { title, render }).`);
    if (this.sections.has(id)) return;
    this.sections.set(id, s);
    s.setup?.(this);
  }
  _visibleSections() {
    return [...this.sections].filter(([, s]) => !s.when || s.when(this.engine)).sort((a, b) => (a[1].order ?? 100) - (b[1].order ?? 100));
  }
  _data() {
    const list = this._visibleSections();
    if (!list.some(([id]) => id === this.current)) this.current = list[0]?.[0] ?? null;
    const tools = this._tools();
    const sec = this.sections.get(this.current);
    let body = '';
    try { body = sec ? sec.render(tools, this.engine, this) : ''; } catch (err) { reportError(this.engine, err, `settings tab '${this.current}' render`, { soft: true }); }
    this._checkDefinedRows(body);
    body += definedRows(tools, this.engine, this, this.current);   // the rows define() put in this tab, drawn by the same helpers as the built-in rows
    return { sections: list.map(([id, s]) => ({ id, title: s.title(this.engine), active: id === this.current })), current: this.current, body, values: { ...this.values } };
  }
  /**
   * @internal The two ways a defined row still goes wrong, said once each instead of drawn wrong in silence: a tab the game draws itself also
   * draws a row the engine draws (two rows, pass menu: false), and a row names a tab the menu does not have (no row at all)
   * @param {string} body the current tab's own HTML
   */
  _checkDefinedRows(body) {
    for (const [key, r] of this.custom) {
      if (r.menu === false) continue;
      if (!this.sections.has(r.menu)) warnOnce(coded('settings-row', `settings.define('${key}', ..., { menu: '${r.menu}' }): the menu has no tab '${r.menu}', so the row shows nowhere. Tabs: ${[...this.sections.keys()].join(', ')}`));
      else if (body.includes(`data-set="${esc(key)}"`) || body.includes(`data-range="${esc(key)}"`)) warnOnce(coded('settings-row', `settings tab '${this.current}' draws '${key}' itself and the engine draws it too (in '${r.menu}'): pass settings.define('${key}', ..., { menu: false, apply })`));
    }
  }
  _tools() { return settingsTools(this.engine, esc); }
  _render({ sections, body }, { esc }) {
    const tabs = sections.map(s => `<button type="button" role="tab" class="threedog-btn threedog-tab${s.active ? ' is-active' : ''}" aria-selected="${s.active}" data-tab="${esc(s.id)}">${esc(s.title)}</button>`).join('');
    return `<div class="threedog-tabs" role="tablist">${tabs}</div><div class="threedog-set-body" role="tabpanel">${body}</div>`;
  }
  _afterRefresh() {
    if (!this.win.open) return;
    for (const a of this.actionList()) if (a.conflict) this.win.el.querySelector(`[data-rebind="${CSS_ESC(a.action)}"]`)?.classList.add('is-conflict');
    const sec = this.sections.get(this.current);
    try { sec?.bind?.(this.win.el, this.engine, this); } catch (err) { reportError(this.engine, err, `settings tab '${this.current}' bind`, { soft: true }); }
  }
  _bindDOM(el) {
    el.addEventListener('click', ev => {
      const b = ev.target.closest('[data-tab],[data-set],[data-rebind],[data-reset],[data-locale],[data-save-export],[data-save-import]');
      if (!b || !el.contains(b)) return;
      const d = b.dataset;
      if (d.tab) { this.current = d.tab; this.capturing = null; this.win.refresh(); }
      else if (d.set) { let v = d.value; try { v = JSON.parse(v); } catch { /* a string */ } this.set(d.set, v); }
      else if (d.rebind) { this.capturing = d.rebind; this.win.refresh(); }
      else if (d.reset === 'controls') this.resetBindings();
      else if (d.locale) { this.engine.i18n.setLocale(d.locale); }
      else if (d.saveExport) this.engine.saves.exportFile(d.saveExport);
      else if ('saveImport' in d) this.engine.saves.importFile().then(slot => slot && this.win.refresh());
    });
    // Slider: applies live while dragging (no redraw, to avoid interrupting the drag), saves on release
    el.addEventListener('input', ev => {
      const r = ev.target.closest?.('[data-range]'); if (!r) return;
      const key = r.dataset.range, v = +r.value;
      this._values[key] = v;
      if (key !== 'density' && key !== 'viewChunks') this._apply(key, v);   // these two rebuild the world, so they apply on release
      const lab = el.querySelector(`[data-val="${CSS_ESC(key)}"]`); if (lab) lab.textContent = formatValue(key, v);
    });
    el.addEventListener('change', ev => {
      const r = ev.target.closest?.('[data-range]'); if (!r) return;
      // the live 'input' above already applied this value; only the two world-rebuilding rows still wait for release
      this.set(r.dataset.range, +r.value, { apply: r.dataset.range === 'density' || r.dataset.range === 'viewChunks' });
    });
  }
}
