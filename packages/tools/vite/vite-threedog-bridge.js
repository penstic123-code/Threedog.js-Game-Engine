// Dev bridge: lets the AI drive the running game page from the terminal (look at state, advance time, press keys, change state, take screenshots). The command line threedog describe|step|press… is in packages/tools/threedog/.
//
//   Installed automatically by gameConfig: plugins: [threedogBridge()]. Dev server only (apply: 'serve'); build / preview contain no bridge code.
//
// Path: command line → POST /__threedog/cmd (local machine + token) → here → the target page runs it → the result goes back the same way.
//   · a browser has a page open: over Vite's HMR WebSocket (no added dependency); with several pages, the one that last got focus gets it
//   · no page connected: when the first command arrives the server opens a headless page itself with Playwright (?threedog-headless, the game advances only on step) and keeps it, closing it once a real page connects
// On start it writes <workspace>/.threedog/dev.json { port, token, pid }, where the command line finds the server.
// Security: only local connections, Host must be localhost-like, anything with an Origin (sent from a web page) is rejected (vite/local.js), the token is random at every start, and commands can only be sent by a local process that can read dev.json.
// A page that reloads or closes fails its pending commands at once ("run the command again"), instead of after the 2-minute timeout.
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { waitEngine, trackPageErrors } from '../wait-engine.mjs';
import { isLocalRequest, readBody, orderedQueue, jsonReply } from './local.js';
import { headlessUrl } from '../lib/page-url.mjs';

const VIRTUAL = 'virtual:threedog-bridge', RESOLVED = '\0' + VIRTUAL;
const CLIENT = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'threedog-bridge-client.js'), 'utf8');
const TIMEOUT = 120000;   // a long step under software rendering can take tens of seconds
const MAX_BODY = 32 << 20;   // snap --width sends the whole PNG through here to scale it in the page, and a detailed full-HD canvas passes 4 MB

