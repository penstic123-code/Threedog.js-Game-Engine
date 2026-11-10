// @ts-check
// Action example: one room, one player, one slime, one drop. Shows how an action game wires the engine's systems; the combat rules are this file's own.
// main.js holds rules only: modules, ops (attack, damage, enemy attack, death), fixed-step logic, presentation. The room, the slime and its stats are
// content (content/templates.js + props.js, rule R33). The engine has no health, damage or death: all of that is below, as plain game state and ops.
import { createEngine, openWorld, followCamera, presets, interactions, inventory, pickups, content, hud, toast } from '../../index.js';
import { createPicture } from './picture/index.js';   // the whole picture, plain three.js; ?picture=none runs the same rules under the engine's placeholder lights
import data from './content/index.js';
import packs from './assets.js';

const url = new URLSearchParams(location.search);
// Tuning of the rules (the slime's own numbers are instance state in content/templates.js)
const TUNE = Object.freeze({
  hp: 5, damage: 1, reach: 1.8, arc: 0.5, attackCooldown: 0.45,   // arc = cos of the half-angle in front of the player that a swing hits (60°)
  aggro: 6, enemySpeed: 1.6, enemyReach: 1.3, enemyCooldown: 1.2,
  spawn: Object.freeze({ x: 0, z: -4 }),
  // What happens when the player dies: 'respawn' (back to the spawn, full hp, the room as it is), 'restart' (the room as at the start:
  // session.newGame), 'gameover' (everything stops until R, then newGame). Pick one here or with ?death=...
  onDeath: url.get('death') ?? 'respawn',
});

const withPicture = url.get('picture') !== 'none';
const engine = createEngine({ bindings: { ...presets.bindings.walk, ...presets.bindings.interact, ...presets.bindings.inventory, ...presets.bindings.debug }, canvas: /** @type {HTMLCanvasElement} */ (document.getElementById('view')), lights: !withPicture, ui: { loading: { title: 'action' } }, saveKey: 'threedog-action' });
// A room needs no terrain, plants, weather, water or physics; a fixed time of day; an over-the-shoulder camera that locks the mouse on click,
// starting behind the player looking along +Z into the room (yaw = which side of the player the camera sits on: PI = the -Z side)
engine.use(openWorld({ camera: followCamera({ ...presets.camera.overShoulder, yaw: Math.PI }), terrain: false, vegetation: false, weather: false, water: false, rigid: false, ambience: false,
  calendar: { ...presets.calendar.fixedTime, time: 0.42 }, characters: { npcs: false } }),
  interactions({ ...presets.interactions.nearest }), inventory(), pickups(), content(), hud());
const picture = withPicture ? createPicture(engine) : null;

engine.assets.manifest(packs);   // assets.js: floor / wall / pillar / enemy (content/templates.js) and the blip synth (content/audio.js)
engine.characters.addPlayer({ ...presets.player.aim, spawn: TUNE.spawn });   // no body asset: the engine's gray capsule; face where the camera looks: a swing goes where you aim
engine.content.load(data, { places: { room: { x: 0, z: 0 } } });

// ---------- Game state: plain values, described and saved (one player, so it is not keyed by actor) ----------
/** @returns {{ hp: number, cooldown: number, over: boolean, deaths: number }} */
const fresh = () => ({ hp: TUNE.hp, cooldown: 0, over: false, deaths: 0 });
const game = fresh();
const slimes = () => engine.world.query({ kind: 'slime' }).map(r => ({ id: r.id, hp: r.hp, x: +r.position.x.toFixed(2), z: +r.position.z.toFixed(2) }));
engine.describe.add('action', () => ({ ...game, maxHp: TUNE.hp, onDeath: TUNE.onDeath, slimes: slimes() }));
engine.saves.define('action', { version: 1, save: () => ({ ...game }), load: d => { Object.assign(game, fresh(), d); } });

