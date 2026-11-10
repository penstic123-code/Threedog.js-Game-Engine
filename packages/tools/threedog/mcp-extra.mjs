// MCP tool definitions that sit next to the per-command ones in mcp.mjs: play, status, verify, the static how / check, and the "does it move time" label put in front of every tool
// description (the first words are what a client shows when it lists tools, so the rule that matters most goes first).
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIME } from './runtime.mjs';
import { item, result, parseResult, HINTS_SHOWN } from '../lib/result.mjs';

const str = description => ({ type: 'string', description });

const LABEL = [
  [TIME.advances, 'ADVANCES GAME TIME.'],
  [['state'], 'No game time unless wait is supplied; wait advances N real seconds.'],
  [TIME.frozenTimeSafe, 'No game time.'],
  [TIME.observes, 'Observes only.'],
];
/** Tool name (underscore form) → label for the front of its description */
export const label = name => LABEL.find(([cmds]) => cmds.includes(name.replace('_', '-')))?.[1] ?? '';

/** engine.runState.state values, copied from core/ops/holds.js (tests/run-state-enum.mjs keeps the two equal) */
export const RUN_STATES = ['loading', 'title-frozen', 'halted', 'frozen', 'running'];
/**
 * The shape every tool result has (structuredContent), explained once at the front of the server instructions. The time sentence is generated
 * from TIME. Why here and not in each tool's outputSchema: the tool list is loaded into every session, and the full schema repeated on all 29
 * tools was 72% of it (35.7 of 49.6 KB)
 */
export const RESULT_SHAPE = 'Every result has text plus structuredContent { ok, code, summary, runtime: { ready, mode: running|halted|frozen|null, tick, headless, ' +
  `blockedBy[], run: { state: ${RUN_STATES.join('|')}, owners[], blockedBy[] } }, data (short, command-specific; a large one keeps its small fields and names the CLI --json call for the rest) }. ` +
  'code: ok; blocked = ran and was refused or found a problem; not-ready = page not ready; no-server|starting|busy|page-error|no-bridge = cannot reach the game; ' +
  'command-error = bad arguments or a page exception. runtime.blockedBy: input contexts (win-<id>, ui-<part>, dialogue, cutscene...), error, loading. ' +
  'The text ends with one line on the game state and how to get back to normal play. ' +
  `${TIME.advances.join(' / ')} advance game time; ${TIME.frozenTimeSafe.join(', ')} do not (state only with wait=); everything else only observes.`;

/** Bytes of structuredContent.data a tool result carries as is; a larger payload is shortened by shortData */
export const DATA_MAX = 3000;
/**
 * A large data payload in an MCP result → its small fields kept, each large one replaced by a size note, plus where the whole payload is.
 * Why: a client may hand structuredContent to the model next to the text, every call; scene / catalog data was 6–45 KB repeating what the text
 * already summarized. The text stays complete for its purpose; the whole payload is one CLI call away (threedog <cmd> --json).
 */
export function shortData(data, cmd) {
  if (data == null || Buffer.byteLength(JSON.stringify(data)) <= DATA_MAX) return data;
  const note = v => Array.isArray(v) ? `[${v.length} items]` : `{${Object.keys(v).length} keys}`;
  const out = Array.isArray(data) ? { count: data.length } : Object.fromEntries(Object.entries(data).map(([k, v]) =>
    [k, v && typeof v === 'object' && JSON.stringify(v).length > 300 ? note(v) : v]));
  return { ...out, omitted: `shortened for the tool result; the whole data: threedog ${cmd} --json` };
}

/** Declared on every tool, kept minimal (the protocol only needs an object schema; the fields are described once in RESULT_SHAPE) */
export const OUTPUT_SCHEMA = { type: 'object', required: ['ok', 'code', 'summary', 'runtime'] };

