// UI focus stack and choice cursor. Windows, dialogue, cutscenes and the settings menu are pushed in open order. The back key (action cancel, default Esc / pad B) goes to the top
// entry only; with an empty stack it goes to the "root" (registered by setRoot, usually the settings menu). So Esc has one entry point and never closes a cutscene and opens the menu at once.
// The choice cursor lives here for the same reason: the menu keys (uiUp / uiDown / uiLeft / uiRight, d-pad, left stick) and confirm move and press
// the selected control of the top entry only (cursor.js), so keyboard-only and gamepad-only players can pick dialogue choices and use every window.
//
//   const f = uiFocus(engine);                                   // one per engine
//   const h = f.push('inventory', { cancel: () => win.toggle(false), nav: () => win.el });   // no cancel = swallow the back key (Esc does nothing during dialogue)
//     nav: () => Element   cursor over the controls inside it (buttons, inputs, selects, [data-nav]); the selected one gets the class is-cursor
//     nav: { count(), confirm(i), moved?(i) }   a list the owner draws itself (dialogue choices); h.setNav(nav | null) changes it while pushed
//     an entry with a nav is something to click, so pushing it (or giving it a nav later) lets go of a locked mouse; the next click on the view locks again
//   h.index      the selected control / choice;  h.consumed  the cursor used confirm on any entry of the stack this frame (the owner's own confirm handling skips it, also when a window above it just closed itself with that press)
//   h.onTop      this entry is the top of the stack (a window without a cursor over a dialogue never uses confirm, so consumed alone would let the dialogue advance)
//   h.fresh      pushed this frame: the key press that opened it (E, Space) must not count as its own action
//   h.remove()   pop (safe to call repeatedly)
//   f.setRoot(() => settings.open())                             // what the back key does on an empty stack; returns a handle { remove() }
//   f.top        top name or null; f.list() names from bottom to top; f.cursor { id, index } of the top entry when it has a nav, else null
// Picture: none (behavior only); the cursor marks the selected DOM control with .is-cursor.
import { stepCursor, forgetNav } from './cursor.js';
const stacks = new WeakMap();   // engine -> UI focus stack
/** @import { Engine } from '../types/core' */
/** @import { UIFocus } from '../types/gameplay' */

/**
 * UI focus stack: windows, dialogue and cutscenes push in open order; the back key (Esc) goes to the top only; an empty stack hands it to the settings menu
 * @experimental the stable route for a screen of your own is engine.input.push (recipes/07-flow-scenes-pause.md)
 * @param {Engine} engine
 * @returns {UIFocus}
 */
export function uiFocus(engine) {
  let f = stacks.get(engine);
  if (f) return f;
  const entries = [], stick = { key: '', t: 0 };
  let root = null, lastUsed = -1;   // lastUsed: the frame the cursor used confirm on any entry; the entry may be gone by the time its owner looks (a window that closes itself), the press is spent either way
  const frame = () => engine.input.frameCount;
  // One place for every window, menu and choice list: under a lock the cursor is gone and a click lands on the canvas. The engine's own release, so it is not read as Esc
  const freeMouse = () => engine.page.releaseLock();
  f = {
    get top() { return entries.at(-1)?.id ?? null; },
    list() { return entries.map(x => x.id); },
    get cursor() { const t = entries.at(-1); return t?.nav ? { id: t.id, index: t.index ?? 0 } : null; },
    /** Push: { cancel, nav }. Returns a handle { id, fresh, index, consumed, setNav(nav), remove() } */
    push(id, { cancel = null, nav = null } = {}) {
      const h = {
        id, cancel, nav, index: null, at: frame(),
        get fresh() { return h.at === frame(); },
        get consumed() { return lastUsed === frame(); },
        get onTop() { return entries.at(-1) === h; },
        setNav(n) { forgetNav(h); h.nav = n; h.index = null; if (n) freeMouse(); },
        remove() { forgetNav(h); const i = entries.indexOf(h); if (i >= 0) entries.splice(i, 1); },
      };
      entries.push(h);
      if (nav) freeMouse();
      return h;
    },
    /** Who gets the back key when the stack is empty (only one; a later registration replaces the earlier) */
    setRoot(fn) { root = fn; return { remove: () => { if (root === fn) root = null; } }; },
  };
  // Each frame (the onFrame callback runs before module frame hooks): the back key dispatches once, and
  // the cursor of the top entry moves / presses (before the dialogue's own confirm check, which reads h.consumed)
  f.hook = engine.onFrame(dt => {
    const top = entries.at(-1);
    if (top?.nav && stepCursor(engine, top, stick, dt)) lastUsed = frame();
    if (!engine.input.pressedRaw('cancel')) return;
    if (entries.at(-1)) entries.at(-1).cancel?.();
    else root?.();
  });
  // Esc under pointer lock never reaches the page: the browser keeps the key and ends the lock, so the first Esc of a mouse-look game would pause nothing.
  // Only the empty stack in running play. A game ending the lock itself (engine.page.releaseLock(), or document.exitPointerLock(): core/engine/page.js marks both as byEngine)
  // to show its own window or screen must not have it closed or covered.
  f.unlock = engine.events.on('page:pointerlock', ({ locked, byEngine }) => {
    if (!locked && !byEngine && !entries.length && !engine.page.away && engine.runState.state === 'running') root?.();
  });
  stacks.set(engine, f);
  return f;
}
