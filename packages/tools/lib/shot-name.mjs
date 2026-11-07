// File name and place of a `threedog shot` picture (shot.mjs): page, query and options joined with '_', only letters, digits and _,.- kept.
// Never starts with '-' (or '.'): a name like "-grain-0_view-ref.png" reads as an option to every CLI it is handed to (picture compare, rm, git),
// which is how a page with only query parameters (/?grain=0&view=ref) used to come out. The page part is 'main' when the path is just '/'.
import { join, resolve } from 'node:path';

/** @param {string} url page path with optional query @param {Record<string, any>} opt shot options @param {number} wait @returns {string} */
export function shotName(url, opt, wait) {
  const [path, query = ''] = url.split('?');
  const page = path.replace(/^\/+/, '').replace(/\.html$/, '') || 'main';
  return [page, query, opt.time && 't' + String(opt.time).replace(':', ''), opt.weather, opt.pos && 'pos' + opt.pos, opt.at && 'at-' + opt.at, opt.view && 'view-' + opt.view, 'w' + wait]
    .filter(Boolean).join('_').replace(/[^\p{L}\p{N}_,.-]+/gu, '-').replace(/^[-.]+/, '') || 'main';
}

/**
 * Where a shot is written. --out with a bare file name goes into <workspace>/.threedog/shots/ like a generated name (why: `--out day.png` used to
 * land in the game root and nearly got committed); a path with a directory (./x.png, out/x.png, absolute) is kept as given, against the current directory.
 * @param {string} dir workspace @param {string | undefined} out the --out value (.png added if missing) @param {string} generated shotName(...) @param {string} [stamp] --keep suffix
 */
export function shotFile(dir, out, generated, stamp = '') {
  if (!out) return join(dir, '.threedog', 'shots', `${generated}${stamp}.png`);
  const f = String(out).replace(/(\.png)?$/i, stamp + '.png');
  return /[\\/]/.test(f) ? resolve(f) : join(dir, '.threedog', 'shots', f);
}

/**
 * The --size value of shot / capture as [width, height] (default 960x540). Why it throws: '1280X720' or '1280' split into NaN, and the browser
 * then failed on the viewport with a message that named neither the option nor the form.
 * @param {string | undefined} size @returns {[number, number]}
 */
export function viewSize(size) {
  const m = /^(\d+)[xX](\d+)$/.exec(String(size ?? '960x540').trim());
  if (!m || !(+m[1] > 0 && +m[2] > 0)) throw new Error(`--size ${size}: give WxH in pixels, e.g. 1280x720`);
  return [+m[1], +m[2]];
}

/**
 * --cam x,y,z,targetX,targetY,targetZ[,fov]: a camera pose, in the form engine.views.define takes. Why: --view needs a view the game declared first, and judging a building from
 * outside (a facade, a roofline, a far backdrop) needs a camera that --pos (the player) cannot give. The page declares it as a throwaway view and shows it.
 * @param {string | boolean | undefined} cam @returns {{ position: number[], target: number[], fov?: number }}
 */
export function camPose(cam) {
  const n = cam === true || cam === undefined ? [] : String(cam).split(',').map(s => (s.trim() === '' ? NaN : Number(s)));
  if (![6, 7].includes(n.length) || !n.every(Number.isFinite)) throw new Error(`--cam ${cam === true ? '' : cam}: give x,y,z,targetX,targetY,targetZ[,fov] as numbers (meters, fov in degrees), e.g. --cam 0,20,-300,0,15,-500,50`);
  return { position: n.slice(0, 3), target: n.slice(3, 6), ...(n.length === 7 && { fov: n[6] }) };
}

const samePath = (a, b) => { const n = p => resolve(p).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase(); return n(a) === n(b); };
/**
 * Before `shot <url>` trusts a page on this machine: is that server this game's? A leftover dev server on 5173 was another game, and the shot
 * and its picture check went through on the wrong picture. The bridge names its folder (/__threedog/root).
 * Five seconds to answer: a dev server still compiling on a busy machine took over two, and "could not tell" then hid a wrong server.
 * @param {string} url @param {string} dir the workspace of this command @param {typeof fetch} [get]
 * @returns {Promise<{ wrong?: string, unknown?: string }>} wrong: refuse the shot; unknown: could not tell, say so
 */
export async function wrongServer(url, dir, get = fetch) {
  const u = new URL(url);
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return {};
  let root = null;
  try { const r = await get(u.origin + '/__threedog/root', { signal: AbortSignal.timeout(5000) }); if (r.ok) ({ root } = await r.json()); } catch { /* no answer: unknown below */ }
  if (!root) return { unknown: `${u.origin} does not say which game it serves (no threedog dev bridge, or an older one): check the picture is the right game` };
  return samePath(root, dir) ? {} : { wrong: `${u.origin} serves ${root}, not ${dir}. A leftover dev server on that port? Stop it, or run this in that game's folder` };
}
