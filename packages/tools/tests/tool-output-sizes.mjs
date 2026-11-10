// Answer first, details on request: every AI-facing bridge command's DEFAULT output on the world example stays under a byte budget, so it cannot
// creep back. Why: scene printed ~15 KB (46 KB as an MCP result), catalog 50 lines of "ops: — · saves: —", and the describeText summary cut the
// game's own describe.add sections off the end. Sizes before / after: docs/testing/tool-output-sizes.md.
// One dev server on the engine package (headless page), commands run through execute() as the CLI and the MCP server do.
import { createServer } from 'vite';
import { ENGINE, viteOptions } from '../paths.mjs';
import { execute } from '../threedog/dispatch.mjs';
import { bridgeDriver } from '../threedog/connect.mjs';
import { perfNotice } from '../lib/perf-baseline.mjs';
import { nameHintLines } from '../assets-check/names.mjs';
import { shortData, DATA_MAX } from '../threedog/mcp-extra.mjs';
import { errorsCommand } from '../threedog/errorlog.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

export const name = 'tool output sizes: each AI-facing command\'s default output on the world example stays under its byte budget (text and MCP result)';

// command line → text budget in bytes. ~4 KB is the general ceiling ("fits in ~40 lines"); the small ones get a tighter one so a 3-line answer
// that grows to 30 is caught too. The MCP result (text + structuredContent after shortData) gets text + DATA_MAX + a little for the envelope.
const BUDGET = {
  'describe': 800, 'describe --full': 4000, 'inspect': 800, 'inspect materials': 2600, 'inspect perf': 1500, 'ops': 1000,
  'errors latest 20': 4000, 'loading': 600, 'scene': 4000, 'pick 480,270': 800, 'catalog': 2000, 'explain thing player': 1000,
  'explain quest first-light': 800, 'catalog inventory': 4000, 'snap size-guard --no-picture': 800,
  'verify barter': 2600,   // measured with its Perf: line present (a budget it is over, set just before); it leaves the page halted, so it runs late
  'status': 600,   // last: before the first page command the headless page may not be open yet
};

/** threedog verify and this machine's .threedog/perf-baseline.json: --save-baseline writes it under the new key (GPU, canvas size, pixel ratio,
 * camera), a slower run from the same key prints the line, another key prints nothing, a broken file is a one-line note (the run stands) */
async function perfBaselineChecks(check) {
  const file = join(ENGINE, '.threedog', 'perf-baseline.json'), kept = existsSync(file) ? readFileSync(file, 'utf8') : null;
  // barter's basket sells out after a few runs on one page: the verdict may be FAIL, the perf line is what these checks read
  const run = async (...a) => (await execute(ENGINE, 'verify', ['barter', ...a])).text;
  try {
    await execute(ENGINE, 'js', ['engine.budget.disable(); return 1']);
    rmSync(file, { force: true });
    const saved = await run('--save-baseline'), base = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}, key = Object.keys(base)[0] ?? '';
    check('[guard] verify --save-baseline writes .threedog/perf-baseline.json under a key with the GPU, canvas size and pixel ratio',
      / \d+x\d+@[\d.]+ @/.test(key) && base[key].drawCalls > 0 && /Perf baseline saved for this machine/.test(saved), saved.slice(0, 400));
    writeFileSync(file, JSON.stringify({ [key]: { ...base[key], drawCalls: Math.floor(base[key].drawCalls / 2) } }));
    const slower = await run();
    check('[guard] a run from the same key with more draw calls than the baseline prints the slower line', /^Perf: slower than baseline: .*drawCalls \d+ \(was \d+/m.test(slower), slower.slice(0, 400));
    writeFileSync(file, JSON.stringify({ [key.replace(/ \d+x\d+@/, ' 1x1@')]: { ...base[key], drawCalls: 1 } }));
    const other = await run();
    check('[guard] a baseline under another key (canvas size) compares nothing', !/slower than baseline/.test(other), other.slice(0, 400));
    writeFileSync(file, '{ broken');
    const broken = await run();
    check('[guard] an unreadable baseline is a one-line note; the run still reports', /^Perf: \.threedog\/perf-baseline\.json unreadable/m.test(broken) && /^[✓✗] verify barter: /.test(broken), broken.slice(0, 400));
  } finally {
    if (kept != null) writeFileSync(file, kept); else rmSync(file, { force: true });
  }
}

