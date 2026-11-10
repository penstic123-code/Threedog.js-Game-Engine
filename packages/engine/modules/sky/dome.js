// The dome's game entries (helper of Sky.js): the backdrop, the cloud function, the dome layers, and handing the dome over to the game's own sky.
// A hook change rebuilds the dome shader text and recompiles that one material (a hitch, so do it at a scene change, not every frame).
// Each renderer draws its own form of a hook: glsl on WebGLRenderer, tsl ((ctx) => vec4 node, render/fx/sky.tsl.js) on WebGPURenderer; a missing one throws by name.
import { engineOwned } from '../../core/scene/things.js';
import * as THREE from 'three';
import { resolveClouds } from './clouds.js';
import { resolveDomeLayers } from './domeLayers.js';
import { domeFragment, loadSkybox, skyNodes } from './shader.js';
import { DOME_FOG } from './fog.js';
import { codedError } from '../../core/base/errorHints.js';
import { isWebGPU } from '../../render/backend.js';
import { fogLook } from '../../render/fogLook.js';

const isColorLike = v => typeof v === 'number' || typeof v === 'string' || !!v?.isColor;

/** The fog band's uniforms and GLSL for a new Sky: the extra dome parts ({ uniforms, decl, body }); it starts with no layers, engine.sky.layer adds them */
export function prepareDome(sky, st) {
  sky._backdrop = resolveBackdrop(st);
  const f = DOME_FOG;
  // the fog object belongs to the game and may be replaced: read its color at draw time (fog.js fogBand turns the band on)
  const uniforms = { uFogBand: { value: 0 }, uFogColor: { get value() { return fogLook(sky.engine.scene, sky.engine.renderer)?.color ?? sky.uniforms.uHorizon.value; } } };
  return { uniforms, decl: f.decl, body: f.body, layers: [] };
}

// backdrop: one flat color instead of the dome: no gradient, horizon, sun / moon disk, stars or clouds. The color goes straight to scene.background
// (no tone mapping), so what is written is what shows, and uSkyHorizon reports it so a game's fog can fade far things into it.
function resolveBackdrop(st) {
  const v = st.backdrop;
  if (v == null) return null;
  if (!isColorLike(v)) throw codedError('sky-option', `sky backdrop must be a color (0xefebe4, '#efebe4'); got ${typeof v === 'function' ? 'a function' : JSON.stringify(v)}. A color that changes: engine.sky.backdrop.set(...) each frame`);
  return { color: new THREE.Color(v) };
}

/**
 * engine.sky.clouds / layer / replace and the backdrop's hand-over, closed over one sky's state.
 * @param {any} sky @param {object} st the sky({ ... }) options
 */
