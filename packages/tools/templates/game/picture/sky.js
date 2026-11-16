// @ts-check
// __NAME__ sky: the background color and, when the game has a sky(), fog in the horizon color. update() runs once per drawn frame.
import { THREE } from 'threedog';
import { palette } from './palette.js';

/** @param {any} engine @param {any} ctx the picture module's ctx: what is added here leaves with it */
export function createSky(engine, ctx) {
  // Colors the background the engine already holds, so a sky() dome still draws over it. Assigning engine.scene.background = ... takes over from the dome, on purpose
  // (engine.sky.backdrop gives one flat color and keeps the sky signals).
  const { r, g, b } = new THREE.Color(palette.background);
  ctx.borrow(engine.scene.background, { r, g, b });
  if (!engine.sky) return { update() {} };   // no sky, no far horizon to hide: no fog until the game wants one (recipe 34)
  // The dome's colors over the day. A picture that replaces this one sets its own rows: engine.sky.keyframes has no undo
  engine.sky.keyframes(palette.sky);

  const F = palette.fog, fog = new THREE.Fog(0xffffff, 1, 2);
  ctx.borrow(engine.scene, { fog });
  return {
    fog,
    // Rewrites the fog every frame from the signals: the horizon color (so ground and dome meet without a line), the view distance, the weather.
    /** @param {any} signals engine.uniforms */
    update(signals) {
      const far = signals.uViewDistance.value * F.far / signals.uWeatherFog.value;   // uWeatherFog: 1 when clear, higher in fog and rain
      fog.color.copy(signals.uSkyHorizon.value);
      fog.near = far * F.near / F.far; fog.far = far;
    },
  };
}
