// Device tier: tool pages' forced tier, render scale per tier. Detection is render/backend.js tier() (the GPU name is read per renderer).
//
// Headless tool pages (shot, gallery, capture) pass ?threedog-tier=high|low. Why: the headless browser reports SwiftShader or the machine's
// integrated GPU, so detection called every tool page "low" and costly post (ao, bloom) silently dropped out of the picture, which then did not
// show the game's picture. The tool says which tier it rendered at; tests pass nothing and keep their detected (deterministic) tier.
const TIERS = ['low', 'high'];

/** The tier a headless tool page asks for (?threedog-tier=low|high), or null (the tools check the value: shot --tier fails on anything else). */
export function forcedTier(search = typeof location === 'undefined' ? '' : location.search) {
  const t = new URLSearchParams(search).get('threedog-tier');
  return TIERS.includes(t) ? t : null;
}

/** @type {WeakMap<any, Set<() => void>>} per engine: the parts that rebuild when engine.tier changes */
const FOLLOWERS = new WeakMap();
/**
 * Follow engine.tier while running: fn runs once after every change (a preset, the device found at start). Why one notice: the post chain followed
 * the tier and the cascades read it only when made, so a preset changed one and not the other (GPT review l2-render 2). Pixel ratio does not follow
 * here: a settings preset writes its own ratio, and a second writer would undo the player's. @param {any} e @param {() => void} fn @returns {{ remove(): void }}
 */
export function onTierChange(e, fn) {
  if (!FOLLOWERS.has(e)) FOLLOWERS.set(e, new Set());
  FOLLOWERS.get(e).add(fn);
  return { remove: () => { FOLLOWERS.get(e)?.delete(fn); } };
}
/** The tier stack's onChange (core/engine/services.js) @param {any} e */
export function tierChanged(e) { for (const fn of [...(FOLLOWERS.get(e) ?? [])]) fn(); }

/** The name under engine.saves.storageKey of a player's MSAA choice */
export const MSAA_KEY = 'msaa';
/**
 * The player's MSAA choice for this game, or null. Read in createEngine before the renderer, and so before saves exist: the key is storageKey(MSAA_KEY) spelled from saveKey.
 * @param {string} saveKey @returns {boolean | null}
 */
export function storedMsaa(saveKey) {
  try { const v = localStorage.getItem(`${saveKey}-${MSAA_KEY}`); return v == null ? null : v === '1'; } catch { return null; }
}

/**
 * Default render scale. High tier: the display scale up to 1.5. Low tier: at least 0.75 x display scale (1.5 on a 2x screen; a fixed 1 there
 * would be an upscaled blurry picture), never above 1.5 or the display scale.
 * @param {number} dpr @param {string} tier
 */
export function defaultPixelRatio(dpr, tier) {
  const cap = Math.min(dpr, 1.5);
  return tier === 'low' ? Math.min(cap, Math.max(1, +(0.75 * dpr).toFixed(2))) : cap;
}
