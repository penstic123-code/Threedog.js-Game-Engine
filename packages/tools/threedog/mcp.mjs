// threedog mcp: an MCP (Model Context Protocol) server over stdio that wraps the dev bridge, so MCP clients (Claude Code, Cursor...) drive the running game
// natively.
//   claude mcp add threedog -- node node_modules/@threedog/tools/bin/threedog.mjs mcp          (see recipes/16-dev-bridge.md section 10)
//   threedog mcp [-w game] [--page /tests/city/index.html] [--allow-js]
// One tool per bridge command; each runs the same commands.mjs code as the command line, so output and errors are identical.
// Transport: newline-delimited JSON-RPC 2.0 on stdin / stdout (the small subset MCP needs: initialize, ping, tools/list, tools/call).
//   Hand-written instead of @modelcontextprotocol/sdk, which pulls in express, hono, ajv, zod and more (several MB) for what is ~100 lines here.
// Security: this process only talks to the bridge as a local client (token from .threedog/dev.json, no Origin header); it opens no listener.
//   The js tool (arbitrary code in the page) exists only with --allow-js.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { command, ENGINE } from '../paths.mjs';
import { pagePath as pageArg } from '../lib/cli-args.mjs';
import { join } from 'node:path';
import { execute } from './dispatch.mjs';
import { EXTRA_TOOLS, STATIC_TOOLS, label, RESULT_SHAPE, OUTPUT_SCHEMA, situationGuide, shortData, pairs, FREEZE, freezeArg } from './mcp-extra.mjs';
import { NONE } from './runtime.mjs';

// stdout carries protocol messages only: anything else that prints goes to stderr
console.log = console.info = console.warn = console.error;

let dir, pagePath, allowJs;
try {
  const { dir: d, opt } = command(process.argv.slice(2), { live: true, flags: ['allow-js'], values: ['page'] });
  dir = d; allowJs = !!opt['allow-js']; pagePath = opt.page === undefined ? undefined : pageArg(opt.page);
} catch (e) { console.error('threedog mcp: ' + e.message); process.exit(1); }
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// ── Tools ─────────────────────────────────────────────
const str = description => ({ type: 'string', description });
const num = description => ({ type: 'number', description });
const obj = (properties = {}, required = [], extra = {}) => ({ type: 'object', properties, required, ...extra });
const SNAP_WIDTH = 480;   // screenshots come back small: numbers first, one image per round (recipe 35)
const MAX = num('Output cap in characters (default 500)');
const opt = (name, v) => v === undefined || v === null || v === '' ? [] : [name, String(v)];

