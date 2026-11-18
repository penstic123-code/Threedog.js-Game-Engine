// During development, sends errors from the browser to the terminal (the npm run dev window) and to .threedog/errors.log of the workspace (engine package or game directory).
// So the AI does not need to open the browser console: the terminal or the log file shows what went wrong in the page.
//
//   Installed automatically by gameConfig (./gameConfig.js): plugins: [errorRelay()]
//
// Collects: uncaught errors, Promise rejections (no catch), resource load failures (404 scripts/images), console.error, console.warn (warn: false turns it off).
// Identical errors (differing numbers still count as identical) are merged and counted: the first is printed in full, then every 2 seconds one summary line "N more times", so the terminal is not flooded.
// Known error classes get a "Possible cause / Read" line (core/base/errorHints.js).
// .threedog/errors.log is cleared each time dev starts; beyond maxBytes only the second half is kept (cutLog). Active in dev only; build / preview inject no code.
// Security: the endpoint takes only same-origin posts from this machine (vite/local.js), bodies up to 64 KB of well-formed items, and never lets a
//   bad body throw. Page text is data, not instructions: in errors.log every line that came from the page starts with "page| ", and only the
//   engine's own hint lines ("Possible cause / Read") are written without it.
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hintText } from 'threedog/error-hints';   // the engine's hint table (plain data), through its public subpath
import { isLocalRequest, readBody } from './local.js';
import { oneLine } from '../lib/oneline.mjs';
import { markReload } from '../threedog/errorlog.mjs';   // (errorlog.mjs imports recordsCut back: both are only called later, so the cycle is harmless)

const ENDPOINT = '/__threedog/error', MAX_BODY = 64 * 1024, MAX_ITEMS = 200;
/** Page-sent text marked as data in the log (an AI reading errors.log must not take it for instructions) */
const quote = s => String(s).split('\n').map(l => 'page| ' + l).join('\n');
/** A well-formed item from the client script below (anything else is dropped) */
const valid = it => it && typeof it === 'object' && typeof it.type === 'string' && Object.hasOwn(LABEL, it.type) && typeof it.msg === 'string'
  && ['stack', 'src', 'page'].every(k => it[k] === undefined || typeof it[k] === 'string') && (it.count === undefined || Number.isFinite(it.count)) && (it.tick === undefined || Number.isFinite(it.tick));

// Browser side: a plain <script> (not a module), running before all page code; sends a merged batch every 300 ms
const CLIENT = `(() => {
  const q = new Map();
  // a rejection reason that is not an Error used to print as {"isTrusted":true} (an Event) or {} : name what it is and where it came from, so the log says what failed
  const fmt = a => a instanceof Error ? (a.message ? String(a) : (a.name || 'Error') + ' (empty message)') : typeof a === 'object' && a !== null ? (() => {
    const kind = (a.constructor && a.constructor.name) || 'object', t = a.target || a.currentTarget, where = t && (t.src || t.href || t.responseURL || t.url);
    if (typeof Event !== 'undefined' && a instanceof Event) return kind + ' type=' + a.type + (where ? ' ' + where : '') + ' (not an Error: no message)';
    try { const j = JSON.stringify(a).slice(0, 500); return j === '{}' ? kind + ' (no readable fields)' : j; } catch { return String(a); }
  })() : String(a);
  const push = (type, msg, stack, src) => {
    const k = type + msg + (src || '');
    const it = q.get(k); if (it) { it.count++; return; }
    q.set(k, { type, msg: String(msg).slice(0, 2000), stack: stack ? String(stack).slice(0, 4000) : '', src: src || '', page: location.pathname + location.search, t: Date.now(), count: 1, tick: Number.isFinite(window.engine?.time?.tick) ? window.engine.time.tick : undefined });
  };
  const flush = () => {
    if (!q.size) return;
    const body = JSON.stringify([...q.values()]); q.clear();
    if (!navigator.sendBeacon?.('${ENDPOINT}', body)) fetch('${ENDPOINT}', { method: 'POST', body, keepalive: true }).catch(() => {});
  };
  setInterval(flush, 300); addEventListener('pagehide', flush);
  // uncaught errors kept on the page too: the dev bridge's wait (threedog/pageFns.mjs READY) stops at once on one instead of waiting a minute
  const uncaught = window.__threedogUncaught = [];
  addEventListener('error', e => {
    const el = e.target;
    if (el && el !== window && el.tagName) return push('resource', 'Failed to load <' + el.tagName.toLowerCase() + '> ' + (el.src || el.href || ''));
    uncaught.push(String(e.message));
    push('error', e.message, e.error && e.error.stack, e.filename ? e.filename + ':' + e.lineno + ':' + e.colno : '');
  }, true);
  addEventListener('unhandledrejection', e => { const r = e.reason; uncaught.push(String(r && r.message || fmt(r))); push('rejection', 'Unhandled rejection: ' + (r && r.message || fmt(r)), r && r.stack); });
  for (const level of __LEVELS__) {
    const orig = console[level];
    console[level] = function (...args) { orig.apply(this, args); const err = args.find(a => a instanceof Error); push(level, args.map(fmt).join(' '), (err || new Error()).stack); };
  }
})();
//# sourceURL=threedog-error-relay.js`;

