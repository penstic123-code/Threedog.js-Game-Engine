// Shoot every point of a project's shots.json for the hub wall: one build, one headless browser, one fresh page per point.
// Why a fresh page per point: a point's scene (time, weather, a started game) must not leak into the next one, the same as separate `threedog shot` runs.
// Why it reuses lib/shot-page.mjs: the wall's pictures must be what `threedog shot` would give for the same options.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildAndPreview, withBrowser, newGamePage } from '../browser.mjs';
import { openShotPage } from '../lib/shot-page.mjs';
import { viewSize } from '../lib/shot-name.mjs';
import { parsePoints, pointQuery } from './points.mjs';
import { newShotPath, recordRun } from './wall.mjs';

const firstLine = e => String(e?.message ?? e).split('\n')[0];

/**
 * @param {string} dir project folder  @param {{ onPoint?: (name: string, ok: boolean) => void }} [o]
 * @returns {Promise<object>} the wall after this run (errors are recorded in it, never thrown)
 */
export async function shootProject(dir, { onPoint } = {}) {
  const at = Date.now(), file = join(dir, 'shots.json');
  const parsed = parsePoints(existsSync(file) ? readFileSync(file, 'utf8') : null);
  // a broken shots.json is a project-level error: no build, the old pictures stay (an AI is probably mid-edit)
  if (parsed.error) return recordRun(dir, { at, error: parsed.error });
  const results = parsed.pointErrors.map(e => ({ name: e.name ?? `point ${e.index + 1}`, error: e.message }));
  if (!parsed.points.length && !results.length) return recordRun(dir, { at, error: 'shots.json has no points', results: [] });

  // the build reads THREEDOG_TEST at build time (test pages in the tool build); restore it so a long-running hub is not left in test mode
  const hadTest = process.env.THREEDOG_TEST;
  process.env.THREEDOG_TEST = '1';
  let server;
  // its own build folder: shot / test / perf run beside the hub and rebuild .threedog/tool-build under it
  try { server = await buildAndPreview(dir, { outDir: '.threedog/hub-build' }); }
  catch (e) { return recordRun(dir, { at, error: `build failed: ${firstLine(e)}` }); }
  finally { if (hadTest === undefined) delete process.env.THREEDOG_TEST; else process.env.THREEDOG_TEST = hadTest; }
  try {
    // the hub keeps running: a browser that cannot start comes back as an error and is recorded below; withBrowser closes it and the server
    await withBrowser(async ({ launch }) => { const browser = await launch(); for (const p of parsed.points) {
      const errors = [];
      let page;
      try {
        const [W, H] = viewSize(p.size);
        page = await newGamePage(browser, { errors, viewport: { width: W, height: H } });
        const url = /^[\p{L}\p{N}_-]+$/u.test(p.page ?? '/') ? `/${p.page}.html` : (p.page ?? '/');
        await openShotPage(page, server.base, url, pointQuery(p), { errors });
        await page.evaluate(() => engine.step(1 / 30, { render: true }));
        const out = newShotPath(dir, p.name, at);
        mkdirSync(dirname(out), { recursive: true });
        await page.screenshot({ path: out });
        results.push({ name: p.name, file: out });
        onPoint?.(p.name, true);
      } catch (e) {
        results.push({ name: p.name, error: firstLine(e) });
        onPoint?.(p.name, false);
      } finally { await page?.close().catch(() => {}); }
    } }, { prefer: 'gpu', server: async () => server });
  } catch (e) {
    return recordRun(dir, { at, error: `browser failed: ${firstLine(e)}` });   // anything outside the per-point code: recorded, already closed
  }
  return recordRun(dir, { at, results });
}
