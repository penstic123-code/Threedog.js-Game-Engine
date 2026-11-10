// R18 names referenced in hand-written docs still exist: docs/{AI,COMMANDS,CONVENTIONS,THREE}.md, recipes, READMEs, the game template's docs,
//   and each game's DESIGN.md, STATUS.md, docs/design/** and docs/plans/** (archived plans in docs/plans/done/ are skipped).
// Detection: only inline code spans and fenced blocks are read, never prose. Reference classes (level):
//   1. paths with an extension and a `/` (error): resolved against the doc's folder, the docs root, the engine and tools packages, the game folders
//      and the repo root; `node_modules/threedog/…` maps to the engine. A `packages/…` path in a shipped doc (engine docs, template) is an error.
//      Placeholders (<…>, *, …, xxx, my-*, games/<missing game>/) are skipped.
//   2. `threedog test name` and `npm test -- name` (error): each name must be a substring of a real test name, any case (engine and game specs, tool tests, scenarios, pack items).
//   3. `threedog cmd` / `npm run script` (error): a command of bin/threedog.mjs, or a script of the root / engine / template / game package.json.
//   4. events `noun:action` (error): in EventMap, a game's GameEvents, or emitted by game code.
//   5. `engine.x.y` (error): a property of the Engine type, then of its type
//      (TypeScript checker on the d.ts program shared with R6 / R7 / R22). Why an error there: an AI copies a name from those docs as a fact, and a
//      renamed API must take its docs along in the same change.
//   6. free functions `name(` at the start of a span (error): exported by the engine, named in any d.ts, declared in the doc set or game code,
//      or a JS / DOM global. ```js blocks are type-checked by R13, so classes 4 and 6 skip them; class 5 reads them in the engine's docs too, because R13 cannot read a block
//      that does not parse (the inside of an object, a line with an ellipsis). A game's own docs name the game's modules, so there it stays off.
//   In a game's docs (warn level) class 6 reports only a near miss of an engine export (`createEngin()`), since `build_rig()` is the game's own name.
//   7. links to `file.md#anchor` and `#anchor` (error): the target has that heading or an <a id>. Why: a recipe's section gets renamed and the link keeps sending readers nowhere.
// Known limits: names built at runtime and paths without an extension are not checked; class 6 accepts any name a d.ts mentions; option keys are R13's job (js blocks only);
//   `§` section numbers, chains after a call (`describe().x`: module names decide those), .js template comments, d.ts comments and error texts are not read.
// False positives: ALLOW below ([doc or '*', token, reason]), `<!-- r18-ignore-line -->` on the line or the line before, or the words
//   "engine repository" on the line (a pointer to a file that is not shipped). Every error carries a "did you mean" when one is close.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, relative, basename, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { walk, read, abs, rel, P, engineApi, dtsFiles, docLevel } from './_lib.mjs';
import { closest, nearest, slug } from '../lib/text.mjs';
import { workspaceSpecs } from '../lib/specs.mjs';

