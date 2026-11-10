// Player-control error texts, i18n strings and the control check (split out of index.js)
// The engine picks no player feel: control has no default (genericity rule: core carries no preset). A preset is one spread away, so the error names it first.
const CONTROL_FIX = "pick how the player moves: addPlayer({ ...presets.player.thirdPerson, spawn }) (import { presets } from 'threedog'), " +
  "control: 'camera' (keys relative to the camera) or a function (player, input, dt) => ({ x, z, run? }). The game moving the player itself (a roll, a lunge) " +
  "takes control for that time: engine.control.take(player, { owner: 'roll', layer: 'script', step })";
export const DEV_STRINGS = { noControl: 'characters.addPlayer(): no control given; ' + CONTROL_FIX,
  badControl: "characters.addPlayer(): control {got} is not a control; " + CONTROL_FIX + ". (A function returning null stands still; a game-driven move takes control, see recipe 57)",
  noFollow: "characters.addPlayer(): a camera module is installed but cameraFollow was not given, so the camera does not follow the player. " +
    'Pass cameraFollow: true (presets.player.* do), or cameraFollow: false if the game aims the camera itself',
  noWorld: 'characters.addPlayer() needs world() installed first: the player is a record in world (position is saved, world splits near/far by it). Use engine.use(world(), …); openWorld() already installs it' };
export const STRINGS = { 'zh-CN': { 'npc.talk': '和{name}说话', 'input.brake': '刹车' }, en: { 'npc.talk': 'Talk to {name}', 'input.brake': 'Brake' } };

export const validControl = c => c === 'camera' || typeof c === 'function';
