// A page whose audio context never reaches 'running' (headless Chromium with no audio device) is reported as an environment problem under the
// failed test (lib/audio-env.mjs, used by run.mjs); a context that was only suspended on purpose, or a running one, adds nothing.
import { launchBrowser } from '../browser.mjs';
import { audioEnvLine } from '../lib/audio-env.mjs';

export const name = 'audio environment: a context stuck out of running is reported as "no audio device", not as a page error; a resumable or running one is not';

export async function run({ check }) {
  const browser = await launchBrowser({ prefer: 'software' });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const fake = state => page.evaluate(s => { window.engine = { audio: { ctx: { state: s, resume: async () => { /* a device that never opens */ } } } }; }, state);
    await fake('suspended');
    const stuck = await page.evaluate(audioEnvLine);
    check('stuck suspended: one environment-problem line naming the state', /^environment problem: .*no audio device.*"suspended"/.test(stuck ?? ''), String(stuck));
    await page.evaluate(() => { window.engine.audio.ctx.resume = async function () { this.state = 'running'; }; window.engine.audio.ctx.resume = window.engine.audio.ctx.resume.bind(window.engine.audio.ctx); });
    check('suspended on purpose (resume works): no line', (await page.evaluate(audioEnvLine)) === null);
    await fake('running');
    check('running: no line', (await page.evaluate(audioEnvLine)) === null);
    await page.evaluate(() => { window.engine = {}; });
    check('no audio context at all: no line', (await page.evaluate(audioEnvLine)) === null);
    check('not a page error', errors.length === 0, errors.join(' | '));
  } finally { await browser.close(); }
}
