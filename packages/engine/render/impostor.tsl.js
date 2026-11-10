// Impostor cards for far plants (vegetation.define({ impostor })): bake N views around a model into array textures (albedo + normal, alpha = coverage),
// then draw each far plant as a card that turns to the camera and samples the nearest view, lit live through the baked normals.
// Why bake from the species' own model and materials: the card keeps the game's colours, alpha cut and lighting model; the engine adds no look.
// Why one array layer per view (not a flat atlas): low mips of neighbouring views never bleed into each other.
// Why a ring of views (not octahedral): far trees are seen from near eye level in a follow camera, and a ring spends every texel on the side views.
// WebGPU route only (also WebGPURenderer's WebGL2 backend); registered as a WebGPU part like the other .tsl.js files, so WebGL bundles stay as they are.
import * as THREE from 'three/webgpu';   // three/webgpu, not three: threedog/tsl stays WebGL-free (both share three.core.js)
import { MeshBasicNodeMaterial, MeshLambertNodeMaterial, MeshStandardNodeMaterial, MeshToonNodeMaterial } from 'three/webgpu';
import { attribute, cameraPosition, cameraViewMatrix, positionGeometry, vec2, vec3, vec4, float, int, atan, cos, sin, floor, fract, texture, varying, uv, normalLocal, faceDirection, uniform } from 'three/tsl';
import { registerWebGPUPart, holdRenderer, releaseRenderer } from './backend.js';
import { season } from './fx/season.tsl.js';

const TAU = Math.PI * 2;

/** Bounds of a plant around its own vertical axis: the card spans [-r, r] across and [minY, maxY] up (plants stand on their origin) */
function bounds(geometry) {
  const p = geometry.attributes.position;
  let r = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < p.count; i++) { r = Math.max(r, Math.hypot(p.getX(i), p.getZ(i))); lo = Math.min(lo, p.getY(i)); hi = Math.max(hi, p.getY(i)); }
  // a small margin so mip filtering of the outermost leaves never reaches the card edge
  const m = 1.04, h = (hi - lo) || 1;
  return { radius: (r || 0.5) * m, minY: lo - h * (m - 1) / 2, height: h * m };
}

/** What a material renders into the normal layers: its object-space normal packed 0..1, and its own alpha cut so leaf cards keep their outline */
function normalMaterial(m) {
  const alpha = m?.map ? texture(m.map, uv()).a : float(1);
  const n = new MeshBasicNodeMaterial({ side: m?.side ?? THREE.FrontSide });
  n.colorNode = vec4(normalLocal.mul(faceDirection).normalize().mul(0.5).add(0.5), alpha);
  n.alphaTest = m?.alphaTest || (m?.transparent || m?.map ? 0.5 : 0);
  return n;
}

/**
 * Render the views. src: { geometry, material (one or an array matching the geometry's groups) }, the species' own, unpatched.
 * Albedo comes from the game's materials under a white ambient light of intensity PI: three's diffuse BRDF divides irradiance by PI, so the
 * layer holds the surface colour (vertex colours and maps included) with no sun baked in; the live scene lights the card.
 * @returns {{ albedo: THREE.Texture, normal: THREE.Texture, views: number, radius: number, minY: number, height: number, dispose(): void }}
 */
