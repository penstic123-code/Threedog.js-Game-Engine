// engine.inspect.scene(): "the mesh exists but I do not see it, why?" Walks the scene once, on call (nothing runs per frame, nothing is registered),
// and for every Mesh / Points / Line / Sprite says whether it can be drawn and, when not, every reason found, most likely first.
// Pure checks of what three.js itself would do (visible flags up the parent chain, layers, material flags, transform and geometry validity,
// the view frustum, fog). It cannot see what a shader does with a pixel, or something drawn over it.
import * as THREE from 'three';
import { materialInfo, infoLine } from './MaterialInfo.js';
import { describeRender } from './describeRender.js';
import { r1, cameraFrustum } from '../base/math.js';

const KINDS = [['isMesh', 'Mesh'], ['isPoints', 'Points'], ['isLine', 'Line'], ['isSprite', 'Sprite']];
const kindOf = o => KINDS.find(([k]) => o[k])?.[1] ?? null;
const PLANES = ['right', 'left', 'bottom', 'top', 'far', 'near'];   // order of THREE.Frustum.planes
// reasons that are just "not in the picture right now" (the camera looks elsewhere), not a bug: listed after the other undrawn objects
const CULLED = new Set(['outside-frustum', 'behind-camera', 'beyond-far', 'fogged-out']);
const NAN_SCAN_MAX = 100000;   // vertices checked for NaN per geometry: enough to find a broken generator, bounded for huge merged meshes
const fmt = o => o.name || '(unnamed)';
const why = (code, text, fix, level = 'hidden') => ({ code, level, text, ...(fix && { fix }) });

/** Path of names from the scene down to o, for telling same-named objects apart */
function pathOf(o) {
  const p = [];
  for (let n = o; n; n = n.parent) p.unshift(n.name || n.type);
  return p.join(' > ');
}

/** NaN / Infinity in a geometry's positions (first NAN_SCAN_MAX vertices), memoized per call */
function badPositions(g, memo) {
  if (memo.has(g)) return memo.get(g);
  const a = g?.attributes?.position;
  let bad = false;
  if (a) {
    for (let i = 0, n = Math.min(a.count, NAN_SCAN_MAX); i < n && !bad; i++) bad = !(Number.isFinite(a.getX(i)) && Number.isFinite(a.getY(i)) && Number.isFinite(a.getZ(i)));
  }
  memo.set(g, bad);
  return bad;
}

/** Why there are no vertices to draw: no positions, count 0, an empty draw range, an InstancedMesh with count 0 */
function emptyReason(o) {
  const g = o.geometry, pos = g?.attributes?.position;
  if (o.isSprite) return null;
  if (!pos || pos.count === 0) return 'the geometry has no vertices';
  if (o.isInstancedMesh && o.count === 0) return 'InstancedMesh.count is 0 (no instances)';
  const n = g.index ? g.index.count : pos.count, dr = g.drawRange;
  if (!(Math.min(n - dr.start, dr.count) > 0)) return `the draw range leaves nothing to draw (drawRange start ${dr.start}, count ${dr.count}, ${n} available)`;
  return null;
}

/** The materials that are actually drawn: an array is drawn per geometry group, so a material no (non-empty) group points at is never used */
function usedMaterials(o) {
  if (!Array.isArray(o.material)) return [o.material].filter(Boolean);
  const gs = o.geometry?.groups;
  if (!gs?.length) return o.material.filter(Boolean);   // no groups: whatever three does with that, these checks do not model it
  return [...new Set(gs.filter(g => g.count > 0).map(g => o.material[g.materialIndex]))].filter(Boolean);
}

/** Reasons from the material(s). An array of materials draws if any one of them does, so it only hides when all of them hide */
function materialReasons(o) {
  const per = usedMaterials(o).map(m => {
    const r = [], id = `material "${m.name || m.type}"`;
    if (m.visible === false) r.push(why('material-hidden', `${id} has visible = false`, 'material.visible = true'));
    if (m.opacity === 0 && m.transparent) r.push(why('opacity-zero', `${id} is transparent with opacity 0`, 'raise material.opacity'));
    else if (m.opacity === 0) {
      r.push(why('opacity-zero',
        `${id} has opacity 0 but transparent is false, so three.js ignores the opacity and draws it opaque (a custom shader may still use it)`,
        'material.transparent = true to fade it for real', 'maybe'));
    }
    if (m.colorWrite === false) r.push(why('color-write-off', `${id} has colorWrite = false: it writes depth only, no color`, 'material.colorWrite = true'));
    if (m.alphaTest >= 1) r.push(why('alpha-test', `${id} has alphaTest ${m.alphaTest}: pixels with alpha below it are discarded, which is all of them`,
      'lower material.alphaTest', 'maybe'));
    if (o.isPoints && m.size === 0) r.push(why('points-size-zero', 'PointsMaterial size is 0', 'material.size = 0.1 (or more)'));
    if (m.depthWrite === false) {
      r.push(why('depth-write-off', `${id} has depthWrite = false: drawn, but it does not occlude and other transparent objects may paint over it`,
        'material.depthWrite = true unless this is a deliberate overlay', 'maybe'));
    }
    return r;
  });
  const hides = per.filter(r => r.some(x => x.level === 'hidden')), soft = per.flat().filter(x => x.level !== 'hidden');
  return per.length && hides.length === per.length ? hides[0].concat(soft.filter(x => !hides[0].includes(x))) : soft;
}

