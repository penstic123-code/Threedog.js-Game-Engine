// @ts-check
// __NAME__ world colors: what the engine's modules draw from the game's data (terrain ground types, water, placeholder capsules) takes its colors from
// palette.js here, so the picture is still the one writer. Only for modules the game installed; each value goes back when the picture leaves.
import { THREE } from 'threedog';
import { palette } from './palette.js';

/** @param {any} engine @param {any} ctx @param {Record<string, any>} materials createMaterials()'s */
export function createWorldColors(engine, ctx, materials) {
  if (engine.characters) ctx.borrow(engine.characters, { material: materials.character });
  if (engine.water) {
    const { r, g, b } = new THREE.Color(palette.water);
    ctx.borrow(engine.water.material.color, { r, g, b });
  }
  // recolor rebuilds the loaded chunks once (collision and edits stay); null on leaving gives back what terrain({...}) was given.
  // A picture that draws the ground itself (replaces 'terrain-draw') sets its colors there instead, and this line goes.
  if (engine.terrain) {
    engine.terrain.recolor(palette.ground);
    ctx.track({ remove() { engine.terrain.recolor({ colors: null, biomeColors: null, variation: null }); } });
  }
}
