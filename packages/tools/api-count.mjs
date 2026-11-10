// threedog api-count [--json] [--unused] [--games dirA,dirB,…]: count the public surface an AI meets, and list the items nothing uses (deletion candidates;
// the ones kept on purpose are reported apart, see keptWhy).
// Source of truth: the public type declarations (index.d.ts, types/tsl.d.ts, @threedog/post-effects index.d.ts) read with the TypeScript checker,
// because that is what an AI's editor and `npm run types` see, and the checker resolves generated re-exports, inheritance and ModuleDef<Api>.
// The CLI comes from the command tables in bin/threedog.mjs and the literal option lists of each tool; error codes from core/base/errorCodes.js.
// "Used" = found in engine sources, examples, the new-game templates or recipe code blocks (tests and prose docs are not users). Name matching is
// a heuristic: a name shared by several items must be written qualified (parent.name) to count. Record: docs/testing/api-count.md.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ROOT, ENGINE, TOOLS, MODE, addonDir, cli, rel } from './paths.mjs';
import { walk, esc } from './lib/text.mjs';

const require = createRequire(import.meta.url);
/** How a lock line says "may still change" (a trailing word: the file merges by line, so only the marked lines move) */
export const EXPERIMENTAL = '@experimental';

/**
 * All public items: { group, name, decl, kind, handle } (decl: repo-relative file of the declaration; handle: for a function, whether what it returns has remove(),
 * null when it is not callable; rules/R69 reads it). Built once per process: the API lock (R55) and the verb rule (R69) read the same checker pass.
 */
