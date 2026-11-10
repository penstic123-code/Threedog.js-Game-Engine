// Mover API (docs/plans/done/2026-11-02-gameplay-architecture.md §4, §7 steps 4-6), on a real Character with the simple mover and a minimal engine:
//   - move stats through engine.mod only: stamina set + haste x1.2 + mud x0.6 give the same speed in all 6 end orders; player.speed written mid-way
//     takes effect at once with the modifiers still on; a character on a time channel moves at that channel's speed
//   - jumps through the public API only: double jump, coyote time, jump buffer, jump({ air: false }), addJumps, launch, jumpState
//   - moving platform: the rider stays within 1 cm of its spot whether the platform moves before the player, after it, or in a frame (timeline)
//   - falling below belowY: character:fall once, back on safe ground
// The "no way around it" check: move() takes exactly (x, z, run, dt), so speed only changes through engine.mod('move.speed'), and the jump state
// lives in the mover (no _coyote / _jumpBuffer field on the character to poke).
import { fakeSaves } from './fixtures/fake-saves.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINE } from '../paths.mjs';

const imp = f => import(pathToFileURL(join(ENGINE, f)).href);
const THREE = await import('three');
const { Stacks } = await imp('core/ops/stacks.js');
const { Time, STEP } = await imp('core/time/time.js');
const { defineHoldStacks, holdMethods } = await imp('core/ops/holds.js');
const { Character } = await imp('modules/characters/Character.js');
const { addSupport, carryRiders } = await imp('modules/characters/movers/support.js');
const { WORLD_MIGRATE } = await imp('modules/world/persist.js');
const { baseWrites } = await import('../rules/R41-move-base-values.mjs');

export const name = 'movers: move.* stats via engine.mod, jump API, moving platforms, fall to safe ground';

/** Flat ground at y = 0 (or ground(x, z)), no water, the real stacks and time channels */
function fake({ ground = () => 0 } = {}) {
  const events = [], on = {};
  const e = Object.defineProperties({ elapsed: 0, disposed: false, halted: false, _loop() { e.loops = (e.loops ?? 0) + 1; }, page: { _sync() {} }, style: {},
    movement: { radius: 0.3, stepHeight: 0.4, slopeRatio: 1 }, saves: fakeSaves(), ops: { allow: f => f() }, _poses: { add: () => ({ remove() {} }) }, clock: { rate: 1, _advance() {} }, world: { set() {}, recs: {}, get(id) { return this.recs[id] ??= {}; }, move() {} },
    surface: (x, z) => ground(x, z), waterAt: () => -Infinity, slope: () => 0, groundType: () => 'grass',
    events: { emit: (n, d) => { events.push([n, d]); for (const f of on[n] ?? []) f(d); }, on: (n, f) => { (on[n] ??= []).push(f); return { remove() {} }; } },
  }, Object.getOwnPropertyDescriptors(holdMethods));
  e.stacks = new Stacks(e); e.mod = (n, o) => e.stacks.mod(n, o);
  e.time = new Time(e); defineHoldStacks(e);
  return Object.assign(e, { list: events, on: (n, f) => (on[n] ??= []).push(f) });
}
const rig = () => ({ root: new THREE.Group() });
const make = (e, o = {}) => { const c = new Character(e, { rig: rig(), ...o }); c.recordId = o.id ?? 'p1'; c.placeAt({ x: 0, z: 0 }); return c; };
const step = (e, c, x = 0, z = 0, n = 1) => { for (let i = 0; i < n; i++) { c.move(x, z, false, STEP); (e.time._beginStep(), e.time._endStep()); } };
const perms = a => a.length < 2 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p]));
const code = f => { try { f(); return 'no throw'; } catch (x) { return x.code; } };

