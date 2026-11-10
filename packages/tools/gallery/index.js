// The asset gallery (dev): every model and texture the game registered (engine.assets.manifest), each on a turntable under three light setups,
// so a person or an AI reviews all assets at once instead of hunting them in the world. Open it with ?gallery=1 on the dev page (the vite preset
// injects the import), or `threedog gallery [-w game]`; `threedog gallery --shots` writes one PNG per asset per light (headless, the same page).
// The light setups are lighting only and neutral on purpose (white-ish sun high, sun low, sky only): they test how an asset reads under
// different light, they are not a picture. The tone mapping and exposure are copied from the game's renderer, so colors match what the game shows.
// It is also the look-dev page (what model viewers share: turntable, switch environment, exposure and tone mapping, one channel at a time):
// two more light setups (studio: three's neutral RoomEnvironment as the environment map, so metals reflect something; game: the game's own
// lights and environment map, copied, never written), the channels albedo / normal / roughness / metalness / ao, an exposure and tone mapping
// override, and one material of the game (any kind, a TSL node material too) on a sphere. Why here and not a page of its own: the gallery
// already isolates an asset on its own renderer and writes shots headless; a second page would be a second staging, framing and shot path.
// It draws with its own renderer on its own canvas: the game's renderer, scene and state are untouched (the game is paused while open).
// That renderer is a WebGPURenderer when the game draws with one, an asset carries a node material (WebGLRenderer cannot draw TSL) or channel
// views are asked for in --shots (node materials; the live grid keeps the game's kind and offers channels only on WebGPU), else a WebGLRenderer. Each grid cell is a 2D canvas the
// picture is copied into, so both renderers fill the grid the same way.
// Plain three.js equivalent: a scene per asset, a camera fitted to its bounding sphere, one render per cell.
// three comes from the engine's package when the gallery opens: the same instance as the game's materials; this file also loads in node (gallery.mjs)
import { isDrawOnly } from 'threedog/draw-only';
let THREE;

/** Light setups: [name, sun elevation in degrees or null, sun intensity, sun color, sky intensity]. Neutral: no style lives here */
export const LIGHTS = [
  ['midday', 65, 2.6, 0xffffff, 0.7],
  ['lowSun', 10, 2.2, 0xffe2c8, 0.45],   // a low sun is slightly warmer in nature; kept mild so it is a light test, not a grade
  ['overcast', null, 0, 0xffffff, 2.0],
];
/** Every light setup a shot can pick (--light); the default is the three above, as before the look-dev setups existed */
export const LIGHT_NAMES = [...LIGHTS.map(l => l[0]), 'studio', 'game'];
const DEFAULT_LIGHTS = LIGHTS.map(l => l[0]);
/** --tone names -> three's tone mapping constants (the numbers of THREE.*ToneMapping: this file also loads in node, without three) */
export const TONES = { none: 0, linear: 1, reinhard: 2, cineon: 3, aces: 4, agx: 6, neutral: 7 };
/** Channel views: the value each material feeds into lighting, shown alone and unlit (data, not a look) */
export const CHANNELS = ['albedo', 'normal', 'roughness', 'metalness', 'ao'];

/** Registered model and texture names (named manifest entries, built-in ones left out) */
function assetNames(engine) {
  const out = { models: [], textures: [] };
  for (const [name, e] of engine.assets.entries) {
    if (!e.named || e.builtIn) continue;
    if (e.type === 'model') out.models.push(name); else if (e.type === 'texture') out.textures.push(name);
  }
  return out;
}

/** One asset as an Object3D centred on the ground at the origin, and the radius a camera has to fit */
async function stageOf(engine, type, name) {
  let obj;
  try {
    if (type === 'texture') {
      const t = await engine.assets.texture(name);
      obj = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide }));
      obj.position.y = 1;
      const g = new THREE.Group(); g.add(obj); obj = g;
    } else obj = await engine.assets.model(name);
  } catch (err) { return { name, type, error: String(err?.message ?? err) }; }
  return framed(name, type, obj);
}

/** obj centred on the ground at the origin under a pivot the turntable turns, with the radius a camera has to fit */
function framed(name, type, obj) {
  const box = new THREE.Box3().setFromObject(obj), c = box.getCenter(new THREE.Vector3());
  obj.position.x -= c.x; obj.position.z -= c.z; obj.position.y -= box.min.y;
  const pivot = new THREE.Group(); pivot.add(obj);
  const r = Math.max(0.1, box.getBoundingSphere(new THREE.Sphere()).radius);
  return { name, type, pivot, radius: r, height: box.max.y - box.min.y };
}