export default function threedogBridge() {
  let frozenUntil = 0;   // opt-in HMR freeze (`scenario|verify --freeze-reload`): file saves reload nothing until this time; the time limit frees a server whose caller died
  return {
    name: 'threedog-bridge',
    apply: 'serve',
    resolveId: id => id === VIRTUAL ? RESOLVED : undefined,
    load: id => id === RESOLVED ? CLIENT : undefined,
    transformIndexHtml: () => [{ tag: 'script', attrs: { type: 'module', src: '/@id/__x00__' + VIRTUAL }, injectTo: 'head' }],
    handleHotUpdate: () => Date.now() < frozenUntil ? [] : undefined,
    configureServer(server) {
      const token = randomBytes(16).toString('hex'), file = resolve(server.config.root, '.threedog/dev.json');
      const focus = new Map();      // ws client → { path, at }
      const pending = new Map();    // command id → { resolve, reject, client }
      let seq = 0, headless = null; // headless: Promise<{ browser, page, path }>
      let headlessBusy = 0, closeWhenIdle = false;
      // A headless page must not burn CPU while nobody asks it for anything (a resumed software-WebGL game runs ~10 cores): a few seconds after
      // the last command it is halted again (idleHalted), and after IDLE_CLOSE_MIN minutes the browser is closed (the next command opens a new one)
      const IDLE_PAUSE_MS = +process.env.THREEDOG_HEADLESS_PAUSE_S * 1000 || 15000, IDLE_CLOSE_MS = (+process.env.THREEDOG_HEADLESS_IDLE_MIN || 2) * 60000;
      let idleTimer = null, idleHalted = false, lastCmd = Date.now();

      /** Fail every command waiting on client (it reloaded or closed) */
      const dropClient = client => {
        for (const [id, p] of pending) if (p.client === client) { pending.delete(id); p.reject(new Error('the page reloaded or closed while the command ran; run the command again')); }
      };
      server.ws.on('vite:client:disconnect', (_, c) => { focus.delete(c); dropClient(c); });
      server.ws.on('threedog:hello', (d, c) => {
        focus.set(c, { path: d.path, at: Date.now() });
        // a real page arrived, so the one the server opened itself is no longer needed (once its running command is done)
        if (headless) { if (headlessBusy) closeWhenIdle = true; else closeHeadless(); }
      });
      server.ws.on('threedog:focus', (_, c) => { const f = focus.get(c); if (f) f.at = Date.now(); });
      server.ws.on('threedog:result', (d) => { const p = pending.get(d.id); if (p) { pending.delete(d.id); p.resolve(d); } });

      /** The real page that last got focus (optionally filtered by path) */
      const liveClient = path => [...focus].filter(([c, f]) => server.ws.clients.has(c) && (!path || f.path === path))
        .sort((a, b) => b[1].at - a[1].at)[0]?.[0];
      const ask = (client, event, payload = {}) => new Promise((res, rej) => {
        const id = ++seq;
        // js --wait can ask for longer than TIMEOUT: the page's own message must get here first, it says more than this one
        const ms = Math.max(TIMEOUT, ((payload.arg?.wait ?? 0) + 15) * 1000);
        const t = setTimeout(() => { pending.delete(id); rej(new Error(`the page did not respond for ${Math.round(ms / 60000)} minutes (stuck? try threedog reload)`)); }, ms);
        // also notice a socket that went away without a disconnect event
        const alive = setInterval(() => { if (!server.ws.clients.has(client)) dropClient(client); }, 500);
        const done = () => { clearTimeout(t); clearInterval(alive); };
        pending.set(id, { client, resolve: d => { done(); d.ok ? res(d.value) : rej(new Error(d.error)); }, reject: e => { done(); rej(e); } });
        client.send(event, { id, ...payload });
      });

      const baseUrl = () => `http://localhost:${server.httpServer.address().port}${server.config.base.replace(/\/$/, '')}`;
      async function openHeadless(path) {
        const h = await headless?.catch(() => null);
        if (h && h.path === path) return h.page;
        if (h) await closeHeadless();
        headless = (async () => {
          let launchBrowser;
          try { ({ launchBrowser } = await import('../browser.mjs')); } catch { throw new Error('playwright not found · run npm install first'); }
          const browser = await launchBrowser({ prefer: 'gpu' }).catch(() => { throw new Error('browser not installed · run npx playwright install chromium first'); });
          try {
            const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
            trackPageErrors(page);   // before goto: main.js runs during it, and an error missed there leaves waitEngine waiting on a dead page
            await page.goto(baseUrl() + headlessUrl(path, { cutscene: 'skip' }));
            return { browser, page, path };
          } catch (e) { await browser.close().catch(() => {}); throw e; }   // nobody holds this browser yet: a page that failed to open must not leave it running
        })();
        headless.catch(() => { headless = null; });
        return (await headless).page;
      }
      async function closeHeadless() {
        const h = headless; headless = null; idleHalted = false; clearTimeout(idleTimer);
        if (h) await (await h.catch(() => null))?.browser.close().catch(() => {});
      }
      server.httpServer?.on('close', closeHeadless);
      /** After a command: halt a real-time-running headless page soon, close the browser later */
      function armIdle() {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(async () => {
          const h = headless && await headless.catch(() => null);
          if (!h || headlessBusy) return;
          idleHalted = await h.page.evaluate(() => { const e = window.engine; if (!e?.headless || e.halted) return false; e.haltLoop('bridge-idle'); return true; }).catch(() => false);
          idleTimer = setTimeout(() => { if (!headlessBusy) closeHeadless(); }, Math.max(1000, IDLE_CLOSE_MS - IDLE_PAUSE_MS));
        }, IDLE_PAUSE_MS);
      }

      /** Run one primitive: eval / shot / reload (what the commands mean is in packages/tools/threedog/commands.mjs; this only carries them) */
      async function exec({ op, src, arg, page: path }) {
        const client = liveClient(path);
        if (client) {
          if (op === 'eval') return ask(client, 'threedog:eval', { src, arg });
          if (op === 'shot') return ask(client, 'threedog:shot');
          dropClient(client);
          client.send('threedog:reload');   // after the reload the page reconnects, wait for it: a command landing in the gap would open a headless page instead
          await new Promise(r => { const t = setInterval(() => { const now = liveClient(path); if (now && now !== client) { clearInterval(t); r(); } }, 200); setTimeout(() => { clearInterval(t); r(); }, 5000); });
          return null;
        }
        headlessBusy++;
        try {
          const page = await openHeadless(path || '/');
          await waitEngine(page, { dir: server.config.root });
          if (idleHalted) { idleHalted = false; await page.evaluate(() => window.engine?._tools.resume('bridge-idle')); }   // hand the page back as it was before the idle pause
          if (op === 'eval') return await page.evaluate(([s, a]) => (0, eval)('(' + s + ')')(a), [src, arg]);
          if (op === 'shot') return (await page.screenshot()).toString('base64');   // the headless page is captured together with the HTML UI
          await page.reload(); return null;
        } finally { if (!--headlessBusy) { if (closeWhenIdle) { closeWhenIdle = false; closeHeadless(); } else armIdle(); } }
      }

      // One command at a time, in arrival order: the MCP server, a session and direct command lines may all call at once, and step / op are
      // order-dependent (two steps interleaving with an op would give a state nobody asked for)
      const inOrder = orderedQueue();

      // which folder this server is for: `threedog shot <url>` asks before it trusts the page (a leftover server on the port is another game)
      server.middlewares.use('/__threedog/root', (req, res) => {
        if (!isLocalRequest(req)) { res.statusCode = 403; return res.end(); }
        jsonReply(res)(200, { root: server.config.root });
      });
      server.middlewares.use('/__threedog/cmd', (req, res) => {
        const reply = jsonReply(res);
        if (req.method !== 'POST' || !isLocalRequest(req)) return reply(403, { ok: false, error: 'the bridge only accepts commands from the local command line' });
        if (req.headers['x-threedog-token'] !== token) return reply(401, { ok: false, error: 'wrong token · was the dev server restarted? just run the command again' });
        readBody(req, MAX_BODY).then(async b => {
          try {
            const cmd = JSON.parse(String(b));
            if (cmd.op !== 'ping') lastCmd = Date.now();
            // ping: "is this the bridge, and is a page attached" without touching the page (never opens the headless browser, skips the queue)
            if (cmd.op === 'ping') return reply(200, { ok: true, value: { live: !!liveClient(cmd.page), headless: !!headless } });
            // true, so the caller can tell this from an older server, whose unknown-op fallback reloads the page and answers null
            if (cmd.op === 'freeze-reload') { frozenUntil = cmd.on ? Date.now() + 10 * 60000 : 0; return reply(200, { ok: true, value: true }); }
            // close-headless (play --stop on a server it did not start): close the browser this bridge opened, whoever asked for it; true if one was open
            if (cmd.op === 'close-headless') { const had = !!headless; await closeHeadless(); return reply(200, { ok: true, value: had }); }
            reply(200, { ok: true, value: await inOrder(() => exec(cmd)) ?? null });
          }
          catch (e) { reply(200, { ok: false, error: String(e.message || e) }); }
        }, e => reply(413, { ok: false, error: String(e.message) }));
      });

      server.httpServer?.once('listening', () => {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ port: server.httpServer.address().port, token, pid: process.pid }));
        // self-check: fetch the game page once, so a broken index.html or main.js shows here and not as a blank tab. The hint points at this
        // output, not `threedog errors`: errors.log holds what the page reported, and a page that did not load reported nothing
        const url = `http://localhost:${server.httpServer.address().port}${server.config.base}`;
        fetch(url, { signal: AbortSignal.timeout(30000) }).then(r => { if (r.status !== 200) console.error(`[threedog] ${url} answers ${r.status}, not 200: the dev server's own error above says why (404: no index.html under that address)`); }, () => {});
      });
      // A server that play started for an agent (THREEDOG_AUTOSTOP_MIN is set by play) exits when no command came and no live page is open for that long
      const stopMin = +process.env.THREEDOG_AUTOSTOP_MIN;
      if (stopMin > 0) setInterval(() => { if (!headlessBusy && !pending.size && !focus.size && Date.now() - lastCmd > stopMin * 60000) server.close().finally(() => process.exit(0)); }, 15000).unref();
      // only our own record: a second server of this game has written its port over it
      const cleanup = () => { try { if (JSON.parse(readFileSync(file, 'utf8')).token === token) rmSync(file); } catch { /* already gone */ } };
      server.httpServer?.on('close', cleanup);
      process.once('exit', cleanup);
    },
  };
}
