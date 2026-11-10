// Chaos: a composite game keeps running while a seeded driver performs random public-API actions; invariants are checked after each (tests/chaos/driver.js).
// It looks for what no one thought to test. A fixed set of seeds runs in the normal suite; a release runs many more:
//   npm test -- "Chaos"                                      the fixed seeds
//   CHAOS_SEEDS=50 CHAOS_FROM=1000 CHAOS_LENGTH=120 npm test -- "Chaos"    50 seeds from 1000, 120 actions each
//   CHAOS_REPLAY='[{"a":"newGame","p":[]}]' npm test -- "Chaos"  one list, as a failure prints it
//   CHAOS_RENDERER=webgpu npm test -- "Chaos"                 one renderer only (webgl | webgpu); by default every seed runs on both, the same list on each
// A failure prints the seed, the failure, the list shrunk to what still fails, and a row to paste into REGRESSIONS below, where it stays as a guard.
import { readFileSync } from 'node:fs';
import { plan, line } from '../chaos/plan.js';

const PAGE = '/tests/chaos/';
// the project's route switch (?renderer=webgpu, as perf.mjs uses it): the page builds a renderer: 'webgpu' engine, everything else is the same list
const RENDERERS = process.env.CHAOS_RENDERER ? [process.env.CHAOS_RENDERER] : ['webgl', 'webgpu'];
const pageOf = renderer => (renderer === 'webgpu' ? `${PAGE}?renderer=webgpu` : PAGE);
const SEEDS = Number(process.env.CHAOS_SEEDS) || 3;
const FROM = Number(process.env.CHAOS_FROM) || 1;
const LENGTH = Number(process.env.CHAOS_LENGTH) || 60;
const ACTION_MS = Number(process.env.CHAOS_ACTION_MS) || 45000;    // one action past this is a hang: the page may be stuck in a loop and cannot answer
const SHRINK_MS = Number(process.env.CHAOS_SHRINK_MS) || 90000;
// CHAOS_REPLAY='@file.json' reads the list from a file: a shrunk list of 60 actions is too long for a shell line
const REPLAY = process.env.CHAOS_REPLAY ? JSON.parse(process.env.CHAOS_REPLAY.startsWith('@') ? readFileSync(process.env.CHAOS_REPLAY.slice(1), 'utf8') : process.env.CHAOS_REPLAY) : null;

/**
 * Seeds a known engine bug stops, by renderer: { seed: 'finding' }. The seed still runs elsewhere; here it is listed, not run, so the suite stays green on
 * every other seed while the bug waits. Each row names its finding in docs/plans/research/2026-11-10-chaos-picture.md; delete the row when it is fixed.
 */
const SKIP_SEEDS = {
  webgl: {},
  webgpu: {},
};

/** Shrunk failures kept as guards: { name, list }. A row goes when its bug is fixed only if the list stops meaning anything; a passing row stays */
const REGRESSIONS = [
  { name: 'rigid swapped', list: [{ a: 'mod', p: [1, 0] }, { a: 'frames', p: [5] }, { a: 'audit', p: [] }] },
  { name: 'rigid removed under a driver', list: [{ a: 'enterVehicle', p: [0] }, { a: 'mod', p: [1, 1] }, { a: 'frames', p: [5] }, { a: 'audit', p: [] }] },
  { name: 'NPC walks to a point inside a wall', list: [{ a: 'walkTo', p: [2, 8, -5], bg: true }, { a: 'audit', p: [] }] },
  { name: 'player walks to a point inside a wall', list: [{ a: 'walkTo', p: [0, 8, -5], bg: true }, { a: 'audit', p: [] }] },
  { name: 'engine disposed with an NPC in a seat', list: [{ a: 'enterVehicle', p: [1] }, { a: 'frames', p: [3] }, { a: 'recreate', p: [] }] },
  { name: 'ragdoll ends after its camera left', list: [{ a: 'ragdoll', p: [0] }, { a: 'mod', p: [3, 1] }, { a: 'ragdoll', p: [1] }] },
  { name: 'ragdoll ended by a load after its camera was swapped', list: [{ a: 'save', p: [1] }, { a: 'ragdoll', p: [0] }, { a: 'mod', p: [3, 0] }, { a: 'load', p: [1] }] },
  { name: 'a load leaves an untouched crate out of the save', list: [{ a: 'frames', p: [37] }, { a: 'audit', p: [] }] },
  { name: 'a crate in the air stays in the air across a load', list: [{ a: 'recreate', p: [] }, { a: 'pushBody', p: [1] }, { a: 'audit', p: [] }] },
  { name: 'weather set at once reads the same after a load', list: [{ a: 'weather', p: [0] }, { a: 'audit', p: [] }] },
  { name: 'a load writes no change for the ground rounding under a prop', list: [{ a: 'levelLoad', p: [2] }, { a: 'audit', p: [] }] },
  { name: 'a moved prop keeps its height across a load on another level', list: [{ a: 'thingSet', p: [2, -5, -9] }, { a: 'levelLoad', p: [2] }, { a: 'audit', p: [] }] },
  { name: 'a crate put back by an undo reads the same after a load', list: [{ a: 'audit', p: [] }, { a: 'frames', p: [14] }, { a: 'thingSet', p: [0, -13, 8] }, { a: 'frames', p: [32] }, { a: 'undo', p: [] }, { a: 'audit', p: [] }] },
  { name: 'a turned car comes back from a load', list: [{ a: 'recreate', p: [] }, { a: 'walkTo', p: [2, 18, -13], bg: true }, { a: 'enterVehicle', p: [0] }, { a: 'audit', p: [] }] },
  { name: 'rigid replaced under a ragdoll', list: [{ a: 'ragdoll', p: [0] }, { a: 'mod', p: [1, 0] }, { a: 'audit', p: [] }] },
  { name: 'a crate moved with no physics installed keeps its record across a load', list: [{ a: 'mod', p: [1, 1] }, { a: 'thingSet', p: [0, -14, -6] }, { a: 'freeze', p: [] }, { a: 'audit', p: [] }] },
  { name: 'a record moved while its body waits for rigid beats the saved state', list: [{ a: 'pushBody', p: [1] }, { a: 'frames', p: [40] }, { a: 'save', p: [1] }, { a: 'mod', p: [1, 1] }, { a: 'load', p: [1] }, { a: 'worldMove', p: [1, -7, 14] }, { a: 'audit', p: [] }] },
  { name: 'a crate placed with no height stands on the ground', list: [{ a: 'thingSet', p: [0, -5, -7] }, { a: 'frames', p: [60] }, { a: 'audit', p: [] }] },
  { name: 'crates falling with no level under them come back from a load falling', list: [{ a: 'levelUnload', p: [] }, { a: 'frames', p: [21] }, { a: 'audit', p: [] }] },
  { name: 'a sleeping body keeps its speed across a load', list: [{ a: 'enterVehicle', p: [0] }, { a: 'quest', p: [2] }, { a: 'exitVehicle', p: [0] }, { a: 'pushBody', p: [2] }, { a: 'camera', p: [1, 0] }, { a: 'frames', p: [13] }, { a: 'frames', p: [11] }, { a: 'mod', p: [5, 0] }, { a: 'undo', p: [] }, { a: 'post', p: [1] }, { a: 'contentPack', p: [0] }, { a: 'audit', p: [] }] },
];

