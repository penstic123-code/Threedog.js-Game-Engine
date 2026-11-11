// Detection: R70 a file imported only for what it does when loaded is listed in the engine package's "sideEffects" (error). `import './x.js'` with no names
// says x.js matters by running (it patches three.js, registers a node, fills a table). The engine's package.json lists such files in "sideEffects"; a bundler
// drops every other file nobody takes a name from, the dev server's pre-bundle included, and says nothing: the patch is simply not there in the game.
// The other way round too: a listed path with no file behind it is an error, so the list cannot rot.
// Known limits: reads static imports in engine code only (a dynamic import() keeps its file anyway); a file that has side effects and is always imported
// by name is not seen. Engine repository only.
import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import { read, lines, abs, engineFiles, P } from './_lib.mjs';

const BARE = /^\s*import\s+['"](\.{1,2}\/[^'"]+)['"]/;

/** @param {{ file: string, text: string[] }[]} files engine-relative paths ('render/fx/index.js') with their lines @param {string[]} listed the "sideEffects" entries
 *  @param {(path: string) => boolean} exists @returns {{ level: 'error', file: string, line: number, msg: string, fix: string }[]} */
export function sideEffectProblems(files, listed, exists) {
  const out = [], set = new Set(listed.map(p => posix.normalize(p)));
  for (const { file, text } of files) text.forEach((l, i) => {
    const m = BARE.exec(l); if (!m) return;
    const target = posix.join(posix.dirname(file), m[1]);
    if (!set.has(target)) out.push({ level: /** @type {const} */ ('error'), file, line: i + 1, msg: `${m[1]} is imported only for its side effects and is not in package.json "sideEffects": a bundler drops it`, fix: `add "./${target}" to "sideEffects" in the engine's package.json` });
  });
  for (const p of set) if (!exists(p)) out.push({ level: /** @type {const} */ ('error'), file: 'package.json', line: 1, msg: `"sideEffects" lists ./${p}, which does not exist`, fix: 'delete the entry, or correct its path' });
  return out;
}

export default {
  id: 'R70', title: 'A file imported only for its side effects is listed in "sideEffects"', game: false,
  run() {
    const pkg = `${P.ENGINE_REL}/package.json`, listed = JSON.parse(read(pkg)).sideEffects;
    if (!Array.isArray(listed)) return [{ level: 'error', file: pkg, line: 1, msg: 'the engine package.json has no "sideEffects" list', fix: 'restore the list: every file that matters by being loaded' }];
    const inEngine = f => f.slice(P.ENGINE_REL.length + 1);
    const out = sideEffectProblems(engineFiles().map(f => ({ file: inEngine(f), text: lines(f) })), listed, p => existsSync(abs(`${P.ENGINE_REL}/${p}`)));
    for (const r of out) r.file = `${P.ENGINE_REL}/${r.file}`;
    return Object.assign(out, { note: `${listed.length} listed files` });
  },
};
