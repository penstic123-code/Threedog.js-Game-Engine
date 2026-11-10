// What an effect says about itself for the picture menu (engine.catalog('picture')), written once next to its factory as fn.about.
// Why on the factory and not only on the definition: the menu lists effects the game has not added yet, so it reads them without calling
// the factory (some need a light or a box). The definition the factory returns carries the same object and takes backend / skipOnLowTier
// from it, so "where it runs" is declared in one place. Fields: cost 'low' | 'medium' | 'high' (rough GPU class, not a measurement),
// on (one line that turns it on), recipe (where it is explained), limits (one line of what it cannot do), webgpuOnly (node only, no WebGL
// version), backend / skipOnLowTier as on PostEffect, acts (what it does to the light, for the engine's combination checks: 'glow' lifts what passes
// params.threshold, 'exposure' scales the light by a value it keeps on the GPU, 'ao' darkens the ambient light; the checks, the settings rows and photo read this, never the effect's name). tests/specs/picture-menu.mjs fails when an exported effect has none or contradicts it.

/** @param {Function & { about: any }} fn @returns {{ about: any, backend?: 'webgpu', skipOnLowTier?: true }} the fields its definition carries */
export const declared = fn => ({ about: fn.about, ...(fn.about.backend ? { backend: fn.about.backend } : {}), ...(fn.about.skipOnLowTier ? { skipOnLowTier: true } : {}) });
