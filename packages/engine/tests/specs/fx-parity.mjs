// threedog/tsl parity (docs/plans/2026-11-03-webgpu-phase2.md §7 steps 3 and 5): each TSL Fn draws what its GLSL function draws.
// A guard: the TSL signatures match the GLSL ones exactly, so a change of algorithm, space or unit on either side pushes the difference past 0.5%;
// plus a static check that threedog/tsl imports only three/tsl / three/webgpu and WebGL-free engine files, and the main entry never imports it
// (WebGL games' bundles must not grow because of the WebGPU path).
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// engine files threedog/tsl may import: plain data / plain functions with no three.js WebGL parts
const SAFE = new Set(['core/base/spelling.js', 'core/base/errorHints.js', 'core/base/errorCodes.js', 'render/engineUniforms.js', 'render/backend.js', 'render/vertexInputs.js', 'render/slots.js', 'render/fxNumbers.js', 'core/scene/threePatches.js', 'core/base/validate.js', 'core/base/util.js', 'render/layers.js',
  'render/lit.js', 'core/base/docRef.js', 'render/postRuns.js', 'core/base/params.js']);   // lit.js and docRef.js import nothing; postRuns.js only backend.js;
// params.js only validate.js / errorHints.js / util.js (lightShaft checks its options with the same readParams schema the catalog shows)
const THREE_OK = new Set(['three/tsl', 'three/webgpu']);
// three's TSL display nodes (bloom, ao for the WebGPU post chain): they import only three/tsl and three/webgpu themselves
// plus CSMShadowNode (render/cascades.tsl.js): three/webgpu, three/tsl and CSMFrustum, which takes only Vector3 / Matrix4 from 'three'
// and LightProbeGrid (render/fx/index.js): three/webgpu, three/tsl and LightProbeGridUtils, which takes only Box3, DirectionalLight, Sphere, Vector3 from 'three'
const THREE_TSL_ADDON = /^three\/addons\/(tsl\/display\/[\w]+|csm\/CSMShadowNode|lighting\/LightProbeGrid)\.js$/;

