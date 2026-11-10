// The sky as an environment map (mixed into Sky.prototype): engine.sky.environment({ into?, interval? }) renders the dome into a PMREM target, only once the
// game calls it. Nothing is written anywhere without `into`; asset maps, intensity and rotation are plain three.js (recipes/34).
//
// What three 0.187 does with scene.environment on a MeshLambertMaterial (read from the source, not assumed):
//   - WebGLPrograms.getParameters hands scene.environment to Standard, Lambert and Phong materials (usePMREM is true for Lambert without its own envMap).
//   - lights_fragment_maps adds getIBLIrradiance(normal) = PI * (the PMREM's blurriest mip in the world normal's direction) * envMapIntensity
//     to the diffuse light, so a Lambert surface gets soft, direction-dependent ambient light that is coloured by the environment.
//   - There is no specular term for Lambert with a PMREM map: the cube reflection mix in envmap_fragment only runs for ENVMAP_TYPE_CUBE.
//   - envMapIntensity comes from scene.environmentIntensity and the lookup direction is turned by scene.environmentRotation.
//   - Adding or removing scene.environment changes the program key of every Lambert material: one recompile at the switch, none after.
//   - The hemisphere light adds on top of it.
import * as THREE from 'three';
import { codedError } from '../../core/base/errorHints.js';
import { isWebGPU, webgpuPart } from '../../render/backend.js';

const DEFAULT_INTERVAL = 1;   // seconds between rebuilds (only when the sky actually changed)
const LOW_TIER_SLOWER = 4;    // by default a low-tier device rebuilds this many times less often (an interval the game gives stands): the cube cannot be made smaller (256 px is PMREMGenerator's floor)

// Everything that decides how the procedural sky looks right now: when it stays put the environment is not rebuilt. It walks the dome's own uniforms
// (sun, moon, cloud colour / cover / speed and a game's layer uniforms are all in there, so a new one needs no edit here) and the dome material's
// shader revision (a changed clouds() / layer() hook). uTime is left out: it moves every frame, and cloud drift alone is not worth a rebuild
function skyKey(sky) {
  const f = x => Math.round(x * 400), m = sky.dome.material, parts = [m.uuid, m.version];
  for (const [k, u] of Object.entries(sky.uniforms)) {
    if (k === 'uTime') continue;
    const v = u.value;
    if (typeof v === 'number') parts.push(f(v));
    else if (v?.isColor) parts.push(f(v.r), f(v.g), f(v.b));
    else if (v?.isVector2 || v?.isVector3 || v?.isVector4) parts.push(...v.toArray().map(f));
    else if (v?.isTexture) parts.push(v.uuid);
  }
  return parts.join(',');
}

export const environmentMethods = {
  // engine.sky.environment(): the first build waits for the first frame's colors, later calls build at once
  _envStart({ into = null, interval = null, ...rest } = {}) {
    const bad = Object.keys(rest)[0];
    if (bad) throw codedError('sky-option', `engine.sky.environment({ ${bad} }): the options are into and interval. Intensity and rotation are plain three.js: scene.environmentIntensity, scene.environmentRotation`);
    if (into !== null && typeof into !== 'object') throw codedError('sky-option', 'engine.sky.environment({ into }): into is the object whose .environment is written, usually engine.scene');
    if (interval !== null && (typeof interval !== 'number' || !(interval >= 0))) throw codedError('sky-option', `engine.sky.environment({ interval }): interval is seconds, 0 or more; got ${JSON.stringify(interval)}`);
    this._envOff();   // a second call replaces the first (a new interval, hot reload, another scene); the old handle's remove() then does nothing
    // interval is read at each frame: the default follows the tier (a stored preset arrives after this call, and a later tier change reaches it with no listener);
    // a number the game gave never changes
    const e = this.engine, env = this._env = { into, get interval() { return interval ?? (e.tier === 'low' ? DEFAULT_INTERVAL * LOW_TIER_SLOWER : DEFAULT_INTERVAL); }, key: null, since: 0, builds: 0, target: null, deferred: !this._envFramed };
    // an explicit call takes the map back from a game write; the warning's way back then names this `into`
    this._oEnv.manual(false); this._oEnv.levels = { ...this._oEnv.levels, back: `engine.sky.environment({ into: ${into === e.scene ? 'engine.scene' : 'into'} })` };
    this._oEnv.mark();   // what `into` holds now is the reference: the first build replaces it as before, only a later write by the game is a takeover
    if (!env.deferred) this._envBuild();
    // a lost context takes the map's pixels with it, and the key cannot see that: with the sky standing still (a fixed hour) the map would stay black
    env.restored = this.engine.events.on('page:contextrestored', () => { env.key = null; env.deferred = true; });
    const sky = this;
    return { get texture() { return env.target?.texture ?? null; }, remove() { if (sky._env === env) sky._envOff(); } };
  },

  // Each frame: rebuild when the interval has passed and the sky moved (the first build waits for the first frame's colors)
  _envFrame(dt) {
    this._envFramed = true;
    const e = this._env;
    if (!e) return;
    e.since += dt;
    if (!this._oEnv.on) return;   // the game wrote scene.environment: nothing is rebuilt while the sky has yielded (frame.js watchOwned)
    if (!e.deferred && e.since < e.interval) return;
    e.since = 0; e.deferred = false;
    if (skyKey(this) !== e.key) this._envBuild();
  },

  // Render the dome alone into a cube and prefilter it (PMREM). The dome mesh follows the camera, so a copy sharing its material is rendered
  _envBuild() {
    const e = this._env, r = this.engine.renderer;
    // WebGPURenderer needs three/webgpu's PMREMGenerator (registered by threedog/tsl)
    this._pmrem ??= new (isWebGPU(r) ? webgpuPart('classes', 'engine.sky.environment').PMREMGenerator : THREE.PMREMGenerator)(r);
    if (!this._envScene) {
      this._envScene = new THREE.Scene();
      const copy = new THREE.Mesh(this.dome.geometry, this.dome.material);
      copy.onBeforeRender = (rr, sc, cam) => { copy.scale.setScalar(cam.far * 0.9); copy.updateMatrixWorld(); };
      copy.frustumCulled = false; copy.renderOrder = -1000;
      this._envScene.add(copy);
    }
    /** @type {any} */ (this._envScene.children[0]).material = this.dome.material;   // a game may have set engine.sky.dome.material
    const old = e.target, next = this._pmrem.fromScene(this._envScene, 0, 0.1, 100, { size: 256 });
    // a map the game wrote there is the game's: the owned check (frame.js) has yielded, and the sky writes it no more
    if (e.into && this._oEnv.on) { e.into.environment = next.texture; this._oEnv.mark(); }
    e.target = next; old?.dispose();
    e.builds++; e.key = skyKey(this);
  },

  // Renderer swap (fallback 'webgl'): the generator and the map belong to the old renderer, so the next frame builds them again on the new one
  _envSwap() {
    this._pmrem = null; this._envScene = null;
    if (this._env) { this._env.key = null; this._env.deferred = true; }
  },

  // handle.remove() and module dispose: what the engine wrote comes off, the GPU memory is released
  _envOff() {
    const e = this._env;
    e?.restored.remove();
    if (e?.into && e.target && e.into.environment === e.target.texture) e.into.environment = null;
    e?.target?.dispose();
    this._env = null; this._oEnv?.mark();   // the map it took off is not a write by the game
    this._pmrem?.dispose(); this._pmrem = null; this._envScene = null;
  },
};
