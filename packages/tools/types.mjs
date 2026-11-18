// Type check: npm run types
// Runs tsc over game code (include in the root tsconfig.json) and reports engine API misuse (misspelled properties and options, missing or
//   wrongly typed arguments, methods that do not exist) as short file:line summaries with a fix hint.
// Engine types: index.d.ts + types/*.d.ts (hand-written) + types/generated/ (gentypes.mjs), via import 'threedog'.
// Also checks that index.d.ts declares every export of index.js (a missing one means the declarations are stale).
// Web (DOM) errors (el.style.opacity = 0.5, window.game missing) are only hints (they run fine); --strict-dom makes them errors. So is plain JS
//   TypeScript cannot follow in game code (fields added to the game's own object, a union from the game's ternary, TSL node inference): isPlainJs.
// -w game (or inside a game folder): only its errors count, the rest is a count (lib/scope.mjs)
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import ts from 'typescript';
import { hintFor } from 'threedog/error-hints';

import { item, result, startJson } from './lib/result.mjs';
import * as P from './paths.mjs';
import { checkScope } from './lib/scope.mjs';

const { ROOT } = P;
// --tally-json: run by check -w (hands the other workspaces' counts back as one line, lib/scope.mjs)
const { dir: SCOPE_DIR, opt: OPT } = P.cli(process.argv.slice(2), { workspace: 'scope', flags: ['strict-dom', 'tally-json', 'json'], values: ['project'] });
// --json: one result (lib/result.mjs) on stdout, built from these at exit so every early exit below still reports
const jsonItems = [];
if (OPT.json) startJson(code => result(jsonItems, jsonItems.length ? `type check: ${jsonItems.filter(i => i.level === 'error').length} errors, ${jsonItems.filter(i => i.level === 'warn').length} hints` : 'type check passed', code === 0));
const STRICT_DOM = !!OPT['strict-dom'];
const SCOPE = checkScope(SCOPE_DIR), ENG = SCOPE?.notEngine;
// --project <tsconfig>: another config instead of the root one (the types guard test uses a probe file)
// A game in its own repo without a tsconfig.json gets a default one in .threedog/ (all game .js and .d.ts, engine types through 'threedog')
const PROJECT = OPT.project ?? (existsSync(join(ROOT, 'tsconfig.json')) ? scopedConfig() ?? join(ROOT, 'tsconfig.json') : defaultConfig());
// check -w <game> in the monorepo: tsc over this game and the engine's declarations, not every game and example, whose errors it only counted. skipLibCheck: three's and
// the engine's .d.ts are the root check's to read, and they were most of the time. A game not under games/ keeps the root config, whose include has no pattern for it
function scopedConfig() {
  if (P.MODE !== 'monorepo' || !ENG || !SCOPE.rel.startsWith('games/')) return null;
  const root = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile).config, up = p => '../' + p;
  const include = root.include.flatMap(p => p.startsWith('games/*/') ? [up(p.replace('games/*', SCOPE.rel))] : p.startsWith(P.ENGINE_REL + '/examples') ? [] : [up(p)]);
  const f = join(ROOT, '.threedog', `tsconfig.${SCOPE.rel.replaceAll('/', '-')}.json`);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ extends: '../tsconfig.json', compilerOptions: { skipLibCheck: true }, include, exclude: root.exclude.map(up) }, null, 2));
  return f;
}
function defaultConfig() {
  const f = join(ROOT, '.threedog', 'tsconfig.types.json');
  mkdirSync(dirname(f), { recursive: true });
  // the game's own sources only (package.json "threedog": { src, exclude }, paths.mjs gameSources)
  // lib ESNext: dependency typings use newer globals (Rapier's Symbol.dispose); skipLibCheck: dependency .d.ts files are not the game's to fix
  const s = P.gameSources(), up = p => '../' + (P.rel(p) || '.');
  const include = s ? s.src.flatMap(p => existsSync(p) && statSync(p).isFile() ? [up(p)] : [up(p) + '/**/*.js', up(p) + '/**/*.d.ts']) : ['../**/*.js', '../**/*.d.ts'];
  writeFileSync(f, JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ESNext', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler',
    allowJs: true, checkJs: true, noEmit: true, strict: false, noImplicitAny: true, skipLibCheck: true, resolveJsonModule: true, types: [] },
    include, exclude: ['../**/node_modules', '../**/dist', '../.threedog', '../**/vite.config.js', '../**/tests', ...(s ? s.exclude.map(up) : [])] }, null, 2));
  return f;
}