/**
 * One material of the running game on a sphere: the "look at one shader" case (a TSL node material is a material like any other).
 * Found by name in the game's scene, the debug views' stand-ins left out; the sphere has UVs, so its maps show.
 */
function materialStage(engine, name) {
  let m = null;
  const names = new Set();
  engine.scene.traverse(o => { for (const x of [].concat(o.material || [])) if (x?.name && !engine._tools?.standIn(x)) { names.add(x.name); if (!m && x.name === name) m = x; } });
  if (!m) return { name, type: 'material', error: `no material named "${name}" in the game's scene${names.size ? `; names: ${[...names].slice(0, 8).join(', ')}` : ''}` };
  const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), m);
  ball.castShadow = true;
  return framed(name, 'material', ball);
}

/** The light-setup scenes a run draws (names from LIGHT_NAMES): lights, a neutral ground disc; the asset pivot is moved in per draw. notes: one line per
 *  setup that could not copy something (the game setup), said once next to the shots instead of a silently different picture */
async function rigs(engine, R, names = LIGHT_NAMES) {
  const out = [];
  for (const name of names) {
    const scene = new THREE.Scene(), rig = { name, scene, notes: [], dispose: [] };
    scene.userData.suns = [];
    const l = LIGHTS.find(x => x[0] === name);
    if (l) {
      const [, elev, sun, color, sky] = l;
      scene.background = new THREE.Color(elev == null ? 0xb8bcc2 : elev < 20 ? 0x9aa4b2 : 0xaab8c8);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, sky));
      if (elev != null) {
        const d = new THREE.DirectionalLight(color, sun), a = THREE.MathUtils.degToRad(elev);
        d.position.set(Math.cos(a) * 10, Math.sin(a) * 10, Math.cos(a) * 6); d.castShadow = true;
        d.shadow.mapSize.set(1024, 1024); d.shadow.bias = -0.0001;   // bias is in shadow-camera depth units: keep it near 2-3 cm
        scene.add(d, d.target); scene.userData.suns.push(d);
      }
    } else if (name === 'studio') await studio(R, rig);
    else if (name === 'game') gameLights(engine, rig);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground); scene.userData.ground = ground;
    out.push(rig);
  }
  return out;
}

/** studio: three's RoomEnvironment prefiltered (PMREM) as the only light. Why: the sun setups have no environment map, and a metal reflects
 *  its surroundings, so there it reads near black; a plain gray room is what model viewers use for a neutral reflection */
async function studio(R, rig) {
  const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');
  const P = R.isWebGPURenderer ? (await import('three/webgpu')).PMREMGenerator : THREE.PMREMGenerator;
  const pm = new P(R), room = new RoomEnvironment();
  const target = pm.fromSceneAsync ? await pm.fromSceneAsync(room, 0.04) : pm.fromScene(room, 0.04);
  pm.dispose(); room.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); });
  rig.scene.environment = target.texture; rig.scene.background = new THREE.Color(0xa0a0a0);
  rig.dispose.push(() => target.dispose());
}

/**
 * game: copies of the game's lights and its environment map, so an asset is seen under the light it gets in the game, alone. Read only: clones,
 * and the same texture objects. Directional lights keep their direction (they light the asset at the origin like they light the world);
 * point, spot and area lights light a place in the world and are left out. A map the game drew on its own renderer (a PMREM, the sky's cube)
 * is a render target of that renderer and cannot be sampled by this one: it is left out and said in rig.notes.
 */
