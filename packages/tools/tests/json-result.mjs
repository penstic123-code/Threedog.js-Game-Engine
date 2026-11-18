// --json on check and test: one result shape { ok, summary, items } on stdout, nothing else there, the exit code unchanged.
// Why: an AI client parsed the text of check (✗ lines, "Fix:" lines) and test; the shape is defined once (lib/result.mjs) and MCP reads it too.
// A throwaway game holds a type error and a failing test item, so both failing cases are real runs.
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, TOOLS } from '../paths.mjs';
import { parseResult } from '../lib/result.mjs';

export const name = 'check/test --json: the one result shape on stdout only, ok and exit code agree, failed rule/type/test items carry code, file and message';

const FIELDS = ['code', 'level', 'file', 'line', 'message', 'fix'];
const shapeOk = r => !!r && typeof r.ok === 'boolean' && typeof r.summary === 'string' && Array.isArray(r.items)
  && r.items.every(i => Object.keys(i).every(k => FIELDS.includes(k)) && typeof i.message === 'string' && Object.values(i).every(v => v !== '' && v !== null));
const node = (...args) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });

export async function run({ check }) {
  // check: pass, and a failure (unknown rule id); stdout parses as exactly one JSON line
  const pass = node(join(TOOLS, 'check.mjs'), '--rule', 'R4', '--json'), p = parseResult(pass.stdout);
  check('check --json (passing): stdout is one JSON line of the shape, ok true, exit 0', shapeOk(p) && p.ok && pass.status === 0 && pass.stdout.trim().split('\n').length === 1, pass.stdout.slice(0, 200));
  const bad = node(join(TOOLS, 'check.mjs'), '--rule', 'R999', '--json'), b = parseResult(bad.stdout);
  check('check --json (unknown rule): ok false, exit 1, an error item with code and fix', shapeOk(b) && !b.ok && bad.status === 1 && b.items[0]?.level === 'error' && !!b.items[0].code && !!b.items[0].fix, bad.stdout.slice(0, 300));
  // MCP reads the same shape: a failed check shows the item's code and fix, not parsed text
  const { STATIC_TOOLS } = await import('../threedog/mcp-extra.mjs');
  const m = await STATIC_TOOLS.check.run(ROOT, { rule: 'R999' });
  check('MCP check digest is built from the items (code and Fix line)', !m.ok && /unknown rule/.test(m.text) && /Fix: Rules:/.test(m.text), m.text.slice(0, 300));

  const games = join(ROOT, 'games'), hadGames = existsSync(games), dir = join(games, 'zz-json');
  try {
    mkdirSync(join(dir, 'tests', 'specs'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'zz-json', private: true, type: 'module' }));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><script type="module" src="./main.js"></script>\n');
    writeFileSync(join(dir, 'main.js'), '/** @type {number} */\nconst n = "not a number";\nwindow.engine = { ready: true, stateApplied: true, modules: new Map([["x", {}]]) };\nexport { n };\n');
    writeFileSync(join(dir, 'tests', 'specs', 'json.mjs'), `export const specs = [
  { name: 'zz json fails', url: '/', timeout: 3000, async run({ check }) { check('one', true); check('two is wrong', false, 'expected 2, got 3'); } },
];\n`);
    const ty = node(join(TOOLS, 'types.mjs'), '-w', dir, '--json'), t = parseResult(ty.stdout);
    check('types --json: ok false, exit 1, a TS error item with file and line', shapeOk(t) && !t.ok && ty.status === 1 && t.items.some(i => /^TS\d+$/.test(i.code) && i.level === 'error' && /zz-json/.test(i.file) && i.line > 0), ty.stdout.slice(0, 400));
    const ts = node(join(TOOLS, 'bin', 'threedog.mjs'), 'test', '-w', dir, '--json'), r = parseResult(ts.stdout);
    check('test --json: stdout is only the JSON; ok false, exit 1, the failed check is an item with item name and reason, totals in the summary',
      shapeOk(r) && !r.ok && ts.status === 1 && r.items.some(i => /^zz json fails: two is wrong → expected 2, got 3$/.test(i.message)) && /\d+ checks in \d+ items, \d+ passed, \d+ failed/.test(r.summary),
      (ts.stdout + ts.stderr).slice(0, 500));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (!hadGames && existsSync(games) && !readdirSync(games).length) rmSync(games, { recursive: true, force: true });   // only an empty games/ it made: other tests run beside this one in games/
  }
}
