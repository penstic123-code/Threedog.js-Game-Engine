// shots.json: the list of "points" (named screenshot spots) a game keeps beside its code; the hub shoots every point and shows them as a wall.
// Why a strict parser: the file is written by an AI (or by hand) while the hub watches it, so a half-saved or misspelled file must become a readable
// message (which point, which key), never a crash and never a silently different picture.
import { camPose, viewSize } from '../lib/shot-name.mjs';

const KEYS = ['name', 'page', 'view', 'cam', 'pos', 'at', 'play', 'time', 'weather', 'wait', 'size'];
/** A cam given as an array is joined the way `--cam x,y,z,tx,ty,tz[,fov]` is typed, so one validator (camPose) reads both forms */
const joined = v => (Array.isArray(v) ? v.join(',') : v);

/** The problem with one point, or null. Same conflicts `threedog shot` refuses. */
function pointProblem(p, seen) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'a point is an object like { "name": "start" }';
  if (typeof p.name !== 'string' || !p.name.trim()) return 'name is required (a non-empty string)';
  if (seen.has(p.name)) return `name "${p.name}" is used twice`;
  const unknown = Object.keys(p).find(k => !KEYS.includes(k));
  if (unknown) return `unknown key "${unknown}" (allowed: ${KEYS.join(', ')})`;
  if (p.view !== undefined && p.cam !== undefined) return 'view and cam both place the camera: use one';
  try {
    if (p.cam !== undefined) camPose(joined(p.cam));
    if (p.size !== undefined) viewSize(p.size);
  } catch (e) { return e.message.replace(/^--/, ''); }
  if (p.wait !== undefined && !(Number.isFinite(p.wait) && p.wait >= 0)) return 'wait is a number of seconds';
  return null;
}

/**
 * @param {string | null} text  the file text; null = no file
 * @returns {{ points: object[], error: string | null, pointErrors: { index: number, name?: string, message: string }[], missing?: true }}
 */
export function parsePoints(text) {
  if (text === null) return { points: [{ name: 'default' }], error: null, pointErrors: [], missing: true };
  let list;
  try { list = JSON.parse(text); } catch (e) { return { points: [], error: `shots.json is not valid JSON (${e.message})`, pointErrors: [] }; }
  if (!Array.isArray(list)) return { points: [], error: 'shots.json must be an array of points: [{ "name": "start" }]', pointErrors: [] };
  const points = [], pointErrors = [], seen = new Set();
  list.forEach((p, index) => {
    const message = pointProblem(p, seen);
    if (message) pointErrors.push({ index, ...(typeof p?.name === 'string' && { name: p.name }), message });
    else { seen.add(p.name); points.push(p); }
  });
  return { points, error: null, pointErrors };
}

/** The URL keys `threedog shot` sets for these options (shot.mjs builds the same query), so a point is the same picture as the same shot command */
export function pointQuery(p) {
  const q = new URLSearchParams({ 'threedog-tier': 'high' });
  for (const k of ['time', 'weather', 'at', 'view']) if (p[k]) q.set(k, p[k]);
  if (p.pos) q.set('pos', joined(p.pos));
  if (p.cam !== undefined) q.set('view', joined(p.cam));
  q.set('wait', String(p.wait ?? 1));
  q.set('cutscene', 'skip');
  if (p.play) q.set('play', '');
  return q;
}

/** A file stem that is safe on every file system and keeps letters of any language */
export const pointFile = name => name.replace(/[^\p{L}\p{N}_-]/gu, '-');