export function gameLights(engine, rig) {
  const g = engine.scene, { scene, notes } = rig, at = new THREE.Vector3(), to = new THREE.Vector3();
  scene.background = g.background?.isColor ? g.background.clone() : new THREE.Color(0x9aa4b2);
  if (g.environment?.isRenderTargetTexture) notes.push('environment map drawn on the game\'s renderer: not copied (lights only)');
  else if (g.environment) scene.environment = g.environment;
  scene.environmentIntensity = g.environmentIntensity ?? 1;
  if (g.environmentRotation) scene.environmentRotation.copy(g.environmentRotation);
  g.updateMatrixWorld();
  let local = 0;
  g.traverseVisible(o => {
    // a light the engine marked drawOnly is part of another one (a cascade's copies of the sun): copying it would add a sun each
    if (!o.isLight || isDrawOnly(o)) return;
    if (o.isAmbientLight || o.isHemisphereLight || o.isLightProbe) { const c = o.clone(false); c.position.setFromMatrixPosition(o.matrixWorld); scene.add(c); }
    else if (o.isDirectionalLight) {
      const d = o.clone(false);
      at.setFromMatrixPosition(o.matrixWorld); to.setFromMatrixPosition(o.target.matrixWorld);
      d.position.copy(at.sub(to).normalize().multiplyScalar(10)); d.target = new THREE.Object3D();
      // the copied shadow may be frozen (the engine turns autoUpdate off for a light at intensity 0): this one draws its own; frame() fits its camera to the asset
      d.shadow.autoUpdate = true; d.shadow.needsUpdate = true;
      scene.add(d, d.target); scene.userData.suns.push(d);
    } else local++;
  });
  if (!scene.children.length) notes.push('no light in the game\'s scene');
  if (local) notes.push(`${local} point / spot / area light(s) left out: they light places in the world`);
}

/** Put the asset into the rig scene, fit ground, shadow camera and the camera; yaw turns the asset */
function frame(rig, st, cam, yaw) {
  const { scene } = rig, r = st.radius;
  // one asset per rig scene at a time: the rigs are shared by every asset (and every grid cell), so the previous pivot leaves first,
  // or each picture would also show all assets drawn before it at the same origin
  if (scene.userData.pivot && scene.userData.pivot !== st.pivot) scene.remove(scene.userData.pivot);
  if (st.pivot.parent !== scene) scene.add(st.pivot);
  scene.userData.pivot = st.pivot;
  st.pivot.rotation.y = yaw;
  scene.userData.ground.scale.setScalar(r * 2.2);
  for (const sun of scene.userData.suns) {
    const s = sun.shadow.camera; s.left = s.bottom = -r * 1.5; s.right = s.top = r * 1.5; s.near = 0.1; s.far = 40 + r * 4;
    sun.position.setLength(10 + r * 2); s.updateProjectionMatrix();
  }
  const dist = r / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2)) * 1.05;
  cam.position.set(0, st.height * 0.5 + dist * 0.35, dist); cam.lookAt(0, st.height * 0.45, 0);
}

/** Whether any material under root is a node material (TSL: only WebGPURenderer draws it) */
export function hasNodeMaterial(root) {
  let n = false;
  root.traverse(o => { for (const m of [o.material].flat()) if (m?.isNodeMaterial) n = true; });
  return n;
}

/**
 * A renderer that matches the game's output (tone mapping, exposure, color space): a WebGPURenderer when the game draws with one, a staged
 * asset carries a node material or node is asked (the channel views), else a WebGLRenderer. Why the game's own class first: it is the three
 * instance its materials come from. exposure / tone (a TONES name) replace the copied ones for this renderer only: the game's stay as they are.
 */
async function rendererLike(engine, canvas, staged, { node = false, exposure = null, tone = null } = {}) {
  if (tone != null && !Object.hasOwn(TONES, tone)) throw new Error(`unknown tone "${tone}"; tone mappings: ${Object.keys(TONES).join(', ')}`);
  const g = engine.renderer, gpu = g.isWebGPURenderer || node || staged.some(st => st.pivot && hasNodeMaterial(st.pivot));
  let R;
  if (gpu) {
    const WebGPURenderer = g.isWebGPURenderer ? g.constructor : (await import('three/webgpu')).WebGPURenderer;
    R = new WebGPURenderer({ canvas, antialias: true });
    await R.init();
  } else R = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  R.toneMapping = tone != null ? TONES[tone] : g.toneMapping; R.toneMappingExposure = exposure ?? g.toneMappingExposure; R.outputColorSpace = g.outputColorSpace;
  R.shadowMap.enabled = true; R.shadowMap.type = THREE.PCFSoftShadowMap;
  return R;
}

/** The node kit the channel views build from (three/webgpu for the classes, three/tsl for the functions), loaded once on first use */
let nodeKit = null;
const loadNodeKit = async () => nodeKit ??= { N: await import('three/webgpu'), T: await import('three/tsl') };