/** name → { description, schema, args(input) → command line args, cmd? (bridge command, default the name) } */
const TOOLS = {
  describe: {
    description: 'Look at the running game: no args = 3-line summary; path = one field as JSON; full = text summary. Use first, before screenshots, to check logic.',
    schema: obj({ path: str('Dotted path into engine.describe() (returned as JSON), e.g. "player.position", "quests.active", "nearby", "ui" or a game describe.add name'),
      full: { type: 'boolean', description: 'The text summary (describeText, at most 30 lines) instead of the 3-line one' },
      all: { type: 'boolean', description: 'Everything (describeText({ full: true })); large' }, max: MAX }),
    args: a => [...(a.full ? ['--full'] : []), ...(a.all ? ['--all'] : []), ...(a.path ? [a.path] : []), ...opt('--max', a.max)],
  },
  step: {
    description: 'Advance the game N real seconds, deterministically (a real page is halted first; resume afterwards). Changes this session only, not the level (edit content/*.js for that).',
    schema: obj({ seconds: num('Real seconds to advance (default 1)') }),
    args: a => [String(a.seconds ?? 1)],
  },
  press: {
    description: 'Simulate an action or key press through engine.input (about 0.117 game s: 0.1 s held + one frame). Pauses a real page. Does not verify physical browser input.',
    schema: obj({ key: str('Action name ("interact", "jump", "menu") or key code ("KeyE", "Space", "Escape", "e")'), for: num('Hold time in seconds (default 0.1, minimum one frame)') }, ['key']),
    args: a => [a.key, ...opt('--for', a.for)],
  },
  hold: {
    description: 'Hold an input action or key for N real seconds (e.g. moveForward 1.5 to walk). Pauses a real page.',
    schema: obj({ key: str('Action name or key code'), seconds: num('How long to hold, in real seconds (default 1)') }, ['key']),
    args: a => [a.key, String(a.seconds ?? 1)],
  },
  skip: {
    description: 'Jump the clock like sleeping (to a time of day or by N seconds); the sky clock and time-keeping modules catch up. Pauses a real page.',
    schema: obj({ to: str('Clock time to jump to, e.g. "06:00" (give to OR seconds)'), seconds: num('Calendar seconds to jump (give seconds OR to)'),
      fade: num('Optional fade length in seconds, e.g. 0.6'), save: str('Optional: "auto" to save after the jump') }),
    args: a => Object.entries(a).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${v}`),
  },
  state: {
    description: 'Jump the scene to a state (like URL parameters) to set up a test situation. For gameplay actions use op.',
    schema: obj({ time: str('Clock time, e.g. "18:30"'), weather: str('Weather name, e.g. "rain"'), pos: str('Player position "x,z", e.g. "40,-20"'),
      wait: str('Real seconds to advance after applying'), cutscene: str('"skip" to skip cutscenes'), save: str('Save slot name to load (this does not write a save)'),
        state: str('A named state (engine.defineState)') },
    [], { additionalProperties: { type: 'string' } }),
    args: a => Object.entries(a).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`),
  },
  ops: {
    description: 'List what the player can do now: each op offer checked with can(), runnable or not with the reason. Use before op.',
    schema: obj(),
    args: () => [],
  },
  catalog: {
    description: 'What the game can do, read from its registrations: no id = a line per module with ops or problems, the rest named on one line (full: a line each); an id = that module or op in detail. Ask before reading API docs.',
    schema: obj({ id: str('Optional: a module id ("sky"; its params, ops, saved parts, time hooks, problems, source / doc files), an op name ("shop.buy": args, failure codes, last attempt), "core" (engine-provided parts), "game" (this game\'s own) or "picture" (each picture capability: on, runs here, cost, how, limits; then the combination checks)'), find: str('Optional: filter the list by a word'), full: { type: 'boolean', description: 'One line for every module' } }),
    args: a => [...(a.id ? [a.id] : []), ...opt('--find', a.find), ...(a.full ? ['--full'] : [])],
  },
  op: {
    description: 'Run a game op (e.g. shop.buy) as source bridge, no time passes: the way to change game state. Result: value and bag, or the failure reason. ops lists them.',
    schema: obj({ name: str('Op name, e.g. "shop.buy"'),
      args: { type: 'object', description: 'Op arguments, converted by the op\'s args shape, e.g. { "shop": "bakery", "item": "bread", "n": 2 }; positions as [x, y, z]',
      additionalProperties: true } }, ['name']),
    args: a => [a.name, ...pairs(a.args)],
  },
  inspect: {
    description: 'What is around the player (or an actor id / a spot) and which ops can run there now, with reasons why not. target "materials": textures, color-space errors, VRAM; "perf": frame cost vs budgets.',
    schema: obj({ target: str('Optional: an actor id such as "npc_3", a spot "x,z" such as "10,-4", "materials" or "perf"') }),
    args: a => a.target ? [String(a.target)] : [],
  },
  pick: {
    description: 'The world record under a screen pixel: id, kind, template, where it is defined (file:line), fields. Use to find which content entry to edit.',
    schema: obj({ x: num('Pixels from the left edge of the game canvas'), y: num('Pixels from the top edge of the game canvas') }, ['x', 'y']),
    args: a => [`${a.x},${a.y}`],
  },
  explain: {
    description: 'Why something is as it is: an op that cannot run, a stuck quest, who wrote a value, everything about one id. Use before changing an object.',
    schema: obj({ about: str('"op" (name = the op, args = its arguments) or "quest" (name = the quest id), or "value" (name = a value such as fog.far: which line last changed it), "thing" (name = an id from describe, scene or pick; full gives its JSON), "module", "capability", or another key a module explains'), name: str('The op name, quest id, value, thing id, module or capability'),
      args: { type: 'object', description: 'Op arguments (about "op" only)', additionalProperties: true }, full: { type: 'boolean', description: 'Add the detail (a thing: its whole JSON)' } }, ['about', 'name']),
    args: a => [a.about, a.name, ...(a.about === 'op' ? pairs(a.args) : []), ...(a.full ? ['--full'] : [])],
  },
  errors: {
    description: 'Page errors with id, time, tick, source, count and, for known classes, the likely cause and doc page. Default: new since the last call. Check after a change.',
    schema: obj({ latest: num('Show the last N errors (e.g. 3); the same ones show again on the next call'), since: str('Error id such as "E5" or "5": list only what came after; never moves the read position') }),
    args: a => a.latest ? ['latest', String(a.latest)] : a.since ? ['--since', String(a.since)] : [],
  },
  loading: {
    description: 'What loading waits for, which assets failed (file, HTTP status, fallback) and whether startup is blocked. Works while start() is stuck.',
    schema: obj({ name: str('Optional: one task by asset, module or track() name, with its manifest and path') }),
    args: a => a.name ? [a.name] : [],
  },
  snap: {
    description: 'Screenshot as a small image (480 px wide; full file in .threedog/shots/) plus the picture check of threedog shot on the live page (glare and its source, shadows, noon / midnight). Read those lines before the image.',
    schema: obj({ name: str('File name without extension (default "snap")'), size: num('Image width in pixels (default 480); raise it only to read fine detail'),
      play: { type: 'boolean', description: 'First leave the title screen the way its Start does, as threedog shot --play' } }),
    args: a => [...(a.name ? [a.name] : []), ...(a.play ? ['--play'] : []), '--width', String(a.size > 0 ? a.size : SNAP_WIDTH)],
  },
  picture_palette: {
    cmd: 'picture-palette',
    description: 'Measure a reference picture: main colors with share, hue, brightness and a summary line. Start of any picture work; read before guessing colors. Needs no game.',
    schema: obj({ image: str('Picture file (png, jpg, webp), relative to the game folder'), n: num('How many colors (2 to 32, default 8)'),
      average: { type: 'boolean', description: 'Also the overall mean color (use it for exposure and tint)' },
      ignore_ui: { type: 'boolean', description: 'Cut a flat phone-UI frame around the picture' }, region: str('Only this rectangle "x,y,w,h" in pixels') }, ['image']),
    args: a => [a.image, ...opt('--n', a.n), ...(a.average ? ['--average'] : []), ...(a.ignore_ui ? ['--ignore-ui'] : []), ...opt('--region', a.region)],
  },
  picture_compare: {
    cmd: 'picture-compare',
    description: 'Numbers for two pictures: brightness, saturation, contrast, fine detail, main color, plus a side-by-side image file (open it and look at both). Run after each snap; read the numbers first. Needs no game.',
    schema: obj({ reference: str('Reference picture file'), screenshot: str('Your screenshot, e.g. ".threedog/shots/snap.png"'),
      region: str('Optional rectangle "x,y,w,h" cut from both'),
      out: str('Side-by-side PNG to write (reference left, screenshot right). Default: next to the screenshot as <name>.compare.png') }, ['reference', 'screenshot']),
    args: a => [a.reference, a.screenshot, ...opt('--region', a.region), '--out', a.out ?? a.screenshot.replace(/\.[^./\\]+$/, '') + '.compare.png'],
  },
  snap_describe: {
    cmd: 'snap-describe',
    description: 'Describe snapshot instead of a screenshot: save stores a baseline of describe(), diff lists what changed since.',
    schema: obj({ mode: { type: 'string', enum: ['save', 'diff'], description: 'save = store tests/snapshots/<name>.describe.json (gameplay part of describe); diff = list what changed since' }, name: str('Baseline name'),
      only: { type: 'array', items: { type: 'string' }, description: 'Compare only these fields (dotted paths); use the same list for save and diff' },
      ignore: { type: 'array', items: { type: 'string' }, description: 'Extra fields to skip' }, tolerance: num('Number tolerance (default 0.5)') },
        ['mode', 'name']),
    args: a => [a.mode, a.name, ...opt('--only', a.only?.join(',')), ...opt('--ignore', a.ignore?.join(',')), ...opt('--tolerance', a.tolerance)],
  },
  scenario: {
    description: 'Run one scenario file on the running page; returns failed checks or a pass count. Leaves the page halted. verify adds what it never touched.',
    schema: obj({ name: str('Scenario file name without .json (tests/scenarios/<name>.json)'), freezeReload: FREEZE }, ['name']),
    args: a => [a.name, ...freezeArg(a)],
  },
  reload: {
    description: 'Reload the game page (back to its initial state).',
    schema: obj(),
    args: () => [],
  },
  resume: {
    description: 'Resume real-time running of a page halted by step, press, hold or scenario.',
    schema: obj(),
    args: () => [],
  },
};
Object.assign(TOOLS, EXTRA_TOOLS, STATIC_TOOLS);
if (allowJs) TOOLS.js = {
  description: 'DEV ONLY, DANGEROUS: run arbitrary JavaScript in the game page (engine in scope, await works). Last resort for reading what describe cannot show; ' +
    'never change state with it (use op).',
  schema: obj({ code: str('An expression ("engine.calendar.timeOfDay") or statements with return'), max: MAX }, ['code']),
  args: a => [a.code, ...opt('--max', a.max)],
};