// Descriptions stay short (they are sent every turn): what it does and when to use it; the details live in the schema field descriptions.
/** The CLI's --freeze-reload as a tool input (scenario, verify): dispatch.mjs parses the flag and holds the dev server's reloads for the run, so the MCP path is the CLI path */
export const FREEZE = { type: 'boolean', description: 'Saves do not reload the page during the run (for at most 10 minutes), so editing files while it runs cannot wipe its state' };
export const freezeArg = a => a.freezeReload ? ['--freeze-reload'] : [];
export const EXTRA_TOOLS = {
  play: {
    description: 'Start the game and connect: starts the dev server if none runs, waits for bridge and engine, returns the page address. Call first when nothing runs.',
    schema: { type: 'object', properties: { stop: { type: 'boolean', description: 'Stop the dev server that play started' } }, required: [] },
    args: a => a.stop ? ['--stop'] : [],
  },
  status: {
    description: 'Is the engine ready, loading done, any page errors, running / halted / frozen? If the bridge cannot answer, names the cause and the next step.',
    schema: { type: 'object', properties: {}, required: [] },
    args: () => [],
  },
  scene: {
    description: 'The mesh exists but is not drawn: lists every Mesh / Points / Line / Sprite and, for each undrawn one, why (visibility, layers, material, scale, fog, view). Use first.',
    schema: { type: 'object', properties: { hidden: { type: 'boolean', description: 'List only the objects that are not drawn' },
      limit: { type: 'number', description: 'How many objects to list (default 6, undrawn and surprising ones first; counts and the reasons line always cover everything)' } }, required: [] },
    args: a => [...(a.hidden ? ['--hidden'] : []), ...(a.limit ? ['--limit', String(a.limit)] : [])],
  },
  verify: {
    description: 'Run a scenario file and report pass or fail plus what it tested and never touched, related tests, and the re-run command. A page error fails it.',
    schema: { type: 'object', properties: { name: str('Scenario file name without .json (tests/scenarios/<name>.json)'), freezeReload: FREEZE,
      saveBaseline: { type: 'boolean', description: 'Store the draw calls, triangles and module ms in .threedog/perf-baseline.json (this machine); later runs from the same spot say when they are slower' } }, required: ['name'] },
    args: a => [a.name, ...(a.saveBaseline ? ['--save-baseline'] : []), ...freezeArg(a)],
  },
};

// Static tools: answered from the files alone (no dev server, no page). run(dir, input) → { ok, text, data }; mcp.mjs wraps it in the result shape.
const HERE = dirname(fileURLToPath(import.meta.url));
/** op arguments object → key=value strings; the page converts them back by the op's args shape. Numbers stay x,y,z for a position; other lists go as JSON, joined they read as one string */
export const pairs = args => Object.entries(args
  || {}).map(([k, v]) => `${k}=${Array.isArray(v) && v.every(x => typeof x === 'number') ? v.join(',') : v !== null && typeof v === 'object' ? JSON.stringify(v) : v}`);

const isHint = i => i.code === 'R40' && i.level === 'warn';
const place = i => `${i.code ? i.code + ' ' : ''}${i.file ? i.file + (i.line ? ':' + i.line : '') + '  ' : ''}`;
/** A `check --json` result (lib/result.mjs) as lines: every error with its fix, the first `hints` bypass hints in the order `check` prints them, then the summary. Capped, and the
 *  summary survives the cap (the full run is `npm run check` in a terminal). A hint never changes the verdict: ok is the exit code */
