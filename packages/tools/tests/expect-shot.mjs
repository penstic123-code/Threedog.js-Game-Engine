// expect shot: `threedog shot --point` and the expectation lines under a shot. No browser: the pieces are checked, the page run is the coordinator's smoke shot.
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPoint, pointQuery, shotQuery, joined } from '../hub/points.mjs';
import { remind } from '../lib/remind.mjs';
import { writeLast, readLast } from '../expect/last.mjs';
import { assemble } from '../expect/facts.mjs';
import { TOOLS } from '../paths.mjs';

export const name = 'expect shot: --point finds the point of shots.json, builds the same URL keys as the hub, expectation lines follow the picture, one reminder line';

export async function run({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'expect-shot-'));
  try {
    check('[guard] no shots.json: default is found', findPoint(dir, 'default').name === 'default');
    const p = { name: 'night-harbor', time: '23:00', weather: 'rain', pos: [4, -2], cam: [0, 12, 30, 0, 0, 0], wait: 2, play: true };
    writeFileSync(join(dir, 'shots.json'), JSON.stringify([p, { name: 'dawn' }]));
    check('[guard] findPoint returns the point', findPoint(dir, 'night-harbor').weather === 'rain');
    let msg = ''; try { findPoint(dir, 'night-harbour'); } catch (e) { msg = e.message; }
    check('[guard] an unknown point names the closest one', /did you mean "night-harbor"/.test(msg), msg);
    // what shot.mjs does with a point: the fields become its options (cam / pos joined, wait a number), then shotQuery builds the keys
    const opt = {}; for (const k of ['time', 'weather', 'pos', 'at', 'view', 'cam', 'wait', 'play']) if (p[k] !== undefined) opt[k] = k === 'pos' || k === 'cam' ? joined(p[k]) : p[k];
    check('[guard] the point through shot\'s options gives the hub\'s URL keys', shotQuery(opt, { tier: 'high' }).toString() === pointQuery(p).toString(), shotQuery(opt).toString());

    const src = readFileSync(join(TOOLS, 'shot.mjs'), 'utf8');
    check('[guard] shot: expectation lines come after the picture lines, the hint goes through remind only under a named point, no entries means no evaluation',
      src.indexOf('result.pictureLines.join') < src.lastIndexOf('await checkExpectations()') && /expectLines\(/.test(src) && /remind\(\[/.test(src) && /point === undefined \? null : hintLine/.test(src) && /if \(mine\.length\)/.test(src) && /shotQuery\(/.test(src));
    check('[guard] remind: one item for a shot is one line', remind([{ file: 'expectations', message: 'm', short: 's' }], { where: 'shot' }).lines.length === 1);

    writeLast(dir, 'night-harbor', assemble({ describe: { economy: { gold: 3 } }, picture: { dark: 0.2 }, backend: 'webgl' }), [{ entry: { value: 'economy.gold' }, actual: 3 }]);
    const last = readLast(dir, 'night-harbor');
    check('expect-last keeps the backend, the picture numbers and the mentioned paths only', last.backend === 'webgl' && last.values['shot.dark'] === 0.2 && last.values['economy.gold'] === 3 && Object.keys(last.values).length === 2);
    writeFileSync(join(dir, '.threedog', 'expect-last.json'), '{broken');
    check('a broken expect-last is no reading', readLast(dir, 'night-harbor') === null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
