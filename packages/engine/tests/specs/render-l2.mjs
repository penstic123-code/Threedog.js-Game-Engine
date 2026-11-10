// Render layer 2 fixes (docs/plans/2026-11-09-render-l2.md, GPT review l2-render). Page: tests/render-l2, one WebGPU engine. software: false, like
// shadow-cache: the picture checks once went silent only on the WebGPU route, so the page must land on the real WebGPU backend or fail.
import { readFileSync, readdirSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const code = f => readFileSync(new URL(f, ROOT), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const filesIn = d => readdirSync(new URL(d, ROOT), { withFileTypes: true }).flatMap(f => (f.isDirectory() ? filesIn(`${d}/${f.name}`) : f.name.endsWith('.js') ? [`${d}/${f.name}`] : []));

export const specs = [
  {
    name: '[guard] render layer 2 on WebGPU: picture checks speak after a frame',
    url: '/tests/render-l2/index.html',
    software: false,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const c = await ev(() => window.checksOnWebGPU());
      check('the page runs on WebGPURenderer, real WebGPU backend', c.webgpu && c.backend === 'webgpu', JSON.stringify(c));
      check("after a drawn frame the picture checks run on WebGPU: the metal ball with no environment is named ('metal-no-env')", c.after.includes('metal-no-env'), JSON.stringify(c));
      // 不许绕开: "has the renderer drawn" is spelled differently per renderer (info.render.frame on WebGL, none on WebGPU); only render/backend.js reads it
      const bare = [...filesIn('core'), ...filesIn('render')].filter(f => f !== 'render/backend.js' && /\binfo\??\.(render\??\.)?frame\b/.test(code(f)));
      check('no core or render file reads renderer.info.(render.)frame itself: drawnAFrame (render/backend.js) is the one reader', !bare.length, JSON.stringify(bare));

      const t = await ev(() => window.tierFollow());
      check('cascades follow a tier change while running: 3 maps on high, 1 on low, 3 again when the preset goes; a removed handle follows nothing',
        t.high === 3 && t.low === 1 && t.sameKept && t.back === 3 && t.afterRemove === null, JSON.stringify(t));
      // 不许绕开: engine.tier has one change notice (core/scene/tier.js); the stack's onChange calls only it, so no reader is told by a side path
      const svc = code('core/engine/services.js'), tierLine = svc.split('\n').find(l => l.includes("define('tier'")) ?? '';
      check("the tier stack's onChange is tierChanged alone; post and cascades subscribe with onTierChange",
        /onChange: \(\) => tierChanged\(engine\) \}/.test(tierLine) && /onTierChange\(/.test(code('render/PostFX.js')) && /onTierChange\(/.test(code('render/shadows.js')), tierLine.trim());

      const p = await ev(() => window.chainRebuilds());
      const J = JSON.stringify(p);
      check('post.antialias written with the value it has rebuilds no node and keeps the scene pass', p.sameAA.heavy === p.first.heavy && p.sameAA.pass, J);
      check('[guard] toggling a final effect rebuilds only from its place: the heavy hdr effect before it keeps its nodes', p.toggled.heavy === p.first.heavy && p.toggled.cheap === 2, J);
      check('a new scene buffer (MRT) still rebuilds the whole chain, and so does taking it away', p.mrt.heavy === p.toggled.heavy + 1 && p.mrtGone.heavy === p.mrt.heavy + 1, J);
      check('[guard] with no effect on, the WebGPU pipeline and its scene pass targets are freed; turning one on builds them again',
        p.empty.pipe === null && p.empty.freed && p.back.pipe && p.back.heavy === p.mrtGone.heavy + 1, J);
      check('[guard] post.own(false) after the game owned the chain rebuilds every stage (no kept node the game may have edited)', p.handBack.heavy === p.back.heavy + 1, J);

      const ct = await ev(() => window.cascadesThrow());
      check('[guard] cascades whose first build throws leave no tier listener: a later tier change builds nothing and throws nothing', /build fails/.test(ct.threw) && !ct.after && ct.csm === false, JSON.stringify(ct));
    },
  },
  {
    name: '[guard] render layer 2 on WebGL: the same antialias value frees no composer target and rebuilds no pass',
    url: '/tests/render-l2/index.html?route=webgl',
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const a = await ev(() => window.sameAAWebGL());
      check('post.antialias written with its own value on WebGLRenderer: no target freed, no pass resized (the chain is not synced); a real change frees both', a.webgl && a.same.freed === 0 && a.same.sized === 0 && a.changed === 2, JSON.stringify(a));
    },
  },
];
