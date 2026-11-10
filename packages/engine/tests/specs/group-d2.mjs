// Group D2 (docs/plans/research/2026-11-10-health-check-d.md): the API cleanup. A renamed name leaves in the same change (no alias); an internalised one still runs inside the engine. One test item each.
export const specs = [
  {
    name: '[guard] group D2: freeze({ still: true }) stills the page; the removed ambient key is rejected like any unknown option',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const out = {};
        const c = engine.freeze('d2-new', { still: true });
        out.newStill = engine.still; c.remove(); out.newGone = engine.still;
        const plain = engine.freeze('d2-plain'); out.plainStill = engine.still; plain.remove();
        try { engine.freeze('d2-old', { ambient: true }).remove(); out.err = null; } catch (e) { out.err = String(e.message ?? e).slice(0, 160); }
        out.after = engine.frozen;
        return out;
      });
      check('still holds a still, a plain freeze does not', r.newStill === true && r.newGone === false && r.plainStill === false, JSON.stringify(r));
      check('ambient is an unknown option: it throws naming the key, and nothing stays frozen', /ambient/.test(r.err ?? '') && r.after === false, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group D2: stacks.mod and engine.commits are internal but still run; engine.mod and ctx.commits reach the same things',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const out = {};
        engine.stacks.define('d2.point', { base: 1 }); engine.stacks.define('d2.point2', { base: 1 });
        out.sameMod = (() => { const h = engine.stacks.mod('d2.point', { owner: 'd2', set: 3 }), v = engine.stacks.get('d2.point'); const has = v.has('d2'); h.remove(); return has; })();
        let seen = null;
        engine.use({ name: 'd2-commits', install(e, ctx) { seen = ctx.commits; ctx.mod('time.world', { mul: 1 }); } });
        await Promise.resolve();
        out.ctxCommits = seen === engine.commits && typeof seen?.request === 'function';
        const h = engine.mod('d2.point2', { owner: 'd2', add: 1 }); out.engineMod = typeof h.remove === 'function'; h.remove();
        out.nextFixed = await engine.nextFixed(() => 7);
        return out;
      });
      check('stacks.mod still enters the same point engine.mod does', r.sameMod === true, JSON.stringify(r));
      check('a module gets the commit queue as ctx.commits (the object the engine uses)', r.ctxCommits === true, JSON.stringify(r));
      check('engine.mod returns a handle, engine.nextFixed answers with the value', r.engineMod === true && r.nextFixed === 7, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group D2: engine.ground keeps height / slope / type for a provider; engine.surface / slope / groundType answer through them; assets.forget and rays.forget still run',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const g = engine.ground;
        const out = { has: typeof g.has === 'function' && typeof g.voidY === 'function', provider: ['height', 'slope', 'type'].every(k => typeof g[k] === 'function') };
        out.surface = engine.surface(1, 2) === g.height(1, 2) && engine.slope(1, 2) === g.slope(1, 2) && engine.groundType(1, 2) === g.type(1, 2);
        out.water = engine.waterLevel === g.waterLevel;
        const o = engine.add(engine.scene.clone(false));
        try { engine.rays.forget(o); engine.assets.forget(o); out.forget = true; } catch (e) { out.forget = String(e); }
        return out;
      });
      check('has / voidY stay on engine.ground and a provider still implements the samplers', r.has && r.provider, JSON.stringify(r));
      check('the engine samplers read the provider', r.surface && r.water, JSON.stringify(r));
      check('rays.forget and assets.forget still run (engine.remove calls them)', r.forget === true, JSON.stringify(r));
    },
  },
  {
    name: '[guard] group D2: engine.debug.view, defineView and viewModes (now in the API lock) exist',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => ({ view: typeof engine.debug.view === 'function', define: typeof engine.debug.defineView === 'function', modes: engine.debug.viewModes().includes('off') || engine.debug.viewModes().length > 0 }));
      check('engine.debug.view / defineView / viewModes exist', r.view && r.define && r.modes, JSON.stringify(r));
    },
  },
];
