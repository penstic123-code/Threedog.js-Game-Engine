// Hints about what is in view: camera inside a mesh, a black frame, fog, hand-written materials, the light layout, transparent neighbors, near-black
// areas. Each hint takes the h of pictureHints (hints.mjs).
import { wrote, INTENT_WORDS } from './intent.mjs';
import { pc, r2, said, list, FOG_MUCH } from './hint-text.mjs';

export function cameraInside({ probe, add }) {
  if (probe?.cameraInside) {
    const c = probe.cameraInside;
    add('fact', 'camera-inside', `the camera at (${c.camera.map(v => r2(v)).join(', ')}) is inside mesh '${c.name}' (its back faces on all six axes): the picture shows its inside; move the camera (--view / --pos) or the mesh.`, 1);
  }
}

/** The whole frame black: a contradiction when hiding one material brings the picture back (no look wants one material to black out everything) */
export function blackFrame({ P, probe, add }) {
  const bk = probe?.black;
  if (bk) {
    const failed = bk.broken?.length ? ` ${bk.broken.length} shader program(s) failed to compile: ${bk.broken.slice(0, 3).join(', ')} (.threedog/errors.log has the line).` : '';
    const c = bk.culprit, nan = c && /Shader/.test(c.type) ? ': a NaN or infinite value from its shader is the usual cause (a division by 0, normalize of a zero vector, pow / sqrt / log of a negative)'
      + (bk.post ? ', and the post chain (bloom) spreads it over the whole frame' : '') : '';
    if (c) add('contradiction', 'black-frame', `the frame is black, and hiding the meshes of material '${c.name}' (${c.type}, ${c.meshes} mesh${c.meshes > 1 ? 'es' : ''}) alone brings the picture back (luminance ${r2(c.luminance)})${nan}.${failed}`, 1,
      `the frame is black; hiding material '${c.name}' (${c.type}) alone brings it back${nan ? ': likely NaN / Inf from its shader' + (bk.post ? ', spread by the post chain' : '') : ''}.${failed}`);
    else add('fact', 'black-frame', `the frame is black, and hiding no single one of the ${bk.tried} newest materials (of ${bk.materials}) brings it back: look at the lights and exposure (${list([P.exposure, P.sun, P.hemi, P.env]) || 'none set'})${bk.post ? `, the post chain (${said(P.post) ?? 'engine.post'})` : ''}, and the camera (inside or behind something).${failed}`, 1);
  }
}

/** Fog that makes up most of the picture: a fact (a foggy look may want it), with the setting that makes it */
export function fogCover({ probe, add }) {
  const fg = probe?.fog;
  if (fg && fg.share >= FOG_MUCH)
    add('fact', 'fog-cover', `the fog is most of the color in ${pc(fg.share)} of the picture (fog color black vs white changes those pixels by over half the full fog amount): scene.fog ${fg.setting}, color ${fg.color}. Colors and lights there barely show; move near / far (or density) or the fog color.`, fg.share,
      `fog covers ${pc(fg.share)} of the picture (scene.fog ${fg.setting}, color ${fg.color}): colors and lights there barely show.`);
}

/** Meshes beyond camera.far: a fact (a game may want a short view), with the documented ways to move the plane */
export function farClip({ probe, add }) {
  const f = probe?.far;
  if (f) add('fact', 'far-clip', `${f.beyond} of ${f.total} visible meshes lie entirely beyond camera.far (${f.far} m, the nearest ${f.nearest} m from the camera): they are never drawn from here${f.fogFar ? `, and scene.fog far (${f.fogFar} m) is past the cut` : ''}. To draw them, own the plane with engine.autoView.manual('far') and write engine.camera.far (recipe 52 "Taken").`,
    f.beyond / f.total, `${f.beyond} of ${f.total} meshes are farther than camera.far ${f.far} m and never drawn (engine.autoView.manual('far'), then engine.camera.far).`);
}

