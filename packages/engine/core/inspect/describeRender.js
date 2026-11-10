// describe().picture: what three.js holds right now, read straight off the renderer and the scene. No record, no layers: whoever wrote a value
// (the game's picture code, a module, a console line), this is the value the frame is drawn with. .writers says which line wrote it (core/inspect/pictureWriters.js).
// describe().render: renderer, post, lights and probes. Facts read from three.js and the post chain.
// This is information only: the engine never warns when a game changes the renderer or lights.
import { NoToneMapping, LinearToneMapping, ReinhardToneMapping, CineonToneMapping, ACESFilmicToneMapping, CustomToneMapping, AgXToneMapping, NeutralToneMapping } from 'three';
import { SHADOW_TYPES } from '../../render/shadowTypes.js';
import { rv } from '../base/math.js';
import { hex } from './MaterialInfo.js';
import { defineOwned } from '../ops/owned.js';
import { slotHolders } from '../scene/pictureSlots.js';
import { isShown } from '../base/util.js';
import { backendFacts } from '../../render/backend.js';
import { pixelSizeOn } from '../scene/pixelRatio.js';
import { autoLowered } from '../scene/adaptive.js';
import { pictureChecks } from './pictureChecks.js';

const shadowName = v => Object.keys(SHADOW_TYPES).find(k => SHADOW_TYPES[k].three === v) ?? String(v);
const TONE_NAMES = { [NoToneMapping]: 'none', [LinearToneMapping]: 'linear', [ReinhardToneMapping]: 'reinhard', [CineonToneMapping]: 'cineon',
  [ACESFilmicToneMapping]: 'aces', [CustomToneMapping]: 'custom', [AgXToneMapping]: 'agx', [NeutralToneMapping]: 'neutral' };
const toneName = v => TONE_NAMES[v] ?? String(v);
/** What a build without the dev server says for every picture value (core/inspect/pictureWriters.js stays out of it) */
export const NO_WRITERS = 'not tracked: source lines are only known on the dev server (threedog dev or npm run dev); a bundled build has no file:line to give';

/**
 * Whether the scene has fog / an environment: the classic field or its TSL node (WebGPU). The one reading, shared with the picture menu,
 * so a catalog row saying "on" and describe() saying "none" cannot happen for the same scene
 * @param {any} s scene
 */
export const sceneFog = s => s.fog || s.fogNode || null;
export const sceneEnvironment = s => s.environment || s.environmentNode || null;
const NODE = { type: 'Node' };   // a TSL node: its value is shader code, not data to print

/** scene.fog as data @param {any} s scene */
const fogOf = s => { const f = sceneFog(s); return !f ? null : !s.fog ? NODE : f.isFogExp2 ? { type: 'FogExp2', color: hex(f.color), density: f.density } : { type: 'Fog', color: hex(f.color), near: f.near, far: f.far }; };
/** scene.background as data: a Color by value, a texture by kind @param {any} s */
function backgroundOf(s) {
  const b = s.background;
  if (!b) return s.backgroundNode ? NODE : null;
  return b.isColor ? { type: 'Color', color: hex(b) } : { type: b.isCubeTexture ? 'CubeTexture' : 'Texture', name: b.name || null, intensity: s.backgroundIntensity };
}
/** Whether three draws with this light: every parent visible and on a layer the camera sees (the test three's renderer makes) */
const lit = (o, cam) => o.layers.test(cam.layers) && isShown(o);
const lightOf = (l, cam) => ({ type: l.type, name: l.name, color: hex(l.color), ...(l.groundColor ? { groundColor: hex(l.groundColor) } : {}), intensity: l.intensity, castShadow: !!l.castShadow, visible: lit(l, cam) });

/**
 * describe().picture: the values the frame is drawn with, read off the three.js objects, so a direct three.js write shows at once and at full precision.
 * @param {any} e
 * @returns {{ toneMapping: string, exposure: number, fog: any, environment: { present: boolean, intensity: number }, background: any, lights: any[], shadows: { enabled: boolean, type: string }, writers: any }}
 */
