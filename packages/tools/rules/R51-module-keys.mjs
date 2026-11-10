// R51 a module that needs a key has one (warning): a game that installs interactions(), quests(), inventory() or photo() usually binds their action somewhere.
// Why: modules bind no keys, so forgetting the bind leaves a game that builds, loads and passes every other check while E does nothing. The engine reports it
// at run time too (interaction-no-key, input-unbound), but `check` is what runs after every change, with no browser.
// Why only a warning: a click-only or touch-only game, or one with its own on-screen button, has no key and is right. The rule cannot see that.
// Scanned per game folder (a bind in main.js covers a module installed in plugins/): createEngine({ bindings }), input.bind(...), input.define(name, { keys }).
// Any key counts, a rebind to another key or to [] included: only "no key at all" is the fault. Bindings this pass cannot read (a variable, a spread of one,
// a computed name) count as "may cover it", so the rule stays quiet rather than guess. content/actions.js entries with keys count by their name.
// Scope: the same as R33 (examples, templates, games/*); tests/ pages are skipped. An action name other than the default is read from the literal `action:` given
// to the module call or to interactions.add.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { metadata } from 'threedog/metadata';
import { ts, read, parse, lineOf, visit, walk, rel, P } from './_lib.mjs';

// module function -> the action it reads when no action option is given: what the module declares without optional: true and with no key of its own
const NEEDS = Object.fromEntries(Object.values(metadata.modules).flatMap(m => metadata.actions.filter(a => a.file === m.file && !a.optional && !a.hasKey).map(a => [m.call, a.action])));
const isPresetsBindings = n => ts.isPropertyAccessExpression(n) && /^presets\.bindings\.\w+$/.test(n.getText());

/** What a bindings value binds: names into `bound`; anything unreadable sets bound.unknown. groups: presets.bindings */
function readBindings(n, bound, groups) {
  if (isPresetsBindings(n)) { for (const a of Object.keys(groups[n.name.text] ?? {})) bound.add(a); return; }
  if (!ts.isObjectLiteralExpression(n)) { bound.unknown = true; return; }
  for (const p of n.properties) {
    if (ts.isSpreadAssignment(p)) readBindings(p.expression, bound, groups);
    else if (p.name && !ts.isComputedPropertyName(p.name)) bound.add(p.name.text);
    else bound.unknown = true;
  }
}
const callName = c => ts.isIdentifier(c.expression) ? c.expression.text : ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : '';
const inputCall = c => ts.isPropertyAccessExpression(c.expression) && /\binput$/.test(c.expression.expression.getText());
/** The string given as `key:` in an object literal argument, else undefined */
const literalOption = (o, key) => {
  if (!o || !ts.isObjectLiteralExpression(o)) return undefined;
  const p = o.properties.find(x => ts.isPropertyAssignment(x) && x.name.getText() === key);
  return p && ts.isStringLiteralLike(p.initializer) ? p.initializer.text : undefined;
};

/** Scan the files of one game: { needs: [{ action, file, line, module }], bound: Set (with .unknown) } */
export function scanGame(files, groups, parseFile = parse) {
  const needs = [], bound = new Set();
  for (const f of files) {
    const sf = parseFile(f), imported = new Set();
    for (const s of sf.statements) {
      if (!ts.isImportDeclaration(s) || !/^threedog(\/|$)/.test(s.moduleSpecifier.text)) continue;
      for (const b of s.importClause?.namedBindings?.elements ?? []) imported.add((b.propertyName ?? b.name).text);
    }
    visit(sf, n => {
      if (!ts.isCallExpression(n)) return;
      const name = callName(n), [a0, a1] = n.arguments;
      if (ts.isIdentifier(n.expression) && NEEDS[name] && imported.has(name)) needs.push({ action: literalOption(a0, 'action') ?? NEEDS[name], file: f, line: lineOf(n), module: name });
      else if (name === 'createEngine') { const b = a0 && ts.isObjectLiteralExpression(a0) && a0.properties.find(p => p.name?.getText() === 'bindings'); if (b) readBindings(ts.isShorthandPropertyAssignment(b) ? b.name : b.initializer, bound, groups); }
      else if (name === 'bind' && inputCall(n) && a0) { if (ts.isStringLiteralLike(a0)) bound.add(a0.text); else readBindings(a0, bound, groups); }
      else if ((name === 'define' || name === 'action') && inputCall(n) && a0 && a1) { if (ts.isStringLiteralLike(a0)) bound.add(a0.text); else bound.unknown = true; }
      else if (name === 'add' && /interactions$/.test(n.expression.expression?.getText() ?? '')) { const action = literalOption(a1, 'action'); if (action) needs.push({ action, file: f, line: lineOf(n), module: 'interactions.add' }); }
    });
    // content/actions.js: { actions: { name: { keys } } } or a default export of that map, loaded by content(); its names are the object keys
    if (/(^|\/)content\/actions\.js$/.test(f)) visit(sf, n => { if (ts.isPropertyAssignment(n) && n.name.getText() === 'keys' && ts.isObjectLiteralExpression(n.parent) && ts.isPropertyAssignment(n.parent.parent)) bound.add(n.parent.parent.name.getText().replace(/['"]/g, '')); });
  }
  return { needs, bound };
}

/** Fix text for one action: the preset group that binds it, else a plain bind */
const fixLine = (action, groups) => {
  const g = Object.keys(groups).find(k => groups[k][action]);
  return g ? `add ...presets.bindings.${g} to createEngine({ bindings }), or engine.input.bind(presets.bindings.${g})` : `engine.input.bind('${action}', ['KeyX'])`;
};

/** Findings of one game's scan */
export function findings({ needs, bound }, groups) {
  if (bound.unknown) return [];
  return needs.filter(n => !bound.has(n.action)).map(n => ({ level: 'warn', file: n.file, line: n.line,
    msg: `${n.module} needs the action '${n.action}' but this game binds no key for it, so no key reaches it`,
    fix: `${fixLine(n.action, groups)}; any key works. Reached by a click, a touch or your own button instead? Say so with engine.input.bind('${n.action}', []) and this stops` }));
}

/** One game per folder: examples/<x>, games/<x>, templates are layers of one game and are read together */
export function gameFolders() {
  if (P.MODE === 'game') return P.gameDirs().map(d => rel(d) || '.').map(d => walk(d, ['.js', '.mjs']));
  const under = dir => [...new Set(walk(dir, ['.js', '.mjs']).map(f => f.slice(dir.length + 1).split('/')[0]))].filter(x => !/\.m?js$/.test(x)).map(x => walk(`${dir}/${x}`, ['.js', '.mjs']));
  return [...under(P.EXAMPLES_REL), ...under(P.GAMES_REL), walk(`${P.TOOLS_REL}/templates`, ['.js', '.mjs'])];
}

export default {
  id: 'R51', title: 'A module that needs a key has one', game: true,
  async run() {
    const { presets } = await import(pathToFileURL(join(P.ENGINE, 'presets.js')).href), groups = presets.bindings;
    return gameFolders().flatMap(files => findings(scanGame(files.filter(f => !/(^|\/)(tests|dist|node_modules)\//.test(f) && read(f).includes('threedog')), groups), groups));
  },
};
