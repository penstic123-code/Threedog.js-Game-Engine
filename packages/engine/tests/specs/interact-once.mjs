// interactions.add(mesh, { once, counter }): a mesh the game built becomes a pick-and-count thing with no pickups, world record or bag. The guard goes through
// the op every use takes (key, click, hold, approach all end there) and through a save, because a thing that comes back after a load is silently lost progress.
export const specs = [
  {
    name: '[guard] interactions once + counter: hides the mesh, counts on the HUD, a refused use changes nothing, and load / new game bring both back in step',
    url: '/tests/ui/index.html?mode=default&play',
    async run({ check, ev }) {
      const r = await ev(async () => {
        await __t.until(() => engine.stateApplied, 10000);
        const I = engine.interactions, use = id => engine.ops.run('interaction.use', { id }, { source: 'player' });
        const count = () => engine.describe().hud.counters.shells;
        const mesh = (x, name) => { const m = new window.THREE.Mesh(); m.position.set(x, 0, 0); if (name) m.name = name; engine.scene.add(m); return m; };
        engine.hud.addCounter('shells', { label: 'Shells', value: 10, max: 14 });
        let refuse = true;
        const a = mesh(0.5, 'shell-a'), b = mesh(0.6), c = mesh(0.7);
        I.add(a, { label: 'Pick', once: true, counter: 'shells' });
        I.add(b, { id: 'b', label: 'Pick', once: true, counter: 'shells' });
        I.add(c, { id: 'c', label: 'Pick', once: true, counter: 'shells', onUse: () => refuse ? { ok: false, code: 'full' } : undefined });
        const out = {};
        const first = use('shell-a');
        out.used = { ok: first.ok, hidden: !a.visible, count: count() };
        const again = use('shell-a');
        out.again = { ok: again.ok, code: again.code, count: count() };
        const no = use('c');
        out.refused = { ok: no.ok, code: no.code, visible: c.visible, count: count() };
        await engine.saves.save('once-test');
        use('b'); refuse = false; use('c');
        out.after = { b: b.visible, c: c.visible, count: count() };
        await engine.saves.load('once-test');
        out.loaded = { a: a.visible, b: b.visible, c: c.visible, count: count() };
        const stops = f => { try { f(); return null; } catch (err) { return { code: err.code, message: err.message }; } };
        out.noId = stops(() => I.add(mesh(0.8), { label: 'Pick', once: true }));
        out.twin = stops(() => I.add(mesh(0.8), { id: 'b', label: 'Pick', once: true }));
        out.plain = stops(() => I.add(mesh(0.8), { label: 'Look' }).remove()) === null;
        await engine.session.newGame();
        out.fresh = { a: a.visible, b: b.visible, c: c.visible, base: count(), use: use('shell-a').ok, count: count() };
        await engine.saves.remove('once-test');
        // no hud(): the use still goes through (optional dependency)
        const h = engine.hud; engine.hud = undefined;
        const d = mesh(0.4); I.add(d, { id: 'd', label: 'Pick', once: true, counter: 'shells' });
        out.noHud = { ok: use('d').ok, hidden: !d.visible };
        engine.hud = h;
        try { I.add(mesh(0.3), { counter: 3 }); out.bad = 'no error'; } catch (e) { out.bad = e.code; }
        return out;
      });
      check('a use hides the mesh and adds 1 to the counter', r.used.ok && r.used.hidden && r.used.count === 11, JSON.stringify(r.used));
      check('a once item cannot be used twice', !r.again.ok && r.again.code === 'disabled' && r.again.count === 11, JSON.stringify(r.again));
      check('onUse returning { ok: false } leaves it and does not count', !r.refused.ok && r.refused.code === 'full' && r.refused.visible && r.refused.count === 11, JSON.stringify(r.refused));
      check('used after the save: hidden and counted', !r.after.b && !r.after.c && r.after.count === 13, JSON.stringify(r.after));
      check('load: the things used after the save are back, the count matches, the one used before stays gone', !r.loaded.a && r.loaded.b && r.loaded.c && r.loaded.count === 11, JSON.stringify(r.loaded));
      check('new game: everything back, the count at the game\'s own base value plus the new use', r.fresh.a && r.fresh.b && r.fresh.c && r.fresh.base === 10 && r.fresh.use && r.fresh.count === 11, JSON.stringify(r.fresh));
      check('without hud() a use still works', r.noHud.ok && r.noHud.hidden, JSON.stringify(r.noHud));
      check('a once thing with no id and no name stops at add(): a running number is not the same thing after a rebuild, so a used thing would come back', r.noId?.code === 'interaction-option' && /id:/.test(r.noId.message), JSON.stringify(r.noId));
      check('a second once thing with the same id stops at add() too (its id would get a running number)', r.twin?.code === 'interaction-option', JSON.stringify(r.twin));
      check('without once the running number stays fine: nothing is saved by it', r.plain === true, String(r.plain));
      check('a counter that is not a name stops at add()', r.bad === 'interaction-option', String(r.bad));
    },
  },
];