/**
 * One unlit stand-in that shows channel ch of material m, cached per material (the live grid swaps every frame; a new material each time
 * would recompile). The values are the ones three feeds into lighting: albedo = color x map (the unlit base color, the rule of
 * engine.debug.view('albedo')), normal = three's normal material with the normal map (as engine.debug.view('normals')), roughness =
 * roughness x roughnessMap.g, metalness = metalness x metalnessMap.b, ao = aoMap.r scaled by aoMapIntensity (1 without a map); a node
 * material's own colorNode / normalNode / roughnessNode / metalnessNode / aoNode replaces the classic value. The gray values are shown as
 * themselves (0.5 reads as 50 % gray, no tone mapping), so the value facts read the value. Cut-outs (alphaTest) and the shape nodes stay.
 * @param {{ N: any, T: any }} kit @param {any} m @param {string} ch @param {WeakMap<any, any>} cache
 */
function channelMaterial({ N, T }, m, ch, cache) {
  let per = cache.get(m);
  if (!per) cache.set(m, per = {});
  // keyed on m.version too: the stand-in copies the values when it is made, so an edit (needsUpdate = true) gets a fresh one
  if (per[ch]?.userData.of === m.version) return per[ch];
  per[ch]?.dispose();
  const base = { side: m.side, alphaTest: m.alphaTest ?? 0, alphaMap: m.alphaMap ?? null, toneMapped: false, fog: false };
  let s;
  if (ch === 'normal') {
    s = new N.MeshNormalNodeMaterial(base);
    for (const k of ['normalMap', 'normalMapType', 'bumpMap', 'bumpScale']) if (m[k] !== undefined) s[k] = m[k];
    if (m.normalScale) s.normalScale.copy(m.normalScale);
    s.normalNode = m.normalNode ?? null;
  } else if (ch === 'albedo') {
    s = new N.MeshBasicNodeMaterial({ ...base, color: m.color ?? 0xffffff, map: m.map ?? null, vertexColors: !!m.vertexColors });
    s.colorNode = m.colorNode ?? null;
  } else {
    const tex = t => T.texture(t);   // the map's own UV channel (uv(t.channel))
    const v = ch === 'roughness' ? m.roughnessNode ?? T.float(m.roughness ?? 1).mul(m.roughnessMap ? tex(m.roughnessMap).g : 1)
      : ch === 'metalness' ? m.metalnessNode ?? T.float(m.metalness ?? 0).mul(m.metalnessMap ? tex(m.metalnessMap).b : 1)
      : m.aoNode ?? (m.aoMap ? tex(m.aoMap).r.sub(1).mul(m.aoMapIntensity ?? 1).add(1) : T.float(1));
    s = new N.MeshBasicNodeMaterial(base);
    // the output turns linear into display values; the inverse first, so the screen shows the number itself
    s.colorNode = T.vec4(T.sRGBTransferEOTF(T.vec3(v)), m.alphaTest > 0 && m.map ? tex(m.map).a : 1);
  }
  s.positionNode = m.positionNode ?? null; s.vertexNode = m.vertexNode ?? null;   // swaying / displaced shapes keep their shape
  s.name = `gallery:${ch}:${m.name || ''}`;
  s.userData.of = m.version;
  return per[ch] = s;
}

/** Show channel ch on every mesh under root (cached stand-ins); returns the undo, which puts the very same materials back (the stand-ins stay cached) */
function showChannel(kit, root, ch, cache) {
  const saved = [];
  root.traverse(o => {
    if (!o.material) return;
    saved.push([o, o.material]);
    o.material = Array.isArray(o.material) ? o.material.map(m => channelMaterial(kit, m, ch, cache)) : channelMaterial(kit, o.material, ch, cache);
  });
  return () => { for (const [o, m] of saved) o.material = m; };
}

/** Draw channel ch of st in rig's framing: unlit on a dark plain background, the ground hidden (it is not the asset's) */
function drawChannel(R, kit, st, cam, rig, yaw, ch, cache) {
  frame(rig, st, cam, yaw);
  const { scene } = rig, bg = scene.background;
  scene.background = new THREE.Color(0x1d1f22); scene.userData.ground.visible = false;
  const undo = showChannel(kit, st.pivot, ch, cache);
  try { R.render(scene, cam); } finally { undo(); scene.background = bg; scene.userData.ground.visible = true; }
}

