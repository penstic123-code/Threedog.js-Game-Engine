// R6 options-table consistency. A is an error: the schema / known-key table is the one source, the d.ts must name exactly its keys
// (two hand copies drifting was the bug: a key in one only). B is a warning. D (error): no module option takes keys (keys / pad / xKeys /
// xPad in a modules/ readParams or checkOptions table): modules only declare actions, the game binds them (presets.bindings).
// E (error): a default written twice. A readParams schema field with a default, destructured again with its own "= value" from the same
// options (the raw argument or the readParams result) in that function, is a second copy that can drift: read the value readParams filled in.
// A. Fields of the d.ts options interface vs the runtime key table: checkOptions(label, object, known keys), or the params schema of
//    readParams(name, SCHEMA, object) (label = 'name()'; SCHEMA is keysSchema([...keys]) or an object literal of fields):
//    in d.ts but not in checkOptions → a game written to the d.ts gets an "unknown option" hint at runtime;
//    in checkOptions but not in d.ts → npm run types reports the correct spelling as a "misspelled option", and the docs cannot find it.
//    How the matching d.ts type is found: derived from the conventional form of checkOptions' first argument (the label) —
//      'hud()'                → parameter 1 of hud(opts) in packages/engine/index.d.ts
// 'npcs.add()' → the add method of the Engine npcs property type; parameter position = position of the checked variable in the JS function's parameters (if not
// found, the first object-typed parameter)
//      "flow.define('x')"     → the quoted part is ignored
//      'hud.marker().set()'   → the set method of marker's return type
//      'npcs.add() schedule'  → the schedule field of the parameter type (arrays use the element type); '.rule' likewise
//    Labels not in this form (e.g. 'timeline step') or types that cannot be resolved are skipped (the output shows the skip count).
// B. Names destructured from function parameters (function f({ a, b = 1 })) never read in the function body → warning (dead parameter);
// only stored as this.x = x while nothing in the project (engine demo styles) reads .x → also a warning (catches things like NPC wander that are "declared but
// unused").
// C. Retired option names (one word per meaning): an options interface field named padKeys / brakePadKeys (→ pad / brakePad), viewDistance
//    (chunks → viewChunks) or range (a distance → radius) → error.
//    Rest pattern: constructor(engine, { a, b = 1, ...rest }) { checkOptions('x()', rest, []) } checks only what is left after the destructure,
//    so the destructured names (a, b) count as known keys too.
// F (error). The other direction of A, from what the engine says it has: every option in metadata.mjs's params and every name on a contract's api (but those its source marks @internal) must be in the
//    hand-written d.ts. Why a check and not generated types: the d.ts carries the doc comments. Why beside A: A starts from a checkOptions / readParams call it can
//    resolve, so a label it skips is unchecked, and it knows nothing about contracts. Factories outside index.d.ts (rigModule behind its cameras, starter pictures,
//    subpath exports) are matched through what game code can call, or left out when nothing public names them.
// Limitation: A only understands known-key arrays resolvable in the same file (literals, ...constants, ...Object.keys(constant)); B ignores variable shadowing
// and cannot see reads in a game repo.
import { metadata } from 'threedog/metadata';
import { ts, parse, visit, engineFiles, projectFiles, lineOf, read, stringArray, objectKeys, constInit, dtsProgram, dtsFiles, abs, P } from './_lib.mjs';

// Allowlist: [label, key, reason] (part A); [file, name, reason] (part B)
const ALLOW_KEYS = [];
const ALLOW_PARAMS = [];

