# Particles: dust, smoke, sparks, splashes

> **Covers:** particles: dust, smoke, sparks, splashes; values over life, emitters, soft edges.
> **Use when:** short-lived effects in numbers.
> **Shortest:** `engine.use(particles({ effects: { dust: { … } } }))`, then `engine.particles.emit('dust', p)`.
> **Sections:** Where a value comes · Values over life · Fast emitters · Soft edges · Lit particles · The material · Weather

```js fragment
import { particles } from 'threedog';
engine.use(particles({
  default: { color: 0xc8b89a },  // what every effect starts from
  effects: { dust: { max: 300, lifetime: [0.6, 1.2], size: [0.3, 0.8], opacity: [0.6, 0] } },  // the effects, by name
}));
engine.particles.emit('dust', player.position, { count: 20 });  // a name in effects needs no define()
engine.particles.define('smoke', { gravity: 0.4, size: [0.5, 2] });
const chimneySmoke = engine.particles.attach('smoke', chimney, { rate: 8, offset: [0, 2, 0] });
chimneySmoke.remove();
```
One effect is one `THREE.Points`, one draw call. Parameters and their fallbacks: `api/particles.md`.
With no options an effect is a soft gray dot.

## Where a value comes from
Lowest to highest: the neutral fallback, `particles({ default })`, `particles({ effects: { name } })`, `define(name, params)`, then `overrides` of one
`emit` or `attach`. So the game's picture can sit in one table and a line of play code writes only what it decides: `define('leaves', { max: 200 })`.

## Values over life
`size`, `color` and `opacity` take one value, `[birth, death]`, or more stops: evenly spaced, or timed from 0 (birth) to 1 (death).
```js
engine.particles.define('flash', { size: [0.2, 1.5, 0.4] });  // evenly spaced
engine.particles.define('puff', { opacity: [[0, 0], [0.1, 0.7], [1, 0]] });  // fades in, then out
engine.particles.define('ember', { color: [[0, 0xffffff], [0.3, 0xffaa33], [1, 0x331100]] });
```
Before the first time and after the last, the end stop holds. A stop list in `overrides` belongs to that batch.

## Fast emitters
`rate` is per second, so a fast emitter leaves beads. `ratePerMeter` is per meter it moves, on top of `rate`, with the particles spread along the path of that step.
```js fragment
engine.particles.define('trail', { rate: 0, ratePerMeter: 6, lifetime: [0.4, 0.6], max: 200 });
const trail = engine.particles.attach('trail', rocket);
trail.ratePerMeter = 12;  // live; attach(name, object, { ratePerMeter }) sets it too
```
Set `max` to what the trail needs: a step that earns more keeps the newest. A teleport counts as moving: set `active = false` for a frame around it. While frozen nothing is born.

## Soft edges
`soft` is the distance in meters over which a particle fades where it meets what writes depth, so smoke on the ground has no hard line. It is off by default, set at `define`, and live
through `fx.uniforms.uSoft.value`.
```js
engine.particles.define('smoke', { gravity: 0.4, size: [0.5, 2], soft: 0.5 });
```
What it costs, only while a soft effect is on screen. On WebGPU, one copy of the depth buffer per render, shared by every soft effect. On WebGLRenderer a shader
cannot read the depth it draws into, so the scene is drawn once more, depth only, per render, shared the same way: that is real cost in a large scene, and it sees surfaces without their
wind, displacement or alphaTest. On WebGPURenderer's WebGL2 backend (the fallback where WebGPU is missing) three's depth copy works only with post and antialias on; elsewhere there the
particles draw hard and the console says so. `soft` applies to the engine's material, not to one of yours.

## Lit particles
By default a particle's color is drawn as given (dust looks the same in a dark mine and in a bright spot). `lit: true` lets the scene's lights tint it:
```js
engine.particles.define('dust', { max: 300, color: 0xc8b89a, opacity: [0.6, 0], lit: true });   // dark away from the light, warm beside it
```
Each particle gets what a matte card facing every light would show (Lambert, no facing). Shadows, environment map, probes and area lights do not count: dust behind a wall still sees the light, and with only an environment map it goes dark (add an ambient or hemisphere light). CPU cost: live particles x lights per frame, same on both renderers; set at `define`, not per batch.

## The material
```js
const sparks = engine.particles.define('sparks', { blending: 'additive' });
sparks.material = new THREE.PointsMaterial({ size: 0.2, color: 0xffaa33 });  // WebGLRenderer: drawn as given
sparks.material = null;  // the engine's back
sparks.uniforms.uMaxPx.value = 64;  // live
```
`.material` is the effect's plain three.js material, `.points` what draws it. Particle age reaches the picture through the geometry attributes `aSize`,
`aAlpha`, `aColor`, `aAngle`: a material that ignores them shows every particle alike, and one that wants the fade reads them, as
`modules/particles/shaders.js` does. `aLife` is the life fraction, 0 at birth and 1 at death, for a flipbook, a gradient or a dissolve of your own. Empty slots stay in the
buffer with `aAlpha` 0, so give them size 0 as the engine's shader does.
```js fragment
// GLSL (WebGLRenderer), in the vertex shader: attribute float aLife; attribute float aAlpha;
// TSL (WebGPURenderer, a new game's route): import { PointsNodeMaterial } from 'three/webgpu'; import { attribute, color, mix, vec4 } from 'three/tsl';
const m = new PointsNodeMaterial({ transparent: true, depthWrite: false, sizeAttenuation: false });
m.colorNode = vec4(mix(color(0x00ff00), color(0xff0000), attribute('aLife', 'float')), attribute('aAlpha', 'float'));
sparks.material = m;  // placed and sized by the engine's nodes, unless m sets positionNode / sizeNode (the particle's place is attribute('aPos', 'vec3'))
```
A flipbook is the same material with a texture. Each route has its own y: `uv()` runs up, `gl_PointCoord` runs down.
```js fragment
import { attribute, float, floor, mod, texture, uv, vec2, vec4 } from 'three/tsl';
// a 4 x 4 sheet, first frame at the top left
const f = floor(attribute('aLife', 'float').mul(16)), col = mod(f, 4), row = floor(f.div(4));
const cell = texture(sheet, vec2(uv().x.add(col).div(4), uv().y.add(float(3).sub(row)).div(4)));
m.colorNode = vec4(cell.rgb, cell.a.mul(attribute('aAlpha', 'float')));
// GLSL, in a ShaderMaterial that writes gl_PointSize from aSize, uScale and uMaxPx as shaders.js does (vLife: aLife passed on as a varying):
// float f = floor(vLife * 16.0); vec2 cell = vec2(mod(f, 4.0), floor(f / 4.0));
// vec4 c = texture2D(uSheet, vec2((gl_PointCoord.x + cell.x) / 4.0, 1.0 - (gl_PointCoord.y + cell.y) / 4.0));
```
`.uniforms` (`uMap`, `uHasMap`, `uScale`, `uMaxPx`) are written whichever material is drawn; a `ShaderMaterial` of yours can
share them, `uScale` being the pixels per meter at distance 1. Your material is yours: the engine never disposes it, and defining the effect again goes back to
the engine's. On WebGPURenderer the effect is a sprite quad drawn once per particle, so a material of yours is a node material there (recipe 56), and any other is refused.

## Weather
Rain and snow are separate, because they follow the camera and fade with the weather: `engine.weather.particles` (recipe 44).
