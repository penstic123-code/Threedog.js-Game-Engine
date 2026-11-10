// Command execution layer: shared by the dev bridge command line (threedog describe|step|press…) and scenario tests (scenario.mjs).
// It depends on a single driver: { evaluate(src, arg), screenshot(), reload?() }
//   evaluate(src, arg)  run function source src (a string) in the page with arg, returning its JSON result (it may be async)
//   screenshot()        returns a PNG Buffer
//   reload()            optional: reload the page and wait for the engine to be ready (without it, location.reload inside evaluate)
// The dev bridge's driver forwards these three to the dev server; a scenario test implements the same three with Playwright's page.
//
// run(driver, command, args array, { dir }) → { ok, text }. text is English, at most 3 lines, read directly by the AI.
// Functions executed in the page must be self-contained (sent via toString()); the 3rd argument brief is injected by page().
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname, isAbsolute, resolve } from 'node:path';
import { ev, evAttached, KEY, TITLE_COVERS } from './pageFns.mjs';
import { readRuntime, trailer } from './runtime.mjs';
import { saveSnapshot, compareSnapshot, changeLine } from '../describe-snapshot.mjs';
import { hintFor } from 'threedog/error-hints';
import { errorsCommand, markReload } from './errorlog.mjs';
import { catalogCommand, offeredEffects } from './catalog.mjs';
import { isStepsScript, stepsReport } from './steps.mjs';
import { parseOptions, intOption } from '../lib/cli-args.mjs';
import { drawnBy } from '../lib/page-url.mjs';
const num = (s, name) => {
  const n = parseFloat(s);
  if (!(n > 0)) throw new Error(`${name} must be a positive number, e.g. threedog ${name === 'seconds' ? 'step 2' : '…'}`);
  return n;
};
/** The first n lines; dropped lines are said, an answer that just stops reads as the whole answer */
const lines = (s, n = 3) => { const l = String(s).split('\n'); return l.length <= n ? l.join('\n') : [...l.slice(0, n), `… ${l.length - n} more line${l.length - n > 1 ? 's' : ''}`].join('\n'); };
const MAX = 500;   // default output cap (characters); add --max N for more
/** The one way output is shortened: JSON cut mid-word looked complete but broken, so every cut names its size and the way to the rest */
const cut = (s, max) => { const t = String(s); return t.length <= max ? t : `${t.slice(0, max)}\n… cut at ${max} of ${t.length} characters (--max ${t.length} shows it all)`; };
const SCENE_ROWS = 6;   // objects threedog scene lists by default (counts and the reasons line still cover all)

/** key=value arguments of op / explain op / skip / state → [[key, value]]; a word without = is an error, not a silent { "": value } */
function opPairs(args, what = 'op arguments', e_g = 'n=2') {
  return args.map(kv => {
    const i = kv.indexOf('=');
    if (i < 1) throw new Error(`${what} are key=value, e.g. ${e_g} (got "${kv}"); in PowerShell quote commas: "position=3,0,-2"`);
    return [kv.slice(0, i), kv.slice(i + 1)];
  });
}

/**
 * Where snap writes: a bare name → <dir>/.threedog/shots/<name>.png; a path (absolute, or containing a folder) → that path, relative ones from dir.
 * .png is added only when there is no extension. → { file (absolute), shown (as printed) }
 */
function snapPath(dir, arg) {
  const given = arg || 'snap', withExt = extname(given) ? given : given + '.png';
  if (isAbsolute(given) || /[\\/]/.test(given)) return { file: resolve(dir, withExt), shown: withExt };
  const name = withExt.replace(/[^\w一-龥.-]+/g, '-');
  return { file: join(dir, '.threedog/shots', name), shown: `.threedog/shots/${name}` };
}

