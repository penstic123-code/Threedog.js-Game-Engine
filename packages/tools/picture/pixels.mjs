// Reading pixels of a picture file for `picture palette`, `picture compare` and the picture check, and the small pure measures both share.
// Pixels are read in a headless browser (canvas getImageData: every format the browser decodes works, no image library needed).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { launchBrowser, withBrowser } from '../browser.mjs';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' };

/** "x,y,w,h" → { x, y, w, h } (whole pixels of the original picture), or a clear error */
export function parseRegion(text) {
  const v = String(text).split(',').map(s => Number(s.trim()));
  if (v.length !== 4 || v.some(n => !Number.isInteger(n)) || v[2] < 1 || v[3] < 1 || v[0] < 0 || v[1] < 0)
    throw new Error(`--region wants "x,y,w,h" in whole pixels of the original picture (w and h at least 1), got "${text}". In Git Bash write it without a leading slash, e.g. --region 0,120,1080,1600`);
  return { x: v[0], y: v[1], w: v[2], h: v[3] };
}

/**
 * Open a picture. read(region?, { max | size, png }) → { w, h, data: RGBA bytes, png?: Buffer of the region at its original size }.
 * region is in original pixels (default: whole picture); max scales the longest side down to at most max; size: [w, h] stretches to exactly that.
 * Call close() when done.
 */
export async function openImage(file) {
  const path = resolve(file), mime = MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error(`cannot read "${file}": use ${Object.keys(MIME).join(' ')}`);
  let data;
  try { data = readFileSync(path).toString('base64'); } catch { throw new Error(`cannot read "${file}": file not found`); }
  const browser = await launchBrowser(), page = await browser.newPage();
  try {
    const [width, height] = await page.evaluate(async src => {
      const img = new Image();
      img.src = src;
      await img.decode();
      window.__img = img;
      return [img.naturalWidth, img.naturalHeight];
    }, `data:${mime};base64,${data}`);
    return {
      width, height,
      async read(region, { max, size, png } = {}) {
        const r = region ?? { x: 0, y: 0, w: width, h: height };
        if (r.x + r.w > width || r.y + r.h > height) throw new Error(`region ${r.x},${r.y},${r.w},${r.h} is outside "${file}" (${width}×${height})`);
        const out = await page.evaluate(([r, max, size, png]) => {
          const k = size ? 1 : Math.min(1, max / Math.max(r.w, r.h));
          const w = size ? size[0] : Math.max(1, Math.round(r.w * k)), h = size ? size[1] : Math.max(1, Math.round(r.h * k));
          const draw = (cw, ch) => {
            const c = document.createElement('canvas');
            c.width = cw; c.height = ch;
            const g = c.getContext('2d', { willReadFrequently: true });
            g.imageSmoothingQuality = 'high';   // averages detail when scaling down, which is what a whole-picture measure wants
            g.drawImage(window.__img, r.x, r.y, r.w, r.h, 0, 0, cw, ch);
            return [c, g];
          };
          const [, g] = draw(w, h), px = g.getImageData(0, 0, w, h).data;
          let bin = '';
          for (let i = 0; i < px.length; i += 8192) bin += String.fromCharCode.apply(null, px.subarray(i, i + 8192));
          return { w, h, b64: btoa(bin), png: png ? draw(r.w, r.h)[0].toDataURL('image/png').split(',')[1] : null };
        }, [r, max, size, png ?? false]);
        return { w: out.w, h: out.h, data: Buffer.from(out.b64, 'base64'), ...(out.png && { png: Buffer.from(out.png, 'base64') }) };
      },
      close: () => browser.close(),
    };
  } catch (e) { await browser.close(); throw e; }
}

/** [h 0-360, s 0-1, l 0-1] of [r, g, b] 0-255 */
export function hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
export const luma = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
export const hex = ([r, g, b]) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

/** Opaque pixels of RGBA bytes as a flat [r, g, b, ...] (alpha < 128 skipped) */
export function opaque(rgba) {
  const out = [];
  for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3] >= 128) out.push(rgba[i], rgba[i + 1], rgba[i + 2]);
  return out;
}

const FRAME_TOL = 12, FRAME_SHARE = 0.92, FRAME_MIN = 0.03, FRAME_MAX = 0.45;
/**
 * Where a picture's suspected UI frame ends, as fractions to cut from each side: { top, right, bottom, left } (0-1).
 * Rule: a row (column) belongs to the frame when it is next to the frame (or the picture edge) and at least 92% of its pixels are
 * within 12 (per channel) of the single color found on the outermost row (column). A side is cut only when the frame is at least 3% of
 * the picture and never more than 45%. Rows first (over the full width), then columns (over the remaining rows). A flat plain sky or
 * wall touching the edge looks the same as a flat UI frame to this rule: look at the cropped result (`--crop`) before trusting it.
 */
