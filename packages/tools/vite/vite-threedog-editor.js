// The in-browser editor's server side (plan docs/plans/done/2026-11-05-editor.md). Dev server only (apply: 'serve'): a production build has no trace of it,
// and a game needs no line of its own, because the loader below is put into every page the dev server serves.
//   Loader      F2, or ?edit=1 in the address: imports @threedog/tools/editor once the engine is up. Why F2 reloads the page instead of opening in place:
//               leaving must show the game as the files say, and a reload is the one way that is always true; the address keeps the mode across reloads.
//   /__threedog/design  POST { op: 'read', id } | { op: 'write' | 'add' | 'remove' | 'restore', ... }: forwards to contentRead / contentWrite and knows nothing
//               of the content format, so a new format changes those two and not this file. The browser sends an id, never a path of its own: the file comes
//               from the id index (restore hands back the file a remove replied with, and contentWrite still refuses anything outside content/).
//               One request at a time: two writes must not edit the same old text.
//   Reloads     a write of our own must not reload the page under the user's hands. handleHotUpdate compares the file's text with what we wrote: the same
//               text is our write, any other text is a hand or AI edit and reloads as usual (the page must never go on with old values).
//               Compared by text, not by a time window: a hand edit a moment after a write is still seen.
import { readFileSync } from 'node:fs';
import { normalizePath } from 'vite';
import { contentRead, contentWrite } from '../content-write.mjs';
import { isLocalRequest, readBody, orderedQueue, jsonReply } from './local.js';

const VIRTUAL = 'virtual:threedog-editor', RESOLVED = '\0' + VIRTUAL;
const LOADER = `
const on = new URLSearchParams(location.search).has('edit');
addEventListener('keydown', e => {
  if (e.code !== 'F2') return;
  const url = new URL(location.href);
  if (on) url.searchParams.delete('edit'); else url.searchParams.set('edit', '1');
  location.assign(url);
});
if (on) {
  const wait = () => window.engine?.ready ? import('@threedog/tools/editor').then(m => m.openEditor(window.engine)) : requestAnimationFrame(wait);
  wait();
}
`;

/** @returns {import('vite').Plugin} */
export default function threedogEditor() {
  const written = new Map();   // normalized path -> the text our last write left there
  const inOrder = orderedQueue();
  let root = process.cwd();
  return {
    name: 'threedog-editor',
    apply: 'serve',
    // Found only when the editor opens, which is too late: Vite would stop to bundle them and reload the page. Named here they are ready from the start
    config: () => ({ optimizeDeps: { include: ['three/addons/controls/OrbitControls.js', 'three/addons/controls/TransformControls.js'] } }),
    configResolved(c) { root = c.root; },
    resolveId: id => id === VIRTUAL ? RESOLVED : undefined,
    load: id => id === RESOLVED ? LOADER : undefined,
    transformIndexHtml: () => [{ tag: 'script', attrs: { type: 'module', src: '/@id/__x00__' + VIRTUAL }, injectTo: 'head' }],
    async handleHotUpdate({ file }) {
      await inOrder.idle();   // the watcher fires as soon as the file lands, while the write is still checking it: `written` is only right after that
      const key = normalizePath(file), mine = written.get(key);
      if (mine === undefined) return undefined;
      try { if (readFileSync(file, 'utf8') === mine) return []; } catch { /* gone: let vite say so */ }
      written.delete(key);   // someone else's text now: a later `git checkout` back to our last write is theirs too, and the page must reload for it
      return undefined;
    },
    configureServer(server) {
      const answer = async ({ op, ...req }) => {
        if (op === 'read') return contentRead(root, { id: req.id, kind: req.kind });
        if (!['write', 'add', 'remove', 'restore'].includes(op)) return { ok: false, error: `unknown op '${op}': read, write, add, remove or restore` };
        // JSON has no undefined: the page says "the file has no such field" with null, which contentWrite's expect spells as undefined
        const set = op === 'write' && { op: 'set', expect: Object.fromEntries(Object.entries(req.expect ?? {}).map(([k, v]) => [k, v === null ? undefined : v])) };
        const { path, ...out } = await contentWrite(root, { op, ...req, ...set });
        if (out.ok) written.set(normalizePath(path), readFileSync(path, 'utf8'));
        return out;   // without the path: the page has no use for it
      };
      server.middlewares.use('/__threedog/design', (req, res) => {
        const reply = jsonReply(res);
        // POST only: a browser always sends Origin on it, so a foreign page cannot pass as "no Origin"; sameOrigin lets the game's own page through
        if (req.method !== 'POST' || !isLocalRequest(req, { sameOrigin: true })) return reply(403, { ok: false, error: 'the editor endpoint only takes POST from this dev server\'s own page' });
        readBody(req, 256 * 1024).then(async b => {
          try { reply(200, await inOrder(() => answer(JSON.parse(String(b))))); }
          catch (e) { reply(400, { ok: false, error: String(e.message || e) }); }
        }, e => reply(413, { ok: false, error: String(e.message) }));
      });
    },
  };
}
