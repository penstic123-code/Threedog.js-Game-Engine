// The player: addPlayer and the parts it is made of. What the player is and how it is saved: the top of index.js.
import { Character, CHARACTER_KEYS } from './Character.js';
import { warnOnce, DEV, fmt } from '../../core/base/validate.js';
import { engineOwned } from '../../core/scene/things.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { codedError, coded } from '../../core/base/errorHints.js';
import { DEV_STRINGS, validControl } from './playerStrings.js';
import { vehicleById, seatFromRecord } from './seat.js';

/** The player's world record: its id and its kind */
export const PLAYER = 'player';

/** Everything addPlayer refuses, before it touches the old player */
function checkOptions(e, st, opts) {
  readParams('characters.addPlayer()', keysSchema([...CHARACTER_KEYS, 'spawn', 'control', 'cameraFollow', 'id', 'input']), opts);
  const control = opts.control;
  if (control === undefined) throw codedError('player-control', DEV_STRINGS.noControl);
  if (!validControl(control)) throw codedError('player-control', fmt(DEV_STRINGS.badControl, { got: JSON.stringify(control) ?? String(control) }));
  if (!e.world) throw codedError('module-needs', DEV_STRINGS.noWorld);
  if (opts.input !== undefined && !e.input.seats.includes(opts.input)) throw codedError('input-seat', 'characters.addPlayer(): input is a seat from engine.input.seat({ pad, keys })');
  const id = opts.id ?? PLAYER;
  if (opts.input) for (const [other, q] of st.players) if (other !== id && q.input === opts.input) throw codedError('input-seat', `characters.addPlayer(): this seat already drives player '${other}'`);
}

/** Place the player by the record (loading, reusing an existing record): do not write back to the record while placing, write once afterwards so record and
 * character agree */
function placeByRecord(e, p, rec, id) {
  const car = vehicleById(e, rec.vehicle), { x, y, z } = rec.position;
  p.recordId = null;
  if (p.vehicle && (p.vehicle !== car || p.seat !== (rec.seat ?? p.seat))) p.exit({ force: true });   // the save has it elsewhere: off this seat first, else every step pulls it back
  p.root.position.set(x, y, z); p.loadMotion(rec); p._fromRecord(rec);
  if (car && !p.vehicle) seatFromRecord(p, car, rec.seat);   // no vehicle with that id yet: the record waits, addVehicle answers it (seat.js)
  p.recordId = id; p._store();
  if (p.vehicle && rec.vehicle !== p._ride.id) p._writeSeat(p._ride.id, p.seat);   // an old save named it by index: from here on by id
}

/**
 * The step of the player's control slot. Gameplay keys are read in the fixed step (input snapshot, frame-rate independent); frame only plays animation.
 * The input is the base holder of the slot: engine.control runs this step (characters fixed, index.js) only while it is in charge, so a walkTo, a game script
 * or a cutscene pauses keys, jump and driving alike, and nothing else moves the player in that step.
 * dt is the player's channel (bullet time on 'player', time.local on 'player'). input: engine.input, or the seat of a local player.
 */
function inputStep(e, api, p, control, input) {
  let autoSpeed = null;   // the autopilot speed the move.speed entry holds now (null: no entry)
  let rig = e.cameraRig;   // the rig this player was handed to: a replaced one starts with nothing to follow (setCamera hands the target over itself)
  return dt => {
    if (rig !== e.cameraRig) {
      rig = e.cameraRig;
      if (rig && !rig.target && p.cameraFollow && e.player === p) rig.follow(p.vehicle?.object ?? p.root, p.vehicle?.camera);
    }
    const has = a => input.actions.has(a);   // 'interact' exists only with a module or binding that declares it
    // when the interactions module is installed, the vehicle's "exit" interaction handles it
    if (p.vehicle) { if (!e.interactions && has('interact') && input.pressed('interact')) p.exit(); }
    else if (p.canJump && input.pressed('jump')) p.jump();
    // autopilot { speed } (benchmarks, recordings) is a move.speed entry like any other modifier, not a second way to set the speed
    const ap = input.autopilot?.speed;
    // taken again only when the speed changed (or the entry was cleared): a take every step changed the stack each step, so every
    // speed read recomputed instead of using the stack's memo (core/ops/stacks.js)
    if (ap != null) { if (ap !== autoSpeed || !e.stacks.get('move.speed').has('autopilot', p.id)) e.mod('move.speed', { owner: 'autopilot', id: p.id, set: ap, layer: 'debug' }); }
    else if (autoSpeed != null) e.stacks.get('move.speed').release('autopilot', { id: p.id });
    autoSpeed = ap ?? null;
    return control === 'camera' ? api.moveInput(input) : control(p, input, dt);
  };
}

