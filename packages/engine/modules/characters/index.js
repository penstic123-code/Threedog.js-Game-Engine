// Characters module: player (keyboard/stick control, camera follow, footsteps, enter/exit vehicles) and NPCs (schedule, pathfinding, dialogue).
// The pathfinding entry for game code is engine.characters.findPath: uses the navmesh if nav is installed and ready, else A* (astar.js is an internal fallback, not
// exported).
// NPC facts live in engine.world (kind 'npc'), the model is just a presentation when near (see the top of NPC.js): NPCs need world() installed (openWorld
// already does).
// The player is also a world record (id / kind both 'player'): position, facing, motion state and current vehicle live in the record and are saved with world;
// world splits near / far by it by default.
// Only the mover changes the player's position (Character.move / placeAt / enter / exit), then writes back to the record; loading places the player back by the
// record. So install world() before creating the player.
// Vehicles are used through an interface (the { object, speed, drive(), seatPosition(), exitPosition() } returned by rigid.addWheeled); rigid is not imported
// here.
import { Character } from './Character.js';
import { addPlayer } from './player.js';
import { NPCManager, NPC } from './NPC.js';
import { findPath } from './astar.js';
import { findSpawn, moveInput, withHeights } from './moveHelpers.js';
import { AsyncPaths, sourcePath, noteAStarStandIn } from './pathAsync.js';
import { needMaterial } from '../../core/base/validate.js';
import { builtInSounds } from '../../core/assets/assetManifest.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { codedError } from '../../core/base/errorHints.js';
import { addSupport, carryRiders, beginMove, endMove, groundAt } from './movers/support.js';
import { moveStacks, ownState } from './movers/common.js';
import { STRINGS } from './playerStrings.js';
import { addVehicle, stepSeats } from './seat.js';
import { footstepSynth, stepSound } from './footsteps.js';
import { xzOf, yOf } from '../../core/base/math.js';
import { surfaceOr } from '../../core/scene/ground.js';
import { isEngineMade } from '../../render/patches.js';
import { keepPart } from '../../core/base/freeParts.js';
import { capsuleDefault, capsuleMaterial } from './proceduralRig.js';
import { passesOf } from '../collision/grid.js';
export { Character, NPC };

/**
 * Characters module. Once installed:
 *   engine.characters.addPlayer({ spawn: {x, z}, colors, model, clips })  → player
 *   engine.npcs.add({ id, name, schedule, interact, ... })                       → NPC handle (needs npcs: true, on by default; data lives in engine.world)
 *   engine.npcs.remove(npc or name); engine.characters.removePlayer()
 *   three.js object of player and NPC: .root (Group), position .position (Vector3); spawn / position accept a Vector3 directly
 *   When an NPC is far it has no model: npc.root is null, npc.position is the data position
 */

/** The characters.path rule, else navmesh when ready, else A* (characters.findPath; the one synchronous A* entry, see R20) */
function solvePath(e, st, from, to, o) {
  const { detailed, id, ...rest } = o;
  rest.passes = passesOf('characters.findPath()', o.passes);
  let res = sourcePath(e, st.path, from, to, o);
  if (res) { /* the game's source answered */ }
  else if (e.nav?.ready) res = e.nav.findPath(from, to, { ...rest, detailed: true });
  else if (!e.collision) res = { status: 'notReady', path: null };
  else {
    noteAStarStandIn(e);
    const [sx, sz] = xzOf(from), [gx, gz] = xzOf(to), radius = rest.radius ?? e.movement.radius;
    const floor = (x, z, y) => surfaceOr(e, x, z, y, y);
    const path = findPath((x, z, y) => e.collision.walkableAt(x, z, radius, y, rest.passes), sx, sz, gx, gz, { ...rest, radius, y: floor(sx, sz, yOf(from)), goalY: yOf(to), floor, body: e.movement.height });
    // nav installed but not ready: A* is only a stand-in, tell the caller honestly
    res = { status: e.nav ? 'notReady' : path ? 'ok' : 'noPath', path };
  }
  if (res.path) withHeights(e, res.path, from, to);
  return detailed ? res : res.path;
}

const CHARACTERS_PARAMS = keysSchema(['npcs', 'npcTiers', 'animation', 'fall']);

/**
 * The object behind engine.characters
 * @param {any} e engine
 * @param {any} st the module's state (characters() below)
 * @param {any} animation characters({ animation })
 */