/** Review modes `threedog gallery --shots --mode` adds next to the light shots. silhouette: every model filled pure black on white, to read the
 *  outline alone; value: the midday shot as grayscale luminance, to see the light/dark structure without hue; the channels (CHANNELS) one
 *  picture each. They measure facts, never a verdict. */
export const MODES = ['silhouette', 'value', ...CHANNELS];

/**
 * Options that only mean something with --shots, and a port that is a number: wrong ones stop with the fix instead of being ignored (like --mode).
 * @returns {{ modes: string[], lights: string[] | null, exposure: number | null, tone: string | null, material: string | null }}
 */
export function parseGalleryOptions(opt) {
  for (const k of ['size', 'only', 'light', 'exposure', 'tone', 'material']) if (opt[k] != null && opt[k] !== false && !opt.shots) throw new Error(`--${k} works with --shots (it shapes the pictures written to disk; the live gallery has its own controls)`);
  if (opt.port != null && !/^\d+$/.test(String(opt.port))) throw new Error(`--port is a port number, e.g. --port 5181; got ${JSON.stringify(opt.port)}`);
  const lights = opt.light == null || opt.light === false ? null : [...new Set(String(opt.light).split(',').map(s => s.trim()).filter(Boolean))];
  const badLight = lights?.filter(l => !LIGHT_NAMES.includes(l)) ?? [];
  if (lights && (badLight.length || !lights.length)) throw new Error(`unknown --light ${badLight.join(',') || '(empty)'}; light setups: ${LIGHT_NAMES.join(', ')}`);
  const exposure = opt.exposure == null || opt.exposure === false ? null : Number(opt.exposure);
  if (exposure != null && !(exposure > 0)) throw new Error(`--exposure is a number above 0 (the renderer's toneMappingExposure), e.g. --exposure 1.5; got ${JSON.stringify(opt.exposure)}`);
  const tone = opt.tone == null || opt.tone === false ? null : String(opt.tone);
  if (tone != null && !Object.hasOwn(TONES, tone)) throw new Error(`unknown --tone ${opt.tone}; tone mappings: ${Object.keys(TONES).join(', ')}`);
  const material = typeof opt.material === 'string' && opt.material ? opt.material : null;
  if (opt.material != null && opt.material !== false && !material) throw new Error('--material takes the name of a material in the game\'s scene, e.g. --material lava');
  return { modes: parseModes(opt.mode, opt.shots), lights, exposure, tone, material };
}

/** One file stem per asset name: characters outside [\w.-] become _, and two names that end up alike ('a/b', 'a_b', or 'Rock' and 'rock' on a disk that ignores case) get -2, -3 so no picture overwrites another */
export function fileStems(names) {
  const used = new Set(), out = new Map();
  for (const n of names) {
    if (out.has(n)) continue;
    const base = n.replace(/[^\w.-]+/g, '_');
    let stem = base;
    for (let i = 2; used.has(stem.toLowerCase()); i++) stem = `${base}-${i}`;
    used.add(stem.toLowerCase()); out.set(n, stem);
  }
  return out;
}

/** Text into HTML (asset names are the game's own strings: a name with < or & must not break the page) */
export const escapeHtml = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** "--mode a,b" -> the list; throws on an unknown mode, or a mode without --shots (the live grid shows the light setups only) */
export function parseModes(mode, shots) {
  if (mode == null || mode === false) return [];
  if (!shots) throw new Error('--mode works with --shots (it writes extra pictures; the live gallery shows the light setups only)');
  const list = String(mode).split(',').map(s => s.trim()).filter(Boolean);
  const bad = list.filter(m => !MODES.includes(m));
  if (bad.length || !list.length) throw new Error(`unknown --mode ${bad.join(',') || '(empty)'}; modes: ${MODES.join(', ')}`);
  return [...new Set(list)];
}

/**
 * Give every material under root a replacement and return the undo. Why swap and restore instead of scene.overrideMaterial: the replacement
 * keeps each material's side, alphaTest and alpha map (a cut-out leaf card stays a leaf, not a quad), and the asset may be a cached instance
 * the game also shows, so its own materials must come back untouched.
 * @param {any} root @param {(m: any) => any} make @returns {() => void}
 */
