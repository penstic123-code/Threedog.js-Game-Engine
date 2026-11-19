// The canvas's CSS box and the UI root laid over it (split out of Engine.js: all about "how big is the canvas on the page").
import * as THREE from 'three';
import { warnOnce } from '../base/validate.js';
import { fitPixelSize } from './pixelRatio.js';

const _size = new THREE.Vector2();
const NO_CSS_SIZE = 'createEngine(): the canvas has no CSS size of its own (it would take its size from its pixel buffer), so the engine sizes it to the window. '
  + 'To embed it in a page section, split layout or editor panel, give it a CSS size, e.g. canvas { width: 100%; height: 100%; display: block } inside a sized parent';
/**
 * The canvas's CSS box in CSS pixels (what the page layout gave it). The drawing buffer is this times the pixel ratio (setSize(w, h, false) leaves the CSS
 * alone).
 * Two cases fall back to the window: a canvas outside the page (headless tests often make one with createElement) has no box, so the aspect
 * is never 0 / 0; and a canvas without a CSS size (e.auto, see sizeMode) takes its box from its own buffer, which would grow by the pixel
 * ratio on every resize, so the engine sets its CSS size to the window instead (what such a page got before).
 */
export function canvasBox(e) {
  const c = e.renderer.domElement;
  if (c.isConnected && e._autoSize === undefined) sizeMode(e);
  const w = c.clientWidth, h = c.clientHeight;
  return !e._autoSize && w > 0 && h > 0 ? { w, h } : { w: innerWidth || 1, h: innerHeight || 1 };
}
/** Once, when the canvas is first in the page: does its CSS box follow its width / height attributes on both axes (no CSS size at all)? Then e._autoSize = true and the engine sizes it.
 *  The probe doubles both attributes (same aspect): a box that follows them on both axes doubles, which is the case that would grow by the pixel ratio.
 *  One CSS axis plus an auto one (width: 100%; height: auto, or aspect-ratio) only takes the attributes' aspect, which the engine keeps, so its box stays and is used */
function sizeMode(e) {
  const c = e.renderer.domElement, w0 = c.width, h0 = c.height, cw = c.clientWidth, ch = c.clientHeight;
  c.width = Math.max(1, w0) * 2; c.height = Math.max(1, h0) * 2;
  e._autoSize = c.clientWidth !== cw && c.clientHeight !== ch;
  c.width = w0; c.height = h0;
  if (e._autoSize) warnOnce(NO_CSS_SIZE);
  // canvas put in the page after createEngine
  if (e.uiRoot?.parentElement === document.body && c.parentElement && c.nextElementSibling !== e.uiRoot) c.after(e.uiRoot);
}
/**
 * Lay the UI root over the canvas box. Its children are position: fixed, and contain: layout makes the root their containing block,
 * so inset: 0 means "the canvas", not "the window". A fixed canvas gets a fixed root at its viewport rect; any other canvas an absolute root
 * at its offset position in the same offset parent, so the two scroll together.
 */
export function placeUI(e) {
  const c = e.renderer.domElement, s = e.uiRoot.style;
  if (!c.isConnected || !e.uiRoot.isConnected) return;
  const fixed = getComputedStyle(c).position === 'fixed', b = fixed ? c.getBoundingClientRect() : null;
  // set only once the root is placed: a root with contain but no box (canvas outside the page) would shrink every fixed child to 0 x 0.
  // pointer-events: the root itself lets clicks through to the canvas; its children take them again (theme.js :where rule)
  s.contain = 'layout'; s.pointerEvents = 'none';
  s.position = fixed ? 'fixed' : 'absolute';
  s.left = (fixed ? b.left + c.clientLeft : c.offsetLeft + c.clientLeft) + 'px';
  s.top = (fixed ? b.top + c.clientTop : c.offsetTop + c.clientTop) + 'px';
  s.width = c.clientWidth + 'px'; s.height = c.clientHeight + 'px';
}

/** Resize follow-up (mixed into Engine): re-read the canvas box, re-place the UI root, resize renderer / post / camera */
export const resizeMethods = {
  _resize() {
    const { w, h } = canvasBox(this);
    this._followed = { w, h };   // the box this resize answered: step() compares with it (_followBox)
    placeUI(this);
    if (fitPixelSize(this, w, h)) return;
    const now = this.renderer.getSize(_size);
    if (now.x === w && now.y === h) return;   // ResizeObserver and the window event can both fire for one change
    this.renderer.setSize(w, h, !!this._autoSize);   // the post chain follows the renderer on its next draw (postWebGL.js follow)
    this._oAspect.drive(w / h);
  },
  /** step() calls this first: a frozen or stepped page has no rAF frame or ResizeObserver callback to follow a viewport change, so the box is compared here (the same path as the events).
   *  Compared with the box the last resize answered, not the renderer size: with pixelSize the renderer is smaller than the box by design, and a
   *  renderer the game or a test sized itself (renderer.setSize) must not be put back to the box while nothing on the page changed */
  _followBox() {
    const { w, h } = canvasBox(this), last = this._followed;
    if (last && last.w === w && last.h === h) return;
    this._resize();
  },
};
