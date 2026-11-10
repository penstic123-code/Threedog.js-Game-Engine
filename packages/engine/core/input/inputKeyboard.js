// The keyboard part of input. A key event is the window's and a gamepad is the page's, so every engine on a page gets them, and two games side by side would both walk.
// One rule: the engine last pressed or focused owns the keyboard and the gamepads no seat is bound to (its canvas or anything in its uiRoot). Until then the first engine on the page does, as it would alone:
// a second engine appearing takes nothing away, and with a single engine nothing here ever changes who hears a key. A press elsewhere on the page moves nothing.
// Only a keydown is gated. A keyup always counts, and what the old owner held it lets go of at the handover: its keyup may come much later.
// Mouse buttons and on-screen buttons are the engine's own: those keys stay as they are. Gamepads are polled: a former owner's next poll reads no pad and lets go (inputPad.js).

import { warnOnce, DEV } from '../base/validate.js';

const NOT_KEYBOARD = /^(Mouse|Pad|Touch:)/;
/** The Inputs alive on this page; the first is the owner, the one after it had the keyboard before and gets it back if the owner goes */
const inputs = [];

/** Does this engine.input own the keyboard and gamepads now? @internal @param {any} input */
export const owns = input => inputs[0] === input;

/** Is this pad bound to a seat of any engine on the page? A seat was told its pad: it hears it whoever owns the input, and the owner does not read it too @internal @param {number} i */
export const padSeated = i => inputs.some(input => input.seats.some(s => s.pad === i));

/** The keyboard codes any action is bound to (mouse, pad and touch keys are not the browser's) @param {any} input */
const boundCodes = input => [...new Set([...input.actions.keys()].flatMap(a => input.keysOf(a)).filter(k => !NOT_KEYBOARD.test(k)))];
/** Is the game being played: no opaque context (menu, dialogue), not frozen (pause, tab away). The same two facts every other system reads, not a notion of its own @param {any} input */
const playing = input => !input.blockedBy().length && !input.engine.frozen;
/** Is this where the player types text: a field, a select, or anything inside a contenteditable (isContentEditable is true for its children too). Game keys never route from here @param {any} t */
const isEditable = t => !!t && (t.isContentEditable === true || /INPUT|TEXTAREA|SELECT/.test(t.tagName));
/** Keys a developer needs: reload and devtools stay with the browser in dev builds, even when a game binds them @param {KeyboardEvent} e */
const devKey = e => e.code === 'F5' || e.code === 'F12' || ((e.ctrlKey || e.metaKey) && (e.code === 'KeyR' || (e.shiftKey && e.code === 'KeyI')));

/** @param {any} input the engine.input that takes the keyboard */
function take(input) {
  const [owner] = inputs;
  if (owner === input) return;
  for (const k of [...owner.keys]) if (!NOT_KEYBOARD.test(k)) owner._keyUp(k);
  inputs.splice(inputs.indexOf(input), 1);
  inputs.unshift(input);
  owner._kbSync?.(); input._kbSync?.();   // the old owner gives the page's key lock back, then the new one asks for its own
}

/** Wire the keyboard to input (called once when Input is constructed). signal: engine.dispose() cancels all listeners at once @param {any} input @param {HTMLCanvasElement} canvas @param {AbortSignal} signal */
export function bindKeyboard(input, canvas, signal) {
  inputs.push(input);
  const claim = e => { if (e.target === canvas || input.engine.uiRoot.contains(e.target)) take(input); };
  addEventListener('pointerdown', claim, { signal, capture: true });   // on the window, capturing: a game's stopPropagation must not hide the press
  addEventListener('focusin', claim, { signal, capture: true });
  addEventListener('keydown', e => {
    if (!owns(input) || isEditable(e.target)) return;
    input._keyDown(e.code, 'keyboard');
    if (input.blockBrowserKeys && (e.code === 'Space' || e.code === 'Tab' || e.code.startsWith('Arrow') || (playing(input) && boundCodes(input).includes(e.code)))) {
      if (DEV && devKey(e)) { warnOnce(`input: '${e.code}' is bound but reload / devtools keys stay with the browser in dev builds (blockBrowserKeys never blocks F5, Ctrl+R, F12, Ctrl+Shift+I here); pick another key`, 'browser-key:' + e.code); return; }
      e.preventDefault();
    }
  }, { signal });
  // Keyboard Lock (Chromium, fullscreen only): while playing, the bound keys go to the page even for Ctrl+W and friends; menus, pause and leaving fullscreen give them back.
  // input._kbSync is the one place that decides the page's lock state: context, rebind, blur, fullscreen, freeze (holds.js), a change of owner (take) and dispose all call it
  const kb = /** @type {any} */ (navigator).keyboard;
  if (kb?.lock) {
    const sync = () => { try { if (input.blockBrowserKeys && document.fullscreenElement && owns(input) && playing(input)) kb.lock(boundCodes(input))?.catch?.(() => {}); else kb.unlock(); } catch { /* not allowed here: the keys simply stay the browser's */ } };
    input._kbSync = sync;
    document.addEventListener('fullscreenchange', sync, { signal });
    for (const ev of ['input:context', 'input:rebind', 'page:blur']) input.engine.events.on(ev, sync);
  }
  addEventListener('keyup', e => input._keyUp(e.code), { signal });
  signal.addEventListener('abort', () => {
    const was = owns(input);
    inputs.splice(inputs.indexOf(input), 1);
    if (was) { input._kbSync?.(); inputs[0]?._kbSync?.(); }   // a disposed owner leaves no lock on the page; the next owner asks for its own
  });
}
