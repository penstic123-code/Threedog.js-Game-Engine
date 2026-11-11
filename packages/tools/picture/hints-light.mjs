// Hints about light: the time of day, lights that change nothing, clipped areas, glare, the light budget, key against fill.
// Each hint takes the h of pictureHints (hints.mjs).
import { CLIP, HOT } from './numbers.mjs';
import { wrote } from './intent.mjs';
import { pc, r2, said, list, FOG_MUCH, TIME_FLAT } from './hint-text.mjs';

/** What each budget category counts and the next step when it is over. Usage lines quote the real API: lightPool (recipe 09 1b), a light's own shadow fields */
const BUDGET_WORDS = {
  lights: 'real point / spot lights lit', shadowLights: 'shadow-casting point / spot lights lit',
  shadowMaps: 'shadow maps drawn each frame (a point light is six)', shadowMapSize: 'pixels on the side of the largest shadow map',
};
/** Why each default limit is there: "lights 10 over 8" read as a rule with no reason. A limit is a guide for what to measure, nothing is cut at it */
const BUDGET_WHY = {
  lights: 'each adds work per lit pixel', shadowLights: 'each draws the scene again', shadowMaps: 'each is one more pass over the scene', shadowMapSize: 'memory grows with its square',
};
const budgetNext = (cat, b) => {
  if (cat === 'lights') return b.pool ? 'lightPool is installed: lightPool({ point }) sets how many real lights it keeps, its other sources wait'
    : 'many lights: light pool, engine.use(lightPool({ point: 8 })) then engine.lightPool.add(torch, { intensity: 4, distance: 8 }) (recipe 09 1b)';
  const who = b.casters?.length ? `: ${b.casters.map(c => `${c.name} (${c.type}, ${c.size})`).join(', ')}` : '';
  return cat === 'shadowMapSize' ? `pick light.shadow.mapSize from engine.tier in the picture code${who}` : `set castShadow = false on the lights that can go without${who}`;
};

/** What makes the bright night or the flat day, in full (cause) and short (brief) */
function timeCause({ P }, t, tn, at, unlitNight) {
  const fogPart = t.noFog !== undefined && tn.midnight - t.noFog >= 0.3 * tn.midnight;
  let cause;
  if (unlitNight) {
    cause = `the 00:00 brightness is not lighting: with every light and the environment at 0 it is still ${r2(t.unlit)}. ` +
      (fogPart ? `Most of it is the fog: ${said(t.at.midnight.fog)} at 00:00 (fog color black gives ${r2(t.noFog)}; scene.fog)` :
        `What stays lit without light: emissive or unlit materials${t.glow ? ` (switched on by the game at night: ${list(t.glow)})` : ''}, the sky / background${t.at.midnight.background ? ` (${said(t.at.midnight.background)})` : ''}${t.at.midnight.fog ? `, ${said(t.at.midnight.fog)}` : ''}, post effects${P.post ? ` (${said(P.post)})` : ''}`);
  } else cause = `what lights the scene does not follow the calendar's time (the sky moves no light: your picture/ code reads engine.uniforms.uDaylight and writes it, recipe 62). At 12:00 ${at(t.at.noon)}; at 00:00 ${at(t.at.midnight)}${t.envSource ? `; ${said(t.envSource)}` : ''}`;
  // brief: the one cause that measured, without the long lists (every post pass, every glowing material) the full text keeps
  const glowShort = t.glow?.length ? `glow ${t.glow.slice(0, 2).map(said).join(', ')}${t.glow.length > 2 ? ` +${t.glow.length - 2}` : ''}` : null;
  const brief = unlitNight
    ? (fogPart ? `the fog: ${said(t.at.midnight.fog)}`
      : `not light: ${r2(t.unlit)} with every light off (${[glowShort, t.at.midnight.background && said(t.at.midnight.background), P.post && 'engine.post'].filter(Boolean).join(', ') || 'emissive / unlit materials, the sky'})`)
    : `the lights do not follow the time (12:00 ${at(t.at.noon)}; 00:00 ${at(t.at.midnight)})`;
  return { cause, brief };
}