// 1. Run tsc
let tscBin;
try { tscBin = createRequire(import.meta.url).resolve('typescript/bin/tsc'); } catch { jsonItems.push(item({ code: 'tsc', message: 'TypeScript not found', fix: 'run npm install first' })); console.error('✗ TypeScript not found, run npm install first'); process.exit(1); }
const run = spawnSync(process.execPath, [tscBin, '-p', PROJECT, '--pretty', 'false', '--listFiles'], { cwd: ROOT, encoding: 'utf8' });
if (run.error) { jsonItems.push(item({ code: 'tsc', message: 'failed to run tsc: ' + run.error.message })); console.error('✗ failed to run tsc:', run.error.message); process.exit(1); }
const out = (run.stdout || '') + (run.stderr || '');
// a tsc that died (out of memory, killed) printed no error line: with nothing to read below that would be a clean pass
if (run.status !== 0 && !/error TS\d+/.test(out)) { const why = `tsc stopped without a result (exit ${run.status ?? run.signal}): ${out.trim().slice(-300)}`; jsonItems.push(item({ code: 'tsc', message: why })); console.error('✗ ' + why); process.exit(1); }

// Generated declarations (types/generated/) must match the source, or games see the wrong types (monorepo only)
if (P.MODE === 'monorepo' && !ENG) {
  const g = spawnSync(process.execPath, [join(P.TOOLS, 'gentypes.mjs'), '--check'], { encoding: 'utf8' });
  if (g.status) { jsonItems.push(item({ code: 'generated-declarations', message: (g.stdout + g.stderr).trim().slice(0, 500) })); (OPT.json ? process.stderr : process.stdout).write(g.stdout + g.stderr); process.exit(1); }
}

// Game files checked (the project .js files listed by --listFiles)
const checked = out.split('\n').map(s => s.trim()).filter(s => s && !s.includes('(') && s.endsWith('.js') && !s.includes('node_modules')).map(P.rel).filter(f => !P.notGameSource(P.abs(f), P.ROOT, false));   // dependencies (vendor/, file: folders) are not game files

// Error: file(line,col): error TSxxxx: message; the indented lines after it are extra explanation
const diags = [];
for (const line of out.split(/\r?\n/)) {   // tsc writes \r\n on Windows; a leftover \r would make the error regex below miss every line
  const m = line.match(/^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/);
  if (m) diags.push({ file: m[1], line: +m[2], col: +m[3], code: +m[4], msg: m[5], more: [] });
  else if (/^\s+\S/.test(line) && diags.length) diags[diags.length - 1].more.push(line.trim());
  else if (/^error TS\d+/.test(line)) diags.push({ file: 'tsconfig.json', line: 0, col: 0, code: 0, msg: line, more: [] });
}

// noImplicitAny stays on only to catch numeric indexing of non-arrays (`vector[0]` reads undefined, later NaN); other TS7xxx reports are dropped
const numIndex = d => d.code === 7053 && /expression of type '-?\d/.test(d.msg);
for (let i = diags.length; i--;) if (diags[i].code >= 7000 && diags[i].code < 8000 && !numIndex(diags[i])) diags.splice(i, 1);

// Translation
const srcCache = new Map();
const srcLine = (file, n) => {
  if (!srcCache.has(file)) { try { srcCache.set(file, readFileSync(join(ROOT, file), 'utf8').split('\n')); } catch { srcCache.set(file, []); } }
  return srcCache.get(file)[n - 1] || '';
};

