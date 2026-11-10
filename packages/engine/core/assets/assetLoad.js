// File loading for engine.assets, split into the phases engine.loading reports: download -> decode -> upload.
// Each step names the failing file and HTTP status, and a glTF records what it references but could not load
// (a texture / .bin that 404s), so "the model looks gray" is traceable to one path instead of a bare "failed".
import { coded } from '../base/errorHints.js';
import * as THREE from 'three';
import { texturesOf } from '../stream/prepare.js';
import { restoreBaked, toGLB, fromGLTF } from './Baked.js';
import { warnOnce, DEV_SERVER, BASE_URL, fmt } from '../base/validate.js';
import { neutralMaterial } from '../../render/neutral.js';
import { maxAnisotropy, isWebGPU } from '../../render/backend.js';

const BASE = BASE_URL;   // DEV_SERVER: only npm run dev serves the /__threedog/cache endpoint
const CACHE = '/__threedog/cache/';
const STALE = 'The generator code for "{name}" has changed, so it is built from code now; run npm run bake once it is final';
const NO_CACHE = '[cache] the dev server has no threedog model cache (a plain Vite server without the threedog plugin): code-generated models are built every time. Use the vite config of the game template (threedog gameConfig) to cache them';

const CACHE_ERR = '[cache] the threedog model cache could not key "{name}" ({why}), so code-generated models are built every time; the vite config is fine, the dev server log has the cause';

// A dev / preview server answers a missing path with its index.html (status 200): treat an HTML answer for an asset as "not found"
const NOT_THERE = 'not found (404: the server sent an HTML page instead, so the file is not at this path)';
const isHtml = res => /text\/html/i.test(res.headers.get('content-type') || '');

/** Error with the failing URL and HTTP status (status 0 = network / CORS / not an HTTP failure) */
export class LoadError extends Error {
  /** @param {string} message @param {{ url: string, status?: number }} info */
  constructor(message, { url, status = 0 }) { super(message); this.url = url; this.status = status; }
}

/** Extensions a glTF file uses (reads only the JSON part, not the whole file) */
function gltfExtensions(buf) {
  const dv = new DataView(buf);
  let json;
  if (buf.byteLength >= 20 && dv.getUint32(0, true) === 0x46546c67) json = new TextDecoder().decode(new Uint8Array(buf, 20, dv.getUint32(12, true)));
  else json = new TextDecoder().decode(buf);
  try { return JSON.parse(json).extensionsUsed || []; } catch { return []; }
}

/** Download as ArrayBuffer, reporting progress when the server sends a length; records size and version headers on the task */
async function download(url, task) {
  task.phase('download', 0);
  const res = await fetch(url, { signal: task.signal });
  if (!res.ok) throw new LoadError(`${res.status} ${res.statusText}`.trim(), { url, status: res.status });
  if (isHtml(res)) throw new LoadError(NOT_THERE, { url, status: 404 });
  const total = +(res.headers.get('content-length') || 0);
  task.source.version = res.headers.get('etag') || res.headers.get('last-modified') || null;
  let buf;
  if (total && res.body) {   // stream so a big model shows 0-100% instead of sitting at "downloading"
    const reader = res.body.getReader(), parts = [];
    let got = 0;
    for (let r; !(r = await reader.read()).done;) { parts.push(r.value); got += r.value.length; task.progress = Math.min(1, got / total); }
    const all = new Uint8Array(got);
    let at = 0; for (const p of parts) { all.set(p, at); at += p.length; }
    buf = all.buffer;
  } else buf = await res.arrayBuffer();
  task.source.bytes = buf.byteLength;
  return buf;
}

/** Upload textures to the GPU now, so the first frame that shows them does not stall (the 'upload' phase). A WebGPURenderer before start() has no GPU to upload to and
 *  throws if asked, so a load then leaves the texture for its first frame: this step only saves a stall, it never decides whether the load works */
function upload(assets, textures, task) {
  task.phase('upload');
  const r = assets.engine.renderer;
  if (r.initialized === false) return;
  for (const t of textures) r.initTexture(t);
}

// task.signal aborts when the load is ended (assetEntry.js). Before a value exists a phase just stops (the throw goes nowhere: an ended load reports
// nothing); once one exists it is returned as is, so the caller frees it, and nothing further touches the renderer or document.fonts, which may be gone.