const ALLOW = [
  ['*', 'door:open', 'the naming convention example for a game event'],
  ['*', 'noun:action', 'the naming convention itself'],
  ['*', 'noun:verb', 'the naming convention itself'],
  ['*', 'manual:game', "a describe().owned writer tag ('manual:<who>', core/ops/owned.js), not an event"],
  [`${P.RECIPES_REL}/14-custom-module.md`, 'stamina:empty', 'the event the example module in this recipe defines'],
  [`${P.RECIPES_REL}/14-custom-module.md`, 'engine.stamina', 'the member the example module in this recipe adds'],
  [`${P.RECIPES_REL}/23-ops.md`, 'npc:state', 'an example of an event name a game may declare'],
  [`${P.RECIPES_REL}/16-dev-bridge.md`, 'assert', 'a global of `threedog js --file` scripts, not an engine export'],
  [`${P.RECIPES_REL}/16-dev-bridge.md`, 'toBeCloseTo', 'a matcher of `threedog js --file` scripts'],
  [`${P.DOCS_REL}/COMMANDS.md`, 'assert', 'a global of `threedog js --file` scripts, not an engine export'],
  [`${P.RECIPES_REL}/49-game-module-contract.md`, 'engine.machines', 'the copyable module of this recipe (named so it does not clash with engine.jobs)'],
  [`${P.RECIPES_REL}/51-capability-catalog.md`, 'engine.shop', 'the example module of this recipe'],
  [`${P.RECIPES_REL}/15-perf.md`, 'serve', 'the worker-side helper of core/threads/threadServe.js, imported inside the worker file'],
  ['*', 'codedError', "engine-internal helper (core/base/errorHints.js) named for the people who write engine code; a game never imports it"],
  ['*', 'warnOnce', 'engine-internal helper named for the people who write engine code; a game never imports it'],
  [`${P.RECIPES_REL}/09-materials-lights-models.md`, 'neutralMaterial', 'engine-internal (render/neutral.js), named in the section for engine developers'],
  [`${P.RECIPES_REL}/62-picture-code.md`, 'dayNightLights', 'a helper the example game writes in its own picture/ folder, named as a shape to copy'],
  ['*', 'updateProjectionMatrix', "three.js's own method (Camera), named in an example README"],
  ['*', 'CameraHelper', "three.js's own class, named in an example README"],
  ['*', 'uniform', "the TSL function (three/tsl), named in an example README"],
];
const GLOBALS = new Set(('setTimeout setInterval clearTimeout clearInterval requestAnimationFrame cancelAnimationFrame fetch structuredClone queueMicrotask ' +
  'addEventListener removeEventListener alert confirm prompt import require eval parseInt parseFloat isNaN isFinite Number String Boolean Array Object ' +
  'Map Set WeakMap Promise Date JSON Math Symbol Error describe it test expect check ev frames wait ceil floor round min max abs sqrt sin cos atan2 hypot').split(' '));
const PLACEHOLDER = /[<>*…]|\bxxx\b|\bname\b|\bmy-|\bNN\b|\.\.\.|\bfoo\b|\bbar\b/;
const IGNORE = '<!-- r18-ignore-line -->';
const fwd = p => p.split(sep).join('/');

