// Detection: R72 a game's expectations.jsonl that cannot be read, or says the same thing twice (error); a thin reason or a point missing from shots.json (warn).
// Each folder with an expectations.jsonl is read by expect/file.mjs, the same reader the commands and `test expectations` use: every problem it reports (bad JSON,
// a git conflict marker, unknown or missing field, budget.*, the same value at the same point twice) is an error, because the file would be refused at run time.
// The two warnings never fail the check: `why` shorter than expect/file.mjs whyProblem allows (a hand-edit skipped the write command's check), and a `point` that
// shots.json does not name (the expectation could never be measured; the message carries the line to paste).
// Known limits: only the game's own folder is read (not expectations inside a copied game elsewhere); whether the value exists in the game is not checked here.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_NAME, parse, whyProblem } from '../expect/file.mjs';
import { readPoints } from '../hub/points.mjs';
import { P, rel } from './_lib.mjs';

/** Results for one game folder (absolute path) */
export function scanGame(dir) {
  const path = join(dir, FILE_NAME), file = rel(path);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8'), { entries, problems } = parse(text), out = [];   // read once: the line numbers below are of this text
  for (const p of problems) {
    const m = /^line (\d+): (.*)$/.exec(p);
    out.push({ level: 'error', file, line: Number(m[1]), msg: m[2], fix: `edit ${FILE_NAME}: one valid JSON object per line, or drop the line with threedog expect drop <value> [--point name]` });
  }
  const { points, error } = readPoints(dir);
  // a broken shots.json is one problem of that file, not one per expectation that names a point
  if (error) out.push({ level: 'warn', file: rel(join(dir, 'shots.json')), msg: error, fix: 'fix shots.json: the points the expectations name cannot be looked up until it reads' });
  const lines = text.split(/\r?\n/);
  const lineOf = e => lines.findIndex(l => l.includes(JSON.stringify(e.value)) && (e.point === undefined || l.includes(JSON.stringify(e.point)))) + 1;
  for (const e of entries) {
    const why = whyProblem(e);
    if (why) out.push({ level: 'warn', file, line: lineOf(e), msg: `${e.value}: ${why}`, fix: 'say what breaks for the player when this fails' });
    if (!error && e.point !== undefined && !points.some(p => p.name === e.point)) out.push({ level: 'warn', file, line: lineOf(e), msg: `${e.value}: point "${e.point}" is not in shots.json`, fix: `add this line to the array in shots.json: { "name": "${e.point}" }` });
  }
  return out;
}

export default {
  id: 'R72', title: "A game's expectations.jsonl is readable, and its reasons and points make sense", game: true,
  run: () => P.gameDirs().flatMap(scanGame),
};