export function swapMaterials(root, make) {
  const saved = [];
  root.traverse(o => {
    if (!o.material) return;
    saved.push([o, o.material]);
    o.material = Array.isArray(o.material) ? o.material.map(make) : make(o.material);
  });
  return () => {
    for (const [o, m] of saved) {
      for (const tmp of Array.isArray(o.material) ? o.material : [o.material]) tmp.dispose?.();
      o.material = m;
    }
  };
}

const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];   // Rec. 709 weights on the output (display) values
const r2 = v => Math.round(v * 100) / 100;

/** Silhouette picture (RGBA, black on white) -> fill: share of the frame covered; boxFill: share of its own bounding box; aspect: width / height */
export function silhouetteFacts(data, w, h) {
  let n = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (luma(data, (y * w + x) * 4) >= 128) continue;
    n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (!n) return { fill: 0, boxFill: 0, aspect: 0 };
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  return { fill: r2(n / (w * h)), boxFill: r2(n / (bw * bh)), aspect: r2(bw / bh) };
}

/** Luminance (0..1) percentiles p5 / p50 / p95 over the asset's pixels only (mask: a silhouette picture of the same framing; null = all pixels) */
export function valueFacts(data, mask) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (mask && luma(mask, i) >= 128) continue;
    hist[Math.min(255, Math.round(luma(data, i)))]++; n++;
  }
  const at = q => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= q * n) return r2(v / 255); } return 1; };
  return n ? { p5: at(0.05), p50: at(0.5), p95: at(0.95) } : { p5: 0, p50: 0, p95: 0 };
}

/** The renderer's canvas as top-down RGBA bytes (a 2D canvas copy: gl.readPixels would be bottom-up, and a WebGPU canvas has no readPixels) */
function readCanvas(canvas, size) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(canvas, 0, 0, size, size);
  return { c, g, img: g.getImageData(0, 0, size, size) };
}

/** Black on white in the midday rig's framing, ground hidden: the asset's materials swapped for unlit black ones (cut-outs kept), then restored */
function drawSilhouette(R, st, cam, rig, yaw) {
  frame(rig, st, cam, yaw);
  const { scene } = rig, bg = scene.background;
  scene.background = new THREE.Color(0xffffff); scene.userData.ground.visible = false;
  const undo = swapMaterials(st.pivot, m => new THREE.MeshBasicMaterial({ color: 0x000000, side: m.side, alphaTest: m.alphaTest ?? 0,
    map: m.alphaTest > 0 ? m.map ?? null : null, alphaMap: m.alphaMap ?? null }));
  try { R.render(scene, cam); } finally { undo(); scene.background = bg; scene.userData.ground.visible = true; }
}

/**
 * Still pictures for review: one PNG (data URL) per asset per light setup, the asset turned to a three-quarter view. Each mode in `modes`
 * adds one more picture per asset (`light` = the mode name) with its `facts`; silhouette and the channels are for models and materials
 * (a texture's is its square). lights picks the setups (LIGHT_NAMES, default the three neutral ones); exposure / tone (a TONES name: agx, aces…) replace the
 * game's for these pictures; material shows one of the game's materials on a sphere (by name), alone unless `only` names assets too.
 * A setup that could not copy something says so once, in `note` on its first picture. The extra modes use the first setup's framing;
 * value is that setup's picture in gray.
 * @param {any} engine
 * @param {{ size?: number, yaw?: number, only?: string[] | null, modes?: string[], lights?: string[] | null, exposure?: number | null, tone?: number | null, material?: string | null }} [o]
 * @returns {Promise<{ name: string, type: string, light: string, png?: string, error?: string, facts?: Record<string, number>, note?: string }[]>}
 */