function charactersApi(e, st, animation) {
  // keepPart: every capsule draws with this material, so removing one character must not dispose it. The hold goes when the material is replaced or the
  // module unloads (dispose below), and a default one is then freed here, as no asset load owns it; a game's is ordinary again for engine.remove
  const hold = m => { st.keep?.remove(); st.keep = keepPart(m); return (st.material = m); };
  const api = {
    /** @internal characters({ animation }): what every model's Animator starts from (useModel.js) */
    _animation: animation,
    /** @internal live capsule mesh -> its colors.body (undefined: none), what a swap of .material walks */
    _capsules: new Map(),
    /**
     * The three.js material of every placeholder capsule. Set it to swap the look of all of them at once; it is used as given, with no patches added.
     * A character with colors.body draws with a copy of it in that color. A model's own materials are the model's: this never touches them.
     * @example engine.characters.material = new THREE.MeshToonMaterial({ color: 0xd9a066 });
     * @type {THREE.Material}
     */
    get material() { return st.material ?? hold(capsuleDefault()); },
    set material(m) {
      needMaterial('character-option', 'engine.characters.material', m, '. Example: engine.characters.material = new THREE.MeshStandardMaterial({ color: 0xd9a066 })');
      const old = api.material;
      if (m === old) return;
      hold(m);
      for (const [mesh, color] of api._capsules) {
        if (mesh.material !== old) mesh.material.dispose();   // the copy in a character's own color
        mesh.material = capsuleMaterial(m, color);
      }
      if (isEngineMade(old)) old.dispose();   // a material the game gave stays the game's
    },
    /**
     * Find a spawn point: spiral outward from position (default origin) for walkable ground (no obstacles, gentle slope) that is not in water. Returns a
     * Vector3 (y is ground height).
     * Assumes no terrain: height range minH / maxH is unbounded by default (open worlds pass their own to avoid beaches and peaks); waterMargin minimum
     * height above water in meters (default 0.5)
     */
    findSpawn(position = { x: 0, z: 0 }, opts = {}) { return findSpawn(e, position, opts); },
    /**
     * Something characters can stand on and ride: a moving platform, lift, raft. Move the object any way (onFixed before or after the player,
     * a timeline, physics); riders are carried by how its matrix changed, so the order does not matter. Returns { id, remove() }.
     * safe: false = never a respawn spot; carry: 'position+yaw' turns riders with it; inherit: false = jumping off keeps none of its speed.
     * The simple mover stands on its measured box top; with mover 'rapier' give it a collider too (the support only carries).
     * @param {import('three').Object3D} object @param {{ id?: string, safe?: boolean, carry?: 'position' | 'position+yaw', inherit?: boolean }} [o]
     * @example const lift = engine.characters.support(liftMesh); engine.onFixed(() => { liftMesh.position.y = 2 + Math.sin(engine.time.now('real')); });
     */
    support(object, o) { return addSupport(e, object, o); },
    /**
     * Pathfinding (the only entry): navmesh if nav is ready, else A* (needs the collision module). Returns [{ x, y, z }…], null if unreachable: every point has its height, and a y on from / to picks the floor.
     * Pass { detailed: true } to get { status, path }: 'ok' found | 'noPath' unreachable | 'notReady' nav installed but mesh not generated yet (path is the
     * A* fallback, may be inaccurate; null without collision). { passes: ['gate'] }: the path goes through colliders of those layers (collision.addBox { layer }), as the body does
     * (walkTo and NPCs pass their character's passes themselves)
     * Where paths come from is the rule 'characters.path' (findPathAsync, walkTo and NPCs follow it too; o.id picks an entry for one character): default 'walk' is the above, false is no path,
     * a function ({ from, to, o }, engine) => [{ x, y?, z }…] | null | 'walk' is your own source, for flight, swimming or anything off the ground. It must be deterministic; it is not saved
     * @example engine.mod('characters.path', { owner: 'birds', id: 'hawk', set: ({ from, to }) => [from, { x: to.x, y: 40, z: to.z }, to] });
     */
    findPath(from, to, o = {}) { return solvePath(e, st, from, to, o); },
    /** @internal may a nav crowd agent walk for this NPC: not with passes (the crowd's one mesh stops at every collider) or a 'characters.path' entry of its own (a game's source or false) */
    _crowdFits(id, passes) { return !passes?.length && st.path.value(id) === 'walk'; },
    /**
     * findPath for many callers (NPC crowds, AI squads): solved in engine.threads workers, done(path, status) runs on a fixed step ~4 steps later
     * via engine.commits, so threads on / off give the same paths. Keep findPath for the few that need a path now (click-to-move). Details: recipe 12
     * section 4.
     * @param {any} from
     * @param {any} to
     * @param {(path: { x: number, y: number, z: number }[] | null, status: 'ok' | 'noPath' | 'notReady') => void} done
     * @param {{ radius?: number, passes?: string[], step?: number, maxNodes?: number }} [opts]
     * @returns {{ remove: () => void }}
     * @example const req = engine.characters.findPathAsync(guard.position, target, (path, status) => { guard.path = path; });
     * req.remove();   // target changed before the answer came
     */
    findPathAsync(from, to, done, opts) { return st.paths.request(from, to, done, opts); },
    /**
     * Bends a link crossing away from its straight line: (t, position, crossing, character) with t 0-1, called each step after position is set on the line, write to position.
     * Depends only on its arguments, so a crossing saved halfway resumes on the same curve. null = the straight line
     * @example engine.characters.linkPose = (t, p) => { p.y += Math.sin(t * Math.PI) * 1.2; };   // every crossing is a hop
     * @experimental
     */
    linkPose: null,
    /** How many findPathAsync requests leave per fixed step (default 32); the rest wait for the next steps */
    get pathsPerStep() { return st.paths.perStep; },
    set pathsPerStep(n) { st.paths.perStep = Math.max(1, n | 0); },
    /**
     * The 'camera' player control as a value: movement keys / stick relative to the camera (world axes, up = -Z, without a camera module), the 'run' action
     * when the game bound one, input.autopilot.
     * Returns a reused { x, z, run } (do not keep it). Call it from your own control function to wrap the default instead of rewriting it. seat: read an engine.input.seat() instead of engine.input
     * @example addPlayer({ ...presets.player.thirdPerson, control: (p, input) => busy ? null : engine.characters.moveInput() }) // no movement while
     * attacking
     */
    moveInput(seat) { return moveInput(e, seat); },
    /**
     * What a game's mover calls to take part in contact, each optional: a mover that calls none owns contact itself.
     * beginMove(c): first in move(), a platform under the feet carries it, true when something outside moved it. groundAt(c, x, z, y): ground height at a spot, supports included.
     * endMove(c, dt, hit, ground): last in move(), keeps support, safeGround and the fall check (hit: the support under the feet, or null). ownState(c, base, speed): the game's states hook, then the state.
     * The mover contract and an example: recipe 57
     */
    kit: { beginMove, endMove, groundAt, ownState },
    /**
     * Join the vehicles characters can be seated in again: a saved rider finds its vehicle here by id, also when the vehicle is built after the load. rigid.addWheeled joins its cars;
     * a game's own boat or mount joins here, before or after the load. Returns { remove() }.
     * @param {any} vehicle anything with the vehicle contract and an id
     * @returns {{ remove(): void }}
     * @example engine.characters.addVehicle(boat);
     */
    addVehicle(vehicle) { return e.ops.allow(() => addVehicle(e, vehicle)); },
    /** @internal outside a fixed step: the rig calls it before it reads a rider's position (camera/common.js) */
    carryRiders() { carryRiders(e, true); },
    /**
     * Remove a player, by default engine.player (exit the vehicle first, stop responding to keys, dispose the model: animation, geometry, materials; the 'player' record in
     * world is removed too)
     */
    removePlayer(id = e.player?.id) { st.players.get(id)?.dispose(); },
    /**
     * Create the player. The engine assumes no feel: control is required, keys and camera follow come only from options (presets.player.* bundle them).
     * The player is also the world record with id 'player' (needs the world module).
     * Without spawn and with an existing player record in world (loaded before the player was created) it continues from the record's position; move the
     * player with player.placeAt(position)
     * control (required) is how the player's input steers it; it holds the player's control slot on layer 'base' as owner 'player-input'
     * (engine.control.of(player)): a walkTo or a game script (layer 'script') pauses it, a cutscene above that too, and it carries on when they end.
     *   'camera' moveInput(): movement keys relative to the camera, plus the jump key and vehicle driving
     *   function (player, input, dt) => ({ x, z, run? }) | null: you decide the direction (its length 0-1 scales the speed; null = stand still);
     *   speed changes go through engine.mod('move.speed', { owner, id: 'player', ... }); jump key and vehicles stay.
     *   Side-scroller: return { x: input.axis.x, z: 0 }
     * The game moving the player itself (rolls, lunges, hit stun): engine.control.take(player, { owner: 'roll', layer: 'script', step }) while it
     * lasts, then h.remove(); a direct player.move() while 'player-input' holds it is a control-bypass error in dev.
     * The 'run' / 'jump' actions are the game's to bind (presets.bindings.walk; player.jump() works without); cameraFollow: true points the camera
     * module at the player (and back after a vehicle)
     * The world record, saving and describe().player work the same for every control. The engine drives the player on its channel (default
     * 'player': dt passed to move and to the control function is engine.time.dt('player', 'player'), so engine.mod('time.player', ...) slows it)
     * @example const player = engine.characters.addPlayer({ ...presets.player.thirdPerson, spawn: engine.characters.findSpawn() })
     * @example const roll = engine.control.take(player, { owner: 'roll', layer: 'script', step: () => ({ x: 0, z: 1, run: true }) }); engine.clock.after(0.4, () => roll.remove(), { channel: 'real' })
     */
    // creating the player is setup (a game does it after loading its model, or on level:loaded), not a gameplay action: the ops guard lets its writes through
    addPlayer(opts = {}) { return e.ops.allow(() => api._createPlayer(opts)); },
    /** @internal */
    _createPlayer(opts) { return addPlayer(e, api, st, opts); },
  };
  return api;
}