/** Hand-written materials: what was measured, and where the pixels gave no clear answer it says so */
export function shaderFacts({ P, probe, add }) {
  const sd = probe?.shaders;
  for (const r of sd?.rows ?? []) {
    const left = sd.left ? ` (${sd.left} more shader materials not measured)` : '';
    if (r.fog?.answer === 'ignores') add('fact', 'shader-no-fog', `ShaderMaterial '${r.name}' ignores the fog: with scene.fog made total, black against white moved ${r.fog.moved} of its ${r.fog.pixels} pixels. In three.js it needs fog: true, the fog uniforms and #include <fog_fragment>; a picture may want it outside the fog${left}.`, 0.03,
      `ShaderMaterial '${r.name}' ignores the fog (${r.fog.moved} of ${r.fog.pixels} pixels moved with the fog color).`);
    else if (r.fog?.answer === 'not sure') add('fact', 'shader-fog-unsure', `not sure whether ShaderMaterial '${r.name}' takes the fog: ${r.fog.why ?? `${r.fog.moved} of its ${r.fog.pixels} pixels moved with the fog color`}.`, 0.005);
    if (r.tone?.answer === 'ignores') add('fact', 'shader-no-tone', `ShaderMaterial '${r.name}' ignores the tone curve (${P.toneMapping?.value ?? 'on'}): exposure /4 against x4 moved ${r.tone.moved} of its ${r.tone.pixels} pixels${r.toneMapped === false ? '; it has toneMapped: false' : '; it needs #include <tonemapping_fragment>'}; a picture may want it outside the curve${left}.`, 0.03,
      `ShaderMaterial '${r.name}' ignores the tone curve (${r.tone.moved} of ${r.tone.pixels} pixels moved with exposure).`);
    else if (r.tone?.answer === 'not sure') add('fact', 'shader-tone-unsure', `not sure whether ShaderMaterial '${r.name}' takes the tone curve: ${r.tone.moved} of its ${r.tone.pixels} pixels moved with exposure.`, 0.005);
  }
}

/** Light layout: seen by the dev light watch while the game ran. A compile and a layout change seen together are not proven to be one frame */
export function lightLayout({ probe, add }) {
  const ll = probe?.lightLayout;
  if (ll?.changes.length) {
    const c = ll.changes[ll.changes.length - 1], n = ll.changes.reduce((s, x) => s + x.programs, 0);
    add('fact', 'light-layout', `the light layout changed during play (${ll.changes.length} time${ll.changes.length > 1 ? 's' : ''}, last ${c.from} -> ${c.to}) and ${n} shader programs were compiled around those changes (seen together, not proven to be the same frame): a compile is a frozen frame. Fading a fixed set of lights with intensity compiles nothing.`, 0.04,
      `light layout changed during play (${c.from} -> ${c.to}), ${n} shader programs compiled around it.`);
  } else if (ll && ll.now !== ll.last)
    add('fact', 'light-layout-unsure', `the light layout now (${ll.now}) differs from the last one seen (${ll.last}) with no compile seen yet: not sure it will cost one.`, 0.005);
}

/** Transparent neighbors: only pixels that moved with the swap count; pairs not drawn stay "not sure" */
export function transparentOrder({ probe, add }) {
  const tp = probe?.transparent;
  if (tp) {
    const untried = tp.pairs - tp.tried, cut = tp.looked < tp.meshes ? `; only the nearest ${tp.looked} of ${tp.meshes} transparent meshes were looked at` : '', rest = untried ? `; not sure about the ${untried} other overlapping pairs${cut}` : cut;
    const s = [...tp.swapped].sort((a, b) => b.pixels - a.pixels)[0];
    if (s) add('fact', 'transparent-order', `transparent meshes '${s.a}' and '${s.b}' have one renderOrder, and swapping their draw order moved ${s.pixels} pixels (${pc(s.share)} of the picture): three sorts them by object center, so the picture can pop as the camera moves. renderOrder fixes the order${rest}.`, Math.max(s.share, 0.01),
      `transparent '${s.a}' / '${s.b}': swapping draw order moves ${pc(s.share)} of the picture.`);
    else if (untried) add('fact', 'transparent-unsure', `no pixel moved in the ${tp.tried} overlapping transparent pairs drawn${rest}.`, 0.005);
  }
}

/** Large near-black areas: a fact (a horror night or a silhouette look may want them), a contradiction only under a DESIGN.md no-pitch-black */
export function crushed({ N, P, probe, intent, isDay, add }) {
  const noBlack = intent.find(a => a.want === 'noBlack');
  if (N.dark >= 0.4 && !probe?.black)
    add(noBlack ? 'contradiction' : 'fact', 'crushed', `${wrote(noBlack)}${pc(N.dark)} of the picture is near black (all channels <= 20): little detail shows there${isDay === false ? ' (a night shot)' : ''}. ` +
      `Set by: ${list([P.exposure, P.sun, P.hemi, P.env]) || 'exposure / light intensities'}.`, N.dark);
}

export function unknownIntentWords({ intent, add }) {
  for (const a of intent) if (a.want === 'unknown')
    add('fact', 'intent-word', `DESIGN.md "Picture intent" has '${a.word}', which the picture check does not read; the words it reads: ${Object.keys(INTENT_WORDS).join(', ')}.`, 0.01);
}