export async function shots(engine, { size = 256, yaw = -0.6, only = null, modes = [], lights = null, exposure = null, tone = null, material = null } = {}) {
  ({ THREE } = await import('threedog'));
  const { models, textures } = assetNames(engine), canvas = document.createElement('canvas'), staged = [];
  if (material) staged.push(materialStage(engine, material));
  if (!material || only) for (const [type, names] of [['model', models], ['texture', textures]]) for (const name of names)
    if (!only || only.includes(name)) staged.push(await stageOf(engine, type, name));
  const chans = modes.filter(m => CHANNELS.includes(m)), kit = chans.length ? await loadNodeKit() : null, cache = new WeakMap();
  const R = await rendererLike(engine, canvas, staged, { node: !!kit, exposure, tone }); R.setPixelRatio(1); R.setSize(size, size, false);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.05, 2000), all = await rigs(engine, R, lights ?? DEFAULT_LIGHTS), out = [];
  const lead = all[0], noted = new Set();
  for (const st of staged) {
    const { name, type } = st;
    for (const rig of all) {
      if (st.error) { out.push({ name, type, light: rig.name, error: st.error }); continue; }
      frame(rig, st, cam, yaw); R.render(rig.scene, cam);
      const note = rig.notes.length && !noted.has(rig.name) ? (noted.add(rig.name), rig.notes.join('; ')) : null;
      out.push({ name, type, light: rig.name, png: canvas.toDataURL('image/png'), ...(note ? { note } : {}) });
    }
    if (st.error || !modes.length) continue;
    drawSilhouette(R, st, cam, lead, yaw);   // also the mask the value facts are measured inside
    const sil = readCanvas(canvas, size);
    if (modes.includes('silhouette') && type !== 'texture') {
      out.push({ name, type, light: 'silhouette', png: sil.c.toDataURL('image/png'), facts: silhouetteFacts(sil.img.data, size, size) });
    }
    if (modes.includes('value')) {
      frame(lead, st, cam, yaw); R.render(lead.scene, cam);
      const v = readCanvas(canvas, size), d = v.img.data, facts = valueFacts(d, sil.img.data);
      for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = Math.round(luma(d, i));
      v.g.putImageData(v.img, 0, 0);
      out.push({ name, type, light: 'value', png: v.c.toDataURL('image/png'), facts });
    }
    if (type !== 'texture') for (const ch of chans) {
      drawChannel(R, kit, st, cam, lead, yaw, ch, cache);
      const c = readCanvas(canvas, size);
      // the gray channels show their value as itself, so the percentiles inside the outline are the material's numbers (a flat value: p5 = p95)
      out.push({ name, type, light: ch, png: c.c.toDataURL('image/png'), ...(ch === 'albedo' || ch === 'normal' ? {} : { facts: valueFacts(c.img.data, sil.img.data) }) });
    }
  }
  for (const rig of all) for (const f of rig.dispose) f();
  R.dispose();
  return out;
}

/**
 * Open the gallery over a running engine: a scrolling grid, a row per asset, a turntable cell per light setup (every one in LIGHT_NAMES).
 * The header switches what every cell shows (the final picture or one channel), the tone mapping and the exposure, on the gallery's
 * renderer only; set() does the same for a script. Close returns to the game.
 * @param {any} engine @returns {Promise<{ close(): void, set(o: { channel?: string, exposure?: number, tone?: string }): void }>}
 */
