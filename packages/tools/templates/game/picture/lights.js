// @ts-check
// __NAME__ lights: a sun (the key) that follows uSunDir and uDaylight, and the environment as the fill. update() runs once per drawn frame.
import { THREE } from 'threedog';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
__PMREM_IMPORT__
import { palette } from './palette.js';

const SHADOW_BOX = 40, SHADOW_SNAP = 0.5;   // meters: half the box around the focus; the box moves in steps so shadow edges do not crawl while walking

/** @param {any} engine @param {any} ctx the picture module's ctx: what is added here leaves with it */
export function createLights(engine, ctx) {
  const { sun: S, environment: E } = palette, noSky = new THREE.Vector3(...S.direction).normalize();
  const sun = new THREE.DirectionalLight(S.color, S.noon);
  sun.name = 'sun';   // the 'sun' slot finds the main light by this name
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(S.shadowMap[engine.tier]);   // the picture reads the quality tier itself: the engine cannot hold this code to it
  Object.assign(sun.shadow.camera, { left: -SHADOW_BOX, right: SHADOW_BOX, bottom: -SHADOW_BOX, top: SHADOW_BOX, near: 1, far: 250 });
  // three 0.187: the default PCFShadowMap filters softly and radius widens the edge. Stripes on lit faces: more normalBias; a gap under a foot: less (shot names both)
  sun.shadow.bias = -0.0001; sun.shadow.normalBias = 0.03; sun.shadow.radius = S.shadowRadius;
  engine.scene.add(sun, sun.target);
  ctx.track({ remove() { engine.scene.remove(sun, sun.target); sun.dispose(); engine.scene.environmentIntensity = 1; } });   // 1: three's own default

  return {
    sun,
    // Rewrites sun.intensity, sun.position and scene.environmentIntensity every frame: to change them, change this function; a write elsewhere lasts one frame.
    /** @param {any} signals engine.uniforms */
    update(signals) {
      sun.target.position.copy(engine.focus).divideScalar(SHADOW_SNAP).round().multiplyScalar(SHADOW_SNAP);
      // Without a sky uSunDir points straight up, which lights every top alike and hides shadows under things: a fixed slant from the palette instead
      sun.position.copy(engine.sky ? signals.uSunDir.value : noSky).multiplyScalar(100).add(sun.target.position);
      const day = signals.uDaylight.value;
      sun.intensity = S.noon * day * signals.uWeatherLight.value;   // uWeatherLight: 1 in clear weather, lower under rain
      // The fill dims toward night too, so a night is dark because the light is. Without a sky uDaylight stays 1 and the fill holds
      engine.scene.environmentIntensity = E.intensity * (E.night + (1 - E.night) * day);
    },
  };
}

// The fill: a neutral studio room (three's RoomEnvironment), prefiltered once, so it costs nothing per frame. scene.environment is plain three.js:
// an .hdr panorama goes there the same way (recipe 34), and engine.sky.environment({ into: engine.scene, interval }) makes the sky dome the map, colored
// by the sky and re-rendered as the sky changes (cheap: the same map is refilled). With it, take the night dimming out of update(): the map darkens by itself.
// Called from the module's init, not install: prefiltering draws, and the renderer is ready only once start() begins the inits.
/** @param {any} engine @param {any} ctx */
export function createFill(engine, ctx) {
  const pmrem = new __PMREM__(engine.renderer), room = new RoomEnvironment();
  const map = pmrem.fromScene(room, 0.04);
  room.dispose(); pmrem.dispose();
  ctx.borrow(engine.scene, { environment: map.texture });
  ctx.track({ remove() { map.dispose(); } });
}
