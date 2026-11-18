// Reminders (lib/remind.mjs): the one exit for what a tool volunteers. Guards: a reminder never changes the verdict, the budget holds, the two classes count on their own lines.
// Fixture: a throwaway game under games/ with 7 reminders and no error (2 "engine already has it", 5 "likely mistakes"), removed afterwards.
// Run: threedog test "remind"
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GAMES, TOOLS } from '../paths.mjs';
import { remind, BUDGET } from '../lib/remind.mjs';

export const name = 'remind: budget, two counted classes, a reminder never fails check';

const CLI = join(TOOLS, 'bin', 'threedog.mjs');
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
const it = (kind, n) => ({ kind, file: 'a.js', line: n, message: `saw ${kind} ${n}`, short: `use engine.${kind}` });
// one line of code per 8 lines: R40 keeps one finding per kind per 7 lines
const spaced = lines => lines.map(l => `${l}\n${'// -\n'.repeat(7)}`).join('');

export async function run({ check }) {
  const items = [it('timers', 1), it('random', 2), it('timers', 3), it('inventory', 4), it('save', 5), it('random', 6), it('loop', 7)];
  const r = remind(items);
  const listed = r.lines.filter(l => l.startsWith('!'));
  check('a check lists at most its budget, the rest is counted', listed.length === BUDGET.check && r.hidden === 2 && r.lines.some(l => /…2 more/.test(l)), r.lines.join(' | '));
  check('"engine already has it" takes the slots first', listed[0].includes('inventory') && listed[1].includes('save'), listed.join(' | '));
  check('each class has its own count line', r.lines.includes('  engine already has it: 2 (2 listed)') && r.lines.includes('  likely mistakes: 5 (3 listed)'), r.lines.join(' | '));
  check('a shot gets one line', remind(items, { where: 'shot' }).lines.filter(l => l.startsWith('!')).length === 1);
  check('a reminder line is one line: what was seen, then where to look', listed[0] === '! a.js:4  saw inventory 4 → use engine.inventory', listed[0]);

  const dir = join(GAMES, 'zz-remind');
  const hadGames = existsSync(GAMES);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@threedog/zz-remind', private: true, type: 'module', dependencies: { threedog: '*' } }, null, 2) + '\n');
    writeFileSync(join(dir, 'index.html'), '<!doctype html><canvas id="c"></canvas><script type="module" src="./main.js"></script>\n');
    writeFileSync(join(dir, 'main.js'), "// Remind fixture: seven reminders, no error\nimport { createEngine } from 'threedog';\n\ncreateEngine({ canvas: document.querySelector('canvas') });\n" + spaced([
      "localStorage.setItem('progress-a', JSON.stringify({}));", "localStorage.setItem('progress-b', JSON.stringify({}));",
      'setInterval(() => {}, 1000);', 'setInterval(() => {}, 1000);', 'const a = Math.random() < 0.5;', 'const b = Math.random() < 0.5;', 'setTimeout(() => {}, 900);']));
    cli('map', '-w', 'games/zz-remind');
    const out = cli('check', '-w', 'games/zz-remind');
    const text = out.out;
    check('[guard] 7 reminders and 0 errors: check passes with exit 0 and says how many', out.code === 0 && /check games\/zz-remind: passed, 7 reminders/.test(text), text.split(/\r?\n/).slice(-6).join(' | '));
    check('[guard] only the budget is listed, the other two are counted', text.split(/\r?\n/).filter(l => l.startsWith('!') && /main\.js/.test(l)).length === BUDGET.check && /…2 more/.test(text), text.slice(-700));
    check('both classes have a count line in the check output', /engine already has it: 2 \(2 listed\)/.test(text) && /likely mistakes: 5 \(3 listed\)/.test(text), text.slice(-700));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(TOOLS, '..', '..', '.threedog', 'tsconfig.games-zz-remind.json'), { force: true });
    if (!hadGames && existsSync(GAMES) && !readdirSync(GAMES).length) rmdirSync(GAMES);
  }
}
