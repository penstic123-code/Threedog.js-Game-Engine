// @ts-check
// __NAME__ post (--pixel): the tone curve and exposure only. The blank start's AO and bloom are left out on purpose: at one art pixel per few screen pixels
// they smear across the hard pixel edges. Add one back with engine.post.add(...) from @threedog/post-effects if the art wants it (recipe 62 4b).
import { palette } from './palette.js';

/** @param {any} engine @param {any} ctx the picture module's ctx: what is added here leaves with it */
export function createPost(engine, ctx) {
  ctx.borrow(engine.renderer, { toneMapping: palette.toneMapping, toneMappingExposure: palette.exposure });
}
