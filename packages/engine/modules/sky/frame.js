// Sky per-frame work (helper of Sky.js): signals (uSunDir, uSunColor, uSkyTop, uSkyHorizon, season, cover) and the dome. Lights, fog,
// exposure and the environment are the game's (its picture/ folder reads the signals): nothing here writes them, because a value with two writers
// is what made a game's picture depend on code it never saw (plan 2026-11-04 rule 1). The shadow box around the focus is engine.shadows.box (render/shadows.js).
import { defineOwned } from '../../core/ops/owned.js';
import { applySeason } from './season.js';
import { applyCover, skyTint } from './tint.js';
import { fogBand } from './fog.js';
import { fogLook } from '../../render/fogLook.js';
import { signalWatch } from '../../render/daylight.js';
import { sunAngle } from '../../core/time/dayTime.js';
import { LUMA } from '../../render/fxNumbers.js';

/**
 * Brightness of the sky's ambient light for one sky color pair: ambient intensity x the luminance of the hemi color (top / horizon halfway,
 * linear colors, so the mean of their luminances). One measure for the keyframe peak (Sky.js) and the frame (updateSky).
 * @param {import('three').Color} top @param {import('three').Color} horizon @param {number} ambient
 */
export const skyLight = (top, horizon, ambient) => ambient * (lum(top) + lum(horizon)) / 2;
const lum = c => LUMA[0] * c.r + LUMA[1] * c.g + LUMA[2] * c.b;

// The copyable takeover calls each owned property's warning quotes (core/ops/owned.js): the engine yields to a direct write, these say it explicitly
const L = {
  background: { manual: 'engine.sky.dome.visible = false', back: 'engine.sky.replace(null)' },
  environment: { manual: 'engine.sky.environment().remove()', back: 'engine.sky.environment()' },
  sunDir: { manual: "engine.autoView.manual('sunDir')", back: "engine.autoView.manual('sunDir', false)" },
};

/**
 * Register what the sky still moves on its own: the background (backdrop / skybox). It yields to a direct write. (The shadow box is engine.shadows.box, render/shadows.js)
 */
export function watchOwned(sky) {
  const e = sky.engine, scene = e.scene;
  sky._signals = signalWatch(e, { uSkyTop: 'engine.sky.top = color', uSkyHorizon: 'engine.sky.horizon = color' });
  const own = (id, part, key, read, levels, objects) => defineOwned(e, { id, part, key, read, levels, objects });
  const list = [];
  // background: the sky writes it with a backdrop / skybox; with the dome it draws over whatever scene.background holds, so a game that sets one
  // takes it, and the dome hides (onChange) so the game's background shows; handing it back shows the dome again
  list.push(sky._oBg = own('background', 'sky', 'background', () => [scene.background, scene.backgroundIntensity], L.background, [scene]));
  sky._oBg._onChange = o => { if (!sky._backdrop && !sky.skybox && !sky._ownSky && !sky._noSky) sky.dome.visible = o.on; };   // a replaced sky keeps the dome hidden
  // the reference is the scene as the engine made it, not what is there now: picture code runs before start() (and may run before sky()), and a write
  // with no reference to differ from would leave the dome drawn over the game's background for good
  sky._oBg.mark([e.baseBackground, 1]);
  // the environment map engine.sky.environment() writes into its `into` object: a game that writes scene.environment itself takes it, the sky stops building it (environment.js)
  list.push(sky._oEnv = own('sky.environment', 'sky', 'environment', () => sky._env?.into?.environment ?? null, L.environment, [scene]));
  sky._oEnv._onChange = o => { if (o.on && sky._env) sky._env.key = null; };   // handed back: the next interval builds it again
  // the sun: part 'view', so engine.autoView.manual('sunDir') is the one takeover entry. The shadow and the game's lights follow this value, so a sun at a chosen
  // direction has to survive the frame. sunDir and uSunDir are one vector (Sky.js), so a write to either name is seen here
  list.push(sky._oSun = defineOwned(e, { id: 'sky.sunDir', part: 'view', key: 'sunDir', read: () => sky.sunDir.toArray(), levels: L.sunDir, objects: [sky] }));
  return list;
}

