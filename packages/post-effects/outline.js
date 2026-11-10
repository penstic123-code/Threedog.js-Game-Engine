// Outline post effect: dark lines where depth jumps (object silhouettes), where surface normals turn sharply (creases), or both;
// optional hand-drawn wobble and per-object exemption through a three.js layer.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { RESERVED_LAYERS } from 'threedog/layers';
import { codedError } from 'threedog/error-hints';
import { FULLSCREEN_VERT, DEPTH_GLSL, depthUniforms, writeDepthUniforms, depthNodes } from './depth.js';
import { declared } from './about.js';
/** @import { PostEffect } from 'threedog' */

/** Layer number to put on objects that should get no outline: mesh.layers.enable(OUTLINE_OFF_LAYER), with outline({ offLayer: OUTLINE_OFF_LAYER }) */
export const OUTLINE_OFF_LAYER = RESERVED_LAYERS.outlineOff;
const MODES = { depth: 0, normal: 1, both: 2 };
// linear (0.5, 0.5, 1): an empty pixel reads as a normal facing the camera, and for the mask its red 0.5 stays below the > 0.5 test
const EMPTY = new THREE.Color().setRGB(0.5, 0.5, 1, THREE.LinearSRGBColorSpace);
const badMode = mode => codedError('post-effect', `outline: unknown mode '${mode}', use 'depth' | 'normal' | 'both'`);

class OutlinePass extends Pass {
  /** @param {any} scene @param {any} camera @param {Record<string, any>} p @param {(renderer: any, draw: () => void, opts?: object) => void} borrow ctx.borrowRenderer, the engine's renderer borrow */
  constructor(scene, camera, p, borrow) {
    super();
    this.scene = scene; this.camera = camera; this.p = p; this.time = 0; this.borrow = borrow;
    this.normalMat = new THREE.MeshNormalMaterial();
    this.maskMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.normalRT = null; this.maskRT = null;
    this.material = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, tDepth: { value: null }, tNormal: { value: null }, tMask: { value: null }, tMaskDepth: { value: null },
        uTexel: { value: new THREE.Vector2() }, ...depthUniforms(), uColor: { value: new THREE.Color(p.color) },
        uThick: { value: 1 }, uStrength: { value: 1 }, uMode: { value: 0 }, uFade: { value: 1 }, uWobble: { value: 0 }, uTime: { value: 0 }, uUseMask: { value: 0 } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: `uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform sampler2D tNormal; uniform sampler2D tMask; uniform sampler2D tMaskDepth;
        uniform vec2 uTexel; uniform vec3 uColor; uniform float uThick; uniform float uStrength;
        uniform float uMode; uniform float uFade; uniform float uWobble; uniform float uTime; uniform float uUseMask;
        varying vec2 vUv;
        ${DEPTH_GLSL}
        #include <threedog_noise>
        // object in the exempt layer at this pixel: its own render is not behind what the scene depth saw
        float masked(vec2 uv){ return texture2D(tMask, uv).r > 0.5 && lin(tMaskDepth, uv) <= lin(tDepth, uv) + 0.05 ? 1.0 : 0.0; }
        void main(){
          vec4 c = texture2D(tDiffuse, vUv);
          vec2 o = uTexel * uThick;
          vec2 uv = vUv;
          if (uWobble > 0.0) uv += (vec2(threedogNoise(vUv / uTexel * 0.04 + uTime), threedogNoise(vUv / uTexel * 0.04 + 17.3 + uTime)) - 0.5) * 2.0 * uWobble * uTexel;
          vec2 nb[4] = vec2[4](vec2(o.x, 0.0), vec2(-o.x, 0.0), vec2(0.0, o.y), vec2(0.0, -o.y));   // the four neighbors, thickness apart
          float d = lin(tDepth, uv), edge = 0.0;
          if (uMode != 1.0) {
            float e = 0.0;
            for (int i = 0; i < 4; i++) e += abs(lin(tDepth, uv + nb[i]) - d);
            edge = smoothstep(0.08, 0.3, e / max(d, 0.5) * 4.0);
          }
          if (uMode != 0.0) {
            vec3 n = texture2D(tNormal, uv).xyz * 2.0 - 1.0;
            float k = 0.0;
            for (int i = 0; i < 4; i++) k += 1.0 - dot(n, texture2D(tNormal, uv + nb[i]).xyz * 2.0 - 1.0);
            edge = max(edge, smoothstep(0.35, 0.8, k));
          }
          if (uFade > 0.5) edge *= 1.0 - smoothstep(uFar * 0.4, uFar * 0.9, d);
          if (uUseMask > 0.5) { float m = masked(vUv); for (int i = 0; i < 4; i++) m = max(m, masked(vUv + nb[i])); edge *= 1.0 - m; }
          gl_FragColor = vec4(mix(c.rgb, uColor, edge * uStrength), c.a);
        }`,
    });
    this.quad = new FullScreenQuad(this.material);
  }
  // Render the scene once with an override material into a target the size of the input
  _pass(renderer, rt, mat, layer) {
    const { scene, camera } = this;
    // what was there goes back, even when the render throws (the engine's one borrow): an override may be a debug view's, and it must outlive this pass
    this.borrow(renderer, () => {
      scene.overrideMaterial = mat; scene.background = null; scene.fog = null;
      if (layer != null) camera.layers.set(layer);
      renderer.setClearColor(EMPTY, 1);
      renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, camera);
    }, { scene, camera });
  }
  _target(rt, w, h, depth) {
    if (rt && (rt.width !== w || rt.height !== h)) { rt.setSize(w, h); return rt; }
    if (rt) return rt;
    rt = new THREE.WebGLRenderTarget(w, h);
    if (depth) rt.depthTexture = new THREE.DepthTexture(w, h);
    return rt;
  }
  render(renderer, writeBuffer, readBuffer, deltaTime) {
    const u = this.material.uniforms, p = this.p, mode = MODES[p.mode], w = readBuffer.width, h = readBuffer.height;
    // wobble redraws at 8 steps a second, like a hand-drawn flip book, so the lines tremble instead of swimming
    this.time = (this.time + deltaTime) % 64;
    if (mode !== 0) { this.normalRT = this._target(this.normalRT, w, h, true); this._pass(renderer, this.normalRT, this.normalMat); u.tNormal.value = this.normalRT.texture; }
    const useMask = p.offLayer != null;
    if (useMask) { this.maskRT = this._target(this.maskRT, w, h, true); this._pass(renderer, this.maskRT, this.maskMat, p.offLayer); u.tMask.value = this.maskRT.texture; u.tMaskDepth.value = this.maskRT.depthTexture; }
    u.tDiffuse.value = readBuffer.texture; u.tDepth.value = readBuffer.depthTexture;
    u.uTexel.value.set(1 / w, 1 / h);
    writeDepthUniforms(u, this.camera);
    u.uMode.value = mode; u.uUseMask.value = useMask ? 1 : 0; u.uTime.value = Math.floor(this.time * 8);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
  dispose() { this.material.dispose(); this.quad.dispose(); this.normalMat.dispose(); this.maskMat.dispose(); this.normalRT?.dispose(); this.maskRT?.dispose(); }
}