const list = () => Object.entries(TOOLS).map(([name, t]) => ({ name, description: `${label(t.cmd || name)} ${t.description}`.trim(), inputSchema: t.schema, outputSchema: OUTPUT_SCHEMA }));

/** Run one tool → MCP CallToolResult. Bridge failures (no dev server, page error, ✗ results) come back as isError with the CLI's text */
async function callTool(name, input = {}) {
  const t = TOOLS[name];
  if (!t) return { content: [{ type: 'text',
    text: `No tool "${name}". Available: ${Object.keys(TOOLS).join(', ')}${name === 'js' ? ' (js needs threedog mcp --allow-js)' : ''}` }],
    structuredContent: { ok: false, code: 'command-error', summary: `No tool "${name}"`, runtime: NONE, data: null }, isError: true };
  if (t.run) {   // static (STATIC_TOOLS): read the files, never touch the dev server
    try {
      const r = await t.run(dir, input);
      return { content: [{ type: 'text', text: r.text }], structuredContent: { ok: r.ok, code: r.ok ? 'ok' : 'blocked', summary: r.text.split('\n')[0].replace(/^[✓✗]\s*/, ''),
        runtime: NONE, data: r.data ?? null }, isError: !r.ok };
    } catch (e) {
      return { content: [{ type: 'text', text: '✗ ' + e.message }], structuredContent: { ok: false, code: 'command-error', summary: e.message, runtime: NONE, data: null }, isError: true };
    }
  }
  let png;
  try {
    const { text, ...structured } = await execute(dir, t.cmd || name, t.args(input), { page: pagePath, onShot: b => { png = b; } });
    structured.data = shortData(structured.data, t.cmd || name);
    const content = [{ type: 'text', text }];
    if (png) content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
    return { content, structuredContent: structured, isError: !structured.ok };
  } catch (e) {
    return { content: [{ type: 'text', text: '✗ ' + e.message }], structuredContent: { ok: false, code: 'command-error', summary: e.message, runtime: NONE, data: null }, isError: true };
  }
}

