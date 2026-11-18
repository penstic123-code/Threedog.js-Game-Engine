// UI choice cursor. Split out of Focus.js: which control of the top focus entry is selected, moved by the menu keys (uiUp / uiDown / uiLeft /
// uiRight, the gamepad d-pad, the left stick) and pressed by confirm. Why one cursor in the focus stack and not one per window: only the top entry
// takes keys (the same rule as the back key), so a dialogue over an open inventory moves its choices, never the slots underneath, and a game's own window
// gets gamepad navigation by pushing with nav instead of writing its own key loop.
// Two kinds of nav (the entry's nav option):
//   a function () => Element | null   the controls inside that element (buttons, inputs, selects, [data-nav]) in screen layout: up / down / left / right
//                                      go to the nearest control that way, so lists, grids and settings rows all work without declaring columns
//   { count(), confirm(i), moved?(i) } a list the owner draws itself (dialogue choices handed to a replaceable UI part): any direction steps by one
// Picture: the DOM kind adds the class is-cursor to the selected control (style it in ui.css); a list owner draws its own (dialogue: view.selected).
const SEL = 'button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), [data-nav]';
const DIRS = { uiUp: [0, -1], uiDown: [0, 1], uiLeft: [-1, 0], uiRight: [1, 0] };
const STICK = 0.5, REPEAT_FIRST = 0.4, REPEAT = 0.15;   // stick: half tilt counts, held it repeats like a key (first after 0.4 s, then every 0.15 s)

/** Visible controls inside root, in DOM order (hidden ones have no client rects) @internal */
function navItems(root) {
  if (!root || root.hidden) return [];
  return [...root.querySelectorAll(SEL)].filter(el => el.getClientRects().length > 0);
}

/** The direction pressed this frame ([dx, dy], screen y down) from the menu keys or the stick (edge + repeat), or null @internal */
function readDir(input, st, dt) {
  for (const [a, d] of Object.entries(DIRS)) if (input.actions.has(a) && input.pressedRaw(a)) return d;
  const s = input.padStick, x = Math.abs(s.x) >= STICK ? Math.sign(s.x) : 0, y = Math.abs(s.y) >= STICK ? -Math.sign(s.y) : 0;   // padStick.y is up-positive
  const d = Math.abs(s.x) > Math.abs(s.y) ? (x ? [x, 0] : null) : (y ? [0, y] : null);
  const key = d ? d.join() : '';
  if (key !== st.key) { st.key = key; st.t = REPEAT_FIRST; return d; }
  if (!d) return null;
  if ((st.t -= dt) > 0) return null;
  st.t = REPEAT;
  return d;
}

/** Nearest control from cur in direction d (screen layout); cur itself when there is none that way @internal */
function spatial(items, cur, [dx, dy]) {
  const r0 = items[cur].getBoundingClientRect(), cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
  let best = cur, bestScore = Infinity;
  items.forEach((el, i) => {
    if (i === cur) return;
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2 - cx, y = r.top + r.height / 2 - cy;
    const along = x * dx + y * dy, across = Math.abs(x * dy - y * dx);
    if (along <= 0.5) return;
    const score = along + across * 2;   // prefer straight ahead: a slot right below beats a closer one off to the side
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}

/** Left / right on a slider or a dropdown changes its value (settings rows) instead of leaving it @internal */
function adjust(el, dx) {
  if (el.tagName === 'INPUT' && el.type === 'range') { if (dx > 0) el.stepUp(); else el.stepDown(); }
  else if (el.tagName === 'SELECT') el.selectedIndex = Math.max(0, Math.min(el.options.length - 1, el.selectedIndex + dx));
  else return false;
  el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/**
 * One frame of cursor work for the top focus entry h (not on the frame it was pushed: the key that opened it is not its first move).
 * Returns true when it used confirm (the owner then skips its own confirm handling this frame).
 * @internal
 */
export function stepCursor(engine, h, st, dt) {
  const input = engine.input, nav = h.nav;
  const dom = typeof nav === 'function';
  const d = h.fresh ? null : readDir(input, st, dt), press = !h.fresh && input.pressedRaw('confirm');
  // a move needs fresh rects (spatial reads layout anyway); an idle frame reuses the cached list, so an open menu forces no layout per frame
  const items = dom ? domItems(h, nav(), !!d || press) : null, n = dom ? items.length : nav.count();
  if (!n) { h.index = 0; return false; }
  if (h.index == null || h.index >= n) h.index = dom ? Math.max(0, items.findIndex(el => !el.classList.contains('threedog-close'))) : 0;   // start on content, not on Close
  const was = h.index;
  if (d) {
    if (!dom) h.index = (h.index + d[0] + d[1] + n) % n;
    else if (!(d[0] && adjust(items[h.index], d[0]))) h.index = spatial(items, h.index, d);
  }
  if (dom) markCursor(h, items[h.index]);
  else if (h.index !== was) nav.moved?.(h.index);
  if (!press) return false;
  if (dom) items[h.index].click(); else nav.confirm(h.index);
  return true;
}

/**
 * The DOM controls of a nav root, cached on the handle. Re-read (getClientRects = a forced layout) only when asked (a move / confirm), when the root
 * element changed, when a cached control left the page, or when the subtree changed (a MutationObserver flags it: rows added, a control disabled
 * or hidden). An idle open menu is then free per frame.
 */
function domItems(h, root, force) {
  let c = h.navCache;
  if (!c || c.root !== root) {
    forgetNav(h);
    c = h.navCache = { root, items: null, dirty: true, obs: null, marked: null };
    if (root && typeof MutationObserver === 'function') {
      c.obs = new MutationObserver(() => { c.dirty = true; });
      c.obs.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'type', 'style', 'data-nav'] });
    }
  }
  if (force || c.dirty || !c.items || c.items.some(el => !el.isConnected)) { c.items = navItems(root); c.dirty = false; }
  return c.items;
}

/** Move the is-cursor class only when the selected control changes (a class write every frame dirties style for nothing) */
function markCursor(h, el) {
  const c = h.navCache;
  if (c.marked === el && el.classList.contains('is-cursor')) return;
  c.marked?.classList.remove('is-cursor');
  for (const x of c.items) if (x !== el) x.classList.remove('is-cursor');
  el.classList.add('is-cursor');
  c.marked = el;
}

/** Drop a handle's cached nav list (setNav / remove), so its observer stops @internal */
export function forgetNav(h) {
  h.navCache?.obs?.disconnect();
  h.navCache = null;
}
