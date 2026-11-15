// shots.json parser of the project hub: a file an AI is editing must give a readable message, never a crash or a different picture.
import { parsePoints, pointQuery, pointFile } from '../hub/points.mjs';

export const name = 'hub-points: shots.json parses strictly, names the bad point and key, one default point when the file is missing';

export async function run({ check }) {
  check('missing file → one default point', parsePoints(null).points[0].name === 'default');
  check('invalid JSON → project error, no points', !!parsePoints('[{').error && parsePoints('[{').points.length === 0);
  check('not an array → project error', !!parsePoints('{}').error);
  const r = parsePoints(JSON.stringify([{ name: 'a', view: 'x' }, { name: 'b', colour: 1 }, { name: 'c', view: 'v', cam: [0, 1, 2, 0, 0, 0] }, { view: 'y' }, { name: 'a' }]));
  check('valid point kept', r.points.map(p => p.name).join() === 'a');
  check('unknown key named', r.pointErrors.some(e => e.name === 'b' && /colour/.test(e.message)));
  check('view+cam refused', r.pointErrors.some(e => e.name === 'c'));
  check('missing name refused', r.pointErrors.some(e => e.index === 3));
  check('duplicate name refused', r.pointErrors.some(e => e.index === 4 && /a/.test(e.message)));
  check('bad cam and size refused', parsePoints('[{"name":"x","cam":[1,2]},{"name":"y","size":"big"}]').pointErrors.length === 2);
  check('query', pointQuery({ name: 'n', cam: [0, 12, 30, 0, 0, 0], play: true }).get('view') === '0,12,30,0,0,0' && pointQuery({ name: 'n' }).get('wait') === '1');
  check('query keys as shot', pointQuery({ name: 'n', play: true, at: 'x' }).has('play') && pointQuery({ name: 'n' }).get('cutscene') === 'skip' && pointQuery({ name: 'n' }).get('threedog-tier') === 'high');
  check('file stem', pointFile('村口 全景/1') === '村口-全景-1');
}