let collected = null;
// copies: callers mark items (used, games), and the next caller must see the clean pass
function collect() { return (collected ??= collectNow()).map(i => ({ ...i })); }
export const publicItems = collect;
function collectNow() {
  const ts = require('typescript');
  const entries = [join(ENGINE, 'index.d.ts'), join(ENGINE, 'types/tsl.d.ts'), join(addonDir('post-effects'), 'index.d.ts'), join(addonDir('post-effects'), 'tsl.d.ts')].filter(existsSync);
  const program = ts.createProgram(entries, { noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext });
  const ch = program.getTypeChecker(), items = [];
  const declOf = s => { const d = s?.declarations?.[0]; return d ? rel(d.getSourceFile().fileName) : '?'; };
  const fromLib = s => s?.declarations?.some(d => /node_modules[\\/](@types[\\/]three|typescript[\\/]lib)[\\/]/.test(d.getSourceFile().fileName));
  // what: the first sentence of the declaration's doc comment (the list of candidates says what each one is)
  const what = s => (s ? ts.displayPartsToString(s.getDocumentationComment(ch)) : '').split(/\n|(?<=[.;:])\s/)[0].slice(0, 120);
  // sig: the type as the editor shows it (the API lock compares it: a changed parameter or option type is a break); '?' marks an optional member
  // a type from a package prints as an absolute path: keep only the package part, so the lock does not hold this machine's folders
  const portable = text => text.replace(/import\("[^"]*\/node_modules\/(?:@types\/)?([^"]+)"\)/g, 'import("$1")').replace(/import\("[^"]*\/packages\/engine\/([^"]+)"\)/g, 'import("threedog/$1")');
  const sigOf = s => { const d = s?.declarations?.[0]; if (!d) return ''; try { return (s.flags & ts.SymbolFlags.Optional ? '?' : '') + portable(ch.typeToString(ch.getTypeOfSymbolAtLocation(s, d), d, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope).replace(/\s+/g, ' ')); } catch { return ''; } };
  // experimental: the name carries @experimental, or its parent does (a module, an engine member); one tag covers what hangs off it
  const tagged = s => !!s?.getJsDocTags?.(ch).some(t => t.name === 'experimental');
  // handle: in every call signature, every non-null part of the awaited return type has a remove() callable with no arguments (a union with a plain
  // value fails: a caller cannot always undo it; an overload that returns something else fails too)
  // not getNonNullableType here: a remove that may be undefined (remove?: or | null) is not a handle a caller can always call
  const callableBare = (p, at) => { const t = ch.getTypeOfSymbolAtLocation(p, at); return !(t.flags & ts.TypeFlags.Union && t.types.some(u => u.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null))) && t.getCallSignatures().some(c => c.parameters.every(q => q.valueDeclaration?.questionToken || q.valueDeclaration?.initializer || q.valueDeclaration?.dotDotDotToken)); };
  const handleOf = s => { const d = s?.declarations?.[0], cs = d ? ch.getNonNullableType(ch.getTypeOfSymbolAtLocation(s, d)).getCallSignatures() : []; if (!cs.length) return null;
    return cs.every(c => { const r = ch.getNonNullableType(ch.getAwaitedType(c.getReturnType()) ?? c.getReturnType());
      return (r.isUnion() ? r.types : [r]).every(t => { const p = ch.getPropertyOfType(t, 'remove'); return !!p && !(p.flags & ts.SymbolFlags.Optional) && callableBare(p, d); }); }); };
  const add = (group, name, s, kind, parent = false) => items.push({ group, name, decl: declOf(s), kind, what: what(s), sig: sigOf(s), experimental: parent || tagged(s), handle: handleOf(s) });
  const propsOf = t => t ? ch.getPropertiesOfType(ch.getNonNullableType(t)).filter(p => !p.name.startsWith('_') && !p.name.startsWith('#') && !p.name.startsWith('__@') && !p.getJsDocTags(ch).some(t => t.name === 'internal')) : [];
  const typeOf = (s, at) => ch.getTypeOfSymbolAtLocation(s, at);
  const isCallable = t => ch.getNonNullableType(t).getCallSignatures().length > 0;
  const isObj = t => { const n = ch.getNonNullableType(t); return !!(n.flags & ts.TypeFlags.Object) && !isCallable(n) && propsOf(n).length > 0 && !ch.isArrayType(n); };
  const modOf = f => ch.getSymbolAtLocation(program.getSourceFile(f));
  const exportsOf = f => { const m = modOf(f); return m ? ch.getExportsOfModule(m).map(s => s.flags & ts.SymbolFlags.Alias ? ch.getAliasedSymbol(s) : s) : []; };
  const index = program.getSourceFile(entries[0]);

  // exported values ('threedog', 'threedog/tsl', '@threedog/post-effects'); module factories are counted again below as modules
  // a class declared for its type (Sky, Weather) reads as a value in the .d.ts: only what index.js really exports is one
  const script = ts.createSourceFile('index.js', readFileSync(join(ENGINE, 'index.js'), 'utf8'), ts.ScriptTarget.Latest), values = new Set();
  for (const st of script.statements) {
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) for (const e of st.exportClause.elements) values.add(e.name.text);
    else if (st.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) for (const d of st.declarationList?.declarations ?? [st]) values.add(d.name.text);
  }
  const exp = exportsOf(entries[0]).filter(s => s.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable | ts.SymbolFlags.Class) && s.name !== 'THREE' && values.has(s.name));
  for (const s of exp) add('exports threedog', s.name, s, 'export');
  for (const s of exportsOf(entries[1]).filter(s => s.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable))) add('exports threedog/tsl', s.name, s, 'export');
  for (const entry of entries.slice(2)) for (const s of exportsOf(entry).filter(s => s.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable))) add('exports @threedog/post-effects', s.name, s, 'export');

  // createEngine options
  const ce = exp.find(s => s.name === 'createEngine');
  const ceSig = typeOf(ce, index).getCallSignatures()[0];
  for (const p of propsOf(typeOf(ceSig.parameters[0], index))) add('createEngine options', p.name, p, 'option');

  // module factories: functions returning ModuleDef<Api>, or an array or tuple of them (weather: state and drawing); options = the first parameter's keys, API = each Api's members named by the engine
  // property that holds it (engine.cameraRig for the four cameras: one API type is counted once)
  const engineSym = exportsOf(entries[0]).find(s => s.name === 'Engine' && s.flags & ts.SymbolFlags.Class);
  const engineProps = propsOf(ch.getDeclaredTypeOfSymbol(engineSym));
  const holder = new Map(engineProps.map(p => [ch.getNonNullableType(typeOf(p, index)).symbol, p]).filter(([s]) => s));
  const apiSyms = new Set();
  const isDef = t => t.aliasSymbol?.name === 'ModuleDef' || t.symbol?.name === 'ModuleDef';
  const defsOf = t => isDef(t) ? [t] : ch.isArrayType(t) || ch.isTupleType(t) ? ch.getTypeArguments(t).filter(isDef) : [];
  for (const s of exp) {
    const sig = typeOf(s, index).getCallSignatures()[0], defs = sig ? defsOf(sig.getReturnType()) : [];
    if (!defs.length) continue;
    const opt = sig.parameters[0] && typeOf(sig.parameters[0], index);
    if (opt && !(ch.getNonNullableType(opt).flags & ts.TypeFlags.Any)) for (const p of propsOf(opt)) add('module options', `${s.name}.${p.name}`, p, 'option', tagged(s));
    for (const ret of defs) {
      const api = ret.aliasTypeArguments?.[0] ?? ret.typeArguments?.[0] ?? ch.getTypeArguments?.(ret)?.[0];
      if (!api || api.flags & ts.TypeFlags.Any || !api.symbol || apiSyms.has(api.symbol)) continue;
      apiSyms.add(api.symbol);
      const at = holder.get(api.symbol), whole = tagged(s) || tagged(at) || tagged(api.symbol);
      for (const p of propsOf(api)) add('module APIs', `${at?.name ?? s.name}.${p.name}`, p, 'member', whole);
    }
  }

  // engine.*: members, and one level into core sub-objects (not three.js / DOM / built-in objects or module APIs)
  for (const p of engineProps) {
    add('engine members', p.name, p, 'member');
    const t = typeOf(p, index);
    const nt = ch.getNonNullableType(t);
    if (!isObj(t) || fromLib(nt.symbol) || apiSyms.has(nt.symbol) || nt.flags & ts.TypeFlags.Any) continue;
    for (const q of propsOf(t)) if (!fromLib(q)) add('engine sub-objects', `${p.name}.${q.name}`, q, 'member', tagged(p));
  }
  return items;
}

