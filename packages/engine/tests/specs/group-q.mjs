// Group Q (docs/plans/2026-11-10-group-q.md): cross-group fixes the post-fix review found, one test item each so one throw stops no other.
// (Batching's hide / show check is in batching.mjs.) Page: the small town (engine.triggers, a calendar and a sky).
const url = '/tests/city/index.html';

export const specs = [
  {
    name: '[guard] group Q 2: engine.tier = tells every onTierChange follower once per real change, and a held post effect follows (small town)',
    url,
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const { onTierChange } = window.internals;
        let n = 0; const sub = onTierChange(engine, () => n++);
        const fx = engine.post.add({ name: 'fxQ', slot: 'ldr', order: 1, params: { q: 1 }, skipOnLowTier: true,
          fuse: { uniforms: { u_fxQ: 'float' }, values: p => ({ u_fxQ: p.q }), glsl: 'color.rgb *= u_fxQ;', tsl: (color, uv, { tsl: T, p }) => T.vec4(color.rgb.mul(p.q), color.a) } });
        const tier0 = engine._deviceTier;
        engine.tier = 'high'; const nHigh = n, onHigh = fx.enabled;
        engine.tier = 'low';
        const out = { nHigh, afterLow: n, onHigh, onLow: fx.enabled, read: engine.tier };
        engine.tier = 'low'; out.same = n;   // no change, no notice
        engine.tier = tier0; sub.remove(); fx.remove();
        return out;
      });
      check('tier setter: followers run once per real change, the held effect follows', r.nHigh <= 1 && r.afterLow === r.nHigh + 1 && r.onHigh && !r.onLow && r.same === r.afterLow && r.read === 'low', JSON.stringify(r));
    },
  },
  {
    name: '[guard] group Q 3: triggers.clear with a throwing onExit removes every zone and debug mesh and reports the error (small town)',
    url,
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const T = engine.triggers;
        engine.debug.view('triggers');
        const mk = (x, bad) => T.add({ shape: 'sphere', position: { x, y: 0, z: 900 }, radius: 1, tag: 'q' + x, onExit: bad ? () => { throw new Error('exit boom'); } : null });
        const zs = [mk(0, true), mk(10), mk(20)]; zs.forEach(z => { z.inside = true; });
        const before = T.list().length, err0 = engine.error;
        const e0 = console.error; console.error = () => {};   // dev reports the error loudly: that is the point, the page check must not count it
        let threw = false;
        try { T.clear(); } catch { threw = true; } finally { console.error = e0; }
        const out = { before, after: T.list().length, meshes: zs.map(z => z._mesh), gone: zs.every(z => z._gone), reported: !!engine.error && engine.error !== err0, threw };
        engine.error = null; engine.debug.view('off');
        return out;
      });
      check('triggers.clear: every zone and debug mesh gone although one onExit throws, and the error is reported', r.before >= 3 && r.after === 0 && r.gone && r.meshes.every(x => x === null) && r.reported && !r.threw, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group Q 4: a failing content undo warns rollback-incomplete, not content-misuse (small town)',
    url,
    async run({ check, ev }) {
      const seen = await ev(() => {
        const { runSections } = window.internals;
        const w0 = console.warn, seen = []; console.warn = (...a) => seen.push(String(a[0]));
        try {
          const bad = { name: 'x', commit() {}, undo: () => () => { throw new Error('undo boom'); } }, boom = { name: 'y', commit() { throw new Error('commit boom'); } };
          try { runSections([{ s: bad, data: 1 }, { s: boom, data: 1 }], {}); } catch {}
        } finally { console.warn = w0; }
        return seen;
      });
      check('a failing content undo warns with rollback-incomplete, not content-misuse', seen.some(s => s.includes('rollback-incomplete')) && !seen.some(s => s.includes('content-misuse')), JSON.stringify(seen));
    },
  },
  {
    name: '[guard] group Q 5: when the last day source goes, uNight, uDaylight and uTimeOfDay reset on the same write (small town)',
    url,
    async run({ check, ev }) {
      const r = await ev(() => {
        const { writeDaylight } = window.internals;
        const m = engine.audio.measures, saved = [m.get('daylight'), m.get('timeOfDay')];
        m.set('daylight', () => 0); m.set('timeOfDay', () => 0.9);
        writeDaylight(engine);
        m.delete('daylight'); m.delete('timeOfDay');
        const U = engine.uniforms, read = () => [U.uNight.value, U.uDaylight.value, U.uTimeOfDay.value];
        const night = read(); writeDaylight(engine); const one = read(); writeDaylight(engine); const two = read();
        if (saved[0]) m.set('daylight', saved[0]); if (saved[1]) m.set('timeOfDay', saved[1]);
        return { night, one, two };
      });
      const { night: a, one: b, two: c } = r;
      check('last day source gone: night, daylight and time of day stay together on the first write and all reset on the second', a[0] === 1 && b[0] === a[0] && b[1] === a[1] && b[2] === a[2] && c[0] === 0 && c[1] === 1 && c[2] === 0.5, JSON.stringify(r));
    },
  },
  {
    name: "[guard] group Q 3b: occupancy 'each': a first occupant's throwing onExit does not stop the later occupants' exits (small town)",
    url,
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const T = engine.triggers, got = [];
        const z = T.add({ shape: 'sphere', position: { x: 0, y: 0, z: 900 }, radius: 1, tag: 'qe', occupancy: 'each', onExit: (t, w, id) => { got.push(id); if (id === 'a') throw new Error('exit boom'); } });
        z._in = new Map([['a', { id: 'a' }], ['b', { id: 'b' }]]); z.inside = true;
        const e0 = console.error; console.error = () => {};
        try { T.clear(); } finally { console.error = e0; }
        const out = { got, gone: z._gone, reported: !!engine.error };
        engine.error = null;
        return out;
      });
      check('both occupants got their exit, the zone is gone, the error is reported', r.got.join() === 'a,b' && r.gone && r.reported, JSON.stringify(r));
    },
  },
];
