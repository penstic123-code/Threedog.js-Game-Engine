// The renderer's pixel ratio has one owner, this file: every engine write goes through it, so no two entries fight by "who wrote last". Two modes:
//   ratio      (the default) the shared value render.pixelRatio is the ceiling: base the tier's default, the game's engine.setPixelRatio, the player's settings
//              choice capping it (so their order never matters). Adaptive resolution writes under it, a photo borrows a ratio; writeRatio is the one write.
//   pixelSize  (createEngine({ pixelSize }), engine.setPixelSize) one art pixel is k real screen pixels: the ratio is devicePixelRatio / k and fitPixelSize
//              alone sets the drawing buffer. Everything else asking for a ratio is held off, refused or kept for later: adaptive stops (engine.adaptive.on
//              reads false), the ceiling only updates what comes back when pixelSize ends, a photo keeps the art pixels, engine.setPixelRatio throws.
// A direct renderer.setPixelRatio by the game is not refused (hard rule 4): the engine yields in both modes (view.pixelRatio in core/ops/owned.js).
// tests/specs/pixel-size.mjs guards that no other file calls renderer.setPixelRatio.
import { DEV, warnOnce } from '../base/validate.js';
import { coded, codedError } from '../base/errorHints.js';
import { ownMsaa } from '../../render/backend.js';
import { defaultPixelRatio } from './tier.js';

const dpr = () => devicePixelRatio || 1;

/** Does pixelSize decide the ratio now: for modules whose rows or tools would otherwise ask for one @param {any} e */
export const pixelSizeOn = e => e._pixelSize != null;

/** The ratio a renderer starts with, before the engine's owned rows exist @param {any} r @param {string} tier @param {number} [pixelRatio] */
export function firstRatio(r, tier, pixelRatio) { r.setPixelRatio(pixelRatio ?? defaultPixelRatio(dpr(), tier)); }

/**
 * The one write in ratio mode; re-reading it after keeps this from counting as an outside write. Skips an equal value because three's setPixelRatio resizes
 * the canvas, which clears the drawing buffer. Does nothing under pixelSize, so a caller that missed the mode still cannot move the art pixels.
 * @param {any} e @param {number} p
 */
export function writeRatio(e, p) {
  if (e._pixelSize != null) return;
  if (Math.abs(e.renderer.getPixelRatio() - p) > 0.001) e.renderer.setPixelRatio(p);
  e._oPixelRatio.mark();
}

/** The ceiling at its top again: adaptive resolution starts over from it (the ceiling moved, or the player turned adaptive off) @param {any} e */
export function topRatio(e) {
  if (e._pixelSize != null) return;
  writeRatio(e, e.adaptive.max);
  Object.assign(e.adaptive, { lowered: false, from: null, good: 0 });
}

/** render.pixelRatio, made with engine.adaptive: its max follows the value (under pixelSize only that, for when pixelSize ends) @param {any} e */
export function defineRatio(e) {
  const point = e.stacks.define('render.pixelRatio', { base: e.renderer.getPixelRatio(), save: false,
    manual: "the settings entry is the player's ceiling: the game's ratio stays under it while the player keeps that choice" });
  point.watch(() => { e.adaptive.max = point.value(); topRatio(e); });
}

/** engine.setPixelRatio, a game-layer set: written even when the game took the ratio (the named entry stays where the raw three.js call is) @param {any} e @param {number} p */
export function askRatio(e, p) {
  if (e._pixelSize != null) throw codedError('pixel-conflict', `engine.setPixelRatio(${p}): pixelSize ${e._pixelSize} decides the ratio now. Keep pixelSize and drop this call, or call engine.setPixelSize(null) first`);
  e.stacks.get('render.pixelRatio').take({ owner: 'game', set: p });
}

/**
 * The player's settings choice; null hands the ratio back to the game (settings.reset). It stands in for the device default (engine layer: the player may
 * pick above it). Under the default it is also a ceiling on the game (settings layer, which only restricts); at or above it (a 'high' preset is a share of 1)
 * it limits nothing, so a full-quality choice never pulls the game's higher ratio down. Two entries, so their order does not change the result.
 * @param {any} e @param {number | null} p
 */
