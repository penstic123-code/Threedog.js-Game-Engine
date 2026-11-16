// @ts-check
// ?env=1: soft light from the sky. A gradient of the sky's two colors over the ground color, turned into an environment map by three's PMREMGenerator;
// it darkens by itself at night because the colors do. Only built when asked for: every lit material recompiles the moment scene.environment appears.
import { THREE } from '../../../index.js';
import { ENV } from './palette.js';

/** @param {any} engine @param {THREE.Light[]} ambients the lights the environment takes over part of */
export function createEnv(engine, ambients) {
  const { renderer, scene } = engine, pmrem = new THREE.PMREMGenerator(renderer);
  const u = { uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGround: { value: new THREE.Color(ENV.ground) } };
  const room = new THREE.Scene();
  room.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, uniforms: u,
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uGround; varying vec3 vDir;
      void main(){ vec3 d = normalize(vDir); gl_FragColor = vec4(d.y < 0.0 ? uGround : mix(uHorizon, uTop, smoothstep(0.0, 0.5, d.y)), 1.0); }`,
  })));
  scene.environmentIntensity = ENV.intensity;
  let target = /** @type {THREE.WebGLRenderTarget | null} */ (null), built = '', last = -Infinity;
  return {
    /** Runs after the picture under test wrote this frame's sky and lights @param {any} s engine.uniforms */
    update(s) {
      for (const light of ambients) light.intensity *= ENV.hemi;
      const now = engine.time.now('real');
      if (now - last < (engine.tier === 'low' ? ENV.lowInterval : ENV.interval)) return;   // read each frame: a settings preset changes the tier while running
      last = now;
      const key = s.uSkyTop.value.getHexString() + s.uSkyHorizon.value.getHexString();
      if (key === built) return;   // a fixed sky costs one build, however long the page runs
      built = key;
      u.uTop.value.copy(s.uSkyTop.value); u.uHorizon.value.copy(s.uSkyHorizon.value);
      const old = target;
      target = pmrem.fromScene(room);
      scene.environment = target.texture;
      old?.dispose();
    },
  };
}
