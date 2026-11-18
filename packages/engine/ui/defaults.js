// Core UI parts. Every engine declares 'loading' (on), 'toast' (on), 'title' (off until the game asks). Modules declare their own (hud.*).
// The title screen is a full-screen part: start() opens it after loading when the game turned it on; engine.ui.open('title') shows it again (e.g. "back to title").
import { injectUICSS, toastPart, esc } from './UI.js';
import { loadingScreen } from './LoadingScreen.js';
import { touchPart } from './touchPart.js';
import { codedError } from '../core/base/errorHints.js';
import { fmt } from '../core/base/validate.js';
/** @import { Engine, UIPart, UITitleItem } from '../types/core' */

const STRINGS = {
  'zh-CN': { 'title.start': '开始', 'title.continue': '继续' },
  en: { 'title.start': 'Start', 'title.continue': 'Continue' },
};
const CSS = `
.threedog-title{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;background:var(--threedog-loading-bg);color:var(--threedog-fg);z-index:var(--threedog-z-title);font-family:var(--threedog-font)}
.threedog-title-name{font-size:32px;font-weight:600;letter-spacing:.08em}
.threedog-title-items{display:flex;flex-direction:column;gap:10px;min-width:200px}
.threedog-title-items .threedog-btn{padding:8px 16px;font-size:16px}
`;
const DEV = { badItem: "ui title items: each item is 'start' | 'continue', the id of a button a module added (engine.ui.titleItem: {added}) or { label, run(engine) }. Got {got}." };

// Built-in title items; when() hides an item that has nothing to do (no save yet). Buttons of modules (settings) come from engine.ui.titleItem
// Both go through engine.session so nothing of an earlier playthrough (after "back to title") is left over; a save that cannot be read keeps the title up (the engine shows why).
const BUILTIN = {
  continue: { when: e => e.saves.list().length > 0, run: async e => { if (await e.session.load(e.saves.list()[0].slot)) e.ui.close('title'); } },
  start: { run: async e => { await e.session.newGame(); e.ui.close('title'); } },
};

/** A game's or a module's item -> { id, label, run } */
const own = (e, it) => ({ id: it.id ?? it.label, label: typeof it.label === 'function' ? it.label(e) : it.label, run: () => it.run(e) });

/**
 * Title items -> [{ id, label, run }] (what the title part's show() receives)
 * @param {Engine} e
 * @param {(string | UITitleItem)[]} items
 * @returns {{ id: string, label: string, run: () => any }[]}
 */
function titleItems(e, items) {
  const out = [];
  for (const it of items) {
    if (typeof it === 'string' && BUILTIN[it]) { const b = BUILTIN[it]; if (!b.when || b.when(e)) out.push({ id: it, label: e.t('title.' + it), run: () => b.run(e) }); }
    else if (typeof it === 'string' && e.ui.titleItems.has(it)) out.push(own(e, { id: it, ...e.ui.titleItems.get(it) }));
    else if (it && typeof it.run === 'function') out.push(own(e, it));
    else throw codedError('ui-misuse', fmt(DEV.badItem, { added: [...e.ui.titleItems.keys()].join(', ') || 'none', got: String(JSON.stringify(it)) }));
  }
  return out;
}

/**
 * Default title part: the game name and a column of buttons. show({ title, items: [{ id, label, run }] }) · hide()
 * @param {Engine} engine
 * @returns {UIPart}
 */
function titleScreen(engine) {
  injectUICSS(CSS);
  let el = null;
  return {
    show({ title, items }) {
      el ??= document.createElement('div');
      el.className = 'threedog-ui threedog-title';
      el.innerHTML = `<div class="threedog-title-name">${esc(title)}</div><div class="threedog-title-items">${items.map((it, i) => `<button type="button" class="threedog-btn" data-i="${i}">${esc(it.label)}</button>`).join('')}</div>`;
      el.querySelectorAll('[data-i]').forEach(b => { b.onclick = () => items[+b.dataset.i].run(); });
      engine.uiRoot.appendChild(el);
    },
    get el() { return el; },   // the UI choice cursor picks Start / Continue with keys or a gamepad (no DOM focus: Enter would click twice)
    hide() { el?.remove(); },
    dispose() { el?.remove(); el = null; },
  };
}

/**
 * Declare the core UI parts on a new engine
 * @param {Engine} e
 * @returns {void}
 * @internal
 */
export function defineCoreParts(e) {
  e.i18n.add(STRINGS);
  e.ui.define('loading', loadingScreen);
  e.ui.define('toast', toastPart);
  e.ui.define('title', titleScreen, {
    on: false,
    modal: {
      freeze: 'title',   // freezes gameplay; the kind tells engine.runState this is a title screen waiting for start
      // items default to continue (when a save exists), start, then every button a module added (settings when installed)
      data: (eng, o) => ({ title: o.title ?? '', items: titleItems(eng, o.items ?? ['continue', 'start', ...eng.ui.titleItems.keys()]) }),
    },
  });
  e.ui.define('touch', touchPart);   // drawn only when a stick (createEngine({ joystick })) or a touch button is wanted
}
