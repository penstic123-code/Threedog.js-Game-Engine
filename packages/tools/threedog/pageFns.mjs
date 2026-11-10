// Functions the threedog commands run inside the game page (sent as source via toString, so each is self-contained) and the helpers that send them.
// The command layer that calls them is commands.mjs.
import { KEYBOARD_CODE } from '../lib/text.mjs';


/** Wait for the engine to be ready (right after the page opens / reloads, commands arrive first) */
// Same rule as the node-side wait (wait-engine.mjs): an uncaught error while there is no engine ends the wait at once and is quoted
// (window.__threedogUncaught is kept by the dev error relay, vite/vite-error-relay.js); the "no engine" text only when nothing threw.
export const READY = async () => {
  // A page that died at start will never get ready, and waiting out the minute on every command is what made it answer in over 100 s. An engine that exists gets
  // 3 s after an uncaught error: main.js throwing past window.engine leaves no engine error, while a stray error during a healthy load must not end the wait
  const threw = () => !window.engine && window.__threedogUncaught?.length;
  const stopped = () => !window.engine?.stateApplied && (window.engine?.error || window.__threedogUncaught?.length);
  let grace = 30;
  for (let i = 0; i < 600 && !window.engine?.stateApplied && !threw() && !window.engine?.error && !(stopped() && --grace < 0); i++) await new Promise(r => setTimeout(r, 100));
  if (stopped() && window.engine) throw new Error('the engine stopped before it was ready: ' + String(window.engine.error?.message ?? window.__threedogUncaught.at(-1)).slice(0, 400) + ' (threedog errors latest; fix it, then threedog reload)');
  if (threw()) throw new Error('the page threw before the engine existed: ' + window.__threedogUncaught.at(-1).slice(0, 400));
  if (!window.engine?.stateApplied) throw new Error('no ready engine in the page (is this a game page?)');
  return window.engine;
};

/**
 * One-line scenario: player position / time and weather / nearby / quest (runs in the page). Picks only what best tells "what is going on now"; ask describe
 * for details
 */
export const BRIEF = e => {
  const d = e.describe(), p = d.player, t = d.time, w = d.weather, flags = [];
  if (d.cutscene) flags.push('in cutscene');
  if (d.ui?.dialogue) flags.push('in dialogue');
  if (d.ui?.windows?.length) flags.push('windows open ' + d.ui.windows.map(x => x.id || x).slice(0, 2).join(', '));
  // engine.error is an object { where, message, code, at } (core/base/errors.js): String() of it printed "engine error [object Object]"
  if (d.error) flags.push(`engine error ${d.error.code ? `[${d.error.code}] ` : ''}${d.error.where}: ${(m => m.length > 400 ? m.slice(0, 200) + ' … ' + m.slice(-197) : m)(String(d.error.message))}${d.error.at ? ` (${d.error.at})` : ''}`);
  if (d.disabledModules?.length) flags.push('switched off after an error: ' + d.disabledModules.slice(0, 3).join(', '));
  if (d.loading?.failed?.length) flags.push('load failed ' + d.loading.failed.map(f => f.name).slice(0, 3).join(', ') + ' (threedog loading)');
  const l1 = [p && `Player (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) ${p.inWater ? 'in water' : 'on ' + (p.ground || 'ground')}`,
    t?.clock != null && `${t.clock}${t.day != null ? ' day ' + t.day : ''}`, (w?.name ?? w?.label), ...flags].filter(Boolean).join(' · ');
  const near = (d.nearby || []).slice(0, 3).map(n => `${n.name} ${n.dist} m${n.use ? ' (interactable)' : ''}`).join(', ');
  const q = d.quests?.active?.[0];
  return [l1, near && 'Nearby: ' + near, q && `Quest: ${q.title}: ${q.step}`].filter(Boolean);
};

/** Printed by shot and snap when the title is up (one sentence, so the two commands cannot drift apart) */
export const TITLE_COVERS = 'The start screen covers this picture: add --play to shoot the game behind it';
/**
 * What bears on a picture, printed under every `threedog shot` and `threedog snap` (one formatter for both): time and day / night, weather,
 * the camera with its focus, and a page error or failed load if any. Why not describeText: a ~15-line state block after every picture buried
 * the picture lines; the rest is one command away (threedog describe). Self-contained: it is serialized into the page.
 */
