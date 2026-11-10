// The mouse / touch pointer part of input: drag to look, wheel to zoom, pointer state; mouse buttons act as keys (Mouse0 left / Mouse1 middle / Mouse2 right) passed to Input's _keyDown / _keyUp,
// the same path as the keyboard, so they can be defined as actions and enter the fixed-step snapshot. Touch taps are not mouse buttons (pointerType only accepts 'mouse').

/** e.button -> its bit in e.buttons (middle and right are the other way round) */
const BUTTON_BITS = [1, 4, 2, 8, 16];

/** Wire pointer events on the canvas to input (called once when Input is constructed). signal: engine.dispose() cancels all listeners at once */
export function bindPointer(input, canvas, signal) {
  let drag = null;
  // A second button pressed or released while another is held fires no pointerdown / pointerup, only a pointermove with e.button set (chorded
  // buttons), and pointerup comes for the last button alone: e.buttons is the one true list. A shooter's aim + fire needs it, and a Mouse0 stuck down is the other half
  const chord = e => { if (e.pointerType === 'mouse') BUTTON_BITS.forEach((bit, b) => { if (e.buttons & bit) input._keyDown('Mouse' + b, 'keyboard'); else input._keyUp('Mouse' + b); }); };
  // pointer x / y are pixels from the canvas content box's top-left, ndc is -1..1 across that box: a canvas in a page section or editor
  // panel picks the thing under the mouse, not the thing under the same window position. Read on every event (the canvas may have moved)
  const place = e => {
    // clientWidth counts padding, and pixelSize leaves up to k real pixels of it at the right and bottom, where the picture does not reach (core/scene/pixelRatio.js)
    const st = canvas.style, p = input.pointer, b = canvas.getBoundingClientRect();
    const w = (canvas.clientWidth || b.width || 1) - (parseFloat(st.paddingRight) || 0), h = (canvas.clientHeight || b.height || 1) - (parseFloat(st.paddingBottom) || 0);
    p.x = e.clientX - b.left - canvas.clientLeft; p.y = e.clientY - b.top - canvas.clientTop;
    p.ndcX = p.x / w * 2 - 1; p.ndcY = -(p.y / h) * 2 + 1;
  };
  canvas.addEventListener('pointerdown', e => {
    place(e);   // a touch tap has no pointermove before it: without this, ndc would still point at the last drag
    // The press that only locks the mouse (camera pointerLock) is not an action: no Mouse0, no click, no pointer.down
    const swallowed = e.pointerType === 'mouse' && !!input.swallowLockClick?.();
    if (!swallowed) {
      input.pointer.down = true; input.pointer.button = e.button;
      if (e.pointerType === 'mouse') input._keyDown('Mouse' + e.button, 'keyboard');
    }
    drag = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: 0, swallowed }; canvas.focus();
    // While the mouse is locked (first person) Chromium rejects pointer capture with InvalidStateError; capture is only needed for drag-to-look anyway
    if (document.pointerLockElement !== canvas) canvas.setPointerCapture(e.pointerId);
  }, { signal });
  canvas.addEventListener('pointermove', e => {
    place(e);
    if (e.button >= 0 && drag && !drag.swallowed) chord(e);   // -1 on a plain move
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (document.pointerLockElement === canvas) return;
    input.look.dx += dx; input.look.dy += dy; drag.moved += Math.abs(dx) + Math.abs(dy); drag.x = e.clientX; drag.y = e.clientY;
  }, { signal });
  // When the mouse is locked (first person), use relative movement
  addEventListener('mousemove', e => { if (document.pointerLockElement === canvas) { input.look.dx += e.movementX; input.look.dy += e.movementY; } }, { signal });
  const end = e => {
    if (drag && drag.id !== e.pointerId) return;   // another finger lifting is not this gesture's end
    const swallowed = drag?.swallowed;
    if (drag && !swallowed && drag.moved < 6 && e.type === 'pointerup') input.pointer.clicked = true;   // a cancelled pointer (the browser took the gesture) is no click
    drag = null;
    if (swallowed) return;
    input.pointer.down = false;
    chord(e);
  };
  canvas.addEventListener('pointerup', end, { signal }); canvas.addEventListener('pointercancel', end, { signal });
  // if the right button is bound to an action, do not show the browser menu
  canvas.addEventListener('contextmenu', e => { if ([...input.actions.keys()].some(n => input.keysOf(n).includes('Mouse2'))) e.preventDefault(); }, { signal });
  canvas.addEventListener('wheel', e => { e.preventDefault(); input.look.zoom += Math.sign(e.deltaY); }, { passive: false, signal });
}
