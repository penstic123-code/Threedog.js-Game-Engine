// A headless Chromium on a busy machine can fail to open an audio output device: the page's AudioContext then never reaches 'running', and every
// sound check fails for a reason that is not the game's. Reported as its own line under a failed test; the test still fails (nothing passes quietly).
/**
 * Page-side (serialized by page.evaluate, so it must not use anything from this module). Returns a line when the page has an audio context that
 * stays out of 'running' even after resume() (a test that suspended it on purpose resumes fine), else null.
 */
export async function audioEnvLine() {
  const ctx = window.engine?.audio?.ctx;
  if (!ctx || ctx.state === 'running') return null;
  await ctx.resume().catch(() => {});
  const end = performance.now() + 3000;
  while (ctx.state !== 'running' && performance.now() < end) await new Promise(r => setTimeout(r, 50));
  return ctx.state === 'running' ? null
    : `environment problem: the headless browser got no audio device (audio context state "${ctx.state}" 3 s after resume()); failed sound checks above come from this, not from the game`;
}