/** A time of day that barely moves the picture, or a night whose brightness is not light */
export function timeFlat(h) {
  const { probe, intent, add } = h;
  const t = probe?.time;
  // judged on the part the time should drive (sun / moon, sky fill, environment): lights and glowing materials the game itself switches with the
  // time (street lamps, lit windows) are taken out at both times, else a town whose lamps light the night "does not follow the time" (t.driven)
  const tn = t?.base ?? t;
  // two ways the night fails to be night: (1) noon and midnight look alike; (2) noon is brighter, but the midnight picture is still at least half
  // the noon brightness with every light off: a gray background / fog that never darkens is what lights the night (the round-1 demo's rainy night)
  // both times fully black: nothing here says what the time does, only that the frame is black ('crushed' below reports that once)
  const bothBlack = t && Math.max(tn.noon, tn.midnight) < 0.01;
  const flatTime = t && !bothBlack && Math.abs(tn.noon - tn.midnight) / Math.max(tn.noon, tn.midnight, 0.01) < TIME_FLAT;
  const unlitNight = t && !bothBlack && t.unlit !== undefined && t.unlit >= 0.6 * tn.midnight;
  if (!(flatTime || (unlitNight && t.unlit >= 0.5 * tn.noon))) return;
  const at = w => list([w.sun, w.hemi, w.env, w.exposure]);
  const drv = t.driven?.length ? `, without the ${t.driven.length} light(s) the game switches with the time (${t.driven.slice(0, 4).join(', ')}): ${r2(tn.noon)} / ${r2(tn.midnight)}` : '';
  const fact = `${flatTime ? "the calendar's time barely changes the picture (the check sets engine.calendar.timeOfDay to 12:00 and 00:00 and renders both; lights you switch by your own presets are not moved by it, so a game that does that can ignore this line)" : 'the night is not dark from lighting'}: mean luminance ${r2(t.noon)} at 12:00, ${r2(t.midnight)} at 00:00 (same view, same weather)${drv}`;
  const { cause, brief } = timeCause(h, t, tn, at, unlitNight);
  // much fog in this very picture: the time line says so itself, the fog comes first (formatPicture prints fog-cover before this line)
  const fogLead = probe?.fog?.share >= FOG_MUCH ? `the fog first (it covers ${pc(probe.fog.share)}), then: ` : '';
  // a fact unless DESIGN.md wants dark nights: a game may want a bright, readable night (fog color or an unlit sky on purpose)
  const darkNight = intent.find(a => a.want === 'dark' && a.when === 'night');
  add(darkNight ? 'contradiction' : 'fact', 'time-flat', `${wrote(darkNight)}${fact}. What makes it: ${fogLead}${cause}.`, 1 - Math.abs(tn.noon - tn.midnight) / Math.max(tn.noon, tn.midnight, 0.01),
    `${wrote(darkNight)}${flatTime ? 'calendar time barely changes the picture' : 'the night is not dark from lighting'}: luminance ${r2(t.noon)} at 12:00, ${r2(t.midnight)} at 00:00; from: ${fogLead}${brief}.`);
}

/** Outshone: it does change pixels once the sun / sky fill / environment are dimmed (a lamp at dusk under a strong sun): no contradiction */
export function lightNoEffect({ probe, add }) {
  for (const l of probe?.lights ?? []) if (!l.changed && !l.outshone)
    add('contradiction', 'light-no-effect', `light ${l.name} (${l.type}) changes no pixel in this view although its range reaches the camera's view, even with the sun, sky fill and environment dimmed: intensity ${r2(l.intensity)}` +
      `${l.distance !== undefined ? `, distance ${r2(l.distance)}, decay ${r2(l.decay)}` : ''}, ${r2(l.toCamera)} m from the camera. Likely cause: intensity too low for its units / decay, ` +
      `a range that ends before the lit surfaces, unlit materials in view, or the light on another layer (layers ${l.layers}, camera ${l.cameraLayers}).`, 0.01,
      `light ${l.name} (${l.type}) changes no pixel though its range reaches the view: intensity ${r2(l.intensity)}${l.distance !== undefined ? `, distance ${r2(l.distance)}, decay ${r2(l.decay)}` : ''}.`);
}

