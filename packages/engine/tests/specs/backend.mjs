// Renderer backend entry (docs/plans/2026-11-03-webgpu-phase2.md section 1, step 2). A guard: renderer: 'webgpu' and a game's own WebGPURenderer
// start through one path; without WebGPU each fallback does what createEngine({ fallback }) says and says so loudly, with the reason in
// describe().renderer; fallback 'webgl' refuses a NodeMaterial and the WebGPU route refuses a ShaderMaterial by name, never a blank picture;
// a ground + swaying trees scene draws on the WebGPU route through the engine's own patches; the default WebGL engine reports as before.
import { probeSource } from '@threedog/tools/picture-check';
const LOUD = '[threedog] WebGPU unavailable (';
export const specs = [
  {
    // Each engine made a throwaway device at start; a re-create loop paid for it every time (docs/testing/runs.md, 2026-11-07)
    name: '[guard] renderer backend: the startup probe makes one device per navigator.gpu, and a failing one still answers with its reason',
    url: '/tests/backend/index.html',
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.probeCases());
      check('two asks of one navigator.gpu: both yes, one device, the adapter asked twice', r.first === null && r.again === null && r.devices === 1 && r.adapters === 2, JSON.stringify(r));
      check('another navigator.gpu is asked again and its failure is named', /^requestDevice\(\) failed: test: no device/.test(r.failing), JSON.stringify(r));
      check('no adapter and no navigator.gpu are never answered from the kept yes', r.none === 'requestAdapter() returned no adapter' && r.missing === 'navigator.gpu is missing', JSON.stringify(r));
    },
  },
  {
    // It was only a console warning: check, build and assets --strict passed and the optimised model did not load
    name: '[guard] renderer backend: a KTX2 asset asked for before start() loads on WebGPU with no renderer.init() from the game',
    url: '/tests/backend/index.html',
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.ktxBeforeStart());
      check('the texture loads and start() goes on', r.compressed && !r.error && ['webgpu', 'webgl2'].includes(r.backend), JSON.stringify(r));
    },
  },
  {
    name: '[guard] renderer backend: webgpu entry, fallbacks webgl2 / webgl / error with the loud line and describe().renderer, WebGL-only materials named, WebGPU scene draws',
    url: '/tests/backend/index.html',
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.backendCases());
      console.log('  backend numbers:', JSON.stringify(r.scene), JSON.stringify(r.webglDefault.renderer));
      const d = r.webglDefault;
      check('default engine: WebGLRenderer, describe().renderer { requested webgl, backend webgl, reason null }',
        d.isWebGL && d.renderer.requested === 'webgl' && d.renderer.backend === 'webgl' && d.renderer.reason === null, JSON.stringify(d.renderer));
      check('default engine: describe().perf keys, tier and counts() keys as before the WebGPU entry',
        ['fps', 'cpuMs', 'cpu', 'apply', 'drawCalls', 'triangles', 'pixelRatio', 'budget'].every(k => d.perf.includes(k)) && ['low', 'high'].includes(d.tier)
          && d.counts.includes('geometries') && d.counts.includes('textures') && typeof d.stats.drawCalls === 'number' && typeof d.stats.programs === 'number', JSON.stringify(d));
      const w2 = r.webgl2;
      check("fallback 'webgl2' (default), navigator.gpu missing: same WebGPURenderer on its WebGL2 backend, reason in describe().renderer",
        w2.isGPU && w2.renderer.requested === 'webgpu' && w2.renderer.backend === 'webgl2' && w2.renderer.reason === 'navigator.gpu is missing', JSON.stringify(w2));
      check("describe().renderer says what each backend can run: WebGL2 backend TSL yes, GLSL no, compute by transform feedback; WebGLRenderer the reverse, no compute",
        w2.renderer.tsl === true && w2.renderer.glsl === false && w2.renderer.compute === 'transform-feedback'
          && d.renderer.tsl === false && d.renderer.glsl === true && d.renderer.compute === null, JSON.stringify([w2.renderer, d.renderer]));
      check('describeText() names the fallback and its reason, so a plain read of the game shows it',
        w2.text.includes('renderer webgl2 (asked webgpu: navigator.gpu is missing)'), w2.text.split('\n').find(l => /renderer/.test(l)));
      check("fallback 'webgl2': one loud line naming the reason and the backend", w2.warns.some(l => l.startsWith(`${LOUD}navigator.gpu is missing), running webgl2; createEngine({ renderer: 'webgpu', fallback:`)), JSON.stringify(w2.warns));
      const gl = r.webgl;
      check("fallback 'webgl', requestDevice failing: a WebGLRenderer on the same canvas, reason requestDevice() failed",
        gl.isWebGL && gl.sameCanvas && gl.renderer.backend === 'webgl' && /^requestDevice\(\) failed: test: no device/.test(gl.renderer.reason), JSON.stringify(gl));
      check("fallback 'webgl': the loud line says running webgl", gl.warns.some(l => l.startsWith(`${LOUD}requestDevice() failed: test: no device), running webgl;`)), JSON.stringify(gl.warns));
      check("fallback 'webgl' with a NodeMaterial in the scene: start() fails naming the material and fallback: 'webgl2'",
        /MeshLambertNodeMaterial/.test(r.webglNode.error) && r.webglNode.error.includes("fallback: 'webgl2'") && /\[renderer-backend\]/.test(r.webglNode.error), r.webglNode.error);
      check("fallback 'error': start() rejects with the reason", r.error.error.startsWith(`${LOUD}requestDevice() failed: test: no device) and createEngine({ fallback: 'error' })`), r.error.error);
      const o = r.own;
      check('own WebGPURenderer({ forceWebGL: true }): used as is, initialized by start(), not reported as a fallback (no loud line)',
        o.same && o.initialized && o.renderer.backend === 'webgl2' && /forceWebGL/.test(o.renderer.reason) && !o.warns.some(l => l.startsWith(LOUD)), JSON.stringify(o));
      check('a ShaderMaterial on the WebGPU route: start() names it, its object and the TSL fix',
        r.shaderMaterial.error.includes("ShaderMaterial 'myGlow' on Mesh 'glow' does not run on WebGPURenderer") && /NodeMaterial/.test(r.shaderMaterial.error), r.shaderMaterial.error);
      check("a game's onBeforeCompile on the WebGPU route: start() names the material, its object and the node fix",
        r.hook.game.includes("MeshStandardMaterial with onBeforeCompile 'myBend' on Mesh 'bent' does not run on WebGPURenderer") && /positionNode/.test(r.hook.game), r.hook.game);
      check("an engine-patched material (GLSL patch wrapper, no game hook) is not named; a game hook under the wrapper is",
        r.hook.engine === '' && r.hook.under.includes("onBeforeCompile 'patchedThenHook' on Mesh 'both'"), JSON.stringify(r.hook));
      check('a RawShaderMaterial added after start() (nested): the next frame reports it by name in the log and play goes on (no engine.error freeze), with no full scene walk',
        r.late.error.includes("RawShaderMaterial 'lateRaw' on Mesh 'late' does not run on WebGPURenderer") && r.late.error.includes('added after start()') && r.late.logged && !r.late.frozen && r.late.walks === 0,
        JSON.stringify(r.late));
      check("renderer: 'webgl' is the default WebGLRenderer the engine owns", r.webglName === true, JSON.stringify(r.webglName));
      check("renderer: 'vulkan' is an option error; fallback without WebGPU starts (a game may switch the renderer by a flag) and warns", /a name is 'webgl' \(the default\) or 'webgpu'/.test(r.badName) && r.fallbackOnWebGL === '', `${r.badName} | ${r.fallbackOnWebGL}`);
      const s = r.scene;
      check("renderer: 'webgpu' scene (ground + wind trees through the engine's tsl patches) draws, on webgpu or its webgl2 fallback",
        ['webgpu', 'webgl2'].includes(s.renderer.backend) && s.mean > 5, JSON.stringify(s));
      check('the wind patch works on the WebGPU route: uWind 0 -> 2 moves the trees (> 1% of pixels)', s.sway > 1, JSON.stringify(s));
    },
  },
  {
    name: "[guard] debug.view on WebGPU: every built-in mode draws its own picture without errors, sway kept, shaderCost ranks node programs, off restores exactly",
    url: '/tests/backend/index.html',
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.debugViewCases());
      console.log('  debug view numbers:', JSON.stringify(r));
      check('every built-in mode is listed', ['albedo', 'lighting', 'shadow', 'normals', 'overdraw', 'shaderCost'].every(m => r.modes.includes(m)), JSON.stringify(r.modes));
      for (const [m, v] of Object.entries(r.views)) {
        check(`${m} on ${r.backend}: draws its own picture (> 5% of pixels differ from the real picture, not blank), no console error`,
          v.mode === m && v.changed > 5 && v.mean > 5 && v.errors.length === 0, JSON.stringify(v));
      }
      const V = r.views;
      check('albedo keeps base colors (the red box stays red) and a swaying tree still sways (NodeMaterial stand-in carries positionNode)', V.albedo.red > 0.5 && V.albedo.sway > 1, JSON.stringify(V.albedo));
      check('lighting: plain white matte (no red left) and the override keeps the sway (three copies positionNode)', V.lighting.red === 0 && V.lighting.sway > 1, JSON.stringify(V.lighting));
      check('normals: the upward ground reads green (view-space normal as color)', V.normals.green > 20, JSON.stringify(V.normals));
      check('overdraw: additive layers give several brightness levels', V.overdraw.levels >= 3 && V.overdraw.override?.type === 'MeshBasicMaterial', JSON.stringify(V.overdraw));
      check('shaderCost ranks the generated node programs (more than one color, none gray = every program read)', V.shaderCost.colors.length > 1 && !V.shaderCost.colors.includes(0x808080), JSON.stringify(V.shaderCost.colors));
      check("off gives back the exact real picture, no override, every real material", r.restored.changed === 0 && r.restored.override === null && r.restored.materials, JSON.stringify(r.restored));
    },
  },
  {
    name: "[guard] debug.view('shadow') with scene.environment (WebGL and WebGPU): the shadow reads dark, 'off' gives back the exact picture",
    url: '/tests/backend/index.html',
    software: true,
    async run({ check, ev }) {
      for (const k of ['webgl', 'webgpu']) {
        const r = await ev(b => window.shadowViewEnvCases(b), k);
        console.log(`  shadow view env numbers (${k}):`, JSON.stringify(r));
        check(`${k} (${r.backend}): with an environment map the shadow is clearly dark in the view (${r.level} of lit over ${r.area}% of pixels)`,
          r.env && r.area > 2 && r.level !== null && r.level < 0.25, JSON.stringify(r));
        check(`${k}: the environment is off only inside the view's renders, so no ownership warning`, r.envInView && r.ownedWarns.length === 0, JSON.stringify(r));
        check(`${k}: 'off' gives back the real picture byte for byte, the same environment, no hooks or override left on the scene`,
          r.restored.bytes === 0 && r.restored.env && !r.restored.hooks && r.restored.override === null, JSON.stringify(r.restored));
      }
    },
  },
  {
    // the tools an AI reads the game through, on a page whose engine runs renderer: 'webgpu' (the parity page's WebGPU variant)
    name: "[guard] tools on WebGPU: describe() names the backend, inspect.perf does not report 0 programs, shot's picture probe sees light changes",
    url: '/tests/parity/index.html?backend=webgpu',
    software: true,
    async run({ check, ev }) {
      await ev(src => { window.__probePicture = (0, eval)('(' + src + ')'); }, probeSource);
      const r = await ev(async () => {
        const E = window.engine;
        E.camera.position.set(-6, 7, 9); E.camera.lookAt(0, 0.5, 0); E.camera.updateMatrixWorld();
        const d = E.describe(), p = E.inspect.perf(), probe = await window.__probePicture(E, { time: false });
        return { renderer: d.renderer, isGPU: !!E.renderer.isWebGPURenderer, perfKeys: Object.keys(d.perf), counts: E.counts(),
          perf: { programs: p.programs, budgets: p.budgets.map(b => b.name), drawCalls: p.drawCalls, text: p.text.split('\n')[0],
            costs: p.programCosts, costText: /costliest programs/.test(p.text) },
          shadows: probe.shadows, lights: probe.lights?.map(l => ({ name: l.name, changed: l.changed })) };
      });
      console.log('  webgpu tools numbers:', JSON.stringify(r).slice(0, 1200));
      check('describe().renderer: requested webgpu, backend webgpu or webgl2 (the reason when it fell back)',
        r.isGPU && r.renderer.requested === 'webgpu' && ['webgpu', 'webgl2'].includes(r.renderer.backend) && (r.renderer.backend === 'webgpu' || !!r.renderer.reason), JSON.stringify(r.renderer));
      check('describe().perf and counts() read through render/backend.js on WebGPU', ['fps', 'drawCalls', 'triangles'].every(k => r.perfKeys.includes(k)) && typeof r.counts.geometries === 'number', JSON.stringify([r.perfKeys, r.counts]));
      check('inspect.perf: draw calls counted, programs null and not budgeted (WebGPU keeps no list), said in the text',
        r.perf.drawCalls > 0 && r.perf.programs === null && !r.perf.budgets.includes('programs') && /programs not counted \(WebGPU\)/.test(r.perf.text), JSON.stringify(r.perf));
      check('inspect.perf on WebGPU lists the costliest programs from the generated node code, costliest first, and says so in the text',
        r.perf.costs.length > 0 && r.perf.costs.every((c, i, a) => c.fragmentLines > 0 && (i === 0 || a[i - 1].score >= c.score)) && r.perf.costText, JSON.stringify(r.perf.costs));
      check("shot's picture probe: turning shadows off changes pixels (WebGPU's per-frame light nodes follow each extra render)", r.shadows?.area > 0, JSON.stringify(r.shadows));
    },
  },
  {
    name: "[guard] shader errors on WebGPU: tsl patch errors name patch and slot with the game's line on top, node build errors name the patch or post effect, a Loop outside Fn warns, node compile and pipeline errors name material, mesh and patches",
    url: '/tests/backend/index.html',
    software: true,
    expectErrors: /'nope'|_broken|Invalid CommandBuffer/,   // the broken node below: on a real device the WGSL error, its pipeline and that frame's commands reach the device's error channel
    async run({ check, ev }) {
      const r = await ev(() => window.shaderErrorCases());
      const game = /test-backend|tests\/backend\/main\.js/;   // the page's own file: bundled by the test build, the source path under vite dev
      check("a tsl patch throwing in applyEffects: patch 'x' (slot y) first, the game's patch code on top of the stack (not the engine's wrapper)",
        r.sync?.message.startsWith("[threedog] patch 'oops' (slot position): ") && game.test(r.sync.top) && !/patchNodes|\/fx-/.test(r.sync.top), JSON.stringify(r.sync));
      check("a tsl hook throwing inside three's build: three's 'TSL:' log names the patch and slot and points at the game's line",
        r.build.includes("[threedog] patch 'late' (slot lighting)") && /"after\(\)" at "[^"]*(test-backend|tests\/backend\/main\.js)[^"]*:\d+"/.test(r.build), r.build.slice(0, 400));
      check("a patch's node that fails while three builds it (null input): three's 'TSL:' log names patch and slot, then the material and mesh",
        /THREE\.TSL: .*\[threedog\] patch 'wetPatch' \(slot color\): .*null/.test(r.nullPatch) && /node build failed for MeshLambertNodeMaterial 'nullInput' .*Mesh 'nullBox'.*patches on it: wetPatch/.test(r.nullPatch), r.nullPatch.slice(0, 600));
      check("a post effect's node that fails while three builds it: the log names the effect",
        /THREE\.TSL: .*\[threedog\] post effect 'nullFog': /.test(r.nullPost) && /node build failed for/.test(r.nullPost), r.nullPost.slice(0, 600));
      check('a TSL Loop outside an Fn in a post effect (three drops it silently): a dev warning names the effect and the fix',
        /\[threedog\] post effect 'loopFog': TSL statements outside an Fn \(LoopNode\).*Fn\(/.test(r.loop), r.loop.slice(0, 400));
      const who = t => t.includes("MeshLambertNodeMaterial 'broken'") && t.includes("Mesh 'brokenBox'") && t.includes('patches on it: wind');
      check(`a node program that does not compile (${r.backend}): material, mesh and its patches named, with the driver's error line`,
        who(r.compile) && (r.backend === 'webgpu' ? /WebGPU pipeline failed/.test(r.compile) : /node program .*WebGL2 backend/.test(r.compile) && /'nope' : undeclared identifier/.test(r.compile)), r.compile.slice(0, 500));
      check("a WebGPU pipeline failure (three's console report): three's line kept, then material, mesh and patches",
        r.pipeline.startsWith('THREE.WebGPURenderer: Render pipeline creation failed') && /\[threedog\] WebGPU pipeline failed for/.test(r.pipeline) && who(r.pipeline), r.pipeline.slice(0, 500));
      // why a guard: sunShafts failed in the driver's compiler, describe() kept saying it was on, and every frame was lost to the invalid pipeline
      const f = r.failed, mine = f.text.filter(t => t.startsWith('[threedog]'));
      check("[guard] a post effect whose own pass the device refused is held: said once with the effect's name and a code, off in describe() with the reason, out of the chain; the others stay",
        f.before.on && f.before.order.includes('brokenFx') && mine.length === 1 && f.made.length === 1 && f.depth === 0 && /The device said: FXC compile failed/.test(mine[0]) && /it draws post effect 'brokenFx', which is now held off .*\[post-effect-failed\]/.test(mine[0])
        && f.row.on === false && /device refused its shader/.test(f.row.held) && !f.order.includes('brokenFx') && f.order.includes('fineFx') && f.fine && f.gameOn, JSON.stringify(f).slice(0, 700));
      check('the held effect runs again once it is removed and added again; the scope on the device is listed in describe().threePatches', f.again === true && f.listed === true, JSON.stringify([f.again, f.listed]));
    },
  },
];