// ── JSON-RPC over stdio ───────────────────────────────
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const INSTRUCTIONS = RESULT_SHAPE + ' Drives the threedog game running under `npm run dev` (the dev bridge). No game running: call play. Then status or describe; change state with op (ops lists what ' +
  'is possible); step / press / hold advance game time and pause a real page (resume restores it); errors reads new page errors. If a tool cannot reach the game it ' +
  'names the cause and the next step (play starts the server). how and check need no game. ' + situationGuide(join(ENGINE, 'docs', 'recipes', '16-dev-bridge.md'));   // the same list as recipe 16 §11 (one source)

let queue = Promise.resolve();   // tool calls run one at a time, in order: they drive one shared game
async function handle(m) {
  const reply = result => m.id !== undefined && send({ id: m.id, result });
  switch (m.method) {
    case 'initialize': return reply({ protocolVersion: PROTOCOLS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'threedog', version: VERSION }, instructions: INSTRUCTIONS });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: list() });
    case 'tools/call': queue = queue.then(async () => reply(await callTool(m.params?.name, m.params?.arguments))); return queue;
    default:
      if (m.id !== undefined && m.method) send({ id: m.id,
        error: { code: -32601, message: `Method not found: ${m.method}` } });   // notifications (no id) are ignored
  }
}

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  let m;
  try { m = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
  for (const one of Array.isArray(m) ? m : [m]) handle(one).catch(e => one.id !== undefined
    && send({ id: one.id, error: { code: -32603, message: String(e.message || e) } }));
}).on('close', () => queue.then(() => process.exit(0)));
