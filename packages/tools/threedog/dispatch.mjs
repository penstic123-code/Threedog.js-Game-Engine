// One entry for every bridge command, used by both the command line (cli.mjs) and the MCP server (mcp.mjs), so they cannot drift apart.
//   execute(dir, cmd, args, { page, onShot }) → { ok, summary, runtime, data, text }
//     ok       the command's own verdict (also the CLI exit code)
//     code     stable: ok | blocked | not-ready | no-server | starting | busy | page-error | no-bridge | command-error (see the comment where it is set)
//     summary  one sentence: the first line of text without its ✓ / ✗
//     runtime  { ready, mode: 'running' | 'halted' | 'frozen' | null, tick, headless, blockedBy[] } read right after the command (runtime.mjs)
//     data     structured payload where there is one (errors, status, verify, a described path); otherwise null
//     text     what the CLI prints and the MCP text content carries: the command's lines, then one line saying the state and the way back to normal.
//              Plain-data outputs (eval / js, describe with a path or --full / --all) get no state line, so their text stays parseable; runtime still has it.
import { run, options } from './commands.mjs';
import { parseOptions } from '../lib/cli-args.mjs';
import { COMMANDS, EXTRA } from './command-table.mjs';
import { bridgeDriver, devServer, errorText } from './connect.mjs';
import { diagnose } from './diagnose.mjs';
import { readRuntime, trailer, NONE } from './runtime.mjs';
import { play, status } from './play.mjs';
import { verify, scenarioReport } from './verify.mjs';
import { pictureCommand } from './picture-cmd.mjs';
import { reportCommand } from './report.mjs';

const ALL = { ...COMMANDS, ...EXTRA };

/**
 * Failures of the bridge itself (not of the command) get the five-cause diagnosis. connect.mjs marks its own with `bridge`; a page that never got ready can
 * only be told by its words, because they reach here as the text of an answer (pageFns READY / ATTACHED, wait-engine.mjs, vite-threedog-bridge.js ask)
 */
const PAGE_NOT_READY = /the engine stopped before it was ready|timed out waiting for the engine|no ready engine|no engine in the page|did not respond for \d+ minutes/;

/** Output that a caller parses (JSON, a bare value): no state line appended. Arguments run() rejects are already an error answer here, so a parse failure just means "not plain" */
const plain = (cmd, args) => {
  if (cmd === 'js') return true;
  if (cmd !== 'describe') return false;
  try { const { rest, opt } = options('describe', args); return !!(opt.full || opt.all || rest.length); } catch { return false; }
};

/** Options of the commands dispatch runs itself (the others are parsed by commands.mjs run()); an unknown one fails with the parser's list of valid ones */
const OWN = { play: { flags: ['stop'] }, status: {}, verify: { flags: ['freeze-reload', 'save-baseline'], positional: true }, scenario: { flags: ['freeze-reload'], positional: true } };

export async function execute(dir, cmd, args = [], { page, onShot } = {}) {
  // a mistyped command name is answered as that, not as "no dev server" (which is what the bridge check below would say first)
  if (!ALL[cmd]) {
    const text = `✗ no command "${cmd}"\nAvailable: ${Object.keys(ALL).filter(c => !c.startsWith('picture-')).join(', ')}, session`;
    return { ok: false, code: 'command-error', summary: `no command "${cmd}"`, runtime: NONE, data: null, text };
  }
  // the answer to --help needs no page, and a dead or absent page must not stand in the way of reading it
  if ((args.includes('--help') || args.includes('-h')) && cmd !== 'snap') return { ok: true, code: 'ok', summary: ALL[cmd], runtime: NONE, data: null, text: `threedog ${cmd}: ${ALL[cmd]}` };
  let r, driver, runtime = null, thrown = false, code = null;
  try {
    const own = OWN[cmd] && parseOptions(args, OWN[cmd]);
    if (own?.rest.length > 1) throw new Error(`${cmd} takes one scenario name, got ${own.rest.length}: ${own.rest.join(' ')}`);
    if (cmd === 'play') r = await play(dir, { page, stop: own.opt.stop });
    else if (cmd === 'status') r = await status(dir, { page });
    else if (cmd.startsWith('picture-')) r = await pictureCommand(dir, cmd, args);
    else if (cmd === 'report') r = await reportCommand(dir, args, { page });   // reads a page only when one is attached
    else if (cmd === 'impact') r = await (await import('../impact.mjs')).impactCommand(dir, args);   // files only; loaded here, it is the one command that needs the content loader
    else if (cmd === 'errors') r = { kind: 'blocked', ...await run(null, cmd, args, { dir }) };   // .threedog/errors.log, no page: a stuck page or a stopped server must not keep it from answering
    else {
      devServer(dir);
      driver = bridgeDriver(dir, { page });
      const freeze = !!own?.opt['freeze-reload'];   // the flag may come before the name
      if (freeze) {
        // a dev server started before this option takes the op as "reload the page" (its fallback for an unknown op) and answers null: stop there
        if (await driver.freezeReload(true) !== true) throw new Error('this dev server was started before --freeze-reload existed and cannot hold reloads: restart it (threedog play --stop, then threedog play) or run without the flag');
      }
      try { r = cmd === 'verify' ? await verify(driver, dir, own.rest[0], { saveBaseline: !!own.opt['save-baseline'] }) : cmd === 'scenario' ? await scenarioReport(driver, dir, own.rest[0]) : await run(driver, cmd, args, { dir }); }
      finally { if (freeze) await driver.freezeReload(false).catch(() => {}); }
    }
    runtime = r.runtime ?? null;
    if (r.image) onShot?.(r.image);   // snap: the picture the caller should see (it may be smaller than the saved file)
  } catch (e) {
    const dx = e.bridge || PAGE_NOT_READY.test(String(e.message)) ? await diagnose(dir, e).catch(() => null) : null;
    thrown = true;
    code = dx ? dx.kind : 'command-error';
    r = { ok: false, text: dx?.text ?? '✗ ' + errorText(e), data: dx ? { cause: dx.kind } : null };
    if (dx) driver = null;
  }
  if (driver) runtime = (await readRuntime(driver)).runtime;
  const rt = runtime ?? NONE;
  // code tells the three kinds of "not ok" apart without reading prose: blocked (the command ran and was refused / found a problem), not-ready (the page is not
  // ready), a connection cause (no-server | starting | busy | page-error | no-bridge), command-error (bad arguments or an exception in the page)
  code ??= r.ok ? 'ok' : r.kind ?? (rt.ready ? 'blocked' : 'not-ready');
  const body = r.text, state = runtime && !thrown && !plain(cmd, args);
  const summary = body.split('\n')[0].replace(/^[✓✗…]\s*/, '');
  let data = r.data ?? null;
  if (!data && plain(cmd, args)) try { data = JSON.parse(body.replace(/^✓ /, '')); } catch { data = null; }
  return { ok: r.ok, code, summary, runtime: rt, data,
    text: state ? `${body}\n${trailer(runtime)}` : body };
}