/** Download a glTF, set up the Draco / KTX2 decoder it needs, parse it and upload its textures. Returns the gltf */
export async function loadGltf(assets, url, task) {
  const buf = await download(url, task), used = gltfExtensions(buf);
  task.phase('decode');
  if (used.includes('KHR_draco_mesh_compression')) await decoder(assets, 'draco');
  if (used.includes('KHR_texture_basisu')) await decoder(assets, 'ktx2');
  task.signal.throwIfAborted();   // a disposed decoder would start its workers again
  // A per-file manager hears which referenced files (.bin, textures) failed; GLTFParser reads the manager when parse() starts,
  // so swapping it around the synchronous start of parseAsync scopes it to this file even with several loads in flight
  const mgr = new THREE.LoadingManager(), missing = task.missing;
  mgr.onError = ref => { if (!missing.includes(ref)) missing.push(ref); };
  const prev = assets.gltf.manager;
  assets.gltf.manager = mgr;
  const parsing = assets.gltf.parseAsync(buf, THREE.LoaderUtils.extractUrlBase(url));
  assets.gltf.manager = prev;
  let gltf;
  try { gltf = restoreBaked(await parsing); }   // baked file: restore materials etc.
  catch (err) { throw new LoadError(String(err?.message ?? err) + (missing.length ? ` (missing: ${missing.join(', ')})` : ''), { url: missing[0] ?? url }); }
  if (task.signal.aborted) return gltf;
  await noteFailedTextures(gltf, missing);
  task.source.animations = gltf.animations.map(a => a.name);
  upload(assets, texturesOf(gltf.scene), task);
  return gltf;
}

/** GLTFLoader swallows a texture that fails to decode (KTX2 / basis transcoder, bad image): it logs "Couldn't load texture" and the material just has no map,
 *  and the LoadingManager never hears of it. Its texture cache still holds the answer (null), so a model that arrived without a texture is recorded as
 *  missing a reference: loading shows it as partial instead of ok. Names are the image file, or "embedded texture" for data inside the file */
async function noteFailedTextures(gltf, missing) {
  const parser = gltf.parser, cache = parser?.textureCache;
  if (!cache) return;
  for (const [key, p] of Object.entries(cache)) {
    if (await p) continue;
    const ref = key.slice(0, key.lastIndexOf(':'));   // the cache key is "<uri or bufferView>:<sampler>"
    const name = /^\d+$/.test(ref) ? `embedded texture (buffer view ${ref}, failed to decode)` : ref.startsWith('data:') ? 'embedded texture (failed to decode)' : ref;
    if (!missing.includes(name)) missing.push(name);
  }
}

/** Load a texture (.ktx2 through KTX2Loader, .hdr through HDRLoader), apply the entry's options and upload it */
export async function loadTexture(assets, e, task) {
  // a texture made in code, registered by name (manifest textures: { brick: () => makeBrick() } or { brick: myTexture }): used as made,
  // its own colorSpace / wrap / repeat untouched (the game chose them); a function runs once per entry, `this` like a model generator
  if (e.opts.build || e.opts.texture) {
    task.phase('build');
    const t = e.opts.texture ?? await e.opts.build.call({ palette: assets.palette, engine: assets.engine });
    if (!t?.isTexture) throw new LoadError(`the texture generator returned ${t === null ? 'null' : typeof t}, not a THREE.Texture`, { url: null });
    return t;
  }
  task.phase('download');
  const ktx = /\.ktx2(\?|$)|^data:image\/ktx2/i.test(e.url);
  const hdr = /\.hdr(\?|$)/i.test(e.url);   // Radiance HDR (environment lighting): float data in linear color
  let t;
  try {
    if (ktx) { const k = await decoder(assets, 'ktx2'); task.signal.throwIfAborted(); t = await k.loadAsync(e.url); }
    else if (hdr) t = await new (await import('three/addons/loaders/HDRLoader.js')).HDRLoader().loadAsync(e.url);
    else t = await assets.tex.loadAsync(e.url);
  }
  catch (err) {
    if (task.signal.aborted) throw err;
    // an <img> error carries no status: ask the server once so the report says 404 vs a broken file
    const status = await fetch(e.url, { method: 'HEAD' }).then(r => (!r.ok ? r.status : isHtml(r) ? 404 : 0), () => 0);
    throw new LoadError(status === 404 ? NOT_THERE : status ? `HTTP ${status}` : String(err?.message ?? 'not a decodable image'), { url: e.url, status });
  }
  if (task.signal.aborted) return t;
  if (e.opts.color === false) t.colorSpace = THREE.NoColorSpace;
  else if (!t.isCompressedTexture && !hdr) t.colorSpace = THREE.SRGBColorSpace;   // KTX2 carries its own color space
  t.anisotropy = maxAnisotropy(assets.engine.renderer);
  if (e.opts.pixelated) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestMipmapNearestFilter; }
  if (e.opts.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(e.opts.repeat[0], e.opts.repeat[1]); }
  upload(assets, [t], task);
  return t;
}