export function domeEntries(sky, st) {
  const e = sky.engine, scene = e.scene, U = sky.uniforms;
  // clone: the panorama copy replace() makes of a game's plain Texture; the sky made it, so the sky frees it on the next replace and on dispose (the game's texture stays)
  let cloudsHook = null, added = null, addedHere = false, clone = null;
  // detached before it is freed: a skybox asset still loading leaves the background as it was until it arrives, and a frame drawn meanwhile would upload
  // the freed copy again, which nobody frees afterwards. The base background shows during that wait
  const dropClone = () => {
    if (!clone) return;
    if (scene.background === clone) scene.background = e.baseBackground;
    if (sky.skybox === clone) sky.skybox = null;
    clone.dispose(); clone = null;
  };
  const layers = new Map();
  // a skybox dims with the hour through scene.backgroundIntensity: it comes off with the skybox, or whatever shows next stays dimmed
  const undim = () => { if (sky.skybox && scene.background === sky.skybox) scene.backgroundIntensity = 1; };

  // The dome shader from a clouds function and layers; throws (changing nothing) when a hook is not valid for its contract
  const rebuild = (hook, map) => {
    // WebGPU dome (node material, render/fx/sky.tsl.js): the hooks' tsl forms, checked there before anything changes (apply)
    const gpu = isWebGPU(e.renderer);
    const cl = resolveClouds(st.clouds, hook, gpu);
    const l = resolveDomeLayers([...map.values()].map(v => (typeof v === 'string' ? { glsl: v } : v)), { gpu, names: [...map.keys()] });
    if (gpu) return { nodes: { kind: cl.kind, clouds: hook ?? null, layers: l.layers }, uniforms: { ...cl.uniforms, ...l.uniforms } };
    const f = DOME_FOG;   // the fog band is always in the dome, switched by a uniform (fog.js)
    const text = domeFragment(cl, { decl: [f.decl, l.decl].filter(Boolean).join('\n'), body: f.body + l.body });
    return { text, uniforms: { ...cl.uniforms, ...l.uniforms } };
  };
  // given: the uniforms of the hook being set. Its start values replace the old ones under those names (in place: a game's handle stays live);
  // every other hook's uniforms keep what was written since
  const apply = (r, given) => {
    // node dome: a new color node over the uniforms with the hook's own added (setHooks throws first on a bad hook, the dome unchanged)
    if (r.nodes) skyNodes(e).setHooks(sky.dome.material, { ...r.uniforms, ...U }, r.nodes.kind, e, r.nodes);
    for (const [k, u] of Object.entries(r.uniforms)) { if (!(k in U)) U[k] = u; else if (given && k in given) U[k].value = u.value; }
    if (r.nodes) return;
    if (sky.dome.material.fragmentShader === r.text) return;
    sky.dome.material.fragmentShader = r.text; sky.dome.material.needsUpdate = true;
  };

  return {
    /** the renderer swap (Sky.js) builds a fresh dome; the hooks set since then go back on it */
    reapply() { apply(rebuild(cloudsHook, layers)); },
    clouds(spec) { apply(rebuild(spec, layers), spec?.uniforms); cloudsHook = spec ?? null; },
    layer(name, spec) {
      if (typeof name !== 'string' || !name) throw codedError('sky-option', `engine.sky.layer(name, spec): name is a non-empty string such as 'aurora'; got ${JSON.stringify(name)}`);
      const next = new Map(layers);
      if (spec == null) next.delete(name); else next.set(name, spec);
      apply(rebuild(cloudsHook, next), spec?.uniforms);   // throws before anything changes when the layer's GLSL is not valid
      layers.clear(); for (const [k, v] of next) layers.set(k, v);
    },
    backdrop(v) {
      if (v == null) { sky._backdrop = null; sky.dome.visible = !sky.skybox && !added && !sky._noSky; scene.background = sky.skybox ?? (sky._noSky ? e.baseBackground : null); sky._oBg.mark(); return; }
      if (sky._backdrop && isColorLike(v)) { sky._backdrop.color.set(v); return; }
      sky._backdrop = resolveBackdrop({ backdrop: v });   // the sky writes scene.background and hides the dome each frame (frame.js)
    },
    // The game's own sky (three/addons Sky, a ShaderMaterial dome, a skybox texture) is never written: the engine only hides its dome, adds the
    // object to the scene when it has no parent yet (and takes it out again on hand-back only then), and keeps feeding time / weather / season
    // through engine.uniforms (uSunDir, uDaylight, uTimeOfDay, uWind, uWeatherCloud ...) and the day / season / weather events. A plain Texture gets its
    // panorama mapping on a clone, so the game's texture object stays as it was.
    replace(impl) {
      if (impl !== false && impl != null && typeof impl !== 'string' && !impl.isTexture && !impl.isObject3D) throw codedError('sky-option', 'engine.sky.replace(sky): sky is a skybox asset name, a THREE.Texture or a THREE.Object3D; null gives the dome back, false draws no sky');
      if (added) { if (addedHere) scene.remove(added); added = null; addedHere = false; }
      undim();
      sky._ownSky = null; sky._noSky = impl === false; sky._panorama = null;
      dropClone();   // every branch below replaces the background the copy was on
      // false: no drawn sky. The signals keep running and the scene shows its base background (a game's palette color lives there)
      if (impl === false) { sky.skybox = null; sky._backdrop = null; sky.dome.visible = false; scene.background = e.baseBackground; sky._oBg.manual(false); sky._oBg.mark(); return; }
      if (impl == null) { sky.skybox = null; scene.background = sky._backdrop?.color ?? null; sky.dome.visible = !sky._backdrop; sky._oBg.manual(false); sky._oBg.mark(); return; }
      sky.dome.visible = false; sky._backdrop = null;   // a backdrop left on would be written over this sky every frame
      if (typeof impl === 'string') loadSkybox(sky, impl);
      else if (impl.isTexture) {
        const tex = impl.isCubeTexture || impl.mapping !== THREE.UVMapping ? impl : (clone = Object.assign(impl.clone(), { mapping: THREE.EquirectangularReflectionMapping }));
        scene.background = tex; sky.skybox = tex;
      } else if (impl.isObject3D) {
        addedHere = !impl.parent; if (addedHere) scene.add(engineOwned('sky', impl));
        added = impl; sky._ownSky = impl; scene.background = null; sky.skybox = null;
      }
      sky._oBg.mark();
    },
    /** the module goes: the game's own sky added here and a background the sky wrote go with it; a background the game wrote stays */
    dispose() {
      sky._panorama = null;
      if (added && addedHere) scene.remove(added);
      undim();
      if (scene.background && (scene.background === sky.skybox || scene.background === sky._backdrop?.color)) scene.background = e.baseBackground;
      dropClone();
    },
  };
}