export function chooseRatio(e, p) {
  const point = e.stacks.get('render.pixelRatio');
  if (p == null || p >= e.adaptive.base) point.release('settings');
  else point.take({ owner: 'settings', layer: 'settings', clamp: { max: p } });
  if (p == null) point.release('settings.default');
  else point.take({ owner: 'settings.default', layer: 'engine', set: p });
}

/**
 * The device became known in start(): its default is the new base (the entries stay on top), unless the game chose one at creation or owns the renderer.
 * engine.adaptive.base is only a mirror of that base, kept for readers (the settings presets' shares). @param {any} e @param {string} tier
 */
export function tierRatio(e, tier) {
  if (!e._ownsRenderer || e._createParams.pixelRatio != null) return;
  const p = defaultPixelRatio(dpr(), tier);
  e.stacks.get('render.pixelRatio').setBase(p);
  e.adaptive.base = p;
}

/**
 * Hand the size and ratio to a renderer that replaces this one, exactly as they were: a recomputed size would move the art pixels.
 * @param {any} from @param {any} to @param {any} size a THREE.Vector2 to read into
 */
export function carryRatio(from, to, size) { from.getSize(size); to.setDrawingBufferSize(size.x, size.y, from.getPixelRatio()); }

/**
 * A ratio for one synchronous draw (a photo at a higher resolution). Returns the call that puts the ratio back. check() first: an outside write not noticed
 * yet would otherwise be marked as the engine's on the way back. Under pixelSize the ratio stays, because a finer buffer draws a picture without the art
 * pixels the game chose.
 * @param {any} e @param {number} p @returns {() => void}
 */
export function borrowRatio(e, p) {
  if (e._pixelSize != null) return () => {};
  e._oPixelRatio.check();
  const back = e.renderer.getPixelRatio();
  writeRatio(e, p);
  return () => writeRatio(e, back);
}

/** Note the canvas's size in real screen pixels from a ResizeObserver entry; browsers without devicePixelContentBoxSize leave it unknown @param {any} e @param {ResizeObserverEntry} entry */
export function noteDeviceBox(e, entry) {
  const s = entry.devicePixelContentBoxSize?.[0];
  if (s) e._deviceBox = { w: s.inlineSize, h: s.blockSize };
}

/**
 * The canvas's box in real screen pixels, measured by the browser. CSS size times the ratio is only the fallback: at 150% the CSS size is already rounded, and
 * that error is what makes art pixels uneven. The measured box excludes the padding fitPixelSize added, so it is put back here. Device emulation (DevTools, Playwright's
 * deviceScaleFactor) reports the box unscaled, so a measure far from the CSS size is not used.
 * @param {any} e @param {number} w CSS width @param {number} h CSS height @param {number} s device pixel ratio
 */
function deviceBox(e, w, h, s) {
  const b = e._deviceBox, st = e.renderer.domElement.style;
  const dw = b && b.w + Math.round((parseFloat(st.paddingRight) || 0) * s), dh = b && b.h + Math.round((parseFloat(st.paddingBottom) || 0) * s);
  if (b && Math.abs(dw - w * s) <= s + 1 && Math.abs(dh - h * s) <= s + 1) return { w: dw, h: dh };
  return { w: Math.round(w * s), h: Math.round(h * s) };
}

const padCanvas = (st, right, bottom) => { st.paddingRight = right ? right + 'px' : ''; st.paddingBottom = bottom ? bottom + 'px' : ''; };
/** Take off what pixelSize put on the canvas: setPixelSize(null), and dispose, because the page may hand the same canvas to the next engine @param {any} e @param {any} st */
const plainCanvas = (e, st) => { padCanvas(st, 0, 0); Object.assign(st, e._pixelCss); };

/**
 * Resize under pixelSize. A whole number of art pixels rarely fills the canvas: stretching the buffer over the rest would make some art pixels wider, so the
 * last few real pixels (fewer than k) stay padding instead; the box the page laid out does not change. The renderer's size is the buffer in CSS units and the
 * small addition keeps three's floor(size * ratio) on the buffer size when the division comes out just under it.
 * @param {any} e @param {number} w CSS width @param {number} h CSS height @returns {boolean} false: not this mode, the plain resize applies
 */