export function describePicture(e) {
  const r = e.renderer, s = e.scene, lights = /** @type {any[]} */ ([]);
  s.traverse(o => { if (/** @type {any} */ (o).isLight && !(/** @type {any} */ (o).isLightProbeGrid)) lights.push(lightOf(o, e.camera)); });   // a probe grid has its own rows (probes)
  return { toneMapping: toneName(r.toneMapping), exposure: r.toneMappingExposure, fog: fogOf(s), environment: { present: !!sceneEnvironment(s), intensity: s.environmentIntensity },
    background: backgroundOf(s), lights, shadows: { enabled: r.shadowMap.enabled, type: shadowName(r.shadowMap.type) }, slots: slotHolders(e), writers: e._picture?.list() ?? { tracked: false, note: NO_WRITERS } };
}

/**
 * Record how the renderer was made.
 * @param {any} e
 * @param {{ owned: boolean }} o owned: false when the game passed its own renderer
 */
export function recordRender(e, { owned }) {
  // who writes tone mapping now is one owned record like every other picture value (core/ops/owned.js),
  // not a comparison against a remembered creation value here: a direct renderer.toneMapping write yields it ('three (engine yielded)'), quietly (once),
  // because that write is the documented way to change the curve. A game-supplied renderer (owned false) starts manual: the engine never wrote it
  e._oTone = defineOwned(e, { id: 'toneMapping', part: 'tone', key: 'toneMapping', read: () => e.renderer.toneMapping, objects: [e.renderer], once: true,
    write: v => { e.renderer.toneMapping = v; }, levels: { manual: 'engine.renderer.toneMapping = THREE.AgXToneMapping' } });
  if (owned) e._oTone.mark(); else e._oTone.manual(true, 'game renderer');
  e._renderBase = { owned };
}

/**
 * What the engine itself still puts on the picture right now, each with how to stop it: a value the game never wrote must be findable (plan 2026-11-04,
 * section 2). What moves every frame is describe().owned; this is what stands with no game code asking.
 * @param {any} e @returns {{ what: string, value: string, off: string }[]}
 */
function engineDefaults(e) {
  const r = e.renderer, s = e.scene, bg = s.background, rows = [];
  if (bg && bg === e.baseBackground && bg.getHex() === e.baseBackgroundHex) rows.push({ what: 'scene.background', value: `#${bg.getHexString()}`, off: 'scene.background = your color or texture' });
  for (const [name, l] of Object.entries(e.lights ?? {})) if (l.parent) rows.push({ what: `lights.${name}`, value: `${l.type} ${rv(l.intensity)}`, off: 'createEngine({ lights: false })' });
  if (r.shadowMap.enabled) rows.push({ what: 'renderer.shadowMap', value: shadowName(r.shadowMap.type), off: 'engine.shadows.enabled = false' });
  // render/postWebGL.js direct(): only once the game has picked a tone curve, so a Color background agrees with the effect chain's OutputPass
  if (r.toneMapping !== NoToneMapping && (bg?.isColor || bg == null) && !e.post?.active) rows.push({ what: 'background tone', value: 'drawn as a 1x1 tone-mapped texture during the render; scene.background itself is not changed', off: 'renderer.toneMapping = THREE.NoToneMapping' });
  return rows;
}

/** One row of backgroundOf / fogOf on a line: 'none', 'Color #aabbcc', 'Fog #aabbcc 10..80', 'FogExp2 #aabbcc 0.02' */
const sceneWord = x => (!x ? 'none' : [x.type, x.color, x.near != null ? `${rv(x.near)}..${rv(x.far)}` : x.density].filter(v => v != null).join(' '));

