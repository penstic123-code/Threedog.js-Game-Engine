// expect rule: R72 reads each game's expectations.jsonl; only an unreadable or duplicated file is an error, a thin reason or an unknown point only warns. Pure node.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanGame } from '../rules/R72-expectations.mjs';

export const name = 'expect rule: bad JSON and duplicates are errors, a short reason and a point missing from shots.json are warnings, a good or absent file says nothing';

const GOOD = '{"value":"economy.gold","min":0,"why":"a negative balance sold for free"}\n';

export async function run({ check }) {
  const dirs = [];
  const game = (text, shots = '[{ "name": "night" }]') => {
    const d = mkdtempSync(join(tmpdir(), 'expect-rule-')); dirs.push(d);
    if (text !== null) writeFileSync(join(d, 'expectations.jsonl'), text);
    writeFileSync(join(d, 'shots.json'), shots);
    return scanGame(d);
  };
  const count = (r, level) => r.filter(x => x.level === level).length;
  try {
    const bad = game('{not json\n');
    check('[guard] bad JSON is one error on its line', count(bad, 'error') === 1 && bad[0].line === 1, JSON.stringify(bad));
    const dup = game(GOOD + GOOD);
    check('[guard] the same value at the same point twice is one error', count(dup, 'error') === 1 && dup[0].line === 2, JSON.stringify(dup));
    const thin = game('{"value":"economy.gold","min":0,"why":"too low"}\n');
    check('[guard] a short reason is one warning and no error', count(thin, 'warn') === 1 && count(thin, 'error') === 0, JSON.stringify(thin));
    const point = game('{"value":"shot.dark","max":0.3,"point":"dusk","why":"the pier must stay readable"}\n');
    check('[guard] a point missing from shots.json is one warning with a pasteable line', count(point, 'warn') === 1 && /\{ "name": "dusk" \}/.test(point[0].fix), JSON.stringify(point));
    const broken = game('{"value":"shot.dark","max":0.3,"point":"a","why":"the pier must stay readable"}\n{"value":"shot.lit","max":0.3,"point":"b","why":"the pier must stay readable"}\n', '{oops');
    check('[guard] a broken shots.json is one warning, not one per expectation', count(broken, 'warn') === 1 && /shots\.json/.test(broken[0].file), JSON.stringify(broken));
    check('a good file gives nothing', game(GOOD).length === 0);
    check('no file gives nothing', game(null).length === 0);
  } finally { for (const d of dirs) rmSync(d, { recursive: true, force: true }); }
}
