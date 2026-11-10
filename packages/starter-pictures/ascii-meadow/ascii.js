// @ts-check
// Character layer: the final image is real characters. The frame is cut into square cells; each cell takes the average scene color under it, picks a glyph by its brightness,
// and draws that glyph in a brighter tint of its color over a darker one. It is a plain engine.post effect: remove it and the scene below is untouched.
// Why the average and not one sample at the cell's center: one sample jumps as an edge crosses it, and the whole cell flickers. This is the main shimmer control here.
// Why two neighbor glyphs fade into each other near a change: it softens swaps from slow changes in place, such as water or light. On a camera move it helps only a little.
// The cells stay fixed to the screen, so edges still churn while the camera moves. To stop that for a panning camera, move the camera in whole-cell steps.
// Why ink and background are solved from the glyph's measured coverage: the cell's mean then equals the scene color, so the layer adds texture and does not darken the picture.
import { THREE } from 'threedog';
import { dot, floor, fract, hash, max, min, mix, screenCoordinate, screenSize, smoothstep, texture, uniformArray, vec2, vec3, vec4 } from 'three/tsl';

export const ASCII = {
  on: true,            // false turns the layer off. While running: picture.ascii.enabled = false
  cell: 6,             // cell size in CSS pixels, so it looks the same on a high-DPI screen. Larger reads as text. At 5 only a few shapes stay apart, and at 4 or less glyphs are dots, not characters: there, use a short set like '.:+x#'.
  glyphs: '.,:;-~+=*oxe%#&@',   // any characters. Their order here does not matter: they are measured and sorted when the atlas is drawn.
  background: 0.3,     // how far ink and background stand apart: this, not the cell, sets how strong the texture reads. A smaller cell alone makes it stronger, because more glyph edges fit in the same area. 0 leaves flat cells.
  range: [0.12, 0.8],  // cell brightness that maps to the first and last glyph: move these to the scene's real dark and light
  inkPale: 0.4,        // how much color the ink gives up: bright strokes read paler than the cell, and brightness stays put. 0 keeps the ink the cell's exact hue and strength.
  variety: 5,          // glyph steps of fixed random offset per cell, so a flat area uses many glyphs and does not read as a mesh. It changes the shape, not the brightness: the ink is solved per glyph.
  font: '{px}px ui-monospace, Consolas, Menlo, "DejaVu Sans Mono", monospace',   // regular weight: at this size bold fills the cell, and the dark gaps left between cells draw a grid
  fontScale: 1,        // glyph size against the cell
  fade: 0.2,           // part of a brightness step spent fading between two glyphs. 0 swaps hard, 0.5 blurs every cell.
};
const LUMA = vec3(0.2126, 0.7152, 0.0722);
const MAX_TAPS = 4;    // samples per cell side at most. Linear filtering averages 2x2 pixels per tap, so half the cell's pixels covers it exactly; a cell over 8 device pixels is sampled more thinly.

/** Draws every glyph into one row of square tiles, sorted by measured ink. The atlas is drawn at the cell's exact pixel size and read with nearest filtering, so one atlas pixel
 *  is one screen pixel, and the coverage measured here is exactly the coverage on screen.
 *  @param {number} px tile size in device pixels */
function makeAtlas(px) {
  const glyphs = [...new Set(ASCII.glyphs)], canvas = document.createElement('canvas');
  canvas.width = px * glyphs.length; canvas.height = px;
  const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
  g.font = ASCII.font.replace('{px}', String(px * ASCII.fontScale));
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff';
  const draw = (/** @type {string} */ ch, /** @type {number} */ i) => {
    // clipped to its tile, so a wide glyph cannot leak into its neighbor and be counted twice
    g.save(); g.beginPath(); g.rect(i * px, 0, px, px); g.clip();
    g.fillText(ch, (i + 0.5) * px, px * 0.54);
    g.restore();
  };
  const inkOf = (/** @type {number} */ i) => {
    const { data } = g.getImageData(i * px, 0, px, px);
    let sum = 0;
    for (let k = 3; k < data.length; k += 4) sum += data[k];
    return sum / 255 / (px * px);
  };
  const ranked = glyphs.map((ch, i) => { draw(ch, i); return { ch, ink: inkOf(i) }; }).sort((a, b) => a.ink - b.ink);
  g.clearRect(0, 0, canvas.width, canvas.height);
  ranked.forEach((r, i) => draw(r.ch, i));
  const map = new THREE.CanvasTexture(canvas);
  map.magFilter = map.minFilter = THREE.NearestFilter;
  map.generateMipmaps = false; map.flipY = false; map.colorSpace = THREE.NoColorSpace;
  return { map, count: glyphs.length, ink: ranked.map(r => r.ink), order: ranked.map(r => r.ch).join('') };
}