/** One run of a list in a page. Returns { fails, log, state, refusals, ran, slow } */
async function runList(page, list, seed) {
  const call = (fn, arg) => { let t; return Promise.race([page.evaluate(fn, arg), new Promise((_, no) => { t = setTimeout(() => no(new Error('HANG')), ACTION_MS); })]).finally(() => clearTimeout(t)); };
  const saveKey = `chaos-${seed}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let ran = 0, slow = [0, ''];
  try {
    await call(a => threedogChaos.begin(a), { seed, saveKey });
    for (const x of list) {
      const t0 = Date.now(), r = await call(a => threedogChaos.act(a), x);
      ran++; if (Date.now() - t0 > slow[0]) slow = [Date.now() - t0, line(x)];
      if (r.fails.length) break;
    }
    return { ...await call(() => threedogChaos.end()), ran, slow };
  } catch (e) {
    if (e.message !== 'HANG') throw e;
    return { fails: [{ kind: 'hang', detail: `${line(list[ran])} took over ${ACTION_MS} ms` }], log: [], state: [], refusals: {}, ran: ran + 1, slow };
  }
}

/** A page of its own, for runs after a hang (the first page may be dead) and so one run's page state cannot reach the next */
async function freshPage(old) {
  const url = new URL(old.url()).href, page = await old.context().browser().newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.threedogChaos, null, { timeout: 30000 });
  return page;
}

/** Delete actions while the same failure stays (ddmin), then drop `bg` marks one at a time */
async function shrink(page, list, seed, kind) {
  const end = Date.now() + SHRINK_MS;
  let trials = 0;
  const still = async cand => {
    trials++;
    const p = await freshPage(page);
    try { const r = await runList(p, cand, seed); return r.fails.some(f => f.kind === kind); } finally { p.close().catch(() => {}); }
  };
  let best = list, n = 2;
  while (best.length >= 2 && Date.now() < end) {
    const size = Math.ceil(best.length / n);
    let cut = false;
    for (let i = 0; i < best.length && Date.now() < end; i += size) {
      const cand = [...best.slice(0, i), ...best.slice(i + size)];
      if (cand.length && await still(cand)) { best = cand; n = Math.max(n - 1, 2); cut = true; break; }
    }
    if (!cut) { if (size === 1) break; n = Math.min(n * 2, best.length); }
  }
  for (let i = 0; i < best.length && Date.now() < end; i++) {
    if (!best[i].bg) continue;
    const cand = best.map((x, k) => { if (k !== i) return x; const { bg, ...rest } = x; return rest; });
    if (await still(cand)) best = cand;
  }
  return { list: best, trials };
}

/** The text of a failure: everything needed to rerun it, nothing else */
function report(seed, fail, small, trials) {
  const json = JSON.stringify(small);
  return [
    `${fail.kind}`, `  ${fail.detail.slice(0, 600)}`, `  seed ${seed}; shrunk to ${small.length} actions in ${trials} runs:`,
    ...small.map(x => `    ${line(x)}`),
    `  rerun: CHAOS_REPLAY='${json}' npm test -- "Chaos"`,
    `  guard: add to REGRESSIONS in tests/specs/chaos.mjs: { name: '${fail.kind.replace(/'/g, '').slice(0, 70)}', list: ${json} },`,
  ].join('\n');
}