/** The render section: structured data plus one compact text block (`text`) @param {any} e */
export function describeRender(e) {
  const r = e.renderer, b = e._renderBase;
  if (!b) return undefined;
  // a post effect in the 'tone' slot replaces the tone-mapping stage (render/PostFX.js): then it, not renderer.toneMapping, makes the picture
  const toneFx = e.post?._list?.find(h => h.slot === 'tone' && h.enabled);
  // who decides an effect's switch: the point's writer, 'default' while nobody wrote it
  const postWho = n => { const point = `post.${n}.enabled`; return { point, writer: e.stacks.get(point).row().writer }; };
  const tone = toneFx ? { value: `post effect '${toneFx.name}' (tone slot)`, ...postWho(toneFx.name) }
    : { value: toneName(r.toneMapping), writer: e._oTone.on ? 'three default' : 'game' };
  const exposure = { value: rv(r.toneMappingExposure) };
  const shadows = { enabled: r.shadowMap.enabled, type: shadowName(r.shadowMap.type) };
  const post = (e.post?._list || []).map(h => { const held = e.post._held(h), facts = h._def.facts?.();
    return { name: h.name, on: h.enabled, params: { ...h.params }, ...postWho(h.name), ...(held ? { held } : {}), ...(facts ? { facts } : {}) }; });
  const lights = Object.entries(e.lights || {}).filter(([, l]) => l.parent)
    .map(([name, l]) => ({ name, type: l.type, intensity: rv(l.intensity), source: 'engine-default' }));
  // the game's own point / spot lights (core/scene/gameLights.js): adopted like a lightPool light, listed with the line that added them
  for (const l of e._gameLights?.list() ?? []) lights.push({ name: l.name || l.type, type: l.type, intensity: rv(l.intensity), castShadow: l.castShadow,
    source: 'game', writer: 'game', at: e._things?.entryOf(l)?.[0]?.at ?? null, ...(e._gameLights.idled(l) ? { shadowIdled: true } : {}) });
  const defaults = engineDefaults(e);
  const by = x => (x.writer ? ` (${x.writer})` : '');
  const antialias = e.post?._antialiasNow() ?? { samples: 0, replacedBy: null };
  const kv = x => Object.entries(x).map(([k, v]) => `${k}=${typeof v === 'number' ? rv(v) : v}`).join(' ');
  const srgb = r.outputColorSpace === 'srgb' ? '' : ' (WRONG: colors are encoded for srgb; color textures must be srgb, data maps linear, see assets.report)';
  let text = [
    `renderer: ${tone.value}${by(tone)} exposure ${exposure.value} shadows ${shadows.enabled ? shadows.type : 'off'}${b.owned ? '' : ' [game-supplied renderer]'} output ${r.outputColorSpace}${srgb}`,
    `post: ${post.map(x => `${x.name}${x.held ? ` held off: ${x.held}` : x.on ? '' : ' off'}${Object.keys(x.params).length ? `{${kv(x.params)}}` : ''} (${x.writer})`).join(', ') || 'none'}${antialias.samples ? ` + MSAA x${antialias.samples}` : antialias.replacedBy ? ` + ${antialias.replacedBy} in place of MSAA` : ''}`,
    `lights: ${lights.map(l => `${l.name} ${l.type} ${l.intensity}${l.writer ? ` (${l.writer}${l.at ? ' ' + l.at : ''})` : ''}`).join(', ')}`,
    `scene: background ${sceneWord(backgroundOf(e.scene))} fog ${sceneWord(fogOf(e.scene))} environment ${sceneEnvironment(e.scene) ? rv(e.scene.environmentIntensity) : 'none'}`,
    `engine defaults on the picture: ${defaults.map(d => d.what).join(', ') || 'none'}`,
  ].join('\n');
  // probe sets (render/probes.js): how many, how dense, who made them, what they miss (light counted twice is a picture check, below)
  const probes = [...(e._probeSets ?? [])].map(s => s.info());
  if (probes.length) text += `
probes: ${probes.map(p => `${p.count} (${p.counts.join('x')}, step ${p.step.join('/')}) from ${p.source} by ${p.owner}`).join('; ')}`
    + (probes[0].outside.count ? `
  outside the probe grid (no probe light): ${probes[0].outside.count} lit object(s), ${probes[0].outside.names.join(', ')}` : '');
  const dv0 = e.debug?.viewState?.(), dv = dv0 && dv0.mode !== 'off' ? dv0 : null;
  if (dv) text = `DEBUG VIEW "${dv.mode}" (by ${dv.owner}) is ON: ${dv.what}. This is NOT the real picture; the debug view 'off' restores it.
` + text;
  // render scale: the canvas resolution against the display. auto: the adaptive resolution lowered it at some point (it raises it back when frames are fast)
  const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1, cur = r.getPixelRatio(), ad = e.adaptive;
  const scale = { current: Math.round(cur * 100) / 100, devicePixelRatio: dpr, upscaled: cur < dpr - 0.01 && !pixelSizeOn(e), pixelSize: e._pixelSize, autoLowered: autoLowered(e),
    adaptive: !!ad?.on, floor: ad?.min ?? null, max: ad?.max ?? null };
  text += `
render scale: ${scale.current} of device pixel ratio ${dpr}${scale.pixelSize ? ` (pixelSize ${scale.pixelSize}: one art pixel is ${scale.pixelSize} screen pixels)` : ''}${scale.upscaled ? ' (picture is upscaled, softer than the screen)' : ''}${scale.autoLowered ? ` (auto-lowered by adaptive resolution, floor ${scale.floor}; adaptiveResolution: false turns it off)` : ''}`;
  // the lightmap (render/lightmap.js): what is baked, and what no longer matches the bake
  const lightmap = e._lightmap?.info() ?? null;
  if (lightmap) text += `\nlightmap: ${lightmap.meshes} mesh(es), ${lightmap.size} map from ${lightmap.file}`
    + ['skipped', 'missing', 'moved', 'shared'].map(k => (lightmap[k].length ? `, ${k}: ${lightmap[k].slice(0, 3).map(x => x.name ?? x).join(', ')}` : '')).join('');
  // occlusion culling (render/occlusion.js): what it skipped this frame, so a game can see whether it pays
  const occlusion = e.occlusion?.enabled ? e.occlusion.stats : null;
  if (occlusion) text += `\nocclusion: ${occlusion.hidden} of ${occlusion.watched} big things hidden, ${occlusion.trianglesSkipped} triangles skipped`;
  // three's BundleGroup in the game's scene: it replays what was recorded, so an AI reading the state must know a child's visible is not what draws. A walk: describe is not per frame
  let bundles = null;
  e.scene.traverse(o => { if (o.isBundleGroup) { bundles ??= { groups: 0, meshes: 0, replayed: !!r.backend?.beginBundle }; bundles.groups++; o.traverse(c => { if (c.isMesh) bundles.meshes++; }); } });
  if (bundles) text += `\nrender bundles: ${bundles.groups} BundleGroup(s), ${bundles.meshes} mesh(es), ${bundles.replayed ? 'replayed as recorded: after changing what is inside, set group.needsUpdate = true' : 'plain groups on this backend, no gain (only WebGPU has bundles)'}`;
  // settings wrong together whatever the game wants (core/inspect/pictureChecks.js): one line each, last, so the fix is the last thing read
  const checks = pictureChecks(e);
  for (const c of checks) text += `\npicture ${c.kind === 'mistake' ? 'check' : 'note'} ${c.id}: ${c.text}`;
  return { debugView: dv, scale, toneMapping: tone, exposure, shadows, post, antialias, lights, defaults, probes, lightmap, occlusion, bundles, checks, text };
}

/**
 * Which renderer was asked for and which backend draws; reason = why not WebGPU (core/engine/startup.js _startRenderer); the rest is what that backend can run.
 * All null before start(): the facts need the started backend.
 * @param {any} e
 */
export function describeBackend(e) {
  if (e._backend) return { ...e._backend, ...backendFacts(e.renderer) };
  return { requested: e._backendWant.requested, backend: null, reason: null, gpu: null, tsl: null, glsl: null, compute: null };
}
