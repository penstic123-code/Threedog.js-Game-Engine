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
  // One deadline for the whole opening: each step gets what is left, so --load-timeout means "this long to be ready", not "this long per step"
  // (it used to cover only the last step, after goto's 30 s and waitEngine's fixed 60 s, and a slow --play --pos start timed out in the middle one)
  const end = Date.now() + loadTimeout * 1000, left = () => Math.max(1, end - Date.now());
  const step = async (name, run) => {
    try { return await run(); }
    catch (e) { e.message += `
  stuck at: ${name} (the whole opening gets ${loadTimeout} s; a slow page: raise --load-timeout)`; throw e; }
  };
  // domcontentloaded: the game's module scripts have run by then, and waitEngine waits for the engine itself
  await step('loading the page', () => page.goto(base + headlessUrl(url, q), { waitUntil: 'domcontentloaded', timeout: left() }));
  await step('waiting for the engine', () => waitEngine(page, { timeout: left(), grace: left(), errors }));
  await refuseState(page, SCENE_KEYS.filter(k => q.has(k)));
  // A picture taken while terrain / models are still arriving shows a half-built world that looks like an art bug, so finish loading first.
  // Headless only advances on step, so step (no render) until engine.loading says nothing is pending; past the limit fail with what it is still waiting for
  // then the game's own code after `await engine.start()` (lamps added after a later await): a shot never shows the scene before it ran
  const { tail } = await step('waiting for loading to finish', () => waitLoaded(page, { timeout: left() }));
  if (q.has('view')) await step('checking the requested view held', () => refuseMovedCamera(page));
  await settleUi(page);
  return { tail };
}

/** The loading screen fades out on a wall-clock timer after ready: wait for it, so nothing is read or captured mid-fade (shot, the hub and tests of a point) */
export const settleUi = page => page.evaluate(() => engine.ui.settled());

/**
 * --cam / --view put the camera on a pose and the engine registers it as owned ('views-camera', core/scene/Views.js); game code that writes the camera on its own
 * (a follow camera that ignores engine.cameraOverride) moves it away and the engine yields. The picture would then show the game's camera, not the one asked for.
 * The engine notices a write on the frame after it, and waitLoaded may not have stepped at all (loading already done), so two frames are stepped here first.
 */
async function refuseMovedCamera(page) {
  const writer = await page.evaluate(() => {
    for (let i = 0; i < 2; i++) engine.step(1 / 30, { render: false, describe: false });
    return engine.describe().owned?.['views-camera']?.writer;
  });
  if (writer?.includes('yielded')) throw new Error("the game's camera code moved the camera away from the requested view; make it step aside while engine.cameraOverride is set (recipe 21)");
}
