// A game's expectations.jsonl as test items for `threedog test`: an expectation that fails is a test that fails (the game's own tests, written by shot / expect).
// One item per point the file names (the page is opened the way the hub and `shot --point` open that point), and one on `/` for the entries that name no point.
// Why no last.mjs write: tests draw with software rendering, and would overwrite the backend a real shot recorded.
import { join } from 'node:path';
import { FILE_NAME, read } from './file.mjs';
import { PAGE_FACTS, assemble } from './facts.mjs';
import { evaluate, rangeText, whyText, backendText } from './evaluate.mjs';
import { findPoint, pointUrl } from '../hub/points.mjs';
import { pagePicture } from '../picture/check.mjs';
import { drawnBy } from '../lib/page-url.mjs';
import { viewSize } from '../lib/shot-name.mjs';
import { settleUi } from '../lib/shot-page.mjs';
import { waitLoaded } from '../wait-engine.mjs';

const show = v => JSON.stringify(v);

/** The checks of one reading: one per expectation, then one `skipped:` line naming what could not be measured (run.mjs counts it as "did not run", never as a pass) */
export function checkResults(results, { point, check }) {
  for (const r of results.filter(x => x.status !== 'unmeasured')) {
    const e = r.entry, label = `expected ${e.value} ${rangeText(e)} at ${point ?? 'any view'}`;
    const was = e.was !== undefined ? ` (was ${show(e.was)})` : '';
    check(label, r.status === 'holds', r.status === 'missing' ? `no longer in describe(). ${whyText(e)}` : `now ${show(r.actual)}${was}. ${whyText(e)}`);
  }
  const un = results.filter(x => x.status === 'unmeasured');
  if (!un.length) return;
  const backend = un.filter(x => x.cause === 'backend'), rest = un.filter(x => x.cause !== 'backend');
  const parts = [backend.length && backendText(backend), ...rest.map(x => x.text)].filter(Boolean);
  check(`skipped: not measured here: ${parts.join('; ')}`, true);
}

/** One reading of the open page, checked against `mine` (the entries of this point, or the ones that name none); `size`: the point's view size */
const readingRun = (mine, point, size = null) => async ({ ev, page, check }) => {
  if (size) await page.setViewportSize({ width: size[0], height: size[1] });   // the point's own size, as shot and the hub use it
  // a new size reaches canvas, camera and UI root on the next engine.step (no frame loop to do it on a stepped page)
  if (size) await page.evaluate(() => engine.step(1 / 60, { render: false, describe: false }));
  await waitLoaded(page);   // the same two steps as shot's openShotPage: a number read while the world is still arriving is not the game's
  await settleUi(page);
  const { describe, halted } = await ev(PAGE_FACTS);
  let picture = null;
  if (mine.some(e => e.value.startsWith('shot.'))) {   // a picture costs time: only when a shot.* number is asked for
    const lk = await pagePicture((src, arg) => page.evaluate(`(${src})(${JSON.stringify(arg)})`), { time: 'auto' });
    if (lk.error) check('the picture could be read for shot.* expectations', false, lk.error);
    else picture = lk.numbers;
  }
  // a picture number only runs on software rendering here (the item is marked), so that is the kind written next to the renderer (as shot writes it)
  const backend = `${drawnBy(await ev(() => engine.describe().renderer))} · software`;
  checkResults(evaluate(mine, assemble({ describe, halted, picture, backend }), { point }), { point, check });
};

/** The test items of this workspace's expectations.jsonl (none when it has no file) */
export function expectationSpecs(dir) {
  const { entries, problems } = read(join(dir, FILE_NAME));
  if (problems.length) return [{ name: 'expectations', url: '/', run: ({ check }) => check(`${FILE_NAME} reads`, false, problems[0]) }];
  const loose = entries.filter(e => !e.point);
  const points = [...new Set(entries.map(e => e.point).filter(Boolean))];
  const items = loose.length ? [{ name: 'expectations', url: '/', run: readingRun(loose, undefined) }] : [];
  for (const point of points) {
    let p;
    try { p = findPoint(dir, point); } catch (e) { items.push({ name: `expectations: ${point}`, url: '/', run: ({ check }) => check(`point ${point} is in shots.json`, false, e.message) }); continue; }
    const mine = entries.filter(e => e.point === point);
    // a picture number is read from pixels: software rendering, so the test gives the same number on every machine (run.mjs spec.software)
    const software = mine.some(e => e.value.startsWith('shot.'));
    items.push({ name: `expectations: ${point}`, url: pointUrl(p), software, run: readingRun(mine, point, viewSize(p.size)) });
  }
  return items;
}