function bake(renderer, src, { views = 8, size = 128 } = {}) {
  const b = bounds(src.geometry);
  // depth > 1: an array texture, one layer per view (three sets isArrayTexture from the depth)
  const mk = () => new THREE.RenderTarget(size, size, { depth: views, type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
  const scene = new THREE.Scene(), holder = new THREE.Group(), mesh = new THREE.Mesh(src.geometry, src.material);
  holder.add(mesh); scene.add(holder, new THREE.AmbientLight(0xffffff, Math.PI));
  const cam = new THREE.OrthographicCamera(-b.radius, b.radius, b.minY + b.height, b.minY, 0.01, b.radius * 6);
  cam.position.set(0, 0, b.radius * 3); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
  const albedo = mk(), normal = mk(), normals = [src.material].flat().map(normalMaterial);
  let done = false;
  // the renderer is borrowed mid-frame: everything the bake changes is put back, whether it finishes or throws (render/backend.js holdRenderer)
  const held = holdRenderer(renderer);
  try {
    renderer.setClearColor(0x000000, 0); renderer.autoClear = true;
    for (const [rt, mat] of [[albedo, src.material], [normal, Array.isArray(src.material) ? normals : normals[0]]]) {
      mesh.material = mat;
      for (let i = 0; i < views; i++) {
        // view i is the plant seen from yaw i/N around it: turning the plant by -yaw shows that side to a camera on +Z (the card's maths in cardMaterial)
        holder.rotation.y = -i * TAU / views; holder.updateMatrixWorld(true);
        renderer.setRenderTarget(rt, i);
        renderer.render(scene, cam);
      }
    }
    done = true;
  } finally {
    releaseRenderer(held);
    for (const n of normals) n.dispose();
    if (!done) { albedo.dispose(); normal.dispose(); }   // a failed bake leaves no render targets behind
  }
  return { albedo: albedo.texture, normal: normal.texture, views, ...b, dispose() { albedo.dispose(); normal.dispose(); } };
}

/**
 * The card material. Per instance (InstancedBufferGeometry): aCenter (world position of the plant), aShape (yaw, across scale, up scale; 0 scale =
 * felled, the card collapses to a point), aTint (instance colour, as InstancedMesh's instanceColor tints the mesh). The material class follows the
 * species' first material (toon stays toon, unlit stays unlit), so the card answers the scene's lights the way the mesh does.
 */
function cardMaterial(src, b) {
  const m0 = [src.material].flat()[0], type = m0?.type ?? '';
  const C = /Toon/.test(type) ? MeshToonNodeMaterial : /Basic/.test(type) ? MeshBasicNodeMaterial : /Lambert|Phong/.test(type) ? MeshLambertNodeMaterial : MeshStandardNodeMaterial;
  const m = /** @type {any} */ (new C());
  if (m0?.gradientMap && 'gradientMap' in m) m.gradientMap = m0.gradientMap;
  if (m.isMeshStandardNodeMaterial) { m.roughness = m0?.roughness ?? 1; m.metalness = 0; }
  m.alphaTest = 0.5;
  const N = b.views, center = attribute('aCenter', 'vec3'), shape = attribute('aShape', 'vec3');
  const toCam = cameraPosition.sub(center), ang = /** @type {any} */ (atan)(toCam.x, toCam.z);   // the camera's yaw seen from the plant
  // nearest baked view in the plant's own frame; fract keeps it positive whatever the yaw (a % of a negative stays negative in WGSL)
  const cell = floor(fract(ang.sub(shape.x).div(TAU).add(0.5 / N).add(4)).mul(N));
  const right = vec3(cos(ang), 0, sin(ang).negate());
  const across = uniform(b.radius * 2), up = uniform(b.height), minY = uniform(b.minY);
  const pg = /** @type {any} */ (positionGeometry);
  m.positionNode = center.add(right.mul(pg.x.mul(across).mul(shape.y))).add(vec3(0, pg.y.mul(up).add(minY).mul(shape.z), 0));
  // the layers come out upside down against the card's uv on both WebGPU backends (render-target rows), so read them flipped
  const layer = int(/** @type {any} */ (varying(cell)).add(0.5)), st = vec2(uv().x, uv().y.oneMinus());
  const alb = texture(b.albedo, st).depth(layer);
  // the season tint the mesh gets from its patches (effects on), so autumn reaches the far cards too; the bake itself is untinted
  const rgb = alb.rgb.mul(attribute('aTint', 'vec3'));
  m.colorNode = vec4(src.season ? season(rgb, 0) : rgb, alb.a);
  if (!m.isMeshBasicNodeMaterial) {
    // baked normal is in the plant's own frame: turn it by the plant's yaw into the world, then into view space (what normalNode takes)
    const n = texture(b.normal, st).depth(layer).rgb.mul(2).sub(1), y = shape.x, c = cos(y), s = sin(y);
    const world = vec3(n.x.mul(c).add(n.z.mul(s)), n.y, n.z.mul(c).sub(n.x.mul(s)));
    m.normalNode = cameraViewMatrix.mul(vec4(world, 0)).xyz.normalize();
  }
  return m;
}

registerWebGPUPart('impostor', Object.freeze({ bake, cardMaterial }));
