// The three engine findings of the picture chaos run (docs/plans/research/2026-11-10-chaos-picture.md), each held at the call a game makes. Built on the
// chaos page's composite game (tests/chaos/game.js), WebGL route, because that is where each one was found and shrunk.
export const specs = [{
  name: '[guard] Picture chaos fixes: depth order refused at add, cascades refused beside another shadow light, non-finite post params refused',
  url: '/tests/chaos/', timeout: 120000, software: true,
  async run({ page, check }) {
    await page.waitForFunction(() => window.threedogChaos, null, { timeout: 30000 });
    const r = await page.evaluate(async () => {
      const { buildGame, FX } = window.threedogChaos;
      const errors = [], log = console.error;
      console.error = (...a) => { errors.push(a.map(String).join(' ').slice(0, 200)); };
      const code = f => { try { f(); return 'accepted'; } catch (e) { return e.code ?? `uncoded: ${e.message}`; } };
      const { E, THREE } = await buildGame({ saveKey: `chaos-fixes-${Date.now()}`, seed: 1 });
      const frame = () => E.step(1 / 30, { render: true, describe: false });
      const out = {};
      try {
        // P1: ao held off by the low preset; outline after it would break depth once ao comes on, so the add is the refusal, and the switch that turns ao on is clean
        E.settings.preset('low');
        E.post.add(FX.ao(), { name: 'ao' });
        out.p1Add = code(() => E.post.add(FX.outline({ order: 30 }), { name: 'outline' }));
        out.p1Left = !!E.post.get('outline');
        E.settings.preset('high'); frame();
        out.p1Fine = code(() => E.post.add(FX.outline({ order: 10 }), { name: 'outline' }));   // before ao: allowed
        E.settings.preset('low'); E.settings.preset('high'); frame();
        out.p1Errors = errors.length;
        E.post.get('outline')?.remove(); E.post.get('ao')?.remove();
        // the one order rule, in every on / off state: a pass of the game's own as plain objects (no render work), swapping as its params say
        const pass = swap => ({ enabled: true, needsSwap: swap, clear: false, renderToScreen: false, render() {}, setSize() {}, dispose() {} });
        const depthReader = (slot, order) => ({ name: `reader-${slot}`, slot, order, needsDepth: true, create: () => pass(false) });
        // a tone effect that does not swap: when it is off the default OutputPass runs, and that swaps, so an ldr depth reader can never be safe
        E.post.add({ name: 'calmTone', slot: 'tone', create: () => pass(false) });
        out.toneLdr = code(() => E.post.add(depthReader('ldr', 1)));
        E.post.get('calmTone').remove(); E.post.get('reader-ldr')?.remove();
        // set() that makes a pass swap ahead of a depth reader: refused at the set, the old params back
        const flip = E.post.add({ name: 'flip', slot: 'hdr', order: 1, params: { swap: 0 }, create: ({ params }) => pass(!!params.swap) });
        E.post.add(depthReader('hdr', 5));
        out.flipSet = code(() => flip.set({ swap: 1 }));
        out.flipKept = flip.params.swap;
        flip.remove(); E.post.get('reader-hdr').remove();
        // a tone effect that reads depth behind a swapping hdr pass: the tone entry keeps its own depth read
        E.post.add({ name: 'swapper', slot: 'hdr', order: 1, create: () => pass(true) });
        out.toneReads = code(() => E.post.add({ name: 'depthTone', slot: 'tone', needsDepth: true, create: () => pass(false) }));
        // while the game owns the chain the gate still checks: refused at the add, nothing left registered, the hand-back clean
        E.post.own();
        out.ownedAdd = code(() => E.post.add({ ...depthReader('hdr', 5), name: 'reader-owned' }));
        out.ownedLeft = !!E.post.get('reader-owned');
        out.handBack = code(() => E.post.own(false));
        E.post.get('swapper').remove(); E.post.get('depthTone')?.remove(); E.post.get('reader-owned')?.remove();
        // one check per change: a set() that rebuilds its pass runs the order rule once
        const be = E.post._be, real = be.checkOrder; let calls = 0;
        const reb = E.post.add({ name: 'reb', slot: 'hdr', order: 1, params: { k: 0 }, create: () => pass(false) });
        E.post.add(depthReader('hdr', 5)); frame();
        be.checkOrder = p => { calls++; return real.call(be, p); };
        reb.set({ k: 1 });
        be.checkOrder = real; out.setChecks = calls;
        reb.remove(); E.post.get('reader-hdr').remove();
        // an update() that changes its pass and then throws: set() puts the old params and the old pass state back
        const bad = E.post.add({ name: 'badUpdate', slot: 'hdr', params: { level: 1 }, create: () => pass(false),
          update(p, params) { p.needsSwap = params.level > 1; if (params.level > 1) throw new Error('update failed half-way'); } });
        frame();
        out.badSet = code(() => bad.set({ level: 2 }));
        out.badKept = [bad.params.level, bad._impl?.needsSwap];   // the built pass, read through the handle's internal: update() wrote on it
        bad.remove();
        // P3: NaN / Infinity refused on both ways in; a finite wild value is the game's (no clamp)
        const v = E.post.add(FX.vignette(), { name: 'vignette' });
        out.p3Set = code(() => v.set({ strength: NaN }));
        out.p3Kept = v.params.strength;
        out.p3Add = code(() => E.post.add(FX.bloom({ strength: Infinity }), { name: 'bloom' }));
        v.set({ strength: -1 }); out.p3Neg = v.params.strength;
        v.remove();
        // P2: the engine sun casts; cascades on a second shadow light are refused by name instead of a csm shader error on the next frame
        const lamp = Object.assign(new THREE.DirectionalLight(0xffffff, 1), { castShadow: true }); lamp.position.set(-20, 30, 10); E.scene.add(lamp);
        E.tier = 'high';
        out.p2Other = code(() => E.shadows.cascades(lamp, { count: 2 }));
        frame();
        E.lights.sun.castShadow = false;
        let h = null; out.p2Alone = code(() => { h = E.shadows.cascades(lamp, { count: 2 }); });
        frame(); frame();
        h?.remove(); E.lights.sun.castShadow = true;
        out.errors = errors.slice(0, 3);
      } finally { console.error = log; E.dispose(); }
      return out;
    });
    check('P1: an add that breaks depth order once a held effect turns on is refused at the add', r.p1Add === 'post-effect' && !r.p1Left, JSON.stringify(r));
    check('P1: an order that keeps depth is accepted, and preset switches turning ao on and off log no error', r.p1Fine === 'accepted' && r.p1Errors === 0, JSON.stringify(r));
    check('order: a depth reader in ldr is refused even beside a tone effect that does not swap (the default output runs when it is off)', r.toneLdr === 'post-effect', JSON.stringify(r));
    check('order: handle.set() that turns a pass into a swapping one ahead of a depth reader is refused and keeps the old params', r.flipSet === 'post-effect' && r.flipKept === 0, JSON.stringify(r));
    check('order: a tone effect that reads depth behind a swapping hdr pass is refused', r.toneReads === 'post-effect', JSON.stringify(r));
    check('order: while the game owns the chain, a bad order is refused at the add and nothing stays registered; the hand-back is clean', r.ownedAdd === 'post-effect' && !r.ownedLeft && r.handBack === 'accepted', JSON.stringify(r));
    check('order: a set() that rebuilds its pass runs the order rule once', r.setChecks === 1, JSON.stringify(r));
    check('set(): an update() that throws half-way leaves the old params', r.badSet !== 'accepted' && r.badKept[0] === 1 && r.badKept[1] === false, JSON.stringify(r));
    check('P3: handle.set({ x: NaN }) is refused and the old value stays', r.p3Set === 'post-effect' && r.p3Kept === 0.35, JSON.stringify(r));
    check('P3: an effect added with Infinity in its params is refused', r.p3Add === 'post-effect', JSON.stringify(r));
    check('P3: a finite negative value is taken as given (no clamp)', r.p3Neg === -1, JSON.stringify(r));
    check('P2: cascades beside another shadow-casting DirectionalLight are refused with a code', r.p2Other === 'shadow-cascades', JSON.stringify(r));
    check('P2: with that light not casting, the same cascades work and no shader error is logged', r.p2Alone === 'accepted' && !r.errors.length, JSON.stringify(r));
  },
}];
