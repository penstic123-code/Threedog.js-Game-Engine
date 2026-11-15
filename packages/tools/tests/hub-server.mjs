// Hub server: API, picture serving, traversal refusal, a deleted project, SSE. A fake shooter keeps it away from real rendering.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHub } from '../hub/server.mjs';
import { recordRun, newShotPath, wallDir } from '../hub/wall.mjs';

export const name = 'hub-server: ping, add folder, reshoot, picture served, traversal refused, deleted folder, events';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export async function run({ check }) {
  const tmp = mkdtempSync(join(tmpdir(), 'hub-server-')), env = { ...process.env, THREEDOG_HOME: join(tmp, 'home') };
  const game = join(tmp, 'farm'), plain = join(tmp, 'plain');
  mkdirSync(game); mkdirSync(plain);
  writeFileSync(join(game, 'package.json'), JSON.stringify({ name: 'farm', dependencies: { threedog: '^1.3.0' } }));
  writeFileSync(join(plain, 'package.json'), '{}');
  const fake = { calls: 0 };
  const shoot = async dir => {
    fake.calls++;
    const at = Date.now(), f = newShotPath(dir, 'start', at);
    mkdirSync(wallDir(dir), { recursive: true }); writeFileSync(f, PNG);
    recordRun(dir, { at, results: [{ name: 'start', file: f }] });
  };
  const hub = await startHub({ port: 0, env, shoot });
  try {
    const call = async (path, method = 'GET', body) => { const r = await fetch(hub.url + path, { method, body: body && JSON.stringify(body) }); return { status: r.status, type: r.headers.get('content-type'), text: await r.text() }; };
    const get = async p => JSON.parse((await call(p)).text);
    const until = async fn => { for (let i = 0; i < 100 && !fn(); i++) await new Promise(r => setTimeout(r, 50)); return fn(); };

    // SSE listener opened before the work
    let sawEvent = false;
    const ac = new AbortController();
    fetch(hub.url + '/events', { signal: ac.signal }).then(async r => { for await (const c of r.body) if (Buffer.from(c).toString().includes('"project"')) sawEvent = true; }).catch(() => {});

    check('ping', (await get('/api/ping')).hub === 'threedog');
    check('page is served', /threedog hub/.test((await call('/')).text));
    const foreign = await fetch(hub.url + '/api/quit', { method: 'POST', headers: { origin: 'http://evil.example' } });
    check('a POST from another web page is refused (403), hub stays up', foreign.status === 403 && (await get('/api/ping')).hub === 'threedog');
    const bad = await call('/api/projects', 'POST', { dir: plain });
    check('add folder without threedog -> 400 with reason', bad.status === 400 && /threedog/.test(JSON.parse(bad.text).reason));
    const added = await call('/api/projects', 'POST', { dir: game });
    const id = JSON.parse(added.text).id;
    check('add game -> listed', (await get('/api/projects')).length === 1);
    await call(`/api/projects/${id}/reshoot`, 'POST');
    check('reshoot ran the shooter', await until(() => fake.calls >= 1));
    const cover = await (async () => { for (let i = 0; i < 60; i++) { const c = (await get('/api/projects'))[0].cover; if (c) return c; await new Promise(r => setTimeout(r, 50)); } return null; })();
    const img = cover && await fetch(hub.url + cover);
    check('cover url served as image/png', img?.headers.get('content-type') === 'image/png');
    check('path traversal refused', (await call(`/wall/${id}/..%2F..%2Fpackage.json`)).status >= 400 && (await call(`/wall/${id}/..%5Cpackage.json`)).status >= 400);
    check('SSE sent a project event', await until(() => sawEvent));
    rmSync(game, { recursive: true, force: true });
    await new Promise(r => setTimeout(r, 200));
    const after = await get('/api/projects');
    check('deleted project -> exists:false, server alive', after[0].exists === false && (await get('/api/ping')).hub === 'threedog');
    ac.abort();
  } finally { await hub.close(); rmSync(tmp, { recursive: true, force: true }); }
}
