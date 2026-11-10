// MCP server test: npm test -- "MCP server"
// Starts `threedog mcp` over stdio (through the real bin), talks JSON-RPC to it, and calls describe / snap against a real dev server on the engine
//   package (its index page is the world example), started in this process the same way as the bridge test; needs no game under games/.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { TOOLS, ROOT, ENGINE, viteOptions } from '../paths.mjs';
import { readFileSync } from 'node:fs';
import { TIME } from '../threedog/runtime.mjs';
import { pairs, STATIC_TOOLS } from '../threedog/mcp-extra.mjs';

export const name = 'MCP server: threedog mcp wraps the dev bridge over stdio';

const BIN = join(TOOLS, 'bin/threedog.mjs');
const EXPECTED = ['art_list', 'catalog', 'check', 'describe', 'errors', 'explain', 'hold', 'how', 'inspect', 'lib_list', 'loading', 'op', 'ops', 'pick', 'picture_compare', 'picture_palette', 'play', 'press', 'reload', 'resume', 'scenario', 'scene', 'skip', 'snap', 'snap_describe', 'state', 'status', 'step', 'verify'];

/** Start one MCP server; returns { rpc(method, params), close() }. Async on purpose: the dev server lives in this process */
function mcp(...args) {
  const child = spawn(process.execPath, [BIN, 'mcp', ...args], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let id = 0;
  createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); });
  const rpc = (method, params) => new Promise((res, rej) => {
    const n = ++id, t = setTimeout(() => rej(new Error(`no answer to ${method} within 120 s`)), 120000);
    waiting.set(n, m => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  const init = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    .then(r => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); return r; });
  return { init, rpc, close: () => { child.stdin.end(); child.kill(); } };
}
const names = r => r.tools.map(t => t.name).sort();

export async function run({ check }) {
  const plain = mcp('-w', 'engine');
  try { await steps(check, plain); } finally { plain.close(); }
}