/** Every import reachable from render/fx/index.js, and the ones it must not have */
function tslImports() {
  const seen = new Set(), bad = [], todo = ['render/fx/index.js'];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(join(ENGINE, f), 'utf8');
    for (const [, spec] of src.matchAll(/^\s*(?:import|export)\s(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/gm)) {   // bare `import './x'` too
      if (!spec.startsWith('.')) { if (!THREE_OK.has(spec) && !THREE_TSL_ADDON.test(spec)) bad.push(`${f} -> ${spec}`); continue; }
      const to = relative(ENGINE, resolve(ENGINE, dirname(f), spec)).replace(/\\/g, '/');
      if (to.endsWith('.tsl.js') || to === 'render/fx/index.js' || SAFE.has(to)) todo.push(to);
      else bad.push(`${f} -> ${to}`);
    }
  }
  return { files: [...seen], bad };
}
/** Does index.js reach render/fx/index.js or any .tsl.js file through its static imports (it must not) */
function mainReachesTsl() {
  const seen = new Set(), todo = ['index.js'];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    let src; try { src = readFileSync(join(ENGINE, f), 'utf8'); } catch { continue; }
    for (const [, spec] of src.matchAll(/^\s*(?:import|export)\s(?:[^'"]*?from\s+)?['"](\.[^'"]+)['"]/gm)) {
      const to = relative(ENGINE, resolve(ENGINE, dirname(f), spec)).replace(/\\/g, '/');
      if (to.endsWith('.tsl.js') || to === 'render/fx/index.js') return `${f} -> ${to}`;
      todo.push(to);
    }
  }
  return null;
}

export const specs = [
  {
    name: '[guard] threedog/tsl imports only three/tsl, three/webgpu and WebGL-free engine files; index.js never reaches it',
    notRealWebGPU: 'reads source files, draws nothing',
    url: '/tests/fx/index.html',
    async run({ check }) {
      const { files, bad } = tslImports();
      check('threedog/tsl reaches no WebGL-only file', bad.length === 0 && files.length >= 7, bad.join('; ') || files.join(', '));
      const hit = mainReachesTsl();
      check('the main entry (index.js) does not import threedog/tsl', hit === null, hit || '');
      const pkg = JSON.parse(readFileSync(join(ENGINE, 'package.json'), 'utf8'));
      check('package.json exports ./tsl -> render/fx/index.js with types', pkg.exports['./tsl']?.default === './render/fx/index.js' && !!pkg.exports['./tsl']?.types,
        JSON.stringify(pkg.exports['./tsl']));
    },
  },
  {
    // Why: a sin hash or a private hash draws a different random pattern on WebGL and WebGPU (sin of large arguments differs by GPU and by
    // GLSL vs WGSL); the one hash is threedogHash (GLSL) = hash (TSL), integer pcg2d, render/fxNumbers.js HASH
    name: '[guard] one shader hash: no sin hash, no private GLSL / TSL hash or alias, no TSL sin-hash chain, no three/tsl hash() in engine or post-effects code',
    notRealWebGPU: 'reads source files, draws nothing',
    url: '/tests/fx/index.html',
    async run({ check }) {
      const roots = ['render', 'modules', 'core'].map(d => join(ENGINE, d)).concat(join(ENGINE, '../post-effects')), bad = [];
      // allowed: threedogHash itself and an alias #define that names it (fuse.js keeps the 1.0 post name fxHash that way)
      const BAD = [/fract\s*\(\s*sin\s*\(/, /\bfloat\s+(?!threedogHash\b)\w*[hH]ash\w*\s*\(\s*vec/, /\b(?:T|tsl|TSL)\.hash\s*\(/,
        /#define\s+\w*[hH]ash\w*\s+(?!threedogHash\b)/,
        // the TSL chain form of a sin hash (sin(...).mul(k).fract(), .sin()...fract()) and its classic constant, anywhere
        /\bsin\s*\([^;]{0,200}\)\s*\.mul\s*\([^;]{0,80}\)\s*\.fract\s*\(/, /\.sin\s*\(\s*\)[^;]{0,120}\.fract\s*\(/, /43758/];
      // a private hash-like TSL helper (name*hash* = Fn(...)): the one lives in render/fx/noise.tsl.js
      const TSL_HASH = /\b\w*[hH]ash\w*\s*=\s*Fn\s*\(/, TSL_HOME = 'render/fx/noise.tsl.js';
      const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) { if (!/^(node_modules|\.threedog|tests)$/.test(e.name)) walk(p); continue; }
        if (!/\.m?js$/.test(e.name)) continue;
        const src = readFileSync(p, 'utf8');
        const rel = relative(ENGINE, p).replace(/\\/g, '/');
        for (const re of rel === TSL_HOME ? BAD : [...BAD, TSL_HASH]) if (re.test(src)) bad.push(`${rel}: ${src.match(re)[0]}`);
      } };
      roots.forEach(walk);
      check('every shader random number goes through threedogHash / fx.hash', bad.length === 0, bad.join('; '));
    },
  },
  {
    name: '[guard] threedog/tsl parity: wind / cloudShadow / season (+ objectOrigin), hash / noise, detail, lighting, water in TSL draw the GLSL picture; engine.uniforms drives both',
    software: true,   // pixel parity, read inside the page
    url: '/tests/fx/index.html',
    expectErrors: /tsl-misuse|node build failed/,   // the unbound-renderer case below prints it on purpose (three logs node build errors, the engine names the material after)
    async run({ check, ev }) {
      const r = await ev(() => window.fxParity());
      console.log('  fx parity numbers:', JSON.stringify(r));
      for (const [n, c] of Object.entries(r.cases)) {
        check(`${n}: GLSL vs TSL differ on < 0.5% of pixels`, c.parity < 0.5 && c.lit > 0.05, JSON.stringify(c));
        check(`${n}: the effect itself changes the picture (on vs off > 1%), so the parity is not two no-ops`, c.effect > 1, JSON.stringify(c));
      }
      // detailBump by normal direction: screen-space derivatives differ by backend (WGSL leaves dpdx coarse or fine to the device), so the limit
      // is on the angle, not on a lit pixel. Real WebGPU (AMD RDNA3, 2026-11-09): median 0.9 degrees, 1.4% of pixels over 10 (edges of quads
      // and silhouettes); a sign, space or unit error turns most pixels over 10 (the bump alone: about 50%)
      check('detailBump: GLSL vs TSL normals: median < 3 degrees, < 3% of pixels over 10 degrees', r.bump.p50 < 3 && r.bump.over < 3 && r.bump.px > 2000, JSON.stringify(r.bump));
      check('detailBump: the bump itself turns the normal (> 10 degrees on > 10% of pixels)', r.bump.effect > 10, JSON.stringify(r.bump));
      check('threedogHash / hash take any vec2 (1.0 contract): fractional inputs inside one integer cell give different values (a per-cell hash: > 90% equal neighbors)', r.stats.hashFract.same < 50, JSON.stringify(r.stats.hashFract));
      for (const [k, c] of Object.entries(r.structure)) check(`hash ${k} path over whole-number cells: neighbor correlation along x, y, diagonal under 0.01 (no stripes)`,
        Math.max(Math.abs(c.x), Math.abs(c.y), Math.abs(c.d)) < 0.01, JSON.stringify(c));
      check('engine.uniforms.uWind changed: the TSL picture moves and still matches GLSL', r.sync.moved > 1 && r.sync.parity < 0.5, JSON.stringify(r.sync));
      check('engine.uniforms.uTime changed: the TSL water moves and still matches GLSL', r.waterSync.moved > 1 && r.waterSync.parity < 0.5, JSON.stringify(r.waterSync));
      check('two engines: one TSL material reads each renderer\'s own engine uniforms', r.twoEngines.apart > 1 && r.twoEngines.parity2 < 0.5
        && r.twoEngines.cached && r.twoEngines.own, JSON.stringify(r.twoEngines));
      check('a renderer with no engine fails by code [tsl-misuse], not silently', /tsl-misuse/.test(r.unbound), r.unbound);
      check("import 'threedog/tsl' is the same module as render/fx/index.js", r.subpath === true);
    },
  },
];
