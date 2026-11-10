// Character control (core/ops/control.js): the "do not bypass" checks for "who decides where a character goes".
//   - a cutscene takes the player and gives it back: keys pause (no movement), the player-input owner is back after
//   - a walkTo paused by a cutscene resumes and still arrives (paused, not cancelled)
//   - two script owners on one character: control-conflict naming both; a direct move() on a held character: control-bypass
//   - an NPC's behaviour is the base holder and pauses under a script; describe().control shows who holds each character
//   - net holds remote characters for good: taking a peer's avatar on the host, or the host's avatar on a client, is control-net
//   - removing the cutscene module (replaces) hands its characters back
// Run in dev (the test bundle): npm test -- character
const PAGE = '/tests/threads/';

export const specs = [
  {
    name: 'character position: thing.set, world.set and world.move on a live character place it, the record stays in step, undo puts it back; a far NPC stays a record write',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, out = {};
        const E = mk(T.createEngine, 'ctl-place');
        E.use(T.world(), T.collision(), T.characters());
        await E.start(); E.haltLoop();
        const steps = n => { for (let i = 0; i < n; i++) E.step(1 / 60, { render: false, describe: false }); };
        const P = E.characters.addPlayer({ control: () => ({ x: 0, z: 0 }), spawn: { x: 0, z: 0 } });
        const npc = E.npcs.add({ id: 'pl-npc', name: 'Walker', position: { x: 4, z: 0 }, speed: 2, schedule: [{ at: 0, position: { x: 14, z: 0 } }] });
        steps(30);
        const both = id => { const c = id === 'player' ? P : npc.character, p = E.world.get(id).position; return { root: [c.root.position.x, c.root.position.z], rec: [p.x, p.z] }; };
        const args = { id: 'player', position: [6, 0, 2] }, res = E.ops.run('thing.set', args);
        out.thingSet = { ok: res.ok, now: both('player') }; steps(5); out.thingSetLater = both('player');
        E.ops.undo('thing.set', args, res.value); steps(2); out.undone = both('player');
        E.ops.allow(() => E.world.set('player', { position: [-3, 0, 1], mood: 'calm' })); out.worldSet = both('player'); steps(5); out.worldSetLater = both('player'); out.field = E.world.get('player').mood;
        const put = (id, at) => E.ops.allow(() => E.world.move(id, at));
        put('player', { x: 2, z: -2 }); out.worldMove = both('player'); steps(5); out.worldMoveLater = both('player');
        // the record following the character is no placement: the writes it makes itself change nothing
        P.root.position.x = 2.5; P.syncRecord(); out.follows = both('player');
        put('pl-npc', { x: 8, z: 5 }); out.npc = both('pl-npc'); out.npcPath = E.world.get('pl-npc').nav.path; steps(1); out.npcLater = both('pl-npc');
        try { put('player', { x: NaN, z: 0 }); } catch (x) { out.bad = x.code; }
        out.afterBad = both('player');
        // no model, no character: the record is all there is
        const far = E.npcs.add({ id: 'pl-far', name: 'Away', position: { x: 5000, z: 0 } }); steps(2);
        out.far = !far.character; put('pl-far', { x: 5005, z: 5 }); out.farRec = E.world.get('pl-far').position.x;
        E.dispose();
        return out;
      });
      const at = (v, x, z) => v.root[0] === x && v.root[1] === z && v.rec[0] === x && v.rec[1] === z;
      const near = (v, x, z) => Math.hypot(v.root[0] - x, v.root[1] - z) < 0.3 && v.root[0] === v.rec[0] && v.root[1] === v.rec[1];
      check('thing.set moves the player itself, and the record says the same', r.thingSet.ok && at(r.thingSet.now, 6, 2), JSON.stringify(r.thingSet));
      check('the place holds on the next steps', near(r.thingSetLater, 6, 2), JSON.stringify(r.thingSetLater));
      check('undo puts the character back', near(r.undone, 0, 0), JSON.stringify(r.undone));
      check('world.set with a position places it, its other fields still land', at(r.worldSet, -3, 1) && near(r.worldSetLater, -3, 1) && r.field === 'calm', JSON.stringify([r.worldSet, r.worldSetLater, r.field]));
      check('world.move places it', at(r.worldMove, 2, -2) && near(r.worldMoveLater, 2, -2), JSON.stringify([r.worldMove, r.worldMoveLater]));
      check('syncRecord after moving the root by hand still only follows', at(r.follows, 2.5, -2), JSON.stringify(r.follows));
      check('an NPC with a model is placed through its own placeAt: path dropped, model and record together', at(r.npc, 8, 5) && r.npcPath === null && near(r.npcLater, 8, 5), JSON.stringify([r.npc, r.npcPath, r.npcLater]));
      check('a bad position is refused before anything moves', !!r.bad && at(r.afterBad, 2.5, -2), JSON.stringify([r.bad, r.afterBad]));
      check('an NPC without a model is a plain record write', r.far && r.farRec === 5005, JSON.stringify([r.far, r.farRec]));
    },
  },
  {
    name: 'character control: cutscene takes the player and gives back; walkTo paused by a cutscene resumes; conflict / bypass errors; NPC behaviour pauses; describe',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, out = {};
        const err = f => { try { f(); return null; } catch (x) { return { code: x.code, msg: x.message }; } };
        const E = mk(T.createEngine, 'ctl-a');
        E.use(T.world(), T.collision(), T.characters(), T.timeline());
        await E.start(); E.haltLoop();
        const steps = n => { for (let i = 0; i < n; i++) E.step(1 / 60, { render: false, describe: false }); };
        const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };   // let a finished cutscene's promise chain run
        const P = E.characters.addPlayer({ control: () => ({ x: 1, z: 0 }), spawn: { x: 0, z: 0 } });
        out.base = E.control.of(P);
        steps(10);
        // cutscene: the keys (here a step that always walks +X) pause; the player stands
        let ended = false;
        E.timeline.play([{ wait: 0.5 }]).then(() => { ended = true; });
        steps(12);   // the body slows down from its walk (inertia), then stands: less than 0.1 m against 0.9 m walking (checked below)
        const x0 = P.position.x;
        steps(12);
        out.during = E.control.of(P); out.duringDx = P.position.x - x0;
        out.duringDescribe = E.describe().control.player;
        steps(15); await settle();
        out.ended = ended; out.after = E.control.of(P)?.owner;
        const x1 = P.position.x; steps(10); out.afterDx = P.position.x - x1;
        // walkTo (script) pauses the keys; a cutscene pauses the walk; the walk resumes and arrives
        P.placeAt({ x: 0, z: 0 }); steps(1);
        let walk = null;
        const w = P.walkTo({ x: 0, z: 6 }, { arrive: 0.6 }); w.then(s => { walk = s.status; });
        steps(20);
        out.walkOwner = E.control.of(P)?.owner;
        E.timeline.play([{ wait: 0.5 }]);
        steps(12); const z0 = P.position.z; steps(12);
        out.walkPaused = { of: E.control.of(P), dz: P.position.z - z0, status: walk };
        for (let i = 0; i < 400 && !walk; i++) { steps(1); await Promise.resolve(); }
        out.walk = walk; out.walkEnd = [P.position.x, P.position.z]; out.afterWalk = E.control.of(P)?.owner;
        // two script owners on one character; a direct move on a held character
        const a = E.control.take(P, { owner: 'quest-a', layer: 'script' });
        out.conflict = err(() => E.control.take(P, { owner: 'quest-b', layer: 'script' }));
        out.retake = err(() => E.control.take(P, { owner: 'quest-a', layer: 'script' }));   // same owner again: replaces its own hold
        a.remove();
        out.staleStillHolds = E.control.has(P, 'quest-a');   // the first handle went stale on the retake; its remove() ends nothing
        E.control.take(P, { owner: 'quest-a', layer: 'script' }).remove();
        out.bypass = err(() => P.move(1, 0, false, 1 / 60));
        out.badLayer = err(() => E.control.take(P, { owner: 'x', layer: 'player' }));
        // an NPC: its behaviour holds the base layer; a script on it pauses the schedule
        const npc = E.npcs.add({ id: 'ctl-npc', name: 'Walker', position: { x: 4, z: 0 }, speed: 2, schedule: [{ at: 0, position: { x: 14, z: 0 } }] });
        steps(30);
        out.npcBase = E.control.of(npc);
        const hold = E.control.take(npc, { owner: 'escort', layer: 'script', step: () => null });
        steps(20); const nx = npc.position.x; steps(30);
        out.npcHeld = { of: E.control.of(npc), dx: npc.position.x - nx };
        hold.remove(); const nx2 = npc.position.x; steps(30); out.npcResumed = npc.position.x - nx2;
        out.describe = Object.keys(E.describe().control);
        E.dispose();
        return out;
      });
      check('the player starts held by its input on layer base', r.base?.owner === 'player-input' && r.base.layer === 'base', JSON.stringify(r.base));
      check('[guard] a cutscene takes the player: owner timeline on layer cutscene, the input waits, the player does not walk', r.during?.owner === 'timeline' && r.during.layer === 'cutscene'
        && r.during.waiting[0]?.owner === 'player-input' && Math.abs(r.duringDx) < 0.1 && r.duringDescribe?.owner === 'timeline', JSON.stringify(r.during) + ' dx ' + r.duringDx);
      check('[guard] the cutscene ends and gives the player back: the input moves it again', r.ended && r.after === 'player-input' && r.afterDx > 0.05, JSON.stringify({ ended: r.ended, after: r.after, dx: r.afterDx }));
      check('[guard] walkTo holds the player on script; a cutscene pauses it (no progress, not cancelled); it resumes and arrives', r.walkOwner === 'walkTo' && r.walkPaused.of?.owner === 'timeline'
        && r.walkPaused.of.waiting.map(w => w.owner).join() === 'walkTo,player-input' && Math.abs(r.walkPaused.dz) < 0.1 && r.walkPaused.status === null
        && r.walk === 'arrived' && Math.hypot(r.walkEnd[0], r.walkEnd[1] - 6) < 1 && r.afterWalk === 'player-input', JSON.stringify({ wo: r.walkOwner, p: r.walkPaused, w: r.walk, end: r.walkEnd, after: r.afterWalk }));
      check('[guard] two script owners on one character: control-conflict naming both, with the fix; the same owner again is fine', r.conflict?.code === 'control-conflict'
        && /quest-a/.test(r.conflict.msg) && /quest-b/.test(r.conflict.msg) && /remove\(\)/.test(r.conflict.msg) && r.retake === null, JSON.stringify(r.conflict) + JSON.stringify(r.retake));
      check('a stale handle (its owner took again) ends nothing', r.staleStillHolds === true, String(r.staleStillHolds));
      check('[guard] move() on a held character from outside its owner: control-bypass; a bad layer: control-layer', r.bypass?.code === 'control-bypass' && /player-input/.test(r.bypass.msg)
        && r.badLayer?.code === 'control-layer', JSON.stringify([r.bypass, r.badLayer]));
      check('[guard] an NPC behaviour holds base; a script on the NPC pauses the schedule; it walks on after', r.npcBase?.owner === 'npcs' && r.npcHeld.of?.owner === 'escort'
        && Math.abs(r.npcHeld.dx) < 0.1 && r.npcResumed > 0.2, JSON.stringify({ b: r.npcBase, h: r.npcHeld, res: r.npcResumed }));
      check('describe().control lists every held character', r.describe.includes('player') && r.describe.includes('ctl-npc'), JSON.stringify(r.describe));
    },
  },
  {
    name: 'character control: net holds remote characters for good (control-net); removing the cutscene module gives its characters back',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, out = {};
        const err = f => { try { f(); return null; } catch (x) { return { code: x.code, msg: x.message }; } };
        // net: a host and one client on a manual wire
        const wire = T.fakeNetwork({ manual: true, latency: 20 });
        const H = mk(T.createEngine, 'ctl-host'), C = mk(T.createEngine, 'ctl-client');
        H.use(T.world(), T.characters(), T.net({ role: 'host', transport: wire.host() }));
        C.use(T.world(), T.characters(), T.net({ role: 'client', transport: wire.connect() }));
        await H.start(); await C.start(); H.haltLoop(); C.haltLoop();
        H.characters.addPlayer({ control: () => null, spawn: { x: 0, z: 0 } });
        C.characters.addPlayer({ control: () => null, spawn: { x: 2, z: 0 } });
        for (let t = 0; t < 600; t += 1000 / 60) { wire.advance(1000 / 60); for (const e of [H, C]) e.step(1 / 60, { render: false, describe: false }); }
        const guest = H.net.peers[0]?.actor;
        out.guest = guest; out.hostOf = guest && H.control.of(guest);
        out.hostTake = guest ? err(() => H.control.take(guest, { owner: 'cutscene-x', layer: 'cutscene' })) : 'no peer';
        out.clientOf = C.control.of('host');
        out.clientTake = err(() => C.control.take('host', { owner: 'quest', layer: 'script' }));
        out.ownFree = C.control.of('player')?.owner;
        H.dispose(); C.dispose();
        // removing the cutscene module hands back what it held
        const E = mk(T.createEngine, 'ctl-swap');
        E.use(T.world(), T.characters(), { ...T.timeline(), provides: ['cutscenes'] });
        await E.start(); E.haltLoop();
        const P = E.characters.addPlayer({ control: () => null, spawn: { x: 0, z: 0 } });
        E.timeline.play([{ wait: 30 }]);
        E.step(1 / 60, { render: false, describe: false });
        out.held = E.control.of(P)?.owner;
        E.use({ name: 'noCutscenes', type: 'rules', provides: ['cutscenes'] }, { replaces: 'cutscenes' });
        out.afterSwap = E.control.of(P)?.owner;
        E.dispose();
        return out;
      });
      check('[guard] host: a peer\'s avatar is held by net; taking it is control-net', r.hostOf?.owner === 'net' && r.hostOf.layer === 'net' && r.hostTake?.code === 'control-net', JSON.stringify([r.guest, r.hostOf, r.hostTake]));
      check('[guard] client: the host\'s avatar is held by net; a local script cannot take it; the own player is the client\'s', r.clientOf?.owner === 'net' && r.clientTake?.code === 'control-net'
        && r.ownFree === 'player-input', JSON.stringify([r.clientOf, r.clientTake, r.ownFree]));
      check('[guard] removing the cutscene module (replaces) gives the player back to its input', r.held === 'timeline' && r.afterSwap === 'player-input', JSON.stringify([r.held, r.afterSwap]));
    },
  },
  {
    // a bad actor threw after the player was taken: no run existed to give it back, so the keys stayed off for good
    name: '[guard] timeline.play refused for a bad actor hands back the ones it took; a bad path point leaves the character free to move in the next run',
    url: PAGE,
    expectErrors: /timeline step|position/,   // the deliberate bad point
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, out = {};
        const E = mk(T.createEngine, 'ctl-leak');
        E.use(T.world(), T.collision(), T.characters(), T.timeline());
        await E.start(); E.haltLoop();
        const P = E.characters.addPlayer({ control: () => ({ x: 0, z: 0 }), spawn: { x: 0, z: 0 } });
        const base = E.control.of(P)?.owner;
        out.refused = await E.timeline.play([{ wait: 1 }], { actors: [P, {}] }).then(() => null, x => x.code);
        out.same = E.control.of(P)?.owner === base; out.held = E.timeline._held.size; out.runs = E.timeline.runs.size;
        await E.timeline.play([{ path: { object: P, points: ['nope'], duration: 1 } }]);
        out.marked = E.timeline._pathing.size;
        E.dispose();
        return out;
      });
      check('the refusal is the coded error, and nothing stays held', r.refused === 'module-params' && r.same && r.held === 0 && r.runs === 0, JSON.stringify(r));
      check('a path step that threw leaves no mark on its character', r.marked === 0, JSON.stringify(r));
    },
  },
];
