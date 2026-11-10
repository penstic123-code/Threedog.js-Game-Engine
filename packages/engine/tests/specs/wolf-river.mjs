// Shared acceptance scene "Wolf river" (docs/plans/done/2026-11-06-batch7-design.md): tests/wolf-river/main.js is game code on the public API; this spec plays it. Rapier's own world is public
// (engine.rigid.world, recipe 11), so the joint and body counts read that.
const PAGE = '/tests/wolf-river/index.html';

const game_LEVEL = -0.4;   // the page's water level

export const specs = [
  {
    name: '[guard] wolf river: four-legged ragdoll, curved river, choice in a bubble, a replaced quests section, leases back to baseline',
    url: PAGE,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
      const r = await ev(async () => {
        engine.haltLoop();
        const P = engine.player, R = engine.rigid, T = game.THREE, out = {};
        const steps = async n => { for (let i = 0; i < n; i++) { engine.step(1 / 60); if (i % 30 === 0) await new Promise(res => setTimeout(res, 0)); } };
        const base = () => ({ bodies: R.bodies.length, colliders: R.world.colliders.len(), rb: R.world.bodies.len(), joints: R.world.impulseJoints.len() });
        const err = f => { try { f(); return null; } catch (e) { return e.code ?? e.message; } };
        await steps(60);
        out.start = { at: P.position.toArray().map(v => +v.toFixed(2)), ground: engine.surface(P.position.x, P.position.z) };

        // the curve: water follows the river, not a straight strip
        const zb = Math.PI / 2 / 0.1, bend = game.riverX(zb);
        out.river = { middle: engine.waterAt(0, 0), bendIn: engine.waterAt(bend, zb), bendOut: engine.waterAt(0, zb), high: engine.waterAt(0, 0, 50) };
        const walk = engine.control.take(P, { owner: 'cross', layer: 'script', step: () => ({ x: -1, z: 0 }) });
        await steps(360); walk.remove();
        out.swim = { swimming: P.swimming, at: P.position.toArray().map(v => +v.toFixed(2)), inWater: engine.describe().player.inWater };
        P.placeAt([20, 0, 0]); await steps(30);

        // ragdoll on the bank
        const b0 = base(), skin = P.root.getObjectByProperty('isSkinnedMesh', true);
        const rd = R.ragdoll(P, { impulse: [40, 60, 20] });
        out.parts = Object.keys(rd.parts).sort(); out.during = { ...base(), owner: engine.control.of(P).owner };
        const lengths = () => { P.root.updateMatrixWorld(true); const V = T.Vector3; return skin.skeleton.bones.filter(b => b.parent?.isBone && b !== rd.parts.hips.object).map(b => b.getWorldPosition(new V()).distanceTo(b.parent.getWorldPosition(new V()))); };
        const len0 = lengths();
        let stretch = 0, nan = false, maxY = 0, maxV = 0;
        for (let i = 0; i < 600 && !rd.settled; i++) {
          await steps(1);
          const now = lengths(); now.forEach((l, k) => { stretch = Math.max(stretch, Math.abs(l - len0[k])); });
          for (const e of Object.values(rd.parts)) { const t = e.body.translation(), v = e.body.linvel(); if (!Number.isFinite(t.x + t.y + t.z)) nan = true; maxY = Math.max(maxY, t.y); maxV = Math.max(maxV, Math.hypot(v.x, v.y, v.z)); }
        }
        // a knee bends by its own limits: the bind pose is zero, so the turn from thigh to shank is the bend
        const rot = e => { const q = e.body.rotation(); return new T.Quaternion(q.x, q.y, q.z, q.w); };
        out.knees = ['FL', 'FR', 'HL', 'HR'].map(k => +(2 * Math.acos(Math.min(1, Math.abs(rot(rd.parts['thigh' + k]).invert().multiply(rot(rd.parts['shank' + k])).w)))).toFixed(2));
        const y = n => +rd.parts[n].body.translation().y.toFixed(2), tp = n => rd.parts[n].body.translation();
        const span = (a, c) => +Math.hypot(tp(a).x - tp(c).x, tp(a).y - tp(c).y, tp(a).z - tp(c).z).toFixed(2);
        out.rest = { settled: rd.settled, stretch: +stretch.toFixed(4), nan, maxV: +maxV.toFixed(1), hips: y('hips'), chest: y('chest'), head: y('head'), paw: y('shankFL'), ground: +engine.surface(tp('hips').x, tp('hips').z).toFixed(2), hipsToChest: span('hips', 'chest'), chestToHead: span('chest', 'head') };
        rd.remove(); await steps(10);
        out.after = { ...base(), want: b0, owner: engine.control.of(P).owner, active: rd.active };
        const hold = engine.control.take(P, { owner: 'cross', layer: 'script', step: () => ({ x: 1, z: 0 }) });
        const x0 = P.position.x; await steps(30); hold.remove();
        out.walksAgain = +(P.position.x - x0).toFixed(2);

        // in the river: the parts float at the curve's water, away from a straight strip
        P.placeAt([bend, 0, zb]); P.root.position.y = 2; await steps(1);
        const rd2 = R.ragdoll(P);
        await steps(420);
        out.floats = { hips: +rd2.parts.hips.body.translation().y.toFixed(2), bed: +engine.surface(bend, zb).toFixed(2), level: game.LEVEL };
        rd2.remove(); P.placeAt([20, 0, 0]); await steps(20);

        // no ragdoll for this body: the rule says false
        const noRag = engine.mod('ragdoll.graph', { owner: 'rule', id: 'pup', layer: 'game', set: false });
        const pup = new game.Character(engine, { model: await engine.assets.model('animal'), id: 'pup' }); engine.add(pup.root); pup.placeAt([25, 0, 4]);
        out.pup = R.ragdoll(pup);
        noRag.remove();
        const rdp = R.ragdoll(pup); out.pupDown = rdp ? Object.keys(rdp.parts).length : null;   // the rule gone: the game's graph again
        pup.dispose?.(); engine.remove(pup.root); await steps(5);

        // a choice in a bubble: play goes on while it asks
        let ended = 0;
        engine.dialogue.define('elder', { start: { text: 'Cross?', choices: [{ text: 'Swim', next: 'wet', do: s => { s.flags.crossed = true; } }, { text: 'Wait', next: 'dry' }] }, wet: { text: 'Go on.' }, dry: { text: 'Then wait.' } });
        engine.dialogue.start('elder', 'start', () => { ended++; }, { channel: 'bubble', at: P.root });
        await steps(5);
        const asking = engine.dialogue.bubbles();
        out.ask = asking.map(b => ({ text: b.text, choices: b.choices, hasRun: Number.isInteger(b.run) }));
        out.described = (engine.describe().ui?.bubbles ?? []).length;
        const h2 = engine.control.take(P, { owner: 'play', layer: 'script', step: () => ({ x: 1, z: 0 }) }); const x1 = P.position.x; await steps(20); h2.remove();
        out.movedWhileAsked = +(P.position.x - x1).toFixed(2);
        await steps(600);
        out.stillAsking = engine.dialogue.bubbles().length;
        out.badIndex = await Promise.resolve(engine.ops.run('dialogue.choose', { index: 7, run: asking[0].run }, { source: 'player' })).then(v => JSON.stringify(v), e => e.code ?? e.message);
        out.choose = await Promise.resolve(engine.ops.run('dialogue.choose', { index: 0, run: asking[0].run }, { source: 'player' })).then(v => JSON.stringify(v), e => e.code ?? e.message);
        await steps(5);
        out.next = engine.dialogue.bubbles().map(b => b.text); out.flag = engine.vars.flags.crossed;
        await steps(400);
        out.endedAfter = { ended, left: engine.dialogue.bubbles().length };

        // the quests section belongs to who holds 'quests'
        engine.content.load({ name: 'stock', quests: { 'old-trail': { title: 'Trail', steps: [{ id: 'a', text: 'Walk', done: () => false }] } } });
        engine.quests.start('old-trail');
        out.stock = !!engine.quests.state('old-trail');
        const events = []; const off = engine.events.on('quest:done', d => events.push(d.id));
        engine.use(game.huntLog(), { replaces: 'quests' });
        await steps(5);
        out.replaced = { old: engine.quests.state('old-trail'), holder: Object.keys(engine.modules ? Object.fromEntries(engine.modules) : {}).includes('huntLog') };
        engine.content.load({ name: 'mine', quests: { stag: { prey: 'stag' } } });
        out.refused = err(() => engine.content.load({ name: 'bad', quests: { other: { title: 'Trail', steps: [] } } }));
        engine.quests.start('stag'); engine.quests.advance('stag'); await steps(5);
        out.hunt = { state: engine.quests.state('stag'), list: engine.quests.list(), other: engine.quests.state('other'), events };
        off?.remove?.();
        out.saved = await engine.saves.save('hunt');
        engine.quests.define('later', { prey: 'hare' });
        out.loaded = await engine.saves.load('hunt');
        out.afterLoad = { stag: engine.quests.state('stag'), later: engine.quests.state('later') };

        // leases: every count comes back
        const assets = () => JSON.stringify(engine.describe().assets ?? null);
        out.lease0 = assets();
        const lease = await engine.assets.lease('animal'), extra = await engine.assets.model('animal');
        engine.add(extra); extra.position.set(25, 3, 3); extra.updateMatrixWorld(true);
        out.lease1 = assets();
        const rd3 = R.ragdoll(extra, {}); out.bare = rd3 ? Object.keys(rd3.parts).length : null;
        await steps(30);
        engine.remove(extra); await steps(5);   // removed while limp: its ragdoll and its lease end with it
        out.lease2 = assets(); out.bareGone = { active: rd3.active, ...base() };
        engine.assets.release('animal');   // the player's copy and the lease still need it: it waits
        out.lease3 = assets(); out.stillDrawn = !!P.root.getObjectByProperty('isSkinnedMesh', true)?.geometry.attributes.position;
        lease.remove(); await steps(2);
        out.lease4 = assets();
        // the last lease frees what release was waiting on, and the name loads again
        const keep = await engine.assets.lease('stone'), copy = await engine.assets.model('stone'); engine.add(copy);
        const geo = copy.geometry; let freed = 0; geo.addEventListener('dispose', () => { freed++; });
        engine.assets.release('stone');
        out.lease5 = assets();
        engine.remove(copy); await steps(2);
        out.lease6 = { text: assets(), freed };
        keep.remove(); await steps(2);
        out.lease7 = { text: assets(), freed };
        const back = await engine.assets.model('stone'); engine.add(back); engine.remove(back); await steps(2);
        out.lease8 = assets();
        return out;
      });
      const J = k => JSON.stringify(r[k]);
      check('the river follows its curve and stops at the bounds', r.river.middle === game_LEVEL && r.river.bendIn === game_LEVEL && r.river.bendOut === -Infinity && r.river.high === -Infinity, J('river'));
      check('the animal walks in and swims', r.swim.swimming && r.swim.inWater && Math.abs(r.swim.at[0]) < 4, J('swim'));
      check('[guard] the ragdoll has the parts of the graph and one joint less', r.parts.length === 12 && r.parts.includes('tail') && r.parts.includes('shankHR') && r.during.joints === 11 && r.during.owner === 'ragdoll', J('during'));
      check('[guard] it settles on the ground, whole', r.rest.settled && !r.rest.nan && r.rest.stretch < 1e-3 && r.rest.hips > r.rest.ground && r.rest.hips < r.rest.ground + 1 && r.rest.paw >= r.rest.ground, J('rest'));
      check('its body keeps its length', Math.abs(r.rest.hipsToChest - 0.9) < 0.15 && Math.abs(r.rest.chestToHead - 0.56) < 0.15, J('rest'));
      check('the knees stay in the limits of the graph', r.knees.every(a => a <= 1.8), J('knees'));
      check('[guard] remove gives everything back, and it walks again', JSON.stringify({ bodies: r.after.bodies, colliders: r.after.colliders, rb: r.after.rb, joints: r.after.joints }) === JSON.stringify(r.after.want) && r.after.owner === 'player-input' && r.walksAgain > 1, J('after'));
      check('[guard] in the river it floats on the curve, off the bed', r.floats.hips > r.floats.bed + 0.8 && r.floats.hips < r.floats.level + 0.5, J('floats'));
      check('the rule says no ragdoll for one body, and gives its graph back after', r.pup === null && r.pupDown === 12, J('pupDown'));
      check('[guard] a bubble asks and holds until answered, and play goes on', r.ask.length === 1 && r.ask[0].choices.join() === 'Swim,Wait' && r.ask[0].hasRun && r.movedWhileAsked > 0.5 && r.stillAsking === 1 && r.described === 1, J('ask'));
      check('a wrong choice is refused by name, the right one runs the script on', /noChoice/.test(r.badIndex) && /"ok":true/.test(r.choose) && r.next.join() === 'Go on.' && r.flag === true && r.endedAfter.ended === 1 && r.endedAfter.left === 0, JSON.stringify([r.badIndex, r.choose, r.next, r.endedAfter]));
      check('[guard] the quests section belongs to the module that holds it: its format loads, the old one is refused by it', r.stock && r.replaced.holder && r.replaced.old === null && /name the prey/.test(r.refused) && r.hunt.other === null, J('refused'));
      check('the replacement keeps the quest contract', r.hunt.state.done === true && r.hunt.list.length === 1 && r.hunt.events.join() === 'stag', J('hunt'));
      check('its save round-trips', r.saved === true && r.loaded === true && r.afterLoad.stag?.done === true && r.afterLoad.later === null, JSON.stringify([r.saved, r.loaded, r.afterLoad]));
      check('a lease and a copy each count', r.lease1 === '{"leases":{"animal":3},"waiting":[]}' && r.bare === 12, J('lease1'));
      check('[guard] a copy removed while limp ends its ragdoll and its lease', r.lease2 === '{"leases":{"animal":2},"waiting":[]}' && !r.bareGone.active && r.bareGone.joints === 0, J('lease2'));
      check('release waits for the leases and the player keeps its model', /"waiting":\["animal"\]/.test(r.lease3) && r.stillDrawn, J('lease3'));
      check('[guard] lease counts are back at the baseline', JSON.parse(r.lease4).leases.animal === JSON.parse(r.lease0).leases.animal, J('lease4'));
      check('a copy going does not free what a lease holds', r.lease6.freed === 0 && /"stone":1/.test(r.lease6.text) && /"waiting":\[.*"stone"/.test(r.lease6.text), J('lease6'));
      check('[guard] the last lease frees it, and nothing stays in the count', r.lease7.freed === 1 && !/stone/.test(r.lease7.text), J('lease7'));
      check('the name loads again after, and leaves no count', !/stone/.test(r.lease8), J('lease8'));
    },
  },
];
