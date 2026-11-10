// Sky fog (helper of Sky.js). The game's fog is plain three.js: engine.scene.fog (WebGPU: scene.fogNode, render/fogLook.js); this file only reads it for the dome's fog band.

// The dome's fog band: its lower band fades to the fog color so the line where fogged ground meets the sky does not show.
// Always compiled in and switched by the uFogBand uniform (0 = off, mix(col, x, 0.0) is col exactly), so any fog color change at
// runtime -- a game writing scene.fog.color, or a fog of its own -- needs no recompile.
export const DOME_FOG = { decl: 'uniform vec3 uFogColor; uniform float uFogBand;', body: '\n  col = mix(col, uFogColor, uFogBand * (1.0 - smoothstep(-0.02, 0.15, d.y)));' };
/** Per frame: the band is on exactly when the fog's color is not the horizon the dome draws. One rule for every fog, because it reads the fog
 * object itself; no fog object = nothing to hide = off; an exp2 density of 0 draws nothing = also off, or the dome would show a band no ground has. */
export const fogBand = (fog, horizon) => (fog?.color && !(fog.isFogExp2 && fog.density <= 0) && !fog.color.equals(horizon) ? 1 : 0);