export async function openGallery(engine) {
  ({ THREE } = await import('threedog'));
  const { models, textures } = assetNames(engine);
  const hold = engine.haltLoop('gallery');   // the game stands still behind the overlay (its own halt owner: nothing of the game's is touched)
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:2000;overflow:auto;background:#2a2c30;color:#eee;font:12px/1.4 sans-serif';
  const canvas = document.createElement('canvas');   // the renderer's own, off the page: each cell gets a copy of its picture
  const head = document.createElement('div');
  head.style.cssText = 'position:sticky;top:0;padding:8px 12px;background:#1d1f22;z-index:2002;display:flex;gap:12px;align-items:center;flex-wrap:wrap';
  head.innerHTML = `<b>Asset gallery</b><span>${models.length} models · ${textures.length} textures · lights: ${LIGHT_NAMES.join(' / ')}</span>`;
  const pick = (label, options) => {
    const l = document.createElement('label'), s = document.createElement('select');
    s.innerHTML = options.map(o => `<option>${escapeHtml(o)}</option>`).join('');
    l.append(label + ' ', s); head.appendChild(l); return s;
  };
  const channel = pick('show', ['final', ...CHANNELS]), toneSel = pick('tone', ['game', ...Object.keys(TONES)]);
  const expLabel = document.createElement('label'), exp = Object.assign(document.createElement('input'), { type: 'number', step: '0.1', min: '0.05' });
  expLabel.append('exposure ', exp); head.appendChild(expLabel);
  const close = Object.assign(document.createElement('button'), { textContent: 'close' });
  head.appendChild(close); host.appendChild(head);
  const grid = document.createElement('div');
  grid.style.cssText = `display:grid;grid-template-columns:160px repeat(${LIGHT_NAMES.length}, minmax(160px, 1fr));gap:6px;padding:8px 12px`;
  host.appendChild(grid); document.body.append(host);
  const staged = [];
  for (const [type, names] of [['model', models], ['texture', textures]]) for (const name of names) staged.push(await stageOf(engine, type, name));
  // the game's own renderer kind, as before the look-dev switches: a WebGL game's onBeforeCompile / ShaderMaterial materials draw as in the game.
  // The channel views are node materials, so there they are off (one line says why); `threedog gallery --shots --mode <channel>` still makes them
  const cache = new WeakMap(), g = engine.renderer;
  const R = await rendererLike(engine, canvas, staged), cam = new THREE.PerspectiveCamera(30, 1, 0.05, 2000), all = await rigs(engine, R), cells = [];
  const kit = R.isWebGPURenderer ? await loadNodeKit() : null;
  if (!kit) { channel.disabled = true; channel.title = 'channels need the WebGPU renderer (this game draws with WebGL): use threedog gallery --shots --mode albedo,roughness'; }
  exp.value = String(R.toneMappingExposure);
  for (const st of staged) {
    const label = document.createElement('div'); label.style.cssText = 'align-self:center;word-break:break-all';
    label.textContent = `${st.name} (${st.type})`; grid.appendChild(label);
    if (st.error) label.textContent += ' — failed: ' + st.error;
    for (const rig of all) {
      const el = document.createElement('canvas'); el.style.cssText = 'width:100%;height:auto;aspect-ratio:1;background:#000;display:block';   // inline: a game's canvas { height } rule must not stretch it
      el.title = `${st.name} · ${rig.name}${rig.notes.length ? ' · ' + rig.notes.join('; ') : ''}`; grid.appendChild(el);
      if (!st.error) cells.push({ el, st, rig });
    }
  }
  let raf = 0;
  const draw = t => {
    raf = requestAnimationFrame(draw);
    const ch = channel.value;
    for (const { el, st, rig } of cells) {
      const b = el.getBoundingClientRect();
      if (b.bottom < 0 || b.top > innerHeight || b.right < 0 || b.left > innerWidth) continue;
      const w = Math.max(1, Math.round(b.width)), h = Math.max(1, Math.round(b.height));
      if (canvas.width !== w || canvas.height !== h) R.setSize(w, h, false);
      if (el.width !== w || el.height !== h) { el.width = w; el.height = h; }
      cam.aspect = w / h; cam.updateProjectionMatrix();
      if (ch === 'final' || !kit || st.type === 'texture') { frame(rig, st, cam, t * 0.0005); R.render(rig.scene, cam); }
      else drawChannel(R, kit, st, cam, rig, t * 0.0005, ch, cache);
      el.getContext('2d').drawImage(canvas, 0, 0);   // in the same task as the render: a WebGPU canvas keeps no picture after it
    }
  };
  raf = requestAnimationFrame(draw);
  const api = {
    /** The header's switches: channel 'final' | a CHANNELS name, tone 'game' | a TONES name, exposure > 0 (an empty or bad one: the game's) */
    set({ channel: c, exposure, tone } = {}) {
      if (c !== undefined && kit) channel.value = c;
      if (tone !== undefined) toneSel.value = tone;
      if (exposure !== undefined) exp.value = String(exposure);
      R.toneMapping = toneSel.value === 'game' ? g.toneMapping : TONES[toneSel.value];
      R.toneMappingExposure = +exp.value > 0 ? +exp.value : g.toneMappingExposure;
    },
    close() { cancelAnimationFrame(raf); for (const rig of all) for (const f of rig.dispose) f(); R.dispose(); host.remove(); hold.remove(); },
  };
  channel.onchange = toneSel.onchange = exp.oninput = () => api.set();
  close.onclick = () => api.close();
  return api;
}

/**
 * What the vite preset's ?gallery=1 runs: waits for window.engine and its first state, then exposes the gallery on window.threedogGallery
 * (`threedog gallery --shots` calls shots() through it) and opens the grid unless the page is headless.
 */
export async function openWhenReady() {
  while (!globalThis.engine?.stateApplied) await new Promise(r => setTimeout(r, 100));
  const engine = globalThis.engine;
  globalThis.threedogGallery = { shots: o => shots(engine, o), names: () => assetNames(engine), open: () => openGallery(engine) };
  if (!/[?&]threedog-headless\b/.test(location.search)) await openGallery(engine);
}
