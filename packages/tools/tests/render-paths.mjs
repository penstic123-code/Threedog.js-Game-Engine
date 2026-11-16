// The two headless render paths of browser.mjs: tests on SwiftShader (same pixels everywhere), shot / gallery / perf / stress on the hardware GPU
// with a verified fallback. Why a test: a GPU launch that silently lands on software makes every perf number and "GPU ms" a lie, and a test
// browser that drifts onto the GPU makes pixel comparisons machine-dependent; both look fine until someone reads a wrong number.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser, probeRenderer, SOFTWARE_RENDERER, forcedRender, withBrowser } from '../browser.mjs';
import { TOOLS } from '../paths.mjs';

export const name = 'render paths: tests stay on software rendering, a GPU launch is verified or falls back with a reason, THREEDOG_RENDER forces one; withBrowser closes what it opened';

export async function run({ check, browser }) {
  const forced = forcedRender();
  const own = await probeRenderer(browser);
  if (forced !== 'gpu') check(`the test runner's browser renders with software (${own?.renderer})`, browser.render.kind === 'software' && SOFTWARE_RENDERER.test(own?.renderer ?? ''), JSON.stringify(browser.render));
  const saved = process.env.THREEDOG_RENDER;
  try {
    delete process.env.THREEDOG_RENDER;
    const g = await launchBrowser({ prefer: 'gpu' });
    try {
      const r = await probeRenderer(g);
      check(`prefer gpu: a hardware renderer, or software with the fallback reason (${g.render.kind}: ${r?.renderer})`,
        g.render.kind === 'gpu' ? !SOFTWARE_RENDERER.test(r.renderer) && g.render.renderer === r.renderer : SOFTWARE_RENDERER.test(r?.renderer ?? '') && !!g.render.fallback,
        JSON.stringify(g.render));
    } finally { await g.close(); }
    process.env.THREEDOG_RENDER = 'software';
    const s = await launchBrowser({ prefer: 'gpu' });
    try { check('THREEDOG_RENDER=software overrides prefer: gpu', s.render.kind === 'software' && SOFTWARE_RENDERER.test((await probeRenderer(s))?.renderer ?? '')); }
    finally { await s.close(); }
    process.env.THREEDOG_RENDER = 'fast';
    check('an unknown THREEDOG_RENDER value is refused, naming the choices', await launchBrowser().then(b => { b.close(); return ''; }, e => e.message).then(m => /gpu or software/.test(m)));
  } finally { if (saved === undefined) delete process.env.THREEDOG_RENDER; else process.env.THREEDOG_RENDER = saved; }

  // withBrowser: the one lifecycle every command goes through. Why: each command had its own try/finally, and a failed launch left the preview server open
  // and printed a stack. Stand-in browser and server (no Chromium needed): what matters is what gets closed, and on which stream the failure lands
  const closed = [], fake = n => ({ base: 'http://x', close: async () => { closed.push(n); } });
  const err = await withBrowser(async ({ launch }) => { await launch(); await launch(); throw new Error('boom'); },
    { launch: async () => fake('browser'), server: async () => fake('server') }).catch(e => e.message);
  check('[guard] withBrowser closes every browser it launched, then the server, when the work throws, and hands the error back', err === 'boom' && closed.join() === 'browser,browser,server', closed.join());
  const { spawnSync } = await import('node:child_process');
  const probe = `import(${JSON.stringify(pathToFileURL(join(TOOLS, 'browser.mjs')).href)}).then(m => m.withBrowser(async ({ launch }) => { await launch(); console.log('not reached'); },
    { launch: async () => { throw Object.assign(new Error('the headless browser did not start (x): fix'), { code: 'browser-failed' }); }, server: async () => ({ base: '', close: async () => console.error('server closed') }) }))`;
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 30000 });
  check('[guard] a browser that cannot start ends the command with one line on stderr and exit 1, the server closed first, stdout empty (--json stays clean)',
    p.status === 1 && p.stdout === '' && /server closed\r?\n✗ the headless browser did not start \(x\): fix\r?\n/.test(p.stderr) && !/\n\s+at /.test(p.stderr), JSON.stringify({ status: p.status, out: p.stdout, err: p.stderr.slice(0, 300) }));
}