export async function run({ check }) {
  // shortData: a big MCP payload keeps its small fields and names the --json call; a small one passes untouched
  const big = { counts: { total: 3 }, items: Array.from({ length: 200 }, (_, i) => ({ name: 'x' + i, why: 'outside the view'.repeat(3) })) };
  const sd = shortData(big, 'scene');
  check('[guard] shortData: a payload over DATA_MAX keeps small fields, notes the big ones, names threedog <cmd> --json; a small one is unchanged',
    sd.counts.total === 3 && sd.items === '[200 items]' && /threedog scene --json/.test(sd.omitted) && JSON.stringify(sd).length < DATA_MAX
    && shortData({ a: 1 }, 'x').a === 1, JSON.stringify(sd));

  const server = await createServer(await viteOptions(ENGINE, { server: { port: 0, host: 'localhost' }, logLevel: 'error' }));
  await server.listen();
  try {
    const over = [], sizes = [];
    let noticed = 'verify never ran';
    for (const [line, max] of Object.entries(BUDGET)) {
      const [cmd, ...args] = line.split(' ');
      if (cmd === 'verify') await execute(ENGINE, 'js', ['engine.budget.enable({ drawCalls: 1 }); return 1']);
      const r = await execute(ENGINE, cmd, args), bytes = Buffer.byteLength(r.text);
      if (cmd === 'verify') noticed = /^Perf: over budget drawCalls \d+ \(limit 1, /m.test(r.text) ? '' : r.text.slice(0, 300);
      const { text, ...st } = r, mcp = Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text }], structuredContent: { ...st, data: shortData(st.data, cmd) } }));
      sizes.push(`${line} ${bytes}/${mcp}`);
      // a command that could not run is short, which would pass by accident; "blocked" (ran, found a problem: a stuck quest) is a real answer
      if (!['ok', 'blocked'].includes(r.code)) over.push(`${line}: did not run (${r.code}: ${r.text.split('\n')[0]})`);
      if (bytes > max) over.push(`${line}: text ${bytes} > ${max}`);
      if (mcp > max + DATA_MAX + 1500) over.push(`${line}: MCP result ${mcp} > ${max + DATA_MAX + 1500}`);
    }
    check(`[guard] every command's default text and MCP result are within budget (${Object.keys(BUDGET).length} commands)`, !over.length, over.join(' · ') || sizes.join(' · '));
    check('[guard] verify prints the Perf: line when the run ends over the game\'s declared budget (and is measured with it)', !noticed, noticed);
    await perfBaselineChecks(check);
    // describeText on the world page (its 30-line summary is full: some module lines are cut): a describe.add section survives the cut, the cut
    // modules are named, the engine tables are one count line
    const dt = await execute(ENGINE, 'js', ['const h = engine.describe.add("sizeGuard", () => ({ points: 7 })); const t = engine.describeText(); h.remove(); return t', '--max', '9000']);
    const txt = String(JSON.parse(dt.text.replace(/^✓ /, ''))), tl = txt.split('\n');
    check('[guard] describeText summary: a describe.add section is kept (before module lines), cut modules are named, engine tables are one count line',
      tl.length <= 30 && tl.includes('sizeGuard: points=7') && /more modules: /.test(txt) && /Engine tables .*shared \d+/.test(txt) && !/^shared:/m.test(txt), txt);
    // the "Values being changed now" line: five rows of long names / many-owner how-chains / newlines stay one bounded line that points to describe shared
    const { describeText } = await import(pathToFileURL(join(ENGINE, 'core/inspect/describeText.js')).href);
    const long = 'x'.repeat(300), crowd = Array.from({ length: 40 }, (_, i) => `owner${i} ${i}`).join(' × ');
    const cl = describeText({ time: { real: 0 }, loading: { done: true, failed: [], warnings: [] }, modules: [], perf: { drawCalls: 0, triangles: 0 }, camera: { type: 'follow', x: 0, y: 0, z: 0, focus: { x: 0, z: 0 } }, ui: { windows: [] }, nearby: [], nearbyRadius: 30,
      changed: Array.from({ length: 5 }, (_, i) => ({ text: `${long}${i}\nline2 1 → 2 (${crowd})` })) }).split('\n').filter(l => l.startsWith('Values being changed now'));
    check('[guard] describeText "Values being changed now": 5 long rows are one line under 450 bytes, newlines escaped, pointing to describe shared',
      cl.length === 1 && Buffer.byteLength(cl[0]) < 450 && cl[0].includes('describe shared'), String(cl[0]?.length));
    // assets check name hints: 500 odd names in a model stay one line per kind under a byte cap (the full list is --full)
    const hint = nameHintLines(Array.from({ length: 500 }, (_, i) => ({ code: i % 2 ? 'sanitized-name' : 'renamed-name', name: `node "Wall.${i}" [Root/Wall.${i}] -> Wall${i}` })), false);
    check('[guard] assets check name hints: 500 names are 2 lines, each under 520 bytes', hint.length === 2 && hint.every(l => Buffer.byteLength(l) < 520), hint.map(l => Buffer.byteLength(l)).join(','));
    const lost = await perfNotice(() => Promise.reject(new Error('window.engine is undefined')), mkdtempSync(join(tmpdir(), 'td-perf-')), false).catch(e => e);
    check('[guard] the verify closing perf notice does not throw when the page has no engine (the FAIL report must still print)', !(lost instanceof Error) && lost.notice === null, String(lost));
    const sc = await execute(ENGINE, 'scene', []);
    check('scene: says the reason counts over all undrawn objects and how to get more', /Not drawn because: /.test(sc.text) && /--limit N/.test(sc.text), sc.text.slice(0, 300));
    const cat = await execute(ENGINE, 'catalog', ['--full']), catShort = await execute(ENGINE, 'catalog', []);
    check('catalog --full keeps one line per module; the default names the rest on one line per kind', cat.text.split('\n').length > catShort.text.split('\n').length
      && /modules without ops: |capabilities: /.test(catShort.text), catShort.text.slice(0, 300));
    const only = await execute(ENGINE, 'js', ['JSON.stringify([Object.keys(engine.describe("picture")), Object.keys(engine.describe({ only: ["time", "nope"] }))])']);
    check('describe(name) / describe({ only }) return just those sections; an unknown name is reported, not dropped silently',
      /\[\["picture"\],\["time","unknownSections","sections"\]\]/.test(only.text.replace(/\\"/g, '"')), only.text);
    // describe({ only }) builds just those sections: each one equals the same section of the whole object (one synchronous eval: same tick).
    // A module's own section, a section hooks write into (time, player, camera, nearby) and engine tables (picture, shared: hooks skipped)
    const same = await execute(ENGINE, 'js', ['const all = engine.describe(), mod = [...engine.modules.values()].find(m => m.describe && all[m.name] !== undefined)?.name; '
      + 'const ks = ["picture", "shared", "slots", "time", "player", "camera", "nearby", "ui", mod]; '
      + 'return JSON.stringify({ mod, diff: ks.filter(k => JSON.stringify(engine.describe(k)[k]) !== JSON.stringify(all[k])), '
      + 'pair: JSON.stringify(engine.describe({ only: ["picture", "time"] })) === JSON.stringify({ picture: all.picture, time: all.time }) })']);
    const sm = JSON.parse(JSON.parse(same.text.replace(/^✓ /, '')));
    check('describe({ only }): every asked section equals the same section of the full describe()', sm.mod && !sm.diff.length && sm.pair, same.text);
    const mat = await execute(ENGINE, 'js', ['const r = engine.inspect.materials(), lines = r.text.split("\\n").slice(1 + r.issues.length).filter(l => !l.startsWith("…")); '
      + 'return JSON.stringify({ n: r.count, lines: lines.length, alike: lines.filter(l => / · ×\\d+ materials alike$/.test(l)).length, dup: lines.length - new Set(lines).size, '
      + 'sum: lines.reduce((s, l) => s + Number(/×(\\d+) materials alike$/.exec(l)?.[1] ?? 1), 0) + Number(/^… (\\d+) more/m.exec(r.text)?.[1] ?? 0) })']);
    const mr = JSON.parse(JSON.parse(mat.text.replace(/^✓ /, '')));
    check('inspect materials: materials that read the same are one line with ×N; the lines (and "… N more") add up to every material', !mr.dup && mr.sum === mr.n, mat.text);
    // errors: the same error repeated as several records is one line with its first and last id / time and the summed count
    const ws = mkdtempSync(join(tmpdir(), 'td-errors-')), blk = (t, tick, msg) => `[browser error] ${t} tick ${tick}\npage| /index.html\npage| ${msg}\npage|     at f (main.js:3:4)\n`;
    mkdirSync(join(ws, '.threedog'));
    writeFileSync(join(ws, '.threedog/errors.log'), 'cleared\n' + blk('12:00:01', 5, 'boom') + blk('12:00:02', 6, 'other') + blk('12:00:03', 7, 'boom') + blk('12:00:09', 80, 'boom'));
    const el = errorsCommand(ws, ['latest', '20'], {}).text;
    rmSync(ws, { recursive: true, force: true });
    check('errors latest: repeats of one error are one line "E1 … E4 ×3" with first and last time; different errors keep their own line',
      /^✗ latest 4 of 4: 4 errors \(2 different\)$/m.test(el) && /^E1 12:00:01 tick 5 … E4 12:00:09 tick 80 ×3 error .*boom/m.test(el) && /^E2 12:00:02 tick 6 error .*other/m.test(el)
      && el.split('\n').length === 4, el);
  } finally {
    await bridgeDriver(ENGINE, {}).closeHeadless().catch(() => {});
    await server.close();
  }
}