/** Large clipped areas: a fact (a game may want a blown-out sky or a blinding scene), a contradiction only under a DESIGN.md no-glare, as glare */
export function clipped({ N, P, intent, add }) {
  const noGlareWish = intent.find(a => a.want === 'noGlare');
  if (N.overexposed >= 0.1)
    add(noGlareWish ? 'contradiction' : 'fact', 'clipped', `${wrote(noGlareWish)}${pc(N.overexposed)} of the picture is clipped (a channel >= ${CLIP.channel} and luma >= ${CLIP.luma}): no detail is left there. Set by: ${list([P.exposure, P.toneMapping, P.sun, P.env]) || 'exposure / light intensities'}${P.post ? `, ${said(P.post)}` : ''}.`, N.overexposed,
      `${wrote(noGlareWish)}${pc(N.overexposed)} of the picture is clipped; set by: ${list([P.exposure, P.toneMapping, P.sun, P.env]) || 'exposure / light intensities'}${P.post ? ', engine.post' : ''}.`);
}

// the cost: mean luma edge under what this source blows out, on vs off (probe-lights.mjs glareTools). Below 0.01 with it off there was no detail to lose
const cost = d => !d ? '' : d.off < 0.01 ? ', a flat area underneath (no detail lost)'
  : `, the detail under it (luma edge ${r2(d.on)} on, ${r2(d.off)} off) ${d.on < d.off ? `${Math.round((1 - d.on / d.off) * 100)}% lost` : 'kept'}`;

/**
 * Glare: near-white spots a light or a glowing material causes (turning that one source off brings those pixels back below near-white), however
 * small the share: the whole-picture share never sees a few blown-out lamps. Sun / sky brightness is not attributed to a source here, so a bright
 * day stays quiet. A fact, not a contradiction: a game may want blinding light. It turns into a contradiction only when DESIGN.md says no glare
 * (readIntent 'noGlare'), the same rule as every intent hint; what the glare costs (detail lost under it) is stated so the game can weigh it.
 */
export function glare({ N, P, probe, intent, add }) {
  const gl = probe?.glare, noGlare = intent.find(a => a.want === 'noGlare');
  const glareKind = noGlare ? 'contradiction' : 'fact', glareWhy = noGlare ? `differs from DESIGN.md: you wrote '${noGlare.clause}' (${noGlare.row}); ` : '';
  if (gl?.sources?.length) {
    const what = s => `blows out ${pc(s.clipped)}${cost(s.detail)}${s.halo ? ` and lifts ${pc(s.halo)} more to near white` : ''}`;
    const src = gl.sources.map(s => s.kind === 'light'
      ? `light ${s.name} (${s.type}) ${what(s)}: intensity ${r2(s.intensity)}${s.distance !== undefined ? `, distance ${r2(s.distance)}, decay ${r2(s.decay)}` : ''}, ${r2(s.toCamera)} m from the camera`
      : `material '${s.name}' (${s.meshes} mesh${s.meshes > 1 ? 'es' : ''} in view) ${what(s)}: emissive ${s.emissive} x emissiveIntensity ${r2(s.emissiveIntensity)}${s.toneMapped === false ? ', toneMapped false' : ''}`);
    const ctx = [said(P.exposure), said(P.toneMapping), gl.bloom && `bloom ${gl.bloom.enabled ? `strength ${r2(gl.bloom.strength)}, threshold ${r2(gl.bloom.threshold)}, radius ${r2(gl.bloom.radius)}` : 'off'}`].filter(Boolean).join(', ');
    add(glareKind, 'glare', `${glareWhy}glare: ${pc(gl.clipped)} of the picture is near white (a channel >= ${HOT.channel}, luma >= ${HOT.luma}) in ${N.hotspots || 'some'} spot(s); ` +
      `turning one source off at a time, these bring part of it back: ${src.join('; ')}. Also in play: ${ctx || 'exposure / tone mapping'}.`,
      gl.sources.reduce((a, s) => a + s.clipped + (s.halo || 0), 0),
      `${glareWhy}glare: ${pc(gl.clipped)} near white; ${src[0]}${src.length > 1 ? ` (+${src.length - 1} more source${src.length > 2 ? 's' : ''})` : ''}.`);
  } else if (!probe && N.hotspots) {
    // a saved picture (shot --image): the spots are counted, but which light / material makes them and what they cover needs the live page
    add(glareKind, 'hotspots', `${glareWhy}${N.hotspots} near-white spot(s) (a channel >= ${HOT.channel}, luma >= ${HOT.luma}). From a picture alone the source is unknown: `
      + 'threedog shot or threedog snap on the running page turns each light and glowing material off once and names the one that makes them.', 0.001);
  }
}