/** The options each command reads (lib/cli-args.mjs parseOptions spec); a command not listed takes none, so a typo fails instead of doing nothing */
const SCRIPT = { flags: ['verbose'], values: ['max', 'file', 'wait'], passthrough: true };   // passthrough: an expression may start with a dash (js "-x")
const OPTIONS = {
  describe: { flags: ['full', 'all'], values: ['max'] },
  press: { values: ['for'] },
  js: SCRIPT,
  snap: { flags: ['play', 'no-picture', 'help'], values: ['width'], short: { h: 'help' } },
  'snap-describe': { values: ['only', 'ignore', 'tolerance'] },
  errors: { values: ['since'] },
  catalog: { flags: ['full'], values: ['max', 'find'] },
  inspect: { values: ['max'] },
  scene: { flags: ['hidden', 'full'], values: ['limit'] },
  thing: { values: ['max'] },
  explain: { flags: ['full'], values: ['max'] },
};
/** One command's arguments → { rest, opt }, the numbers and lists already converted */
export function options(cmd, args) {
  const { rest, opt } = parseOptions(args, { positional: true, ...OPTIONS[cmd] });
  for (const k of ['max', 'width']) if (k in opt) opt[k] = intOption(opt, k);
  for (const k of ['wait', 'tolerance']) if (k in opt) opt[k] = +opt[k];
  for (const k of ['only', 'ignore']) if (k in opt) opt[k] = opt[k].split(',').filter(Boolean);
  return { rest, opt };
}

const WAIT_S = 120;   // eval: seconds a script may wait on a page that looks stopped before the command gives up (--wait)

/** catalog --find covers the library too: an entry pulled later is something the game can do. An unreadable library is said, never a silent "no hits" */
async function libraryHits(words) {
  if (!words) return null;
  const { listEntries, libraryDir } = await import('../lib.mjs');
  try { return listEntries(libraryDir(), [words]); } catch (e) { return { error: String(e?.message ?? e) }; }
}

/** Why a screenshot failed: the browser's "Timeout 30000ms" says nothing, so ask the page what it is doing. No answer in time means its main thread is stuck */
async function snapFailed(driver, err) {
  const { raw, runtime } = await readRuntime(driver, 3000), first = String(err?.message ?? err).split('\n')[0];
  return `snap failed: ${first}\nThe page: ${raw ? trailer(runtime) : 'did not answer within 3 s, so its main thread is busy: a long loop in game code, or shaders compiling on the software renderer. threedog loading and threedog errors may still say what it was doing; threedog reload starts it again.'}`;
}

/** loading command text: line 1 status, line 2 the failures, line 3 the hint for the first failure */
function loadingText({ view: v, ready }) {
  const c = v.counts, head = v.done
    ? `${v.ok ? '✓' : '✗'} Loading finished${ready ? '' : ' (start() not finished)'}, ${c.done - v.warnings.length}/${c.total} ok${v.warnings.length ? `, ${v.warnings.length} partial (missing files)` : ''}${c.failed ? `, ${c.failed} failed` : ''}`
    : `… ${v.blocked ? 'BLOCKED, ' : ''}waiting: ${v.waiting} (${c.pending} pending, ${c.done}/${c.total} done)`;
  const fail = v.failed.map(f => `${f.critical ? '✗ critical' : '! fell back'} ${f.kind} "${f.name}" ${f.error.url ?? ''} ${f.error.message}`
    + (f.fallback ? ` -> ${f.fallback}` : ''));
  const warn = v.warnings.map(w => `! "${w.name}" missing ${w.missing.join(', ')}`);
  const h = v.failed.length ? hintFor(v.blocked ? '[asset-critical]' : '[asset-load]') : v.warnings.length
    ? hintFor('[asset-missing-ref]') : null;
  const lines3 = [head, [...fail, ...warn].join(' · ').slice(0, 300), h && `-> Possible cause: ${h.cause.slice(0, 160)} Read: ${h.docs.join(', ')}`];
  return { ok: v.ok && !v.blocked, text: lines3.filter(Boolean).join('\n') };
}

