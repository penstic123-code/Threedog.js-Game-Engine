// Error hints and tool output (review 2026-11-09): hints name real options and a next step, one meaning per error code, short default listings.
// Node side only: the sections / rig functions are pure, the rest reads the tables and runs the CLI.
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { listArt, artListText } from '../art.mjs';
import { label } from '../threedog/mcp-extra.mjs';
import { TOOLS, ENGINE } from '../paths.mjs';

export const name = 'hints group H: hints name real options and a next step, codes mean one thing, art list / unknown command stay short';

const eng = p => import(pathToFileURL(join(ENGINE, p)).href);   // computed path: the pure engine functions, loaded the way api-count loads errorCodes
const src = p => readFileSync(join(ENGINE, p), 'utf8');

export async function run({ check }) {
  const { ERROR_CODES } = await eng('core/base/errorCodes.js'), { runSections } = await eng('core/base/sections.js'), { rigFromObject } = await eng('modules/characters/proceduralRig.js');
  const said = [], warn = console.warn;
  console.warn = (...a) => said.push(a.join(' '));
  try {
    // the undo hint names the section and the next step
    const bad = { name: 'quests', owner: 'questsModule', commit() {}, undo: () => () => { throw new Error('boom'); } };
    let thrown = null;
    try { runSections([{ s: bad, data: 1 }, { s: { name: 'later', owner: 'm2', commit() { throw new Error('second fails'); } }, data: 2 }], {}); } catch (e) { thrown = e; }
    const msg = said.find(s => /undo/.test(s)) ?? '';
    check('a failed undo names the section, its module and what to do', thrown && /section 'quests'/.test(msg) && /questsModule/.test(msg) && /reload the page/.test(msg), msg);
    // the rig-name hint says what to change
    rigFromObject({ name: 'hero', userData: { rig: { body: 'nope' } }, getObjectByName: () => null });
    check('a rig name with no object says how to fix it', said.some(s => /nope/.test(s) && /getObjectByName/.test(s)), said.join('\n'));
  } finally { console.warn = warn; }

  // one meaning per code
  check('new codes are registered with a fix and docs', ['time-owner-conflict', 'rollback-incomplete'].every(c => ERROR_CODES[c]?.fix && ERROR_CODES[c]?.docs?.length));
  check('settings-tab fix names `sections`, not the removed `tabs` option', /settings\(\{ sections \}\)/.test(ERROR_CODES['settings-tab'].fix) && !/\{ tabs \}/.test(ERROR_CODES['settings-tab'].fix));
  check('calendar and sky report the time conflict under one code', /coded\('time-owner-conflict'/.test(src('modules/calendar/index.js')) && /coded\('time-owner-conflict'/.test(src('modules/sky/skyModule.js')));
  check('a sound entry of the wrong type is asset-misuse; an incomplete rollback is its own code',
    /codedError\('asset-misuse'.*not a sound/.test(src('core/audio/audioVoice.js')) && /'rollback-incomplete'/.test(src('core/saves/saveApply.js')) && /'rollback-incomplete'/.test(src('core/ops/opsAtomic.js')));

  // wording that must match the behaviour
  check('state is labelled as moving time only with wait; press says it simulates input', /unless wait/.test(label('state')) && !/real keyboard/.test(readFileSync(join(TOOLS, 'threedog/mcp.mjs'), 'utf8')));

  // art list: short by default, --full for all
  const tmp = mkdtempSync(join(tmpdir(), 'td-artlist-'));
  try {
    mkdirSync(join(tmp, 'g', 'art'), { recursive: true });
    writeFileSync(join(tmp, 'g', 'package.json'), '{"name":"g"}');
    for (let i = 0; i < 9; i++) writeFileSync(join(tmp, 'g', 'art', `m${i}.js`), `/** thing ${i} */\nexport function make${i}() {}\n`);
    const r = listArt(join(tmp, 'g'), tmp), short = artListText(r, false, 'g', 'g'), full = artListText(r, true, 'g', 'g');
    check('art list shows the first few and names --full; --full lists all', short.length < full.length && short.some(l => /--full/.test(l)) && full.some(l => /m8\.js/.test(l)) && !short.some(l => /m8\.js/.test(l)), short.join('\n'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }

  // unknown command: one line
  const u = spawnSync(process.execPath, [join(TOOLS, 'bin/threedog.mjs'), 'qq-no-such-cmd'], { encoding: 'utf8' });
  check('an unknown command prints one line pointing to --help, exit 1', u.status === 1 && (u.stderr + u.stdout).trim().split('\n').length === 1 && /--help/.test(u.stderr + u.stdout), u.stderr + u.stdout);
}