/** Import and create DRACOLoader / KTX2Loader on first use. Decoders default to the ones shipped with three (vite bundles them); if createEngine({ decoders }) is set, download from there */
function decoder(assets, kind) {
  return assets._loaders[kind] ||= (async () => {
    const dir = assets.engine._decoders;
    if (kind === 'draco') {
      const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
      assets.draco = new DRACOLoader();
      if (dir) assets.draco.setDecoderPath(dir + 'draco/');
      assets.gltf.setDRACOLoader(assets.draco);
      return assets.draco;
    }
    const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
    const r = assets.engine.renderer;
    if (isWebGPU(r)) await r.init();   // detectSupport asks the GPU, and an asset may be requested before start(). three's init runs once, start() goes on from it
    assets.ktx2 = new KTX2Loader().detectSupport(r);
    if (dir) assets.ktx2.setTranscoderPath(dir + 'basis/');
    assets.gltf.setKTX2Loader(assets.ktx2);
    return assets.ktx2;
  })();
}

/** Download a sound file and decode it. Decoding needs no click, so the context is made here if the first click has not come yet */
export async function loadAudio(assets, e, task) {
  const { audio } = assets.engine; audio._init();
  const { ctx } = audio;   // read now: a dispose during the download clears audio.ctx
  if (!ctx) throw new LoadError('this browser has no Web Audio', { url: e.url });
  const buf = await download(e.url, task);
  task.phase('decode');
  try { return await ctx.decodeAudioData(buf); } catch (err) { throw new LoadError(`not a sound file this browser can decode (${err?.message ?? err})`, { url: e.url }); }
}

/** FontFace descriptors an asset pack's fonts entry may carry (everything else on the entry is the asset's own: url, family, critical...) */
const FONT_DESCRIPTORS = ['weight', 'style', 'stretch', 'unicodeRange', 'display', 'featureSettings', 'variationSettings'];
/**
 * Download a font file and add it to document.fonts as a FontFace (family = entry.family, else the asset name). Downloaded with fetch
 * (not the FontFace url source) so a 404 reports its HTTP status like any other asset; the face is decoded before it is added, so a
 * broken file fails here instead of silently falling back to the system font. Returns the FontFace
 */
export async function loadFont(assets, e, task) {
  const family = e.opts.family ?? e.name;
  if (typeof family !== 'string' || /["'();\\<>]/.test(family))
    throw new LoadError(`font family ${JSON.stringify(family)} must be a plain name without quotes, brackets, ';' or '\\', e.g. family: 'PixelFont'`, { url: e.url });
  const buf = await download(e.url, task);
  task.phase('decode');
  const desc = Object.fromEntries(FONT_DESCRIPTORS.filter(k => e.opts[k] != null).map(k => [k, String(e.opts[k])]));
  const face = new FontFace(family, buf, { display: 'swap', ...desc });
  try { await face.load(); } catch (err) { throw new LoadError(`not a font the browser can read (${err.message})`, { url: e.url }); }
  if (!task.signal.aborted) document.fonts.add(face);
  return face;
}

/** Stand-ins for a degradable asset that failed: neutral gray (hard rule 1: the engine has no art of its own) */
export function placeholder(type) {
  if (type === 'texture') { const t = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1); t.needsUpdate = true; return t; }
  if (type === 'model') {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), neutralMaterial('default')));
    g.name = 'placeholder';
    return { scene: g, animations: [] };
  }
  return null;   // sound: silence; font: the next family in ui.theme.font (the system font)
}