function apply(pass, p) {
  if (!(p.mode in MODES)) throw badMode(p.mode);
  pass.p = p;
  const u = pass.material.uniforms;
  u.uColor.value.set(p.color); u.uThick.value = p.thickness; u.uStrength.value = p.strength; u.uFade.value = p.fadeWithDistance ? 1 : 0; u.uWobble.value = p.wobble;
}

/**
 * Dark lines (cartoon look), hdr slot, before bloom so the glow does not blur the lines.
 * mode 'depth' (default): silhouettes where depth jumps; 'normal': creases where surface normals turn (the scene is drawn once more with
 * normals; heavy on weak devices); 'both': either. Objects can opt out of the lines with offLayer.
 * @example
 * engine.post.add(outline({ color: 0x222222, thickness: 1.5 }))
 * engine.post.add(outline({ mode: 'both', wobble: 1.5, offLayer: OUTLINE_OFF_LAYER }))   // hand-drawn; then: sky.layers.enable(OUTLINE_OFF_LAYER)
 * @param {{ color?: any, thickness?: number, strength?: number, mode?: 'depth' | 'normal' | 'both', fadeWithDistance?: boolean, wobble?: number,
 *   offLayer?: number | null, enabled?: boolean, order?: number }} [o]
 *   fadeWithDistance: lines fade out in the far 40..90% of the camera range (default true); wobble: line jitter in pixels (0 = straight);
 *   offLayer: objects with this three.js layer enabled get no outline (costs one extra render of just those objects; null = off)
 * @returns {PostEffect}
 */
export function outline({ color = 0x222222, thickness = 1, strength = 0.8, mode = 'depth', fadeWithDistance = true, wobble = 0, offLayer = null, enabled, order = 10 } = {}) {
  return { ...declared(outline), name: 'outline', slot: 'hdr', order, enabled, needsDepth: true, params: { color, thickness, strength, mode, fadeWithDistance, wobble, offLayer },
    create: ({ scene, camera, params, borrowRenderer }) => { const pass = new OutlinePass(scene, camera, params, borrowRenderer); apply(pass, params); return pass; },
    update: apply, node: outlineNode };
}

/**
 * WebGPU: the same steps as OutlinePass's fragment shader, as one node (not three's OutlineNode, which outlines selected objects, a different
 * effect). Depth comes from the scene pass; the normal and mask views are extra scene renders made through ctx.display.pass, so this file never
 * imports three/webgpu. Number / boolean params are live uniforms (ctx.p); mode and offLayer on / off rebuild the node, as any non-number param does.
 * @param {any} input @param {any} ctx
 */
