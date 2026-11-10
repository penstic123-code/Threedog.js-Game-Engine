// Who wrote a picture value (core/inspect/pictureWriters.js), on the real dev server: a bundle has no source lines, so only here do the answers mean anything.
// The page (packages/engine/tests/picture-writers/) wires picture/ parts through one engine.onRender, the case per-hook attribution cannot tell apart.
import { createServer } from 'vite';
import { launchBrowser } from '../browser.mjs';
import { ENGINE, viteOptions } from '../paths.mjs';

export const name = 'value writers: file:line and history, two real writers fighting, the engine yielding with a name, not tracked says so (dev server)';

export async function run({ check }) {
  // a build earlier in this process (the engine specs) leaves NODE_ENV production, and the dev server would then serve import.meta.env.DEV false
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const server = await createServer(await viteOptions(ENGINE, { server: { port: 0, host: 'localhost' }, logLevel: 'error' }));
  await server.listen();
  const browser = await launchBrowser({ prefer: 'software' });
  try {
    const page = await browser.newPage();
    const warnings = [], yields = [];
    page.on('console', m => { if (m.type() === 'warning' && /two writers/.test(m.text())) warnings.push(m.text()); else if (m.type() === 'warning' && /stopped writing it/.test(m.text())) yields.push(m.text()); });
    await page.goto(`${server.resolvedUrls.local[0]}tests/picture-writers/index.html`);
    await page.waitForFunction(() => window.engine?.ready, null, { timeout: 90000 });
    const step = n => page.evaluate(k => { window.engine.haltLoop(); for (let i = 0; i < k; i++) window.engine.step(1 / 60, { describe: false }); }, n);
    const values = () => page.evaluate(() => window.engine.describe('picture').picture.writers);
    await step(3);
    let w = await values();
    const v = k => w.values[k]?.at ?? '';
    check('[guard] one onRender, parts in separate files: each value names its own file', w.tracked && /picture\/lights\.js:\d+$/.test(v('light:sun.intensity')) && /picture\/sky\.js:\d+$/.test(v('fog.color')), JSON.stringify(w).slice(0, 500));
    check('[guard] a Color and a Vector3 changed in place are attributed, through three.js frames', /picture\/lights\.js:10$/.test(v('light:sun.color')) && /picture\/lights\.js:11$/.test(v('light:sun.position')), JSON.stringify([v('light:sun.color'), v('light:sun.position')]));
    check('fog values start with the line that assigned the fog', /picture\/sky\.js:4$/.test(v('fog.near')) && /picture\/sky\.js:4$/.test(v('scene.fog')), JSON.stringify([v('fog.near'), v('scene.fog')]));
    const before0 = await page.evaluate(() => {
      const e = window.engine, a = e.explain({ value: 'material:box.color' }), b = e.explain({ value: 'light:sun.shadow.bias' });
      window.picture.box.material.color.setHex(0xff0000);
      return { a, b, c: e.explain({ value: 'material:box.color' }), d: window.picture.box.material.color.getHex(), e: e.explain({ value: 'light:sun.intensity' }) };
    });
    check('[guard] a value set before tracking and a name outside the list both say not tracked, never a guess', /not tracked: set before/.test(before0.a.text) && !before0.a.ok && /not tracked/.test(before0.b.text) && !before0.b.ok, JSON.stringify([before0.a.text, before0.b.text]));
    check('a write made from the console has no source file and says so, and the write goes through', !before0.c.ok && /no source file/.test(before0.c.text) && before0.d === 0xff0000, before0.c.text);
    check('explain names the line for a tracked value', before0.e.ok && /picture\/lights\.js:9/.test(before0.e.text), before0.e.text);
    // group P2 item 2: a direct renderer.shadowMap.enabled write (what describe() used to suggest) is watched like toneMapping: the writers tool sees it
    const shadowWrite = await page.evaluate(() => { const e = window.engine; e.renderer.shadowMap.enabled = false; const x = e.explain({ value: 'renderer.shadowMap.enabled' }); e.renderer.shadowMap.enabled = true; return x; });
    check('[guard] group P2 2b: a direct renderer.shadowMap.enabled write is seen (not "nothing is known")', /no source file/.test(shadowWrite.text), shadowWrite.text);
    check('[guard] steps in one function are no fight (copy then lerp on fog.color)', warnings.length === 0 && (await values()).conflicts.length === 0, warnings.join(' | '));

    for (const mode of ['nightOnly', 'dayOnly', 'nightOnly']) { await page.evaluate(m => { window.mode = m; }, mode); await step(2); }
    check('[guard] a value written from two states across frames is no fight', warnings.length === 0, warnings.join(' | '));

    await page.evaluate(() => { window.mode = 'fight'; });
    await step(40);
    w = await values();
    const c = w.conflicts.find(x => x.value === 'fog.far');
    check('[guard] two files writing fog.far in one frame: one warning naming both file:line', warnings.length === 1 && /fog\.far/.test(warnings[0]) && /picture\/sky\.js:\d+/.test(warnings[0]) && /picture\/rival\.js:\d+/.test(warnings[0]) && !!c, warnings.join(' | ') + JSON.stringify(w.conflicts));
    await step(40);
    check('[guard] the warning comes once per value', warnings.length === 1, String(warnings.length));
    const far = await page.evaluate(() => window.engine.scene.fog.far);
    check('[guard] nothing is blocked: the later write stands', far === 90, String(far));

    // core lives in folders (core/inspect/DebugOverrides.js): a write from there is the engine's, however deep the file
    await page.evaluate(() => { const e = window.engine; e.debug.override('wr', e.scene.getObjectByName('sun'), 'intensity', 9); });
    await step(40);
    const overridden = (await values()).conflicts.filter(x => x.value === 'light:sun.intensity');
    check('[guard] a debug override is the engine writing: no fight with the picture code it overrides', overridden.length === 0, JSON.stringify(overridden));

    const before = (await values()).stacks;
    await step(60);
    const cost = (await values()).stacks - before;
    // 4 moving values, 3 components each, twice for fog.color: a stack on every write would be over 700 in 60 frames
    check('[guard] stacks stay sampled: a value written every frame gets about one look per 30 frames', cost < 80, String(cost));

    // two real writers in two files that never share a frame: a value the game named, written from picture/lights.js on even ticks and picture/rival.js on odd ones
    const quiet = await page.evaluate(() => window.engine.explain({ value: 'game.speed' }));
    check('[guard] a named value nobody wrote answers not tracked', !quiet.ok && /not tracked/.test(quiet.text), quiet.text);
    await page.evaluate(() => { window.mode = 'duel'; });
    await step(30);
    const duel = await page.evaluate(() => window.engine.explain({ value: 'game.speed' }));
    const hint = warnings.find(x => /game\.speed/.test(x)) ?? '';
    check('[guard] two writers taking turns: one one-line hint naming both files', /taking turns/.test(hint) && /picture\/lights\.js:\d+/.test(hint) && /picture\/rival\.js:\d+/.test(hint) && hint.split('\n').length === 1, hint);
    check('[guard] explain gives the history of the value with frames, and the fix', duel.ok && duel.detail.history.length >= 2 && duel.detail.history.every(h => /picture\/(lights|rival)\.js:\d+$/.test(h.at) && h.frame > 0) && /Fix, one of/.test(duel.text), duel.text);
    check('[guard] a fight blocks nothing', (await page.evaluate(() => window.game.speed)) > 0);

    // the engine's own value: it yields, and now says to whom
    await page.evaluate(() => { window.mode = 'day'; window.takeFar(); window.engine.viewFar(5000); });
    await step(2);
    const view = await page.evaluate(() => ({ x: window.engine.explain({ value: 'view.far' }), row: window.engine.describe('owned').owned['view.far'], v: window.engine.camera.far }));
    check('[guard] the engine yields as before, and the warning, describe().owned and explain name the line', view.v === 777 && view.row.writer.startsWith('three') && /main\.js:\d+$/.test(view.row.writtenAt) && yields.some(y => /view\.far/.test(y) && /Written at .*main\.js:\d+/.test(y)) && /main\.js:\d+/.test(view.x.text), JSON.stringify([view, yields]));
    check('[guard] a clean answer never claims there is no conflict', /No fight seen; none seen is not proof of none/.test(view.x.text), view.x.text);
    const ratio = await page.evaluate(() => window.engine.explain({ value: 'view.pixelRatio' }));
    check('[guard] an owned value no hook can sit on says so', !ratio.ok && /not tracked/.test(ratio.text), ratio.text);

    await page.evaluate(() => window.dimSun());
    const point = await page.evaluate(() => window.engine.explain({ value: 'game.sun' }));
    check('[guard] a shared point answers through the same entry, with its owner and line, and admits what it cannot see', point.ok && /intro/.test(point.text) && /main\.js:\d+/.test(point.text) && /not seen here/.test(point.text), point.text);
    const none = await page.evaluate(() => window.engine.explain({ value: 'boss.mood' }));
    check('[guard] an unknown name says nothing is known, and how to watch it', !none.ok && /nothing is known/.test(none.text) && /engine\.debug\.watch/.test(none.text), none.text);
    const taken = await page.evaluate(() => window.engine.debug.watch('fog.far', {}, 'x').watching);
    check('[guard] a name already answering is refused', taken === false);
    // a removed watch stops tracking: its setter stays (others may answer through it) but takes no more stacks
    const stopped = await page.evaluate(() => {
      const E = window.engine, o = { v: 0 }, h = E.debug.watch('gi.removed', o, 'v');
      o.v = 1; const n = E._picture.stacks; h.remove();
      for (let i = 2; i < 40; i++) o.v = i;
      return E._picture.stacks === n;
    });
    check('[guard] a removed watch takes no more stacks', stopped === true);
    // the accessor outlives the first record: a watch again on the same property records, and removing one of two records leaves the other recording
    const again = await page.evaluate(() => {
      const E = window.engine, o = { v: 0 }, o2 = { v: 0 }, P = E._picture;
      E.debug.watch('gi.a', o, 'v').remove();
      const h = E.debug.watch('gi.a2', o, 'v'); let n = P.stacks; o.v = 1; const reHook = P.stacks > n;
      h.remove(); const plain = Object.getOwnPropertyDescriptor(o, 'v').value === 1;
      const first = E.debug.watch('gi.b1', o2, 'v'), second = E.debug.watch('gi.b2', o2, 'v');
      first.remove(); n = P.stacks; o2.v = 5; const other = P.stacks > n;
      return { reHook, plain, other, second: second.watching };
    });
    check('[guard] a watch again after remove records; two records on one property, remove one, the other still records', again.reHook && again.plain && again.other, JSON.stringify(again));
    const w2 = await values();
    check('[guard] the list says its own limit', /not proof/.test(w2.limit), w2.limit);

    const list = await page.evaluate(() => window.engine.describe({ only: ['threePatches'] }).threePatches?.map(p => p.id) ?? window.engine.threePatches?.list().map(p => p.id));
    check('the change is listed with the others', !!list?.includes('picture-writers'), String(list));
    const off = await page.evaluate(() => { window.THREEDOG_OFF?.('picture-writers'); return window.engine.explain({ value: 'game.speed' }).text; });
    check('[guard] switched off, it says so instead of answering from old records', /turned this off/.test(off), off);
  } finally { await browser.close(); await server.close(); process.env.NODE_ENV = env; }
}
