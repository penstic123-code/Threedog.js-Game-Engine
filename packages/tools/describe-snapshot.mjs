// describe() snapshots: a baseline of the game's state as JSON, compared later as readable text, instead of comparing screenshots.
// A baseline is the gameplay part of engine.describe() (perf and elapsed time are dropped; numbers compare within a tolerance), stored per name as
// <workspace>/tests/snapshots/<name>.describe.json and committed with the code.
//
// In a test (engine specs or a game's tests/specs/*.mjs); the page must already be in the state you want to freeze:
//   import { expectDescribe } from '@threedog/tools/describe-snapshot';
//   await ev(() => { engine.haltLoop(); engine.step(1); });
//   await expectDescribe({ check, ev }, 'market-noon', { only: ['player', 'quests', 'nearby'], tolerance: 0.5 });
// On the dev bridge:
//   threedog snap-describe save market-noon --only player,quests     (write / overwrite the baseline)
//   threedog snap-describe diff market-noon --only player,quests     (compare the running page with it)
// Update after an intended change: `threedog test <name> --update-snapshots`, or `threedog snap-describe save <name>`.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Paths dropped before saving / comparing: timing and performance numbers are not gameplay */
// warnings: the engine's dev diagnostics, they change when the engine adds one, not when the game does.
// loading: file versions and on-demand counts; picture.writers: how many frames each writer has run, which moves with every frame and says nothing about the game
const DEFAULT_IGNORE = ['perf', 'time.tick', 'time.real', 'time.ambient', 'loading', 'picture.writers', 'warnings'];
/** Also dropped when a command says what it changed: these move on their own in any step, and a list of them would bury the change */
const MOVES_ALONE = ['time', 'camera', 'nearby', 'actions', 'ops', 'holds', 'shared', 'input', 'picture', 'render', 'weather.progress'];
const MAX_LINES = 20;
const isObj = v => v !== null && typeof v === 'object';

const matches = (path, list) => list.some(p => path === p || path.startsWith(p + '.') || path.startsWith(p + '['));

/**
 * Copy of the describe object with only the gameplay fields.
 * @param {any} d result of engine.describe()
 * @param {{ only?: string[], ignore?: string[] }} [opts] only: keep these paths (top-level field or dotted path such as 'time.clock'); ignore: extra paths to drop
 */