/** Code-generated model: baked file -> dev cache -> build now (Assets.cached, internal); returns { scene, animations, geometry? } */
export async function generated(assets, name, build, params, task) {
  const wrap = v => v.isBufferGeometry
    ? { geometry: v, scene: new THREE.Mesh(v, neutralMaterial('default', { vertexColors: !!v.attributes.color })), animations: [] }
    : { scene: v, animations: v.animations ?? [] };
  const same = JSON.stringify(params ?? null);
  const ctx = { palette: assets.palette, engine: assets.engine };   // a function() generator reads this.palette
  const colored = Object.keys(assets.palette).length > 0;
  const baked = (await bakedIndex(assets))[name];
  task.signal.throwIfAborted();   // the generator has not run yet: an ended load need not start it
  // npm run bake has no engine, so a baked file carries no palette: with one set, only a hand-made file (source: 'file') stands in for the generator
  const bakedOk = baked && JSON.stringify(baked.params ?? null) === same && (!colored || baked.source === 'file');
  const file = async url => wrap(fromGLTF(await loadGltf(assets, url, task)));
  if (!DEV_SERVER) return bakedOk ? file(BASE + 'models/baked/' + baked.file) : wrap(await build.call(ctx, params));
  // In dev: ask the dev server for the current hash of this generator (with its file and imports)
  // a plain Vite dev server without threedog's plugin answers with index.html: no cache then, build now (said once)
  // Three answers, three messages: JSON = the cache; an HTML page = no threedog plugin (NO_CACHE); a plugin error status (403 not same-origin,
  // 500 the key could not be computed) = the plugin is there and said why. Why: every failure used to read "no model cache" even with the
  // template's own vite config, which sent the AI to a config that was already right
  let info = null, why = null;
  try {
    const r = await fetch(CACHE + 'key', { method: 'POST', body: JSON.stringify({ name, src: String(build), params: colored ? [params ?? null, ctx.palette] : params ?? null }) });
    const text = await r.text();
    if (r.ok && !/^\s*</.test(text)) info = JSON.parse(text);
    else if (!r.ok) why = `${r.status}${text ? ': ' + text.slice(0, 160) : ''}`;
  } catch (err) { why = String(err?.message ?? err); }
  task.signal.throwIfAborted();
  if (!info) {
    warnOnce(coded('asset-cache', why ? fmt(CACHE_ERR, { name, why }) : NO_CACHE), why ? 'asset-cache-err' : undefined);
    return bakedOk ? file(BASE + 'models/baked/' + baked.file) : wrap(await build.call(ctx, params));
  }
  if (bakedOk) {
    if (baked.source === 'file' || baked.key === info.key) return file(BASE + 'models/baked/' + baked.file);
    warnOnce(coded('asset-cache', fmt(STALE, { name })));
  }
  if (info.hit) return file(CACHE + info.key + '.glb');
  const t0 = performance.now(), v = await build.call(ctx, params);   // measure：build time
  // { build, cache: false } in the manifest: never stored (a material the GLB round trip cannot keep, see Baked.js)
  if (performance.now() - t0 >= assets.cacheMinMs && assets.entries.get(name)?.opts.cache !== false)   // measure
    toGLB(v, name).then(buf => fetch(CACHE + info.key + '.glb', { method: 'PUT', body: buf })).catch(err => warnOnce(coded('asset-cache', '[cache] could not store a built model in .threedog/cache (' + err.message + '); it is built again next time')));
  return wrap(v);
}
/** Bake manifest public/models/baked/index.json (empty if missing: a 404 means nothing was baked; any other failure or a malformed file is said once) */
export function bakedIndex(assets) {
  const bad = why => { warnOnce(coded('asset-cache', `[assets] the bake manifest models/baked/index.json could not be used (${why}); baked models are ignored and built again`)); return {}; };
  return assets._baked ||= fetch(BASE + 'models/baked/index.json').then(r => (r.ok ? r.text() : r.status === 404 ? '{}' : bad('HTTP ' + r.status))).then(t => { try { const m = typeof t === 'string' ? JSON.parse(t) : t; return m && typeof m === 'object' && !Array.isArray(m) ? m : bad('the top level is not an object: ' + String(t).slice(0, 20)); } catch (e) { return bad(e.message); } }, e => bad(e.message));
}
