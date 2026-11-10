// [guard] The engine's own content on the WebGPU route (docs/plans/done/2026-11-03-review-0.4.md section 2.D). Terrain, vegetation, water, sky,
// particles and bloom all on, drawn by a WebGL engine and a renderer: 'webgpu' engine (headless: WebGPURenderer's WebGL2 backend), compared
// per pixel; each patch effect must also move on WebGPU (wind sways, the season tint recolors). Plus fallback: 'webgl' with post, sky (hook, fog, cascades), particles, weather.
// Why a guard: the engine's materials once drew on WebGPU without any of their patches and nothing said so.
export const specs = [
  {
    // 不许绕开: every engine copy of a material goes through cloneMaterial (render/patches.js); a bare clone() + copyPatches dropped the game's own lighting
    name: "[guard] vegetation model copy keeps the game's material: own setupLightingModel, colorNode, own fields, onBeforeCompile; onModel runs on a named model",
    url: '/tests/engine-webgpu/index.html',
    async run({ check, ev }) {
      const r = await ev(() => window.vegetationGameMaterial());
      check('vegetation draws its own copies (wind is per species)', r.copied, JSON.stringify(r));
      check("the copy keeps the game's colorNode", r.colorNode, JSON.stringify(r));
      check("the copy lights with the game's own setupLightingModel, not three's toon light", r.lighting, JSON.stringify(r));
      check('a field the class never declares (look) is carried', r.look, JSON.stringify(r));
      check('the engine adds only its effects on top (wind among them)', r.patches.includes('wind'), r.patches);
      check("a classic material's own onBeforeCompile still runs under the engine patches", r.hook, JSON.stringify(r));
      check('a copy of a copy carries the game part once (no wrapper nests, patches once)', r.twice, JSON.stringify(r));
      check("a model named in define went through the game's onModel before it was copied", r.named, JSON.stringify(r));
      check('an attribute on only some meshes is dropped with a vegetation-ignored notice in describe().warnings (none for the matching models)', r.notice, JSON.stringify(r));
      const { readFileSync, readdirSync } = await import('node:fs');
      const files = [];
      const walk = d => { for (const f of readdirSync(new URL(`../../${d}`, import.meta.url), { withFileTypes: true })) f.isDirectory() ? walk(`${d}/${f.name}`) : f.name.endsWith('.js') && files.push(`${d}/${f.name}`); };
      walk('modules'); walk('core'); walk('render');
      // any second route counts, not only copyPatches(x, x.clone()): a copyPatches call outside patches.js, or a bare material.clone() (comments stripped)
      const code = f => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      const bare = files.filter(f => f !== 'render/patches.js' && /\bcopyPatches\b|\bmaterial\.clone\(\)/.test(code(f)));
      check('no engine file copies a material past cloneMaterial (copyPatches outside render/patches.js, material.clone()): cloneMaterial carries what three drops', !bare.length, JSON.stringify(bare));
    },
  },
  {
    name: '[guard] engine content on WebGPU looks like WebGL: terrain / vegetation / water / sky / particles / post, effects move; fallback webgl rebuilds post, sky, fog, cascades, particles, weather',
    url: '/tests/engine-webgpu/index.html',
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.engineWebGPU());
      console.log('  engine webgpu numbers:', JSON.stringify(r));
      check('the WebGPU engine runs WebGPURenderer (webgpu or its webgl2 backend)', ['webgpu', 'webgl2'].includes(r.backend), r.backend);
      check('engine materials with patches are in the scene (terrain, vegetation, water)', r.materials.length >= 3 && r.materials.some(m => m.patches.includes('wind')), JSON.stringify(r.materials));
      check('the swaying material carries its tsl position chain on WebGPU (positionNode for the shadow pass)', r.materials.filter(m => m.patches.includes('wind')).every(m => m.position), JSON.stringify(r.materials));
      check('near-only plants draw on WebGPU with their distance fade (the nearFade patch has a tsl form: once GLSL only, it froze the world example on WebGPU)',
        r.materials.some(m => m.patches.includes('nearFade') && m.position) && !r.errors.length, JSON.stringify(r.materials));
      // tight on purpose: the WebGPU route was once 4% darker overall (Lambert / Phong node twins lost scene.environment's fill) while
      // under 4% of pixels differed by more than 24 levels, so a loose per-pixel bound alone let a whole-picture shift through
      check('WebGPU and WebGL pictures agree: mean brightness within 1.5 levels, under 1.5% of pixels differ by more than 24 levels, under 4% by more than 8',
        Math.abs(r.mean.gl - r.mean.gpu) < 1.5 && r.differ < 1.5 && r.differFine < 4, JSON.stringify({ differ: r.differ, differFine: r.differFine, mean: r.mean }));
      check('wind sways the trees on WebGPU about as much as on WebGL (both > 0.3% of pixels)', r.sway > 0.3 && r.swayGL > 0.3, JSON.stringify({ gpu: r.sway, gl: r.swayGL }));
      check('the season tint recolors terrain and trees on WebGPU (> 5% of pixels)', r.tint > 5, String(r.tint));
      const ts = await ev(() => window.textureShading());
      console.log('  texture shading numbers:', JSON.stringify(ts));
      check("terrain shading: 'texture': the color map patch draws on WebGPU like WebGL (same bounds as the whole picture)",
        ts.patched && !ts.errors.length && Math.abs(ts.mean.gl - ts.mean.gpu) < 1.5 && ts.differ < 1.5 && ts.differFine < 4, JSON.stringify(ts));
      const pm = await ev(() => window.patchMeanings());
      console.log('  patch meanings numbers:', JSON.stringify(pm));
      check('patch meanings match: a position offset on turned instances and a lighting direct() hook after another patch draw the same on both routes',
        pm.differ < 0.5 && pm.differFine < 1.5, JSON.stringify(pm));
      const f = await ev(() => window.fallbackWebGL());
      console.log('  fallback webgl numbers:', JSON.stringify(f));
      check("fallback 'webgl' with bloom and sky: start() succeeds on WebGLRenderer, the dome rebuilt as a WebGL material, the picture is drawn",
        !f.error && f.isWebGL && f.backend === 'webgl' && !f.domeNode && f.mean > 5, JSON.stringify(f));
      check("fallback 'webgl': a engine.sky.clouds() made before start() is on the rebuilt dome; no node material left in the scene",
        !f.error && f.cloudHook && f.nodeMats.length === 0, JSON.stringify(f));
      check("fallback 'webgl': particles and rain / snow rebuilt as WebGL points / lines, rain drawn; exp fog moved from the scene fog node to the patch; cascades are lights",
        !f.error && f.particles === 'Points ShaderMaterial' && f.rain === 'ShaderMaterial' && f.snow === 'ShaderMaterial' && f.rainShown && f.csm === 'lights', JSON.stringify(f));
      const tb = await ev(() => window.textureBeforeStart());
      console.log('  texture before start numbers:', JSON.stringify(tb));
      check('assets.texture() before start() on the WebGPU route loads, and the texture draws (it once threw "initTexture() called before the backend is initialized")', !tb.error && tb.red > 0.9, JSON.stringify(tb));
      const ps = await ev(() => window.programSharing());
      console.log('  program sharing numbers:', JSON.stringify(ps));
      check(`${ps.materials} materials of one setup (lighting + detail) share their patch objects on WebGPU: one node key, at most 2 node builds (was one per material)`,
        ps.nodeKeys === 1 && ps.builds <= 2 && ps.colors === ps.materials, JSON.stringify(ps));
      const cs = await ev(() => window.colorSpots());
      console.log('  color spots numbers:', JSON.stringify(cs));
      // same bound as the whole picture above: this one once differed on ~6% of pixels
      check('an sRGB texture as scene.background (no tone mapping): WebGPU and WebGL agree (mean within 1.5 levels, under 1.5% of pixels differ by more than 24 levels, under 4% by more than 8)',
        Math.abs(cs.backgroundFlat.mean.gl - cs.backgroundFlat.mean.gpu) < 1.5 && cs.backgroundFlat.differ < 1.5 && cs.backgroundFlat.differFine < 4, JSON.stringify(cs.backgroundFlat));
      // Half-transparent meshes in fog, like for like: both blend in linear and tone-map once, so nothing may differ (measured 0 at every lighting tried)
      const fl = cs.fogLinear;
      check('half-transparent meshes in fog: WebGPU equals WebGL through a composer (mean within 0.1 levels, under 0.5% of pixels differ by more than 2 levels)',
        fl.composer && Math.abs(fl.mean.gl - fl.mean.gpu) < 0.1 && fl.differ < 0.5, JSON.stringify(fl));
      // WebGL straight to the canvas blends in display values, a three.js property (recipe 56): the size depends on the scene's light, so this bound only
      // says the difference stays that one and shows no bigger fault; the 8-level share was 4% while the scene was tuned to fit it
      check('half-transparent meshes in fog: WebGL straight to the canvas stays near (mean within 1.5 levels, under 1.5% of pixels differ by more than 24 levels, under 10% by more than 8)',
        Math.abs(cs.fog.mean.gl - cs.fog.mean.gpu) < 1.5 && cs.fog.differ < 1.5 && cs.fog.differFine < 10, JSON.stringify(cs.fog));
      // once a known difference (WebGL's straight path left the sRGB background out of tone mapping, three's WebGLBackground rule): the
      // engine tone-maps it there too (render/postWebGL.js toneBackground), so a skybox photo no longer changes with MSAA, effects or renderer
      check('an sRGB texture as scene.background with tone mapping: WebGPU and WebGL straight-to-canvas agree (same bounds)',
        Math.abs(cs.background.mean.gl - cs.background.mean.gpu) < 1.5 && cs.background.differ < 1.5 && cs.background.differFine < 4, JSON.stringify(cs.background));
      const bc = cs.backgroundComposer;
      check('the same sRGB background on WebGL: straight to the canvas = through the composer (under 1% of pixels differ by more than 8); back to straight is the first picture',
        !bc.direct && bc.composer && bc.differFine < 1 && bc.back < 0.5, JSON.stringify(bc));
    },
  },
];