async function steps(check, plain) {
  // 1. initialize + tools/list: the expected tools, each with a schema and a description; js only with --allow-js
  const withJs = mcp('-w', 'engine', '--allow-js');
  try {
    const info = await plain.init, list = await plain.rpc('tools/list');
    check('initialize: answers with the protocol version, the tools capability and the server name',
      info.protocolVersion === '2025-06-18' && info.capabilities.tools && info.serverInfo.name === 'threedog', JSON.stringify(info).slice(0, 200));
    // one source: the server instructions carry recipe 16 §11 "When something happens: which tool" (every row, backticks dropped)
    const aiSec = readFileSync(join(ENGINE, 'docs/recipes/16-dev-bridge.md'), 'utf8').split(/^## /m).find(s => /^11\. When something happens/.test(s)) ?? '';
    const aiRows = aiSec.split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2).replaceAll('`', '').replace(/\.$/, '').trim());
    check('initialize: the instructions carry every row of recipe 16 "When something happens: which tool", and stay short',
      aiRows.length >= 10 && aiRows.every(r => info.instructions.includes(r)) && info.instructions.length < 3000, `rows ${aiRows.length}, length ${info.instructions.length}`);
    check('tools/list: one tool per bridge command, each with an object schema and a description',
      JSON.stringify(names(list)) === JSON.stringify(EXPECTED) && list.tools.every(t => t.inputSchema.type === 'object' && t.description.length > 20), names(list).join(', '));
    // the descriptions are sent every turn: short; the time rule comes from the one TIME table; recipe 16 lists exactly the tools the server has
    const recipe = readFileSync(join(ENGINE, 'docs/recipes/16-dev-bridge.md'), 'utf8'), inRecipe = list.tools.filter(t => !recipe.includes('`' + t.name + '`')).map(t => t.name);
    check('tool descriptions are at most 230 characters; skip is labelled as advancing time like TIME says; recipe 16 names every tool',
      list.tools.every(t => t.description.length <= 230) && TIME.advances.every(c => !list.tools.some(t => t.name === c.replace('-', '_') && !t.description.startsWith('ADVANCES')))
        && !inRecipe.length, `too long: ${list.tools.filter(t => t.description.length > 230).map(t => t.name + ':' + t.description.length)}; missing in recipe 16: ${inRecipe}`);
    await withJs.init;
    const js = (await withJs.rpc('tools/list')).tools.find(t => t.name === 'js');
    const denied = await plain.rpc('tools/call', { name: 'js', arguments: { code: '1 + 1' } });
    check('js: absent without --allow-js (calling it says how to enable it); with the flag it is listed and marked dangerous',
      !names(list).includes('js') && denied.isError && denied.content[0].text.includes('--allow-js') && /DANGEROUS/.test(js?.description), denied.content[0].text);
    const unknown = await plain.rpc('nope/method').then(() => 'answered', e => e.message);
    check('unknown method: JSON-RPC "Method not found" error', unknown.includes('Method not found'), unknown);
  } finally { withJs.close(); }

  // 1b. Static tools answer from the files, with or without a dev server
  const how = await plain.rpc('tools/call', { name: 'how', arguments: { task: 'tone mapping' } });
  check('how: static, the same one answer as the CLI, plain three.js recommended first (no dev server needed)', !how.isError && /^Recommended \(.*not the only.*\): plain three\.js/.test(how.content[0].text) && how.structuredContent.ok, how.content[0].text.slice(0, 300));
  // [guard] a list of strings was joined: the op got the one string "a,b,c", with no way to tell ['a,b', 'c'] from ['a', 'b', 'c']
  check('[guard] op arguments: a string list goes as JSON, numbers stay x,y,z', pairs({ tags: ['a,b', 'c'], at: [1, 2, 3], n: 2 }).join(' ') === 'tags=["a,b","c"] at=1,2,3 n=2');
  // [guard] a child that cannot start had no error listener: the error ended the MCP server
  const noCheck = await STATIC_TOOLS.check.run(join(ROOT, '.threedog', 'no-such-folder'), {});
  check('[guard] check that cannot start answers with a failure', !noCheck.ok, noCheck.text);
  const chk = await plain.rpc('tools/call', { name: 'check', arguments: { rule: 'R33' } });
  check('check: static, runs npm run check (one rule here) and answers with a verdict line', /^[✓✗] check (passed|failed)/.test(chk.content[0].text) && typeof chk.structuredContent.data?.exit === 'number', chk.content[0].text.slice(0, 300));

  // 2. No dev server: a tool call says how to fix it (skipped when someone is running dev on the engine right now)
  const dir = ENGINE;
  if (!existsSync(join(dir, '.threedog/dev.json'))) {
    const r = await plain.rpc('tools/call', { name: 'describe', arguments: {} });
    check('without a dev server the tool result is an error that says npm run dev, with code no-server', r.isError && r.content[0].text.includes('npm run dev')
      && r.structuredContent.code === 'no-server', r.content[0].text);
  }

  // 3. Against a running dev server: describe returns text, snap returns an image
  const server = await createServer(await viteOptions(dir, { server: { port: 0, host: 'localhost' }, logLevel: 'error' }));
  await server.listen();
  try {
    const d = await plain.rpc('tools/call', { name: 'describe', arguments: {} });
    check('describe: text content with the scene summary', !d.isError && d.content[0].type === 'text' && d.content[0].text.includes('Player'), JSON.stringify(d).slice(0, 300));
    const p = await plain.rpc('tools/call', { name: 'describe', arguments: { path: 'time.clock' } });
    check('describe: structuredContent has ok, code, summary, runtime and data, and every tool declares an outputSchema',
      d.structuredContent?.ok === true && d.structuredContent.code === 'ok' && typeof d.structuredContent.summary === 'string'
        && d.structuredContent.runtime.ready === true && ['running', 'halted', 'frozen'].includes(d.structuredContent.runtime.mode)
        && Array.isArray(d.structuredContent.runtime.blockedBy) && (await plain.rpc('tools/list')).tools.every(t => t.outputSchema?.type === 'object'),
      JSON.stringify(d.structuredContent).slice(0, 300));
    const bad = await plain.rpc('tools/call', { name: 'op', arguments: { name: 'no.such.op' } }), er = await plain.rpc('tools/call', { name: 'errors', arguments: {} });
    check('a failed op is not a connection failure; errors carries data.cursor', bad.isError && bad.structuredContent.code !== 'ok'
      && !['no-server', 'starting', 'page-error', 'no-bridge'].includes(bad.structuredContent.code) && typeof er.structuredContent.data?.cursor === 'number',
      JSON.stringify([bad.structuredContent, er.structuredContent]).slice(0, 300));
    // freezeReload goes through the CLI's own parser (dispatch.mjs): the dev server holds file-save reloads for the run and lets go after it. The server runs in this process,
    // so its hot-update hook can be asked while the call is out (frozen = it returns [] and nothing reloads)
    const hot = server.config.plugins.find(pl => pl.name === 'threedog-bridge')?.handleHotUpdate, frozen = () => Array.isArray(hot?.());
    const sch = (await plain.rpc('tools/list')).tools.filter(t => t.name === 'scenario' || t.name === 'verify').map(t => !!t.inputSchema.properties.freezeReload);
    let sawFrozen = true, polling = true;
    let fz;
    for (const tool of ['scenario', 'verify']) {
      let saw = false; polling = true; const poll = (async () => { while (polling) { if (frozen()) saw = true; await new Promise(r => setImmediate(r)); } })();
      fz = await plain.rpc('tools/call', { name: tool, arguments: { name: 'no-such-scenario', freezeReload: true } });
      polling = false; await poll; sawFrozen &&= saw && !frozen();
    }
    check('scenario / verify take freezeReload; the call freezes hot reload for the run and releases it after',
      sch.length === 2 && sch.every(Boolean) && hot && sawFrozen && !frozen() && !/unknown option|started before/.test(fz.content[0].text), `${sch} ${!!hot} ${sawFrozen} ${frozen()} ${fz.content[0].text.slice(0, 120)}`);
    check('describe path: one field',/\d\d:\d\d/.test(p.content[0].text), p.content[0].text);
    const s = await plain.rpc('tools/call', { name: 'snap', arguments: { name: 'mcp-test' } });
    const img = s.content.find(c => c.type === 'image');
    check('snap: an MCP image (PNG) next to the text', !s.isError && img?.mimeType === 'image/png' && Buffer.from(img.data, 'base64').subarray(1, 4).toString() === 'PNG', JSON.stringify(s).slice(0, 200));
    // the image is small by default (480 wide) and the file is full size; picture_palette / picture_compare read that file with the same code as the CLI
    const widthOf = b => Buffer.from(b, 'base64').readUInt32BE(16), file = '.threedog/shots/mcp-test.png';
    const big = await plain.rpc('tools/call', { name: 'snap', arguments: { name: 'mcp-test', size: 960 } });
    check('snap: 480 px wide by default, size asks for more', widthOf(img.data) <= 480 && widthOf(big.content.find(c => c.type === 'image').data) > 480,
      `${widthOf(img.data)} / ${widthOf(big.content.find(c => c.type === 'image').data)}`);
    const sp = await plain.rpc('tools/call', { name: 'picture_palette', arguments: { image: file, n: 4 } });
    const sc2 = await plain.rpc('tools/call', { name: 'picture_compare', arguments: { reference: file, screenshot: file } });
    check('picture_palette / picture_compare: numbers about a saved shot, no image', !sp.isError && !sc2.isError && /brightness|saturation/i.test(sp.content[0].text + sc2.content[0].text)
      && !sp.content.some(c => c.type === 'image'), JSON.stringify([sp.content[0].text.slice(0, 150), sc2.content[0].text.slice(0, 150)]));
    // explain thing: the tool and the CLI end to end against the live page; ids come from the scene tool so no example data is assumed
    const sc = await plain.rpc('tools/call', { name: 'scene', arguments: {} });
    const id = 'player';   // the world example's player (describe names it); 'engine.thing' takes an object name too
    const t = id ? await plain.rpc('tools/call', { name: 'explain', arguments: { about: 'thing', name: id } }) : null;
    check('thing: the tool returns the id\'s explain() JSON (the name is echoed back in the text)', !!t && !t.isError && t.content[0].text.includes(id), `${id} ${JSON.stringify(t?.content?.[0]?.text).slice(0, 200)}`);
    const stt = await plain.rpc('tools/call', { name: 'status', arguments: {} });
    check('status: against a live page the text has a "Run state:" line (running / frozen(by …) / halted)', /Run state: (running|halted|frozen)/.test(stt.content[0].text), stt.content[0].text);
    const nt = await plain.rpc('tools/call', { name: 'explain', arguments: { about: 'thing', name: 'no-such-thing-xyz' } });
    check('thing: an unknown id is a tool error with a message, not a crash', nt.isError && nt.content[0].text.length > 5, nt.content[0].text);
    // async spawn on purpose: the dev server lives in this process, a blocking spawnSync would starve it
    const cli = await new Promise(res => {
      const c = spawn(process.execPath, [BIN, 'explain', 'thing', id ?? 'x', '--full', '-w', 'engine'], { cwd: ROOT }); let out = '';
      c.stdout.on('data', d => out += d); c.stderr.on('data', d => out += d);
      const t = setTimeout(() => { c.kill(); res({ status: 'timeout', out }); }, 90000);
      c.on('close', status => { clearTimeout(t); res({ status, out }); });
    });
    check('threedog explain thing <id> --full: CLI prints the JSON and exits 0', cli.status === 0 && cli.out.includes(id ?? '?'), `${cli.status} ${cli.out.slice(0, 200)}`);
  } finally {
    await server.close();
  }
}
