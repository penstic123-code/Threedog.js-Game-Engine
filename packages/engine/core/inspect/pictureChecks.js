// Combination checks: picture settings read together off the three.js objects (no pixels). The one place a combination is judged:
// describe().render prints the results (field `checks`, one line each), `threedog shot` puts them first in its hint lines
// (packages/tools/picture/hints.mjs), a probe set or lightmap load warns once with the same text.
// Two kinds, and the line between them is the rule: kind 'mistake' only when the settings alone prove the picture wrong whatever the game
// wants (baked light plus the fill it baked counts twice), with a "Fix:"; kind 'note' when the settings make a fault likely but only the
// drawn picture could prove it (a top-down view never shows the horizon, a metal can glow on its own): the facts, never "must fix".
// Never taste ("too dark", "too much bloom"), never a target value. Runs on describe() and at load, never per frame: some walk the scene.
import * as THREE from 'three';
import { mats, noteFillLight, noteEnvironment } from '../../render/lit.js';
import { cameraFrustum } from '../base/math.js';
import { drawnAFrame } from '../../render/backend.js';
import { fogLook } from '../../render/fogLook.js';

const nameOf = o => o.name || `${o.type} ${o.id}`;
const hex = c => '#' + c.getHexString(THREE.SRGBColorSpace);
const note = (out, id, text) => out.push({ id, kind: 'note', text });

/** Metal with no environment map has only the direct lights to reflect. A note: half metal keeps a diffuse color, an emissive one glows by itself */
function metalNoEnv(e, out) {
  const s = e.scene;
  if (s.environment || s.environmentNode) return;
  const metal = new Set();
  s.traverseVisible(o => {
    if (!o.isMesh) return;
    // a metalness map or node is the game's own math: its value is unknown here, so it is not counted
    for (const m of mats(o)) if ((m?.isMeshStandardMaterial || m?.isMeshStandardNodeMaterial) && m.metalness >= 0.5 && !m.metalnessNode && !m.metalnessMap && !m.envMap && !m.envNode) metal.add(nameOf(o));
  });
  if (!metal.size) return;
  const bg = s.background?.isTexture ? ' (scene.background is not one: it lights nothing)' : '';
  note(out, 'metal-no-env', `no environment reflection on ${metal.size} metal mesh(es) (${[...metal][0]}): what metal reflects comes from scene.environment or material.envMap, and neither is set${bg}.`);
}

/**
 * Baked light (a probe set or a lightmap) plus a light the bake already saw: that light counts twice. Exported for the load-time warning of
 * render/probes.js and render/lightmap.js (the same words there). @param {any} e @returns {string | null}
 */
export function litTwice(e) {
  const probes = !!e._probeSets?.size, lightmap = !!e._lightmap;
  if (!probes && !lightmap) return null;
  const doubled = [];
  let mapped = 0;
  e.scene.traverseVisible(o => {
    if (noteFillLight(o, doubled)) return;
    if (lightmap && o.isLightProbeGrid) doubled.push(`probe grid ${o.name}`);   // the lightmap baked the bounce the grid adds again
    else if (probes && !lightmap && o.isMesh && mats(o).some(m => m?.lightMap)) mapped++;   // a game's own lightMap under a probe grid
  });
  noteEnvironment(e.scene, doubled);
  if (mapped) doubled.push(`material.lightMap on ${mapped} mesh(es)`);
  if (!doubled.length) return null;
  const what = [probes && 'probe', lightmap && 'lightmap'].filter(Boolean).join(' and ');
  const list = doubled.slice(0, 2).join(', ') + (doubled.length > 2 ? ` and ${doubled.length - 2} more` : '');
  if (!bakeSeenScene(e)) return `${what} light is added on top of ${list}. If the bake saw it, it counts twice (a loaded file does not say which lights it saw). Fix: lower it where the bake takes over, or bake without it.`;
  return `${what} light is added on top of ${list}, which the bake already saw, so it counts twice. Fix: lower it where the bake takes over, or bake without it.`;
}

/** True only when every baked light came from a bake made in this session (engine.bakeProbes): it saw this scene's lights. A loaded file or a lightmap carries no record of them */
const bakeSeenScene = e => !e._lightmap && [...(e._probeSets ?? [])].every(s => s.source === 'bake');

/**
 * A glow before the exposure that applies after it: its threshold acts on light the screen shows scaled. A note: how much of the picture passes the
 * threshold depends on the light in view, which only the pixels say. Effects are found by what they declare (about.acts, @threedog/post-effects
 * about.js), never by name, in the order that runs now (held effects are off); an exposure effect keeps its value on the GPU, so with one after the
 * glow the numbers are unknown and the note says so instead of guessing (GPT review l2-render 8)
 */
function bloomBeforeExposure(e, out) {
  const r = e.renderer, on = e.post?._sorted().filter(h => h.enabled) ?? [], acts = (h, a) => h._def?.about?.acts === a;
  const b = on.find(h => acts(h, 'glow') && (h.slot === 'scene' || h.slot === 'hdr')), t = b?.params?.threshold;
  if (!b || !(b.params.strength > 0) || typeof t !== 'number') return;
  const auto = on.find(h => acts(h, 'exposure') && on.indexOf(h) > on.indexOf(b));
  if (auto) {
    note(out, 'bloom-before-exposure', `${b.name} (threshold ${+t.toFixed(2)}) runs before ${auto.name}, which scales the light by a value it keeps on the GPU: what that threshold ` +
      `is on screen is unknown here and changes with the light in view; ordered after ${auto.name}, its cut is on the exposed light.`);
    return;
  }
  // a game tone stage (slot 'tone') replaces three's output, so whether it applies renderer.toneMappingExposure is the game's code
  const ex = r.toneMappingExposure;
  if (r.toneMapping === THREE.NoToneMapping || on.some(h => h.slot === 'tone') || !(ex < 1)) return;
  if (t * ex > 0.5) return;   // why 0.5: a cut at half of white or below reaches past highlights into ordinary lit surfaces
  note(out, 'bloom-before-exposure', `${b.name} runs before exposure ${+ex.toFixed(2)}: its threshold ${+t.toFixed(2)} acts like ${+(t * ex).toFixed(2)} of the screen's white, ` +
    `so more than highlights can glow; threshold ${+(t / ex).toFixed(2)} would keep the cut where it shows.`);
}

