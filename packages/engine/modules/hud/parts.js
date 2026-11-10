// Default HUD UI parts (hud.marker, hud.counter, hud.bar). hud/index.js keeps the logic (targets, projection, edge arrows, quest sync)
// and hands each part plain data; a game replaces any of them with engine.ui.set('hud.counter', ...) or turns it off with false.
// Picture: CSS classes .threedog-hud .threedog-hud-stats .threedog-hud-marker .threedog-hud-arrow .threedog-hud-counter .threedog-hud-bar;
//   colors follow ui.theme bg / fg / accent unless ui.theme hudBg / hudFg / hudAccent say otherwise; layout is plain CSS, so ui.css moves the stats column, sizes, fonts.
//   Inner HTML: ui.templates.hudMarker / hudCounter / hudBar (data, { esc, t }) => HTML.
import { esc, placeAt } from '../../ui/UI.js';
import { keyed } from '../../core/input/inputPad.js';   // "E · Talk", the same as the interaction prompt
/** @import { Engine } from '../../types/core' */

export const CSS = `
.threedog-hud{position:fixed;inset:0;pointer-events:none;z-index:12;font:13px/1.4 var(--threedog-font);color:var(--threedog-hud-fg)}
.threedog-hud-stats{position:absolute;display:flex;flex-direction:column;gap:6px;--hx:calc(12px + env(safe-area-inset-left,0px));--hy:calc(12px + env(safe-area-inset-top,0px))}
.threedog-hud-top-left,.threedog-hud-left,.threedog-hud-bottom-left{left:var(--hx)}
.threedog-hud-top-right,.threedog-hud-right,.threedog-hud-bottom-right{right:calc(12px + env(safe-area-inset-right,0px));align-items:flex-end}
.threedog-hud-top,.threedog-hud-bottom{left:50%;transform:translateX(-50%);align-items:center}
.threedog-hud-top-left,.threedog-hud-top,.threedog-hud-top-right{top:var(--hy)}
.threedog-hud-bottom-left,.threedog-hud-bottom,.threedog-hud-bottom-right{bottom:calc(12px + env(safe-area-inset-bottom,0px))}
.threedog-hud-left,.threedog-hud-right{top:50%;transform:translateY(-50%)}
.threedog-hud-counter,.threedog-hud-bar,.threedog-hud-hint{background:var(--threedog-hud-bg);border-radius:var(--threedog-radius-small);padding:4px 10px;min-width:120px}
.threedog-hud-bar-track{height:6px;border-radius:3px;background:var(--threedog-line);overflow:hidden;margin-top:3px}
.threedog-hud-bar-fill{height:100%;width:calc(var(--threedog-hud-fill,0) * 100%);background:var(--threedog-hud-accent)}
.threedog-hud-marker{position:absolute;left:0;top:0;transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;white-space:nowrap;text-shadow:var(--threedog-shadow-small)}
.threedog-hud-marker::after{content:'';width:10px;height:10px;margin-top:2px;border-radius:50%;background:var(--threedog-hud-accent)}
.threedog-hud-marker.threedog-hud-arrow{transform:translate(-50%,-50%)}
.threedog-hud-marker.threedog-hud-arrow::after{width:0;height:0;border-radius:0;border:7px solid transparent;border-left:12px solid var(--threedog-hud-accent);order:-1;transform:rotate(var(--threedog-hud-angle,0rad))}
.threedog-hud-stats .threedog-hud-button{pointer-events:auto}
.threedog-hud-dist{color:var(--threedog-hud-accent);font-size:12px}
`;

/**
 * Declare the default HUD parts. layer / column(anchor) are hud's containers (created only when some default part is in use).
 * @param {Engine} e
 * @param {() => { layer: HTMLElement, column(anchor?: string): HTMLElement }} root
 * @returns {void}
 */
