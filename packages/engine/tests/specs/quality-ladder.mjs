// Adaptive quality's ladder (core/scene/adaptive.js, docs/plans/2026-11-09-quality-ladder.md). 不许绕开: one controller lowers the steps in order and
// raises them back in reverse, says what it lowered in the one perf notice, never back and forth on a step that rebuilds the chain, and what the game
// or the player decided (steps, an effect off) holds. Frames are fed by hand (engine._adapt), so no GPU and no timing luck decide the run.

export const specs = [
  {
    name: '[guard] quality-ladder: overload lowers cheaper params, then resolution, then held-off effects; reports it; raises back in reverse; no flapping; the game and the player win (small town)',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        const w0 = console.warn; console.warn = () => {};
        const tier0 = engine._deviceTier, a = engine.adaptive, pr = () => engine.renderer.getPixelRatio();
        try {
          engine.haltLoop();
          engine.tier = 'high';   // the fakes declare skipOnLowTier: a software-rendered page reads 'low' and would hold them before the ladder sees them
          // 8 frames of 125 ms = exactly one 1 s decision window; GPU time known, so cost alone decides (60 ms over a 16.7 ms budget, 3 ms well under)
          const win = cost => { for (let i = 0; i < 8; i++) engine._adapt(0.125, cost, false, true); };
          const state = () => [...a.held.keys()].join(',') + '|' + pr();
          const fresh = () => { a.on = false; win(3); Object.assign(a, { on: true, target: 60, t: 0, good: 0, cooldown: 0, age: 10, costs: [], gaps: [], refresh: Infinity, raisedAt: {}, wait: {}, notBefore: {}, steps: null }); engine.setPixelRatio(a.max); };
          const fake = (name, order, more) => ({ name, slot: 'ldr', order, params: { q: 1 }, skipOnLowTier: true, ...more,
            fuse: { uniforms: { [`u_${name}`]: 'float' }, values: p => ({ [`u_${name}`]: p.q }), glsl: `color.rgb *= u_${name};`, tsl: (color, uv, { tsl: T, p }) => T.vec4(color.rgb.mul(p.q), color.a) } });
          const A = engine.post.add(fake('fxA', 1, { cheaper: { q: 0.25 } })), B = engine.post.add(fake('fxB', 2));
          const out = { max: a.max, min: a.min };

          // 1. default ladder under overload, one step per window
          fresh();
          const down = [];
          for (let i = 0; i < 20; i++) { win(60); down.push(state()); }
          out.down = down;
          out.aq = A.params.q; out.on = [A.enabled, B.enabled];
          out.notice = engine.budget.notice();
          // 2. cheap frames: raised back in reverse (fxB, fxA, the resolution, fxA's params)
          const up = [];
          for (let i = 0; i < 200; i++) { win(3); const s = state(); if (s !== up[up.length - 1]) up.push(s); }
          out.up = up; out.back = { q: A.params.q, on: [A.enabled, B.enabled], ratio: pr(), notice: engine.budget.notice() };

          // 3. flapping: fxB raised, overload again at once -> it waits longer before its next raise
          fresh();
          for (let i = 0; i < 20; i++) win(60);          // all four steps down
          let n = 0; while (B.enabled === false && n++ < 60) win(3);   // until fxB is raised
          const raisedAt = a.age;
          win(60);                                         // straight back down
          out.flap = { reheld: !B.enabled, wait: (a.notBefore['post.fxB.off'] ?? 0) - a.age, at: raisedAt };
          let t = 0; while (!B.enabled && t < 60) { win(3); t++; }
          out.flap.raisedAfter = t;

          // 4. the game's steps: only the resolution; the effects held before are put back on the next decision
          fresh();
          for (let i = 0; i < 20; i++) win(60);
          a.steps = ['resolution'];
          win(60);
          out.only = { q: A.params.q, on: [A.enabled, B.enabled], held: [...a.held.keys()] };
          a.steps = [];
          engine.setPixelRatio(a.max); win(60); win(60);
          out.none = { ratio: pr(), held: a.held.size };
          // a game knob with a floor: lowered twice, then the ladder stops there; raised back twice
          let density = 1;
          a.steps = [{ name: 'grass', down: () => { if (density <= 0.5) return false; density -= 0.25; }, up: () => { density += 0.25; } }];
          win(60); win(60); win(60);
          out.grass = { density, text: engine.budget.notice() };
          for (let i = 0; i < 30; i++) win(3);
          out.grass.back = density;
          let bad = null; try { a.steps = ['shadows']; } catch (e) { bad = e.code; }
          let twice = null; try { a.steps = ['resolution', 'resolution']; } catch (e) { twice = e.code; }
          let odd = null; try { engine.post.add(fake('fxC', 3, { cheaper: { nope: 0 } })); } catch (e) { odd = e.message; }
          out.errors = { bad, twice, odd, cAdded: !!engine.post.get('fxC') };

          // 5. the player: fxB off in settings is not a step and stays off after the climb; the game's own set() meanwhile wins over the restore
          fresh();
          engine.mod('post.fxB.enabled', { owner: 'player-test', layer: 'settings', set: false });
          for (let i = 0; i < 20; i++) win(60);
          out.player = { heldB: a.held.has('post.fxB.off'), heldA: a.held.has('post.fxA.off') };
          A.set({ q: 0.8 });   // the game writes the param the ladder lowered (fxA is held off too: its params are still the game's)
          for (let i = 0; i < 200; i++) win(3);
          out.player.after = { q: A.params.q, b: B.enabled, a: A.enabled };
          engine.stacks.get('post.fxB.enabled').release('player-test');
          // 6. turning it off puts every effect back at once
          fresh();
          for (let i = 0; i < 20; i++) win(60);
          a.on = false; win(3);
          out.off = { q: A.params.q, on: [A.enabled, B.enabled], held: a.held.size };
          return out;
        } finally { for (const n of ['fxA', 'fxB', 'fxC']) engine.post.get(n)?.remove(); a.on = false; a.steps = null; engine.setPixelRatio(a.max); engine.tier = tier0; console.warn = w0; }
      });
      const J = JSON.stringify;
      const d = r.down, res = (s) => +s.split('|')[1];
      check('first step: the effect\'s own cheaper params, resolution untouched', d[0] === `post.fxA|${r.max}`, J(d.slice(0, 2)));
      const lastRes = d.findIndex(s => s.includes('post.fxA.off'));
      check('then the resolution, 0.1 a window, down to its floor before any effect goes off', res(d[1]) < r.max && lastRes > 1 && Math.abs(res(d[lastRes - 1]) - r.min) < 0.011 && !d.slice(0, lastRes).some(s => s.includes('.off')), J(d));
      check('last: the skipOnLowTier effects held off, in chain order; then nothing more', d[lastRes + 1] === `post.fxA,post.fxA.off,post.fxB.off|${r.min}` && d[d.length - 1] === d[lastRes + 1], J(d.slice(lastRes - 1)));
      check('lowered means lowered: param at its cheaper value, both effects off', r.aq === 0.25 && r.on[0] === false && r.on[1] === false, J([r.aq, r.on]));
      check('one notice line names every step and why', /lowered automatically: resolution [\d.]+ -> 0\.6, fxA cheaper, fxA off, fxB off \(frames cost 60\.0 ms of a 16\.7 ms budget/.test(r.notice ?? ''), String(r.notice));
      const u = r.up;
      check('raised in reverse: fxB, then fxA, then the resolution, then fxA\'s params', u[1]?.startsWith('post.fxA,post.fxA.off|') && u[2]?.startsWith('post.fxA|') && u[u.length - 1] === `|${r.max}`
        && u.findIndex(s => s.startsWith('|')) === u.length - 1, J(u.slice(0, 4).concat(u.slice(-2))));
      check('all the way back: params, effects, ratio, and the notice is gone', r.back.q === 1 && r.back.on.every(Boolean) && r.back.ratio === r.max && !/lowered/.test(r.back.notice ?? ''), J(r.back));
      check('a step that comes straight back down waits longer before its next raise', r.flap.reheld && r.flap.wait >= 14 && r.flap.raisedAfter >= 14, J(r.flap));
      check('the game keeps only the resolution: what the ladder held is put back, the effects are left alone', r.only.q === 1 && r.only.on.every(Boolean) && r.only.held.length === 0, J(r.only));
      check('steps = []: nothing is lowered', r.none.ratio === r.max && r.none.held === 0, J(r.none));
      check('a game knob: lowered until it says floor, named with its count, raised back', r.grass.density === 0.5 && /lowered automatically: grass x2/.test(r.grass.text ?? '') && r.grass.back === 1, J(r.grass));
      check('a wrong step and a step twice throw engine-misuse; cheaper naming a param the effect lacks throws, nothing added', r.errors.bad === 'engine-misuse' && r.errors.twice === 'engine-misuse'
        && /cheaper names nope/.test(r.errors.odd ?? '') && !r.errors.cAdded, J(r.errors));
      check('the player\'s off is not a step and stays off after the climb', !r.player.heldB && r.player.heldA && r.player.after.b === false && r.player.after.a === true, J(r.player));
      check('a param the game set while it was lowered is the game\'s: the restore leaves it', r.player.after.q === 0.8, J(r.player));
      check('adaptive.on = false puts every effect back at once (to the 0.8 the game wrote in 5)', r.off.q === 0.8 && r.off.on.every(Boolean) && r.off.held === 0, J(r.off));
    },
  },
  {
    // a step is the object the game gave, not its name: a new { name: 'grass' } after a reload used to inherit the old one's held notches, so raising called the old up()
    name: 'quality-ladder: a game step replaced by a new one of the same name: the old one is raised back first, the new one starts clean (small town)',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        const a = engine.adaptive;
        try {
          engine.haltLoop();
          const win = cost => { for (let i = 0; i < 8; i++) engine._adapt(0.125, cost, false, true); };
          a.on = false; win(3);
          Object.assign(a, { on: true, target: 60, t: 0, good: 0, cooldown: 0, age: 10, costs: [], gaps: [], refresh: Infinity, raisedAt: {}, wait: {}, notBefore: {} });
          const knob = () => { const k = { v: 1, step: { name: 'grass', down: () => { if (k.v <= 0.5) return false; k.v -= 0.25; }, up: () => { k.v += 0.25; } } }; return k; };
          const old = knob(), neu = knob();
          a.steps = [old.step];
          win(60); win(60);
          const lowered = old.v;
          a.steps = [neu.step];
          win(60);
          const swapped = { old: old.v, neu: neu.v };
          for (let i = 0; i < 40; i++) win(3);
          return { lowered, swapped, back: { old: old.v, neu: neu.v } };
        } finally { a.on = false; a.steps = null; engine.setPixelRatio(a.max); }
      });
      const J = JSON.stringify(r);
      check('the old step is raised back as soon as the new one replaces it', r.lowered === 0.5 && r.swapped.old === 1, J);
      check('raising works the new step, never the old one past where it started', r.back.old === 1 && r.back.neu === 1, J);
    },
  },
];
