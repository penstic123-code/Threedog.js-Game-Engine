// expect cli: threedog expect writes, changes, drops and lists expectations.jsonl in the folder it runs in. Pure node.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TOOLS } from '../paths.mjs';

export const name = 'expect cli: a reason and a range are required, shot.* needs a point, budget.* is refused, same key changes, drop and list --json work';

export async function run({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'expect-cli-')), file = join(dir, 'expectations.jsonl');
  const x = (...args) => { const r = spawnSync(process.execPath, [join(TOOLS, 'expect.mjs'), ...args], { cwd: dir, encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
  const lines = () => readFileSync(file, 'utf8').trimEnd().split('\n');
  try {
    writeFileSync(join(dir, 'package.json'), '{"dependencies":{"threedog":"*"}}'); writeFileSync(join(dir, 'main.js'), '');   // a game root: the command picks its workspace the way shot does
    writeFileSync(join(dir, 'shots.json'), '[{ "name": "night" }]');
    check('[guard] no --why is refused and writes nothing', x('economy.gold', '--min', '0').code === 1 && !/economy/.test(x('list').out));
    check('[guard] shot.dark without --point is refused', /needs --point/.test(x('shot.dark', '--max', '0.3', '--why', 'the pier must stay readable').out));
    check('[guard] budget.fps is refused with the pointer to engine.budget', /engine\.budget/.test(x('budget.fps', '--min', '30', '--why', 'low tier stalls below this').out));
    check('a point missing from shots.json gives a pasteable line', /\{ "name": "dusk" \}/.test(x('shot.dark', '--max', '0.3', '--point', 'dusk', '--why', 'the pier must stay readable').out));
    check('shares above 1 are refused', /0\.\.1/.test(x('shot.dark', '--max', '35', '--point', 'night', '--why', 'the pier must stay readable').out));
    check('two writes are two sorted lines', x('shot.dark', '--max', '0.3', '--point', 'night', '--why', 'the pier must stay readable').code === 0
      && x('economy.gold', '--min', '0', '--why', 'a negative balance sold for free').code === 0 && lines().length === 2 && /^\{"value":"economy\.gold"/.test(lines()[0]) && /^\{"value":"shot\.dark"/.test(lines()[1]), readFileSync(file, 'utf8'));
    const again = x('economy.gold', '--min', '5', '--why', 'a bigger floor is needed now');
    check('the same key is a change and quotes the earlier reason', lines().length === 2 && /Earlier reason: "a negative balance sold for free"/.test(again.out), again.out);
    const list = x('list', '--json');
    check('list --json parses', JSON.parse(list.out).length === 2);
    mkdirSync(join(dir, '.threedog'));
    writeFileSync(join(dir, '.threedog', 'expect-last.json'), JSON.stringify({ night: { date: '2026-11-19', backend: 'webgpu', values: { 'shot.dark': 0.21 } } }));
    check('shot.* written after a reading of the point carries its backend and was', x('shot.dark', '--max', '0.3', '--point', 'night', '--why', 'the pier must stay readable').code === 0 && /"was":0\.21/.test(readFileSync(file, 'utf8')) && /"backend":"webgpu"/.test(readFileSync(file, 'utf8')));
    check('[guard] the write command finds the workspace the way shot does (not only the folder it runs in)', !/workspace: 'scope'/.test(readFileSync(join(TOOLS, 'expect.mjs'), 'utf8')));
    writeFileSync(join(dir, 'shots.json'), '{broken');
    check('[guard] a broken shots.json is said to be broken, not "add this line"', /not valid JSON/.test(x('shot.dark', '--max', '0.3', '--point', 'night', '--why', 'the pier must stay readable').out));
    writeFileSync(join(dir, 'shots.json'), '[{ "name": "night" }]');
    check('drop removes one line', x('drop', 'economy.gold').code === 0 && lines().length === 1 && x('drop', 'economy.gold').code === 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
