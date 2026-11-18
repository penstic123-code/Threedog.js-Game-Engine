// shots.json: the list of "points" (named screenshot spots) a game keeps beside its code; the hub shoots every point and shows them as a wall.
// Why a strict parser: the file is written by an AI (or by hand) while the hub watches it, so a half-saved or misspelled file must become a readable
// message (which point, which key), never a crash and never a silently different picture.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { camPose, viewSize } from '../lib/shot-name.mjs';
import { closest } from '../lib/text.mjs';

const KEYS = ['name', 'page', 'view', 'cam', 'pos', 'at', 'play', 'time', 'weather', 'wait', 'size'];
/** A cam given as an array is joined the way `--cam x,y,z,tx,ty,tz[,fov]` is typed, so one validator (camPose) reads both forms */
export const joined = v => (Array.isArray(v) ? v.join(',') : v);

/** The problem with one point, or null. Same conflicts `threedog shot` refuses. */
function pointProblem(p, seen) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'a point is an object like { "name": "start" }';
  if (typeof p.name !== 'string' || !p.name.trim()) return 'name is required (a non-empty string)';
  if (seen.has(p.name)) return `name "${p.name}" is used twice`;
  // two names that give one picture file would overwrite each other on the wall (case-insensitive file systems, "a b" and "a-b")
  const same = [...seen.keys()].find(n => pointFile(n).toLowerCase() === pointFile(p.name).toLowerCase());
  if (same) return `name "${p.name}" and "${same}" would share one picture file: rename one`;
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
  try { list = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { return { points: [], error: `shots.json is not valid JSON (${e.message})`, pointErrors: [] }; }
  if (!Array.isArray(list)) return { points: [], error: 'shots.json must be an array of points: [{ "name": "start" }]', pointErrors: [] };
  const points = [], pointErrors = [], seen = new Map();
  list.forEach((p, index) => {
    const message = pointProblem(p, seen);
    if (message) pointErrors.push({ index, ...(typeof p?.name === 'string' && { name: p.name }), message });
    else { seen.set(p.name, true); points.push(p); }
  });
  return { points, error: null, pointErrors };
}

/**
 * The URL keys of one shot, from shot's options (a point's fields have the same names): the one place options become parameters, so a point and
 * `threedog shot` with the same options are the same picture. Arrays (a cam or pos typed as JSON) are joined the way the command line types them.
 * @param {Record<string, any>} o time, weather, pos, at, view, cam, wait (seconds), play
 * @param {{ tier?: string, keepCutscene?: boolean }} [x]
 */
export function shotQuery(o, { tier = 'high', keepCutscene = false } = {}) {
  const q = new URLSearchParams({ 'threedog-tier': tier });
  for (const k of ['time', 'weather', 'at', 'view']) if (o[k] !== undefined && o[k] !== '') q.set(k, o[k]);
  if (o.pos !== undefined && o.pos !== '') q.set('pos', joined(o.pos));
  if (o.cam !== undefined) q.set('view', joined(o.cam));   // a pose goes the way a view name does (?view=x,y,z,tx,ty,tz[,fov])
  q.set('wait', String(o.wait ?? 1));
  q.set('cutscene', keepCutscene ? 'keep' : 'skip');
  if (o.play) q.set('play', '');
  return q;
}

/** The URL keys a point sets (the hub shoots with these) */
export const pointQuery = p => shotQuery(p);

/** A page given as a bare name is the page of that name (`styletest` -> `/styletest.html`): the one reading of a `page`, for shot, the hub and tests */
export const namedPage = page => (/^[\p{L}\p{N}_-]+$/u.test(page) ? `/${page}.html` : page);

/** The page address of a point with its keys in the query (a `page` that already has a query keeps it): what a test opens to see the point as the hub does */
export const pointUrl = p => { const page = namedPage(p.page ?? '/'); return `${page}${page.includes('?') ? '&' : '?'}${pointQuery(p)}`; };

/** The game's shots.json read once: parsePoints of the file (no file: only `default`) */
export const readPoints = dir => { const file = join(dir, 'shots.json'); return parsePoints(existsSync(file) ? readFileSync(file, 'utf8') : null); };

/**
 * The point `name` of the game's shots.json (no file: only `default`, the plain page). An unknown name fails naming the closest one.
 * @returns {object} the point as written in the file
 */
export function findPoint(dir, name) {
  const { points, error } = readPoints(dir);
  if (error) throw new Error(error);
  const hit = points.find(p => p.name === name);
  if (hit) return hit;
  const near = closest(name, points.map(p => p.name));
  throw new Error(`no point "${name}" in shots.json${near ? ` (did you mean "${near}"?)` : ''}. Points: ${points.map(p => p.name).join(', ') || 'none'}`);
}

/** A file stem that is safe on every file system and keeps letters of any language */
export const pointFile = name => name.replace(/[^\p{L}\p{N}_-]/gu, '-');
