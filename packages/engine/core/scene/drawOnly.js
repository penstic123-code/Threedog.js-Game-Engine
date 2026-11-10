// Parts the engine draws for something else, not things of their own: a cascade's extra copies of the sun (the material patch adds them up to
// one sun), far impostor cards placed only in the vertex shader, the sky dome. Whatever copies the scene (the photo path trace, the gallery's
// 'game' light) leaves every marked object out: one rule here, so no copier keeps its own list and a new such part is covered by marking it.
// A WeakMap, not userData: three's clone() copies userData, so a game's own clone of a marked object (a cascade light reused as a fill light,
// a cloned sky mesh) would be hidden too. The tools package reads it through the 'threedog/draw-only' export (the same module instance).

/** object -> what a copy lacks without it, in plain words ('' when nothing is: the real sun stays) */
const MARKED = new WeakMap();
/**
 * Mark objects as drawn for something else (returns the first, so it fits in the call). For engine module code.
 * @template {import('three').Object3D} T @param {string} what @param {[T, ...import('three').Object3D[]]} objs @returns {T}
 */
export function drawOnly(what, ...objs) { for (const o of objs) MARKED.set(o, what); return objs[0]; }
/** True for an object drawOnly marked (never for a clone of one) @param {any} o @returns {boolean} */
export const isDrawOnly = o => MARKED.has(o);
/** What a copy lacks without o ('' when nothing), undefined when o is not marked @param {any} o @returns {string | undefined} */
export const drawOnlyWhat = o => MARKED.get(o);