// type name → which declaration file holds it (so an error can point to where the valid options are)
const typeHome = new Map();
for (const f of [P.abs(P.INDEX_DTS_REL), ...readdirSync(P.abs(P.TYPES_REL)).map(f => join(P.abs(P.TYPES_REL), f))]) {
  if (!f.endsWith('.d.ts') || !existsSync(f)) continue;
  for (const m of readFileSync(f, 'utf8').matchAll(/export (?:declare )?(?:interface|type|class) (\w+)/g)) typeHome.set(m[1], P.rel(f));
}
// every engine type name, the generated declarations too (PostEffect): an error that names one is about the engine API (isPlainJs)
const engineTypes = new Set(typeHome.keys());
for (const f of readdirSync(P.abs(P.TYPES_REL), { recursive: true })) if (String(f).endsWith('.d.ts'))
  for (const m of readFileSync(join(P.abs(P.TYPES_REL), String(f)), 'utf8').matchAll(/export (?:declare )?(?:interface|type|class) (\w+)/g)) engineTypes.add(m[1]);
const where = t => { const name = t.match(/^(\w+)/)?.[1]; return name && typeHome.has(name) ? ` (valid forms: see ${name} in ${typeHome.get(name)})` : ''; };

/** Turn TypeScript's type notation into plain English */
function typeText(t) {
  t = t.trim();
  const lits = t.split(' | ').map(s => s.trim());
  if (lits.length > 1 && lits.every(s => /^"[^"]*"$/.test(s))) return 'one of ' + lits.map(s => s.slice(1, -1)).join(' / ');
  const map = { string: 'string', number: 'number', boolean: 'true/false', undefined: 'undefined (no value)', null: 'null',
    any: 'any value', void: 'no return value', 'number[]': 'array of numbers', 'string[]': 'array of strings' };
  if (map[t]) return map[t];
  if (/^"[^"]*"$/.test(t)) return `string ${t}`;
  if (/^\d+(\.\d+)?$/.test(t)) return `number ${t}`;
  // a long object / function type is cut, not replaced: "expected an object/function, got an object/function" told nothing
  if (t.startsWith('{') || t.startsWith('(')) return t.length > 60 ? t.slice(0, 57).replace(/;?\s*\S*$/, '') + ' … }' : t;
  return t.length > 70 ? t.slice(0, 67) + '…' : t;
}

/** The "who." in front of the error position: the engine in engine.inventroy */
function receiver(d) {
  const before = srcLine(d.file, d.line).slice(0, d.col - 1);
  const m = before.match(/([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\[[^\]]*\]|\(\))*)\??\.$/);
  return m ? m[1] : null;
}

