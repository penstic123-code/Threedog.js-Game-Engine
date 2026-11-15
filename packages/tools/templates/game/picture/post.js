// @ts-check
// __NAME__ post: the tone curve, exposure and the post effects (ambient occlusion, a light bloom), all from @threedog/post-effects through engine.post.add.
// Each effect is one line: delete it to drop the effect, or turn it off live with engine.post.get('ao').enabled = false.
import { ao, bloom } from '@threedog/post-effects';
import { palette } from './palette.js';

/** @param {any} engine @param {any} ctx the picture module's ctx: what is added here leaves with it */
export function createPost(engine, ctx) {
  ctx.borrow(engine.renderer, { toneMapping: palette.toneMapping, toneMappingExposure: palette.exposure });
  // AO and bloom cost a few milliseconds a frame (npx threedog perf shows it). skipOnLowTier holds them while engine.tier is 'low': the tier is measured at start()
  // and can change later (settings, the adaptive quality ladder), so a declaration follows it where reading engine.tier here would not
  const P = palette.post;
  ctx.track(engine.post.add({ ...ao(P.ao), skipOnLowTier: true }));         // screen space: what is off screen does not darken; order 20, so bloom sees the darkened corners
  ctx.track(engine.post.add({ ...bloom(P.bloom), skipOnLowTier: true }));
}
