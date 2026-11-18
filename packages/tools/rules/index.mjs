// Rule runner: packages/tools/check.mjs calls runRules(). Finds packages/tools/rules/R*.mjs (sorted by number), runs each and prints the results grouped by rule.
// Each rule file exports default { id, title, run(), game? } (game: true = also runs in a game installed from npm); run returns [{ level: 'error'|'warn', file, line, msg, fix }],
// and the array may carry note (a one-line summary) and verbose (an extra list shown with --verbose).
// Default output: errors in full, warnings as one count line per rule; --verbose lists the warnings (the first WARN_LIMIT per rule), --all every one.
// A rule with remind: true (R40) is the exception: its warnings are reminders, printed together through lib/remind.mjs (budget, one line each, counts) and never as plain warnings; runRules returns how many it found.
// A crashing rule does not stop the check: it is recorded as one error for that rule.
// scope (lib/scope.mjs, check -w <game>): only results in that workspace's files are printed and counted; the rest go to scope.other().
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RULES_REL } from '../paths.mjs';
import { item } from '../lib/result.mjs';
import { remind, BUDGET } from '../lib/remind.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const WARN_LIMIT = 15;

/** 'R04', 'r4', ' R4 ' -> 'R4' (rule ids are unpadded, file names are padded); anything else is returned trimmed and upper-cased */
export const normRuleId = s => { const t = String(s).trim().toUpperCase(), m = /^R0*(\d+)$/.exec(t); return m ? `R${m[1]}` : t; };

/** Every rule file, loaded: [{ file, rule }], sorted by number. check.mjs validates --rule ids against this before running anything */
export async function loadRules() {
  const files = readdirSync(DIR).filter(f => /^R\d+.*\.mjs$/.test(f)).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
  return Promise.all(files.map(async f => ({ file: f, rule: (await import(`./${f}`)).default })));
}

/** only: rule ids already normalized and validated by the caller (normRuleId); an id not in the list would just never match.
 *  items: an array to collect every result into (lib/result.mjs items, warnings included, code = the rule id) for --json; the printing stays as it is */
export async function runRules({ only = null, all = false, verbose = false, game = false, scope = null, items = null } = {}) {
  let errors = 0, warns = 0, hidden = 0;
  const reminders = [];   // warnings of remind rules, shown together after the loop
  const summary = [];
  console.log(`\nRule checks (${RULES_REL}/, each rule's criteria and allowlist are at the top of its file)`);
  for (const { file: f, rule } of await loadRules()) {
    if ((only && !only.includes(rule.id)) || (game && !rule.game)) continue;
    let res; const t0 = Date.now();
    try { res = await rule.run({ scope }); } catch (err) { res = [{ level: 'error', crashed: true, file: `${RULES_REL}/${f}`, line: 0, msg: `the rule itself crashed: ${err.message}`, fix: 'fix the rule script' }]; }
    if (Date.now() - t0 > 2000) console.log(`… ${rule.id} ${rule.title} took ${((Date.now() - t0) / 1000).toFixed(1)} s`);   // a slow rule shows while it happens, so the check does not look hung
    if (scope) {
      for (const r of res) if (!r.crashed && !scope.mine(r.file)) scope.other(r.file, r.level);
      res = res.filter(r => r.crashed || scope.mine(r.file));   // a crash counts everywhere: a rule that did not run has checked nothing. The rule's note describes the whole repo, so it is dropped with the rest
    }
    const found = res.map(r => item({ code: rule.id, level: r.level === 'error' ? 'error' : 'warn', file: r.file, line: r.line, message: r.msg, fix: r.fix, short: r.short, kind: r.kind }));
    items?.push(...found);
    const es = res.filter(r => r.level === 'error'), warned = res.filter(r => r.level !== 'error'), ws = rule.remind ? [] : warned;
    errors += es.length; warns += warned.length;
    summary.push(`${rule.id} ${es.length}✗ ${warned.length}!`);
    if (rule.remind) reminders.push(...found.filter(i => i.level === 'warn'));
    if (rule.remind && !es.length) { if (only && res.note) console.log(`${rule.id}: ${res.note}`); continue; }
    if (!res.length && !res.note) continue;
    // Short by default, detail on demand: errors print in full; a rule with only warnings is one line ("R1 file size: 92 warnings"), and
    // --verbose (or --all) lists them as before. Why: 90+ warning lines buried the one error an AI had to fix
    const full = verbose || all;
    let lastFix = null;
    const show = r => {
      const at = r.line ? `${r.file}:${r.line}` : r.file;
      console.log(`${r.level === 'error' ? '✗' : '!'} ${at}  ${r.msg}`);
      if (r.fix && r.fix !== lastFix) console.log(`    Fix: ${r.fix}`);
      lastFix = r.fix;
    };
    if (!full && !es.length) {
      if (ws.length) {
        console.log(`${rule.id} ${rule.title}: ${ws.length} warning${ws.length > 1 ? 's' : ''}`);
        hidden += ws.length;
      }
      continue;
    }
    console.log(`\n── ${rule.id} ${rule.title}: ${es.length} errors, ${ws.length} warnings (${f})`);
    es.forEach(show);
    if (!full) { if (ws.length) { console.log(`  and ${ws.length} warning${ws.length > 1 ? 's' : ''}`); hidden += ws.length; } continue; }
    (all ? ws : ws.slice(0, WARN_LIMIT)).forEach(show);
    if (!all && ws.length > WARN_LIMIT) console.log(`  …${ws.length - WARN_LIMIT} more warnings (npm run check -- --rule ${rule.id} --all shows all)`);
    if (res.note) console.log(`  (${res.note})`);
    if (verbose && res.verbose?.length) for (const v of res.verbose) console.log('    · ' + v);
  }
  if (reminders.length) {
    // a listing asks for more than the check's own budget (a plain check shows the budget): --rule and --all list every reminder, as the MCP check does; --verbose the first WARN_LIMIT
    const max = all || only ? Infinity : verbose ? WARN_LIMIT : BUDGET.check;
    console.log();
    remind(reminders, { max, rest: `npm run check -- --rule ${[...new Set(reminders.map(i => i.code))].join(',')} --all lists them` }).lines.forEach(l => console.log(l));
  }
  console.log(`\nRule checks: ${errors} errors, ${warns} warnings  [${summary.join(' · ')}]`);
  if (hidden) console.log(`details: --verbose (the warnings, the first ${WARN_LIMIT} per rule; --all for every one)`);
  return { errors, reminders: reminders.length };
}
