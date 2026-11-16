// @ts-check
// __NAME__ picture: wiring only, no values. Each part is one file here and writes plain three.js; numbers and colors live in palette.js.
// The engine hands over signals (engine.uniforms) and writes none of this; recipe 62 lists them and shows how to add parts or shaders/.
// A placeholder start with correct light (a key, a fill, soft shadows, a tone curve, AO and a light bloom): a plain temperate day to replace with the game's style.
// Change anything here, or delete the folder and write your own.
import { createLights, createFill } from './lights.js';
import { createSky } from './sky.js';
import { createPost } from './post.js';
import { createMaterials } from './materials.js';
import { createWorldColors } from './world.js';

// A picture module: what it adds goes through ctx, so engine.use(another(), { replaces: 'picture' }) swaps the whole picture and leaves nothing behind (recipe 62).
/** @returns {import('threedog').ModuleDef} */
export function createPicture() {
  return {
    name: 'picture', type: 'picture', provides: ['picture', 'tone', 'sun'],
    /** @param {any} engine @param {any} ctx */
    install(engine, ctx) {
      const lights = createLights(engine, ctx), sky = createSky(engine, ctx), materials = createMaterials();
      createPost(engine, ctx);
      ctx.track({ remove() { for (const m of Object.values(materials)) m.dispose(); } });
      // onRender, not onFrame: it runs after every module updated, so the signals are this frame's. Without a sky there is no day and night: uDaylight stays 1
      ctx.track(engine.onRender(() => { lights.update(engine.uniforms); sky.update(engine.uniforms); }));
      // One object's state gets a name here, so gameplay never touches a light or a material, e.g. lamp: id => ({ off() { lamps.get(id).intensity = 0; } }),
      // and combat code calls picture.lamp(id).off(). The names are this game's own.
      return { lights, materials };
    },
    /** @param {any} engine @param {any} ctx */
    init(engine, ctx) { createFill(engine, ctx); createWorldColors(engine, ctx, engine.picture.materials); },   // after the renderer is ready (lights.js says why); world.js after the terrain and water exist
  };
}
