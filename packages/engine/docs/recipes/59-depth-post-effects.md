# A post effect that reads depth (volumetric fog, god rays)

> **Covers:** a post effect that reads depth on both renderers: volumetric fog, god rays.
> **Use when:** an effect needs the distance behind each pixel.
> **Shortest:** a Pass that reads the depth texture (§1).
> **Sections:** One effect, both renderers · Volumetric fog march along · God rays

Fog you march through, light shafts, haze that thickens with distance, edge or focus effects: they all read the scene depth behind each pixel
and turn it into a distance or a world position. This recipe writes one such effect with both forms, a three.js `Pass` (GLSL) for
WebGLRenderer and a TSL node for WebGPURenderer, in one effect object. How effects are ordered, switched and tuned is recipe 52's
[Post effect chain](52-around-the-picture.md#post-effect-chain); the TSL side in general is [recipe 56](56-webgpu-tsl.md#post-effects-as-nodes).
For plain distance or height fog on materials, `engine.scene.fog` is enough (recipe 34).

## One effect, both renderers
`needsDepth: true` gives the WebGL pass the scene depth as `readBuffer.depthTexture`; on WebGPU the same depth is `ctx.scenePass.getTextureNode('depth')`.
Both turn the stored depth into the view distance with the camera's near and far. Number and color params are live: `handle.set()` writes
them without a rebuild (WebGL through `update`, WebGPU through the uniforms in `ctx.p`).
```js
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

class DepthHazePass extends Pass {
  constructor(camera) {
    super();
    this.camera = camera;
    this.material = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, tDepth: { value: null }, uNear: { value: 0.1 }, uFar: { value: 1000 },
        uColor: { value: new THREE.Color() }, uDensity: { value: 0.02 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform float uNear, uFar, uDensity; uniform vec3 uColor; varying vec2 vUv;
        void main() {
          vec4 base = texture2D(tDiffuse, vUv);
          float z = texture2D(tDepth, vUv).x * 2.0 - 1.0;
          float dist = 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));  // view distance in world units
          gl_FragColor = vec4(mix(base.rgb, uColor, 1.0 - exp(-uDensity * dist)), base.a);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer, readBuffer) {
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture; u.tDepth.value = readBuffer.depthTexture;
    u.uNear.value = this.camera.near; u.uFar.value = this.camera.far;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
  dispose() { this.material.dispose(); this.quad.dispose(); }
}

// WebGPU: the same math as a node. onRenderUpdate's callback RETURNS the new value (it is not handed one to edit)
function depthHazeNode(input, { tsl: T, scenePass, camera, p }) {
  const near = T.uniform(camera.near).onRenderUpdate(() => camera.near), far = T.uniform(camera.far).onRenderUpdate(() => camera.far);
  const depth = scenePass.getTextureNode('depth').sample(T.screenUV).x;
  const dist = T.perspectiveDepthToViewZ(depth, near, far).negate();
  return T.vec4(T.mix(input.rgb, p.color, T.float(1).sub(T.exp(p.density.mul(dist).negate()))), input.a);
}

const update = (pass, p) => { pass.material.uniforms.uColor.value.copy(p.color); pass.material.uniforms.uDensity.value = p.density; };
engine.post.add({ name: 'depthHaze', slot: 'hdr', needsDepth: true, params: { color: new THREE.Color(0.72, 0.76, 0.82), density: 0.02 },
  create: ({ camera, params }) => { const pass = new DepthHazePass(camera); update(pass, params); return pass; }, update, node: depthHazeNode });
engine.post.get('depthHaze').set({ density: 0.05 });  // live on both renderers
```
- Slot `hdr`: the effect works in linear color, before tone mapping, so a bright sun shaft can bloom after it.
- A world position instead of a distance (height fog, a fog volume): on WebGL multiply the clip-space point by `camera.projectionMatrixInverse`,
  then `camera.matrixWorld` (pass both as uniforms each frame); on WebGPU scale the view ray by the view depth and use `T.cameraWorldMatrix`.
  Both routes must give the same point; compare them with `threedog shot` on each renderer.
- Depth order: a depth reader runs before any pass that swaps buffers; recipe 52 says how `order` keeps it so and what throws when it does not.

## Volumetric fog: march along the ray
A raymarch adds up fog in steps from the camera to the depth found above. On WebGPU the march is a `Loop`, and a `Loop` (like `If` or
`.addAssign`) is a statement: it must be written inside an `Fn`, or three drops it with no error and the fog vanishes (the engine warns in dev
for an effect's node). On WebGL it is a plain `for` loop in the fragment shader.
```js
// WebGPU: give it as an effect's node, beside a create() whose GLSL marches with a for loop
function marchedFogNode(input, { tsl: T, p }) {
  return T.Fn(() => {
    const acc = T.float(0).toVar();
    T.Loop(16, ({ i }) => { acc.addAssign(p.density.mul(T.float(i).add(0.5))); });  // your density per step goes here
    return T.vec4(T.mix(input.rgb, p.color, acc.clamp(0, 1)), input.a);
  })();
}
```
## God rays
Light shafts from the sun: sample the color (or a mask: depth at the far plane is sky) along the line from each pixel toward the sun's point on
screen and add it up with falling weight. The sun's screen point is `engine.uniforms.uSunDir` projected with the camera each frame; when it is
behind the camera, fade the effect out. The color at other pixels needs the input as a texture: on WebGPU `ctx.display.texture(input)`, on
WebGL the pass's `readBuffer.texture`.
