// What any characters module must provide (fields: see gameplay/inventory.contract.js; shared check: @threedog/tools/contract).
// The player is the world record 'player' (saved with world, not under a key of its own); jumps, landings, launches and falls are events other
// modules listen to, fired by the character itself (not exercised by the shared check: they need a player on ground). kit is what a game's mover calls (mover.contract.js).
// What addPlayer and control.characterOf hand out is character.contract.js: every member other modules use, the world protocol among them.
// position: who may write a character's position (design.md section 9). The record follows the character, so a write to the record of a live character is a placeAt (world.move).
export default {
  name: 'characters',
  api: ['addPlayer', 'removePlayer', 'findSpawn', 'findPath', 'findPathAsync', 'support', 'moveInput', 'carryRiders', 'addVehicle'],
  fields: ['kit'],
  resolves: true,   // calls engine.control.resolveWith; what it answers with is character.contract.js
  position: {
    authority: 'solver',
    writers: {
      holder: 'the holder of the character\'s engine.control slot, through its mover; a step that returns false placed it itself and calls syncRecord',
      vehicle: 'a seat places its rider while it rides (vehicle.contract.js); a placeAt ends the ride, so a seat never takes a placement back',
      physics: 'a hold on the physics layer lays it where the body lies (a ragdoll); a placeAt carries that body along',
      placeAt: 'character.placeAt or npc.placeAt: a placement, by anyone; world.move, world.set and thing.set on its record arrive here',
      load: 'a save puts it back',
    },
  },
  ops: [],
  events: ['character:jump', 'character:step', 'character:land', 'character:launch', 'character:fall', 'link:enter', 'link:exit'],
  saves: {},
  describe: true,
  options: { npcs: false },
  probe: { setup: [], emits: [], state: null },
};
