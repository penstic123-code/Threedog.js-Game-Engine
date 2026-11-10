// mover: 'manual': the game owns the position. The engine integrates no velocity and applies no gravity; it only keeps what other systems read
// in step with where the game put the character: grounded, what it stands on (a support still carries it), safeGround and the fall check.
//   const p = addPlayer({ control: (p, input, dt) => { p.position.x += 3 * dt; return null; }, faceMode: 'manual', mover: 'manual' });
// Why a mover and not "a control that never moves": control decides where to go (core/ops/control.js), the mover is still the one that writes the
// position. 'manual' is the takeover level for the position itself, so a hand-written controller (a platformer's own physics) keeps the
// platform, safe-ground and fall behaviour without fighting the built-in integration.
import { groundAt, beginMove, endMove, stateOf } from './support.js';
import { ownState } from './common.js';

/** Create the 'manual' mover (c is the character) */
export function manualMover(c) {
  return {
    name: 'manual',
    move(_dirX, _dirZ, _run, dt) {
      beginMove(c);
      const p = c.root.position, g = groundAt(c, p.x, p.z, p.y);
      c.grounded = p.y <= g + 1e-3; c.swimming = false;
      endMove(c, dt, c.grounded ? stateOf(c).hit : null, 'ground');
      // only with a hook: without one the game owns the state too. A ladder is manual plus states, so the climb clip plays with no gravity to fight
      if (c.states) ownState(c, c.grounded ? 'idle' : 'fall', 0);
    },
  };
}