/** The player's actions, declared once by the module (gone with it); the game binds their keys (presets.bindings.walk / .brake), so no option takes keys.
 * optional: a player without jump or brake still works, reading them unbound stays silent */
function declareActions(ctx) {
  ctx.input.define('jump', { label: 'input.jump', optional: true });
  ctx.input.define('run', { label: 'input.run', optional: true });
  ctx.input.define('brake', { label: 'input.brake', context: 'vehicle', optional: true });
}

/** What the module listens to, all through ctx.track */
function listen(e, ctx, st) {
  // the players' footsteps: plain listeners, so a game's own listener adds to them instead of taking the one slot (silent until audio.sounds names a sound)
  const isPlayer = c => st.players.get(c.id)?.character === c;
  ctx.track(e.events.on('character:step', ({ character }) => { if (isPlayer(character)) e.audio.sfx(stepSound(e, character.groundType())); }));
  ctx.track(e.events.on('character:land', ({ character, impact }) => { if (isPlayer(character) && impact > 3) e.audio.sfx(stepSound(e, character.groundType()), { volume: Math.min(2, impact / 6) }); }));
  ctx.track(e.events.on('ground:change', b => st.paths.dropTiles(b)));   // dug or raised ground: resample the path rasters there
  for (const n of ['level:loaded', 'level:unloaded']) ctx.track(e.events.on(n, () => { st.paths.tiles.clear(); e.control.endTasks(null, 'level'); }));   // another level, or none: no cached raster and no path planned on it applies
}