export function defineHudParts(e, ctx, root) {
  const tools = { esc, t: (k, p) => e.t(k, p) };
  const tpl = name => e.ui.templates[name];

  // One marker: update({ x, y, arrow, angle, label, icon, distance }) moves and redraws it; hide() hides it
  ctx.ui.define('hud.marker', () => {
    const el = document.createElement('div');
    el.className = 'threedog-hud-marker'; el.hidden = true; root().layer.appendChild(el);
    let html = null;
    return {
      el,
      update(d) {
        el.hidden = false;
        el.classList.toggle('threedog-hud-arrow', d.arrow);
        if (d.arrow) el.style.setProperty('--threedog-hud-angle', d.angle.toFixed(3) + 'rad');
        const t = tpl('hudMarker');
        const h = t ? t(d, tools) : `${d.icon || d.label ? `<span class="threedog-hud-label">${esc(d.icon)} ${esc(d.label)}</span>` : ''}${d.distance ? `<span class="threedog-hud-dist">${esc(d.distance)}</span>` : ''}`;
        if (h !== html) { html = h; el.innerHTML = h; }   // rebuild only when the text changed (called every frame)
        // An edge arrow is centered on its spot, so a long label would run off the screen: keep the whole marker inside
        const half = d.arrow ? el.offsetWidth / 2 : 0, w = el.parentNode?.clientWidth ?? 0;
        placeAt(el, half && w ? Math.min(Math.max(d.x, half), w - half) : d.x, d.y);
      },
      hide() { el.hidden = true; },
      dispose() { el.remove(); },
    };
  }, { multi: true });

  // a counter / bar lives in the column of its anchor; a changed anchor moves the element there
  const place = (el, d) => { const col = root().column(d.anchor ?? 'top-left'); if (el.parentNode !== col) col.appendChild(el); };

  // a text box placed at its anchor (counter, key hint): the part is one div, write(el, d) fills it
  const box = (cls, write) => () => {
    const el = document.createElement('div'); el.className = cls;
    return { el, update(d) { place(el, d); write(el, d); }, dispose() { el.remove(); } };
  };

  ctx.ui.define('hud.counter', box('threedog-hud-counter', (el, d) => {
    const t = tpl('hudCounter');
    if (t) el.innerHTML = t(d, tools);
    // value is a number (a count, with max: 2 / 5) or text (a time '08:30', a quest step): one counter for both, no second widget.
    // No value = the label alone: a status line that has no number yet must not read "0". No label = the value alone: the id is the game's handle, not text for the player
    else el.textContent = [d.icon, d.label, d.value == null ? null : d.max != null ? `${d.value} / ${d.max}` : d.value].filter(x => x != null && x !== '').join(' ');
  }), { multi: true });

  // A button is plain DOM over the canvas, so a press on it never reaches the canvas input (no shot, no look-drag, no pointer lock). A click gives keyboard focus back to the
  // game (a button left focused would answer the next Enter), and the label goes through engine.t like every other text.
  ctx.ui.define('hud.button', () => {
    const el = document.createElement('button'); el.type = 'button'; el.className = 'threedog-btn threedog-hud-button';
    let run = null;
    el.addEventListener('click', () => { el.blur(); run?.(); });
    return {
      el,
      update(d) {
        place(el, d); run = d.run;
        el.textContent = [d.icon, keyed(d.key, d.label == null ? '' : e.t(d.label))].filter(x => x).join(' ');
      },
      dispose() { el.remove(); },
    };
  }, { multi: true });

  // "E · Talk": d.key is already the input label of the action (hud keeps it current); not clickable, so it never takes the mouse
  ctx.ui.define('hud.hint', box('threedog-hud-hint', (el, d) => { el.textContent = keyed(d.key, d.label == null ? '' : e.t(d.label)); }), { multi: true });

  ctx.ui.define('hud.bar', () => {
    const el = document.createElement('div'); el.className = 'threedog-hud-bar';
    let label;
    return {
      el,
      update(d) {
        place(el, d);
        const t = tpl('hudBar');
        if (t) { el.innerHTML = t(d, tools); return; }
        if (label !== d.label || !el.firstChild) { label = d.label; el.innerHTML = `${d.label ? `<span>${esc(d.label)}</span>` : ''}<div class="threedog-hud-bar-track"><div class="threedog-hud-bar-fill"></div></div>`; }
        el.style.setProperty('--threedog-hud-fill', Math.max(0, Math.min(1, (d.value ?? 0) / (d.max ?? 1))));
      },
      dispose() { el.remove(); },
    };
  }, { multi: true });
}