function translate(d) {
  const msg = d.msg;
  let m;
  // property does not exist
  if ((m = msg.match(/^Property '(.+?)' does not exist on type '(.+?)'\.(?: Did you mean '(.+?)'\?)?$/))) {
    const who = receiver(d);
    // `function f(opts = {})` with no JSDoc: TypeScript takes the default as the type, so every opts.x "does not exist" although the code runs
    if (m[2] === '{}') return `${who ?? 'this value'}.${m[1]}: ${who ? `\`${who}\`` : 'it'} has no JSDoc type, so its type was inferred from a default \`{}\` (an object with no properties). ` +
      `Fix: /** @param {{ ${m[1]}?: number }} [${who ?? 'opts'}] */ above the function (any type you like, or {any}), or destructure with defaults: ({ ${m[1]} = … } = {})`;
    if (/Window|globalThis/.test(m[2])) return `window has no ${m[1]} (to attach a debug object write /** @type {any} */ (window).${m[1]} = …)`;
    const full = who ? `${who}.${m[1]}` : `${typeText(m[2])}.${m[1]}`;
    const hint = hintFor(`${m[2]}.${m[1]} is not a function`.toLowerCase());   // a guessed pause: the wording and the names live in the error hint
    if (hint?.id === 'pause-guess') return `property does not exist: ${full}. ${hint.cause}`;
    return `property does not exist: ${full}` + (m[3] ? `; did you mean \`${m[3]}\`?` : ` (${typeText(m[2])} has no ${m[1]})${where(m[2])}`);
  }
  // the engine has no such export
  if ((m = msg.match(/^(?:Module )?'?"?(.+?)"?'? has no exported member (?:named )?'(.+?)'\.(?: Did you mean '(.+?)'\?)?$/)))
    return `the engine has no export ${m[2]}` + (m[3] ? `; did you mean \`${m[3]}\`?` : ' (module name misspelled? available modules are in ' + P.INDEX_DTS_REL + ')');
  // misspelled option name (an unknown item in an object)
  if ((m = msg.match(/^Object literal may only specify known properties, (?:but|and) '(.+?)' does not exist in type '(.+?)'\.(?: Did you mean to write '(.+?)'\?)?$/))) {
    const short = m[2].replace(/<.*?>/g, '').split(' | ')[0];
    const t = m[2].startsWith('{') || short.length > 60 ? 'this object' : short;
    return `misspelled option name: ${m[1]} is not a known option of ${t}` + (m[3] ? `; did you mean \`${m[3]}\`?` : where(m[2]));
  }
  // missing required item
  if ((m = msg.match(/^Property '(.+?)' is missing in type '(.+?)' but required in type '(.+?)'\.$/)))
    return `missing required property: ${m[1]} (${typeText(m[3])} must have it)${where(m[3])}`;
  if ((m = msg.match(/^Type '(.+?)' is missing the following properties from type '(.+?)': (.+)$/)))
    return `missing required properties: ${m[3]} (${typeText(m[2])} needs them)${where(m[2])}`;
  // argument count
  if ((m = msg.match(/^Expected (\d+)(?:-(\d+))? arguments?, but got (\d+)\.$/)))
    return `wrong number of arguments: expected ${m[2] ? `${m[1]}–${m[2]}` : m[1]}, got ${m[3]}`;
  if ((m = msg.match(/^Expected at least (\d+) arguments?, but got (\d+)\.$/)))
    return `wrong number of arguments: expected at least ${m[1]}, got ${m[2]}`;
  // a call to the game's own function that destructures its parameter with no JSDoc: the inferred type makes every destructured name required
  // ({ w: any; rough: any }), so leaving one out is reported as a type error although the code runs (the name is just undefined)
  if ((m = msg.match(/^Argument of type '(.+?)' is not assignable to parameter of type '(\{ (?:[\w$]+(?:: any|\?: [^;{}]+); )+\})'\.$/))) {
    const missing = d.more.map(l => l.match(/^Property '(.+?)' is missing in type/)?.[1] ?? l.match(/^Type '.+?' is missing the following properties from type '.+?': (.+)$/)?.[1]).find(Boolean);
    const names = [...m[2].matchAll(/([\w$]+)\??: /g)].map(x => x[1]);
    return `the argument lacks ${missing ? '`' + missing + '`' : 'some names'}: the called function destructures { ${names.join(', ')} } with no JSDoc type, so TypeScript requires every name. ` +
      `Fix: give the name a default in the pattern ({ ${(missing ?? names[0]).split(',')[0].trim()} = … }), or document the parameter: /** @param {{ ${names.map(n => n + '?: any').join(', ')} }} opts */ (real types where you know them)`;
  }
  // wrong type
  if ((m = msg.match(/^Argument of type '(.+?)' is not assignable to parameter of type '(.+)'\.$/)))
    return `wrong argument type: expected ${typeText(m[2])} here, got ${typeText(m[1])}` + detail(d);
  if ((m = msg.match(/^Type '(.+?)' is not assignable to type '(.+)'\.$/)))
    return `wrong type: expected ${typeText(m[2])} here, got ${typeText(m[1])}` + detail(d);
  if (d.code === 7053) return `numeric index on a non-array (${msg.match(/index type '(.+?)'/)?.[1]}): use .x / .y / .z or .toArray()[i]`;
  // name not defined
  if ((m = msg.match(/^Cannot find name '(.+?)'\.(?: Did you mean '(.+?)'\?)?/)))
    return `name not defined: ${m[1]}` + (m[2] ? `; did you mean \`${m[2]}\`?` : ' (forgot to import it, or misspelled?)');
  if ((m = msg.match(/^Cannot find module '(.+?)'/)))
    return `file not found: ${m[1]} (wrong path?)`;
  if (/^This expression is not callable/.test(msg)) {
    // name the expression (TypeScript only says "this expression") and its type: `engine.random()` where engine.random is an object (keeper run 2026-11-03)
    // TypeScript points at the last name of a member call (random in engine.random()): the receiver in front of it completes the expression
    const own = srcLine(d.file, d.line).slice(d.col - 1).match(/^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*/)?.[0], who = receiver(d);
    const what = own && (who ? `${who}.${own}` : own);
    const type = d.more.map(l => l.match(/^Type '(.+?)' has no call signatures/)?.[1]).find(Boolean);
    return `${what ? `\`${what}\`` : 'this'} is not a function, it cannot be called with parentheses` +
      (type ? ` (it is ${typeText(type)}; call one of its methods, ${what ? `\`${what}.<method>()\`` : '`.<method>()`'})${where(type)}` : detail(d));
  }
  if ((m = msg.match(/^'(.+?)' is possibly '(null|undefined)'/))) return `${m[1]} may be empty (${m[2]})`;
  if (/^No overload matches this call/.test(msg)) return 'the arguments match none of the forms of this function' + detail(d);
  if ((m = msg.match(/^Cannot assign to '(.+?)' because it is a read-only property\.$/))) return `${m[1]} is read-only and cannot be changed directly`;
  return `${msg} (original TypeScript message TS${d.code})`;
}
/** The most specific line of the extra explanation (such as "Types of property 'speed' are incompatible") */
function detail(d) {
  for (const line of d.more) {
    let m;
    if ((m = line.match(/^Types of property '(.+?)' are incompatible\.?$/)) || (m = line.match(/^The types of '(.+?)' are incompatible/))) return ` (the problem is in ${m[1]})`;
    if ((m = line.match(/^Object literal may only specify known properties, (?:but|and) '(.+?)' does not exist/))) return ` (unknown option ${m[1]})`;
    if ((m = line.match(/^Property '(.+?)' is missing in type '.+?' but required in type/))) return ` (missing ${m[1]})`;
  }
  return '';
}

/** Web element (DOM) errors unrelated to the engine */
function isDom(d) {
  const all = d.msg + ' ' + d.more.join(' ');
  if (/HTML\w*Element|CSSStyleDeclaration|EventTarget|'ChildNode'|'Node'|'Element'|Window|globalThis|'Document'|'Navigator'|'Location'/.test(all)) return true;
  if (d.code === 2322 && /\.(style\.\w+|textContent|innerText|innerHTML|value|src|href|title|alt|className|id|hidden)\s*=[^=]/.test(srcLine(d.file,
    d.line))) return true;
  return false;
}

function fnCallOnLine(d) {
  srcLine(d.file, 1);   // fills srcCache for the file
  const names = [...(srcCache.get(d.file) ?? []).join('\n').matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*Fn\(/g)].map(m => m[1].replace(/\$/g, '\\$'));
  return names.some(n => new RegExp('(?<![\\w$.])' + n + '\\(').test(srcLine(d.file, d.line)));
}
/** TSL node types (three/tsl): Node<"float">, ConstNode<"vec3", Vector3>, UniformArrayElementNode<any>, Number<"float">, NodeBuilder (what a Fn callback's destructuring sees) */
const tslType = text => /\b(?:\w*Node<|Number<"|NodeBuilder\b)/.test(text);
/**
 * A swizzle or method on a TSL node (p.xy, data.x, element.mul) in a game's own code. Three's declarations list only part of what a node takes,
 * so valid shader code lands here. It stays a hint with its own wording: a misspelled name fails when the shader builds, so "does not affect
 * running" would be untrue here.
 */
const isTslMember = d => d.code === 2339 && tslType(d.msg + ' ' + d.more.join(' ')) && isPlainJs(d);
/**
 * A member read on a value TypeScript typed as never in a game's own code: inference lost the value (three's TSL declarations do this to
 * vec2(…).add(uniform(…))), so every member of it is reported, right or wrong. A hint without "does not affect running": a misspelled member is
 * reported the same way and cannot be told apart.
 */
const isLostType = d => d.code === 2339 && !d.file.startsWith('packages/') && / on type 'never'\./.test(d.msg);
/**
 * Plain JS that TypeScript cannot follow, in a game's own code: a field added to the game's own object after it was made (fx.density = …),
 * a property read on a union the game's own ternary built (gpu ? nodeMaterial : shaderMaterial), a default `{}` parameter, a call that leaves
 * out a name the game's own untyped function destructures, a TSL node whose
 * type TypeScript narrowed by inference (let s = float(0); s = s.add(…)), a call of a function made with Fn(...), two geometry classes in one variable, an array literal where a fixed-length pair is declared, a name declared and never read (noUnusedLocals). It runs fine, so it is a hint, not an error. Why not stricter: an AI
 * that gets errors for ordinary JS turns the check off for the whole file (// @ts-nocheck) and loses the engine checks with it. Anything that
 * names an engine type stays an error, and so does the engine's own code (packages/, examples included).
 */
function isPlainJs(d) {
  if (d.file.startsWith('packages/')) return false;
  if ([6133, 6192, 6196, 6198, 6199].includes(d.code)) return true;
  const all = d.msg + ' ' + d.more.join(' ');
  for (const w of all.matchAll(/\b[A-Z]\w+/g)) if (engineTypes.has(w[0])) return false;
  const tsl = tslType(all);
  // two sibling three.js classes where inference fixed the first one's type (let g = new IcosahedronGeometry(); g = new BoxGeometry()): only `parameters` differs
  const siblingGeometry = (d.code === 2322 || d.code === 2345) && /\b\w+Geometry\b/.test(d.msg) && d.more.some(l => /^Types of property 'parameters' are incompatible/.test(l));
  // a function made with Fn(...) is typed as taking no arguments although it takes the ones its callback destructures
  if (d.code === 2554) return fnCallOnLine(d);
  if (d.code === 2339) { const t = d.msg.match(/^Property '.+?' does not exist on type '(.+?)'\./)?.[1] ?? ''; return t.startsWith('{') || t.includes(' | ') || tsl; }
  // an array literal where a fixed-length pair is declared ({ repeat = [1, 1] } passed on): TypeScript widens it to number[], the array runs the same
  const widenedTuple = (d.code === 2322 || d.code === 2345) && /'(?:number|string|boolean)\[\]' is not assignable to (?:parameter of )?type '\[/.test(d.msg);
  // the game's own function that destructures its parameter with no JSDoc: TypeScript makes every name required ({ w: any; rough: any })
  const ownParam = d.code === 2345 && /parameter of type '\{ (?:[\w$]+(?:: any|\?: [^;{}]+); )*[\w$]+: any; /.test(d.msg);
  // 2488 (not iterable) only for a Fn callback's destructuring: on any other TSL node it is a real mistake, a node is not an array
  return ownParam || siblingGeometry || widenedTuple || ((d.code === 2322 || d.code === 2345 || d.code === 2769) && tsl) || (d.code === 2488 && /\bNodeBuilder\b/.test(all));
}

const RUNS_ANYWAY = ', not a misuse of the engine API, does not affect running';
const LOST_TYPE = "TypeScript lost this value's type (never) and cannot check its members, not a misuse of the engine API";
const TSL_MEMBER = "TSL name three's declarations leave out, not a misuse of the engine API: valid swizzles and methods run, a misspelled one fails when the shader builds";
const errors = [], hints = [];
for (const d of diags) {
  if (d.line && P.notGameSource(resolve(P.ROOT, d.file), P.ROOT, false)) continue;   // an error inside a dependency is not the game's
  const at = d.line ? `${d.file}:${d.line}` : d.file;
  const text = d.code ? translate(d) : d.msg;
  const hint = !d.code ? null : !STRICT_DOM && isDom(d) ? 'web (DOM) type hint' + RUNS_ANYWAY : isTslMember(d) ? TSL_MEMBER : isLostType(d) ? LOST_TYPE : isPlainJs(d) ? 'plain JS TypeScript cannot follow' + RUNS_ANYWAY : null;
  if (SCOPE?.mine(d.file) === false) SCOPE.other(d.line && d.file, hint ? 'warn' : 'error');
  else if (hint) { hints.push(`${at}  ${text}  ← ${hint}`); jsonItems.push(item({ code: d.code ? 'TS' + d.code : undefined, level: 'warn', file: d.file, line: d.line, message: `${text}  ← ${hint}` })); }
  else { errors.push(`${at}  ${text}`); jsonItems.push(item({ code: d.code ? 'TS' + d.code : undefined, file: d.file, line: d.line, message: text })); }
}

// ---------------------------------------------------------------------
// 2. Do the declarations cover all exports of packages/engine/index.js
// ---------------------------------------------------------------------
function jsExports(file) {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = new Set(), star = [];
  const exported = n => n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const s of sf.statements) {
    if (ts.isExportDeclaration(s)) {
      if (!s.exportClause) star.push(s.moduleSpecifier?.text);
      else if (ts.isNamedExports(s.exportClause)) for (const el of s.exportClause.elements) names.add(el.name.text);
    } else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && exported(s) && s.name) names.add(s.name.text);
    else if (ts.isExportAssignment(s)) names.add('default');
    else if (ts.isVariableStatement(s) && exported(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text);
  }
  return { names, star };
}
function dtsValueExports(file) {
  const program = ts.createProgram([file], { noEmit: true, skipLibCheck: true, moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, types: [] });
  const checker = program.getTypeChecker(), sf = program.getSourceFile(file);
  const mod = sf && checker.getSymbolAtLocation(sf);
  const names = new Set();
  if (mod) for (const sym of checker.getExportsOfModule(mod)) {
    // export type { X } from …: type-only export (such as class PostFX, not public in JS, games only need its type), not counted as a runtime export
    if (sym.declarations?.some(d => ts.isExportSpecifier(d) && (d.isTypeOnly || d.parent.parent.isTypeOnly))) continue;
    const real = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    if (real.flags & ts.SymbolFlags.Value) names.add(sym.name);
  }
  return names;
}
const coverage = [];
const jsFile = P.abs(P.INDEX_JS_REL), dtsFile = P.abs(P.INDEX_DTS_REL), J = P.INDEX_JS_REL, D = P.INDEX_DTS_REL;
if (P.MODE !== 'monorepo') { /* the installed engine's own declarations are checked before it is published */ }
else if (!existsSync(dtsFile)) coverage.push(`${D} does not exist`);
else {
  const js = jsExports(jsFile), dts = dtsValueExports(dtsFile);
  for (const s of js.star) coverage.push(`${J} has export * from '${s}', which the script cannot check one by one; declare them by hand in index.d.ts`);
  for (const n of js.names) if (!dts.has(n)) coverage.push(`${J} exports ${n}, but ${D} does not declare it (game code using it would be misreported, please add it)`);
  for (const n of dts) if (!js.names.has(n)) coverage.push(`${D} declares ${n}, but ${J} does not export it (this fails at runtime, delete or rename it)`);
}

// ---------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------
// Grouped by source: examples, each game games/<name> (a game's picture/ folder counts as that game)
const group = f => P.under(f, P.EXAMPLES_REL) ? 'examples' : P.MODE === 'game' ? (f.startsWith('games/') ? f.split('/').slice(0, 2).join('/') : 'game') : f.split('/').slice(0, 2).join('/');
if (ENG) { SCOPE.engine(coverage.length); coverage.length = 0; }   // the engine's own to fix: a count, no failure of this game
for (const c of coverage) jsonItems.push(item({ code: 'declarations', message: c}));
const shown = SCOPE ? checked.filter(SCOPE.mine) : checked;
console.log(`Type check: ${shown.length} game files (${[...new Set(shown.map(group))].join(', ') || 'none'})`);
for (const e of errors) console.log('  ✗ ' + e);
for (const c of coverage) console.log('  ✗ ' + c);
for (const h of hints) console.log('  ! ' + h);
SCOPE?.report();
const n = errors.length + coverage.length;
if (n) {
  console.log(`\n${n} error${n === 1 ? '' : 's'}. ✗ means the declarations reject this line: usually a real mistake (a wrong name, argument or option), sometimes declarations that lag the code; fix the code, then run npm run types again.`);
  process.exit(1);
}
console.log(`\n✓ No misuse of the engine API found${hints.length ? ` (plus ${hints.length} hints, listed above)` : ''}.`);
