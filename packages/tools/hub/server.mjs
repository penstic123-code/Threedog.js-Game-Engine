// The hub's local web server: one static page plus a small JSON API and a server-sent-events stream. Plain node:http, no dependency.
// Why SSE and not polling: a re-shot picture should appear the moment it is written, and the page costs nothing while nothing happens.
import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync, createReadStream } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjects, addProject, removeProject } from './registry.mjs';
import { readWall, wallDir } from './wall.mjs';
import { createQueue, watchProject, newestChange } from './queue.mjs';
import { shootProject } from './shoot.mjs';
import { ensureShortcut } from './shortcut.mjs';
import { devServer } from '../browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)), PAGE = join(HERE, 'page'), CLI = join(HERE, '..', 'bin', 'threedog.mjs'), HUB_SCRIPT = resolve(HERE, '..', 'hub.mjs');
const VERSION = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version;
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/hub.js': ['hub.js', 'text/javascript; charset=utf-8'], '/hub.css': ['hub.css', 'text/css; charset=utf-8'] };
// template name -> `threedog init` flag; the same four starts as the command
const TEMPLATES = { blank: [], 'open-world': ['--open-world'], pixel: ['--pixel'], 'scene-only': ['--scene-only'] };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise(ok => { let s = ''; req.on('data', c => { s += c; if (s.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok(null); } }); req.on('error', () => ok(null)); });
const firstLine = e => String(e?.message ?? e).split('\n')[0];

