// @ts-check
// STARTER PICTURE: a soft, muted landscape whose final image layer is real ASCII characters, in plain three.js and TSL. It was copied into this game, it is this game's code now,
// and nothing links back. Nothing in it is required, and it is meant to be changed: if the game still looks like this starter when it ships, it has failed.
//
// What each file controls:
//   palette.js    every scene color and number. Start here.
//   ascii.js      the character layer: cell size, glyph set, background strength, and the line that turns it off, all at the top of the file.
//   paint.js      the one texture language: soft two-color fields. Also the lit material all surfaces share.
//   grade.js      bright pixels get paler. One small step on the finished picture.
//   lights.js     sun, green fill, fog.   materials.js  named surfaces.
//   ground.js / water.js    ground and water from your own height function.
//   props.js      branching trees, bushes, rocks, reeds, and plant() that merges them into one draw. Replace these with your game's own shapes.
//   sampler.js    a test valley to look at the picture. Delete it when your game has a scene.
//
// Make it yours, in this order, and look at a shot after each step:
//   1. Pick the game's mood in one sentence, then rewrite palette.js for it: grass, leaves, water, and the fill's ground color (the color of every shadow).
//   2. Change the marks in ascii.js and paint.js: another glyph set (digits, kana, block shapes, one letter), a bigger cell, a different ramp. This is what stops two games looking alike.
//   3. Replace the shapes in props.js with silhouettes that belong to this game.
//   4. Move the sun low, or change the time of day: long shadows push cells down the ramp and change the glyphs across the whole frame.
// Not this look at all (sharp, realistic, no characters)? Set ASCII.on to false to keep the scene, or delete the folder and write your own; the engine does not need any of it.
import { palette } from './palette.js';
import { createLights } from './lights.js';
import { createMaterials } from './materials.js';
import { createGround } from './ground.js';
import { createWater } from './water.js';
import { createAscii } from './ascii.js';
import { grade } from './grade.js';
import * as props from './props.js';

// A picture module: engine.use(createPicture()), then engine.picture. Everything it adds goes through ctx, so engine.use(another(), { replaces: 'picture' }) leaves nothing of it.
/** @returns {import('threedog').ModuleDef} */
export function createPicture() {
  return {
    name: 'asciiMeadow', skipKind: 'none', type: 'picture', provides: ['picture', 'tone', 'fog', 'background', 'sun'],
    /** @param {any} engine @param {any} ctx */
    install(engine, ctx) {
      ctx.borrow(engine.renderer, { toneMapping: palette.toneMapping });
      const lights = createLights(engine, ctx), materials = createMaterials();
      ctx.track({ remove() { for (const m of Object.values(materials)) m.dispose(); } });
      // onRender, not onFrame: it runs after every module updated, so the signals are this frame's
      ctx.track(engine.onRender(() => lights.update(engine.uniforms)));
      ctx.track(engine.post.add(grade));
      const ascii = createAscii(engine, ctx);
      /** @param {any} m ground and water are the picture's: they leave with it */
      const own = m => {
        engine.scene.add(m);
        ctx.track({ remove() { m.removeFromParent(); m.geometry.dispose(); m.material.dispose(); } });
        return m;
      };
      return {
        lights, materials, props, palette, ascii,
        /** @param {Parameters<typeof createGround>[0]} [o] */
        ground: o => own(createGround(o)),
        /** @param {Parameters<typeof createWater>[1]} [o] */
        water: o => own(createWater(engine, o)),
      };
    },
  };
}
