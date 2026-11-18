// expect spec: expectations.jsonl becomes test items (one per point, or one on `/`), a failed expectation is a failed check, a reading from another renderer is said aloud. No browser.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectationSpecs, checkResults } from '../expect/spec.mjs';
import { TOOLS } from '../paths.mjs';

export const name = 'expect spec: expectations.jsonl gives one test item per point, failures and other-backend readings show as checks';

const line = o => JSON.stringify(o) + '\n';

export async function run({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'expect-spec-')), file = join(dir, 'expectations.jsonl');
  try {
    check('[guard] no file gives no items', expectationSpecs(dir).length === 0);
    writeFileSync(file, line({ value: 'economy.gold', min: 0, why: 'a negative balance sold for free' }));
    const plain = expectationSpecs(dir);
    check('[guard] only point-less entries give one item on /', plain.length === 1 && plain[0].name === 'expectations' && plain[0].url === '/', JSON.stringify(plain.map(s => [s.name, s.url])));

    writeFileSync(join(dir, 'shots.json'), '[{ "name": "dusk", "time": 18 }, { "name": "noon", "page": "/town.html" }]');
    writeFileSync(file, line({ value: 'economy.gold', min: 0, why: 'a negative balance sold for free' }) + line({ value: 'shot.dark', max: 0.3, point: 'dusk', why: 'the pier must stay readable', backend: 'webgpu' }) + line({ value: 'npc.count', is: 3, point: 'noon', why: 'the town keeps three' }));
    const two = expectationSpecs(dir);
    check('[guard] two points and the point-less entries give three items, the points with their url', two.length === 3 && two[0].name === 'expectations' && two[0].url === '/' && two[1].name === 'expectations: dusk' && /^\/\?.*time=18/.test(two[1].url) && two[2].name === 'expectations: noon' && /^\/town\.html\?/.test(two[2].url), JSON.stringify(two.map(s => [s.name, s.url])));
    writeFileSync(join(dir, 'shots.json'), '[{ "name": "a", "page": "town" }, { "name": "b", "page": "/g.html?lang=en" }]');
    writeFileSync(file, line({ value: 'economy.gold', min: 0, why: 'a negative balance sold for free', point: 'a' }) + line({ value: 'economy.gold', min: 0, why: 'a negative balance sold for free', point: 'b' }));
    const pages = expectationSpecs(dir).map(s => s.url);
    check('[guard] a bare page name and a page with a query open as the hub opens them', /^\/town\.html\?threedog-tier/.test(pages[0]) && /^\/g\.html\?lang=en&threedog-tier/.test(pages[1]), pages.join(' '));
    writeFileSync(join(dir, 'shots.json'), '[{ "name": "dusk", "time": 18 }, { "name": "noon", "page": "/town.html" }]');
    writeFileSync(file, line({ value: 'economy.gold', min: 0, why: 'a negative balance sold for free' }) + line({ value: 'shot.dark', max: 0.3, point: 'dusk', why: 'the pier must stay readable', backend: 'webgpu · gpu' }) + line({ value: 'npc.count', is: 3, point: 'noon', why: 'the town keeps three' }));

    // a fake page: ev answers by what the function is, check collects
    const got = [];
    const ev = fn => String(fn).includes('describe()') && !String(fn).includes('.renderer') ? { describe: { economy: { gold: -5 }, npc: { count: 3 } }, halted: false } : { backend: 'webgl2' };
    const fakePage = { evaluate: async () => ({ pixels: null, error: 'fake' }), setViewportSize: async () => {} };
    await two[2].run({ ev, page: fakePage, check: (label, ok, detail) => got.push({ label, ok, detail }) });
    check('[guard] a point item judges only its own entries', !got.some(c => /economy\.gold/.test(c.label)), JSON.stringify(got));
    const loose = []; await two[0].run({ ev, page: fakePage, check: (label, ok, detail) => loose.push({ label, ok, detail }) });
    const gold = loose.find(c => /economy\.gold/.test(c.label)), npc = got.find(c => /npc\.count/.test(c.label));
    check('[guard] a failed expectation is a failing check with now and why', gold && !gold.ok && gold.label === 'expected economy.gold >= 0 at any view' && /now -5\. Why: "a negative balance sold for free"/.test(gold.detail), JSON.stringify(loose));
    check('a held expectation passes', npc?.ok === true);
    // the dusk item asks for a picture: the fake page cannot give one, so it says so as a failure instead of passing quietly
    const dusk = []; await two[1].run({ ev, page: fakePage, check: (label, ok, detail) => dusk.push({ label, ok, detail }) });
    check('[guard] an unreadable picture fails loudly', dusk.some(c => !c.ok && /picture/.test(c.label) && c.detail === 'fake'), JSON.stringify(dusk));

    // another backend and a stopped page: both are said in one passing check, not dropped
    const un = [], shotEntry = { value: 'shot.dark', max: 0.3, point: 'dusk', why: 'x', backend: 'webgpu' };
    checkResults([{ status: 'unmeasured', cause: 'backend', drawnBy: 'WebGL 2', entry: shotEntry, text: 'shot.dark not measured here' }, { status: 'unmeasured', cause: 'halted', entry: { value: 'perf.fps' }, text: 'perf.fps needs a live page (this one is stepped by hand)' }], { point: 'dusk', check: (l, ok) => un.push({ l, ok }) });
    check('[guard] unmeasured entries make one passing check that lists why', un.length === 1 && un[0].ok && un[0].l.startsWith('skipped: ') && un[0].l.includes('1 cannot be checked here (written for webgpu, drawn by WebGL 2); perf.fps needs a live page'), JSON.stringify(un));

    check('[guard] a broken file is one failing item', (writeFileSync(file, '{not json}\n'), expectationSpecs(dir).length === 1));
    const bad = []; expectationSpecs(dir)[0].run({ check: (l, ok, d) => bad.push({ l, ok, d }) });
    check('the broken file item fails with the line problem', bad[0]?.ok === false && /line 1/.test(bad[0].d), JSON.stringify(bad));

    const runSrc = readFileSync(join(TOOLS, 'run.mjs'), 'utf8');
    check('[guard] run.mjs includes expectationSpecs(dir) in its item list', /const all = \[[^\]]*expectationSpecs\(dir\)/.test(runSrc));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