/** Recompute the signals and the dome for this frame */
export function updateSky(sky) {
  applySeason(sky, sky.engine.uniforms);
  const t = sky.drawnTime, kf = sky.kf;
  let i = 0; while (i < kf.length - 2 && t > kf[i + 1][0]) i++;
  const a = kf[i], b = kf[i + 1], f = (t - a[0]) / (b[0] - a[0]);
  const u = sky.uniforms, scene = sky.engine.scene;
  u.uTop.value.copy(a[1]).lerp(b[1], f);
  u.uHorizon.value.copy(a[2]).lerp(b[2], f);
  // engine.sky.top / horizon: a color over the keyframes (null = keyframes); the dome and the signals follow
  if (sky.top != null) u.uTop.value.set(sky.top);
  if (sky.horizon != null) u.uHorizon.value.set(sky.horizon);
  u.uStarCloudDim.value = sky.dim.stars ? 1 : 0;
  for (const o of sky._owned) o.check();
  applyCover(sky, sky.engine.uniforms);   // after the season: snow / ash cover lies over the season tint
  const M = skyTint(sky, sky._tintNow), flash = sky._points.flash.value(), hemiI = a[4] + (b[4] - a[4]) * f;
  // the sky's light now, 0-1 of its brightest keyframe row, read before any tint. Why: a sky.tint color (weather grey, a cave tint) is the color
  // under that brightest sky; lerping toward it as a fixed color turned a rainy night into a lit grey (#0d1628 -> #6b6b6d, R3). Dimmed by the
  // sky's own light it stays dark at night and is unchanged at the brightest row
  // sky. engine.sky.dim.tint false keeps the tint at its full color at any hour (a picture decision, not the engine's)
  const light = !sky.dim.tint ? 1 : sky._lightPeak > 0 ? Math.min(1, skyLight(u.uTop.value, u.uHorizon.value, hemiI) / sky._lightPeak) : 1;
  if (M.amount || M.horizon) {
    const tint = sky._tintLit.copy(M.color).multiplyScalar(light);
    if (M.amount) u.uTop.value.lerp(tint, M.amount);
    if (M.horizon) u.uHorizon.value.lerp(tint, M.horizon);
  }
  if (flash) { u.uTop.value.addScalar(flash * 0.4); u.uHorizon.value.addScalar(flash * 0.3); }
  const bd = sky._backdrop;   // engine.sky.backdrop (dome.js): a flat background in place of the dome
  if (bd && sky._oBg.on) { sky.dome.visible = false; scene.background = bd.color; }
  // the drawn sky colors for game shaders (render/effects.js uSkyTop / uSkyHorizon): the horizon a game's fog can copy
  sky._signals.check();
  sky.engine.uniforms.uSkyTop.value.copy(u.uTop.value); sky.engine.uniforms.uSkyHorizon.value.copy(bd ? bd.color : u.uHorizon.value);
  sky._signals.mark();
  u.uFogBand.value = fogBand(fogLook(scene, sky.engine.renderer), u.uHorizon.value);   // compared to the dome's horizon (not the backdrop): the band is drawn on the dome
  u.uSunColor.value.copy(a[3]).lerp(b[3], f);   // the keyframes' sun color: the dome's sun disk, and a signal for the game's own sun (shader.js shares the object)

  const ang = sunAngle(t), elev = Math.sin(ang);
  if (sky._oSun.on) sky.sunDir.set(Math.cos(ang) * sky.orbit.sway, elev, sky.orbit.tilt).normalize();
  // uDaylight / uTimeOfDay are not written here: render/daylight.js writes them from the 'daylight' / 'timeOfDay' measures (one writer each)
  u.uNight.value = Math.min(1, Math.max(0, -elev * 4));
  // a skybox is the dome's stand-in, so it dims with the keyframes' ambient column like the dome dims with its colors
  if (sky.skybox && sky._oBg.on) sky.engine.scene.backgroundIntensity = Math.max(0.05, sky._ambientPeak > 0 ? hemiI / sky._ambientPeak : 1);
  for (const o of sky._owned) o.mark();
}
