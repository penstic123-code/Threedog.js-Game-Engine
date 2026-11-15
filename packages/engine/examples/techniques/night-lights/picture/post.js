// @ts-check
// The bloom on the lamp heads. Declared skipOnLowTier: it blurs the whole frame several times (the real tier is known only at start).
import { bloom } from '@threedog/post-effects';
import { BLOOM, GLARE } from './palette.js';

/** @param {any} engine @param {{ glare: boolean }} o */
export function createPost(engine, o) {
  engine.post.add({ ...bloom(o.glare ? GLARE.bloom : BLOOM), skipOnLowTier: true }, { name: 'bloom', slot: 'hdr' });
}