/** A visible inside-out mesh around the camera (a sky dome or box, three's Sky addon too): the background color is not what shows behind the world */
function skyAround(e) {
  const at = e.camera.getWorldPosition(new THREE.Vector3()), sphere = new THREE.Sphere();
  let found = false;
  e.scene.traverseVisible(o => {
    if (found || !o.isMesh || !mats(o).some(m => m?.side === THREE.BackSide || m?.side === THREE.DoubleSide)) return;
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    found = sphere.copy(o.geometry.boundingSphere).applyMatrix4(o.matrixWorld).containsPoint(at);
  });
  return found;
}

/** Far things fade to the fog color; where they meet a visible flat background a band shows. A note: a top-down view may never show the background */
function fogHorizon(e, out) {
  const s = e.scene, f = fogLook(s, e.renderer), bg = s.background;
  if (!f?.color || !bg?.isColor || s.backgroundNode) return;   // a sky mesh, texture or node: its horizon color is not known here
  if (f.isFog ? f.near >= e.camera.far : f.isFogExp2 && !(f.density > 0)) return;   // the fog starts past what the camera draws, or has no density: it never shows (a fogNode: its range is not known, so it is taken as shown)
  if (skyAround(e)) return;   // a sky dome hides the background color: its horizon is the game's own (found 2026-11-09 on examples/webgpu-tsl)
  const a = f.color.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace), c = bg.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  // why 0.25 of the display range: below it a seam is hard to see; above it it reads as a line in every style
  if (Math.max(Math.abs(a.r - c.r), Math.abs(a.g - c.g), Math.abs(a.b - c.b)) < 0.25) return;
  note(out, 'fog-horizon', `fog color ${hex(f.color)} differs from the background ${hex(bg)}: where fogged far things meet visible background, a band shows (none if the background is never in view).`);
}

/** The shadow caster nearest the camera outside every shadow box: it casts no shadow. A note: a light may cover only part of the scene on purpose */
function shadowBox(e, out) {
  const r = e.renderer, cam = e.camera;
  if (!r.shadowMap?.enabled || e.shadows?.csm) return;   // cascades fit their own boxes to the view
  const lights = [];
  let unknown = false;
  e.scene.traverseVisible(l => { if (l.isLight && l.castShadow) { if (l.isPointLight) unknown = true; else if (l.isDirectionalLight || l.isSpotLight) lights.push(l); } });
  if (unknown || !lights.some(l => l.isDirectionalLight)) return;   // a point light's six faces are not one box: who shadows what is not known
  cam.updateMatrixWorld();
  const view = cameraFrustum(cam);
  const sphere = new THREE.Sphere(), casters = [];
  e.scene.traverseVisible(o => {
    if (!o.isMesh || !o.castShadow || o.isInstancedMesh || o.isSkinnedMesh) return;   // instances and skinned bounds are not the drawn shape
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    sphere.copy(o.geometry.boundingSphere).applyMatrix4(o.matrixWorld);
    if (view.intersectsSphere(sphere)) casters.push({ o, s: sphere.clone(), d: sphere.center.distanceTo(cam.position) });
  });
  if (!casters.length) return;
  casters.sort((a, b) => a.d - b.d);
  // what the shadow pass does each frame (the boxes it is about to draw), worked out on a copy: updateMatrices on the real shadow would move the camera and matrix
  // the renderer samples, so a baked shadow (autoUpdate off) would get the new matrix over the old map. Asking must not change the picture
  const boxes = lights.map(l => { const s = new l.shadow.constructor().copy(l.shadow); s.updateMatrices(l); return s.getFrustum(); });
  const outside = casters.filter(c => !boxes.some(b => b.intersectsSphere(c.s)));
  if (outside[0] !== casters[0]) return;
  note(out, 'shadow-box', `${nameOf(casters[0].o)}, the shadow caster nearest the camera, is outside every shadow box (${lights.map(nameOf).join(', ')}; ${outside.length} of ${casters.length} casters in view are), so it casts no shadow.`);
}

/**
 * Every combination check, in order. @param {any} e @returns {{ id: string, kind: 'mistake' | 'note', text: string }[]}
 */
export function pictureChecks(e) {
  const out = [];
  // before the first frame the game's per-frame picture code has not run (examples/webgpu-tsl at tick 0: fog still black, sun not aimed), so no claim yet
  if (!drawnAFrame(e.renderer)) return out;
  const twice = litTwice(e);
  if (twice) out.push({ id: 'lit-twice', kind: bakeSeenScene(e) ? 'mistake' : 'note', text: twice });   // without the bake's own record it is only a possibility
  metalNoEnv(e, out);
  bloomBeforeExposure(e, out);
  fogHorizon(e, out);
  shadowBox(e, out);
  return out;
}