/**
 * Over a budget (the probe's out.budget, the same values and limits as engine.budget): a limit the game wrote is its own declaration (intent); the
 * engine's default line for lights is a fact. Tier is printed because a game picks its limits from it: engine.budget.enable(engine.tier === 'low' ? {...} : {...})
 */
export function overBudget({ probe, add }) {
  const bg = probe?.budget;
  for (const o of bg?.over ?? []) {
    const whose = o.own ? `your engine.budget limit ${o.limit}` : `the engine's default guide ${o.limit} (${BUDGET_WHY[o.category]}; nothing is cut at it, measure with threedog perf; engine.budget.enable({ ${o.category}: n }) sets yours)`;
    // size: shadow maps by their share of the frame's passes over the scene (13 maps beside the one main pass: 0.93), the rest by how far over the limit.
    // Why: two point lights with shadows tripled the frame's triangles and this line, ranked by "13 over 12", was folded into "2 more" behind "9 lights over 8"
    const maps = o.category === 'shadowMaps', cost = maps && bg.triangles ? `${(bg.triangles / 1e6).toFixed(1)} M triangles a frame with them` : '';
    // brief: value, limit and the way out; the full sentence runs past LINE_MAX and clipLine would cut the usage first. The measured cost stands in for the general reason
    add(o.own ? 'intent' : 'fact', 'over-budget', `${o.value} ${BUDGET_WORDS[o.category]}, over ${whose}; tier ${bg.tier}${cost && `; ${cost}`}. ${budgetNext(o.category, bg)}.`, maps ? o.value / (o.value + 1) : Math.min(1, o.value / o.limit - 1),
      `${o.category} ${o.value} over ${o.own ? `${o.limit} (tier ${bg.tier}${cost && `; ${cost}`})` : `default ${o.limit} (a guide: ${cost || BUDGET_WHY[o.category]}; tier ${bg.tier})`}: ${budgetNext(o.category, bg)}.`);
  }
}

/**
 * Key against fill (the probe's out.key): what the sun / key light and the fill each add to the mean brightness (each turned off once) and how much
 * darker the shadowed areas are. Why a fact on every lit shot: whether a picture reads as lit is mostly this ratio (and warm / cool between lit and
 * shaded sides), and a flat day had no line pointing at it. A contradiction only when DESIGN.md asks for strong light.
 */
export function lightBalance({ P, probe, sh, intent, isDay, add }) {
  const k = probe?.key;
  if (!k) return;
  const dk = Math.max(0, k.base - k.noKey), df = Math.max(0, k.base - k.noFill);
  if (dk + df < 0.01) return;
  const ks = dk / (dk + df), lit = sh && sh.sunLit && sh.area >= 0.003 ? sh.depth : null;
  const fillP = list([P.hemi, P.env, P.ambient]);
  const strong = intent.find(a => a.want === 'strongLight' && (!a.when || isDay == null || (a.when === 'day') === isDay));
  const weak = strong && (ks < 0.5 || (lit !== null && lit < 0.2));
  const text = `light: the sun / key gives ${Math.round(ks * 100)}% of the lit brightness, the fill ${Math.round((1 - ks) * 100)}%` +
    (lit !== null ? `; shadowed areas are ${pc(lit)} darker than lit` : '') + ` (${said(P.sun) ?? 'sun'}${fillP ? `; fill ${fillP}` : ''})`;
  // size: the share of the brightness that is not the key (a flat picture ranks high)
  // printed short ("engine.lights.sun intensity 2.19" -> "sun intensity 2.19"), so the line stays one sentence
  const bare = p => p && `${p.name.replace(/^engine\.lights\./, '')} ${r2(p.value)}`;
  const brief = `light: sun / key ${Math.round(ks * 100)}%, fill ${Math.round((1 - ks) * 100)}% of the lit brightness${lit !== null ? `; shadows ${pc(lit)} darker` : ''}` +
    ` (${[P.sun, P.hemi, P.env, P.ambient].map(bare).filter(Boolean).join(', ')})`;
  const why = weak ? `differs from DESIGN.md: you wrote '${strong.clause}' (${strong.row}); ` : '';
  add(weak ? 'contradiction' : 'fact', 'light-balance', `${why}${text}.`, 1 - ks, `${why}${brief}.`);
}
