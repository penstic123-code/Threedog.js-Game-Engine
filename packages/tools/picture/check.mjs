// The picture check printed after every `threedog shot` and `threedog snap` (pagePicture), and on a saved picture by `threedog shot --image` (imagePicture,
// pixel facts only): numbers from the pixels plus hints of four kinds only.
//   mistake:       settings proven wrong together whatever the game wants (baked light plus the fill it baked): the engine's own combination
//                  checks (core/inspect/pictureChecks.js, also in describe().render), printed first; its notes come in as facts.
//   contradiction: a setting says X, the pixels show not-X (shadows on but none measurable, a light that changes no pixel). Style-independent.
//   fact:          something measured that may or may not be wanted, with its cost: glare, large clipped or near-black areas, a night that is not
//                  dark from lighting (time-flat), the key / fill balance. A game may want blinding light, deep black or a bright night, so each is
//                  a contradiction only where DESIGN.md declares the opposite (readIntent: no-glare, no-pitch-black, dark-nights, strong-light).
//   intent:        the numbers clearly disagree with what the game itself declared (DESIGN.md "Picture intent" line, or --ref).
//                  No declaration and no reference -> numbers only, no judgement.
// Every hint states the fact and the likely cause as a parameter name with its current value, never a target value: the thresholds only
// decide whether a fact is worth a line, they are not printed as goals. Nothing here fails a check or changes the game.
// The parts: numbers.mjs (pixels), intent.mjs (DESIGN.md), hints*.mjs (what is said), format.mjs (how it prints), probe*.mjs (what runs in the page).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pictureNumbers, shadowEdges, PROBE_W, HOT } from './numbers.mjs';
import { readIntent } from './intent.mjs';
import { pictureHints } from './hints.mjs';
import { formatPicture } from './format.mjs';
import { probeSource } from './probe.mjs';

export { pictureNumbers, shadowEdges, readIntent, pictureHints, formatPicture, probeSource };

/** The declared intent of the game at dir (its DESIGN.md), [] without one */
function designIntent(dir) {
  const f = join(dir, 'DESIGN.md');
  return existsSync(f) ? readIntent(readFileSync(f, 'utf8')) : [];
}

/**
 * The picture check on a live page, for every way a picture of the running game is taken: `threedog shot` (its own headless page) and `threedog snap`
 * (the dev bridge's page). Why one function: the demos bypassed the check by screenshotting another way; the check must be the same wherever it runs.
 * evaluate(src, arg) runs function source in the page (Playwright page.evaluate and the dev bridge driver both take a function string).
 * → { numbers, probe, intent, hints } or { error } when the canvas could not be read (the picture still stands)
 */
export async function pagePicture(evaluate, { dir, time = 'auto', ref = null } = {}) {
  const probe = await evaluate(`([src, o]) => (0, eval)('(' + src + ')')(window.engine, o)`, [probeSource, { time, hot: HOT }]);
  if (!probe?.pixels) return { error: probe?.error ?? 'no pixels read' };
  const numbers = pictureNumbers(Buffer.from(probe.pixels.b64, 'base64'), probe.pixels.w);
  delete probe.pixels;
  const intent = dir ? designIntent(dir) : [];
  return { numbers, probe, intent, hints: pictureHints({ numbers, probe, intent, isDay: probe.isDay, ref }) };
}

/** What the live-page probes add, said under a check that had no page (a saved picture) */
export const NO_PAGE = '  (a saved picture: only pixel facts. Which light / material blows out, shadows, noon / midnight need the running page: threedog shot or threedog snap)';

/**
 * The pixel-only part of the picture check on a saved picture (any screenshot, however it was taken): luminance, contrast, saturation, clipped /
 * near-black share, near-white spots, and the intent words of DESIGN.md. Read at the probe's width so spots and shares match a shot's numbers.
 */
export async function imagePicture(file, { dir, ref = null } = {}) {
  const { openImage } = await import('./pixels.mjs'), img = await openImage(file);
  const w = Math.min(PROBE_W, img.width), size = [w, Math.max(1, Math.round(w * img.height / img.width))];
  let px; try { px = await img.read(undefined, { size }); } finally { await img.close(); }
  const numbers = pictureNumbers(px.data, px.w), intent = dir ? designIntent(dir) : [];
  return { numbers, size: [img.width, img.height], intent, hints: pictureHints({ numbers, intent, ref }) };
}