function outlineNode(input, { tsl: T, fx, display, scenePass, scene, camera, params, p, borrowRenderer }) {
  const mode = MODES[params.mode];
  if (mode === undefined) throw badMode(params.mode);
  const { far, lin } = depthNodes(T, camera);
  // the color param may be a number (then ctx.p holds a float uniform, not a color) or a Color: read the param itself every render
  const tint = new THREE.Color(), col = T.uniform(tint).onRenderUpdate(() => { tint.set(params.color); });
  const depthTex = scenePass.getTextureNode('depth');
  const texel = T.vec2(1).div(T.screenSize), o = texel.mul(p.thickness), base = T.screenUV;
  const nb = [T.vec2(o.x, 0), T.vec2(o.x.negate(), 0), T.vec2(0, o.y), T.vec2(0, o.y.negate())];   // the four neighbors, thickness apart
  // wobble: value noise on the pixel grid, redrawn 8 times a second (flip-book trembling); the GLSL counts its own clock modulo 64 s the same way
  const tick = T.floor(T.mod(T.time, 64).mul(8)), px = base.div(texel).mul(0.04);
  const jitter = T.vec2(fx.noise(px.add(tick)), fx.noise(px.add(17.3).add(tick))).sub(0.5).mul(2).mul(p.wobble).mul(texel);
  const uv = T.select(p.wobble.greaterThan(0), base.add(jitter), base);
  const d = lin(depthTex, uv);
  let edge = T.float(0);
  if (mode !== 1) {
    const e = nb.reduce((s, n) => s.add(lin(depthTex, uv.add(n)).sub(d).abs()), T.float(0));
    edge = T.smoothstep(0.08, 0.3, e.div(T.max(d, 0.5)).mul(4));
  }
  // An extra render of the scene with one material, no background or fog. three's MeshNormalNodeMaterial stores its packed normal as an sRGB
  // color (decoded to linear, so the canvas looks like WebGL's), unlike WebGL's MeshNormalMaterial in a render target, so the sample is
  // re-encoded with the sRGB curve before unpacking; the clear is the sRGB (0.5, 0.5, 1) for the same reason: an empty pixel then reads as a
  // normal facing the camera (as OutlinePass._pass), and for the mask its red (0.21 linear) stays below the > 0.5 test
  const view = (mat, layer) => {
    const v = display.pass(scene, camera);
    v.overrideMaterial = mat;
    const L = layer && new THREE.Layers(), run = v.updateBefore.bind(v), free = v.dispose.bind(v), clear = new THREE.Color();
    if (L) v.setLayers(L);
    v.updateBefore = frame => {
      if (L) L.set(params.offLayer);
      // the engine's one borrow gives the clear and the scene's background / fog back, also when the pass throws
      borrowRenderer(frame.renderer, () => {
        frame.renderer.setClearColor(clear.setRGB(0.5, 0.5, 1, THREE.SRGBColorSpace), 1);
        scene.background = scene.backgroundNode = null; scene.fog = null;   // three prefers backgroundNode over background, so both go
        run(frame);
      }, { scene });
    };
    v.dispose = () => { free(); mat.dispose(); };
    return v;
  };
  if (mode !== 0) {
    const nTex = view(new THREE.MeshNormalMaterial()).getTextureNode(), unpack = q => T.sRGBTransferOETF(nTex.sample(q).xyz).mul(2).sub(1), n = unpack(uv);
    const k = nb.reduce((s, q) => s.add(T.float(1).sub(T.dot(n, unpack(uv.add(q))))), T.float(0));
    edge = T.max(edge, T.smoothstep(0.35, 0.8, k));
  }
  edge = edge.mul(T.select(p.fadeWithDistance.greaterThan(0.5), T.float(1).sub(T.smoothstep(far.mul(0.4), far.mul(0.9), d)), T.float(1)));
  if (params.offLayer != null) {
    const m = view(new THREE.MeshBasicMaterial({ color: 0xffffff }), true), mTex = m.getTextureNode(), mDepth = m.getTextureNode('depth');
    // object in the exempt layer at this pixel: its own render is not behind what the scene depth saw (unwobbled uv, as the GLSL)
    const masked = q => T.select(mTex.sample(q).r.greaterThan(0.5).and(lin(mDepth, q).lessThanEqual(lin(depthTex, q).add(0.05))), T.float(1), T.float(0));
    edge = edge.mul(T.float(1).sub(nb.reduce((s, q) => T.max(s, masked(base.add(q))), masked(base))));
  }
  return T.vec4(T.mix(input.rgb, col, edge.mul(p.strength)), input.a);
}

// the picture menu facts of each effect (about.js says why they sit on the factory)
outline.about = { cost: 'medium', on: 'engine.post.add(outline())', recipe: 'recipes/52-around-the-picture.md "Post effect chain"', limits: "one color for every edge; mode 'depth' misses edges between surfaces at one depth" };