/** Run one command. On failure throws an Error (message is English, for the AI to read) */
export async function run(driver, cmd, args = [], { dir = process.cwd() } = {}) {
  const { rest, opt } = options(cmd, args), max = opt.max || MAX;
  switch (cmd) {
    case 'describe': {
      const text = await ev(driver, 'describe', { full: opt.full, all: opt.all, path: rest[0] });
      return { ok: true, text: opt.full || opt.all ? text : rest[0] ? cut(text, max) : lines(text) };
    }
    case 'step': {
      const seconds = num(rest[0] ?? 1, 'seconds'), r = await ev(driver, 'step', { seconds });
      // the verdict is the seconds that passed, not the seconds asked for
      return r.short ? { ok: false, text: `✗ Stepped ${r.moved} of ${seconds} s: ${r.why} · ` + lines(r.text, 3) } : { ok: true, text: `✓ Stepped ${seconds} s · ` + lines(r.text, 3) };
    }
    case 'skip': {
      // same key=value shape as op: skip to=06:00 | skip seconds=600 (fade= and save= pass through to engine.skip)
      const o = Object.fromEntries(opPairs(rest)), opts = {}, usage = 'Usage: threedog skip to=06:00 or skip seconds=600 (optional fade=0.6 save=auto)';
      if ((o.to === undefined) === (o.seconds === undefined)) throw new Error(usage);
      for (const k of Object.keys(o)) if (!['to', 'seconds', 'fade', 'save'].includes(k)) throw new Error(`Unknown skip argument "${k}". ` + usage);
      if (o.to !== undefined) opts.to = o.to; else opts.seconds = num(o.seconds, 'seconds');
      if (o.fade !== undefined) opts.fade = num(o.fade, 'fade');
      if (o.save !== undefined) opts.save = o.save;
      return { ok: true, text: '✓ ' + lines(await ev(driver, 'skip', { opts, desc: o.to !== undefined ? 'to ' + o.to : o.seconds + ' s' }), 3) };
    }
    case 'press': case 'hold': {
      if (!rest[0]) throw new Error(`Usage: threedog ${cmd} action-or-key${cmd === 'hold' ? ' seconds' : ''}, e.g. threedog ${cmd} interact`);
      const seconds = cmd === 'hold' ? num(rest[1] ?? 1, 'seconds') : opt.for !== undefined ? num(opt.for, '--for seconds') : 0.1;
      const before = await ev(driver, 'raw', {}), r = await ev(driver, 'press', { key: rest[0], seconds, valid: KEY.source });
      r.text = lines(r.text, 3) + '\n' + changeLine(before, await ev(driver, 'raw', {}));
      // a press on a frozen page is normal (a title's Start, a dialogue choice): it fails only when the engine stopped on an error, or a hold never ran
      const held = cmd === 'hold' && r.short;
      return r.stopped || held ? { ok: false, text: `✗ ${held ? `Only ${r.moved} of ${seconds} s passed: ${r.why} · ` : ''}` + r.text } : { ok: true, blocked: r.blocked, text: '✓ ' + r.text };
    }
    case 'state': {
      const stray = rest.find(kv => !kv.includes('='));
      if (stray && /^-?[\d.]+$/.test(stray)) throw new Error(`"${stray}" is a stray number: in PowerShell a comma splits the argument, `
        + 'so quote coordinates, e.g. "pos=1,-8"');
      const params = Object.fromEntries(opPairs(rest, 'state arguments', 'time=18:30'));
      if (params.pos !== undefined && !/^-?[\d.]+,-?[\d.]+$/.test(params.pos)) throw new Error(`pos must be two numbers x,z (got "${params.pos}"). `
        + 'In PowerShell quote the comma: threedog state "pos=1,-8"');
      if (!Object.keys(params).length) throw new Error('Usage: threedog state time=18:30 weather=rain pos=40,-20 (also wait= cutscene=skip state=name fresh=1)');
      const r = await ev(driver, 'state', { params });
      if (!r.refused.length) return { ok: true, text: '✓ Set · ' + lines(r.text, 3) };
      const took = Object.keys(params).filter(k => !r.refused.some(x => x.key === k));
      return { ok: false, text: `✗ Not applied: ${r.refused.map(x => `${x.key}=${x.value} (${x.reason})`).join('; ')}${took.length ? `. Applied: ${took.join(', ')}` : ''}\n` + lines(r.text, 2) };
    }
    case 'js': {
      // --file: keep the script in a file, avoiding PowerShell / Bash quoting and multi-line problems
      if (opt.file && !existsSync(opt.file)) throw new Error(`Script file not found: "${opt.file}"`);
      const expr = opt.file ? readFileSync(opt.file, 'utf8') : rest.join(' ');
      if (!expr.trim()) throw new Error('Usage: threedog js "engine.calendar.timeOfDay" or threedog js --file script.js (same as eval)');
      // a script with assert( / expect( is a checks script: one call, short report, ok false (exit 1) on any failure (steps.mjs)
      const wait = opt.wait ?? WAIT_S;
      if (!(wait > 0)) throw new Error('--wait takes seconds above 0, e.g. js --wait 300 "await longJob()"');
      if (isStepsScript(expr)) return stepsReport(await ev(driver, 'steps', { src: expr, wait }), opt.verbose);
      // no checks: prints the return value as before (same globals; log lines come first)
      const r = await ev(driver, 'steps', { src: expr, plain: true, wait }), logs = r.logs.map(l => '· ' + l);
      // a script that threw keeps its log lines: they are what says how far it got
      if (r.threw) return { ok: false, kind: 'command-error', text: [...logs, '✗ ' + r.threw].join('\n') };
      return { ok: true, text: [...logs, '✓ ' + cut(r.text, max)].join('\n') };
    }
    case 'snap': {
      const usage = 'Usage: threedog snap [name | path] [--play] [--width N] [--no-picture]. A bare name saves .threedog/shots/<name>.png; a path (absolute, or with a folder) '
        + 'is used as given; .png is added only when it has no extension. --width N scales the returned image, the file stays full size. '
        + 'The picture check (as in threedog shot) runs on the page after the picture; --no-picture skips it. '
        + '--play first leaves the title screen the way its Start does, as in threedog shot --play';
      if (opt.help) return { ok: true, text: usage };
      const noPicture = opt['no-picture'], play = opt.play;
      if (rest.length > 1) throw new Error(`snap takes one name or path (got ${rest.length}: ${rest.join(' ')}). ` + usage);
      const out = snapPath(dir, rest[0]);
      if (play) await ev(driver, 'play', {});
      await ev(driver, 'settled', {});   // like threedog shot: never capture the loading screen mid-fade
      const png = await driver.screenshot().catch(async e => { throw new Error(await snapFailed(driver, e)); });
      mkdirSync(dirname(out.file), { recursive: true });
      writeFileSync(out.file, png);
      // the same lines as under a threedog shot (pageFns PICTURE): what bears on the picture, the rest via threedog describe
      const brief = await ev(driver, 'picture', {});
      // --width N: the file keeps the full size (picture compare reads it); the picture returned to the caller (MCP image) is scaled down to N px wide
      let image = png;
      if (opt.width) {
        const b64 = await driver.evaluate(`async ([src, w]) => { const i = new Image(); i.src = 'data:image/png;base64,' + src; await i.decode();
          if (i.naturalWidth <= w) return null; const c = document.createElement('canvas'); c.width = w; c.height = Math.max(1, Math.round(i.naturalHeight * w / i.naturalWidth));
          const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(i, 0, 0, c.width, c.height); return c.toDataURL('image/png').split(',')[1]; }`,
        [png.toString('base64'), opt.width]);
        if (b64) image = Buffer.from(b64, 'base64');
      }
      // the picture check on this same live page: a picture taken through the bridge must not skip what `threedog shot` reports (glare with its
      // source, shadows, noon / midnight). The probe renders and restores within one call, so the running game is left as it was
      let picture = '';
      if (!noPicture) {
        const { pagePicture, formatPicture } = await import('../picture/check.mjs');   // lazy: it pulls in the picture reader, which other commands never need
        const lk = await pagePicture((src, arg) => driver.evaluate(src, arg), { dir }).catch(e => ({ error: String(e?.message ?? e) }));
        picture = '\n' + (lk.error ? `Picture: skipped (${lk.error})` : formatPicture(lk.numbers, lk.probe, lk.hints).join('\n'));
      }
      const covered = !play && await ev(driver, 'title', {}) ? '\n  ' + TITLE_COVERS : '';
      return { ok: true, image, text: `✓ Screenshot ${out.shown} (${(png.length / 1024).toFixed(0)} KB, drawn by ${drawnBy(await ev(driver, 'backend', {}))})${image !== png ? `, image shown ${opt.width} px wide` : ''}${covered}\n` + brief + picture };
    }
    case 'snap-describe': {
      const [mode, name] = rest, snapDir = join(dir, 'tests', 'snapshots');
      if (!['save', 'diff'].includes(mode) || !name) throw new Error('Usage: threedog snap-describe save|diff name [--only a,b] [--ignore x.y] ' +
        '[--tolerance 0.5], e.g. snap-describe save market-noon --only player,quests');
      const d = await ev(driver, 'raw', {}), o = { only: opt.only, ignore: opt.ignore, tolerance: opt.tolerance };
      if (mode === 'save') { saveSnapshot(snapDir, name, d, o); return { ok: true, text: `✓ Baseline saved: tests/snapshots/${name}.describe.json` }; }
      const r = compareSnapshot(snapDir, name, d, o);
      return { ok: r.ok, text: r.ok ? `✓ describe "${name}" matches the baseline (${r.values} values compared)` : '✗ ' + r.text };
    }
    case 'errors': return errorsCommand(dir, rest, opt);
    case 'reload':
      markReload(dir);
      if (driver.reload) await driver.reload(); else await driver.evaluate('() => { setTimeout(() => location.reload(), 0); return 1; }');
      return { ok: true, text: '✓ Page reloaded' };
    case 'resume':
      return { ok: true, text: '✓ ' + await ev(driver, 'resume', {}) };
    case 'catalog': return catalogCommand(await ev(driver, 'catalog', { id: rest[0], find: opt.find, offered: /^(capability:)?picture$/.test(rest[0] ?? '') ? await offeredEffects(dir) : undefined }),
      rest[0], opt, dir, await libraryHits(opt.find));
    case 'ops':
      return { ok: true, text: lines(await ev(driver, 'ops', {}), 3) };
    case 'op': {
      if (!rest[0]) throw new Error('Usage: threedog op name key=value …, e.g. threedog op shop.buy shop=bakery item=bread (threedog ops lists what is ' +
        'possible)');
      const before = await ev(driver, 'raw', {}), r = await ev(driver, 'op', { name: rest[0], pairs: opPairs(rest.slice(1)) });
      return { ok: r.ok, text: lines(r.text, 3) + (r.ok ? '\n' + changeLine(before, await ev(driver, 'raw', {})) : '') };
    }
    case 'inspect': {
      const at = rest[0] && /^-?[\d.]+,-?[\d.]+$/.test(rest[0]) ? rest[0].split(',').map(Number) : rest[0];
      const text = await ev(driver, 'inspect', { at });
      // ✗ means a problem only in these two reports: around the player it marks an op that cannot run now, which is the answer asked for
      if (at !== 'materials' && at !== 'perf') return { ok: true, text: lines(text, 3) };
      return { ok: !/^✗/m.test(text), text: cut(text, opt.max || 2000) };
    }
    case 'scene': {
      const limit = opt.limit ? Number(opt.limit) : undefined;
      if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error('--limit must be a whole number above 0, e.g. threedog scene --hidden --limit 20');
      // answer first: the counts, the reasons line and the first few undrawn objects (the surprising ones sort before plain culling).
      // Why: listing 40 objects with their materials was ~15 KB of text and ~45 KB of MCP data on the world example, for one bug
      const r = await ev(driver, 'scene', { hidden: !!opt.hidden, limit: limit ?? (opt.full ? undefined : SCENE_ROWS) });
      const more = limit || opt.full ? '' : `\nMore: threedog scene --limit N (or --full for 40), --hidden for undrawn only, threedog thing <name> for one object`;
      return { ok: r.ok, text: r.text + more, data: r.data };
    }
    case 'pick': {
      const m = /^(-?[\d.]+),(-?[\d.]+)$/.exec(rest[0] ?? '');
      if (!m) throw new Error('Usage: threedog pick x,y (screen pixels from the canvas top-left), e.g. threedog pick 480,270 (in PowerShell quote it: ' +
        '"480,270")');
      const r = await ev(driver, 'pick', { x: Number(m[1]), y: Number(m[2]) });
      return { ok: r.ok, text: lines(r.text, 3) };
    }
    case 'explain': {
      if (!rest[1]) throw new Error('Usage: threedog explain op shop.buy key=value … / threedog explain quest first-light / threedog explain value fog.far / threedog explain thing chest-home / threedog explain module quests');
      const r = rest[0] === 'op' ? await ev(driver, 'op', { name: rest[1], explain: true, pairs: opPairs(rest.slice(2)) })
        : await ev(driver, 'explain', { key: rest[0], value: rest[1] });
      // --full adds the detail (an op's last attempt, a value's history, a thing's whole JSON)
      return { ok: r.ok, text: (r.ok ? '✓ ' : '✗ ') + lines(r.text, 3) + (opt.full && r.detail ? '\n' + cut(typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail, null, 1), max) : '') };
    }
    case 'loading': {
      if (!rest[0]) return loadingText(await evAttached(driver, 'loading', {}));
      const { task } = await evAttached(driver, 'loading', { name: rest[0] });
      if (!task) throw new Error(`No loading task named "${rest[0]}"; `
        + 'threedog loading lists pending and failed ones (manifest asset names, module names, track() names)');
      return { ok: task.phase !== 'failed', text: cut(JSON.stringify(task, null, 1), max) };
    }
  }
}