/** The listeners that keep the record and the player together; returns their handles */
function watchRecord(e, W, p, id) {
  const begin = p.position.clone(), rest = p.saveMotion();   // a player made after start() is in no new-game state: this is how a new playthrough has it
  return [
    // loading: after world is replaced wholesale, place the player back by the record; if the save has no player record (saved before the player was
    // created), add one from the current state
    e.events.on('world:load', () => {
      const rec = W.get(id);
      if (rec) placeByRecord(e, p, rec, id);
      else { if (e.session.replacing) { if (p.vehicle) p.exit({ force: true }); p.root.position.copy(begin); p.loadMotion(rest); } W.add({ id, kind: PLAYER, position: p.position, vehicle: null }); p._store(); }
    }),
  ];
}

/**
 * engine.characters.addPlayer, documented there
 * @param {any} e engine
 * @param {any} api engine.characters
 * @param {any} st the module's state: the new player joins st.players
 * @param {any} opts
 */
export function addPlayer(e, api, st, opts) {
  checkOptions(e, st, opts);
  const W = e.world, { id = PLAYER, input = e.input } = opts;
  api.removePlayer(id);   // a player of this id: dispose the old one first (else two characters respond to the same keys)
  const p = new Character(e, { channel: 'player', ...opts }), had = W.get(id);
  // engine.player is the first player. The one without an id is always it, as a replaced one was; a second player must not take the driving keys or camera in enter()
  const first = id === PLAYER || !e.player;
  p.cameraFollow = !!opts.cameraFollow;   // read again on vehicle exit and a new session (Character.js, camera/common.js)
  if (DEV && first && opts.cameraFollow === undefined && e.cameraRig) warnOnce(coded('player-control', DEV_STRINGS.noFollow));
  if (!had) W.add({ id, kind: PLAYER, position: [0, 0, 0], vehicle: null });
  if (had && !opts.spawn) { if (first) e.player = p; placeByRecord(e, p, had, id); }   // a record in a vehicle enters it here, and enter() gives the driving keys and camera only to engine.player
  else { p.recordId = id; p.placeAt(opts.spawn || api.findSpawn()); }
  e.scene.add(engineOwned('characters', p.root));
  // a touch jump button only when the game bound jump (a game without jumping gets no button)
  const jump = first && p.canJump && e.input.keysOf('jump').length ? e.input.touchButton('jump', 'input.jump') : null;   // released: entry.dispose below, which the module's dispose runs
  if (first) e.player = p;
  if (p.cameraFollow && !p.vehicle) e.cameraRig?.follow(p.root);
  // in the map before control.take: the control lookup finds a held character by id through it
  const entry = { character: p, input, dispose: null };
  st.players.set(id, entry);
  p._release = () => entry.dispose();   // player.dispose() from the game is the same teardown as removePlayer
  if (input !== e.input) input.actor = id;
  const held = e.control.take(p, { owner: 'player-input', layer: 'base', step: inputStep(e, api, p, opts.control, input) });
  // what the keys ask of the pedal, while the keys are in charge: the seat reads it each step, so a holder above lets go of it (seat.js)
  p._pedal = () => { if (!held.active) return null; const a = input.autopilot || input.axis; return [a.y, a.x, input.down('brake') ? 1 : 0]; };
  const watching = watchRecord(e, W, p, id);
  // keepRecord: the module is going, not the player; its place stays in world for the next addPlayer
  entry.dispose = (keepRecord = false) => {
    st.players.delete(id); held.remove(); jump?.remove(); for (const h of watching) h.remove();
    if (input.actor === id) input.actor = null;
    p.recordId = null; p._release = null; p.dispose(); if (!keepRecord) W.remove(id);
    if (e.player === p) e.player = st.players.values().next().value?.character ?? null;   // the next player is the first now
  };
  return p;
}