export function pickGameplay(d, { only, ignore = [] } = {}) {
  const drop = [...DEFAULT_IGNORE, ...ignore];
  const walk = (v, path) => {
    if (matches(path, drop)) return undefined;
    if (!isObj(v)) return v;
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`));
    const out = {};
    for (const k of Object.keys(v).sort()) {
      const p = path ? `${path}.${k}` : k, r = walk(v[k], p);
      if (r !== undefined) out[k] = r;
    }
    return out;
  };
  const copy = JSON.parse(JSON.stringify(d));
  // ui.parts: only the ones the game replaced ('custom'); 'default' / 'off' are the engine's own list, which grows with the engine (hud.button, hud.hint…)
  if (isObj(copy.ui?.parts)) copy.ui.parts = Object.fromEntries(Object.entries(copy.ui.parts).filter(([, v]) => v === 'custom'));
  const all = walk(copy, '');
  if (!only?.length) return all;
  const out = {};
  for (const p of only) {
    let src = all, dst = out;
    const keys = p.split('.');
    for (let i = 0; i < keys.length; i++) {
      if (!isObj(src) || !(keys[i] in src)) { src = undefined; break; }
      if (i === keys.length - 1) { dst[keys[i]] = src[keys[i]]; break; }
      dst = dst[keys[i]] ??= {}; src = src[keys[i]];
    }
  }
  return out;
}

/** Key of an array item: its name / id when every item is an object with a unique one (so a reordered list is not a pile of changes), else the index */
function keysOf(arr) {
  for (const f of ['id', 'name']) {
    const ks = arr.map(x => isObj(x) && typeof x[f] === 'string' ? x[f] : null);
    if (ks.every(Boolean) && new Set(ks).size === ks.length) return ks;
  }
  return arr.map((_, i) => String(i));
}

const leaves = v => isObj(v) ? Object.values(v).reduce((n, x) => n + leaves(x), 0) : 1;
const short = v => { const s = JSON.stringify(v); return s.length > 70 ? s.slice(0, 67) + '...' : s; };

/**
 * Readable differences between a baseline and the current state (empty array = same).
 * @param {any} base baseline (from pickGameplay)
 * @param {any} cur current (from pickGameplay)
 * @param {{ tolerance?: number | Record<string, number> }} [opts] tolerance: absolute allowed difference for numbers; an object maps a path (or its prefix, e.g. 'player') to its own tolerance, 'default' for the rest. Default 0.5
 * @returns {string[]}
 */
export function diffDescribe(base, cur, { tolerance = 0.5 } = {}) {
  const tol = path => {
    if (matches(path, ['vars'])) return 0;   // story counters are whole facts: a tolerance would hide one bump
    if (typeof tolerance === 'number') return tolerance;
    let best = tolerance.default ?? 0.5, len = -1;
    for (const k in tolerance) if (k !== 'default' && matches(path, [k]) && k.length > len) { best = tolerance[k]; len = k.length; }
    return best;
  };
  const out = [];
  const walk = (a, b, path) => {
    if (typeof a === 'number' && typeof b === 'number') {
      const t = tol(path);
      if (!(Math.abs(a - b) <= t) && !(Number.isNaN(a) && Number.isNaN(b))) out.push(`${path}: ${a} -> ${b} (changed ${+(b - a).toFixed(3)}, tolerance ${t})`);
    } else if (Array.isArray(a) && Array.isArray(b)) {
      const ka = keysOf(a), kb = keysOf(b), byKey = (arr, ks) => new Map(ks.map((k, i) => [k, arr[i]]));
      const ma = byKey(a, ka), mb = byKey(b, kb);
      for (const k of new Set([...ka, ...kb])) {
        if (!mb.has(k)) out.push(`${path}[${k}]: removed ${short(ma.get(k))}`);
        else if (!ma.has(k)) out.push(`${path}[${k}]: added ${short(mb.get(k))}`);
        else walk(ma.get(k), mb.get(k), `${path}[${k}]`);
      }
    } else if (isObj(a) && isObj(b) && !Array.isArray(a) && !Array.isArray(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const p = path ? `${path}.${k}` : k;
        if (!(k in b)) out.push(`${p}: removed (was ${short(a[k])})`);
        else if (!(k in a)) out.push(`${p}: added ${short(b[k])}`);
        else walk(a[k], b[k], p);
      }
    } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${short(a)} -> ${short(b)}`);
  };
  walk(base, cur, '');
  return out;
}

/**
 * What changed between two describe() results, as one line: the answer of press and op, read from the same differ snapshots use.
 * @param {any} before
 * @param {any} after
 * @returns {string}
 */
export function changeLine(before, after) {
  const pick = d => pickGameplay(d, { ignore: MOVES_ALONE }), found = diffDescribe(pick(before), pick(after), { tolerance: 0.05 });
  if (!found.length) return 'Changed: nothing describe() shows';
  const shown = found.slice(0, 4).map(l => l.replace(/ \(changed .*\)$/, ''));
  return `Changed: ${shown.join('; ')}${found.length > 4 ? `; … ${found.length - 4} more (threedog describe --all)` : ''}`;
}

/** Baseline file path: <dir>/<name>.describe.json (dir is <workspace>/tests/snapshots) */
const snapshotFile = (dir, name) => join(dir, `${String(name).replace(/[^\w一-龥.-]+/g, '-')}.describe.json`);

/** Where tests keep baselines: the test runner sets THREEDOG_SNAP_DIR to the running workspace's tests/snapshots */
const defaultSnapDir = () => process.env.THREEDOG_SNAP_DIR || join(process.cwd(), 'tests', 'snapshots');