// ---------- Ops: every caller (mouse, key, dev bridge, MCP, tests, enemy AI) runs the same rule ----------
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
engine.ops.define('player.attack', {
  desc: 'Swing at every slime within reach in front of the actor',
  can: () => game.over ? 'dead' : game.cooldown > 0 ? 'cooldown' : true,
  run(e, a, ctx) {
    game.cooldown = TUNE.attackCooldown;
    const me = e.world.get(ctx.actor), at = e.actorPosition(ctx.actor), f = me?.facing ?? 0;
    let hits = 0;
    for (const r of e.world.query({ kind: 'slime', near: at, radius: TUNE.reach })) {
      const d = dist(r.position, at) || 1e-6, dot = (Math.sin(f) * (r.position.x - at.x) + Math.cos(f) * (r.position.z - at.z)) / d;
      if (dot >= TUNE.arc && e.ops.run('enemy.damage', { id: r.id, amount: TUNE.damage }).ok) hits++;
    }
    return hits;
  },
  reasons: { dead: 'The player is dead', cooldown: 'Still recovering from the last swing' },
});
engine.ops.define('enemy.damage', {
  desc: 'Take hp off a slime; at 0 it dies and leaves its drop', args: { id: 'string', amount: 'number' },
  can: (e, { id }) => e.world.get(id)?.kind === 'slime' || 'noEnemy',
  run(e, { id, amount }) {
    const r = e.world.get(id), hp = Math.max(0, r.hp - amount);
    if (hp > 0) { e.world.set(id, { hp }); e.audio.sfx('hit', { at: r.position }); return hp; }
    // Death: the drop is a pickup made during play (inside an op, rule R33); a stable id ties it to this slime so a save keeps it
    e.pickups.spawn(r.position, { give: r.drop, id: `${id}-drop` });
    e.world.remove(id);   // the saved world remembers the slime is gone
    e.vars.bump('kills');
    e.audio.sfx('kill', { at: r.position });
    return 0;
  },
  reasons: { noEnemy: 'No living slime with that id' },
});
engine.ops.define('enemy.attack', {
  desc: 'The acting slime hits the player when in reach and off cooldown',
  can(e, a, ctx) {
    const r = e.world.get(ctx.actor);
    if (r?.kind !== 'slime') return 'notEnemy';
    if (game.over) return 'targetDead';
    return r.cooldown > 0 ? 'cooldown' : dist(r.position, e.actorPosition('player')) > TUNE.enemyReach ? 'outOfReach' : true;
  },
  run(e, a, ctx) {
    const r = e.world.get(ctx.actor);
    r.cooldown = TUNE.enemyCooldown;   // a value that changes every step: a direct field write, saved without an event
    game.hp = Math.max(0, game.hp - r.damage);
    e.audio.sfx('hurt');
    if (game.hp === 0) e.ops.run('player.die');
    return game.hp;
  },
  reasons: { notEnemy: 'The actor is not a slime', targetDead: 'The player is already dead', cooldown: 'Still recovering', outOfReach: 'The player is too far' },
});
engine.ops.define('player.die', {
  desc: `What dying does in this example (onDeath = ${TUNE.onDeath})`,
  can: () => game.over ? 'dead' : true,
  run(e) {
    game.deaths++;
    if (TUNE.onDeath === 'respawn') { game.hp = TUNE.hp; e.player.placeAt(TUNE.spawn); return 'respawn'; }
    game.over = true;   // 'restart' resets at once in the frame hook, 'gameover' waits for R (session.newGame is async flow, not a step)
    return TUNE.onDeath;
  },
});

// ---------- Fixed step: game time (cooldowns, enemy AI, gameplay keys), the same at any frame rate ----------
engine.world.simulate('slime', {
  near(rec, dt) {
    rec.cooldown = Math.max(0, rec.cooldown - dt);
    const p = engine.actorPosition('player'), d = dist(rec.position, p);
    if (game.over || d > TUNE.aggro) return;
    rec.rot = Math.atan2(p.x - rec.position.x, p.z - rec.position.z);   // face the player (+Z is forward)
    if (d > TUNE.enemyReach * 0.8) {
      const s = Math.min(TUNE.enemySpeed * dt, d - TUNE.enemyReach * 0.8);
      engine.world.move(rec.id, { x: rec.position.x + (p.x - rec.position.x) / d * s, z: rec.position.z + (p.z - rec.position.z) / d * s });
    } else if (rec.cooldown === 0) engine.ops.run('enemy.attack', {}, { actor: rec.id });
  },
});
engine.onFixed(dt => {
  game.cooldown = Math.max(0, game.cooldown - dt);
  if (engine.input.pressed('attack')) engine.ops.run('player.attack', {}, { source: 'player' });
});

// ---------- Frame: presentation and flow (HUD, death screen, save keys) ----------
let shownOver = false, restarting = null;
engine.onFrame(() => {
  engine.hud.bar('hp', { value: game.hp, max: TUNE.hp, label: 'HP' });
  const s = engine.world.query({ kind: 'slime', near: engine.player.position, radius: TUNE.aggro + 2 })[0];
  if (s) engine.hud.bar('enemy', { value: s.hp, max: s.maxHp, label: 'Slime' }); else engine.hud.remove('enemy');
  engine.hud.addCounter('gem', { icon: '💎', label: 'Gems', value: engine.inventory.count('gem') });
  if (game.over !== shownOver && (shownOver = game.over) && TUNE.onDeath === 'gameover') toast(engine, 'You died. Press R to retry');
  if (game.over && !restarting && (TUNE.onDeath === 'restart' || engine.input.pressed('retry'))) restarting = engine.session.newGame().finally(() => { restarting = null; });
  if (engine.input.pressed('save')) engine.saves.save('slot1').then(ok => { if (ok) toast(engine, 'Saved'); });
  if (engine.input.pressed('load')) engine.saves.load('slot1').then(ok => toast(engine, ok ? 'Loaded' : 'No save yet'));
});

Object.assign(window, { engine, actionTest: { picture } });   // tests, the dev bridge and the console rely on it (before start)
await engine.start();
