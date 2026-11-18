// threedog expect: write down what must stay true, in the game's expectations.jsonl.
//   threedog expect <value> (--min n | --max n | --is v) [--point name] --why "reason" [-w game]   write, or change the same value at the same point
//   threedog expect drop <value> [--point name] [-w game]                                          remove it
//   threedog expect list [--point name] [--json] [-w game]                                          show them
// <value> is the dotted path of one number or fact, e.g. economy.gold, shot.dark, loading.failed.length. shot.* needs --point (a view named in shots.json).
// --is takes JSON (true, null, 0, "storm"); anything else is read as text. Limits stay in engine.budget: budget.* is refused.
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli } from './paths.mjs';
import { remind } from './lib/remind.mjs';
import { FILE_NAME, read, update, keyOf, whyProblem, MIN_WHY } from './expect/file.mjs';
import { readLast } from './expect/last.mjs';
import { rangeText } from './expect/evaluate.mjs';
import { findPoint } from './hub/points.mjs';

/** Values that are times: they move between runs and machines, so the writer is reminded to leave room (recipe 15) */
const TIME_LIKE = /Ms$|^perf\.startup\./;
const SHARES = ['shot.dark', 'shot.overexposed'];

const show = e => `${e.value} ${rangeText(e)} at ${e.point ?? 'any view'}`;
const fail = msg => { console.error('✗ ' + msg); return 1; };

/** The --is argument: JSON when it parses (true, null, 0, "storm"), else the text as given */
function isValue(s) { try { return JSON.parse(s); } catch { return s; } }

/** What is wrong with a write request, or null (the file's own rules in expect/file.mjs run again on the written line) */
function problem(o, value) {
  const num = k => o[k] !== undefined && !Number.isFinite(Number(o[k]));
  if (num('min') || num('max')) return '--min and --max take a number';
  if (o.min === undefined && o.max === undefined && o.is === undefined) return 'give --min, --max or --is';
  if (whyProblem({ value, why: o.why })) return `--why "reason" is required (at least ${MIN_WHY} characters, not the value): it is quoted whenever this fails`;
  if (SHARES.includes(value) && [o.min, o.max].some(v => Number(v) > 1)) return 'shares are 0..1: write 0.35 for 35%';
  return null;
}

export async function main(argv) {
  const sub = argv[0] === 'drop' || argv[0] === 'list' ? argv[0] : null;
  const c = cli(sub ? argv.slice(1) : argv, { positional: true, flags: ['json'], values: ['min', 'max', 'is', 'point', 'why'] });
  const dir = c.dir ?? process.cwd(), file = join(dir, FILE_NAME), o = c.opt;
  const { entries, problems } = read(file);

  if (sub === 'list') {
    if (problems.length) return fail(`${FILE_NAME} has problems:\n  ${problems.join('\n  ')}`);
    const shown = entries.filter(e => o.point === undefined || e.point === o.point);
    if (o.json) { console.log(JSON.stringify(shown, null, 2)); return 0; }
    if (!shown.length) console.log(`No expectations yet (${FILE_NAME}): threedog expect <value> --min n --why "reason"`);
    for (const e of shown) console.log(`${show(e)}  — ${e.why}`);
    return 0;
  }

  const value = c.rest[0];
  if (!value || c.rest.length > 1) return fail('usage: threedog expect <value> (--min n | --max n | --is v) [--point name] --why "reason" · threedog expect drop <value> [--point name] · threedog expect list');
  const key = keyOf({ value, point: o.point }), old = entries.find(e => keyOf(e) === key);

  if (sub === 'drop') {
    if (!old) return fail(`no expectation for ${key}. See: threedog expect list`);
    try { update(file, es => es.filter(e => keyOf(e) !== key)); } catch (e) { return fail(e.message); }
    console.log(`✓ dropped: ${show(old)}`);
    return 0;
  }

  const bad = problem(o, value);
  if (bad) return fail(bad);
  if (value.startsWith('shot.') && !o.point) return fail(`${value} needs --point <name>: a picture number needs a named view from shots.json`);
  if (o.point !== undefined) {
    try { findPoint(dir, o.point); } catch (e) { return fail(`${e.message}. To add it, put { "name": "${o.point}" } in the array of shots.json`); }
  }
  const entry = { value, ...(o.min !== undefined && { min: Number(o.min) }), ...(o.max !== undefined && { max: Number(o.max) }), ...(o.is !== undefined && { is: isValue(o.is) }),
    ...(o.point !== undefined && { point: o.point }), why: o.why.trim(), date: new Date().toISOString().slice(0, 10) };
  // a picture number belongs to the renderer that drew it (shot.* is judged only on the same backend): take it from the last shot of this point
  const last = value.startsWith('shot.') ? readLast(dir, o.point) : null;
  if (last?.backend) entry.backend = last.backend;
  if (typeof last?.values?.[value] === 'number') entry.was = last.values[value];
  try { update(file, es => [...es.filter(e => keyOf(e) !== key), entry]); } catch (e) { return fail(e.message); }
  console.log(old ? `✓ changed: ${show(old)} -> ${rangeText(entry)}. Earlier reason: "${old.why}"` : `✓ kept: ${show(entry)}`);
  if (value.startsWith('shot.') && !last) console.log(`not measured yet: threedog shot --point ${o.point} checks it`);
  if (TIME_LIKE.test(value)) console.log(remind([{ file: FILE_NAME, message: 'times move 10-30% between runs and machines', short: 'leave room (recipe 15)' }], { where: 'shot' }).lines.join('\n'));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