/** The camera's side: where it is, which way it looks, its frustum */
function viewOf(cam) {
  if (!cam) return null;
  cam.updateMatrixWorld();
  const me = cam.matrixWorld.elements;
  return { pos: new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld), fwd: new THREE.Vector3(-me[8], -me[9], -me[10]).normalize(), frustum: cameraFrustum(cam) };
}

/**
 * What a zero scale does to this object: 'none' (nothing left to see), 'flat' (flattened to a plane: seen edge-on it is gone), or null. A zero on an axis the
 * geometry has no extent on (a plane's z) changes nothing. A surface needs two axes with extent, a line one; points keep their screen size at any scale
 */
function zeroScale(o, type, sc) {
  if (!sc.some(s => s < 1e-9) || type === 'Points') return null;
  if (type === 'Sprite') return sc[0] < 1e-9 || sc[1] < 1e-9 ? 'none' : null;   // a sprite is drawn in x and y only
  const g = o.geometry;
  if (g && !g.boundingBox && g.attributes?.position) g.computeBoundingBox();
  const size = g?.boundingBox ? g.boundingBox.getSize(new THREE.Vector3()) : { x: 1, y: 1, z: 1 };
  const own = [size.x, size.y, size.z], live = own.filter((v, i) => v * sc[i] > 1e-9).length;
  if (live < (type === 'Line' ? 1 : 2)) return 'none';
  return own.some((v, i) => v > 1e-9 && sc[i] < 1e-9) ? 'flat' : null;
}

/** Transform and geometry sanity: NaN positions / scales, scale 0, NaN vertices, nothing to draw */
function shapeReasons(o, type, sc, memo) {
  const r = [], me = o.matrixWorld.elements;
  if (![o.position.x, o.position.y, o.position.z].every(Number.isFinite)) r.push(why('position-nan', 'its own position has NaN or Infinity in it',
    'find the code that sets position (an undefined, a division by zero)'));
  else if (![me[12], me[13], me[14]].every(Number.isFinite)) r.push(why('position-nan',
    'its world position is NaN: a transform up the parent chain has NaN or Infinity', 'check the positions / scales of its ancestors'));
  if (sc.some(s => !Number.isFinite(s))) r.push(why('scale-zero', 'its world scale is NaN or Infinity', 'check scale on it and its ancestors'));
  else {
    const z = zeroScale(o, type, sc);
    if (z) r.push(why('scale-zero', `its world scale is 0 on at least one axis (${sc.map(r1).join(', ')}): ${z === 'none' ? 'it flattens to nothing' : 'it is flattened to a plane, gone when seen edge-on'}`,
      `${fmt(o)}.scale.set(1, 1, 1), and check ancestors`, z === 'none' ? 'hidden' : 'maybe'));
  }
  if (type !== 'Sprite' && badPositions(o.geometry, memo)) {
    r.push(why('geometry-nan', 'the geometry has NaN or Infinity in its vertex positions: it cannot be culled or drawn correctly',
      'fix the generator that wrote the positions (radius 0, division by zero, missing input)'));
  }
  const empty = emptyReason(o);
  if (empty) r.push(why('geometry-empty', empty, 'check the code that builds the geometry, geometry.setDrawRange, InstancedMesh.count'));
  return r;
}