/**
 * Write the baseline from a describe() result.
 * @param {string} dir snapshot directory
 * @param {string} name scenario name
 * @param {any} d result of engine.describe()
 * @param {{ only?: string[], ignore?: string[] }} [opts]
 * @returns {string} the file written
 */
export function saveSnapshot(dir, name, d, opts) {
  mkdirSync(dir, { recursive: true });
  const file = snapshotFile(dir, name);
  writeFileSync(file, JSON.stringify(pickGameplay(d, opts), null, 1) + '\n');
  return file;
}

/**
 * Compare a describe() result with the baseline.
 * @param {string} dir snapshot directory
 * @param {string} name scenario name
 * @param {any} d result of engine.describe()
 * @param {{ only?: string[], ignore?: string[], tolerance?: number | Record<string, number> }} [opts]
 * @returns {{ ok: boolean, text: string, values?: number }} text: empty when equal, otherwise the differences, one per line; values: how many were compared
 */
export function compareSnapshot(dir, name, d, opts = {}) {
  const file = snapshotFile(dir, name);
  if (!existsSync(file)) return { ok: false, text: `no baseline for describe snapshot "${name}" (${file}). Create it once: threedog snap-describe save ${name}  (or run the test with --update-snapshots)` };
  const saved = JSON.parse(readFileSync(file, 'utf8')), base = pickGameplay(saved, opts), cur = pickGameplay(d, opts);
  // an --only path found on neither side compares nothing, and nothing always matches
  const empty = (opts.only ?? []).filter(p => !leaves(pickGameplay(saved, { only: [p] })) && !leaves(pickGameplay(d, { only: [p] })));
  if (empty.length) return { ok: false, text: `describe "${name}": nothing to compare at ${empty.join(', ')}: neither the baseline nor the page has it. Top-level fields: ${Object.keys(d).join(', ')}` };
  const lines = diffDescribe(base, cur, opts);
  if (!lines.length) return { ok: true, text: '', values: leaves(cur) };
  const shown = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) shown.push(`... ${lines.length - MAX_LINES} more`);
  return { ok: false, text: `describe "${name}" differs from the baseline in ${lines.length} place${lines.length > 1 ? 's' : ''}:\n  ` + shown.join('\n  ')
    + `\nIf this change is intended, update the baseline: threedog snap-describe save ${name}  (or run the test with --update-snapshots)` };
}

/**
 * One-line assertion for tests: the page's current describe() must match the baseline `name`.
 * With `--update-snapshots` (threedog test ... --update-snapshots) it writes the baseline instead of comparing.
 * @param {{ check: (label: string, ok: boolean, detail?: string) => void, ev: (fn: () => any) => Promise<any> }} ctx the arguments of run({ check, ev })
 * @param {string} name scenario name (file name of the baseline)
 * @param {{ only?: string[], ignore?: string[], tolerance?: number | Record<string, number>, dir?: string }} [opts]
 *   only: compare just these fields (top-level or dotted path); ignore: extra paths to skip; tolerance: allowed difference for numbers (default 0.5, or { default, 'player': 2 }); dir: baseline folder (default <workspace>/tests/snapshots)
 * @example await expectDescribe({ check, ev }, 'market-noon', { only: ['player', 'quests'], tolerance: { default: 0.5, player: 1 } });
 */
export async function expectDescribe({ check, ev }, name, opts = {}) {
  const dir = opts.dir ?? defaultSnapDir(), d = await ev(() => window.engine.describe());
  if (process.env.THREEDOG_UPDATE_SNAPSHOTS) {
    saveSnapshot(dir, name, d, opts);
    check(`describe snapshot "${name}" updated`, true);
    return;
  }
  const r = compareSnapshot(dir, name, d, opts);
  check(`describe snapshot "${name}" matches the baseline`, r.ok, r.text);
}