/** @param {{ port?: number, env?: object, shoot?: (dir: string) => Promise<any>, quit?: () => void }} o */
export async function startHub({ port = 5180, env = process.env, shoot = shootProject, quit = () => process.exit(0) } = {}) {
  const clients = new Set(), watchers = new Map(), jobs = { busy: null };
  const emit = ev => { for (const c of clients) c.write(`data: ${JSON.stringify(ev)}\n\n`); };
  const find = id => listProjects(env).find(p => p.id === id);
  let dev = null;   // the one project dev server: { id, server: Promise<{ base, close }> }; a promise so two quick /open requests share one start
  const closeDev = async () => { const d = dev; dev = null; await (await d?.server.catch(() => null))?.close().catch(() => {}); };
  const children = new Set(), creating = new Set();   // running npm / init processes (killed on quit); folders being created right now

  const queue = createQueue({ shoot: async id => {
    const p = find(id);
    if (!p?.exists) return;
    jobs.busy = id; emit({ type: 'project', id });
    try { await shoot(p.dir); } catch (e) { emit({ type: 'log', line: `shoot failed: ${firstLine(e)}` }); }
    finally { jobs.busy = null; emit({ type: 'project', id }); }
  } });

  // one watcher per existing project; a project added later gets one on add
  const watch = p => {
    if (!p || watchers.has(p.id) || !p.exists) return;
    // a watcher that errors (folder deleted or moved) is dropped from the map so the next project list re-arms it when the folder is back
    watchers.set(p.id, watchProject(p.dir, () => { queue.touch(p.id); emit({ type: 'project', id: p.id }); }, () => watchers.delete(p.id)));
    if (newestChange(p.dir) > (readWall(p.dir).runAt ?? 0)) queue.touch(p.id);
  };
  listProjects(env).forEach(watch);

  const wallUrl = (id, s) => `/wall/${id}/${encodeURIComponent(basename(s.file))}?t=${s.at}`;
  const card = p => {
    const wall = p.exists ? readWall(p.dir) : { runAt: null, error: null, points: {} };
    const pts = Object.values(wall.points), shots = pts.flatMap(v => v.shots);
    const cover = pts.map(v => v.shots[0]).find(Boolean);
    return { id: p.id, name: p.name, dir: p.dir, exists: p.exists, cover: cover ? wallUrl(p.id, cover) : null,
      updatedAt: shots.length ? Math.max(...shots.map(s => s.at)) : wall.runAt, error: wall.error, busy: jobs.busy === p.id, queued: queue.pending().includes(p.id),
      pointsMissing: p.exists && !existsSync(join(p.dir, 'shots.json')) };
  };
  const detail = p => {
    const wall = p.exists ? readWall(p.dir) : { points: {} };
    return { ...card(p), points: Object.entries(wall.points).map(([name, v]) => ({ name, error: v.error, shots: v.shots.map(s => ({ url: wallUrl(p.id, s), at: s.at })) })) };
  };

  const sendWall = (res, id, file) => {
    const p = find(id);
    // the file name is one segment of the wall folder: anything with a separator or `..` is refused
    if (!p || !file || /[\\/]|\.\./.test(file)) { res.writeHead(404); return res.end(); }
    const path = join(wallDir(p.dir), file);
    if (!existsSync(path)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=31536000, immutable' }); createReadStream(path).pipe(res);
  };

  // New project: init, npm install, register, first shoot. Progress lines go to every open page as log events.
  const run = (cmd, args, cwd) => new Promise(ok => {
    // no THREEDOG_TEST: a shoot's build sets it on the whole process for a moment, and a game's npm install must not inherit that
    const { THREEDOG_TEST: _t, ...clean } = env;
    const c = spawn(cmd, args, { cwd, shell: process.platform === 'win32' && cmd === 'npm', env: clean });
    children.add(c);
    const line = b => String(b).split(/\r?\n/).filter(Boolean).forEach(l => emit({ type: 'log', line: l.slice(0, 300) }));
    c.stdout.on('data', line); c.stderr.on('data', line); c.on('error', e => { line(e.message); ok(1); }); c.on('close', code => { children.delete(c); ok(code ?? 1); });
  });
  async function createProject({ parent, name, template }) {
    const dir = join(resolve(parent), name);
    emit({ type: 'log', line: `creating ${dir}` });
    try {
      if (await run(process.execPath, [CLI, 'init', dir, ...TEMPLATES[template]], process.cwd()) !== 0) return emit({ type: 'log', line: 'init failed' });
      if (await run('npm', ['install'], dir) !== 0) emit({ type: 'log', line: 'npm install failed: run it in the folder by hand' });
      const added = addProject(dir, env);
      if (!added.ok) return emit({ type: 'log', line: added.reason });
      watch(find(added.id)); queue.now(added.id); emit({ type: 'project', id: added.id }); emit({ type: 'log', line: 'done' });
    } finally { creating.delete(dir.toLowerCase()); }
  }

  const routes = async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname, m = req.method;
    // Why: DNS rebinding. A page on evil.example whose name later resolves to 127.0.0.1 would be same-origin with the hub and could read it; its Host header still says evil.example
    const at = server.address().port;
    if (req.headers.host !== `127.0.0.1:${at}` && req.headers.host !== `localhost:${at}`) return json(res, 403, { reason: 'wrong host' });
    // Why: any web page open in the browser can send a POST to 127.0.0.1; only the hub's own page may create projects, write the icon or quit
    if (m !== 'GET' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { reason: 'only the hub page may do this' });
    if (m === 'GET' && STATIC[path]) { res.writeHead(200, { 'content-type': STATIC[path][1], 'cache-control': 'no-store' }); return res.end(readFileSync(join(PAGE, STATIC[path][0]))); }
    if (m === 'GET' && path === '/api/ping') return json(res, 200, { hub: 'threedog', version: VERSION });
    if (m === 'GET' && path === '/api/projects') { const l = listProjects(env); l.forEach(watch); return json(res, 200, l.map(card)); }   // watch: a project added from a terminal (threedog init) or a folder that came back gets its watcher now
    // where a new project goes by default: next to the newest project, else the Desktop
    if (m === 'GET' && path === '/api/defaults') { const l = listProjects(env); return json(res, 200, { parent: l.length ? dirname(l[l.length - 1].dir) : join(homedir(), 'Desktop') }); }
    if (m === 'GET' && path === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }); res.write(': ok\n\n');
      clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    let g = path.match(/^\/wall\/([0-9a-f]+)\/(.+)$/);
    if (m === 'GET' && g) { let f; try { f = decodeURIComponent(g[2]); } catch { f = ''; } return sendWall(res, g[1], f); }
    g = path.match(/^\/api\/projects\/([0-9a-f]+)(?:\/(reshoot|open))?$/);
    if (g) {
      const p = find(g[1]);
      if (!p) return json(res, 404, { reason: 'unknown project' });
      if (m === 'GET' && !g[2]) return json(res, 200, detail(p));
      if (m === 'DELETE' && !g[2]) { removeProject(p.id, env); watchers.get(p.id)?.(); watchers.delete(p.id); emit({ type: 'project', id: p.id }); return json(res, 200, { ok: true }); }
      if (m === 'POST' && g[2] === 'reshoot') { if (!p.exists) return json(res, 400, { reason: 'folder not found' }); queue.now(p.id); emit({ type: 'project', id: p.id }); return json(res, 200, { ok: true }); }
      if (m === 'POST' && g[2] === 'open') {
        const what = (await readBody(req))?.what;
        if (!['game', 'editor', 'gallery'].includes(what) || !p.exists) return json(res, 400, { reason: 'folder not found or unknown target' });
        try {
          // one dev server at a time: opening another project closes the previous one
          // the start is stored as a promise and awaited by every request, so two quick clicks cannot start two servers and leak one
          // cacheDir: its own dependency cache, so it does not fight a running `npm run dev` of the game over node_modules/.vite
          if (dev?.id !== p.id) { await closeDev(); dev = { id: p.id, server: devServer(p.dir, { cacheDir: '.threedog/vite-hub' }) }; }
          const server = await dev.server;
          // the editor has no URL switch (F2 inside the game), so it opens the game
          return json(res, 200, { url: server.base + (what === 'gallery' ? '/?gallery=1' : '/'), hint: what === 'editor' ? 'press F2 in the game to open the editor' : null });
        } catch (e) { dev = null; return json(res, 500, { reason: firstLine(e) }); }
      }
    }
    if (m === 'POST' && path === '/api/projects') {
      const b = await readBody(req);
      if (typeof b?.dir !== 'string' || !b.dir.trim()) return json(res, 400, { reason: 'give a folder path' });
      const r = addProject(b.dir.trim().replace(/^"(.*)"$/, '$1'), env);
      if (!r.ok) return json(res, 400, { reason: r.reason });
      watch(find(r.id)); queue.touch(r.id); emit({ type: 'project', id: r.id }); return json(res, 200, r);
    }
    if (m === 'POST' && path === '/api/new') {
      const b = await readBody(req);
      if (!b || typeof b.parent !== 'string' || !b.parent.trim() || !/^[\p{L}\p{N}_. -]+$/u.test(b.name ?? '') || /^[. ]+$/.test(b.name) || !Object.hasOwn(TEMPLATES, b.template)) return json(res, 400, { reason: 'give a name (letters, digits, - _ space), a parent folder and a template' });
      const dir = join(resolve(b.parent.trim()), b.name.trim()), key = dir.toLowerCase();
      if (creating.has(key)) return json(res, 409, { reason: 'this folder is already being created' });
      // "new project" makes the folder; one that exists with files in it is for "Add folder"
      if (existsSync(dir) && readdirSync(dir).length) return json(res, 400, { reason: `${dir} already exists and is not empty: use "Add folder" for an existing game` });
      creating.add(key);
      createProject({ parent: b.parent.trim(), name: b.name.trim(), template: b.template }).catch(e => emit({ type: 'log', line: firstLine(e) }));
      return json(res, 202, { ok: true });
    }
    if (m === 'POST' && path === '/api/shortcut') { const r = ensureShortcut({ script: HUB_SCRIPT }); return json(res, 200, { action: r.action, message: r.message }); }
    if (m === 'POST' && path === '/api/quit') { json(res, 200, { ok: true }); setTimeout(() => { close().finally(quit); }, 50); return; }
    json(res, 404, { reason: 'not found' });
  };

  const server = createServer((req, res) => { routes(req, res).catch(e => { if (!res.headersSent) json(res, 500, { reason: firstLine(e) }); else res.end(); }); });
  await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', ok); });

  async function close() {
    queue.stop(); watchers.forEach(c => c()); watchers.clear(); await closeDev();
    // an npm install still running would go on after the hub is gone (on Windows npm runs in a shell: kill its whole tree)
    for (const c of children) { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true }); else c.kill(); }
    for (const c of clients) c.end();
    server.closeAllConnections?.(); await new Promise(ok => server.close(ok));
  }
  return { url: `http://127.0.0.1:${server.address().port}`, close };
}