export function fitPixelSize(e, w, h) {
  const k = e._pixelSize, r = e.renderer, c = r.domElement, o = e._oPixelRatio;
  if (k == null) return false;
  o.check();
  if (!o.on) { padCanvas(c.style, 0, 0); return false; }   // the game took the ratio (core/ops/owned.js): the canvas is a plain one again
  const s = dpr(), dev = deviceBox(e, w, h, s), bw = Math.max(1, Math.floor(dev.w / k)), bh = Math.max(1, Math.floor(dev.h / k)), pr = s / k;
  padCanvas(c.style, (dev.w - bw * k) / s, (dev.h - bh * k) / s);
  if (e._autoSize) { c.style.width = w + 'px'; c.style.height = h + 'px'; }
  if (c.width !== bw || c.height !== bh || r.getPixelRatio() !== pr) {
    r.setDrawingBufferSize((bw + 1e-7) / pr, (bh + 1e-7) / pr, pr);   // the post chain follows the renderer on its next draw (postWebGL.js follow)
    e._oAspect.drive(bw / bh);
  }
  o.mark();
  return true;
}

/**
 * A window moved to another display or a page zoom changes devicePixelRatio. A resolution query matches one value only, so each change registers the next
 * one. Armed once: a watch left from before setPixelSize(null) keeps its query, which is still the current value.
 * @param {any} e
 */
function watchDisplay(e) {
  if (e._displayWatch || typeof matchMedia !== 'function') return;
  e._displayWatch = true;
  matchMedia(`(resolution: ${dpr()}dppx)`).addEventListener('change', () => {
    e._displayWatch = false;
    if (e._pixelSize == null) return;
    watchDisplay(e);
    e._resize();
  }, { once: true, signal: e.signal });
}

/**
 * engine.setPixelSize. A direct renderer.setPixelRatio before this call is over: the call is the newer, named request. autoView.manual('pixelRatio') is a claim
 * on purpose, so it conflicts.
 * @param {any} e @param {number | null} k
 */
export function askPixelSize(e, k) {
  if (k !== null && !(Number.isInteger(k) && k > 0)) throw codedError('engine-misuse', `engine.setPixelSize(k): k is how many real screen pixels make one art pixel, a whole number from 1 up (null turns it off); got ${JSON.stringify(k)}`);
  const o = e._oPixelRatio, was = e._pixelSize, st = e.renderer.domElement.style;
  o.check();
  if (k === null) {
    if (was == null) return;
    e._pixelSize = null;
    plainCanvas(e, st);
    if (o.on) writeRatio(e, e.adaptive.max);   // a ratio the game took stays the game's, as in fitPixelSize
    e._resize();
    return;
  }
  if (o.mode === 'manual') throw codedError('pixel-conflict', `engine.setPixelSize(${k}): the game took the pixel ratio with engine.autoView.manual('pixelRatio'). Keep one: hand it back with engine.autoView.manual('pixelRatio', false), or drop this call`);
  if (o.mode === 'yielded') o.manual(false);
  if (was == null) {
    if (!e._pixelCss) e.signal.addEventListener('abort', () => plainCanvas(e, st), { once: true });
    e._pixelCss = { imageRendering: st.imageRendering, boxSizing: st.boxSizing };
    Object.assign(st, { imageRendering: 'pixelated', boxSizing: 'border-box' });   // border-box: the padding comes out of the box the page gave the canvas
    Object.assign(e.adaptive, { lowered: false, from: null, good: 0 });
  }
  e._pixelSize = k;
  // the canvas's MSAA is fixed when its context is made, so nothing here can switch it off
  if (DEV && (e.post.antialias || ownMsaa(e.renderer))) warnOnce(coded('pixel-conflict', `pixelSize ${k} with antialias on: the edges of art pixels come out blended. It can only be set at creation: createEngine({ antialias: false })`));
  watchDisplay(e);
  e._resize();
}
