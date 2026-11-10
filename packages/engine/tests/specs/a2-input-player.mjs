// Input and player (phase-1 wrap-up A2): input is snapshotted per fixed step, the player is a world record, near-field simulation runs in id order. Same format as s1-world-sim.mjs.
// Each spec is a guard that must not be bypassed: these behaviors must hold whenever input, characters or world simulation change.

export const specs = [
  {
    name: 'A2 input snapshot: repeated reads within one fixed step agree; just-pressed is not lost on a frame with 0 fixed steps and not repeated across several; same for just-released; frame reads the latest state (open world)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const inp = engine.input, fx = [], fr = [];
        inp.bind('a2k', ['KeyK']);
        const h1 = engine.onFixed(() => fx.push([inp.pressed('a2k'), inp.pressed('a2k'), inp.down('a2k'), inp.released('a2k')].map(Number).join('')));
        const h2 = engine.onFrame(() => fr.push(Number(inp.pressed('a2k'))));
        inp._keyDown('KeyK', 'keyboard');
        inp.endFrame();                                   // the frame ended without a fixed step: the fixed copy is kept
        const frameAfterEmpty = inp.pressed('a2k');       // the frame copy is already cleared
        engine.step(3 / 60, { frameEvery: 1 });           // just-pressed on step 1, held afterwards
        inp._keyUp('KeyK');
        engine.step(2 / 60, { frameEvery: 2 });           // just-released only on step 1
        inp._keyDown('KeyK', 'keyboard'); inp._keyUp('KeyK');   // press and release in the same frame (a tap)
        engine.step(4 / 60, { frameEvery: 4 });
        h1.remove(); h2.remove();
        return { fx: fx.join(' '), fr: fr.join(''), frameAfterEmpty };
      });
      check('fixed: just-pressed on step 1 (both reads agree), held afterwards; just-released on the first step after release; a tap counts once', r.fx === '1110 0010 0010 0001 0000 1101 0000 0000 0000', r.fx);
      check('frame: reads the latest state of this frame (cleared after an empty frame; computed per frame)', !r.frameAfterEmpty && r.fr === '00001', JSON.stringify(r));
    },
  },
  {
    name: 'A2 mouse button is an action: define binds Mouse0, pressed in fixed fires the same number of times regardless of frame rate (1 / 2 / 4 fixed steps per frame); touch taps and the right button do not trigger Mouse0',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const inp = engine.input, cv = engine.renderer.domElement, counts = [];
        inp.bind('a2atk', ['KeyJ', 'Mouse0']);
        const ptr = (type, button, pointerType = 'mouse') => cv.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType, button, clientX: 5, clientY: 5 }));
        for (const fe of [1, 2, 4]) {
          let n = 0;
          const h = engine.onFixed(() => { if (inp.pressed('a2atk')) n++; });
          const go = s => engine.step(s, { frameEvery: fe, render: false });
          ptr('pointerdown', 0); go(3 / 60); ptr('pointerup', 0);   // held for several steps: counts once
          go(2 / 60);
          ptr('pointerdown', 0); ptr('pointerup', 0); go(4 / 60);   // press and release in the same frame (a tap): also counts once
          ptr('pointerdown', 2); ptr('pointerup', 2); go(2 / 60);   // right button is not bound
          ptr('pointerdown', 0, 'touch'); ptr('pointerup', 0, 'touch'); go(2 / 60);   // a touch tap is not treated as a mouse button
          h.remove(); counts.push(n);
        }
        return { counts, stuck: inp.keys.has('Mouse0') };
      });
      check('mouse-button action fires twice at each of the three frame rates (a hold counts once, a tap counts once)', r.counts.join() === '2,2,2', JSON.stringify(r));
      check('Mouse0 does not stay stuck after release', !r.stuck);
    },
  },
  {
    name: 'A2 frame-rate independence: the same key sequence (walk, jump, run, tap) at 1 / 2 / 4 fixed steps per frame gives identical player position and record (open world)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const inp = engine.input, P = engine.player, W = engine.world;
        engine.step(0.5);
        engine.saves.save('a2-keys');
        const out = [];
        for (const fe of [1, 2, 4]) {
          engine.saves.load('a2-keys');
          const go = s => engine.step(s, { frameEvery: fe, render: false });
          inp._keyDown('KeyW', 'keyboard'); go(0.7);
          inp._keyDown('Space', 'keyboard'); go(0.3); inp._keyUp('Space');
          inp._keyDown('ShiftLeft', 'keyboard'); inp._keyDown('KeyD', 'keyboard'); go(0.9);
          inp._keyUp('KeyW'); inp._keyUp('ShiftLeft'); inp._keyUp('KeyD');
          inp._keyDown('Space', 'keyboard'); inp._keyUp('Space'); go(1);
          const p = P.position;
          out.push({ pos: [p.x, p.y, p.z].map(v => v.toFixed(6)).join(), rec: JSON.stringify(W.get('player')) });
        }
        return { out, moved: out[0].pos };
      });
      const same = k => r.out.every(o => o[k] === r.out[0][k]);
      check('player position matches', same('pos'), JSON.stringify(r.out.map(o => o.pos)));
      check('player record (position, facing, movement state) matches', same('rec'), JSON.stringify(r.out.map(o => o.rec)));
    },
  },
  {
    name: 'A2 player is a world record: position goes into saves, placeAt takes effect at once, load restores it, anchor reads it by default, removePlayer deletes the record (open world)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const W = engine.world, P = engine.player, rec = () => W.get('player'), xz = o => [o.x, o.z].map(v => +v.toFixed(3)).join();
        engine.step(0.2);
        const kind = rec()?.kind, synced = xz(rec().position) === xz(P.position);
        const p0 = P.position.clone();
        P.placeAt({ x: p0.x + 6, y: 999, z: p0.z - 4 });
        const placedRec = xz(rec().position) === xz(P.position);
        const bad = [[10, 20], { x: 5, y: 3 }, [NaN, 0, 1]].map(v => { try { P.placeAt(v); return 'no error'; } catch (e) { return /finite x and z/.test(e.message); } });
        engine.step(0.5);
        const stayed = Math.hypot(P.position.x - p0.x - 6, P.position.z - p0.z + 4) < 0.05;
        const anchor = xz(W._s.at) === xz(P.position);
        P.face({ x: P.position.x + 1, z: P.position.z });
        engine.step(1 / 60);
        const saved = { pos: xz(P.position), facing: P.facing };
        engine.saves.save('a2-player');
        const data = engine.saves.collect();
        P.placeAt({ x: p0.x - 10, z: p0.z + 10 }); P.face({ x: P.position.x, z: P.position.z - 1 });
        engine.step(0.2);
        engine.saves.load('a2-player');
        const back = { pos: xz(P.position), facing: P.facing, rec: xz(rec().position) };
        const camAway = engine.focus.clone(); engine.focus.set(camAway.x + 500, camAway.y, camAway.z);
        engine.step(1 / 60);
        const anchorNotCam = xz(W._s.at) === xz(P.position);
        engine.focus.copy(camAway);
        return { bad, kind, synced, placedRec, stayed, anchor, saved, back, anchorNotCam, oldKey: 'player' in data.parts };
      });
      check('a record of kind "player" exists and its position matches the player', r.kind === 'player' && r.synced, JSON.stringify(r));
      check('placeAt: record updates at once and the new position holds after a few steps (not pulled back)', r.placedRec && r.stayed, JSON.stringify(r));
      check('placeAt with a 2-element array / missing z / NaN throws with the fix instead of silently landing at z = 0', r.bad.every(b => b === true), JSON.stringify(r.bad));
      check('near/far center defaults to the player record (unchanged when the camera focus moves away)', r.anchor && r.anchorNotCam, JSON.stringify(r));
      check('save has no separate player key (the player lives only in the world record)', r.oldKey === false, JSON.stringify(r));
      check('load: player position and facing are restored from the record', r.back.pos === r.saved.pos && Math.abs(r.back.facing - r.saved.facing) < 1e-9 && r.back.rec === r.saved.pos, JSON.stringify(r));
    },
  },
  {
    name: 'A2 near-field order by id: when near records affect each other, running straight through and save-then-load are bit-identical (open world)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const W = engine.world, p = engine.player.position;
        // every near-field step reads and writes the same pool, so the result depends on simulation order
        W.add({ id: 'a2-pool', kind: 'a2pool', position: [p.x + 300, p.y, p.z], x: 1 });
        W.simulate('a2n', { radius: 25, near: (rec, dt) => { const pool = W.get('a2-pool'); pool.x = (pool.x * 1.37 + rec.i) % 9973; rec.v = (rec.v * 3 + pool.x) % 7919; } });
        // runtime records are added first, initial ones after: loading reverses this (initial data goes back in first), so the order inside a cell changes
        for (let i = 0; i < 6; i++) W.add({ id: `a2-r${5 - i}`, kind: 'a2n', position: [p.x + i, p.y, p.z + 2], i: i + 1, v: 0 });
        for (let i = 0; i < 6; i++) W.add({ id: `a2-b${i}`, kind: 'a2n', position: [p.x - i, p.y, p.z - 2], i: 10 + i, v: 0 }, { initial: true });
        engine.step(0.3);
        engine.saves.save('a2-near');
        const snap = () => JSON.stringify(W.query({ where: x => x.id.startsWith('a2-') }).sort((a, b) => a.id < b.id ? -1 : 1).map(x => [x.id, x.v, x.x]));
        engine.step(1, { render: false });
        const a = snap();
        engine.saves.load('a2-near');
        engine.step(1, { render: false });
        const b = snap();
        return { same: a === b, a: a.slice(0, 160), b: b.slice(0, 160) };
      });
      check('running straight through vs save-then-load: near-field results are bit-identical', r.same, JSON.stringify(r));
    },
  },
  {
    name: 'character create and replace: a refused addPlayer keeps the old player; a new one takes over the record, the control slot and the frame hook; the old one answers nothing; a record loaded first places the player (open world)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        const C = engine.characters, W = engine.world, old = engine.player, out = {}, step = s => engine.step(s, { describe: false });
        const code = f => { try { f(); return 'no error'; } catch (x) { return x.code; } };
        out.noControl = code(() => C.addPlayer({}));
        out.badControl = code(() => C.addPlayer({ control: 'manual' }));
        out.badKey = code(() => C.addPlayer({ control: 'camera', contrl: 1 }));
        out.keptOld = engine.player === old && !!old.root.parent;
        const x = old.position.x + 3, z = old.position.z;
        old.placeAt({ x, z });
        let oldLoads = 0, oldFrames = 0, steps = 0, frames = 0;
        old.loadMotion = () => { oldLoads++; }; old.animate = () => { oldFrames++; };
        const p = C.addPlayer({ control: (who, input, dt) => { steps++; out.args = who === engine.player && input === engine.input && dt > 0; return null; } });
        p.animate = () => { frames++; };
        out.swapped = engine.player === p && p !== old && !old.root.parent && !!p.root.parent;
        const open = C.findSpawn();
        out.respawned = Math.hypot(p.position.x - open.x, p.position.z - open.z) < 0.01;   // replacing removes the old record first: nothing to continue from
        out.owner = engine.control.of(p)?.owner; out.oldHolder = engine.control.of(old) ?? null;
        step(0.1);
        out.steps = steps; out.frames = frames; out.oldFrames = oldFrames;
        const q = C.addPlayer({ control: 'camera', spawn: { x: x + 3, z } });
        out.spawned = Math.hypot(q.position.x - x - 3, q.position.z - z) < 0.01 && Math.abs(W.get('player').position.x - q.position.x) < 0.01;
        const before = steps; step(0.1); out.replacedStepRan = steps !== before;
        await engine.saves.save('char-replace');
        q.placeAt({ x: x + 8, z }); step(0.05);
        await engine.saves.load('char-replace');
        out.loaded = Math.abs(q.position.x - x - 3) < 0.05; out.oldLoads = oldLoads;
        C.removePlayer();
        await engine.saves.load('char-replace');
        const late = C.addPlayer({ control: 'camera' });
        out.continued = Math.abs(late.position.x - x - 3) < 0.05 && Math.abs(late.position.z - z) < 0.05;
        return out;
      });
      const J = JSON.stringify(r);
      check('no control, a bad control and a misspelt key are refused by name', r.noControl === 'player-control' && r.badControl === 'player-control' && r.badKey !== 'no error', J);
      check('a refused addPlayer leaves the old player in place', r.keptOld, J);
      check('replacing: engine.player is the new one, the old model left the scene', r.swapped, J);
      check('replacing without spawn looks for a spawn; with spawn it stands there and the record follows', r.respawned && r.spawned, J);
      check('a record loaded before the player is created places it', r.continued, J);
      check('the new player holds the control slot as player-input, the old one holds nothing', r.owner === 'player-input' && r.oldHolder === null, J);
      check('the control function runs per step with (player, input, dt); the frame hook animates the new player only', r.steps > 0 && r.args === true && r.frames > 0 && r.oldFrames === 0, J);
      check('a replaced control function stops', r.replacedStepRan === false, J);
      check('a load places the current player and never the replaced one', r.loaded && r.oldLoads === 0, J);
    },
  },
  {
    name: 'character dispose: removePlayer drops the model, record, control and hooks, twice is safe; a save without a player record gets one from the player on load (open world)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        const C = engine.characters, W = engine.world, p = engine.player, out = {}, step = s => engine.step(s, { describe: false });
        let frames = 0; p.animate = () => { frames++; };
        C.removePlayer();
        out.gone = engine.player === null && !W.get('player') && !p.root.parent && p.recordId === null;
        out.holder = engine.control.of(p) ?? null;
        C.removePlayer();
        step(0.1);
        out.frames = frames; out.describe = engine.describe().player ?? null;
        await engine.saves.save('char-none');
        await engine.saves.load('char-none');
        out.noRecordYet = !W.get('player');
        const q = C.addPlayer({ control: 'camera', spawn: { x: 4, z: 4 } });
        out.fresh = W.get('player')?.kind === 'player';
        await engine.saves.load('char-none');
        const rec = W.get('player');
        out.rebuilt = !!rec && Math.abs(rec.position.x - q.position.x) < 0.01 && Math.abs(rec.position.z - q.position.z) < 0.01;
        return out;
      });
      const J = JSON.stringify(r);
      check('removePlayer: engine.player null, record gone, model out of the scene', r.gone, J);
      check('nothing holds the removed player and its frame hook stopped', r.holder === null && r.frames === 0, J);
      check('a second removePlayer and later steps are safe; describe reports no player', r.describe === null, J);
      check('a removed player is not brought back by a load', r.noRecordYet, J);
      check('addPlayer after removePlayer makes a new record', r.fresh, J);
      check('a save from before the player: the record is rebuilt from the player', r.rebuilt, J);
    },
  },
  {
    name: 'character input: an autopilot speed is one move.speed entry, taken once and released with it; the player alone sounds its steps and hard landings (open world)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const p = engine.player, out = {}, step = s => engine.step(s, { render: false, describe: false }), stack = engine.stacks.get('move.speed');
        const mod = engine.mod; let takes = 0;
        engine.mod = (name, o) => { if (name === 'move.speed' && o.owner === 'autopilot') takes++; return mod.call(engine, name, o); };
        engine.input.autopilot = { x: 0, y: 1, speed: 3 };
        step(0.2);
        out.held = stack.has('autopilot', 'player'); out.takes = takes;
        engine.input.autopilot = { x: 0, y: 1, speed: 5 };
        step(0.2);
        out.takesAfterChange = takes;
        engine.input.autopilot = null;
        step(0.05);
        out.released = !stack.has('autopilot', 'player');
        engine.mod = mod;
        const sfx = engine.audio.sfx, heard = [];
        engine.audio.sfx = (name, o) => { heard.push(o?.volume ?? null); };
        const other = new p.constructor(engine, {});
        engine.events.emit('character:step', { character: other });
        engine.events.emit('character:land', { character: other, impact: 9 });
        out.otherHeard = heard.length;
        engine.events.emit('character:step', { character: p });
        engine.events.emit('character:land', { character: p, impact: 2 });
        engine.events.emit('character:land', { character: p, impact: 6 });
        engine.events.emit('character:land', { character: p, impact: 60 });
        out.heard = heard;
        engine.audio.sfx = sfx; other.dispose();
        return out;
      });
      const J = JSON.stringify(r);
      check('one take while the speed stays, one more when it changes', r.held && r.takes === 1 && r.takesAfterChange === 2, J);
      check('the entry leaves with the autopilot', r.released, J);
      check('another character makes no player sound', r.otherHeard === 0, J);
      check('a step sounds, a soft landing does not, a hard one scales with the impact up to 2', JSON.stringify(r.heard) === '[null,1,2]', J);
    },
  },
];
