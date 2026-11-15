// Open a game page the way `threedog shot` does and wait until it is ready to be photographed: the one copy shared by shot.mjs and the hub's wall.
// Why one copy: a second "open and wait" would drift (a missed loading wait gave half-built pictures once), and the hub's pictures must equal `shot`'s.
import { headlessUrl } from './page-url.mjs';
import { waitEngine, waitLoaded, refuseState } from '../wait-engine.mjs';

/** The URL keys that set the scene: if the page refuses one the picture would show something else, so refuseState fails on them */
const SCENE_KEYS = ['time', 'weather', 'pos', 'at', 'view'];

/**
 * goto → engine up (state applied) → refuse a scene key the page did not take → wait for loading and the game's code after start() → UI settled
 * @param {import('playwright').Page} page @param {string} base server origin ('' for a full URL in `url`) @param {string} url page path
 * @param {URLSearchParams} q  engine URL parameters  @param {{ errors: string[], loadTimeout?: number }} o  loadTimeout in seconds
 * @returns {Promise<{ tail: object }>} how long the game's code after start() kept changing the scene (waitLoaded)
 */
export async function openShotPage(page, base, url, q, { errors, loadTimeout = 120 }) {
  await page.goto(base + headlessUrl(url, q));
  await waitEngine(page, { timeout: 60000, errors });
  await refuseState(page, SCENE_KEYS.filter(k => q.has(k)));
  // A picture taken while terrain / models are still arriving shows a half-built world that looks like an art bug, so finish loading first.
  // Headless only advances on step, so step (no render) until engine.loading says nothing is pending; past the limit fail with what it is still waiting for
  // then the game's own code after `await engine.start()` (lamps added after a later await): a shot never shows the scene before it ran
  const { tail } = await waitLoaded(page, { timeout: loadTimeout * 1000 });
  await page.evaluate(() => engine.ui.settled());   // the loading screen fades out on a wall-clock timer after ready; do not capture it mid-fade
  return { tail };
}