/**
 * The npcs section of content data. The key is the NPC's stable id (saves and quest targets use it). Every documented npcs.add option can be written; the same
 * option table checks the spelling. The content form owns start / schedule (clock strings, places) and the id, so those are translated, not passed as written
 */
const NPC_CONTENT = {
  desc: 'NPCs (id -> name, schedule, interact)',
  validate(d, { engine: e, ids }) {
    if (!e.npcs) throw codedError('module-needs', 'content npcs: characters({ npcs: false }) has no NPCs: drop npcs: false');
    const keys = keysSchema([...e.npcs.optionKeys.filter(k => !['id', 'position', 'zone', 'initial'].includes(k)), 'start']);
    for (const [id, n] of Object.entries(d)) { ids.claim(id, `npcs.${id}`); readParams(`content npcs.${id}`, keys, n); }
  },
  undo: (d, { engine: e }) => e.npcs.undoPoint(),   // the records go back with the world (modules/content/loader.js keepLoad)
  commit(d, { engine: e, where, zone, origin }) {
    for (const [id, n] of Object.entries(d)) {
      const plan = n.schedule ?? [], { start: _s, schedule: _p, ...rest } = n;
      e.npcs.add({ ...rest, id, schedule: plan.map(s => ({ at: s.at, position: where(s) })), position: where(n.start || plan[0]), zone: zone(n.start, ...plan), initial: true });
      origin(id, d, id);
    }
  },
};

/** describe(): the NPCs near the focus and the player's character state */
function describeCharacters(e, ctx, mgr) {
  // with a model report by the model (merged with interaction points and world's own report for the same object into one), without a model report by data
  // position
  for (const r of mgr && e.world ? e.world.query({ kind: 'npc', near: ctx.center, radius: ctx.radius, where: r => e.world.inZone(r) }) : []) {
    ctx.near(e.world.view(r.id) ?? r.position, { id: r.id, name: r.name, kind: 'npc', state: r.state });
  }
  if (ctx.out.player) Object.assign(ctx.out.player, { swimming: e.player.swimming, grounded: e.player.grounded, facing: Math.round(e.player.facing * 100) / 100,
    control: e.control.of(e.player)?.owner ?? null, faceMode: e.player.faceMode, mover: e.player.mover.name, ...(e.player.anim && { anim: e.player.anim.describe() }), ...(e.player.vehicle && { vehicle: { speed: Math.round(e.player.vehicle.speed * 10) / 10 } }) });
}

