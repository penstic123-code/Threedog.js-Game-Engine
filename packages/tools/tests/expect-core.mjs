// expect core: the expectations file (parse, validate, write back), one reading of the page, and the four results with their wording. Pure node, no browser.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, serialize, update } from '../expect/file.mjs';
import { assemble } from '../expect/facts.mjs';
import { evaluate, lines, hintLine } from '../expect/evaluate.mjs';

export const name = 'expect core: file problems carry line numbers; holds / fails / missing / unmeasured; the failure line quotes its reason';

const E = (value, extra) => JSON.stringify({ value, why: 'because', ...extra });

export async function run({ check }) {
  // [guard] (a) every kind of broken line is reported with its own line number, and valid lines around it still load
  const text = [E('a.x', { min: 0 }), '{ not json', E('a.x', { min: 1 }), '<<<<<<< HEAD', E('b.y', { is: null }), E('c.z', { max: 1, by: 'claude' }), E('shot.dark', { max: 1 })].join('\n');
  const p = parse(text);
  check('[guard] a bad JSON line, a duplicate key and a conflict marker are each reported with their line number', /^line 2: not valid JSON/.test(p.problems[0]) && /^line 3: a\.x at any view is written twice \(lines 1 and 3/.test(p.problems[1]) && /^line 4: git conflict marker/.test(p.problems[2]), p.problems.join(' | '));
  check('[guard] an unknown field and a shot value without a point are errors on their lines', /^line 6: unknown field "by"/.test(p.problems[3]) && /^line 7: shot\.dark: "point" is required/.test(p.problems[4]), p.problems.slice(3).join(' | '));
  check('valid lines still load', p.entries.map(e => e.value).join() === 'a.x,b.y', JSON.stringify(p.entries));
  const b = parse(E('budget.fps', { min: 30 }));
  check('[guard] a budget.* expectation is refused with the pointer to engine.budget', b.problems.length === 1 && b.problems[0].includes('limits stay in engine.budget (createEngine({ budget }))'), b.problems.join());

  // file: sorted, fixed field order, LF; update re-reads and refuses a broken file instead of dropping its bad lines
  const dir = mkdtempSync(join(tmpdir(), 'expect-core-')), file = join(dir, 'expectations.jsonl');
  try {
    const out = serialize([{ why: 'w', value: 'b', max: 1, point: 'p2' }, { value: 'b', why: 'w', min: 0, point: 'p1' }, { value: 'a', why: 'w', is: 0 }]);
    const want = ['{"value":"a","is":0,"why":"w"}', '{"value":"b","min":0,"point":"p1","why":"w"}', '{"value":"b","max":1,"point":"p2","why":"w"}', ''].join('\n');
    check('serialize sorts by value then point, in a fixed field order, with LF', out === want, out);
    writeFileSync(file, E('a.x', { min: 0 }) + '\n');
    update(file, es => [...es, { value: 'a.y', is: 1, why: 'w' }]);
    check('update reads the file again, adds and writes back sorted', readFileSync(file, 'utf8').split('\n').filter(Boolean).length === 2);
    writeFileSync(file, '{ broken\n');
    let refused = false; try { update(file, es => es); } catch { refused = true; }
    check('update refuses a file with problems and leaves it as it was', refused && readFileSync(file, 'utf8') === '{ broken\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }

  // [guard] (b) the four results
  const d = { economy: { gold: 5, flag: null, n: 7 }, perf: { fps: null } };
  const facts = assemble({ describe: d, picture: { dark: 0.48, luminance: 0.4 }, backend: 'webgl2', halted: true });
  const st = (e, f = facts, point = 'p') => evaluate([e], f, { point })[0].status;
  const ent = (value, extra) => ({ value, why: 'because', ...extra });
  check('a value inside the range holds, outside it fails (end points count as inside)', st(ent('economy.gold', { min: 5, max: 5 })) === 'holds' && st(ent('economy.gold', { min: 6 })) === 'fails');
  check('[guard] null with is: null holds; an undefined path is missing', st(ent('economy.flag', { is: null })) === 'holds' && st(ent('economy.nope', { min: 0 })) === 'missing');
  check('[guard] shot.* without a picture is unmeasured', st(ent('shot.dark', { max: 1, point: 'p' }), assemble({ describe: d })) === 'unmeasured');
  check('[guard] perf.fps on a halted page is unmeasured, on a live page it is read', st(ent('perf.fps', { is: null })) === 'unmeasured' && st(ent('perf.fps', { is: null }), assemble({ describe: d })) === 'holds');
  check('[guard] a different backend is unmeasured and the headline says so', st(ent('shot.dark', { max: 1, point: 'p', backend: 'webgpu' })) === 'unmeasured' && lines(evaluate([ent('shot.dark', { max: 1, point: 'p', backend: 'webgpu' })], facts, { point: 'p' }), { point: 'p' })[0].includes('cannot be checked here (written for webgpu, drawn by webgl2)'));
  check('entries of another point are not checked, entries without a point always are', evaluate([ent('economy.gold', { min: 0, point: 'q' }), ent('economy.n', { min: 0 })], facts, { point: 'p' }).length === 1);

  // [guard] (c) wording
  const fail = ent('shot.dark', { max: 0.35, point: 'night-harbor', why: 'the pier must stay readable', was: 0.22, date: '2026-11-18' });
  const one = lines(evaluate([fail], facts, { point: 'night-harbor' }), { point: 'night-harbor' }).join('\n');
  check('[guard] a failure line has the value, the range, was, the quoted reason and the date', one.startsWith('Expectations at night-harbor: 1 of 1 fails') && one.includes('✗ shot.dark 0.48, expected <= 0.35 (was 0.22). Why: "the pier must stay readable" (2026-11-18)'), one);
  const four = ['a', 'b', 'c', 'd'].map(k => ent(`economy.${k}`, { min: 1, why: 'w' })), many = { ...facts, values: { economy: { a: 0, b: 0, c: 0, d: 0 } } };
  const m = lines(evaluate(four, many), {});
  check('[guard] four failures list three and then "1 more"', m.length === 5 && m.slice(1, 4).every(l => l.startsWith('  ✗')) && m[4].startsWith('  1 more:'), m.join('\n'));
  check('[guard] everything holding is one line', lines(evaluate([ent('economy.gold', { min: 0 }), ent('economy.n', { max: 9 })], facts), {}).join() === 'Expectations: 2 hold');
  check('the hint is offered once: not when there already is an expectation, and it ends in a command', hintLine({ point: 'p', hasAny: true }) === null && /^threedog expect shot\.<number> --max <n> --point p --why/.test(hintLine({ point: 'p', hasAny: false })));
}
