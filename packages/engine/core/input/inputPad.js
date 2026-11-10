// Gamepad buttons. Standard layout names; like keyboard key names they can go into action bindings
import { owns, padSeated } from './inputKeyboard.js';

const PAD_BUTTONS = ['PadA', 'PadB', 'PadX', 'PadY', 'PadLB', 'PadRB', 'PadLT', 'PadRT', 'PadSelect', 'PadStart', 'PadL3', 'PadR3', 'PadUp', 'PadDown', 'PadLeft', 'PadRight'];

/** The pads seats own, each into its seat's keys ('PadA@1') and stick. No look: a shared screen has one camera */
function pollSeats(input, pads) {
  const z = input.padDeadzone, cut = v => Math.abs(v) < z ? 0 : v;
  for (const s of input.seats) {
    if (s.pad === undefined) continue;
    const gp = pads?.[s.pad];
    if (!gp?.connected) {
      s.padStick.x = s.padStick.y = 0;
      if (s._padOn) { s._padOn = false; for (const b of PAD_BUTTONS) input._keyUp(`${b}@${s.pad}`); }
      continue;
    }
    s._padOn = true;
    const btns = gp.buttons;
    for (let i = 0; i < btns.length && i < PAD_BUTTONS.length; i++) { const k = `${PAD_BUTTONS[i]}@${s.pad}`; if (btns[i].pressed) input._keyDown(k, 'pad'); else input._keyUp(k); }
    s.padStick.x = cut(gp.axes[0] || 0); s.padStick.y = -cut(gp.axes[1] || 0);
  }
}

/** Read the first connected gamepad no seat owns into the input's keys, stick and look (every frame; without seats it allocates nothing). An engine that does not own the input reads no unbound pad, which releases what it held @internal */
export function pollPad(input, dt) {
  const pads = navigator.getGamepads?.();
  if (input.seats.length) pollSeats(input, pads);
  let gp = null;
  if (pads && owns(input)) for (let i = 0; i < pads.length && !gp; i++) if (pads[i]?.connected && !padSeated(i)) gp = pads[i];
  if (!gp) {
    input.padStick.x = input.padStick.y = 0;
    if (input._padOn) { input._padOn = false; for (const b of PAD_BUTTONS) input._keyUp(b); }   // disconnected (battery died): release what it held, once
    return;
  }
  input._padOn = true;
  const btns = gp.buttons;
  for (let i = 0; i < btns.length && i < PAD_BUTTONS.length; i++) { if (btns[i].pressed) input._keyDown(PAD_BUTTONS[i], 'pad'); else input._keyUp(PAD_BUTTONS[i]); }
  const z = input.padDeadzone, cut = v => Math.abs(v) < z ? 0 : v;
  input.padStick.x = cut(gp.axes[0] || 0); input.padStick.y = -cut(gp.axes[1] || 0);
  const lx = cut(gp.axes[2] || 0), ly = cut(gp.axes[3] || 0);
  if (lx || ly || input.padStick.x || input.padStick.y) input.lastDevice = 'pad';
  input.look.dx += lx * input.padLookSpeed * 60 * dt; input.look.dy += ly * input.padLookSpeed * 60 * dt;
}

const KEY_NAMES = { Space: 'Space', Enter: 'Enter', Escape: 'Esc', ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', AltLeft: 'Alt', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Tab: 'Tab', Backquote: '`' };
const keyName = code => KEY_NAMES[code] ?? code.replace(/^Key|^Digit|^Pad/, '');

/** Key name shown in the UI, e.g. "E" (follows the last used device: gamepad keys after a pad press) @internal */
export function keyLabel(input, action) {
  const keys = input.keysOf(action).filter(k => !k.startsWith('Touch:'));
  const pad = keys.filter(k => k.startsWith('Pad')), kb = keys.filter(k => !k.startsWith('Pad'));
  const use = input.lastDevice === 'pad' && pad.length ? pad : kb.length ? kb : pad;
  // Key names go through the string table too (key.Space -> its localized name); fall back to the generic form if missing
  const name = k => input.engine.i18n.has('key.' + k) ? input.engine.t('key.' + k) : keyName(k);
  return use.map(name).filter((v, i, arr) => arr.indexOf(v) === i).join('/');
}
/** The key an on-screen hint shows: its label; the 'input.noKey' text when it needs a key and has none (never an empty name); '' for none on purpose (touch, click only) or an action removed since @internal */
export function hintKey(input, action) { return keyLabel(input, action) || (input.actions.has(action) && input.isUnbound(action) ? input.engine.t('input.noKey') : ''); }
/** "E · Talk": the one way an on-screen key and its text read (the interaction prompt, HUD hints and markers) @internal */
export const keyed = (key, text) => key ? (text ? `${key} · ${text}` : key) : text;