/** Where it is relative to the camera: behind, beyond far, outside the view, lost in fog. center / radius are in the world */
function viewReasons(o, type, center, radius, view, cam, fog) {
  const r = [], dz = center.clone().sub(view.pos).dot(view.fwd), where = `${r1(dz)} m ahead of the camera`;
  if (Number.isNaN(radius)) r.push(why('radius-nan', 'its bounding sphere radius is NaN, so frustum culling rejects it',
    'fix the geometry positions, then geometry.computeBoundingSphere()'));
  else if (radius === 0 && (type === 'Mesh' || type === 'Line')) r.push(why('radius-zero',
    'its bounding sphere radius is 0: all vertices are at one point, nothing to see', 'check the generator (a size or radius of 0)'));
  if (!Number.isFinite(radius)) return r;
  if (o.frustumCulled === false) { /* three draws it wherever its sphere is */ }
  else if (dz < -radius) r.push(why('behind-camera', `it is behind the camera (${r1(-dz)} m behind)`,
    'move the camera or the object; check the camera looks where you think'));
  else if (dz - radius > cam.far) r.push(why('beyond-far', `it is beyond camera.far (${r1(dz - radius)} m away, far is ${cam.far})`,
    'raise camera.far or bring the object closer'));
  else {
    const out = view.frustum.planes.findIndex(p => p.distanceToPoint(center) < -radius);
    if (out >= 0) r.push(why('outside-frustum', `it is outside the view (${PLANES[out]} plane; ${where}). frustumCulled is ${o.frustumCulled}`,
      'move the camera to face it, or check its position'));
  }
  const m0 = Array.isArray(o.material) ? o.material[0] : o.material;
  if (fog && m0?.fog !== false && (fog.isFogExp2 ? dz - radius > 2.15 / fog.density : dz - radius >= fog.far)) {
    r.push(why('fogged-out', `it is fully inside the fog (${where}; ${fog.isFogExp2 ? 'density ' + fog.density : 'fog far ' + fog.far})`,
      'raise fog.far / lower the density, or set material.fog = false', 'maybe'));
  }
  return r;
}

/** One object: its reasons (most likely first: switched off, wrong layer, material, transform / geometry, then where it is) and its record */
function checkObject(o, type, ctx) {
  const { view, cam, scene, memo, replays } = ctx, reasons = [], off = [];
  for (let n = o; n; n = n.parent) if (n.visible === false) off.push(n);
  if (off[0] === o) reasons.push(why('hidden-self', 'its own visible is false', `${fmt(o)}.visible = true`));
  const anc = off.find(n => n !== o);
  if (anc) reasons.push(why('hidden-ancestor', `ancestor "${fmt(anc)}" (${pathOf(anc)}) has visible = false, which hides all its children`,
    `${fmt(anc)}.visible = true`));
  if (cam && !o.layers.test(cam.layers)) {
    reasons.push(why('layers', `layers do not match the camera (object mask ${o.layers.mask}, camera mask ${cam.layers.mask}): the renderer skips it`,
      'object.layers.enable(n) for a layer the camera sees, or camera.layers.enable(n)'));
  }
  // here what the state says and what draws can differ, so it comes first. Only where bundles exist: elsewhere a BundleGroup is a plain group
  if (replays) for (let n = o.parent; n; n = n.parent) if (n.isBundleGroup) { reasons.push(why('in-bundle', `inside BundleGroup ${fmt(n)}, which replays what it recorded: a change to its visible, children or castShadow shows after a new recording`, `${fmt(n)}.needsUpdate = true`, 'maybe')); break; }
  reasons.push(...materialReasons(o));
  const me = o.matrixWorld.elements, sc = [Math.hypot(me[0], me[1], me[2]), Math.hypot(me[4], me[5], me[6]), Math.hypot(me[8], me[9], me[10])];
  const shape = shapeReasons(o, type, sc, memo);
  reasons.push(...shape);
  let center = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld), radius = NaN;
  if (!shape.some(x => ['geometry-nan', 'position-nan', 'geometry-empty'].includes(x.code))) {
    let bs = o.boundingSphere ?? o.geometry.boundingSphere;
    if (!bs) { (o.computeBoundingSphere ? o : o.geometry).computeBoundingSphere(); bs = o.boundingSphere ?? o.geometry.boundingSphere; }
    center = bs.center.clone().applyMatrix4(o.matrixWorld);
    radius = bs.radius * Math.max(...sc);
    if (view) reasons.push(...viewReasons(o, type, center, radius, view, cam, scene.fog));
  }
  const ranked = [...reasons.filter(x => x.level === 'hidden'), ...reasons.filter(x => x.level !== 'hidden')], mats = (Array.isArray(o.material) ? o.material : [o.material]).filter(Boolean);
  const drawn = !ranked.some(x => x.level === 'hidden');
  return { name: o.name || null, type, path: pathOf(o), id: o.id, position: { x: r1(center.x), y: r1(center.y), z: r1(center.z) }, radius: Number.isFinite(radius) ? r1(radius) : null,
    material: mats.length ? { type: mats.map(m => m.type).join('+'), purpose: mats[0].userData?.purpose ?? o.userData?.purpose ?? null, info: mats.map(m => materialInfo(m, o)) } : null,
    visible: o.visible, drawn, ...(ranked.length && { reasons: ranked }) };
}

