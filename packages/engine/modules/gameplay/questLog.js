// The quest log window as the UI part 'questLog'. Quests keeps the behavior through engine.ui (the J key toggles it; open = UI focus stack, input lock,
// Esc closes, ui:open / ui:close 'questLog'); the part only draws { title, key, quests, close() }. Replace it or turn it off with engine.ui.set('questLog', ...).
// Default picture: a .threedog-win window; its body can be replaced by ui.templates.quests({ quests }, { esc, t }) or restyled via .threedog-quest*.
import { injectUICSS, esc } from '../../ui/UI.js';
/** @import { Engine, UIPart } from '../../types/core' */
/** @import { QuestLogView } from '../../types/gameplay' */

const NAME = 'questLog';

/**
 * Default 'questLog' part: show(view) / update(view) draw the list, hide() hides it
 * @param {Engine} engine
 * @returns {UIPart}
 */
function questLogPart(engine) {
  injectUICSS();
  let w = null;
  const tools = { esc, t: (k, p) => engine.t(k, p) };
  const body = ({ quests }) => quests.length ? quests.map(q => `
    <div class="threedog-quest${q.done ? ' is-done' : ''}"><div class="threedog-quest-title">${esc(q.title)}${q.done ? esc(engine.t('quests.doneTag')) : ''}</div>
    ${q.desc ? `<div class="threedog-row-sub">${esc(q.desc)}</div>` : ''}
    <ol class="threedog-steps">${q.steps.map(s => `<li class="threedog-step${s.done ? ' is-done' : s.current ? ' is-current' : ''}">${esc(s.text)}</li>`).join('')}</ol></div>`).join('')
    : `<p class="threedog-empty">${esc(engine.t('quests.empty'))}</p>`;
  /** @param {QuestLogView} v */
  const draw = v => {
    if (!w) { w = document.createElement('div'); w.className = 'threedog-ui threedog-win threedog-win-quests'; engine.uiRoot.appendChild(w); }
    w.hidden = false;
    const tpl = engine.ui.templates.quests;
    w.innerHTML = `<div class="threedog-win-head"><span>${esc(v.title)}</span><span><span class="threedog-win-hint">${esc(v.key)}</span> <button class="threedog-btn threedog-close" type="button">${esc(engine.t('common.close'))}</button></span></div>${tpl ? tpl(v, tools) : body(v)}`;
    w.querySelector('.threedog-close').onclick = () => v.close();
  };
  return { show: draw, update: draw, hide() { if (w) w.hidden = true; }, get el() { return w; }, dispose() { w?.remove(); w = null; } };   // el: the UI choice cursor's root
}

/**
 * Declare the 'questLog' part and return the handle Quests uses: { open, toggle(on?), refresh() } (same shape toggleOnKey expects)
 * @param {Engine} e
 * @param {import('./Quests.js').Quests} q
 * @returns {{ readonly open: boolean, toggle(on?: boolean): void, refresh(): void }}
 * @internal
 */
export function questLogWindow(e, q, ctx) {
  const { track } = ctx;
  /** @returns {QuestLogView} */
  const view = () => ({ title: e.t('quests.title'), key: e.input.label(q.action), quests: q.list(), close: () => e.ui.close(NAME) });
  ctx.ui.define(NAME, questLogPart, { modal: { cancel: eng => eng.ui.close(NAME), data: view } });
  const win = {
    get open() { return e.ui.isOpen(NAME); },
    toggle(on = !win.open) { if (on) e.ui.open(NAME); else e.ui.close(NAME); },
    refresh() { if (win.open) e.ui.get(NAME).update(view()); },
  };
  track(e.events.on('i18n:change', win.refresh));
  track(e.events.on('input:rebind', win.refresh));
  return win;
}