/** The hand-written docs this rule reads (paths relative to ROOT) */
export function docFiles(scope = null) {
  const game = d => [...['DESIGN.md', 'STATUS.md', 'README.md'].map(f => join(d, f)).filter(existsSync).map(rel),
    ...walk(rel(join(d, 'docs')), ['.md']).filter(f => !/\/docs\/plans\/done\//.test(f))];
  if (P.MODE === 'game') return P.gameDirs().flatMap(game);
  if (scope?.notEngine) return game(scope.dir);   // check -w <game>: only this game's docs count, and reading every engine doc and spec was most of its minute
  const D = P.DOCS_REL;
  return [...['AI', 'COMMANDS', 'CONVENTIONS', 'THREE'].map(n => `${D}/${n}.md`).filter(f => existsSync(abs(f))),
    ...walk(P.RECIPES_REL, ['.md']), ...['README.md', 'README.zh-CN.md', `${P.ENGINE_REL}/README.md`,
      `${P.TOOLS_REL}/README.md`].filter(f => existsSync(abs(f))),
    ...walk(`${P.TOOLS_REL}/templates`, ['.md']), ...walk(`${P.ENGINE_REL}/examples/techniques`, ['.md']), ...P.gameDirs().flatMap(game)];
}

/** Code spans and fenced block lines of a markdown text: [{ line, text, span: bool, lang }] */
export function extract(text) {
  const out = [], L = text.split('\n');
  let fence = null;
  L.forEach((raw, i) => {
    const m = raw.match(/^\s*```(\w*)/);
    if (m) { fence = fence === null ? m[1] || 'text' : null; return; }
    if (raw.includes(IGNORE) || (L[i - 1] || '').includes(IGNORE) || /engine repository/.test(raw)) return;
    if (fence !== null) { out.push({ line: i + 1, text: raw, span: false, lang: fence }); return; }
    for (const s of raw.matchAll(/`([^`\n]+)`/g)) out.push({ line: i + 1, text: s[1], span: true, lang: '' });
  });
  return out;
}

let ctxCache = null;
/** Everything the checks resolve against (built once) */
export async function context(scope = null) {
  if (ctxCache) return ctxCache;
  const only = scope?.notEngine ? [scope.dir] : null, games = only ?? P.gameDirs();
  // test names
  const tests = [];
  // the same files npm test runs (lib/specs.mjs); a broken spec file is npm test's error to report, here it only adds no names (the other files keep theirs)
  const specsOf = async d => { try { return (await workspaceSpecs(d, [])).map(x => x.spec.name); } catch { return []; } };
  for (const d of only ?? P.workspaces()) {
    const names = await specsOf(d);
    tests.push(...names);
    if (d !== P.ENGINE) { if (!names.length) tests.push(`smoke: ${basename(d)}`); tests.push(`pack: ${rel(d)}`, `pack: dist of ${rel(d)}`); }
    const sc = join(d, 'tests', 'scenarios');
    if (existsSync(sc)) tests.push(...readdirSync(sc).filter(f => f.endsWith('.json')).map(f => `scenario: ${f.slice(0, -5)}`));
  }
  const toolTests = join(P.TOOLS, 'tests');
  if (P.MODE === 'monorepo' && !only && existsSync(toolTests)) for (const f of readdirSync(toolTests).filter(f => f.endsWith('.mjs')))
    tests.push(readFileSync(join(toolTests, f), 'utf8').match(/export const name = '([^']+)'/)?.[1] ?? f);
  // commands
  const bin = await import(pathToFileURL(join(P.TOOLS, 'bin', 'threedog.mjs')).href);
  const cli = new Set([...bin.BRIDGE, ...Object.keys(bin.SCRIPTS), ...bin.VITE, 'map']);
  const scripts = new Set();
  for (const f of [join(P.ROOT, 'package.json'), join(P.ENGINE, 'package.json'), join(P.TOOLS, 'templates', 'game', 'package.json'),
    ...games.map(d => join(d, 'package.json'))])
    if (existsSync(f)) Object.keys(JSON.parse(readFileSync(f, 'utf8')).scripts || {}).forEach(s => scripts.add(s));
  // events
  const events = new Set();
  try { (await import(pathToFileURL(abs(P.EVENTS_GEN_REL)).href)).ENGINE_EVENTS.forEach(e => events.add(e)); } catch { /* not generated yet */ }
  const gameCode = new Map();   // game dir → concatenated .js / .d.ts text
  for (const d of games) {
    const files = walk(rel(d), ['.js', '.d.ts']).filter(f => !f.includes('/tests/'));
    const text = files.map(f => read(f)).join('\n');
    gameCode.set(d, text);
    for (const m of text.matchAll(/(?:emit|on|once)\((?:[^'")]*\?\s*)?'([a-z]\w*:[a-z]\w*)'/g)) events.add(m[1]);
    for (const m of text.matchAll(/^\s*'([a-z]\w*:[a-z]\w*)'\s*:/gm)) events.add(m[1]);   // GameEvents entries
  }
  // functions: engine exports, d.ts names, functions declared in docs and games
  const api = engineApi();
  const fns = new Set([...api.exports, ...GLOBALS]);
  for (const f of dtsFiles()) for (const m of read(f).matchAll(/\b([A-Za-z_$][\w$]*)\??\s*[(:<]/g)) fns.add(m[1]);
  for (const f of [...P.ADDONS_REL.flatMap(d => walk(d, ['.d.ts', '.js'])),
    ...walk(P.TOOLS_REL, ['.mjs']).filter(f => !f.includes('/tests/'))]) for (const m of read(f).matchAll(/export (?:default )?(?:async )?function\s+(\w+)|export const (\w+)/g)) fns.add(m[1] || m[2]);
  // technique examples document the functions of their own folder's .js (pulled into a game together with the README)
  for (const f of walk(`${P.ENGINE_REL}/examples/techniques`, ['.js'])) for (const m of read(f).matchAll(/export (?:default )?(?:async )?function\s+(\w+)|export const (\w+)/g)) fns.add(m[1] || m[2]);
  for (const t of gameCode.values()) for (const m of t.matchAll(/function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|\w+\s*=>|function)/g)) fns.add(m[1] || m[2]);
  // files that can be referenced
  const known = walk(P.ENGINE_REL, ['.md', '.js', '.mjs', '.json', '.d.ts', '.html']).map(f => fwd(relative(P.ENGINE, abs(f))));
  const bases = [abs(P.DOCS_REL), P.ENGINE, P.TOOLS, P.ROOT, ...games, join(P.TOOLS, 'templates', 'game')];
  return (ctxCache = { tests, cli, scripts, events, fns, api, known, bases, games });
}

const shipped = f => P.under(f, P.DOCS_REL) || P.under(f, `${P.TOOLS_REL}/templates`);
// A name in an engine doc is a fact the AI copies, so a wrong one is an error. A game's own DESIGN / STATUS / README names the game's own modules
// (engine.farm.plant), which the engine d.ts cannot know, so there it is a warning.
const levelOf = docLevel;
const allowed = (doc, token) => ALLOW.some(([d, t]) => (d === '*' || d === doc) && t === token);

function checkPath(doc, tok, ctx) {
  let p = tok.replace(/[#?].*$/, '').replace(/:\d+(:\d+)?$/, '').replace(/^\.\//, '');
  // runtime output (.threedog/…) and command lines are not file references
  if (/\s/.test(p) || p.startsWith('.threedog/')) return null;
  if (!/\/./.test(p) || !/\.(md|js|mjs|json|d\.ts|html)$/.test(p) || /^[a-z]+:\/\//.test(p) || PLACEHOLDER.test(p)) return null;
  if (shipped(doc) && /^packages\//.test(p)) return { level: 'error', msg: `\`${tok}\` is a monorepo path in a shipped doc`,
    fix: 'write it relative to the package (recipes/…, api/…, core/…) or node_modules/threedog/…' };
  const g = p.match(/^games\/([\w-]+)\//);
  if (g && !ctx.games.some(d => basename(d) === g[1])) return null;   // an example game name (games/farm/…)
  const cands = [];
  if (/^three\/addons\//.test(p)) cands.push(join(P.ROOT, 'node_modules', 'three', 'examples', 'jsm', p.slice('three/addons/'.length)));   // three's import map
  else if (/^(node_modules\/)?threedog\//.test(p)) cands.push(join(P.ENGINE, p.replace(/^(node_modules\/)?threedog\//, '')));
  else if (p.startsWith('node_modules/@threedog/tools/')) cands.push(join(P.TOOLS, p.slice('node_modules/@threedog/tools/'.length)));
  else cands.push(resolve(dirname(abs(doc)), p), ...ctx.bases.map(b => join(b, p)));
  if (cands.some(existsSync)) return null;
  const near = closest(p, ctx.known, 6);
  return { level: levelOf(doc), msg: `path \`${tok}\` does not exist${near ? `; did you mean \`${near}\`?` : ''}`,
    fix: 'fix the path, or mark an intentional example with <!-- r18-ignore-line -->' };
}

function checkTests(doc, tok, ctx) {
  const m = tok.split(/\s(?:#|\/\/)|\s{2,}/)[0].match(/\b(?:npm (?:run )?test\s+--|threedog\s+test)\s+(.+)$/); if (!m) return [];
  const args = [...m[1].matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)].map(x => x[1] ?? x[2] ?? x[3]);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-w' || a === '--workspace') { i++; continue; }
    if (a.startsWith('-') || PLACEHOLDER.test(a) || /^[|#;]/.test(a) || a === 'name' || /^(and|or|e\.g\.)$/.test(a)) { if (/^[|#;]/.test(a)) break; continue; }
    if (!ctx.tests.some(t => t.toLowerCase().includes(a.toLowerCase()))) out.push({ level: levelOf(doc),
      msg: `\`threedog test ${a}\` matches no test${nearest(a, ctx.tests, 2).length ? `; close: ${nearest(a, ctx.tests, 2).map(t => `"${t}"`).join(', ')}` : ''}`,
      fix: 'use a fragment of a real test name, any case (threedog test --verbose lists them)' });
  }
  return out;
}

function checkCli(doc, tok, ctx) {
  const out = [];
  for (const m of tok.matchAll(/(?:^|\bnpx\s+|[;&|]\s*)threedog\s+([a-z][\w-]*)/g)) if (!ctx.cli.has(m[1]) && !PLACEHOLDER.test(m[1]))
    out.push({ level: levelOf(doc), msg: `\`threedog ${m[1]}\` is not a command${closest(m[1], [...ctx.cli]) ? `; did you mean \`threedog ${closest(m[1], [...ctx.cli])}\`?` : ''}`, fix: 'the commands are listed by threedog' });
  for (const m of tok.matchAll(/\bnpm run ([\w:-]+)/g)) if (!ctx.scripts.has(m[1]) && !PLACEHOLDER.test(m[1]))
    out.push({ level: levelOf(doc), msg: `\`npm run ${m[1]}\` is not a script${closest(m[1], [...ctx.scripts]) ? `; did you mean \`npm run ${closest(m[1], [...ctx.scripts])}\`?` : ''}`, fix: 'use a script from package.json' });
  return out;
}

function checkEvents(doc, item, ctx) {
  const names = [];
  const whole = item.span && item.text.match(/^'?([a-z][A-Za-z]*:[a-z][A-Za-z]*)'?$/);
  if (whole) names.push(whole[1]);
  for (const m of item.text.matchAll(/\b(?:on|once|emit|off)\(\s*'([a-z][A-Za-z]*:[a-z][A-Za-z]*)'/g)) names.push(m[1]);
  return [...new Set(names)].filter(n => !ctx.events.has(n) && !allowed(doc, n) && !/^(https?|wss?|data|blob|file|node|npm)$/.test(n.split(':')[0])).map(n => {
    const near = closest(n, [...ctx.events]);
    return { level: levelOf(doc), msg: `event \`${n}\` is not in EventMap, a game's GameEvents or game code${near ? `; did you mean \`${near}\`?` : ''}`,
      fix: 'fix the name, or declare the game event in its GameEvents' };
  });
}

function checkMembers(doc, item, ctx) {
  const out = [], { checker, engine, typeOf } = ctx.api;
  if (!engine) return out;
  const level = levelOf(doc);
  for (const m of item.text.matchAll(/(?<![\w.$])engine\.([A-Za-z_$][\w$]*)(?:\??\.([A-Za-z_$][\w$]*))?/g)) {
    const [, a, b] = m;
    if (PLACEHOLDER.test(a) || (b && PLACEHOLDER.test(b)) || allowed(doc, `engine.${a}`)) continue;   // ALLOW: 'engine.crops' = an example module's member
    const sa = checker.getPropertyOfType(engine, a);
    if (!sa) { const near = closest(a, checker.getPropertiesOfType(engine).map(s => s.name)); out.push({ level,
      msg: `\`engine.${a}\` is not on Engine${near ? `; did you mean \`engine.${near}\`?` : ''}`,
      fix: 'fix the name (api/engine.md lists the members)' }); continue; }
    if (!b) continue;
    const t = typeOf(sa);
    if (!t || t.flags & 1 /* any */) continue;
    const props = checker.getPropertiesOfType(t);
    if (!props.length || checker.getPropertyOfType(t, b)) continue;
    const near = closest(b, props.map(s => s.name));
    // an open type accepts any name; only a near miss of a known one is a typo
    if (checker.getIndexInfosOfType(t).length && !near) continue;
    out.push({ level, msg: `\`engine.${a}.${b}\` does not exist${near ? `; did you mean \`engine.${a}.${near}\`?` : ''}`,
      fix: `fix the name (the members are in api/${a}.md)` });
  }
  return out;
}

function checkFn(doc, item, ctx) {
  const m = item.span && item.text.match(/^([A-Za-z_$][\w$]*)\((?!s\))/);   // stair(s) is a plural, not a call
  if (!m || ctx.fns.has(m[1]) || PLACEHOLDER.test(m[1]) || allowed(doc, m[1])) return [];
  const near = closest(m[1], [...ctx.api.exports]);
  // a game's own docs name its own helpers (a Blender script's build_rig()): only a near miss of an engine export claims to be engine API
  if (levelOf(doc) === 'warn' && !near) return [];
  return [{ level: levelOf(doc), msg: `\`${m[1]}()\` is not an engine export or a name the d.ts knows${near ? `; did you mean \`${near}()\`?` : ''}`,
    fix: 'fix the name, or import it from where it lives' }];
}

/** All problems in one doc (exported for the rule tests) */
export function checkDoc(doc, text, ctx) {
  const out = [];
  for (const it of extract(text)) {
    const at = r => ({ ...r, file: doc, line: it.line });
    if (it.span) { const p = checkPath(doc, it.text.trim(), ctx); if (p) out.push(at(p)); }
    if (it.lang === 'js') {   // R13 type-checks js blocks; commands in their comments are examples
      if (levelOf(doc) === 'error') out.push(...checkMembers(doc, it, ctx).map(at));
      continue;
    }
    for (const r of [...checkTests(doc, it.text, ctx), ...checkCli(doc, it.text, ctx)]) out.push(at(r));
    for (const r of [...checkEvents(doc, it, ctx), ...checkMembers(doc, it, ctx), ...checkFn(doc, it, ctx)]) out.push(at(r));
  }
  return out;
}

/** GitHub's heading anchor: lower case, punctuation gone, spaces to dashes */
const anchorsOf = text => new Set([...[...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => slug(m[1])), ...[...text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)].map(m => m[1])]);

/** Class 7 on one doc's text */
export function checkAnchors(doc, text, readFile = f => existsSync(f) ? readFileSync(f, 'utf8') : null) {
  const out = [], lineAt = i => text.slice(0, i).split('\n').length;
  for (const m of text.matchAll(/\]\(([^()\s#]*\.md)?#([^()\s]+)\)/g)) {
    const target = m[1] ? readFile(resolve(dirname(abs(doc)), m[1])) : text;
    if (target != null && !anchorsOf(target).has(decodeURIComponent(m[2]))) out.push({ level: levelOf(doc), file: doc, line: lineAt(m.index), msg: `link to ${m[1] ?? ''}#${m[2]}: no such heading or <a id>`, fix: 'point it at the section as it is named now' });
  }
  return out;
}

export default {
  id: 'R18', title: 'Names referenced in hand-written docs exist', game: true,
  async run({ scope = null } = {}) {
    const ctx = await context(scope), docs = docFiles(scope), out = [];
    for (const d of docs) out.push(...checkDoc(d, read(d), ctx), ...checkAnchors(d, read(d)));
    out.note = `${docs.length} docs, ${ctx.tests.length} test names, ${ctx.events.size} event names`;
    return out;
  },
};