export async function run({ check }) {
  // ---- step 0: engine.mod('halt') is engine.haltLoop()
  {
    const e = fake();
    const h = e.mod('halt', { owner: 'menu' });
    check('mod(halt) stops the loop like engine.haltLoop()', e.halted === true);
    const loops = e.loops ?? 0; h.remove();
    check('... and its remove() resumes and restarts the loop', e.halted === false && e.loops === loops + 1);
    e.haltLoop('a'); e.mod('halt', { owner: 'b' }); e._unhalt('a');
    check('halt(a) + mod(halt, b), end a: still halted by b', e.halted === true);
    e.stacks.get('halt').release('b');
    check('release(b): running', e.halted === false);
  }
  // ---- step 4: stats
  {
    const e = fake(), c = make(e, { speed: 4, runSpeed: 8 });
    const want = 4 * 1.2 * 0.6;   // stamina sets runSpeed to the walk speed (4), haste x1.2, mud x0.6 (mud on everyone: no id)
    let ok = true, bad = '';
    for (const order of perms(['stamina', 'haste', 'mud'])) {
      const hs = {
        stamina: e.mod('move.runSpeed', { owner: 'stamina', id: c.id, set: c.speed }),
        haste: e.mod('move.runSpeed', { owner: 'haste', id: c.id, mul: 1.2 }),
        mud: e.mod('move.runSpeed', { owner: 'mud', mul: 0.6 }),
      };
      if (Math.abs(c.stat('runSpeed') - want) > 1e-9) { ok = false; bad = `all on: ${c.stat('runSpeed')}`; }
      const on = new Set(Object.keys(hs));
      for (const k of order) {
        hs[k].remove(); on.delete(k);
        const v = (on.has('stamina') ? 4 : 8) * (on.has('haste') ? 1.2 : 1) * (on.has('mud') ? 0.6 : 1);
        if (Math.abs(c.stat('runSpeed') - v) > 1e-9) { ok = false; bad = `${order} after ${k}: ${c.stat('runSpeed')} != ${v}`; }
      }
    }
    check('stamina set + haste x1.2 + mud x0.6: right value after every end in all 6 orders', ok, bad);
    e.mod('move.speed', { owner: 'haste', id: c.id, mul: 1.5 });
    c.speed = 2;   // the game writes the base: always allowed
    check('the game writes player.speed mid-way: takes effect at once, the modifier still on (2 x 1.5)', c.stat('speed') === 3);
    step(e, c, 1, 0, 120);
    check('the mover walks at the modded speed (velocity ~ 3 m/s)', Math.abs(c.velocity.x - 3) < 0.01, String(c.velocity.x));
    const other = make(e, { id: 'p2', speed: 2 });
    check('an entry with id is only that character\'s', other.stat('speed') === 2);
    // guard: one id form. A character without a world record takes the id option; character.id is what engine.mod's { id } matches
    const free = new Character(e, { rig: rig(), id: 'knight-1', speed: 2 }); e.mod('move.speed', { owner: 'slow', id: 'knight-1', mul: 0.5 });
    check('[guard] new Character({ id }) -> character.id, and engine.mod({ id }) reaches it', free.id === 'knight-1' && free.stat('speed') === 1, `${free.id} ${free.stat('speed')}`);
    e.mod('move.canJump', { owner: 'stun', id: c.id, set: 0 });
    c.jump(); step(e, c);
    check('move.canJump set 0 (stun): jump() does nothing', c.grounded && c.vy === 0);
    e.stacks.get('move.canJump').release('stun', { id: c.id });
    check('move() takes 4 arguments: no per-call speed (the move.speed stack is the one way)', c.move.length === 4);
    check('no private jump fields on the character (jumpState() reads, jump() / launch() change)', !('_coyote' in c) && !('_jumpBuffer' in c));
    // time channel: a character on 'enemies' at 0.5 walks half as far when the engine gives it its channel dt
    e.time.channel('enemies');
    const en = make(e, { id: 'en', speed: 4, channel: 'enemies' }), x0 = en.position.x;
    e.mod('time.enemies', { owner: 'bullet-time', mul: 0.5 });
    for (let i = 0; i < 120; i++) { en.move(1, 0, false, e.time.dt(en.channel, en.id)); (e.time._beginStep(), e.time._endStep()); }
    check('bullet time on the character\'s channel: it covers about half the distance (2 s x 4 m/s x 0.5 ~ 4 m)', Math.abs(en.position.x - x0 - 4) < 0.4, String(en.position.x - x0));
  }
  // ---- step 5: jumps (public API only)
  {
    const e = fake(), c = make(e, { maxJumps: 2, jumpSpeed: 8, airJumpSpeed: 6, coyoteTime: 0.1, jumpBuffer: 0.15 });
    c.jump(); step(e, c);
    check('ground jump: vy = jumpSpeed (8) then gravity', !c.grounded && c.jumpState().jumpsUsed === 1, JSON.stringify(c.jumpState()));
    step(e, c, 0, 0, 10);
    c.jump(); step(e, c);
    const js = c.jumpState();
    check('double jump: air jump at airJumpSpeed, jumpsLeft 0', js.jumpsUsed === 2 && js.jumpsLeft === 0 && js.vy < 6 && js.vy > 5, JSON.stringify(js));
    const jumps = e.list.filter(([n]) => n === 'character:jump').map(([, d]) => d);
    check('character:jump says air and index', jumps.length === 2 && jumps[0].air === false && jumps[1].air === true && jumps[1].index === 2);
    c.jump(); step(e, c);
    check('a third jump with maxJumps 2: nothing', c.jumpState().jumpsUsed === 2 && e.list.filter(([n]) => n === 'character:jump').length === 2);
    c.addJumps(1); c.jump(); step(e, c);
    check('addJumps(1) gives one air jump back', e.list.filter(([n]) => n === 'character:jump').length === 3);
    for (let i = 0; i < 200 && !c.grounded; i++) step(e, c);
    check('landing refills the jumps', c.grounded && c.jumpState().jumpsUsed === 0);
    // buffer: pressed 0.1 s before landing still jumps on landing
    c.jump(); step(e, c);
    let n = 0; while (c.vy > -1 || c.position.y > 0.3) { step(e, c); if (++n > 400) break; }
    c.jump({ air: false });   // ground only: must not be spent as an air jump now
    const before = e.list.filter(([x]) => x === 'character:jump').length;
    for (let i = 0; i < 9 && !(e.list.filter(([x]) => x === 'character:jump').length > before); i++) step(e, c);
    const buffered = e.list.filter(([x]) => x === 'character:jump').slice(before).map(([, d]) => d);
    check('jump({ air: false }) pressed just before landing: buffered, jumps on landing (a ground jump)', buffered.length === 1 && buffered[0].air === false, JSON.stringify(buffered.map(b => b.air)));
    for (let i = 0; i < 200 && !c.grounded; i++) step(e, c);
    // coyote: walk off a ledge, jump within coyoteTime -> ground jump
    const e2 = fake({ ground: x => x < 1 ? 0 : -5 }), d = make(e2, { coyoteTime: 0.1, maxJumps: 1 });
    let t = 0; while (d.grounded && t < 300) { step(e2, d, 1, 0); t++; }
    step(e2, d, 1, 0, 3);
    check('walked off: coyote time left', !d.grounded && d.jumpState().coyoteLeft > 0, JSON.stringify(d.jumpState()));
    d.jump(); step(e2, d, 1, 0);
    check('jump in coyote time: a ground jump', e2.list.some(([x, v]) => x === 'character:jump' && v.air === false));
    const e3 = fake({ ground: x => x < 1 ? 0 : -50 }), f = make(e3, { coyoteTime: 0.1, maxJumps: 1 });
    t = 0; while (f.grounded && t < 300) { step(e3, f, 1, 0); t++; }
    step(e3, f, 1, 0, 12); f.jump(); step(e3, f, 1, 0);
    check('after coyote time with maxJumps 1: no jump', !e3.list.some(([x]) => x === 'character:jump') && f.jumpState().jumpsLeft === 0);
    f.resetJumps(); f.launch(12, { owner: 'pad' });
    check('launch: vy set, character:launch with owner, ground jump spent', f.vy === 12 && e3.list.some(([x, v]) => x === 'character:launch' && v.owner === 'pad') && f.jumpState().jumpsUsed === 1);
    // the motion save keeps jump state nested (format 2)
    const m = c.saveMotion({});
    check('saveMotion: jump { coyote, used }, safe spot, no flat coyote', m.jump && 'used' in m.jump && !('coyote' in m) && Array.isArray(m.safe));
    // an old save (world part version 3): the flat coyote moves into jump, on the player record and in an NPC's motion, whole and changed
    const old = { records: { player: { vx: 0, coyote: 0.05 }, 'npc#1': { motion: { coyote: 0.02, vx: 1 } } }, changed: { guard: { set: { motion: { coyote: 0 } } } } };
    const up = WORLD_MIGRATE[3](old);
    check('world migrate 3: coyote -> jump { coyote, used: 0 } everywhere a motion is saved', up.records.player.jump.coyote === 0.05 && !('coyote' in up.records.player)
      && up.records['npc#1'].motion.jump.coyote === 0.02 && up.changed.guard.set.motion.jump.used === 0, JSON.stringify(up));
    // world part version 4 -> 5: talk fields became interact, also in a changed entry's removed keys (a content NPC that stopped talking)
    const v4 = { records: {}, changed: { mute: { del: ['talk', 'talkLabel', 'talkRadius'] }, relabel: { set: { talkLabel: 'Hi' }, del: ['talkRadius'] } } };
    const v5 = WORLD_MIGRATE[4](v4);
    check('world migrate 4: changed.del talk -> interact; label / radius alone leave no stray old key',
      JSON.stringify(v5.changed.mute.del) === '["interact"]' && JSON.stringify(v5.changed.relabel) === '{"set":{},"del":[]}', JSON.stringify(v5));
  }
  // ---- step 6: moving platform carry, in three orders
  for (const where of ['before', 'after', 'frame']) {
    const e = fake({ ground: () => -100 });
    const plat = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 4));
    plat.position.set(0, -0.5, 0);   // top at y = 0
    addSupport(e, plat, { id: 'lift' });
    const c = make(e, { id: 'rider' });
    c.root.position.set(0.5, 0, 0.5);
    const at = t => { plat.position.set(Math.sin(t) * 3, -0.5 + Math.sin(t * 0.7) * 1.5, Math.cos(t * 0.5) * 2); plat.rotation.y = t * 0.3; };
    step(e, c);   // stand on it
    plat.updateWorldMatrix(true, false);
    const local0 = plat.worldToLocal(c.position.clone());
    let worst = 0;
    for (let i = 1; i <= 600; i++) {
      const t = i * STEP;
      if (where === 'before') at(t);
      c.move(0, 0, false, STEP);
      if (where === 'after') at(t);
      carryRiders(e, false);   // the characters module's fixed hook
      (e.time._beginStep(), e.time._endStep());
      if (where === 'frame') at(t);
      carryRiders(e, true);    // the characters module's frame hook (a timeline moves things in frame)
      plat.updateWorldMatrix(true, false);
      worst = Math.max(worst, plat.worldToLocal(c.position.clone()).distanceTo(local0));
    }
    check(`platform moves ${where} the player: rider within 1 cm of its spot over 600 steps`, worst < 0.01 && c.support.kind === 'platform', `worst ${worst.toFixed(4)} m, kind ${c.support.kind}`);
  }
  // ---- what a support needs. The boat over a sea floor at -3: placeAt stands on the deck, a dock walks onto it, and it carries the rider.
  // Registering the whole group puts the top at the mast head, so the character passes under it: the shape the docs tell games to avoid
  {
    const boatAt = () => {
      const boat = new THREE.Group(), deck = new THREE.Mesh(new THREE.BoxGeometry(3, 0.2, 2)), mast = new THREE.Mesh(new THREE.BoxGeometry(0.2, 5, 0.2));
      deck.position.y = 0.5; mast.position.y = 3; boat.add(deck, mast); boat.position.x = 3.5;
      return { boat, deck };
    };
    const sea = x => x < 2 ? 0.5 : -3;
    {
      const e = fake({ ground: sea }), { boat, deck } = boatAt(); addSupport(e, deck, { id: 'deck' });
      const c = make(e);
      c.placeAt({ x: 3.5, z: 0 });
      check('placeAt over a support stands on it, not on the sea floor below', Math.abs(c.position.y - 0.6) < 1e-6, `y ${c.position.y}`);
      step(e, c, 0, 0, 3);
      check('placed on a support: it rides from the next step', c.support.kind === 'platform' && c.support.id === 'deck', c.support.kind);
      boat.position.x += 2; step(e, c, 0, 0, 2);
      check('moving the parent group carries the rider of its deck mesh', Math.abs(c.position.x - 5.5) < 1e-6, `x ${c.position.x}`);
    }
    {
      const walkOn = what => {
        const e = fake({ ground: sea }), b = boatAt(); addSupport(e, b[what], { id: what });
        const c = make(e); c.placeAt({ x: 1, z: 0 });
        for (let i = 0; i < 120 && c.position.x < 3; i++) step(e, c, 1, 0);
        step(e, c, 0, 0, 120);
        return c;
      };
      const onDeck = walkOn('deck'), onGroup = walkOn('boat');
      check('from a dock: the deck mesh is walked onto', onDeck.support.kind === 'platform' && Math.abs(onDeck.position.y - 0.6) < 1e-6, `${onDeck.support.kind} y ${onDeck.position.y}`);
      check('from a dock: the whole group is passed under (its top is the mast head), down to the sea floor', onGroup.support.kind !== 'platform' && onGroup.position.y < -2.9, `${onGroup.support.kind} y ${onGroup.position.y}`);
    }
  }
  // ---- a ladder: the manual mover has no gravity and still runs the states hook, so the climb clip plays
  {
    const e = fake(), c = make(e, { states: () => 'climb' });
    c.mover = 'manual'; c.root.position.y = 2; step(e, c, 0, 0, 30);
    check('mover manual: the position stays where the game put it and states picks the state', c.position.y === 2 && c.state === 'climb', `y ${c.position.y} state ${c.state}`);
  }
  // ---- fall: below belowY back to safe ground, character:fall once
  {
    const e = fake({ ground: x => x < 2 ? 0 : -1000 }), c = make(e, { fall: { belowY: -20 } });
    e.mod('fall', { owner: 'game', set: 'rescue' });   // the game's choice: the engine alone rescues nothing
    step(e, c, 0, 0, 5);
    const safe = c.safeGround.clone();
    let t = 0; while (c.grounded && t < 300) { step(e, c, 1, 0); t++; }
    for (let i = 0; i < 300 && !e.list.some(([n]) => n === 'character:fall'); i++) step(e, c, 1, 0);
    const falls = e.list.filter(([n]) => n === 'character:fall');
    check('fell below belowY: character:fall once', falls.length === 1, String(falls.length));
    check('... back on the last safe ground, standing', c.position.y > -1 && c.grounded && c.position.x < 2, JSON.stringify(c.position));
    check('... the safe spot is where it last stood still (before walking off)', c.safeGround.distanceTo(safe) < 2.5);
    e.mod('fall', { owner: 'game', id: c.id, set: false });
    let n2 = 0; while (n2++ < 400 && e.list.filter(([n]) => n === 'character:fall').length < 2) step(e, c, 1, 0);
    step(e, c, 1, 0, 30);
    check('rule fall false: stays where it fell (the game handles it), told once', c.position.y < -20 && e.list.filter(([n]) => n === 'character:fall').length === 2);
  }
  { // mover switched at runtime: 'manual' stops the integration (the game writes the position), 'simple' takes it back with the same instance
    const e = fake(), c = make(e), simple = c.mover;
    step(e, c, 1, 0, 30);
    c.mover = 'manual';
    const x = c.position.x; step(e, c, 1, 0, 30);
    check("mover = 'manual' at runtime: move() no longer walks, the name shows it", c.mover.name === 'manual' && Math.abs(c.position.x - x) < 1e-9,
      `${c.mover.name} dx ${c.position.x - x}`);
    c.position.x += 2; step(e, c, 0, 0);
    check('... the game moves it; grounded still kept up', Math.abs(c.position.x - x - 2) < 1e-9 && c.grounded);
    c.mover = 'simple'; step(e, c, 1, 0, 30);
    check("mover = 'simple' again: the same mover object walks on", c.mover === simple && c.position.x > x + 2.5, String(c.position.x - x));
  }
  { // character.state: the mover recomputes it every step, so a direct write would vanish silently: it warns once with playAction / mover 'manual'
    const e = fake(), c = make(e), warns = [], w = console.warn;
    console.warn = m => warns.push(String(m));
    try {
      step(e, c, 1, 0, 10); const quiet = warns.length;
      c.enter({ driver: null, seatPosition: () => new THREE.Vector3(), exitPosition: () => ({ x: 0, z: 0 }), speed: 0, drive() {}, object: c.root });
      c.exit(); step(e, c, 0, 0, 3); const vehicle = warns.length;
      c.state = 'attack'; step(e, c, 0, 0); c.state = 'attack'; step(e, c, 0, 0);
      const mine = warns.filter(m => m.includes('character.state was written directly'));
      check("character.state = x under an engine mover: warned once naming playAction(name) and mover 'manual'; the engine's own writes (moving, vehicle) say nothing",
        quiet === 0 && vehicle === 0 && mine.length === 1 && mine[0].includes('character.playAction(name)') && mine[0].includes("mover = 'manual'") && c.state === 'idle', warns.join(' | '));
    } finally { console.warn = w; }
  }
  { // R41: engine modules write move stats only through engine.mod (the base fields are the game's)
    const hit = l => baseWrites(l).length;
    check('R41 flags a module writing a base stat (=, *=, e.player / c)', hit('e.player.runSpeed = walk;') && hit('  c.speed *= 0.6;') && hit('npc.jumpSpeed=4'));
    check('R41 leaves this.<field>, comparisons, comments and strings alone', !hit('this.gravity = gravity;') && !hit('if (c.speed === 3) go();')
      && !hit('// player.speed = 6 is fine') && !hit("warn('player.speed = 6');") && !hit(' * the base is the plain field (player.speed = 6)'));
  }
}
