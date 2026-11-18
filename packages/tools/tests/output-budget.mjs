// Short by default, detail on demand: the text a command prints after a picture or a check stays within a line budget, and the detail is
// one flag away. Why: a ~15-line game-state block under every shot and 90+ warning lines under every check buried what the AI had to act on.
//   shot / snap: under the picture only PICTURE (time, weather, camera, an error), one formatter for both; describeText stays in --json / --describe-only
//   check: errors in full, warnings one count line per rule; --verbose lists them
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS, ROOT } from '../paths.mjs';
import { PICTURE } from '../threedog/pageFns.mjs';
import { lines as expectLines } from '../expect/evaluate.mjs';

export const name = 'output budget: shot / snap print only the picture state, check prints warnings as one line per rule (--verbose lists them)';

export async function run({ check }) {
  // a busy page: many nearby things, quests, windows, an error. Only what bears on the picture is printed
  const busy = { describe: () => ({
    time: { clock: '21:40', day: 3, isDay: false }, weather: { name: 'rain', label: '雨', progress: 0.4 },
    camera: { type: 'follow', x: 1.234, y: 5, z: -2, focus: { x: 0, z: 0 } },
    player: { x: 1, z: 2 }, nearby: Array.from({ length: 12 }, (_, i) => ({ name: `thing${i}`, dist: i })), quests: { active: [{ title: 'q', step: 's' }] },
    ui: { windows: ['inv', 'map'] }, error: { where: 'onFixed', message: 'x is not a function', code: null } }) };
  const pic = PICTURE(busy);
  check('[guard] PICTURE on a busy page: at most 6 lines, time (with night), weather (name, changing), camera, the error and the describe pointer; no nearby / quests',
    pic.length <= 6 && /^Time: 21:40, day 3, night$/.test(pic[0]) && /^Weather: rain, changing \(40%\)$/.test(pic[1]) && /^Camera: follow, position \(1\.2, 5, -2\), focus \(0, 0\)$/.test(pic[2])
    && pic.some(l => /engine error onFixed/.test(l)) && /threedog describe/.test(pic.at(-1)) && !pic.some(l => /thing|Quest|Nearby/.test(l)), pic.join(' | '));
  const src = f => readFileSync(join(TOOLS, f), 'utf8');
  check('[guard] shot prints PICTURE under a picture (describeText only with --describe-only, kept in --json); snap uses the same page function',
    /\(\$\{PICTURE\}\)\(window\.engine\)/.test(src('shot.mjs')) && /if \(opt\['describe-only'\]\) \{ say\('\\n' \+ text\)/.test(src('shot.mjs'))
    && /ev\(driver, 'picture'/.test(src('threedog/commands.mjs')) && !/ev\(driver, 'brief'[^)]*\), 2\)/.test(src('threedog/commands.mjs')));

  // check: one rule with many warnings (R1 file size), default vs --verbose
  const cli = (...a) => spawnSync(process.execPath, [join(TOOLS, 'bin/threedog.mjs'), 'check', ...a], { cwd: ROOT, encoding: 'utf8' });
  const plain = cli('--rule', 'R1'), verbose = cli('--rule', 'R1', '--verbose');
  const warnLines = s => s.split('\n').filter(l => l.startsWith('! ')).length;
  const n = +(/R1 [^\n]*: (\d+) warnings?/.exec(plain.stdout)?.[1] ?? 0);
  const holds = [1, 2, 3, 4].map(i => ({ entry: { value: 'v' + i }, status: 'holds', actual: i }));
  check('[guard] expectations: all holding is one line under a shot', expectLines(holds, { point: 'p' }).length === 1);
  check('[guard] check: warnings are one count line per rule and a "details: --verbose" line; no warning listed; exit code unchanged',
    n > 0 && warnLines(plain.stdout) === 0 && /^details: --verbose/m.test(plain.stdout) && plain.status === verbose.status, plain.stdout.slice(-400));
  check('check --verbose lists the warnings as before', warnLines(verbose.stdout) > 0, verbose.stdout.slice(0, 300));
}
