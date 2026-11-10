// Page side of the picture check (probe.mjs says how these files run): the tools every probe uses, and the values the hints quote.

/** c, what every probe reads: the engine's parts, grab() and its helpers. c.raw holds the last grab's bytes */
export function probeTools(e, [W, H], hot) {
  const R = e.renderer, c = { e, R, scene: e.scene, cam: e.camera, T: globalThis.__threedogThree, W, H, raw: null };
  const c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
  const g = c2.getContext('2d', { willReadFrequently: true });
  // drawImage of the WebGL canvas in the same task as the render: the drawing buffer is still there without preserveDrawingBuffer
  // hooks false (every probe render but one): the game's onRender hooks do not run, else picture code that writes three.js values each frame
  // put back the light a probe had just turned off and every light read "changes no pixel". true only right after the probe moved the time,
  // so the picture code maps the new time to its lights once (then the renders after it keep what the probe writes)
  const lumaOf = d => { const L = new Float32Array(d.length / 4); for (let i = 0; i < L.length; i++) L[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255; return L; };
  // lit particles take their light on the CPU in particles.update (modules/particles/lit.js), which a bare render never runs: recolor them
  // first (colors only: no motion, emission or visibility changes), else a probe that changes a light would see no change in them and call the light useless
  const grab = (hooks = false) => { e.particles?._relight?.(); e._tools.render(0, hooks); g.drawImage(R.domElement, 0, 0, W, H); return lumaOf(c.raw = g.getImageData(0, 0, W, H).data); };
  // near-white pixels of the last grab (HOT in numbers.mjs, passed in: this runs in the page)
  const clipped = L => { const m = new Uint8Array(L.length); for (let i = 0; i < L.length; i++) m[i] = Math.max(c.raw[i * 4], c.raw[i * 4 + 1], c.raw[i * 4 + 2]) >= hot.channel && L[i] >= hot.luma ? 1 : 0; return m; };
  const mean = L => { let s = 0; for (const v of L) s += v; return s / L.length; };
  return Object.assign(c, { lumaOf, grab, clipped, mean });
}

/** The lights the hints talk about and the values they quote: c.pic, key, sun, hemi, mine, params, and c.out, the result */
export function probeSettings(c) {
  const { e, R, scene } = c;
  // describe().picture is what three.js holds now, whoever wrote it: every value below goes by its three.js name
  const desc = e.describe?.({ only: ['picture', 'render', 'owned', 'time'] }), pic = desc?.picture ?? {}, fo = desc?.owned?.['shadow.follow'];
  // the key and fill lights: the engine's sun / hemisphere when they are in the scene, else the game's own strongest DirectionalLight /
  // HemisphereLight. Why: with createEngine({ lights: false }) the engine lights still exist outside the scene, and the hints named their
  // values for a picture the game lights itself
  const inScene = o => { for (let p = o; p; p = p.parent) if (p === scene) return true; return false; };
  const pickLight = (eng, is) => {
    if (eng && eng.visible && inScene(eng)) return { light: eng, engine: true };
    let best = null; scene.traverse(o => { if (is(o) && o.visible && (!best || o.intensity > best.intensity)) best = o; });
    return best && { light: best, engine: false };
  };
  const key = pickLight(e.lights?.sun, o => o.isDirectionalLight), fill = pickLight(e.lights?.hemi ?? e.lights?.hemisphere, o => o.isHemisphereLight);
  const sun = key?.light, hemi = fill?.light;
  const lightName = k => (k.engine ? `engine.lights.${k.light === e.lights?.sun ? 'sun' : 'hemi'}` : `${k.light.type} '${k.light.name || k.light.uuid.slice(0, 8)}'`);
  const lightParam = k => ({ name: `${lightName(k)} intensity`, value: k.light.intensity });
  let ambient = 0; scene.traverse(o => { if (o.isAmbientLight && o.visible) ambient += o.intensity; });
  const shadowParam = (what, value) => (sun ? { name: `${lightName(key)} shadow.${what}`, value } : null);
  const params = {
    exposure: { name: 'renderer.toneMappingExposure', value: pic.exposure ?? R.toneMappingExposure }, toneMapping: pic.toneMapping ? { name: 'renderer.toneMapping', value: pic.toneMapping } : null,
    sun: key ? lightParam(key) : null, hemi: fill ? lightParam(fill) : null,
    env: pic.environment?.present ? { name: 'scene.environmentIntensity', value: pic.environment.intensity } : null,
    ambient: ambient ? { name: 'AmbientLight intensity (sum)', value: ambient } : null,
    bias: shadowParam('bias', sun?.shadow.bias), normalBias: shadowParam('normalBias', sun?.shadow.normalBias),
    extent: sun?.shadow.camera.isOrthographicCamera ? { name: `${lightName(key)} shadow camera half width`, value: (sun.shadow.camera.right - sun.shadow.camera.left) / 2 } : null,
    mapSize: shadowParam('mapSize', sun?.shadow.mapSize.x),
    follow: fo ? { name: 'shadow box follow', value: fo.writer === 'engine' ? 'on' : 'off' } : null,
    shadowIntensity: shadowParam('intensity', sun?.shadow.intensity),
    fog: pic.fog ? { name: 'scene.fog', value: pic.fog.type === 'FogExp2' ? `density ${pic.fog.density}` : `near ${pic.fog.near} far ${pic.fog.far}` } : null,
    post: desc?.render?.post?.length ? { name: 'engine.post', value: desc.render.post.filter(x => x.on).map(x => x.name).join(' ') } : null,
  };
  for (const k in params) if (!params[k]) delete params[k];
  Object.assign(c, { pic, key, sun, hemi, params, mine: new Set([sun, hemi].filter(Boolean)) });
  // the engine's combination checks (core/inspect/pictureChecks.js), read here so shot prints the same sentences describe does
  c.out = { params, isDay: desc?.time?.isDay ?? null, shadows: null, time: null, lights: [], checks: desc?.render?.checks ?? [] };
}