/** The effect for engine.post.add. Cell size in device pixels is a param, so a pixel-ratio change rebuilds the atlas through handle.set({ cellPx }).
 *  @param {number} cellPx */
function effect(cellPx) {
  /** @type {any} */ let atlas = null;
  return {
    name: 'ascii', slot: 'final', enabled: ASCII.on, params: { cellPx },
    /** @param {any} input the finished picture, display color @param {any} ctx */
    node(input, ctx) {
      const px = ctx.params.cellPx;
      // the post stage disposes what ctx.display.own() holds when this node graph is torn down; a dispose() on the effect definition is never called
      const mine = atlas = makeAtlas(px);
      ctx.display.own({ dispose() { mine.map.dispose(); if (atlas === mine) atlas = null; } });
      const frame = ctx.display.texture(input), inkAt = uniformArray(atlas.ink, 'float'), n = atlas.count;

      const cellPos = screenCoordinate.xy.div(px), cell = floor(cellPos), inCell = fract(cellPos);
      const taps = Math.min(MAX_TAPS, Math.ceil(px / 2));
      /** @type {any} */ let sum = vec3(0);
      for (let y = 0; y < taps; y++) for (let x = 0; x < taps; x++) {
        sum = sum.add(frame.sample(cell.add(vec2((x + 0.5) / taps, (y + 0.5) / taps)).mul(px).div(screenSize)).rgb);
      }
      const col = sum.div(taps * taps);

      const [lo, hi] = ASCII.range;
      // the offset belongs to the cell, not to the frame, so it holds still while the picture moves under it
      const jitter = hash(cell.x.add(cell.y.mul(4099))).sub(0.5).mul(ASCII.variety);
      const level = dot(col, LUMA).sub(lo).div(hi - lo).mul(n - 1).add(jitter).clamp(0, n - 1.001);
      const first = floor(level), next = first.add(1), half = ASCII.fade / 2;
      const blend = smoothstep(0.5 - half - 1e-3, 0.5 + half + 1e-3, level.sub(first));
      const tile = (/** @type {any} */ i) => texture(atlas.map, vec2(i.add(inCell.x).div(n), inCell.y)).a;
      const ink = mix(tile(first), tile(next), blend);
      const cover = /** @type {any} */ (mix(/** @type {any} */ (inkAt.element(first.toInt())), /** @type {any} */ (inkAt.element(next.toInt())), blend));

      // cover * glyph + (1 - cover) * background = col, for any strength. The cap keeps the ink under 1, because a clipped channel would shift the hue and lose the mean
      const peak = max(max(col.r, col.g), max(col.b, 1e-3));
      const strength = min(ASCII.background, peak.reciprocal().sub(1).div(cover.oneMinus().max(1e-3)));
      const glyph = col.mul(cover.oneMinus().mul(strength).add(1)), behind = col.mul(cover.mul(strength).oneMinus());
      return vec4(mix(behind, mix(glyph, vec3(dot(glyph, LUMA)), ASCII.inkPale), ink), 1);
    },
    facts: () => atlas && { glyphs: atlas.order },
  };
}

/** Adds the layer. Returns its post handle: handle.enabled = false turns it off. @param {any} engine @param {any} ctx the picture module's ctx */
export function createAscii(engine, ctx) {
  const cellPx = () => Math.max(2, Math.round(ASCII.cell * engine.renderer.getPixelRatio()));
  let px = cellPx();
  const handle = ctx.track(engine.post.add(effect(px)));
  // the pixel ratio can change at run time: quality settings, or a window dragged to another screen
  ctx.track(engine.onRender(() => { const now = cellPx(); if (now !== px) { px = now; handle.set({ cellPx: px }); } }));
  return handle;
}