/** CLI commands (bin tables) and their options (the literal flags / values lists each tool passes to the shared parser) */
async function cliItems() {
  const { SCRIPTS, BRIDGE, VITE } = await import('./bin/threedog.mjs');
  const items = [...VITE, 'map', ...Object.keys(SCRIPTS), ...BRIDGE].map(c => ({ group: 'CLI commands', name: c, decl: 'packages/tools/bin/threedog.mjs', kind: 'cli' }));
  const seen = new Set();
  for (const f of walk(TOOLS, { exts: /\.mjs$/, skip: ['tests', 'templates'] })) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\b(flags|values|lists):\s*\[([^\]]*)\]/g)) for (const q of m[2].matchAll(/'([a-z][\w-]*)'/g)) {
      const key = rel(f) + ' --' + q[1];
      if (!seen.has(key)) { seen.add(key); items.push({ group: 'CLI options', name: '--' + q[1], decl: rel(f), kind: 'flag' }); }
    }
  }
  return items;
}

/** The API lock: one sorted line per public name, `group | name | signature`, with EXPERIMENTAL after the signature of a name that may still change. The committed snapshot is docs/api-surface.txt (rules/R55-api-lock.mjs compares it) */
export async function surfaceLines() {
  const items = [...collect(), ...await cliItems(), ...await errorItems(), ...await eventItems()];
  return [...new Set(items.map(i => `${i.group} | ${i.name} | ${[i.sig, i.experimental && EXPERIMENTAL].filter(Boolean).join(' ')}`.trimEnd()))].sort();
}

/** Event names (core/base/events.generated.js, from EventMap): a game listens to them by name, so a rename is a break the lock guards. Not counted in the surface totals (names, not callable API) */
async function eventItems() {
  const { ENGINE_EVENTS } = await import(pathToFileURL(join(ENGINE, 'core/base/events.generated.js')).href);
  return ENGINE_EVENTS.map(n => ({ group: 'events', name: n, decl: 'packages/engine/types/core.d.ts', kind: 'event' }));
}

async function errorItems() {
  const { ERROR_CODES } = await import(pathToFileURL(join(ENGINE, 'core/base/errorCodes.js')).href);
  return Object.keys(ERROR_CODES).map(c => ({ group: 'error codes', name: c, decl: rel(join(ENGINE, 'core/base/errorCodes.js')), kind: 'error' }));
}

