// Default 'touch' UI part. An on-screen stick (bottom left) and round action buttons (bottom right). It only turns fingers into
// view.move(x, y) / view.press(action) / view.release(action); Input does the rest. Picture: CSS classes .threedog-stick*, .threedog-touch-* (ui.css).
import { injectUICSS } from './UI.js';
/** @import { Engine, UIPart, TouchView } from '../types/core' */

/**
 * @param {Engine} engine
 * @returns {UIPart}
 * @internal
 */
export function touchPart(engine) {
  injectUICSS();
  let pad = null, bar = null, labels = '';
  /** @type {TouchView} */ let cur;
  const held = new Set();   // actions a finger is on now: a button that goes away mid-press never sees its pointerup, so this view lets go for it
  const letGo = () => { for (const a of held) cur.release(a); held.clear(); };
  const makeStick = () => {
    pad = document.createElement('div'); const knob = document.createElement('div');
    pad.className = 'threedog-stick'; knob.className = 'threedog-stick-knob';
    pad.appendChild(knob); engine.uiRoot.appendChild(pad);
    let id = null;
    const move = ev => {
      const r = pad.getBoundingClientRect(), R = r.width / 2, m = R * 0.72;
      let dx = ev.clientX - r.left - R, dy = ev.clientY - r.top - R;
      const l = Math.hypot(dx, dy); if (l > m) { dx *= m / l; dy *= m / l; }
      knob.style.transform = `translate(${dx}px,${dy}px)`; cur.move(dx / m, -dy / m);   // x right, y forward, length <= 1
    };
    pad.addEventListener('pointerdown', ev => { id = ev.pointerId; pad.setPointerCapture(id); move(ev); });
    pad.addEventListener('pointermove', ev => { if (ev.pointerId === id) move(ev); });
    const end = () => { id = null; cur.move(0, 0); knob.style.transform = ''; };
    pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', end);
  };
  const button = b => {
    const el = document.createElement('button'); el.type = 'button'; el.className = 'threedog-touch-btn'; el.textContent = b.label;
    el.addEventListener('pointerdown', ev => { ev.preventDefault(); held.add(b.action); cur.press(b.action); });
    const up = () => { held.delete(b.action); cur.release(b.action); };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); el.addEventListener('pointerleave', up);
    return el;
  };
  /** @param {TouchView} v */
  const draw = v => {
    cur = v;
    if (v.stick && !pad) makeStick();
    const key = v.buttons.map(b => b.action + ':' + b.label).join('|');
    if (key === labels) return;   // rebuild the buttons only when the set or a label changed
    labels = key;
    letGo();
    if (!bar) { bar = document.createElement('div'); bar.className = 'threedog-touch-bar'; engine.uiRoot.appendChild(bar); }
    bar.replaceChildren(...v.buttons.map(button));
  };
  return { show: draw, update: draw, dispose() { if (cur) { letGo(); cur.move(0, 0); } pad?.remove(); bar?.remove(); pad = bar = null; } };
}
