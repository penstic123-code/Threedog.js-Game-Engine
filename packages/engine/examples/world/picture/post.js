// @ts-check
// The glow on the sun, the lamp and bright water. Declared skipOnLowTier: it blurs the whole frame several times, and a slow machine needs that time for the world (the real tier is known only at start and can change later, so it is declared, not read here).
import { bloom } from '@threedog/post-effects';
import { BLOOM } from './palette.js';

/** @param {any} engine */
export function createPost(engine) {
  engine.post.add({ ...bloom(BLOOM), skipOnLowTier: true }, { name: 'bloom', slot: 'hdr' });
}
