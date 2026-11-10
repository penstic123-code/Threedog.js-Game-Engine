// Genericity fixes (docs/plans/done/2026-11-02-genericity-fixes.md items 6, 8, 9, 10): character states hook and water modes, vehicles that keep riders
// visible, hold / approach interactions, grid occupancy layers and levels, hud anchors, NPC interact ops. Same format as the other files here.
// Each check drives the engine path itself (fixed steps, ops, real key state), so a shortcut around the mechanism fails it.

export const specs = [
  {
    name: 'genfix: the states hook adds a game state on top of the mover, and the animation plays its clip',
    url: '/tests/vehicle/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const T = __threedogThree, Character = engine.player.constructor;
        const model = window.makeRig();   // skinned dummy with Idle / Walk / Run / Wave clips
        let crouch = true;
        const c = new Character(engine, { model, clips: { crouch: 'Wave' }, states: (ch, f) => crouch && f.grounded && f.base !== 'run' ? 'crouch' : null }); engine.add(c.root);
        c.placeAt({ x: 10, z: 10 });
        for (let i = 0; i < 10; i++) { c.move(0, 0, false, 1 / 60); c.animate(1 / 60); }
        const out = { state: c.state, anim: c.anim?.state ?? null };
        crouch = false;
        for (let i = 0; i < 3; i++) c.move(0, 0, false, 1 / 60);
        out.back = c.state;
        let bad = null; try { new Character(engine, { states: 'crouch' }); } catch (err) { bad = err.message; }
        out.bad = bad;
        c.dispose();
        return out;
      });
      check('[guard] states returns crouch: character.state is crouch (not idle)', r.state === 'crouch', JSON.stringify(r));
      check('the animator is on the crouch state (its clip comes from clips: { crouch })', r.anim === 'crouch', JSON.stringify(r));
      check('null from the hook gives the mover state back; a non-function states throws', r.back === 'idle' && /states/.test(r.bad || ''), JSON.stringify(r));
    },
  },
  {
    name: 'genfix: water modes swim / block / wade / function and the character:water event',
    url: '/tests/nav/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const p = engine.player, events = [];
        const off = engine.events.on('character:water', ({ character, in: inn, mode }) => { if (character === p) events.push(`${inn ? 'in' : 'out'}:${mode}`); });
        // deep water east of x = 20 (south of the maze wall), dry land west of it
        engine.waterAt = (x) => (typeof x === 'object' ? x.x : x) > 20 ? 10 : -Infinity;
        const h = engine.control.take(p, { owner: 'test', layer: 'script' });   // the test drives the player (its keys pause): core/ops/control.js
        const walk = mode => { p.water = mode; p.placeAt([17, 0, -8]); p.swimming = false; for (let i = 0; i < 90; i++) h.move(1, 0, false, 1 / 60); return { x: +p.position.x.toFixed(2), swim: p.swimming, state: p.state }; };
        const out = { swim: walk('swim'), block: walk('block'), wade: walk('wade'), fn: walk((c, { depth }) => depth > 5 ? 'block' : 'swim') };
        p.water = 'swim'; p.placeAt([17, 0, -8]); for (let i = 0; i < 3; i++) h.move(0, 0, false, 1 / 60);
        delete engine.waterAt; off.remove(); h.remove();
        out.events = events;
        return out;
      });
      check('[guard] swim: enters deep water and swims', r.swim.x > 20 && r.swim.swim && r.swim.state === 'swim', JSON.stringify(r.swim));
      check('[guard] block: stops at the shore and never swims', r.block.x <= 20.5 && !r.block.swim, JSON.stringify(r.block));
      check('wade: walks the bottom into deep water without swimming', r.wade.x > 20 && !r.wade.swim && r.wade.state !== 'swim', JSON.stringify(r.wade));
      check('a function decides per spot (depth 10 > 5: blocked)', r.fn.x <= 20.5 && !r.fn.swim, JSON.stringify(r.fn));
      check('character:water fires on entering and leaving with the mode', r.events.includes('in:swim') && r.events.includes('in:block') && r.events.includes('in:wade') && r.events.some(x => x.startsWith('out:')), JSON.stringify(r.events));
    },
  },
  {
    name: 'genfix: hideDriver false keeps the rider visible on its seat; seats take a passenger who does not drive',
    url: '/tests/vehicle/index.html',
    async run({ check, ev }) {
      await ev(() => __t.until(() => window.car?.seatPosition, 15000).catch(() => {}));
      const r = await ev(() => {
        engine.haltLoop();
        const p = engine.player, car = window.car, Character = p.constructor;
        car.hideDriver = false; car.seats = 2;
        const h = engine.control.take(p, { owner: 'test', layer: 'script' });
        p.enter(car); h.move(0, 0, false, 1 / 60);
        const rider = new Character(engine, {}); engine.add(rider.root); rider.enter(car); rider.move(0, 0, false, 1 / 60);
        const third = new Character(engine, {}); engine.add(third.root); third.enter(car);
        const out = { visible: p.root.visible, onSeat: p.position.distanceTo(car.seatPosition(0)) < 0.01, seat: p.seat, riderSeat: rider.seat,
          passengers: car.passengers.length, full: third.vehicle === null, driver: car.driver === p };
        rider.exit(); p.exit(); h.remove();
        out.after = { visible: p.root.visible, driver: car.driver, passengers: car.passengers.length };
        car.hideDriver = true; p.enter(car); out.hidden = !p.root.visible; p.exit();
        rider.dispose(); third.dispose(); car.seats = 1;
        return out;
      });
      check('[guard] hideDriver: false: the driver stays visible and sits on seat 0', r.visible && r.onSeat && r.seat === 0 && r.driver, JSON.stringify(r));
      check('a second character takes seat 1 as a passenger; a third finds no seat', r.riderSeat === 1 && r.passengers === 1 && r.full, JSON.stringify(r));
      check('getting out frees the seats; hideDriver true (default) hides the driver again', r.after.visible && !r.after.driver && r.after.passengers === 0 && r.hidden, JSON.stringify(r));
    },
  },
  {
    name: 'genfix: a hold interaction completes after its seconds with the key down and is interrupted on release',
    url: '/tests/vehicle/index.html',
    async run({ check, ev, page }) {
      await ev(() => {
        engine.haltLoop();
        window.__step = n => { for (let i = 0; i < n; i++) engine.step(1 / 60, { render: false, describe: false }); };
        const p = engine.player; p.placeAt({ x: 30, z: 30 });
        window.__hold = { used: 0, events: [] };
        engine.events.on('interaction:hold', x => window.__hold.events.push('hold:' + x.id));
        engine.events.on('interaction:interrupt', x => window.__hold.events.push('interrupt:' + x.reason));
        window.__holdH = engine.interactions.add({ x: 31, y: 0, z: 30 }, { id: 'pump', label: 'Pump', hold: 0.5, onUse: () => { window.__hold.used++; } });
        engine.interactions.update();
      });
      // released early: key down for 10 steps (0.17 s) then up
      await page.keyboard.down('KeyE');
      const early = await ev(() => { window.__step(10); return { holding: engine.interactions.holding?.progress ?? null, prompt: engine.interactions.current?.id }; });
      await page.keyboard.up('KeyE');
      const after = await ev(() => { window.__step(3); return { used: window.__hold.used, holding: engine.interactions.holding }; });
      // held through: 40 steps (0.67 s > 0.5 s)
      await page.keyboard.down('KeyE');
      const full = await ev(() => { window.__step(40); return { used: window.__hold.used, holding: engine.interactions.holding }; });
      await page.keyboard.up('KeyE');
      const r = await ev(() => { const o = { ...window.__hold }; window.__holdH.remove(); return o; });
      check('[guard] mid-hold: progress between 0 and 1, nothing used yet', early.holding > 0 && early.holding < 1 && after.used === 0, JSON.stringify({ early, after }));
      check('[guard] released early: interaction:interrupt with reason released', r.events.includes('interrupt:released') && after.holding === null, JSON.stringify(r.events));
      check('held past hold seconds: onUse ran once and the hold ended', full.used === 1 && full.holding === null, JSON.stringify(full));
    },
  },
  {
    name: 'genfix: approach walks the player to the target, then uses it; radius Infinity is usable from afar',
    url: '/tests/vehicle/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        const p = engine.player; p.placeAt({ x: 20, z: 20 });
        let usedAt = null, allowed = false;
        const h = engine.interactions.add({ x: 26, y: 0, z: 20 }, { id: 'clerk', label: 'Talk', radius: Infinity, approach: true, onUse: () => { usedAt = Math.hypot(p.position.x - 26, p.position.z - 20); allowed = engine.ops.running === 'interaction.use'; return 'served'; } });
        const res = engine.ops.run('interaction.use', { id: 'clerk' }, { source: 'test' });
        let settled = null; res.value?.approaching?.then(v => { settled = v; });
        const immediately = usedAt;
        for (let i = 0; i < 600 && settled === null; i++) { engine.step(1 / 60, { render: false, describe: false }); await Promise.resolve(); }
        h.remove();
        return { ok: res.ok, approaching: !!res.value?.approaching, immediately, usedAt, settled, allowed };
      });
      check('[guard] the use after the walk may write saved state (the op itself ended steps ago)', r.allowed, JSON.stringify(r));
      check('[guard] the op starts a walk instead of using it at once', r.ok && r.approaching && r.immediately === null, JSON.stringify(r));
      check('onUse runs after arriving (within reach) and its result settles the walk', r.usedAt !== null && r.usedAt < 2 && r.settled === 'served', JSON.stringify(r));
    },
  },
  {
    name: 'genfix: grid occupancy layers (a sofa on a floor tile, two sofas refused) and levels',
    url: '/tests/level/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        if (!engine.grids) engine.use(window.grids());
        const G = engine.grids, run = (n, a) => engine.ops.run(n, a, { source: 'test' });
        const room = G.add('gf-room', { cell: 1, origin: [-10, 10], size: [6, 6], levelHeight: 3 });
        G.define('gf-tile', { occupy: 'floor' }); G.define('gf-sofa', { size: [2, 1] });
        const tile = run('grid.place', { grid: 'gf-room', item: 'gf-tile', cell: [1, 1] });
        const sofa = run('grid.place', { grid: 'gf-room', item: 'gf-sofa', cell: [1, 1] });
        const sofa2 = run('grid.place', { grid: 'gf-room', item: 'gf-sofa', cell: [2, 1] });
        const tile2 = run('grid.place', { grid: 'gf-room', item: 'gf-tile', cell: [1, 1] });
        const up = run('grid.place', { grid: 'gf-room', item: 'gf-sofa', cell: [2, 1], level: 1 });
        const out = {
          tile: tile.ok, sofa: sofa.ok, sofa2: sofa2.code, tile2: tile2.code, up: up.ok,
          stack: room.stack([1, 1]), upAt: room.at([2, 1], { level: 1 }) === up.value,
          upY: +(engine.world.get(up.value).position.y - engine.world.get(sofa.value).position.y).toFixed(2),
          rec: JSON.parse(JSON.stringify(engine.world.get(up.value).grid)),
        };
        // a replaced mapping: cells twice as wide on x (a stand-in for another lattice), used by toCell and toWorld
        const wide = G.add('gf-wide', { cell: 1, origin: [0, 0], size: [4, 4], mapping: { toCell: (x, z) => [Math.floor(x / 2), Math.floor(z)], center: ([i, j]) => [i * 2 + 1, j + 0.5] } });
        out.mapped = [wide.toCell([5, 0, 1.5]), wide.toWorld([2, 1]).x];
        for (const id of [tile.value, sofa.value, up.value]) run('grid.remove', { id });
        return out;
      });
      check('[guard] a sofa stands on a floor tile (different occupancy layers share the cell)', r.tile && r.sofa && r.stack.floor && r.stack.main, JSON.stringify(r));
      check('[guard] two sofas on one layer are refused (occupied), and so are two tiles', r.sofa2 === 'occupied' && r.tile2 === 'occupied', JSON.stringify(r));
      check('level 1 is its own storey: same cells free, 3 m up, level saved on the record', r.up && r.upAt && r.upY === 3 && r.rec.level === 1, JSON.stringify(r));
      check('mapping replaces toCell / toWorld', JSON.stringify(r.mapped) === '[[2,1],5]', JSON.stringify(r.mapped));
    },
  },
  {
    name: 'genfix: hud counter / bar anchor picks the screen column; an unknown anchor throws',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.hud.addCounter('gf-score', { label: 'Score', value: 3, anchor: 'top-right' });
        engine.hud.bar('gf-hp', { value: 0.5, label: 'HP', anchor: 'bottom' });
        const col = id => [...document.querySelectorAll('.threedog-hud-counter, .threedog-hud-bar')].find(el => el.textContent.includes(id))?.parentElement?.className ?? null;
        const out = { score: col('Score'), hp: col('HP') };
        engine.hud.addCounter('gf-score', { anchor: 'bottom-left' }); out.moved = col('Score');
        try { engine.hud.bar('gf-x', { value: 1, anchor: 'middle' }); } catch (err) { out.bad = err.message; }
        engine.hud.remove('gf-score'); engine.hud.remove('gf-hp');
        return out;
      });
      check('[guard] anchor top-right / bottom put the counter and bar in those columns', /threedog-hud-top-right/.test(r.score || '') && /threedog-hud-bottom\b/.test(r.hp || ''), JSON.stringify(r));
      check('changing the anchor moves it; an unknown anchor throws with the list', /bottom-left/.test(r.moved || '') && /anchor 'middle'/.test(r.bad || ''), JSON.stringify(r));
    },
  },
  {
    name: 'genfix: NPC interact runs its op with { npc, ...args }; dialogue is the op npc.talk',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const got = [];
        engine.ops.define('gf.trade', { args: { npc: 'string', shelf: 'string' }, run: (e, a) => { got.push(`${a.npc}:${a.shelf}`); return 'opened'; } });
        const p = engine.player.position;
        engine.npcs.add({ id: 'gf-clerk', name: 'Clerk', position: [p.x + 1, 0, p.z], interact: { label: 'Trade', op: 'gf.trade', args: { shelf: 'tools' } } });
        await __t.until(() => engine.interactions.get('gf-clerk'), 8000).catch(() => {});
        const use = engine.ops.run('interaction.use', { id: 'gf-clerk' }, { source: 'test' });
        let bad = null; try { engine.npcs.add({ id: 'gf-bad', name: 'Bad', interact: 'hello' }); } catch (err) { bad = err.message; }
        const talk = engine.ops.can('npc.talk', { npc: 'gf-clerk' }).ok;
        const data = engine.npcs.get('gf-clerk').interact;
        engine.npcs.remove('gf-clerk');
        return { got, use: use.ok ? use.value : use.code, bad, talk, data, fisher: engine.npcs.get('fisher')?.interact?.op ?? null };
      });
      check('[guard] using the NPC runs its op with npc id and args, and returns the op value', r.got.join() === 'gf-clerk:tools' && r.use === 'opened', JSON.stringify(r));
      check('the record keeps interact as plain data; a wrong interact throws', r.data?.op === 'gf.trade' && r.data.label === 'Trade' && /interact is/.test(r.bad || ''), JSON.stringify(r));
      check('dialogue NPCs use the op npc.talk (the example fisher), and npc.talk is a checked op', r.fisher === 'npc.talk' && r.talk === true, JSON.stringify(r));
    },
  },
];
