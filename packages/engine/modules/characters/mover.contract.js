// What a game's mover must be (fields: see gameplay/inventory.contract.js; shared check: @threedog/tools/contract). Built by (character, engine) => mover, once per character.
//   move(x, z, run, dt, y)   every step the character moves: x, z the direction (length 0-1 scales the speed), y up or down, default 0. It writes character.root.position
//   name                     what describe().player.mover shows
//   dispose()                optional: the character is gone, release what the mover built
//   leave()                  optional: another mover took over; take out of the world what this one keeps there. Its move() runs again when it is back
// Contact is the mover's to take or leave: engine.characters.kit (beginMove, groundAt, endMove, ownState). Calling none of it means the mover owns grounded, platforms and the fall check.
export default {
  name: 'mover',
  kind: 'object',
  api: ['move'],
  fields: ['name'],
  position: { authority: 'solver', writers: { mover: 'move() writes character.root.position while the holder of the control slot drives it; it writes no record' } },
  optional: { dispose: v => typeof v === 'function', leave: v => typeof v === 'function', collider: v => typeof v === 'object', world: v => typeof v === 'object' },
};
