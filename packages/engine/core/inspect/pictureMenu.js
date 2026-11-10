// engine.catalog('picture'): every picture capability on one line each: on now, can it run here, rough cost, one way to turn it on, where it is
// explained, what it cannot do. Capabilities only, never values: no row says how strong or which color. Read live, so nothing drifts:
//   three's own features: the small table below (the only list in the engine; each row reads its "on" off the scene and renderer)
//   post effects in the chain: their own definition's `about` (@threedog/post-effects puts it on every effect), "runs here" from the chain's rule
//   effects not added yet: `offered` (factories with .about); the dev bridge passes the ones of @threedog/post-effects, which the engine never imports
import * as THREE from 'three';
import { runsHere } from '../../render/postRuns.js';
import { isWebGPU, backendName } from '../../render/backend.js';
import { pictureChecks } from './pictureChecks.js';
import { sceneFog, sceneEnvironment } from './describeRender.js';

const R34 = s => `recipes/34-environment-lighting.md §"${s}"`, EXTRAS = R34('Soft shadows, area lights, translucency, lens flare');

/** What the scene holds that no single field says: walked once per menu (the menu is asked for, never per frame) */
function sceneHas(scene) {
  const has = { area: false, sss: false, flare: false, probes: false };
  scene.traverse(o => {
    if (o.isRectAreaLight) has.area = true;
    if (o.isLensflare || o.isLensflareMesh) has.flare = true;
    if (o.isLightProbeGrid) has.probes = true;
    if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m?.isMeshSSSNodeMaterial) has.sss = true;
  });
  return has;
}

/**
 * three.js's own picture features. Each row: on(e, has), runs (renderers it runs on), cost, on-line, recipe, limits.
 * Why here and not on three's classes: three carries no such facts; this is the one table, the effects carry their own.
 */
const THREE_ROWS = [
  { id: 'fog', on: e => !!sceneFog(e.scene), cost: 'low', how: 'engine.scene.fog = new THREE.Fog(color, near, far)', recipe: R34('Fog: plain three.js, signals, your own math'),
    limits: 'color by distance only: no height, no light in it (recipes/59 for a fog that reads depth)' },
  { id: 'environment map', on: e => !!sceneEnvironment(e.scene), cost: 'low', how: 'engine.scene.environment = pmrem.fromScene(new RoomEnvironment()).texture', recipe: R34('Environment maps'),
    limits: 'one map seen from one point for the whole scene: no local reflections, no shadow in it (indoors gets sky light)' },
  { id: 'tone curve', on: e => e.renderer.toneMapping !== THREE.NoToneMapping, cost: 'low', how: 'engine.renderer.toneMapping = THREE.AgXToneMapping', recipe: R34('Exposure and the tone curve'),
    limits: 'one curve and one exposure for the whole screen (autoExposure for one that adapts, WebGPU)' },
  { id: 'shadows', on: e => !!e.renderer.shadowMap?.enabled && someLight(e.scene, l => l.castShadow), cost: 'medium', how: 'light.castShadow = true; mesh.castShadow = mesh.receiveShadow = true',
    recipe: 'recipes/45-cascaded-shadows.md', limits: 'one box per light: nothing outside it casts; each cascade or point light face is another render of the scene' },
  { id: 'lightmap', on: e => !!e._lightmap, cost: 'low', how: "await engine.loadLightmap('light/level.lightmap') (threedog bake light)", recipe: R34('Lightmaps (baked light on what never moves)'),
    limits: 'only what never moves; a moved mesh keeps its old light, a new light is not in it' },
  { id: 'light probes', on: (e, has) => !!e._probeSets?.size || has.probes, cost: 'low', how: 'await engine.bakeProbes({ bounds, spacing })', recipe: R34('Light probes (baked indirect light)'),
    limits: 'soft indirect light only, no reflections; light blends between probes, so thin walls leak' },
  { id: 'area lights', on: (e, has) => has.area, cost: 'medium', how: 'engine.scene.add(new THREE.RectAreaLight(color, intensity, w, h))', recipe: EXTRAS,
    limits: 'no shadows; lights MeshStandard / MeshPhysical only' },
  { id: 'translucency (SSS)', on: (e, has) => has.sss, webgpuOnly: true, cost: 'low', how: 'new THREE.MeshSSSNodeMaterial({ ... }) (three/webgpu)', recipe: EXTRAS,
    limits: 'a per-light approximation, not light traveling through the volume' },
  { id: 'lens flare', on: (e, has) => has.flare, cost: 'low', how: 'light.add(lensflare) (LensflareMesh on WebGPU, Lensflare on WebGL)', recipe: EXTRAS,
    limits: 'follows one light; hidden only by what the depth test sees' },
];
export function someLight(scene, test) { let hit = false; scene.traverseVisible(o => { if (o.isLight && test(o)) hit = true; }); return hit; }

/** "yes", or why not: the chain's own rule for effects (runsHere), the renderer kind for three's WebGPU-only features */
const runsText = w => (w ? `${w.held ? 'held' : 'no'}: ${w.why}` : 'yes');
// an effect not added yet, as the shape the rule reads: about.webgpuOnly = node only; otherwise both renderers (the spec checks each effect says so truly)
const NOOP = () => {}, asDef = a => ({ create: a.webgpuOnly ? undefined : NOOP, node: NOOP, backend: a.backend, skipOnLowTier: a.skipOnLowTier });

function postRow(e, name, about, inChain) {
  const a = about ?? {};
  return { id: name, from: about ? (a.webgpuOnly ? '@threedog/post-effects/tsl' : '@threedog/post-effects') : 'game', on: inChain ? !!inChain.enabled : false,
    runs: runsText(inChain ? runsHere(inChain._def, e) : runsHere(asDef(a), e)), cost: a.cost ?? 'unknown', how: a.on ?? (inChain ? 'in the chain (the game\'s own effect)' : ''),
    recipe: a.recipe ?? 'recipes/52-around-the-picture.md §"Post effect chain"', limits: a.limits ?? 'not declared (give the effect an about field)' };
}

/**
 * The picture menu. @param {any} e @param {{ offered?: any[] }} [o] offered: effect factories (with .about) or { name, ...about }
 * @returns {{ id: 'picture', kind: 'menu', env: any, rows: any[], checks: { id: string, text: string }[], more: string | null }}
 */
export function pictureMenu(e, { offered = [] } = {}) {
  const r = e.renderer, webgpu = isWebGPU(r), has = sceneHas(e.scene);
  const rows = THREE_ROWS.map(t => ({ id: t.id, from: 'three', on: !!t.on(e, has), runs: t.webgpuOnly && !webgpu ? 'no: WebGPURenderer only' : 'yes',
    cost: t.cost, how: t.how, recipe: t.recipe, limits: t.limits }));
  const chain = e.post?._list ?? [], names = new Set(chain.map(h => h.name));
  for (const h of chain) rows.push(postRow(e, h.name, h._def.about, h));
  let listed = 0;
  for (const x of offered) {
    const about = typeof x === 'function' ? x.about : x, name = typeof x === 'function' ? x.name : x?.name;
    if (!about || !name || names.has(name)) continue;
    names.add(name); listed++;
    rows.push(postRow(e, name, about, null));
  }
  return { id: 'picture', kind: 'menu', env: { renderer: webgpu ? 'WebGPURenderer' : 'WebGLRenderer', backend: webgpu ? backendName(r) : 'webgl', tier: e.tier },
    rows, checks: pictureChecks(e),
    more: listed ? null : "effects not added yet: threedog catalog picture lists them, or engine.catalog('picture', { offered: Object.values(await import('@threedog/post-effects')) })" };
}
