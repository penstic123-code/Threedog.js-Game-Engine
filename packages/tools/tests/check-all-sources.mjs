// Type check covers every .js of a game, not a list of known folders.
// Why: the root tsconfig used to list main.js, game/, content/, picture/ and plugins/. A game that put code in another folder (landmarks/, data/) had it skipped
// by the type check while `check` said "passed": a duplicate `const` there only failed in the build. The scope is now all of games/<name>/**, minus public, tests, docs, shots.
// Fixture: one throwaway game whose main.js imports a file from an unlisted folder (extra/, with a type error and a redeclared const) and from public/ (not checked).
// Run: threedog test "type check covers"
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GAMES, TOOLS } from '../paths.mjs';

export const name = 'type check covers every game folder, not a list of known ones';

const CLI = join(TOOLS, 'bin', 'threedog.mjs');
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };

export async function run({ check }) {
  const dir = join(GAMES, 'zz-cover');
  const hadGames = existsSync(GAMES);
  try {
    mkdirSync(join(dir, 'extra'), { recursive: true });
    mkdirSync(join(dir, 'public'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@threedog/zz-cover', private: true, type: 'module', dependencies: { threedog: '*' } }, null, 2) + '\n');
    writeFileSync(join(dir, 'index.html'), '<!doctype html><canvas id="c"></canvas><script type="module" src="./main.js"></script>\n');
    writeFileSync(join(dir, 'main.js'), `// Cover fixture\nimport { createEngine } from 'threedog';\nimport { build } from './extra/part.js';\n\ncreateEngine({ canvas: document.querySelector('canvas') });\nbuild();\n`);
    // a wrong option name (the engine API check) and a redeclared block-scoped name (what the build rejected)
    writeFileSync(join(dir, 'extra', 'part.js'), `// @ts-check\nimport { createEngine } from 'threedog';\n\nexport function build() {\n  const B = 1;\n  const B = 2;\n  return createEngine({ canvas: document.querySelector('canvas'), styel: {} }) && B;\n}\n`);
    writeFileSync(join(dir, 'public', 'worker.js'), `// served as is, not game source\nconst x = 1; const x = 2;\n`);
    cli('map', '-w', 'games/zz-cover');

    const r = cli('check', '-w', 'games/zz-cover');
    check('check fails on a file in a folder that is not on any list', r.code === 1, r.out.split(/\r?\n/).slice(-6).join(' | '));
    check('the wrong option in extra/ is reported', /zz-cover\/extra\/part\.js:\d+ .*styel/.test(r.out), r.out.split(/\r?\n/).filter(l => /extra/.test(l)).slice(0, 3).join(' | '));
    check('the redeclared name in extra/ is reported', /zz-cover\/extra\/part\.js:\d+ .*(redeclare|already)/i.test(r.out), r.out.split(/\r?\n/).filter(l => /extra/.test(l)).slice(0, 4).join(' | '));
    check('public/ is not type-checked', !/zz-cover\/public\//.test(r.out), r.out.split(/\r?\n/).filter(l => /public/.test(l)).slice(0, 2).join(' | '));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (!hadGames && existsSync(GAMES) && !readdirSync(GAMES).length) rmdirSync(GAMES);
  }
}