export const PICTURE = e => {
  const d = e.describe(), t = d.time, w = d.weather, c = d.camera, r = v => Math.round(v * 10) / 10;
  const err = d.error && `engine error ${d.error.code ? `[${d.error.code}] ` : ''}${d.error.where}: ${String(d.error.message).slice(0, 200)}`;
  return [
    t?.clock != null && `Time: ${t.clock}${t.day != null ? `, day ${t.day}` : ''}${t.isDay != null ? (t.isDay ? ', daytime' : ', night') : ''}`,
    w && `Weather: ${w.name ?? w.label}${w.progress < 1 ? `, changing (${Math.round(w.progress * 100)}%)` : ''}`,
    c && `Camera: ${c.type}${c.override ? ` (override ${c.override})` : ''}, position (${r(c.x)}, ${r(c.y)}, ${r(c.z)})${c.focus ? `, focus (${r(c.focus.x)}, ${r(c.focus.z)})` : ''}`,
    err, d.loading?.failed?.length && 'load failed ' + d.loading.failed.map(f => f.name).slice(0, 3).join(', ') + ' (threedog loading)',
    'More: threedog describe (--full for the state summary)',
  ].filter(Boolean);
};

/** The page's run state after a step or test command: running / title-frozen / halted / frozen(by owners) / loading (engine.runState) */
const RUN = e => { const r = e.runState; return 'Run state: ' + (r.state === 'frozen' ? `frozen(by ${r.owners.join(', ')})` : r.state) + (r.state === 'halted' && !e.headless ? ' (threedog resume restores real-time running)' : ''); };

/**
 * Value at a describe path: 'player.x', 'nearby[0].name', 'player.position' (-> { x, y, z }). The ONE parser: describe <path> and a scenario's
 * expect keys both use it (it runs in the page for describe, so it is self-contained).
 */
