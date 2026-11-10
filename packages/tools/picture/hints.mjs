// The hints of the picture check, from the screenshot numbers, the page probe and the declared intent. pictureHints runs every hint in HINTS, in this
// order; each adds its lines with h.add. The kinds and their rules: the header of check.mjs.
import { list } from './hint-text.mjs';
import { readEdgeMask, cascadeWayOf, shadowInvisible, shadowBlack, shadowEdgeHints } from './hints-shadow.mjs';
import { timeFlat, lightNoEffect, clipped, glare, overBudget, lightBalance } from './hints-light.mjs';
import { cameraInside, blackFrame, farClip, fogCover, shaderFacts, lightLayout, transparentOrder, crushed, unknownIntentWords } from './hints-scene.mjs';

const LEVERS = {
  luminance: ['exposure', 'sun', 'hemi', 'env'],
  contrast: ['sun', 'hemi', 'env', 'shadowIntensity', 'fog'],
  saturation: ['fog', 'post'],
};
const levers = (P, k) => list(LEVERS[k].map(n => P[n])) + (k === 'saturation' ? (P.post || P.fog ? ', ' : '') + 'the material / palette colors in picture/ (style/ in an older game)' : '');

/** Intent: declared words, checked only where the numbers clearly disagree */
function designWords({ N, P, intent, isDay, add }) {
  const CHECK = {
    bright: [N.luminance < 0.3, 'luminance', 'mean luminance', N.luminance], dark: [N.luminance > 0.5, 'luminance', 'mean luminance', N.luminance],
    highContrast: [N.contrast < 0.12, 'contrast', 'contrast (std of luminance)', N.contrast], lowContrast: [N.contrast > 0.24, 'contrast', 'contrast (std of luminance)', N.contrast],
    saturated: [N.saturation < 0.2, 'saturation', 'mean saturation', N.saturation], muted: [N.saturation > 0.45, 'saturation', 'mean saturation', N.saturation],
  };
  const seen = new Set();
  for (const a of intent) {
    if (a.when && (isDay == null || (a.when === 'day') !== isDay)) continue;   // "dark nights" says nothing about a noon shot, nor about a game with no sky (day or night unknown)
    if (!CHECK[a.want]) continue;   // noGlare is judged with the glare (hints-light.mjs)
    const [off, k, what, v] = CHECK[a.want];
    if (!off || seen.has(a.want)) continue;
    seen.add(a.want);
    add('intent', `design-${a.want}`, `differs from DESIGN.md: you wrote '${a.clause}' (${a.row}), measured ${what} ${v}; levers: ${levers(P, k)}.`, 0.5);
  }
}

/** A reference picture (--ref): each dimension that clearly differs */
function referenceDiff({ P, ref, add }) {
  if (!ref?.diff) return;
  const d = ref.diff, R = ref.reference, S = ref.screenshot;
  const dims = [['brightness', 'luminance', 0.25], ['contrast', 'contrast', 0.3], ['saturation', 'saturation', 0.3]];
  for (const [k, lk, lim] of dims) if (Math.abs(d[k].relative) >= lim)
    add('intent', `ref-${k}`, `differs from the reference ${R.file}: ${k} ${R[k]} there, ${S[k]} here (${d[k].relative > 0 ? '+' : ''}${Math.round(d[k].relative * 100)}%); levers: ${levers(P, lk)}.`, Math.abs(d[k].relative));
}

/** The engine's combination checks, as they came from the page (probe-setup.mjs): judged there, never again here */
function combination({ probe, add }) {
  for (const c of probe?.checks ?? []) add(c.kind === 'mistake' ? 'mistake' : 'fact', c.id, c.text, 1);   // a note is a fact: likely, not proven
}

const HINTS = [combination, shadowInvisible, timeFlat, lightNoEffect, clipped, glare, shadowBlack, shadowEdgeHints, overBudget, lightBalance, cameraInside, blackFrame,
  farClip, fogCover, shaderFacts, lightLayout, transparentOrder, crushed, unknownIntentWords, designWords, referenceDiff];

/**
 * Hints from the screenshot numbers, the page probe (probe.mjs) and the declared intent.
 * @param {{ numbers: any, probe?: any, intent?: any[], isDay?: boolean | null, ref?: any }} o ref: a compareImages result
 * @returns {{ kind: 'mistake' | 'contradiction' | 'fact' | 'intent', id: string, text: string }[]}
 */
export function pictureHints({ numbers: N, probe, intent = [], isDay = null, ref = null }) {
  const out = [], sh = probe?.shadows, add = (kind, id, text, size = 0, brief) => out.push({ kind, id, text, size, ...(brief && { brief }) });
  // size: the measured share of the picture (or of its brightness) the hint is about; formatPicture ranks by it and prints `brief` (one sentence:
  // measured -> source -> value), --json keeps the full `text`
  readEdgeMask(sh);
  const h = { N, probe, P: probe?.params ?? {}, sh, cascadeWay: cascadeWayOf(sh), intent, isDay, ref, add };
  for (const hint of HINTS) hint(h);
  return out;
}