// ── who uses it ──
const files = (d, exts) => walk(d, { exts, skip: ['tests', 'docs', 'types'] });
/** The text of every user: [{ file, where, text }]; where = 'engine' | 'example' | 'template' | 'recipe' */
function corpus() {
  const code = /\.(m?js|html|json)$/;
  const out = [];
  for (const d of ['core', 'modules', 'render', 'ui']) for (const f of files(join(ENGINE, d), /\.js$/)) out.push({ file: rel(f), where: 'engine', text: readFileSync(f, 'utf8') });
  out.push({ file: rel(join(ENGINE, 'index.js')), where: 'engine', text: readFileSync(join(ENGINE, 'index.js'), 'utf8') });
  // presets are option bundles a game picks: they count as a user of the options they set
  out.push({ file: rel(join(ENGINE, 'presets.js')), where: 'preset', text: readFileSync(join(ENGINE, 'presets.js'), 'utf8') });
  for (const a of ['post-effects', 'terrain-noise']) for (const f of files(addonDir(a), /\.js$/)) out.push({ file: rel(f), where: 'engine', text: readFileSync(f, 'utf8') });
  for (const f of files(join(ENGINE, 'examples'), code)) out.push({ file: rel(f), where: 'example', text: readFileSync(f, 'utf8') });
  for (const f of files(join(TOOLS, 'templates'), /\.(m?js|html|json|md)$/)) out.push({ file: rel(f), where: 'template', text: readFileSync(f, 'utf8') });
  const rdir = join(ENGINE, 'docs/recipes');
  for (const n of existsSync(rdir) ? readdirSync(rdir).filter(n => n.endsWith('.md')) : []) {
    const blocks = [...readFileSync(join(rdir, n), 'utf8').matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(m => m[1]).join('\n');
    out.push({ file: rel(join(rdir, n)), where: 'recipe', text: blocks });
  }
  return out;
}

/** Mark each item used / unused; returns the unused ones */
function usage(items, texts) {
  const leaf = i => i.name.split('.').pop();
  const count = new Map();
  for (const i of items) count.set(i.kind + ':' + leaf(i), (count.get(i.kind + ':' + leaf(i)) ?? 0) + 1);
  const hit = re => texts.some(t => re.test(t.text));
  const raised = new Set();
  // a code is raised when engine code names it as a string or a [code] tag (often through a variable: const code = slot ? 'a' : 'b')
  for (const t of texts) if (t.where === 'engine' && !t.file.endsWith('core/base/errorCodes.js')) for (const m of t.text.matchAll(/['"`[]([a-z0-9]+(?:-[a-z0-9]+)+)['"`\]]|\b(?:codedError|coded)\(\s*'([a-z0-9-]+)'/g)) raised.add(m[1] ?? m[2]);
  for (const i of items) {
    const n = esc(leaf(i)), parent = i.name.includes('.') ? esc(i.name.split('.').slice(-2, -1)[0]) : null;
    const unique = count.get(i.kind + ':' + leaf(i)) === 1;
    let used;
    switch (i.kind) {
      case 'export': used = hit(new RegExp(`(^|[^\\w.$'"])${n}\\b(?!\\s*[:(]?\\s*function)`, 'm')) && texts.some(t => new RegExp(`\\b${n}\\s*\\(|import\\s*\\{[^}]*\\b${n}\\b|\\b${n}\\.|[,(\\[]\\s*${n}\\b`).test(t.text.replace(new RegExp(`(export\\s+)?(async\\s+)?function\\s+${n}\\b|export\\s+(const|let|class)\\s+${n}\\b`, 'g'), ''))); break;
      case 'option': used = texts.some(t => t.where !== 'engine' && new RegExp(`\\b${n}\\s*:`).test(t.text)) ||(i.group === 'createEngine options' && texts.some(t => new RegExp(`createEngine\\([^)]*\\b${n}\\b`).test(t.text))); break;
      case 'cli': used = texts.some(t => t.where !== 'engine' && new RegExp(`(threedog|npm run)\\s+${n}\\b|"${n}"\\s*:`).test(t.text)); break;
      case 'flag': used = true; break;   // options are not traced per command (a flag name alone says too little); counted only
      case 'error': used = raised.has(i.name); break;
      default: {
        const q = parent ? new RegExp(`\\b${parent}\\??\\.${n}\\b`) : new RegExp(`\\bengine\\??\\.${n}\\b`);
        const bare = new RegExp(`\\.${n}\\b(?!\\s*=[^=>])|\\{[^}]*\\b${n}\\b[^}]*\\}\\s*=\\s*(engine|this)`);
        used = hit(q) || (unique && hit(bare));
      }
    }
    i.used = !!used;
  }
  return items.filter(i => !i.used);
}

// Kept (留 in docs/testing/api-count.md): unused items the owner decided to keep, reported apart so they stop being candidates. CLI commands
// live in the terminal, not in code; error codes are what a game reads when something fails; an option with a default is tuning a game reaches
// for when it needs it. Except the picture parameters below: they still sit on module options and wait for the owner's call on moving them
// elsewhere (the proposal on that page), so they stay candidates.
const PICTURE_MOVE = new Set(['sky.dim', 'sky.skybox',
  'water.waveScale', 'water.waveSpeed', 'water.normalScale', 'water.normalRepeat', 'water.normalSpeed']);

// Kept on purpose after the 0.7 audit (docs/testing/api-count.md): name -> why. Read-only facts and the other half of a pair stay because plain
// three.js does not give them and a game or a test reaches for them when debugging; "taught" ones belong in a recipe and are not dead.
const KEPT_API = new Map();
const keep = (why, ...names) => { for (const n of names) KEPT_API.set(n, why); };
keep('read-only fact for debugging, UI or tests', 'slope', 'stateApplied', 'player.radius', 'player.water', 'player.gravity', 'player.channel', 'player.support', 'player.groundType',
  'player.ready', 'player.whenReady', 'saves.ready', 'input.contexts', 'audio.value', 'post.list', 'plugins.list', 'threads.shared', 'runState.owners', 'random.state',
  'startup.startMs', 'startup.preloadMs', 'startup.streamMs', 'startup.modules', 'cameraOverride.focus', 'lightPool.lights', 'lightPool.focus',
  'vegetation.get', 'vegetation.list', 'vegetation.isRemoved', 'rigid.stats', 'dialogue.speaking', 'inventory.list', 'inventory.get', 'quests.state', 'interactions.current', 'interactions.get',
  'triggers.list', 'grids.list', 'water.bodies', 'net.actor', 'net.pending', 'net.stats', 'ambience.position', 'particles.has', 'music.current', 'music.ready', 'music.pick',
  'timeline.playing', 'hud.markers', 'content.ready', 'content.markers', 'nav.agent', 'settings.values', 'settings.isOpen', 'views.current', 'views.has', 'batching.root');
keep('the other half of a pair (do / undo, set / get)', 'terrain.rebuild', 'vegetation.rebuild', 'player.addJumps', 'player.resetJumps', 'player.dispose', 'assets.release', 'views.release',
  'plugins.on', 'settings.close', 'settings.save', 'settings.rebind', 'triggers.clear', 'particles.clear', 'batching.refresh', 'ambience.rules', 'content.run');
keep('runtime tuning knob', 'interactions.radius', 'pickups.radius', 'pickups.size', 'photo.scale', 'stream.radius', 'events.historySize', 'ops.historySize', 'budget.enabled', 'rigid.gravity',
  'uniforms.uSkyCloudSpeed');
keep('taught in a recipe (prose), not dead', 'quests.isDone', 'quests.isActive', 'quests.isFailed', 'quests.check', 'level.markersWith', 'triggers.byTag');
keep('contract of a replaceable draw module (engine.use(mine, { replaces }))', 'terrainDraw.material', 'terrainDraw.patches', 'terrainDraw.uniforms', 'terrainDraw.recolor', 'terrainDraw.meshes',
  'vegetationDraw.meshes', 'weatherDraw.particles');
/** Why an unused item is kept anyway, or null when it is a candidate */
function keptWhy(i) {
  if (i.group === 'CLI commands') return 'CLI command (used in the terminal)';
  if (i.group === 'error codes') return 'error code';
  if ((i.group === 'module options' || i.group === 'createEngine options') && !PICTURE_MOVE.has(i.name)) return 'tuning option with a default';
  return KEPT_API.get(i.name) ?? null;
}

/**
 * The daily surface: which public code names do real games write? Each folder in `dirs` is one game (its own .js/.mjs/.html/.json files, not
 * node_modules, dist, public or docs). A name counts for a game when that game's text alone matches (same heuristic as `usage`).
 * collect() alone: CLI commands and options, and error codes are not code a game writes.
 */
function dailySurface(dirs) {
  const items = collect();
  for (const i of items) i.games = 0;
  for (const d of dirs) {
    const texts = files(d, /\.(m?js|html|json)$/).map(f => ({ file: rel(f), where: 'example', text: readFileSync(f, 'utf8') }));
    const probe = items.map(i => ({ ...i }));
    usage(probe, texts);
    probe.forEach((p, k) => { if (p.used) items[k].games++; });
  }
  return items;
}

/** Totals per group in a fixed order */
export const GROUPS = ['createEngine options', 'engine members', 'engine sub-objects', 'module options', 'module APIs',
  'exports threedog', 'exports threedog/tsl', 'exports @threedog/post-effects', 'CLI commands', 'CLI options', 'error codes'];
export async function apiCount() {
  const items = [...collect(), ...await cliItems(), ...await errorItems()];
  const all = usage(items, corpus()), kept = all.filter(keptWhy), unused = all.filter(i => !keptWhy(i));
  const n = (list, g) => list.filter(i => i.group === g).length;
  const groups = Object.fromEntries(GROUPS.map(g => [g, { total: n(items, g), unused: n(unused, g), kept: n(kept, g) }]));
  const row = ({ group, name, decl, what }) => ({ group, name, decl, what });
  return { total: items.length, experimental: items.filter(i => i.experimental).map(i => `${i.group} | ${i.name}`), unusedTotal: unused.length, keptTotal: kept.length, groups, unused: unused.map(row), kept: kept.map(i => ({ ...row(i), why: keptWhy(i) })) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (MODE !== 'monorepo') { console.error('api-count reads the engine sources: run it in the threedog repository'); process.exit(1); }
  const { opt } = cli(process.argv.slice(2), { workspace: false, flags: ['json', 'unused', 'lock'], values: ['games'] });
  if (opt.lock) {   // regenerate the API lock snapshot (see surfaceLines); then add a CHANGELOG line under "## Unreleased" for every removed or changed name
    const lines = await surfaceLines();
    writeFileSync(join(ROOT, 'docs/api-surface.txt'), ['# Public names and signatures, one per line (threedog api-count --lock rewrites it; rule R55 compares it). group | name | signature [@experimental]', ...lines, ''].join('\n'));
    console.log(`docs/api-surface.txt: ${lines.length} lines`);
    process.exit(0);
  }
  if (opt.games) {
    const dirs = opt.games.split(',').filter(Boolean).map(d => resolve(d));
    const items = dailySurface(dirs), used = items.filter(i => i.games > 0), most = items.filter(i => i.games > dirs.length / 2);
    if (opt.json) console.log(JSON.stringify({ games: dirs.length, names: items.length, usedByAny: used.length, usedByMost: most.length, usedByAll: items.filter(i => i.games === dirs.length).length,
      byGroup: Object.fromEntries(GROUPS.map(g => [g, [items.filter(i => i.group === g).length, used.filter(i => i.group === g).length, most.filter(i => i.group === g).length]])), used: used.map(i => [i.group, i.name, i.games]) }));
    else {
      console.log(`${dirs.length} games; ${items.length} code names (CLI and error codes left out)`);
      console.log(`used by at least one game: ${used.length}   by more than half: ${most.length}   by all ${dirs.length}: ${items.filter(i => i.games === dirs.length).length}`);
      for (const g of GROUPS) { const t = items.filter(i => i.group === g); if (t.length) console.log(`${g.padEnd(32)} ${String(t.length).padStart(4)}  any ${String(used.filter(i => i.group === g).length).padStart(3)}  most ${String(most.filter(i => i.group === g).length).padStart(3)}`); }
      console.log('(small sample: a name no game here uses is not necessarily dead; --json lists the used names)');
    }
    process.exit(0);
  }
  const r = await apiCount();
  if (opt.json) console.log(JSON.stringify(opt.unused ? r : { ...r, unused: undefined, kept: undefined }));
  else {
    const w = Math.max(...GROUPS.map(g => g.length)), kept = k => k ? `   kept ${k}` : '';
    for (const g of GROUPS) console.log(`${g.padEnd(w)}  ${String(r.groups[g].total).padStart(4)}   unused ${r.groups[g].unused}${kept(r.groups[g].kept)}`);
    console.log(`${'total'.padEnd(w)}  ${String(r.total).padStart(4)}   unused ${r.unusedTotal}${kept(r.keptTotal)}   experimental ${r.experimental.length}`);
    if (opt.unused) for (const g of GROUPS) { const u = r.unused.filter(i => i.group === g); if (u.length) console.log(`\n${g}: ${u.map(i => i.name).join(', ')}`); }
    else console.log('(unused = candidates; kept = unused but kept on purpose: tuning options, CLI commands, error codes; --unused lists the candidates; --json for data)');
  }
}