export const atPath = (obj, path) => String(path).split(/\.|(?=\[)/).filter(Boolean).reduce((v, k) => {
  if (v == null) return undefined;
  const got = v[k.startsWith('[') ? +k.slice(1, -1) : k];   // null is an answer ("no dialogue open"), only undefined means the path is not there
  return got === undefined && k === 'position' && typeof v === 'object' && 'x' in v ? { x: v.x, y: v.y, z: v.z } : got;
}, obj);

/**
 * Real seconds a step really moved, measured on the tick (frozen pages tick nothing), and why it fell short. The answer of step / press / hold and of a scenario's step: asked for
 * 3 s and frozen on an error after 2, it says 2 of 3, and less than asked is a failure everywhere. state says what stopped it: 'running', 'frozen', 'loading' or 'error'. A tick that went backwards means a new run started inside the step, so that is
 * counted as done. Self-contained.
 */
const MOVED = (e, before, seconds) => {
  const fixed = Math.max(1, Math.round(seconds * 60)), ticks = e.time.tick - before, moved = ticks < 0 ? seconds : Math.min(seconds, ticks / 60);
  const short = (ticks >= 0 && ticks < fixed) || !!e.error, by = e.runState.owners, state = e.error ? 'error' : !short ? 'running' : e.ready ? 'frozen' : 'loading';
  return { moved: +moved.toFixed(3), short, state, why: { error: `the engine stopped on an error: ${e.error?.message}`, frozen: `gameplay is frozen by ${by.join(', ') || 'a hold'}`, loading: 'the game is still loading', running: '' }[state] };
};
/** The one way a tool advances a page by seconds and reads what happened: the `step` command and a scenario's step both come here, so they cannot disagree. Self-contained */
export const STEPPED = `(e, seconds) => { const before = e.time.tick; e.step(seconds, { render: false }); return (${MOVED})(e, before, seconds); }`;

/** Wrap fn(arg, engine, brief, run, at, moved) into the source evaluate takes */
const page = fn => `async a => { const engine = await (${READY})(); return (${fn})(a, engine, ${BRIEF}, ${RUN}, ${atPath}, ${MOVED}, ${STEPPED}); }`;
/** Only waits for window.engine to exist: `loading` must answer while start() is still running or stuck */
const ATTACHED = async () => {
  for (let i = 0; i < 300 && !window.engine?.loading && !window.__threedogUncaught?.length; i++) await new Promise(r => setTimeout(r, 100));
  if (!window.engine && window.__threedogUncaught?.length) throw new Error('the page threw before the engine existed: ' + window.__threedogUncaught.at(-1).slice(0, 400));
  if (!window.engine?.loading) throw new Error('no engine in the page (is this a game page? main.js should set window.engine = engine before start())');
  return window.engine;
};

export const KEY = new RegExp(`^(${KEYBOARD_CODE}|Mouse[0-4])$`);

// ── Functions executed in the page ─────────────────────────────────────
const PAGE = {
  describe: (a, e, brief, run, at) => {
    if (a.all) return e.describeText({ full: true });   // everything: every nearby thing, every module's full data
    if (a.full) return e.describeText();   // the summary (at most 30 lines)
    if (!a.path) return brief(e).join('\n');
    const v = at(e.describe(), a.path);
    if (v === undefined) throw new Error(`describe has no "${a.path}"; top-level keys: ${Object.keys(e.describe()).join(', ')}`);
    return JSON.stringify(v, null, 1);
  },
  step: (a, e, brief, run, at, moved, stepped) => {
    e.haltLoop('threedog');   // stop a real-time page first, so the real-time loop and step do not both advance it
    const m = stepped(e, a.seconds);   // before the drawing step below, which would add a tick of its own
    e.step(1 / 60);   // render one frame so the picture matches the state
    const b = brief(e).slice(0, 2);
    b.push(run(e));
    return { ...m, text: b.join('\n') };
  },
  press: (a, e, brief, run, at, moved) => {
    const inp = e.input;
    let code = a.key;
    const action = inp.actions.has(code) ? code : null;
    if (action) code = inp.keysOf(code).find(k => !k.startsWith('Pad'));
    else if (/^[a-z]$/i.test(code)) code = 'Key' + code.toUpperCase();
    else if (/^\d$/.test(code)) code = 'Digit' + code;
    else if (!new RegExp(a.valid).test(code)) throw new Error(`Unknown "${a.key}". Action names: ${[...inp.actions.keys()].slice(0, 14).join(', ')}…; `
      + 'or a key code such as KeyE, Space, Escape');
    if (!code) throw new Error(`action "${a.key}" has no keyboard key`);
    e.haltLoop('threedog');
    // a part opened since the last frame (the title of a page just reloaded, nothing stepped yet) skips the keys of its first frame: that frame runs here, with no game time
    e._tools.frameHooks(0, true); inp.endFrame();
    // Actions go through the public input.simulate (same path as a real key press: the fixed snapshot and the frame "just pressed" see it).
    // A raw key code is sent as a real keyboard event: the engine's own window listener takes it, no private input call
    const down = on => action ? inp.simulate(action, on) : dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code }));
    // who holds the action is read BEFORE the press: a key that itself opens a window (cancel -> settings) must not be reported blocked by the window it opened
    const blocked = action ? inp.blockedBy(action) : [];
    const before = e.time.tick;
    down(true);
    e.step(a.seconds, { render: false });
    down(false);
    const m = moved(e, before, a.seconds);
    e.step(1 / 60);
    // an action the game refuses to read (a window or dialogue was already open, a gate is closed) is refused for a real key too: say so and by whom, not a silent no-op
    const b = brief(e).slice(0, 2), hold = a.seconds > 0.1;
    b[0] = `${hold ? 'Held' : 'Pressed'} ${a.key}${code === a.key ? '' : ' (' + code + ')'}${hold ? ' for ' + a.seconds + ' s' : ''} · ` + b[0];
    b.push(run(e));
    if (blocked.length) b.unshift(`Blocked: ${a.key} did nothing, input is held by ${blocked.join(', ')}`);
    return { ...m, stopped: !!e.error, blocked, text: b.join('\n') };
  },
  // skip: engine.skip({ to | seconds }): the jump itself is the op time.skip; the sky clock moves, no fixed steps run
  skip: async (a, e, brief, run) => {
    e.haltLoop('threedog');
    // fade= waits on frames and this page is halted: they are driven here (engine.skip says so), or the command hangs until the bridge gives up. Gameplay is frozen for the skip
    const jump = e.skip(a.opts);
    let ended = false; const end = () => { ended = true; }; jump.then(end, end);
    for (;;) { await new Promise(r => setTimeout(r)); if (ended) break; e.step(1 / 30, { render: false, describe: false }); }
    const v = await jump;
    e.step(1 / 60);
    return [`Skipped ${a.desc}` + (v === null || v === undefined ? '' : ' → ' + JSON.stringify(v).slice(0, 80)), ...brief(e).slice(0, 2), run(e)].join('\n');
  },
  // state changes the scenario, not the clock (only wait= moves it). On a halted page one frame with no game time shows the result: rigs see the new place, then a draw
  state: async (a, e, brief) => { const r = await e.applyState(a.params); if (e.halted) { e._tools.frameHooks(0, true); e._tools.render(1 / 60); } return { refused: r.refused, text: brief(e).slice(0, 2).join('\n') }; },
  // js / eval and checks scripts (js --file steps.js) share this one function, so both see the same globals: engine, step(seconds = 1/60) (pauses the
  // real-time loop first, like the step command), log(...), assert(cond, msg), expect(v, msg).toBe/toEqual/toBeGreaterThan(x, msg), toBeCloseTo(x, tol?, msg).
  // Checks mode (the script calls assert / expect, steps.mjs): a failed check is recorded and the script goes on; a throw ends it and counts as one
  // failure; returns the records, steps.mjs prints them. Plain mode (a.plain): the source is tried as an expression first, a throw comes back as threw, and
  // the return value comes back as JSON text (commands.mjs cuts it).
  steps: async (a, e) => {
    const AsyncFunction = (async () => {}).constructor, res = [], logs = [];   // the function body is async, so await works directly inside
    const show = v => { try { return JSON.stringify(v); } catch { return String(v); } };
    const rec = (ok, msg, detail) => { res.push({ ok, msg: msg || 'check ' + (res.length + 1), detail: ok ? '' : detail }); };
    const assert = (c, msg) => rec(!!c, msg, 'assert failed');
    // the message goes on the matcher (expect(v).toBe(x, msg)) or on expect (expect(v, msg).toBe(x)); the matcher's wins
    const expect = (v, em) => ({
      toBe: (x, m) => rec(Object.is(v, x), m ?? em, `expected ${show(x)}, got ${show(v)}`),
      toEqual: (x, m) => rec(show(v) === show(x), m ?? em, `expected ${show(x)}, got ${show(v)}`),
      // the message may stand where the tolerance goes, as on every other matcher
      toBeCloseTo: (x, tol = 0.01, m) => { if (typeof tol === 'string') [tol, m] = [0.01, tol]; rec(Math.abs(v - x) <= tol, m ?? em, `expected ${x} ± ${tol}, got ${show(v)}`); },
      toBeGreaterThan: (x, m) => rec(v > x, m ?? em, `expected > ${show(x)}, got ${show(v)}`),
    });
    const step = (s = 1 / 60) => { e.haltLoop('threedog'); e.step(s, { render: false }); e.step(1 / 60); };
    const log = (...x) => logs.push(x.map(y => typeof y === 'string' ? y : show(y)).join(' '));
    // a script awaiting game time on a page whose clock nobody advances (await walkTo on a headless page) would wait until the command timed out with no
    // reason given. The count of a.wait seconds runs only while the page looks stopped: driven by manual step, nothing loading, no clock tick, no queue moving.
    // A queue counts by change, not by being non-empty: jobs drain in frames, so on such a page a waiting queue never empties. Even then a script may be
    // waiting on something else (a fetch, a long timer), which a page cannot see: the message says "may", and --wait gives it longer.
    // Promise.resolve().then(fn): a body that does not compile rejects here and leaves no timer behind
    const stall = fn => new Promise((ok, no) => {
      const mark = () => `${e.time.tick} ${e.jobs?.pending} ${e.commits?.pending}`, manual = () => e.headless || e.runState.state === 'halted';
      let seen = mark(), last = Date.now();
      const t = setInterval(() => {
        const now = mark(), stopped = now === seen && manual() && e.stateApplied;
        seen = now;
        if (!stopped) { last = Date.now(); return; }
        if (Date.now() - last > a.wait * 1000) no(new Error(`script still waiting after ${a.wait} s. This page advances only on step and nothing is loading, so it may be waiting on the game clock: await walkTo, clock.after and timelines need step(1) in the script, or engine.step. If it waits on something else, give it longer with js --wait <seconds>. The command stops here; the script may still be running in the page.`));
      }, 500);
      Promise.resolve().then(fn).then(ok, no).finally(() => clearInterval(t));
    });
    // the body sits in a block: its own const log shadows the helper; as the bare function body it was a redeclaration of the parameter
    const run = body => stall(() => new AsyncFunction('engine', 'assert', 'expect', 'step', 'log', `{${body}\n}`)(e, assert, expect, step, log));
    if (a.plain) {
      let v;
      try {
        // an expression if it compiles as one, otherwise statements (multi-line needs its own return). Decided before anything runs: a SyntaxError from
        // JSON.parse inside the script is the script's own, and running it again would do its steps twice
        let expression = true;
        try { new AsyncFunction('return (' + a.src + ')'); } catch { expression = false; }
        v = await run(expression ? 'return (' + a.src + ')' : a.src);
      } catch (err) { return { logs, threw: String(err?.message ?? err) }; }
      let text = '(no return value)';
      if (v !== undefined) {
        try { text = JSON.stringify(v, (k, x) => typeof x === 'function' ? '[function]' : x, 1); } catch { text = String(v); }
      }
      return { logs, text };
    }
    let value, threw = null;
    try { value = await run(a.src); }
    catch (err) { threw = String(err?.message ?? err); }
    return { res, logs, threw, value: value === undefined ? undefined : show(value)?.slice(0, 300) };
  },
  resume: (a, e, brief, run) => { e._tools.resume('threedog'); return 'Real-time running resumed\n' + run(e); },
  // fading UI parts (the loading screen) finished: snap waits for it. Then, on a halted page (headless, step-driven), draw the current state once
  // without advancing game time: at tick 0 nothing had been drawn yet and snap read a black canvas (shot steps one frame before reading; the
  // same rule here, minus the game time, because snap must not change the running game)
  settled: async (a, e) => { await e.ui.settled?.(); if (e.halted) e._tools.render(1 / 60); return true; },
  // snap --play: what shot --play does (?play), on the open page. On a paused page one frame with no game time, so the picture is not the frame under the title
  play: async (a, e) => { await e.applyState({ play: true }); if (e.halted) { e._tools.frameHooks(0, true); e._tools.render(1 / 60); } return true; },
  title: (a, e) => !!e.ui.isOpen?.('title'),
  backend: (a, e) => e.describe().renderer,   // in words: lib/page-url.mjs drawnBy
  raw: (a, e) => e.describe(),   // the whole describe() object, compared in node (describe-snapshot.mjs)
  // op: raw key=value strings are converted by the op's args shape (n=2 -> 2, position=3,0,-2 -> [3, 0, -2]);
  // runs as source 'bridge' between steps, so no game time passes
  op: (a, e, brief) => {
    const d = e.ops.defs.get(a.name), shape = d?.shape || {}, args = {};
    // a value that does not fit the shape is refused here: Number('abc') went on as NaN and 'yes' as false, which the op then took for a real value
    const bad = (k, v, form) => { throw new Error(`${a.name}: ${k}=${v} is not ${form}`); };
    const list = v => v.split(',').map(Number);
    const conv = (k, v, t) => {
      if (t === 'int' || t === 'number') return Number.isFinite(Number(v)) && v !== '' ? Number(v) : bad(k, v, 'a number');
      if (t === 'bool') return v === 'true' ? true : v === 'false' ? false : bad(k, v, 'true or false');
      if (t === 'position') return list(v).length === 3 && list(v).every(Number.isFinite) ? list(v) : bad(k, v, 'three numbers x,y,z');
      if (t === 'string' || t === 'id') return v;
      if (/^-?[\d.]+(,-?[\d.]+)+$/.test(v)) return list(v);   // 3,0,4 for an untyped argument: the form every other bridge coordinate takes
      try { return JSON.parse(v); } catch { return v; }
    };
    for (const [k, v] of a.pairs) args[k] = conv(k, v, shape[k]?.type);
    // explain op: same arg conversion, nothing runs
    if (a.explain) { const x = e.explain({ op: a.name, args }); return { ok: x.ok, text: x.text, detail: x.detail }; }
    const r = e.ops.run(a.name, args, { source: 'bridge' });
    if (e.halted) e._tools.render(1 / 60);   // show the result without advancing game time
    const bag = e.inventory ? 'Bag ' + (e.inventory.list().slice(0, 6).map(x => `${x.id}×${x.count}`).join(' ') || 'empty') : '';
    const head = r.ok ? `✓ ${a.name}${r.value === undefined ? '' : ' → ' + JSON.stringify(r.value).slice(0, 80)}`
      : `✗ ${a.name}: ${r.code}${d?.reasons?.[r.code] ? ' (' + d.reasons[r.code] + ')' : ''}`;
    return { ok: r.ok, text: [head + (bag ? ' · ' + bag : ''), ...brief(e).slice(0, 2)].join('\n') };
  },
  ops: (a, e) => {
    // a value is an offer's value, or in the free-form list the arg's shape ({ type, optional, ... }), which prints as its type
    const word = v => v?.type ? v.type + (v.optional ? '?' : '') : Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : v;
    const fmtArgs = x => Object.entries(x || {}).map(([k, v]) => `${k}=${word(v)}`).join(' ');
    const all = e.ops.list();
    if (!all.length) return 'No ops defined (engine.ops.define(name, { can, run }), see recipes/23-ops.md)';
    const now = e.ops.list({ available: true });
    const shown = now.slice(0, 12).map(o => `${o.ok ? '✓' : '✗'} ${o.name}`
      + `${o.args && Object.keys(o.args).length ? ' ' + fmtArgs(o.args) : ''}${o.ok ? '' : ' (' + o.code + ')'}`);
    const free = all.filter(o => o.args && !e.ops.defs.get(o.name).offers).map(o => `${o.name} ${fmtArgs(o.args)}`);
    const freeLine = free.length ? 'Free-form args: ' + free.slice(0, 6).join(' · ') : '';
    const more = now.length > 12 ? ` · … ${now.length - 12} more on offer` : '', moreFree = free.length > 6 ? ` · … ${free.length - 6} more` : '';
    return [(shown.join(' · ') + more) || 'Nothing on offer right now', freeLine && freeLine + moreFree].filter(Boolean).join('\n');
  },
  // a source string, not a function: PICTURE is spliced in here because the page wrapper only passes brief / run / at / moved
  picture: `(a, e) => (${PICTURE})(e).join('\\n')`,
  catalog: (a, e) => ({ data: e.catalog(a.id ?? (a.find ? { find: a.find } : undefined), a.offered ? { offered: a.offered } : undefined), ids: [...e.modules.keys()], ops: [...e.ops.defs.keys()] }),
  inspect: (a, e) => {
    if (a.at === 'materials' || a.at === 'perf') return e.inspect[a.at]().text;   // threedog inspect materials | perf (engine.inspect.materials / perf)
    const r = e.inspect(a.at), args = x => Object.entries(x || {}).map(([k, v]) => ` ${k}=${v}`).join('');
    return [`${r.actor} at (${r.at.x}, ${r.at.z}) · near: ${r.near.slice(0, 4).map(n => `${n.name} ${n.dist} m`).join(', ') || 'nothing'}`,
      r.ops.map(o => `${o.ok ? '✓' : '✗'} ${o.op}${args(o.args)}`
      + (o.ok ? '' : ` (${o.code}${o.why ? ': ' + o.why : ''})`)).join(' · ') || 'No ops on offer',
      r.thing?.edit && `${r.thing.id}: ${r.thing.edit}`].filter(Boolean).join('\n');
  },
  scene: (a, e) => { const r = e.inspect.scene({ hidden: a.hidden, limit: a.limit }); return { ok: true, text: r.text, data: { camera: r.camera, counts: r.counts, items: r.items, truncated: r.truncated } }; },
  explain: (a, e) => { const r = e.explain({ [a.key]: a.value }); return { ok: r.ok, text: r.text, detail: r.detail }; },
  // pick: screen pixels (from the canvas top-left) -> the thing under them (engine.pick(...).thing): record id, kind, template, where it was authored
  pick: (a, e) => {
    const r = e.renderer.domElement.getBoundingClientRect(), h = e.pick(a.x / r.width * 2 - 1, 1 - a.y / r.height * 2, { targets: 'all' });
    if (!h) return { ok: false, text: `Nothing under (${a.x}, ${a.y}) `
      + `(canvas ${Math.round(r.width)}x${Math.round(r.height)} px; sky, terrain and vegetation are not picked)` };
    const t = h.thing, p = h.point, f = Object.entries(t.fields || {}).slice(0, 6).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
    const head = t.id ? `${t.id} (kind ${t.kind}${t.template ? ', template ' + t.template : ''})` : `scenery mesh "${t.mesh ?? '?'}" (no world record)`;
    return { ok: true, text: [`✓ ${head} at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) `
        + `· material ${t.material ?? '-'}${t.model ? ' · model ' + JSON.stringify(t.model) : ''}`,
      t.edit ?? (t.id ? 'no source known (a record added from code)' : 'part of a level model or added with engine.add'), f && 'fields '
        + f].filter(Boolean).join('\n'), thing: t };
  },
  // contentGroup: every object with this name that can hold parts, each with its direct children as plain numbers (content capture; the judging is in
  // content-stamp.mjs). A model comes from userData: modelKey (content and namedModel prototypes, JSON) or modelName (assets.model copies and their clones)
  contentGroup: (a, e) => {
    const yaw = q => 2 * Math.atan2(q.y, q.w), tilted = q => Math.abs(q.x) > 1e-3 || Math.abs(q.z) > 1e-3;   // from the quaternion: an Euler y wraps past 90 degrees
    const holder = o => o.isGroup || o.type === 'Object3D', found = [], names = new Set();
    e.scene.traverse(o => { if (!holder(o) || !o.name) return; names.add(o.name); if (o.name === a.name) found.push(o); });
    const child = o => {
      const ud = o.userData, q = o.quaternion;
      return { name: o.name, type: o.type, template: ud.template ?? null, model: ud.modelKey ? JSON.parse(ud.modelKey) : ud.modelName ?? null, visible: o.visible,
        x: o.position.x, y: o.position.y, z: o.position.z, rot: yaw(q), tilted: tilted(q), scale: [o.scale.x, o.scale.y, o.scale.z] };
    };
    const groups = found.map(g => {
      g.updateWorldMatrix(true, false);
      const s = g.getWorldScale(g.position.clone()), p = g.getWorldPosition(g.position.clone()), q = g.getWorldQuaternion(g.quaternion.clone());
      return { x: p.x, y: p.y, z: p.z, rot: yaw(q), tilted: tilted(q), scale: [s.x, s.y, s.z], children: g.children.map(child) };
    });
    return { groups, names: [...names].slice(0, 20) };
  },
  // loading: the same view as describe().loading, or one task with its source; formatted in node so the hint table applies
  loading: (a, e) => (a.name ? { task: e.loading.get(a.name) } : { view: e.loading.view(), ready: e.ready }),
};

export const ev = (d, name, arg) => d.evaluate(page(PAGE[name]), arg);
export const evAttached = (d, name, arg) => d.evaluate(`async a => (${PAGE[name]})(a, await (${ATTACHED})())`, arg);