// Headless Chromium has no WebGPU, so every page load repeats this in words that vary (three's own line and the engine's, with a reason). It stays one line in the
// log, kept apart from real errors; an error (fallback: 'error' refusing to start) is not a warning and is not merged. shot / snap say which backend drew the picture
const WEBGPU_FALLBACK = /WebGPU (unavailable|is not available)|No available adapters/i;
/** What makes two items the same line of the log (numbers differing still count as the same) */
export const mergeKey = (it, src) => it.type === 'warn' && WEBGPU_FALLBACK.test(it.msg) ? 'warn:webgpu-fallback' : it.type + it.msg.replace(/\d+(\.\d+)?/g, '#') + src;

const LABEL = { error: 'error', rejection: 'Promise rejection', resource: 'resource load failure', warn: 'warning' };
const RED = s => `\x1b[31m${s}\x1b[0m`, YELLOW = s => `\x1b[33m${s}\x1b[0m`, DIM = s => `\x1b[2m${s}\x1b[0m`;

// URL → project path: http://localhost:5173/examples/city.js?t=1:42:7 → packages/engine/examples/city.js:42:7
const shortUrl = u => u.replace(/https?:\/\/[^/\s]+\//g, '').replace(/\?[^:\s)]*(?=:\d)/g, '');
const SKIP = /threedog-error-relay|@vite\/client/;
const FRAME = /(https?:\/\/[^\s)]+?):(\d+):(\d+)/;
function sourceOf(it) {
  if (it.src) return shortUrl(it.src);
  for (const line of it.stack.split('\n')) {
    if (SKIP.test(line)) continue;   // skip the relay script itself and the vite client
    const m = FRAME.exec(line); if (m) return shortUrl(`${m[1]}:${m[2]}:${m[3]}`);
  }
  return '';
}
const clock = t => new Date(t).toTimeString().slice(0, 8);

const CUT = /^# …earlier content truncated, (\d+) records/m;
/** How many records a cut has dropped so far: the first id of the log is this + 1, so an id means the same error before and after a cut */
export const recordsCut = text => Number(CUT.exec(text)?.[1] ?? 0);
/** The log with only its last keep bytes, cut between two records. The first line stays, since it names this dev-server run (errorlog.mjs) */
export function cutLog(text, keep) {
  const from = text.indexOf('\n[browser', Math.max(0, text.length - keep));
  if (from < 0) return text;
  const gone = recordsCut(text) + (text.slice(0, from).match(/^\[browser [^\]×]+\]/gm)?.length ?? 0);
  return `${text.split('\n', 1)[0]}\n# …earlier content truncated, ${gone} records${text.slice(from)}`;
}

