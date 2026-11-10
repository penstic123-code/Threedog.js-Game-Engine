// The picture check's page side. Everything in probe*.mjs runs inside the game page, serialized as text: probeSource joins every exported function of
// those files into one function, so they may call each other and read what they are given (c, from probeTools), and nothing else at module level.
// Renders the current view a few extra times at the canvas size, reads a small copy of each, and restores every value it touched.
// Uses only intensity / time writes (uniforms), a shadow camera's view offset and the debug 'shadow' view, so nothing but the view's one override material recompiles.
import * as setup from './probe-setup.mjs';
import * as scenes from './probe-scene.mjs';
import * as draws from './probe-draws.mjs';
import * as shadows from './probe-shadows.mjs';
import * as lights from './probe-lights.mjs';
import * as times from './probe-time.mjs';

/**
 * @param {any} e @param {{ time?: boolean | 'auto', size?: [number, number], hot?: { channel: number, luma: number } }} [opts] time: also render 12:00
 *   and 00:00 (needs sky; the calendar's time if any; 'auto' = only when calendar and sky both run); hot: HOT of numbers.mjs, passed in because this function
 *   is serialized alone. Returns { pixels: the shot's view as RGBA (base64, size) for pictureNumbers, isDay, params, shadows, lights, time, ms }
 */
async function probePicture(e, { time = 'auto', size = [240, 135], hot = { channel: 240, luma: 0.7 } } = {}) {
  const t0 = performance.now();
  const c = probeTools(e, size, hot);
  probeSettings(c);
  const { out, grab, clipped } = c;
  // a built page holds no three.js for the tools (vite/vite-threedog-three.js): what needs a three class says so, the rest runs
  if (!c.T) out.unread = ['shaders in view', 'transparent draw order', 'camera inside a mesh', 'glowing materials'];
  // the light watch runs in dev and test builds; without it nothing is claimed either way
  const lw = e._tools.lightWatch;
  if (lw) out.lightLayout = { changes: [...lw.changes], last: lw.lights, now: lw.setup() };
  // what the check changes and puts back is not the game's: the "who wrote it" record and the light watch skip it (core/inspect/pictureWriters.js, core/inspect/lightWatch.js).
  // Set here, next to the finally that clears it: what runs above only reads, and a throw there must not leave it on
  e._tools.probing = true;
  try {
    c.base = grab(); c.baseClip = clipped(c.base);
    // the numbers come from this canvas-only copy (no HTML UI on top), so they measure the 3D look, at one fixed size whatever the shot size
    let bin = ''; for (let i = 0; i < c.raw.length; i += 8192) bin += String.fromCharCode.apply(null, c.raw.subarray(i, i + 8192));
    out.pixels = { w: c.W, h: c.H, b64: btoa(bin) };
    probeBudget(c);
    probeBlack(c);
    if (c.T) probeOwnDraws(c);
    probeFog(c);
    probeShadows(c);
    probeKey(c);
    if (c.T) probeCameraInside(c);
    if (c.T) probeFar(c);
    probeLights(c);
    probeTime(c, time);
  } catch (err) { out.error = String(err?.message ?? err); } finally { e._tools.probing = false; e.particles?._relight?.(); }   // lit particle colors back to the restored lights
  out.ms = Math.round(performance.now() - t0);
  return out;
}

/** The probe as text, for page.evaluate(`(${probeSource})(engine, opts)`) or a test page with any engine */
export const probeSource = `async (e, o) => {\n${[probePicture, ...[setup, scenes, draws, shadows, lights, times].flatMap(m => Object.values(m))].join('\n')}\nreturn probePicture(e, o);\n}`;
