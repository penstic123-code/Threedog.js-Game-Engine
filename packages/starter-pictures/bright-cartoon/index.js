// @ts-check
// STARTER PICTURE: a clear, bright cartoon look in plain three.js and TSL. It was copied into this game, it is this game's code now, and nothing links
// back. Nothing in it is required, and it is meant to be changed: if the game still looks like this starter when it ships, it has failed.
//
// What each file controls:
//   palette.js    every color and number. Start here.
//   paint.js      the one texture language: flat colors with a clean edge. Also the lit material all surfaces share.
//   lights.js     sun and fill.          sky.js    gradient, cut-out clouds, fog.
//   materials.js  named surfaces.        ground.js / water.js    a ground from your height function, water with depth bands.
//   props.js      tree, bush, rock, fence, hut, lamp, grass tufts. Replace these with your game's own shapes.
//   sampler.js    a test yard to look at the picture. Delete it when your game has a scene.
//
// Make it yours, in this order, and look at a shot after each step:
//   1. Pick the game's mood in one sentence, then rewrite palette.js for it: sky, ground, and the ramp's dark entry (the color of every shadow).
//   2. Change the mark in paint.js: blobs could be stripes, dots, or brush strokes. This is what stops two games looking alike.
//   3. Replace the shapes in props.js with silhouettes that belong to this game.
//   4. Move the sun low, or change the time of day: long shadows or a dusk sky change more than any single color.
// Not this look at all (dark, realistic, ink, pixel)? Delete the folder and write your own; the engine does not need any of it.
import { palette } from './palette.js';
import { createLights } from './lights.js';
import { createMaterials } from './materials.js';
import { createSky } from './sky.js';
import { createGround } from './ground.js';
import { createWater } from './water.js';
import * as props from './props.js';

// A picture module: engine.use(createPicture()), then engine.picture. Everything it adds goes through ctx, so engine.use(another(), { replaces: 'picture' }) leaves nothing of it.
// It holds no 'sky' slot, because a sky() module stays for its signals: it borrows that dome's visible instead.
/** @returns {import('threedog').ModuleDef} */
export function createPicture() {
  return {
    name: 'brightCartoon', skipKind: 'none', type: 'picture', provides: ['picture', 'tone', 'fog', 'sun'], optional: ['sky'],
    /** @param {any} engine @param {any} ctx */
    install(engine, ctx) {
      ctx.borrow(engine.renderer, { toneMapping: palette.toneMapping });
      const lights = createLights(engine, ctx), sky = createSky(engine, ctx), { materials, glow } = createMaterials();
      ctx.track({ remove() { for (const m of Object.values(materials)) m.dispose(); } });
      // onRender, not onFrame: it runs after every module updated, so the signals are this frame's
      ctx.track(engine.onRender(() => {
        const s = engine.uniforms;
        lights.update(s); sky.update(s);
        glow.value = palette.glow.night + (palette.glow.day - palette.glow.night) * s.uDaylight.value;
      }));
      /** @param {any} m ground and water are the picture's: they leave with it */
      const own = m => {
        engine.scene.add(m);
        ctx.track({ remove() { m.removeFromParent(); m.geometry.dispose(); m.material.dispose(); } });
        return m;
      };
      return {
        lights, sky, materials, props,
        /** @param {Parameters<typeof createGround>[0]} [o] */
        ground: o => own(createGround(o)),
        /** @param {Parameters<typeof createWater>[1]} [o] */
        water: o => own(createWater(engine, o)),
      };
    },
  };
}