/** @param o warn: whether to forward console.warn (default true); logFile: log path (relative to vite's root, i.e. the workspace directory); maxBytes: log size cap */
export default function errorRelay({ warn = true, logFile = '.threedog/errors.log', maxBytes = 1 << 20 } = {}) {
  let root;
  return {
    name: 'threedog-error-relay',
    apply: 'serve',
    // Vite 8 forwards on its own when it detects it runs inside an AI tool (printing each one, no merging), which duplicates this, so turn it off unless set by hand
    config: c => c.server?.forwardConsole === undefined ? { server: { forwardConsole: false } } : undefined,
    // A hot update replaces the code that threw: errors before it stop counting as the page's current ones (errors latest still lists them), like a reload does
    handleHotUpdate() { if (root) markReload(root); },
    configureServer(server) {
      root = server.config.root;
      const file = resolve(server.config.root, logFile), log = server.config.logger;
      mkdirSync(resolve(file, '..'), { recursive: true });
      writeFileSync(file, `# Browser error log (cleared when dev starts at ${new Date().toLocaleString()})\n`);
      let size = 0;
      const write = text => {
        appendFileSync(file, text); size += Buffer.byteLength(text);
        if (size > maxBytes) {   // too big: keep only the second half
          writeFileSync(file, cutLog(readFileSync(file, 'utf8'), Math.floor(maxBytes / 2))); size = maxBytes / 2;
          seen.clear();   // a repeat line needs its record above it, and that may be gone: the next one writes the record again
        }
      };
      const seen = new Map();   // merge key → { it, src, total, pending }
      const print = (it, text) => (it.type === 'warn' ? log.warn : log.error)(text, { timestamp: false });

      setInterval(() => {   // summarize repeats
        for (const s of seen.values()) if (s.pending) {
          const line = `[browser ${LABEL[s.it.type]} ×${s.pending}, ${s.total} total] ${clock(Date.now())} same as above: ${oneLine(s.it.msg)}${s.src ? ' (' + s.src + ')' : ''}`;
          print(s.it, DIM(line)); write(line + '\n'); s.pending = 0;
        }
      }, 2000).unref();

      server.middlewares.use(ENDPOINT, async (req, res) => {
        if (req.method !== 'POST' || !isLocalRequest(req, { sameOrigin: true })) { res.statusCode = 403; return res.end(); }
        let list;
        try { list = JSON.parse(String(await readBody(req, MAX_BODY))); } catch { res.statusCode = 400; return res.end(); }
        res.statusCode = 204; res.end();
        if (!Array.isArray(list)) return;
        for (const raw of list.slice(0, MAX_ITEMS)) try {
          if (!valid(raw)) continue;
          const it = { stack: '', src: '', page: '', count: 1, t: Date.now(), ...raw };
          it.count = Math.max(1, Math.min(1e6, Math.floor(it.count))); it.msg = it.msg.slice(0, 2000); it.stack = it.stack.slice(0, 4000);
          const src = sourceOf(it), key = mergeKey(it, src);
          const s = seen.get(key);
          // a warning says the same thing every time (most are warned once per page, so once per reload): only its first line is kept, repeats
          // are counted silently; an error's repeats are still summarized, since how often it happens is news
          if (s) { s.total += it.count; if (it.type !== 'warn') s.pending += it.count; continue; }
          seen.set(key, { it, src, total: it.count, pending: it.type === 'warn' ? 0 : it.count - 1 });
          const page = it.page.slice(0, 200).replace(/\s+/g, ' ');
          const head = `[browser ${LABEL[it.type]}] ${clock(Number(it.t) || Date.now())}${it.tick === undefined ? '' : ' tick ' + Math.floor(it.tick)}`;
          // "Possible cause / Read" for known error classes comes from the engine's table, so it is the only text written unquoted
          const hint = /\n\s*Possible cause:/.test(it.msg) ? '' : hintText(it.msg);
          const stack = it.stack.split('\n').filter(l => /^\s*at /.test(l) && !SKIP.test(l)).slice(0, 4).map(l => shortUrl(l.trim())).join('\n');
          const color = it.type === 'warn' ? YELLOW : RED;
          print(it, `${color(head)} ${page}\n${quote(it.msg)}${hint}${src ? '\n  ' + DIM('at ' + src) : ''}`);
          write(`${head}\n${quote(`${page}\n${it.msg}${src ? '\nat ' + src : ''}${stack ? '\n' + stack : ''}`)}${hint}\n\n`);
        } catch { /* one bad item never takes the dev server down */ }
      });
    },
    transformIndexHtml() {
      const levels = JSON.stringify(warn ? ['error', 'warn'] : ['error']);
      return [{ tag: 'script', children: CLIENT.replace('__LEVELS__', levels), injectTo: 'head-prepend' }];
    },
  };
}