export function uiFrame(rgba, w, h) {
  const at = (x, y) => { const i = (y * w + x) * 4; return [rgba[i], rgba[i + 1], rgba[i + 2]]; };
  const median = list => { const s = [...list].sort((a, b) => a - b); return s[s.length >> 1]; };
  // Walk inward from one side; pixel(n, k) gives the k-th of len pixels of the n-th line in from that side
  const walk = (lines, len, pixel) => {
    const first = [0, 1, 2].map(c => median(Array.from({ length: len }, (_, k) => pixel(0, k)[c])));
    let n = 0;
    for (; n < lines * FRAME_MAX; n++) {
      let ok = 0;
      for (let k = 0; k < len; k++) { const p = pixel(n, k); if (p.every((v, c) => Math.abs(v - first[c]) <= FRAME_TOL)) ok++; }
      if (ok / len < FRAME_SHARE) break;
    }
    return n / lines >= FRAME_MIN ? n : 0;
  };
  const top = walk(h, w, (n, k) => at(k, n)), bottom = walk(h, w, (n, k) => at(k, h - 1 - n));
  const rows = h - top - bottom;
  if (rows < 1) return { top: 0, right: 0, bottom: 0, left: 0 };
  const left = walk(w, rows, (n, k) => at(n, top + k)), right = walk(w, rows, (n, k) => at(w - 1 - n, top + k));
  return { top: top / h, right: right / w, bottom: bottom / h, left: left / w };
}

/** The region left after cutting a frame (fractions of region r) from region r: whole original pixels */
export function shrink(r, f) {
  const x = r.x + Math.round(f.left * r.w), y = r.y + Math.round(f.top * r.h);
  return { x, y, w: Math.max(1, r.w - Math.round((f.left + f.right) * r.w)), h: Math.max(1, r.h - Math.round((f.top + f.bottom) * r.h)) };
}

/**
 * Variance of the Laplacian (4-neighbor kernel 0 1 0 / 1 -4 1 / 0 1 0) of luma 0-255: the usual "how much fine detail / noise / edges"
 * number (OpenCV's blur detector). Higher = more broken-up. Only comparable between pictures read at the same size.
 */
export function laplacianVariance(rgba, w, h) {
  if (w < 3 || h < 3) return 0;
  const y = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) y[i] = 0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2];
  let sum = 0, sq = 0, n = 0;
  for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
    const o = j * w + i, v = y[o - 1] + y[o + 1] + y[o - w] + y[o + w] - 4 * y[o];
    sum += v; sq += v * v; n++;
  }
  return sq / n - (sum / n) ** 2;
}

/**
 * Write one PNG with two RGBA rasters side by side (left a, right b, same height), a thin divider and small labels.
 * Drawn in a headless browser canvas like the reading side (text via fillText, no image library). → { w, h }
 */
export async function writeSideBySide(a, b, labels, file) {
  const GAP = 6, w = a.w + GAP + b.w, h = Math.max(a.h, b.h), b64 = d => d.toString('base64');
  // a library call: a browser that cannot start comes back as an error, the command that called it decides how that ends
  return withBrowser(async ({ launch }) => {
    const page = await (await launch()).newPage();
    const png = await page.evaluate(([A, B, labels, GAP, w, h]) => {
      const un = s => Uint8ClampedArray.from(atob(s), ch => ch.charCodeAt(0));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = '#ff00ff'; g.fillRect(0, 0, w, h);   // magenta divider: no picture is likely to have it, so the seam is obvious
      g.putImageData(new ImageData(un(A.b64), A.w, A.h), 0, 0);
      g.putImageData(new ImageData(un(B.b64), B.w, B.h), A.w + GAP, 0);
      g.font = 'bold 12px sans-serif'; g.textBaseline = 'top';
      [[labels[0], 0], [labels[1], A.w + GAP]].forEach(([t, x]) => {
        const tw = g.measureText(t).width;
        g.fillStyle = 'rgba(0,0,0,0.65)'; g.fillRect(x + 4, 4, tw + 8, 18);
        g.fillStyle = '#fff'; g.fillText(t, x + 8, 7);
      });
      return c.toDataURL('image/png').split(',')[1];
    }, [{ w: a.w, h: a.h, b64: b64(a.data) }, { w: b.w, h: b.h, b64: b64(b.data) }, labels, GAP, w, h]);
    mkdirSync(dirname(resolve(file)), { recursive: true });
    writeFileSync(resolve(file), Buffer.from(png, 'base64'));
    return { w, h };
  });
}