/** Text of one listed object: a line, the reasons that hide it, then the "maybe" ones */
function lineOf(x) {
  const hard = (x.reasons ?? []).filter(r => r.level === 'hidden'), soft = (x.reasons ?? []).filter(r => r.level === 'maybe');
  return `${x.drawn ? '✓' : '✗'} ${x.name ?? '(unnamed)'} [${x.type}] (${x.position.x}, ${x.position.y}, ${x.position.z}) r=${x.radius ?? '?'}`
    + `${x.material ? ` · ${x.material.type}${x.material.purpose ? '/' + x.material.purpose : ''}` : ''}`
    + (x.material?.info ? '\n    material: ' + x.material.info.map(infoLine).join('\n    material: ') : '')
    + (hard.length ? '\n    ' + hard.map(r => r.text).join('\n    ') : '') + (soft.length ? `\n    maybe: ${soft.map(r => r.text).join(' · ')}` : '');
}

/**
 * Check every Mesh / Points / Line / Sprite in the scene. Not drawn (as far as these checks can tell) means at least one reason of level 'hidden';
 * level 'maybe' reasons are things that may explain a missing or odd look but do not by themselves stop drawing.
 * @param {any} e engine
 * @param {{ hidden?: boolean, limit?: number }} [opts] hidden: list only objects that are not drawn; limit: how many to list (default 40; counts cover all)
 */
export function inspectScene(e, { hidden = false, limit = 40 } = {}) {
  const scene = e.scene, cam = e.camera, ctx = { scene, cam, view: viewOf(cam), memo: new Map(), replays: !!e.renderer?.backend?.beginBundle };
  scene.updateMatrixWorld();
  const items = [], counts = { total: 0, drawn: 0, notDrawn: 0, byType: {} };
  scene.traverse(o => {
    const type = kindOf(o);
    if (!type) return;
    const item = checkObject(o, type, ctx);
    counts.total++; counts.byType[type] = (counts.byType[type] ?? 0) + 1; counts[item.drawn ? 'drawn' : 'notDrawn']++;
    if (!(hidden && item.drawn)) items.push(item);
  });
  // Undrawn first, and among them the surprising ones (visible=false, empty geometry, NaN, material flags) before plain view culling: most of a big
  // world is off-screen on purpose, and listing 60 culled terrain chunks first buried the one mesh that was really broken.
  const culledOnly = x => !x.drawn && (x.reasons ?? []).filter(r => r.level === 'hidden').every(r => CULLED.has(r.code));
  items.sort((a, b) => a.drawn - b.drawn || culledOnly(a) - culledOnly(b));
  // one count per first reason over ALL undrawn objects (not just the listed ones), so a short listing still says what the rest are
  const byReason = {};
  for (const x of items) if (!x.drawn) { const c = x.reasons?.find(r => r.level === 'hidden')?.code ?? 'unknown'; byReason[c] = (byReason[c] ?? 0) + 1; }
  counts.byReason = byReason;
  const shown = items.slice(0, limit), cp = ctx.view?.pos, types = Object.entries(counts.byType).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  const head = `Scene: ${counts.total} drawable objects (${types}), ${counts.drawn} drawn, ${counts.notDrawn} not drawn`
    + (cp ? ` · camera at (${r1(cp.x)}, ${r1(cp.y)}, ${r1(cp.z)}), far ${cam.far}` : ' · no camera');
  const reasonLine = counts.notDrawn ? 'Not drawn because: ' + Object.entries(byReason).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')
    + (Object.keys(byReason).every(k => CULLED.has(k)) ? ' (all ordinary view culling)' : '') : null;
  const render = describeRender(e)?.text.split('\n')[0];   // the renderer line (tone mapping + exposure), reused from describe().render
  const text = [head, reasonLine, render, ...shown.map(lineOf), items.length > shown.length ? `… ${items.length - shown.length} more (limit ${limit}; pass a bigger limit)` : null,
    'Checks what three.js would do (visible flags, layers, material flags, transform / geometry validity, frustum, fog). It cannot see shader output or something drawn over it.']
    .filter(Boolean).join('\n');
  return { camera: cam ? { position: { x: r1(cp.x), y: r1(cp.y), z: r1(cp.z) }, near: cam.near, far: cam.far } : null, counts, items: shown, truncated: items.length - shown.length, render: render ?? null, text };
}
