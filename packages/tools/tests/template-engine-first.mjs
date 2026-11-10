// A new game opens on the engine's path: three field runs on a template that said only "plain three.js" rewrote save, pause and menus by hand (more code than
// plain three.js). So save, Esc pause and the start screen stay wired in main.js, the "Already here" table stays the first section of CLAUDE.md, every row points
// at a recipe that exists, and the blank template stays genre-free (no player, no camera rig, no ground). Offline, reads files only.
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGINE, TOOLS } from '../paths.mjs';
import { render, copyTemplates } from '../lib/scaffold.mjs';

export const name = 'template engine first: save, pause and start screen wired; the Already here table leads; blank stays genre-free';

const read = (...p) => readFileSync(join(TOOLS, 'templates', ...p), 'utf8');
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');

export async function run({ check }) {
  for (const t of ['game', 'openworld']) {
    const main = code(read(t, 'main.js'));
    check(`${t}: autosave wired`, /engine\.saves\.autosave\(/.test(main));
    check(`${t}: the start screen is on (Continue is what loads the autosave)`, /title: \{ title: '__NAME__' \}/.test(main));
    check(`${t}: Esc pauses, not only opens the menu`, /settings(\(|: )\{ freezeWorld: true \}/.test(main));
  }
  check('the template names no style folder or style key: its picture is picture/', !/style\/|style\.\w/.test(read('game', 'DESIGN.md') + read('game', 'tsconfig.json') + read('game', 'assets.js'))
    && read('game', 'tsconfig.json').includes('"**/*.js"'));   // every game .js is type-checked, picture/ included (a list of known folders let other folders go unchecked)
  const blank = code(read('game', 'main.js'));
  check('blank assumes no player, camera rig or ground', !/addPlayer|followCamera|characters\(|openWorld|terrain|setGround/.test(blank));

  const claude = read('game', 'CLAUDE.md'), heads = [...claude.matchAll(/^## (.+)$/gm)].map(m => m[1]);
  check('Already here is the first section of the template CLAUDE.md', heads[0] === 'Already here', heads.join(' | '));
  // the table is cut from AI.md at new-game time: test the rendered text, as a new game gets it
  const table = render(claude, { name: 'x', openWorld: false, webgl: false }).replace(/__\w+__/g, '');
  const at = table.indexOf('## Already here'), intro = table.slice(at, table.indexOf('\n## ', at + 3));
  check('Already here tells where the rest is: threedog how', /threedog how "/.test(intro.slice(0, 1200)));
  // the full list of systems is checked against AI.md in doc-rules; here the words of the rendered intro, as a new game reads it
  for (const need of ['Save', 'Esc pause', 'quality', 'Keys', 'Camera', 'character', 'HUD', 'Sound', 'Terrain', 'Water', 'Grass']) check(`the table covers: ${need}`, intro.includes(need));
  // AGENTS.md: the same rendered text as CLAUDE.md for tools that do not read CLAUDE.md, written by copyTemplates beside it, never over an existing file
  const tmp = mkdtempSync(join(tmpdir(), 'td-agents-')), kept = mkdtempSync(join(tmpdir(), 'td-agents-kept-'));
  try {
    copyTemplates(tmp, { name: 'x', openWorld: false, webgl: false });
    check('copyTemplates writes AGENTS.md with exactly the text of CLAUDE.md', existsSync(join(tmp, 'AGENTS.md')) && readFileSync(join(tmp, 'AGENTS.md'), 'utf8') === readFileSync(join(tmp, 'CLAUDE.md'), 'utf8'));
    writeFileSync(join(kept, 'AGENTS.md'), 'mine');
    copyTemplates(kept, { name: 'x', openWorld: false, webgl: false });
    check('an existing AGENTS.md is kept (init into a project that has one)', readFileSync(join(kept, 'AGENTS.md'), 'utf8') === 'mine');
    // [guard] the per-machine .threedog/ is ignored by new-game (the template) and by init into a folder with its own .gitignore (one appended line, nothing else touched)
    const ign = d => readFileSync(join(d, '.gitignore'), 'utf8').split('\n').some(l => /^\/?\.threedog\/?$/.test(l.trim()));
    const own = mkdtempSync(join(tmpdir(), 'td-ign-')), ownIgn = mkdtempSync(join(tmpdir(), 'td-ign2-'));
    try {
      writeFileSync(join(own, '.gitignore'), 'node_modules\nmine.log');
      copyTemplates(own, { name: 'x', openWorld: false, webgl: false });
      writeFileSync(join(ownIgn, '.gitignore'), 'out\n.threedog\n');
      copyTemplates(ownIgn, { name: 'x', openWorld: false, webgl: false });
      check('[guard] .threedog/ is ignored after new-game and after init into a folder with its own .gitignore (one line appended, the rest kept, none added twice)',
        ign(tmp) && ign(own) && readFileSync(join(own, '.gitignore'), 'utf8') === 'node_modules\nmine.log\n.threedog/\n' && readFileSync(join(ownIgn, '.gitignore'), 'utf8') === 'out\n.threedog\n', readFileSync(join(own, '.gitignore'), 'utf8'));
    } finally { rmSync(own, { recursive: true, force: true }); rmSync(ownIgn, { recursive: true, force: true }); }
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(kept, { recursive: true, force: true }); }
  const recipes = readdirSync(join(ENGINE, 'docs', 'recipes')).map(f => f.slice(0, 2));
  const named = [...intro.matchAll(/\b(\d\d)-[a-z0-9-]+\.md/g)].map(m => m[1]);
  check('the table names recipes, and each exists', named.length >= 6 && named.every(n => recipes.includes(n)), named.join());
}
