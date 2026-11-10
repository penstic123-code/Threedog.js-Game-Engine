// [guard] Path-traced photos (modules/photo/pathTrace.js): the tracer is the game's optional package and the game writes its import, so a game that
// never installed it still builds. Without the import: one install line. With it: a picture that is not black, near the real-time brightness, and
// a line naming what the tracer did not draw as the game does. WebGL runs here on software; the WebGPU tracer needs a device, so that row opens
// the real GPU itself and says when it fell back.
import { readFileSync, readdirSync } from 'node:fs';
import { launchBrowser } from '@threedog/tools/browser';

const PAGE = '/tests/pathtrace/index.html';
const J = JSON.stringify;
// an import, not text that shows one: the install line quotes import('three-gpu-pathtracer/webgpu') inside a double-quoted or template string
const AT = /(?:\bfrom\s*|\bimport\s*\(\s*)/.source;
function imports(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), bare = code.replace(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
  return new RegExp(AT + '"three-gpu-pathtracer').test(code) || new RegExp(AT + "'three-gpu-pathtracer").test(bare);
}
/** Engine source files that import the optional package by name: each one breaks the build of every game without it */
function namedImports() {
  const out = [], walk = d => { for (const f of readdirSync(new URL(`../../${d}`, import.meta.url), { withFileTypes: true })) {
    const p = `${d}/${f.name}`;
    if (f.isDirectory()) walk(p);
    else if (f.name.endsWith('.js') && imports(readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'))) out.push(p);
  } };
  for (const d of ['core', 'modules', 'render', 'ui']) walk(d);
  return out;
}
/** A traced photo against a real-time one on the same page: brightness within a factor of 2.5 (the tracer bounces light and drops the ambient term) */
function judge(check, label, real, t) {
  check(`${label}: the traced photo is not black (lit share ${t.lit?.toFixed(2)})`, t.lit > 0.3, J(t));
  const ratio = t.mean / Math.max(real.mean, 1e-3);
  check(`${label}: mean brightness near the real-time photo (traced ${t.mean?.toFixed(3)}, real ${real.mean?.toFixed(3)}, ratio ${ratio.toFixed(2)})`, ratio > 0.4 && ratio < 2.5, J({ real, t }));
  check(`${label}: samples reached and the picture at the canvas size`, t.samples >= 4 && J(t.size) === J([160, 120]), J(t));
  const own = label === 'WebGL' ? /patchedBall \(onBeforeCompile\)/ : /tslBall \(colorNode\)/;   // each renderer's way to change a material's look
  check(`${label}: the untraced line names the Lambert box, the AmbientLight and the ${label === 'WebGL' ? 'onBeforeCompile' : 'TSL colorNode'} material`, /lambertBox/.test(t.untraced) && /AmbientLight/.test(t.untraced) && own.test(t.untraced), t.untraced);
  check(`${label}: the line always says a traced picture has no post effects (a --ref comparison would read missing bloom as light)`, /no post effects/.test(t.untraced), t.untraced);
  check(`${label}: the game's geometry is as it was (no boundsTree left, the unindexed box without an index)`, t.geometryLeft === 0, J(t));
  check(`${label}: every indexed geometry's index is byte-identical after the trace (the BVH reorders it in place; drawRange subsets and faceIndex depend on it)`, t.indexSame === true, J(t));
}

export const specs = [
  {
    name: "[guard] photo pathTrace: the engine never imports the tracer by name; without the game's import, one install line and a refused op; take() stays synchronous",
    url: PAGE + '?nolib',
    software: true,
    async run({ check, ev }) {
      const named = namedImports();
      check("no engine file imports three-gpu-pathtracer (a game that never installed it would fail to build): the game passes photo({ pathTracer })", !named.length, J(named));
      const r = await ev(async () => ({ msg: await window.pathTraceTest.error(), bad: [await window.pathTraceTest.error({ samples: 0 }), await window.pathTraceTest.error({ seconds: -1 })],
        op: engine.ops.run('photo.trace'), take: typeof engine.photo.take({ scale: 1 }).url, album: engine.photo.album.length, tracing: engine.photo.tracing, ratio: engine.renderer.getPixelRatio() }));
      check('photo.trace() without photo({ pathTracer }) rejects with the install line', r.msg.includes('npm i -D three-gpu-pathtracer three-mesh-bvh') && r.msg.includes("import('three-gpu-pathtracer/webgpu')"), r.msg);
      check("the op photo.trace is refused with 'noTracer' (never logged as a success)", r.op.ok === false && r.op.code === 'noTracer', J(r.op));
      check('samples 0 and seconds -1 are rejected by the option check', r.bad.every(m => /samples|seconds/.test(m) && !/npm i/.test(m)), J(r.bad));
      check('take() still returns the shot itself; nothing else stays behind (one album entry, not tracing, the ratio as it was)', r.take === 'string' && r.album === 1 && r.tracing === null && r.ratio === 1, J(r));
    },
  },
  {
    name: 'photo pathTrace on WebGL: not black, near the real-time brightness, names what it could not trace, puts the ratio back',
    url: PAGE,
    serial: true,
    software: true,
    async run({ check, ev }) {
      const real = await ev(() => window.pathTraceTest.real());
      const busy = await ev(async () => {
        window.__pt = window.pathTraceTest.traced(4); const r = engine.ops.run('photo.trace');
        await new Promise(requestAnimationFrame); engine.photo.take({ scale: 2 });   // a real-time photo mid-trace resizes the canvas: the trace must not restart
        return { code: r.code, tracing: engine.describe().modules?.photo?.tracing ?? engine.photo.tracing };
      });
      check("a second trace while one accumulates is refused with 'tracing', and progress is visible", busy.code === 'tracing' && busy.tracing?.of === 4, J(busy));
      const t = await ev(() => window.__pt);
      judge(check, 'WebGL', real, t);
      const after = await ev(() => ({ ratio: engine.renderer.getPixelRatio(), tracing: engine.photo.tracing, album: engine.photo.album.length }));
      check('after: ratio 1 again, not tracing, all three photos in the album', after.ratio === 1 && after.tracing === null && after.album === 3, J(after));
      const gone = await ev(async () => { const p = window.pathTraceTest.error({ samples: 64 }); await new Promise(requestAnimationFrame); engine.dispose(); return p; });
      check('disposing the engine mid-trace stops it with a named rejection', /stopped/.test(gone), gone);
    },
  },
  {
    name: '[guard] photo pathTrace on WebGPU: the WebGL2 fallback is refused by name; on a real device the traced photo matches',
    notRealWebGPU: 'launches the real GPU itself, in every full run',
    url: PAGE + '?route=webgpu',
    serial: true,
    async run({ check, ev, page }) {
      const r = await ev(async () => ({ backend: window.pathTraceTest.backend(), msg: await window.pathTraceTest.error() }));
      if (r.backend.backend === 'webgl2') check('on the WebGL2 fallback the photo says so by name', /WebGL2 fallback/.test(r.msg), J(r));
      const b = await launchBrowser({ prefer: 'gpu' });
      try {
        const p = await b.newPage({ viewport: { width: 320, height: 240 } });
        await p.goto(new URL(page.url()).origin + PAGE + '?route=webgpu');
        await p.waitForFunction(() => window.pathTraceTest, null, { timeout: 60000 });
        const backend = await p.evaluate(() => window.pathTraceTest.backend().backend);
        if (backend !== 'webgpu') { console.log(`  NOT real WebGPU (${backend}, ${b.render?.kind}): the WebGPU tracer row says nothing here`); return; }
        const real = await p.evaluate(() => window.pathTraceTest.real()), t = await p.evaluate(() => window.pathTraceTest.traced(16, window.pathTraceTest.gameBounds));
        console.log(`  real WebGPU: ${t.samples} samples in ${t.ms} ms at ${t.size}`);
        judge(check, 'WebGPU', real, t);
        check('WebGPU: a boundsTree the game set during the trace is kept (only objects the tracer made are removed)', await p.evaluate(() => window.pathTraceTest.floorBounds()), 'floor boundsTree gone');
      } finally { await b.close(); }
    },
  },
];