async function chaos({ page, check }, seed, list) {
  await page.waitForFunction(() => window.threedogChaos, null, { timeout: 30000 });
  const r = await runList(page, list, seed);
  const refused = Object.entries(r.refusals).map(([k, n]) => `${k} x${n}`).join(', ');
  if (process.env.CHAOS_TRACE) console.log(`  seed ${seed} (${r.backend}): ran ${r.ran} of ${list.length}, ${r.frames} frames read, slowest ${r.slow.join(' ms ')}, refused ${refused || 'nothing'}`);
  if (!r.fails.length) { check(`${list.length} actions, every invariant held`, true); return; }
  const first = r.fails[0], { list: small, trials } = await shrink(page, list.slice(0, r.ran), seed, first.kind);
  check(`seed ${seed}: ${first.kind}`, false, report(seed, first, small, trials));
}

const seedSpec = (seed, renderer) => {
  const why = SKIP_SEEDS[renderer]?.[seed], name = `Chaos (${renderer}): seed ${seed}, ${LENGTH} random actions on a composite game keep every invariant`;
  if (why) return { name: `${name} [skipped: ${why}]`, url: pageOf(renderer), timeout: 30000, run: ({ check }) => check(`skipped seed: ${why}`, true) };
  return { name, url: pageOf(renderer), timeout: 600000, software: true,   // the frame check reads pixels: only all-black or all-white fails, the same on every machine
    serial: SEEDS <= 3 ? false : undefined, run: ctx => chaos(ctx, seed, plan(seed, { length: LENGTH })) };
};

export const specs = REPLAY ? RENDERERS.map(r => ({ name: `Chaos (${r}): replay of CHAOS_REPLAY`, url: pageOf(r), timeout: 300000, software: true, run: ctx => chaos(ctx, 1, REPLAY) })) : [
  ...RENDERERS.flatMap(r => Array.from({ length: SEEDS }, (_, i) => seedSpec(FROM + i, r))),
  ...REGRESSIONS.map(({ name, list }) => ({ name: `Chaos regression: ${name}`, url: PAGE, timeout: 300000, software: true, run: ctx => chaos(ctx, 1, list) })),
  {
    name: '[guard] Chaos: a seed replays exactly, and a planted bug is caught and shrunk to its cause',
    url: PAGE, timeout: 180000, software: true,
    async run({ page, check }) {
      await page.waitForFunction(() => window.threedogChaos, null, { timeout: 30000 });
      const list = plan(FROM, { length: 15 }), a = await runList(page, list, FROM), b = await runList(page, list, FROM);
      check('the plan comes from the seed alone', JSON.stringify(plan(7)) === JSON.stringify(plan(7)) && JSON.stringify(plan(7)) !== JSON.stringify(plan(8)));
      check('two runs of one list give the same log and the same end state', a.state.join() === b.state.join(), a.state.map((s, i) => (s === b.state[i] ? '' : `${s.slice(0, 120)} <> ${b.state[i].slice(0, 120)}`)).filter(Boolean).slice(0, 3).join(' ; '));
      const frames = n => ({ a: 'frames', p: [n] }), planted = [frames(2), { a: 'give', p: [1] }, { a: 'fault', p: [] }, frames(3), { a: 'camera', p: [1, 0] }, { a: 'audit', p: [1] }];
      const r = await runList(page, planted, FROM), kind = r.fails[0]?.kind ?? '';
      check('a planted held input or freeze fails the audit', /locked|frozen/.test(kind), JSON.stringify(r.fails));
      const { list: small } = await shrink(page, planted, FROM, kind);
      check('shrinking keeps the cause and drops the rest', small.map(x => x.a).join() === 'fault,audit', small.map(line).join(' '));
      // a refused wild value marks nothing: after weather.set refuses NaN seconds the black-frame check still watches
      const refused = await runList(page, [{ a: 'weatherTo', p: [0, 4] }, { a: 'faultBlack', p: [] }, { a: 'audit', p: [1] }], FROM);
      check('a refused wild value leaves the frame check on', /frame all black/.test(refused.fails[0]?.kind ?? ''), JSON.stringify(refused.fails));
      for (const [a, want] of [['faultBlack', /frame all black/], ['faultStale', /stale provider: weather/], ['faultLeak', /counter grew: sceneObjects/], ['faultLost', /record lost/]]) {
        const got = await runList(page, [{ a, p: [] }, { a: 'audit', p: [1] }], FROM);
        check(`planted ${a} fails with ${want.source}`, want.test(got.fails[0]?.kind ?? ''), JSON.stringify(got.fails));
      }
    },
  },
];
