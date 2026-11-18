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
import { label, RESULT_SHAPE, OUTPUT_SCHEMA, situationGuide, shortData } from './mcp-extra.mjs';
import { TOOLS as BASE_TOOLS, JS_TOOL } from './mcp-tools.mjs';
import { NONE } from './runtime.mjs';

// stdout carries protocol messages only: anything else that prints goes to stderr
console.log = console.info = console.warn = console.error;

let dir, pagePath, allowJs;
try {
  const { dir: d, opt } = command(process.argv.slice(2), { live: true, flags: ['allow-js'], values: ['page'] });
  dir = d; allowJs = !!opt['allow-js']; pagePath = opt.page === undefined ? undefined : pageArg(opt.page);
} catch (e) { console.error('threedog mcp: ' + e.message); process.exit(1); }
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const TOOLS = { ...BASE_TOOLS };
if (allowJs) TOOLS.js = JS_TOOL;

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