export const checkDigest = (r, max, hints = HINTS_SHOWN) => {
  const all = r.items.filter(isHint), shown = all.slice(0, hints), more = all.length - shown.length;
  const body = [...r.items.filter(i => i.level === 'error').map(i => `✗ ${place(i)}${i.message}${i.fix ? `\n    Fix: ${i.fix}` : ''}`),
    ...shown.map(i => `! ${place(i)}${i.message}\n    ${i.short ?? i.fix}`), ...(more ? [`… ${more} more hints: ask with hints: ${all.length}`] : [])].join('\n');
  const room = max - r.summary.length - 1;
  return [...(!body ? [] : [body.length > room ? body.slice(0, room - 40) + `\n… (${body.length - room + 40} more characters)` : body]), r.summary].join('\n');
};
const CHECK_MS = 10 * 60000;
export const STATIC_TOOLS = {
  how: {
    description: 'What already exists, before building a system or a picture. task: one recommended route, is it installed here. browse: categories, then a category. card: one capability by id. Works with no game.',
    schema: { type: 'object', properties: { task: str('Search: the task in English words, e.g. "tone mapping", "save game", "rain"'), browse: str('"categories" for the first screen, or a category id for its capabilities'), card: str('A capability id from browse: install, dependencies, time, saves, example'),
      read: str('One piece by where it is: a docs pointer (recipes/63-third-person-start.md#4) or an API name (interactions.add.once)'),
      full: { type: 'boolean', description: 'task: also the other routes; card: also the example code; read: the whole section' } }, required: [] },
    // the answers of `threedog how` (how-answer.mjs): one field each, the same as its flags
    run: async (dir, a) => {
      const how = await import('../how-answer.mjs'), full = !!a.full;
      if (a.read) return how.readDoc(String(a.read).trim(), { full });
      if (a.card) return how.card(dir, String(a.card).trim(), { full });
      if (a.browse) return how.browse(a.browse === 'categories' ? '' : String(a.browse).trim());
      return how.answer(dir, String(a.task ?? '').trim(), { full });
    },
  },
  // read-only on purpose: copying writes into the game and can need --force, so it stays a command the user (or AI) runs on purpose (threedog art copy)
  art_list: {
    description: 'What a source of art code offers before `threedog art copy`: modules, exported generator functions with their first JSDoc line, asset files. Source: a game folder, local path or package.',
    schema: { type: 'object', properties: { source: str('Path relative to the game folder (e.g. "../my-earlier-game") or a package name'), full: { type: 'boolean', description: 'Every module and asset (default: the first few)' } }, required: ['source'] },
    run: async (dir, a) => {
      const { listArt, artListText } = await import('../art.mjs'), source = String(a.source ?? ''), r = listArt(source, dir);
      // data: the full list only when asked, so the long list is not sent twice (text and data)
      return { ok: true, text: artListText(r, !!a.full, r.root, source).join('\n'), data: a.full ? r : { root: r.root, modules: r.modules.length, assets: r.assets.length } };
    },
  },
  // read-only on purpose, like art_list: adding and pulling write files and stay commands (threedog lib add / pull)
  lib_list: {
    description: 'Your own art library from earlier games (~/.threedog/library): name, kind, summary, backends, use line. Check before writing an effect.',
    schema: { type: 'object', properties: { query: str('Words that must all match (optional)') }, required: [] },
    run: async (dir, a) => {
      const { listEntries, libraryDir, readLibrary, brokenLine } = await import('../lib.mjs'), lib = libraryDir(), list = listEntries(lib, String(a.query ?? '').split(/\s+/));
      const broken = brokenLine(readLibrary(lib).broken);
      const text = (list.length ? list.map(e => `${e.name} [${e.kind}] ${e.summary} (${(e.backends ?? []).join(', ')})\n  use: ${e.use}`).join('\n') : `No entry${a.query ? ` matches "${a.query}"` : ''} in ${lib}`)
        + (broken ? `\n${broken}` : '');
      return { ok: !broken, text, data: list.map(({ dir: _dir, ...e }) => e) };
    },
  },
  check: {
    description: 'Run npm run check on this game (rules R*, content, types, GAMEMAP) from the files alone (no game needed): errors, counts, the first bypass hints (hints never fail it).',
    schema: { type: 'object', properties: { rule: str('Optional: only these rules, e.g. "R33,R18"'), max: { type: 'number', description: 'Output cap in characters (default 2000)' }, hints: { type: 'number', description: `Bypass hints to list (default ${HINTS_SHOWN}; every one when rule names R40)` } }, required: [] },
    run: (dir, a) => new Promise(res => {
      const args = [join(HERE, '..', 'check.mjs'), '--json', ...(a.rule ? ['--rule', String(a.rule)] : [])];
      const c = spawn(process.execPath, args, { cwd: dir, timeout: CHECK_MS });   // a check that hangs would hold every tool call queued behind it
      c.on('error', e => res({ ok: false, text: `✗ check could not run: ${e.message}`, data: { exit: null, errors: [] } }));
      let out = '';
      c.stdout.setEncoding('utf8'); c.stderr.setEncoding('utf8');   // a Chinese character split over two chunks stays whole
      c.stdout.on('data', d => out += d); c.stderr.resume();   // stdout is only the JSON result; the text goes to stderr
      c.on('close', (code, signal) => {
        const r = parseResult(out) ?? result([item({ code: 'check', message: signal ? `check stopped after ${CHECK_MS / 60000} minutes` : 'check did not print a result' })], 'check failed', false);
        const hints = a.hints >= 0 ? a.hints : /\bR40\b/.test(String(a.rule ?? '')) ? Infinity : HINTS_SHOWN;   // what check --rule R40 prints
        res({ ok: code === 0, text: (code === 0 ? '✓ check passed\n' : '✗ check failed\n') + checkDigest(r, a.max > 0 ? a.max : 2000, hints), data: { exit: code, errors: r.items.filter(i => i.level === 'error'), hints: r.items.filter(isHint).slice(0, hints) } });
      });
    }),
  },
};

/** The "When something happens: which tool" section of recipe 16 as one compact line (backticks dropped): the server instructions carry it, so the list
 *  has one source (the test compares the two). '' when the recipe is not found (a project without the engine docs). */
export function situationGuide(recipePath) {
  let text;
  try { text = readFileSync(recipePath, 'utf8'); } catch { return ''; }
  const sec = text.split(/^## /m).find(s => /^(\d+\.\s*)?When something happens/.test(s));
  if (!sec) return '';
  const rows = sec.split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2).replaceAll('`', '').replace(/\.$/, '').trim());
  return rows.length ? 'When something happens -> which tool: ' + rows.join('; ') + '.' : '';
}