// ---------- d.ts type resolution ----------
export function typeTools() {
  const program = dtsProgram(), checker = program.getTypeChecker();
  const exportsOf = f => { const sf = program.getSourceFile(abs(f)); const m = sf && checker.getSymbolAtLocation(sf); return m ? checker.getExportsOfModule(m) : []; };
  const indexFns = new Map(exportsOf(P.INDEX_DTS_REL).map(s => [s.name, s]));
  const engineSym = exportsOf(P.CORE_DTS_REL).find(s => s.name === 'Engine');
  const engineType = engineSym && checker.getDeclaredTypeOfSymbol(engineSym);
  const nn = t => checker.getNonNullableType(t);
  const prop = (t, name) => { t = nn(t); const p = checker.getPropertyOfType(t, name); return p ? checker.getTypeOfSymbol(p) : null; };
  const elem = t => { t = nn(t); return checker.isArrayType(t) ? checker.getTypeArguments(t)[0] : t; };
  const sigs = t => (t ? checker.getSignaturesOfType(nn(t), ts.SignatureKind.Call) : []);
  /** Field names of a type; null for Record/index signatures and non-objects */
  function fields(t) {
    t = nn(t);
    const parts = t.isUnion() ? t.types : [t];
    const names = new Set(); let any = false;
    for (const p of parts) {
      if (p.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue;
      if (checker.getSignaturesOfType(p, ts.SignatureKind.Call).length && !checker.getPropertiesOfType(p).length) continue;
      if (checker.getIndexInfosOfType(p).length) return null;
      for (const s of checker.getPropertiesOfType(p)) { names.add(s.name); any = true; }
    }
    return any ? names : null;
  }
  const isObj = t => !!fields(t);
  /** An object parameter, including an open one ({ [k: string]: any }, whose fields() is null): the fallback must stop at it, not skip to a later parameter */
  const isObjLike = t => isObj(t) || !!checker.getIndexInfosOfType(nn(t)).length;
  return { indexFns, engineType, prop, elem, sigs, fields, isObj, isObjLike, checker };
}

/** label → { base, steps: [{call}|{prop}], tail: [fields…] } */
function parseLabel(label) {
  const s = label.replace(/\(\s*(['"`]).*?\1\s*\)/g, '()').replace(/\$\{[^}]*\}/g, 'X');
  const m = s.match(/^([A-Za-z_]\w*)((?:\.\w+|\(\))*)((?:[ .]\w+)*)\s*$/);
  if (!m || !m[2].includes('()')) return null;
  const steps = [...m[2].matchAll(/\.(\w+)|\(\)/g)].map(x => (x[1] ? { prop: x[1] } : { call: true }));
  return { base: m[1], steps, tail: m[3].trim() ? m[3].trim().split(/[ .]+/) : [] };
}

function resolveParamType(T, label, paramIndex) {
  const p = parseLabel(label);
  if (!p) return null;
  let t, steps = p.steps;
  if (steps[0]?.call && T.indexFns.has(p.base)) {
    const sym = T.indexFns.get(p.base);
    t = T.checker.getTypeOfSymbol(sym.flags & ts.SymbolFlags.Alias ? T.checker.getAliasedSymbol(sym) : sym);
  } else {
    if (!T.engineType) return null;
    t = T.prop(T.engineType, p.base);
  }
  for (let i = 0; i < steps.length && t; i++) {
    const s = steps[i], last = i === steps.length - 1;
    if (s.prop) { t = T.prop(t, s.prop); continue; }
    const sig = T.sigs(t)[0];
    if (!sig) return null;
    if (!last) { t = sig.getReturnType(); continue; }
    const params = sig.getParameters().map(x => T.checker.getTypeOfSymbol(x));
    t = paramIndex != null && params[paramIndex] && T.isObj(params[paramIndex]) ? params[paramIndex] : params.find(T.isObjLike);
  }
  for (const f of p.tail) { if (!t) return null; t = T.prop(T.elem(t), f); t = t && T.elem(t); }
  return t || null;
}

function enclosingFn(n) { for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p; return null; }
/** Position of the checked variable in the outer function's parameters (opts = {} counts too) */
function paramIndexOf(call, argAt = 1) {
  const arg = call.arguments[argAt];
  if (!arg || !ts.isIdentifier(arg)) return null;
  for (let fn = enclosingFn(call); fn; fn = enclosingFn(fn)) {
    const i = fn.parameters.findIndex(p => ts.isIdentifier(p.name) && p.name.text === arg.text);
    if (i >= 0) return i;
  }
  return null;
}

/** Keys of a readParams schema: keysSchema([...]) -> its key list; an object literal -> its field names (a spread makes it incomplete) */
function schemaKeys(sf, node, depth = 0) {
  if (!node || depth > 5) return { vals: [], complete: false };
  if (ts.isIdentifier(node)) return schemaKeys(sf, constInit(sf, node.text), depth + 1);
  if (ts.isCallExpression(node) && node.expression.getText() === 'keysSchema') return stringArray(sf, node.arguments[0]);
  const r = objectKeys(sf, node, depth + 1);
  return { vals: r.keys, complete: r.complete };
}

/** Names destructured next to `...name` in the enclosing function's parameters (the keys a rest-checked object has already lost) */
function restSiblings(call, arg) {
  if (!arg || !ts.isIdentifier(arg)) return [];
  for (const p of enclosingFn(call)?.parameters ?? []) {
    if (!ts.isObjectBindingPattern(p.name)) continue;
    const els = p.name.elements;
    if (!els.some(el => el.dotDotDotToken && ts.isIdentifier(el.name) && el.name.text === arg.text)) continue;
    return els.filter(el => !el.dotDotDotToken).map(el => (el.propertyName ?? el.name).getText());
  }
  return [];
}

/** Keys of a schema object literal whose spec has a default ({ type, default }) */
function defaultedKeys(sf, node, depth = 0) {
  if (!node || depth > 5) return [];
  if (ts.isIdentifier(node)) return defaultedKeys(sf, constInit(sf, node.text), depth + 1);
  if (!ts.isObjectLiteralExpression(node)) return [];
  return node.properties.filter(p => ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer)
    && p.initializer.properties.some(q => q.name?.getText() === 'default')).map(p => p.name.getText());
}
function partE(out) {
  for (const f of engineFiles()) {
    const sf = parse(f);
    visit(sf, n => {
      if (!ts.isCallExpression(n) || n.expression.getText() !== 'readParams' || n.arguments.length < 3) return;
      const keys = new Set(defaultedKeys(sf, n.arguments[1])); if (!keys.size) return;
      const fn = enclosingFn(n); if (!fn) return;
      const names = new Set([n.arguments[2].getText()]);
      if (ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) names.add(n.parent.name.text);
      visit(fn, d => {
        const init = ts.isVariableDeclaration(d) ? d.initializer : null;
        const fromSame = init && (init === n || names.has(init.getText()));
        if (!fromSame || !ts.isObjectBindingPattern(d.name)) return;
        for (const el of d.name.elements) {
          const k = (el.propertyName ?? el.name).getText();
          if (el.initializer && keys.has(k)) out.push({ level: 'error', file: f, line: lineOf(el),
            msg: `'${k}' has a default in the readParams schema and again here (= ${el.initializer.getText()})`, fix: 'drop the "= value": readParams already filled the schema default in' });
        }
      });
    });
  }
}

function partA(out, stats) {
  const T = typeTools();
  for (const f of engineFiles()) {
    const sf = parse(f);
    visit(sf, n => {
      const fnName = ts.isCallExpression(n) ? n.expression.getText() : '';
      if ((fnName !== 'checkOptions' && fnName !== 'readParams') || n.arguments.length < 3) return;
      const isParams = fnName === 'readParams';   // readParams('sky', SCHEMA, opts): the label is the factory call 'sky()'
      const raw = n.arguments[0].getText().slice(1, -1);   // a public API entry already names its call (grids.add(name)); a module factory is only its name
      const label = isParams && !raw.includes('(') && !raw.includes('.') ? raw + '()' : raw;
      const known = isParams ? schemaKeys(sf, n.arguments[1]) : stringArray(sf, n.arguments[2]);
      // D
      if (/[\\/]modules[\\/]/.test(f)) for (const k of known.vals) if (KEY_OPTION.test(k)) out.push({ level: 'error', file: f, line: lineOf(n),
        msg: `${label}: option '${k}' takes keys; modules take no keys`, fix: `declare the action (ctx.input.define) and let the game bind it: a presets.bindings map or createEngine({ bindings })` });
      const t = resolveParamType(T, label, paramIndexOf(n, isParams ? 2 : 1));
      const dts = t && T.fields(t);
      if (!dts) { stats.skipped.push(`${f}:${lineOf(n)} ${label}`); return; }
      stats.matched++;
      const js = new Set([...known.vals, ...restSiblings(n, n.arguments[isParams ? 2 : 1])]);
      const allow = k => ALLOW_KEYS.some(([l, kk]) => l === label && kk === k);
      const onlyDts = [...dts].filter(k => !js.has(k) && !allow(k));
      const onlyJs = [...js].filter(k => !dts.has(k) && !allow(k));
      if (onlyDts.length && known.complete) out.push({ level: 'error', file: f, line: lineOf(n), msg: `${label}: in d.ts but unknown to ${fnName}: ${onlyDts.join(', ')}`,
        fix: 'add these keys to the known keys of checkOptions (if they are really supported), otherwise delete them from the d.ts' });
      if (onlyJs.length) out.push({ level: 'error', file: f, line: lineOf(n), msg: `${label}: known to ${fnName} but missing from d.ts: ${onlyJs.join(', ')}`,
        fix: 'add these fields (with JSDoc) to the matching options interface in the d.ts, otherwise delete them from the known keys' });
    });
  }
}

// ---------- F: what metadata lists is in the types ----------
/** Names one metadata fact says exist and a d.ts type lacks */
const missing = (names, has) => names.filter(k => !has(k));
/** Problems in the given facts: modules { call, file, params, aliases }, contracts { api }. T: typeTools() */
export function typeGaps(T, { modules, contracts }) {
  const out = [];
  for (const [name, m] of Object.entries(modules)) {
    const keys = Object.keys(m.params ?? {});
    if (!keys.length || !m.file.startsWith(P.MODULES_REL)) continue;
    for (const { call, file = m.file } of m.aliases ?? [m]) {
      if (!T.indexFns.has(call)) { out.push({ file, msg: `${call}() has options but is not in ${P.INDEX_DTS_REL}`, fix: `declare ${call}(opts) there, with a doc comment per option` }); continue; }
      const t = resolveParamType(T, call + '()', 0), fields = t && T.fields(t);
      if (!fields) { if (!t || !T.isObjLike(t)) out.push({ file, msg: `${call}() takes options but its d.ts declares none`, fix: `give ${call}() in ${P.INDEX_DTS_REL} an options type` }); continue; }
      const gone = missing(keys, k => fields.has(k));
      if (gone.length) out.push({ file, msg: `module ${name}: option(s) missing from the type of ${call}(): ${gone.join(', ')}`, fix: 'add them to the options interface, each with a doc comment' });
    }
  }
  for (const [name, c] of Object.entries(contracts)) {
    const api = c.api.filter(k => !c.internal?.includes(k)), t = api.length ? T.prop(T.engineType, name) : null;
    if (!api.length || (c.kind === 'object' && !t)) continue;   // a mover or a vehicle is an object handed around: no engine.<name> holds one
    const gone = !t ? api : missing(api, k => T.prop(t, k));
    if (gone.length) out.push({ file: c.file, msg: `contract ${name}: engine.${name} has no ${gone.join(', ')} in the types`, fix: `add them to the type of engine.${name} in the d.ts` });
  }
  return out;
}

// ---------- B: destructured parameters never read ----------
function partB(out) {
  const readCache = new Map();
  let code = null;   // the project's source without // comments, built once: each property used to split every file of the project again
  const readAnywhere = prop => {
    if (!readCache.has(prop)) {
      code ??= projectFiles().filter(f => !P.under(f, P.TOOLS_REL) && !P.under(f, P.ENGINE_TESTS_REL)).map(f => read(f).replace(/\/\/.*$/gm, '')).join('\n');
      readCache.set(prop, new RegExp(`\\.${prop}\\b(?![ \\t]*=[^=>\\r\\n])`).test(code));
    }
    return readCache.get(prop);
  };
  for (const f of engineFiles()) {
    visit(parse(f), fn => {
      if (!ts.isFunctionLike(fn) || !fn.body) return;
      for (const param of fn.parameters) {
        if (!ts.isObjectBindingPattern(param.name)) continue;
        for (const el of param.name.elements) {
          if (el.dotDotDotToken || !ts.isIdentifier(el.name)) continue;
          const name = el.name.text;
          if (ALLOW_PARAMS.some(([af, n]) => af === f && n === name)) continue;
          const refs = [];
          const scan = node => visit(node, x => {
            if (!ts.isIdentifier(x) || x.text !== name || x === el.name) return;
            const p = x.parent;
            if (ts.isPropertyAccessExpression(p) && p.name === x) return;
            if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === x) return;
            if (ts.isBindingElement(p) && p.propertyName === x) return;
            refs.push(x);
          });
          scan(fn.body);
          for (const other of fn.parameters) if (other !== param) scan(other);
          for (const other of param.name.elements) if (other !== el && other.initializer) scan(other.initializer);
          const where = `${fn.name?.getText() || (ts.isConstructorDeclaration(fn) ? 'constructor' : 'anonymous function')}`;
          if (!refs.length) {
            out.push({ level: 'warn', file: f, line: lineOf(el), msg: `parameter ${name} of ${where} is destructured but never used`, fix: `implement it, or delete it from the parameters, the checkOptions known keys and the d.ts together` });
            continue;
          }
          // only stored as this.x = name: check whether anything in the project reads .x
          const stored = refs.map(r => r.parent).filter(p => ts.isBinaryExpression(p) && p.right.getText() === name && p.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && ts.isPropertyAccessExpression(p.left) && p.left.expression.kind === ts.SyntaxKind.ThisKeyword);
          if (stored.length === refs.length) {
            const prop = stored[0].left.name.text;
            if (!readAnywhere(prop)) out.push({ level: 'warn', file: f, line: lineOf(el), msg: `parameter ${name} of ${where} is only stored as this.${prop}, and nothing in the project reads .${prop}`,
              fix: `implement it (read this.${prop}), or delete it from the parameters, the checkOptions known keys and the d.ts together` });
          }
        }
      }
    });
  }
}

const KEY_OPTION = /^(keys|pad|\w+Keys)$/;   // xPad stays free: cameraPad / colliderPad are paddings, not buttons
const RETIRED = { padKeys: 'pad', brakePadKeys: 'brakePad', viewDistance: 'viewChunks', range: 'radius' };
function partC(out) {
  for (const f of dtsFiles()) {
    const sf = parse(f);
    visit(sf, n => {
      if (!ts.isInterfaceDeclaration(n) || !/Options$/.test(n.name.text)) return;
      for (const m of n.members) {
        const k = m.name && m.name.getText();
        if (k && Object.hasOwn(RETIRED, k)) out.push({ level: 'error', file: f, line: lineOf(m), msg: `${n.name.text}.${k} is a retired option name`, fix: `call it ${RETIRED[k]}` });
      }
    });
  }
}

export default {
  id: 'R6', title: 'd.ts vs checkOptions / readParams tables, dead parameters',
  run() {
    const out = [], stats = { matched: 0, skipped: [] };
    partA(out, stats);
    partB(out);
    partC(out);
    partE(out);
    for (const p of typeGaps(typeTools(), metadata)) out.push({ level: 'error', line: 1, ...p });
    out.note = `${stats.matched} checkOptions calls (checkOptions + readParams) matched, ${stats.skipped.length} skipped because the label cannot be resolved to a d.ts type (add --verbose for the list)`;
    out.verbose = stats.skipped;
    return out;
  },
};
