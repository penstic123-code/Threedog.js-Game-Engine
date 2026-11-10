// R9 display-text keys for key actions must exist in every locale table (error)
// The label of input.define('action', { label: 'textKey' }), the 2nd argument of input.touchButton('action', 'textKey'),
// and the label in <game>/content/actions.js are the text shown on the key-rebinding page of the settings menu / on touch buttons:
//   - written as a key name (a.b form) → both the zh-CN and the en table must have it; missing one is an error (after switching language it would show as "inventory.action")
//   - plain text (no dot) in packages/engine/ → error (the engine hard-codes no UI text); plain text in game content is fine (the game picks its own language)
//   - input.define in packages/engine/ without a label → warning (the action name is shown as is)
// Where the text tables are collected from: every object literal in the whole project (engine, add-ons, examples and games, their picture/ folders included) that has both 'zh-CN' and en keys (CORE in I18n.js, each module's STRINGS,
//   e.i18n.add({...}), createEngine({ strings })), whose values are object literals or same-file constants.
// Limitation: text keys held in variables (such as the passthrough of a.label in content) are only checked for literals in content/actions.js; dynamically built keys are not found.
import { ts, parse, visit, lineOf, strValue, objectKeys, constInit, walk, isEngineCode, P } from './_lib.mjs';

// Allowlist: [text key, reason]
const ALLOW = [];
const KEYLIKE = /^[\w-]+(\.[\w-]+)+$/;

function tables(files) {
  const zh = new Set(), en = new Set();
  for (const f of files) {
    const sf = parse(f);
    visit(sf, n => {
      if (!ts.isObjectLiteralExpression(n)) return;
      const prop = name => n.properties.find(p => ts.isPropertyAssignment(p) && p.name && (p.name.text ?? p.name.getText()) === name);
      const z = prop('zh-CN'), e = prop('en');
      if (!z || !e) return;
      for (const k of objectKeys(sf, z.initializer).keys) zh.add(k);
      for (const k of objectKeys(sf, e.initializer).keys) en.add(k);
    });
  }
  return { zh, en };
}

export default {
  id: 'R9', title: 'Key text keys exist in every locale',
  run() {
    const files = [P.INDEX_JS_REL, ...[...P.ENGINE_CODE_DIRS_REL, ...P.ADDONS_REL, ...P.GAME_CODE_DIRS_REL].flatMap(d => walk(d, ['.js']))];
    const T = tables(files), out = [];
    const check = (f, line, key, where) => {
      if (ALLOW.some(([k]) => k === key)) return;
      const isEngine = isEngineCode(f);
      if (!KEYLIKE.test(key)) {
        if (isEngine) out.push({ level: 'error', file: f, line, msg: `${where} has display text hard-coded as "${key}"`, fix: `use a text key (such as 'myModule.action') and register zh-CN and en with e.i18n.add({ 'zh-CN': {...}, en: {...} })` });
        return;
      }
      const miss = [!T.zh.has(key) && 'zh-CN', !T.en.has(key) && 'en'].filter(Boolean);
      if (miss.length) out.push({ level: 'error', file: f, line, msg: `text key '${key}' of ${where} is missing from the ${miss.join(', ')} table`, fix: `add '${key}' to the ${miss.join(', ')} part of the i18n.add / STRINGS that registers the text` });
    };
    for (const f of files) {
      const sf = parse(f);
      visit(sf, n => {
        if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
        const m = n.expression.name.text, recv = n.expression.expression.getText();
        if (!/(^|\.)input$/.test(recv)) return;
        let arg;
        if (m === 'define' || m === 'action') {   // action: the old name of define
          const o = n.arguments[1];
          // options given as an object literal: read its label; anything else (a spread, a variable) cannot be checked here
          if (o && (!ts.isObjectLiteralExpression(o) || o.properties.some(p => ts.isSpreadAssignment(p)))) return;
          arg = o?.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText() === 'label')?.initializer;
        } else if (m === 'touchButton') arg = n.arguments[1]; else return;
        const action = strValue(n.arguments[0]) ?? n.arguments[0]?.getText();
        if (!arg) { if (isEngineCode(f)) out.push({ level: 'warn', file: f, line: lineOf(n), msg: `input.${m}('${action}') has no display text key`, fix: "add label: 'module.action' (a text key), otherwise the rebinding menu shows the action name" }); return; }
        let v = strValue(arg);
        if (v == null && ts.isIdentifier(arg)) { const init = constInit(sf, arg.text); v = strValue(init); }
        if (v == null) return;   // variable / expression: cannot check
        check(f, lineOf(n), v, `input.${m}('${action}')`);
      });
    }
    // game content actions.js: { action: { keys, label } }
    for (const f of P.GAME_CODE_DIRS_REL.flatMap(d => walk(d, ['.js'])).filter(f => /\/content\/actions\.js$/.test(f))) {
      const sf = parse(f);
      visit(sf, n => {
        if (!ts.isPropertyAssignment(n) || n.name.getText() !== 'label') return;
        const v = strValue(n.initializer);
        if (v != null) check(f, lineOf(n), v, `content actions "${n.parent.parent?.name?.getText?.() ?? ''}"`);
      });
    }
    return out;
  },
};
