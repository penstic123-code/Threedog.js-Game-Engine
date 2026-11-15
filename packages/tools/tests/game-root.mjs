// Which folder a command acts on, for a game nested inside a repository with npm workspaces (or kept anywhere outside games/ of this repo).
// 为什么要这条检查：一次真实试玩里游戏放在 .demo/town-farm，`threedog init .demo/town-farm` 把文件写进了仓库根并合并了根 package.json，
// 游戏里的 npm run dev / check 作用到外层（"dev: packages/engine"），`check -w .` 报 not found，游戏自己的检查一次都没跑。
// Everything runs in child processes: paths.mjs resolves the project once from its process's cwd.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, TOOLS, rel } from '../paths.mjs';

export const name = 'game root: init <folder> scaffolds there (never the repo root), commands inside a nested game act on that game, -w . works';

// init registers the game in the hub list under THREEDOG_HOME: a temp home keeps this test away from the real one
const home = mkdtempSync(join(tmpdir(), 'threedog-home-'));
const cli = (cwd, ...args) => spawnSync(process.execPath, [join(TOOLS, 'bin', 'threedog.mjs'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, THREEDOG_HOME: home } });
/** What paths.mjs decides from cwd: mode, root, the workspace with no -w and with the extra args */
const resolveIn = (cwd, args = []) => {
  const src = `const p = await import(${JSON.stringify(pathToFileURL(join(TOOLS, 'paths.mjs')).href)});
    let w; try { w = p.command(${JSON.stringify(args)}).dir; } catch (e) { w = 'ERR ' + e.message; }
    console.log(JSON.stringify({ mode: p.MODE, root: p.ROOT, here: p.workspaceFor(undefined), w }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { cwd, encoding: 'utf8' });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { err: r.stderr }; }
};
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export async function run({ check }) {
  // ── a fake repository with npm workspaces, outside this one ──
  const repo = mkdtempSync(join(tmpdir(), 'threedog-ws-'));
  const rootPkg = JSON.stringify({ name: 'some-repo', private: true, workspaces: ['games/*'] }, null, 2) + '\n';
  writeFileSync(join(repo, 'package.json'), rootPkg);
  // a game nested in this repository but outside games/ (where the demo was)
  const nested = join(ROOT, '.threedog', 'zz-nested-game');
  try {
    const made = cli(repo, 'init', 'games/farm');
    const game = join(repo, 'games', 'farm');
    check('init <folder> exits 0', made.status === 0, made.stderr.slice(-300));
    check('init <folder> writes the game into that folder', existsSync(join(game, 'main.js')) && existsSync(join(game, 'package.json')));
    check('init <folder> leaves the repo root alone (no main.js, package.json byte-identical)', !existsSync(join(repo, 'main.js')) && readFileSync(join(repo, 'package.json'), 'utf8') === rootPkg);
    check('the game is named after its folder', JSON.parse(readFileSync(join(game, 'package.json'), 'utf8')).name === 'farm');
    // [guard] what the folder already had must not leave a game that cannot load or a tool that does not connect
    const had = join(repo, 'had');
    mkdirSync(had);
    writeFileSync(join(had, 'package.json'), JSON.stringify({ name: 'had', type: 'commonjs', scripts: { test: 'echo "Error: no test specified" && exit 1', lint: 'x' } }));
    writeFileSync(join(had, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'o' } } }));
    const merged = cli(had, 'init'), hadPkg = JSON.parse(readFileSync(join(had, 'package.json'), 'utf8')), hadMcp = JSON.parse(readFileSync(join(had, '.mcp.json'), 'utf8'));
    check('[guard] init turns "type": "commonjs" into module and says so: content/*.js cannot load otherwise', hadPkg.type === 'module' && /"type" was "commonjs"/.test(merged.stdout), merged.stdout);
    check('[guard] init replaces only npm\'s placeholder test script', hadPkg.scripts.test === 'threedog test' && hadPkg.scripts.lint === 'x', JSON.stringify(hadPkg.scripts));
    check('[guard] init adds the threedog server to an .mcp.json that lacks it and keeps the rest', !!hadMcp.mcpServers.threedog && !!hadMcp.mcpServers.other, JSON.stringify(hadMcp));
    // [guard] map: every engine.use is read, and a content file that does not load fails it instead of passing as a game without that file
    const hadMain = join(had, 'main.js');
    writeFileSync(hadMain, readFileSync(hadMain, 'utf8') + '\nengine.use(firstExtra());\n// engine.use(commentedOut());\nengine.use(secondExtra());\n');
    const mapped = cli(had, 'map'), hadMap = join(had, 'GAMEMAP.md');
    check('[guard] map reads every engine.use call and no commented one', mapped.status === 0 && /firstExtra/.test(readFileSync(hadMap, 'utf8')) && /secondExtra/.test(readFileSync(hadMap, 'utf8')) && !/commentedOut/.test(readFileSync(hadMap, 'utf8')), mapped.stdout + mapped.stderr);
    const mapText = readFileSync(hadMap, 'utf8');
    writeFileSync(join(had, 'content', 'items.js'), 'export default { oops: ;\n');
    const brokenMap = cli(had, 'map');
    check('[guard] map fails on a content file that cannot load, names it and leaves the map alone', brokenMap.status === 1 && /items\.js/.test(brokenMap.stderr) && readFileSync(hadMap, 'utf8') === mapText, brokenMap.stdout + brokenMap.stderr);
    // [guard] vite cannot work under a # in the path: the tool says so, instead of vite's stack or "wait a few seconds"
    const hash = join(repo, 'a#b');
    mkdirSync(hash);
    writeFileSync(join(hash, 'package.json'), JSON.stringify({ name: 'hash', type: 'module', dependencies: { threedog: '*' } }));
    const hashBuild = cli(hash, 'build'), hashPlay = await (await import('../threedog/play.mjs')).play(hash);
    check('[guard] build and play in a folder with # say why they cannot run', hashBuild.status !== 0 && /path has a #/.test(hashBuild.stderr) && !hashPlay.ok && /path has a #/.test(hashPlay.text), hashBuild.stderr + hashPlay.text);
    // [guard] every folder of Chinese letters was the game 'game': one saveKey, so one save, for all of them on the same address
    const cn = ['小岛', '农场'].map(n => { const d = join(repo, n); cli(repo, 'init', n); return JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).name; });
    check('[guard] folders named in Chinese get different names, valid for npm', cn[0] !== cn[1] && cn.every(n => /^game-[0-9a-f]{6}$/.test(n)), cn.join(' '));
    check('[guard] the name reaches the saveKey', readFileSync(join(repo, '小岛', 'main.js'), 'utf8').includes(`saveKey: '${cn[0]}'`));
    // ── a newcomer's folder: tools installed with -D first, nothing else there ──
    const fresh = join(repo, 'fresh');
    mkdirSync(fresh);
    writeFileSync(join(fresh, 'package.json'), JSON.stringify({ name: 'fresh', devDependencies: { '@threedog/tools': '^0.7.1' } }));
    const first = cli(fresh, 'init', '--open-world');
    check('init on a new folder says it kept nothing it made itself', first.status === 0 && !/existing files kept \(.*main\.js/.test(first.stdout), first.stdout);
    const freshPkg = JSON.parse(readFileSync(join(fresh, 'package.json'), 'utf8'));
    check('a package already in devDependencies is not added to dependencies too', !freshPkg.dependencies['@threedog/tools'] && !!freshPkg.devDependencies['@threedog/tools'], JSON.stringify(freshPkg));
    check('init writes GAMEMAP.md, or says when to', existsSync(join(fresh, 'GAMEMAP.md')) || first.stdout.includes('npx threedog map'), first.stdout);
    const board = cli(repo, 'art', 'board');
    check('art board in a workspaces root refuses and writes nothing there', board.status !== 0 && /repository root/.test(board.stdout + board.stderr) && !existsSync(join(repo, '.threedog')), (board.stdout + board.stderr).slice(-300));
    const atRoot = cli(repo, 'init');
    check('init in a workspaces root refuses and names the fix', atRoot.status === 1 && /repository root.*threedog init games\/my-game/.test(atRoot.stderr), atRoot.stderr.slice(-300));

    const g = resolveIn(game, ['-w', '.']);
    check('inside a game nested in a workspaces repo: game mode rooted at the game', g.mode === 'game' && same(g.root, game), JSON.stringify(g));
    check('no -w: the command acts on that game (dev / check / test / map)', same(g.here, game), JSON.stringify(g));
    check('-w . names the game of the current folder', same(g.w, game), JSON.stringify(g));

    // ── a game inside this monorepo but not in games/ ──
    // [guard] a game under the repository that holds the tools: the path in .mcp.json must reach them from the game, it pointed at a node_modules the game does not have
    const inRepo = join(ROOT, '.threedog', 'zz-init-game');
    cli(ROOT, 'init', rel(inRepo));
    const mcpBin = JSON.parse(readFileSync(join(inRepo, '.mcp.json'), 'utf8')).mcpServers.threedog.args[0];
    check('[guard] init <folder> inside the repository writes an .mcp.json path that exists', existsSync(join(inRepo, mcpBin)), mcpBin);
    rmSync(inRepo, { recursive: true, force: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'zz-nested-game', private: true, type: 'module', dependencies: { threedog: '*' } }));
    writeFileSync(join(nested, 'main.js'), 'const drop = Math.random();\n');
    const n = resolveIn(nested, ['-w', '.']);
    check('a game nested in this monorepo outside games/ is its own project', n.mode === 'game' && same(n.root, nested) && same(n.w, nested), JSON.stringify(n));
    const hints = cli(nested, 'check', '--rule', 'R40', '--all');
    check('R40 reads the code of a game in its own repo, not the engine examples', /main\.js:1 .*Math\.random/.test(hints.stdout) && !/examples\//.test(hints.stdout), hints.stdout.slice(-400));
    const m = resolveIn(ROOT, ['-w', '.threedog/zz-nested-game']);
    check('the monorepo root stays monorepo mode', m.mode === 'monorepo' && same(m.root, ROOT), JSON.stringify(m));
    check('-w <that game> from the root says to run the command inside it', /game folder of its own: cd .* and run the command there, without -w/.test(m.w), m.w);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(nested, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}
