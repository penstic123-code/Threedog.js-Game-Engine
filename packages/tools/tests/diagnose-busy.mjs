// A dev server that is alive but slow to answer the bridge ping must not be reported as "No dev server is running" (threedog/diagnose.mjs).
// Why: a play-test saw `threedog describe` say "no dev server" while one was running. Not reproduced with a healthy server (the bridge opens its own
// headless page); the one path that can print it for a live server is a ping that times out, which looked the same as a dead port.
// Fixture: a plain http server that accepts the ping and never answers, plus a dev.json naming this process as its pid.
// Run: threedog test "busy dev server"
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { diagnose } from '../threedog/diagnose.mjs';
import { execute } from '../threedog/dispatch.mjs';
import { stopServer } from '../threedog/play.mjs';

export const name = 'busy dev server: a live pid whose port does not answer the ping is reported as busy, not as "No dev server is running"';

export async function run({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'td-busy-'));
  const srv = createServer(() => { /* never answers */ });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    mkdirSync(join(dir, '.threedog'));
    writeFileSync(join(dir, '.threedog', 'dev.json'), JSON.stringify({ port: srv.address().port, token: 't', pid: process.pid }));
    const d = await diagnose(dir);
    check('names the live server and says wait, not "No dev server is running"', d?.kind === 'busy' && /is running/.test(d.text) && !/No dev server is running/.test(d.text) && /retry/.test(d.text), d?.text);
    // a record whose process is gone: the words of connect.mjs differ from "no dev server", the code must not
    writeFileSync(join(dir, '.threedog', 'dev.json'), JSON.stringify({ port: 1, token: 't', pid: 2 ** 22 + 1 }));
    const stale = await execute(dir, 'describe');
    check('a stale record answers no-server, not command-error', stale.code === 'no-server', JSON.stringify(stale));
    const pic = await execute(dir, 'picture-palette', ['no-such-picture.png']);
    check('[guard] a picture command with a bad file is a command error, not "page not ready"', !pic.ok && pic.code === 'command-error', JSON.stringify(pic));
  } finally { srv.closeAllConnections?.(); srv.close(); rmSync(dir, { recursive: true, force: true }); }
  // [guard] the server misses the probe's two pings (it asks twice) and answers the next: the answer status acted on stands. A second look found it free, had nothing to say, and execute threw
  const dir2 = mkdtempSync(join(tmpdir(), 'td-busy-'));
  let pings = 0;
  const slow = createServer((req, res) => { if (++pings > 2) res.end('{"ok":true,"value":false}'); });
  await new Promise(r => slow.listen(0, '127.0.0.1', r));
  try {
    mkdirSync(join(dir2, '.threedog'));
    writeFileSync(join(dir2, '.threedog', 'dev.json'), JSON.stringify({ port: slow.address().port, token: 't', pid: process.pid }));
    const st = await execute(dir2, 'status').catch(e => ({ code: 'threw: ' + e.message }));
    check('[guard] status on a server that frees up meanwhile still answers: busy, with its text', st.code === 'busy' && /did not answer/.test(st.text), JSON.stringify(st));
    // [guard] play.json outlives a server that stopped itself: the hand-started server answering now is not play's to kill
    writeFileSync(join(dir2, '.threedog', 'play.json'), JSON.stringify({ pid: 2 ** 22 + 1 }));
    const stop = await stopServer(dir2);
    check('[guard] play --stop with a dead play.json pid leaves the running server up and drops the record', stop.ok && /keeps running/.test(stop.text) && !existsSync(join(dir2, '.threedog', 'play.json'))
      && existsSync(join(dir2, '.threedog', 'dev.json')), stop.text);
  } finally { slow.closeAllConnections?.(); slow.close(); rmSync(dir2, { recursive: true, force: true }); }
  // [guard] the recorded port now holds a web server: its HTML reached JSON.parse and the reader got "Unexpected token <"
  const dir3 = mkdtempSync(join(tmpdir(), 'td-busy-'));
  const web = createServer((req, res) => { res.statusCode = 404; res.end('<html>not found</html>'); });
  await new Promise(r => web.listen(0, '127.0.0.1', r));
  try {
    mkdirSync(join(dir3, '.threedog'));
    writeFileSync(join(dir3, '.threedog', 'dev.json'), JSON.stringify({ port: web.address().port, token: 't', pid: process.pid }));
    const other = await execute(dir3, 'describe');
    check('[guard] a port that answers HTML gets the diagnosis, not a parse error', other.code === 'no-bridge' && !/Unexpected token/.test(other.text), JSON.stringify(other));
  } finally { web.closeAllConnections?.(); web.close(); rmSync(dir3, { recursive: true, force: true }); }
}
