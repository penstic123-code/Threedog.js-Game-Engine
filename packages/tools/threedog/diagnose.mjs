// Why the bridge cannot be used: one of five causes, each with the single most likely next step (no generic checklist).
//   no-server   nothing is listening (no dev.json, or the process in it is gone)           -> threedog play
//   starting    the server answers but the page has no ready engine yet and logged nothing -> wait, then threedog status
//   page-error  the page's script failed (errors in .threedog/errors.log) or start() blocked -> threedog errors latest
//   busy        the server's process is alive but the port did not answer the ping in time    -> wait, retry (never start a second server)
//   no-bridge   a dev server answers, but it has no dev bridge (its vite config lacks the plugin) -> use gameConfig
import { basename } from 'node:path';
import { devServerInfo } from '../devinfo.mjs';
import { currentErrors, isError } from './errorlog.mjs';
import { oneLine } from '../lib/oneline.mjs';
import { rel } from '../paths.mjs';

const get = async (url, init, ms = 1500) => { try { return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) }); } catch { return null; } };

/**
 * { state: 'none' | 'ok' | 'missing', port?, foreign?, scanned? }. 'ok' = the server in dev.json answers the bridge with ITS token (a wrong token would also
 * get 401 from a bridge, so a 401 on the real token means the port now belongs to another server: foreign, reported as none so play starts a fresh one).
 * scanned = found by looking at the default vite ports (no dev.json), which may be another project's server; otherPorts: default ports where
 * another workspace's threedog server (it has a bridge) answers
 */
export async function probe(dir) {
  const info = devServerInfo(dir);
  if (info.state === 'live') {
    // asked twice: a server that is only busy (compiling, a page eating the CPU) often misses one 1.5 s window and answers the next
    const ping = () => get(`http://localhost:${info.port}/__threedog/cmd`, { method: 'POST', headers: { 'x-threedog-token': info.token ?? '' }, body: '{"op":"ping"}' });
    const res = await ping() ?? await ping();
    // The record's process exists but the port gave no answer in time: a busy server (first compile, a software-rendered page eating the CPU) looks
    // exactly like a dead one here, and "No dev server is running" for a live pid sent people to start a second server. Say what is known instead.
    if (!res) return { state: 'none', port: info.port, busy: info.pid };
    if (res.status === 200) return { state: 'ok', port: info.port };
    if (res.status === 401) return { state: 'none', port: info.port, foreign: true };
    return { state: 'missing', port: info.port };
  }
  if (info.state !== 'none') return { state: 'none' };   // stale / unreadable record: nothing of ours is running
  // no dev.json: a vite server started by hand (npm run dev with another config) may still be running on a default port;
  // one that has the bridge belongs to another workspace: not ours, but named, so "no dev server" is not said while one visibly runs
  const hits = await Promise.all([5173, 5174, 5175, 5176].map(async p => {
    if (!(await get(`http://localhost:${p}/@vite/client`, {}, 600))?.ok) return null;
    const bridged = (await get(`http://localhost:${p}/__threedog/cmd`, { method: 'POST', headers: { 'x-threedog-token': 'probe' }, body: '{}' }, 600))?.status === 401;
    return { port: p, bridged };
  }));
  const plain = hits.find(h => h && !h.bridged), other = hits.filter(h => h?.bridged).map(h => h.port);
  return plain ? { state: 'missing', port: plain.port, scanned: true } : { state: 'none', ...(other.length && { otherPorts: other }) };
}

/**
 * { kind, text } for a failure, or null when the cause is none of the five (the caller keeps its own message). p: the probe the caller already made: the server
 * is judged by that answer, a second probe can find a busy server free again and leave nothing to say
 */
export async function diagnose(dir, err, p) {
  const msg = String(err?.message ?? err ?? ''), ws = rel(dir) || basename(dir);
  p ??= await probe(dir);
  if (p.state === 'none' && p.otherPorts) return { kind: 'no-server', text: `✗ A threedog dev server answers on port ${p.otherPorts.join(', ')}, but ${ws} has no .threedog/dev.json for it: `
    + `it was started for another folder (it writes its record there), or the record was deleted.\nNext: run the command in the folder that server was started for (or -w <game>); `
    + `to use ${ws} itself, start its own: threedog play, or npm run dev in another terminal.` };
  if (p.state === 'none' && p.busy) return { kind: 'busy', text: `✗ The dev server for ${ws} is running (pid ${p.busy}, port ${p.port}) but did not answer the bridge ping in time: it is probably busy (compiling the game, or a headless page is using the CPU).
`
    + 'Next: wait a few seconds and retry; do not start another server. If it stays like this, stop it (threedog play --stop) and run threedog play.' };
  if (p.state === 'none') return { kind: 'no-server', text: `✗ ${p.foreign ? `The port in .threedog/dev.json (${p.port}) now belongs to another server (the record is out of date)` : `No dev server is running for ${ws}`}.\nNext: threedog play (starts it and waits for the bridge), or npm run dev in another terminal.` };
  if (p.state === 'missing') return { kind: 'no-bridge', text: `✗ A dev server answers on port ${p.port} but it has no dev bridge.\n`
    + 'Next: make the workspace vite.config.js use gameConfig() from @threedog/tools/vite (it installs the bridge), then restart the server.' };
  if (!/engine|start\(\)|window\.engine|did not respond|timed out|blocked/i.test(msg)) return null;
  const errs = currentErrors(dir).filter(isError), last = errs.at(-1);
  if (errs.length || /blocked/.test(msg)) return { kind: 'page-error', text: `✗ The page's script failed before the engine was ready${last ? `: ${oneLine(last.message)}` : ' (startup is blocked)'}.\n`
    + `Next: threedog ${last ? 'errors latest' : 'loading'} ${last ? '(shows the cause and the doc page)' : '(shows the failed asset)'}.` };
  return { kind: 'starting', text: `✗ The dev server is up but the page has no ready engine yet and logged no error.\n`
    + 'Next: wait a few seconds and run threedog status (the first start compiles the game and generates the world). If it stays like this, main.js may never set window.engine = engine.' };
}