export function characters(opts = {}) {
  readParams('characters', CHARACTERS_PARAMS, opts);
  const { npcs = true, npcTiers, animation, fall } = opts;
  // players: what addPlayer made, by id. Their per-frame animation and per-step drive run in this module's own fixed / frame hooks (not
  // engine.onFixed), so a game onFixed sees the same player position whether it was registered before or after addPlayer (phase 'early' = before the move,
  // 'late' = after)
  const st = { mgr: null, paths: null, path: null, players: new Map(), material: null, keep: null };
  return {
    // before rigid: the player's move this step is in the physics step that follows (as when control was an onFixed)
    content: { npcs: NPC_CONTENT },
    name: 'characters', skipKind: 'none', type: 'actor', provides: ['characters'], params: CHARACTERS_PARAMS, options: opts, label: 'Characters', before: ['rigid'], noSkip: 'fixed steps paths, control holders and riders, none of which a time jump moves; schedules read the calendar clock', optional: ['cameraRig', 'calendar', 'interactions', 'dialogue', 'nav', 'collision', 'rigid', 'world'],
    install(e, ctx) {
      e.i18n.add(STRINGS); e.i18n.add({ 'zh-CN': { 'module.characters': '角色' }, en: { 'module.characters': 'characters' } });
      // move.* are defined at module install: doc examples call engine.mod('move.speed', …) in setup before creating a character, and relying on the first Character's definition would give unknown-name
      moveStacks(e);
      if (fall) ctx.mod('fall', { set: fall, layer: 'engine' });   // characters({ fall: 'rescue' }): the game's choice for everyone; engine.mod('fall', ...) from the game sits above it
      declareActions(ctx);
      builtInSounds(e.assets, { footstep: footstepSynth });   // sound asset 'footstep', silent until audio.sounds names it (step.grass: { src: 'footstep', params })
      if (npcs) { st.mgr = new NPCManager(e, ctx, st.players); e.npcs = st.mgr; if (npcTiers) st.mgr.tiers(npcTiers); }
      else if (npcTiers) throw codedError('module-params', 'characters({ npcTiers }) needs NPCs: drop npcs: false, or drop npcTiers');
      st.path = ctx.rule('characters.path', 'walk');
      st.paths = new AsyncPaths(e, st.path);
      // control (core/ops/control.js) finds a held character by id: the player, else an NPC's model (null while it is far)
      e.control.resolveWith(id => st.players.get(id)?.character ?? st.mgr?.character(id) ?? null);
      listen(e, ctx, st);
      return charactersApi(e, st, animation);
    },
    // NPC simulation and animation are driven by world (simulate / present update); here we only register with world at start; without world, wait for the
    // first npcs.add and then report the error
    init(e) { if (st.mgr && e.world) st.mgr.setup(); },
    // player control runs here (stage late: after every early onFixed and the gameplay stages); then carry riders by what moved since their own step
    // (support.js): every platform mover of this step has run by now
    // control holders' steps (the player's input, game steps) run here too, in that order: one move per held character per step (core/ops/control.js)
    fixed(_dt, e) { st.paths.flush(); e.control.stepAll(); stepSeats(e); carryRiders(e, false); },
    // a timeline or frame code moved a platform: carry now, so the picture never shows a rider sinking into or floating above it
    frame(dt, e) { for (const p of st.players.values()) p.character.animate(dt); carryRiders(e, true); },
    describe(e, ctx) { describeCharacters(e, ctx, st.mgr); },
    // a player, a queued path and the control lookup all outlive install unless they are ended here; the player's record stays in world, as NPC records do
    dispose(e) {
      for (const p of [...st.players.values()]) p.dispose(true); st.paths?.stop(); e.control.resolveWith(() => null); if (st.mgr) e.npcs = null;
      if (isEngineMade(st.material)) st.material.dispose();   // the default capsule material is this module's (kept, so nothing else frees it); a game's stays the game's
      st.keep?.remove(); st.material = st.keep = null;
    },
  };
}

export const handRolled = 'none: walking code is game movement, and any code shape would match ordinary maths';
