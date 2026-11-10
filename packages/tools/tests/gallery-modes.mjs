// gallery --mode silhouette|value: the parts that run in node. Why: the facts are what an AI reads instead of the pictures, so a wrong mask or
// percentile would mislead silently; and the material swap touches the game's cached assets, so the restore must be exact.
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { parseModes, parseGalleryOptions, fileStems, escapeHtml, swapMaterials, silhouetteFacts, valueFacts, MODES } from '../gallery/index.js';

export const name = 'gallery review modes: --mode parsing, silhouette / value facts, materials restored after the swap';

const throws = fn => { try { fn(); return ''; } catch (e) { return e.message; } };

/** w×h RGBA picture, white, with a black rectangle [x0,x1)×[y0,y1) */
function picture(w, h, [x0, y0, x1, y1]) {
  const d = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) d.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
  return d;
}

export async function run({ check }) {
  // ── options ──
  check('no --mode: no extra pictures', parseModes(undefined, true).length === 0);
  check('a list, duplicates dropped; the channels are modes too', parseModes('silhouette,value,value,roughness', true).join() === 'silhouette,value,roughness' && MODES.length === 7);
  check('an unknown mode fails naming the known ones', /unknown --mode outline; modes: silhouette, value, albedo, normal, roughness, metalness, ao/.test(throws(() => parseModes('outline', true))));
  check('--mode without --shots fails instead of being ignored', /--mode works with --shots/.test(throws(() => parseModes('value', false))));

  // ── the other options: wrong ones stop; names stay apart on disk and safe in the page ──
  check('--size / --only / --light / --material without --shots fail instead of being ignored', /--size works with --shots/.test(throws(() => parseGalleryOptions({ size: '128' }))) && /--only works with --shots/.test(throws(() => parseGalleryOptions({ only: 'a' })))
    && /--light works with --shots/.test(throws(() => parseGalleryOptions({ light: 'studio' }))) && /--material works with --shots/.test(throws(() => parseGalleryOptions({ material: 'lava' }))) && parseGalleryOptions({ size: '128', shots: true }).modes.length === 0);
  check('--port must be a number', /--port is a port number/.test(throws(() => parseGalleryOptions({ port: 'abc' }))) && parseGalleryOptions({ port: '5181' }).modes.length === 0);
  // ── the look-dev options: a wrong one stops naming the right ones; a right one is passed through as the value shots() takes ──
  const look = parseGalleryOptions({ shots: true, light: 'studio,game,studio', exposure: '1.5', tone: 'agx', material: 'lava' });
  check('--light / --exposure / --tone / --material parse to what shots() takes', look.lights.join() === 'studio,game' && look.exposure === 1.5 && look.tone === 'agx' && look.material === 'lava', JSON.stringify(look));
  check('an unknown --light / --tone, a non-positive --exposure fail naming what is allowed', /unknown --light noon; light setups: midday, lowSun, overcast, studio, game/.test(throws(() => parseGalleryOptions({ shots: true, light: 'noon' })))
    && /unknown --tone filmic; tone mappings: none, linear/.test(throws(() => parseGalleryOptions({ shots: true, tone: 'filmic' }))) && /--exposure is a number above 0/.test(throws(() => parseGalleryOptions({ shots: true, exposure: '0' }))));
  check('no look-dev option: the gallery as before (the three neutral setups, the game\'s tone mapping)', Object.values(parseGalleryOptions({ shots: true })).filter(v => v != null && !(Array.isArray(v) && !v.length)).length === 0);
  const stems = fileStems(['a/b', 'a_b', 'a/b', 'c']);
  check('names that sanitize alike get different file stems; the same name keeps one', stems.get('a/b') === 'a_b' && stems.get('a_b') === 'a_b-2' && stems.get('c') === 'c', JSON.stringify([...stems]));
  const cased = fileStems(['Rock', 'rock']);
  check('[guard] names that differ only by case get different file stems: on Windows and macOS they are one file', cased.get('Rock') === 'Rock' && cased.get('rock') === 'rock-2', JSON.stringify([...cased]));
  check('asset names are escaped in the page', escapeHtml('<b>&"x"</b>') === '&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;');

  const cli = readFileSync(new URL('../gallery.mjs', import.meta.url), 'utf8');
  check('[guard] --shots sets THREEDOG_TEST before the server starts: the vite preset reads it there, set later it does nothing', cli.indexOf('THREEDOG_TEST') > 0 && cli.indexOf('THREEDOG_TEST') < cli.indexOf('devServer('));

  // ── silhouette facts: a 20×10 block in a 100×100 frame ──
  const sil = picture(100, 100, [10, 30, 30, 40]);
  const f = silhouetteFacts(sil, 100, 100);
  check('fill = covered share of the frame, boxFill = share of its own box, aspect = w/h', f.fill === 0.02 && f.boxFill === 1 && f.aspect === 2, JSON.stringify(f));
  check('an empty frame gives zeros (no division by zero)', silhouetteFacts(picture(10, 10, [0, 0, 0, 0]), 10, 10).fill === 0);

  // ── value facts: measured inside the mask only (a white background must not count) ──
  const img = new Uint8ClampedArray(100 * 100 * 4).fill(255);
  for (let y = 30; y < 40; y++) for (let x = 10; x < 30; x++) { const i = (y * 100 + x) * 4, v = x < 20 ? 51 : 204; img[i] = img[i + 1] = img[i + 2] = v; }
  const v = valueFacts(img, sil);
  check('percentiles come from the asset pixels (half 0.2, half 0.8), not the white frame', v.p5 === 0.2 && v.p95 === 0.8, JSON.stringify(v));
  check('without a mask every pixel counts', valueFacts(img, null).p50 === 1);

  // ── the swap returns every original material, arrays included, and disposes the stand-ins ──
  const a = new THREE.MeshStandardMaterial(), b = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
  const root = new THREE.Group(), m1 = new THREE.Mesh(new THREE.BoxGeometry(), a), m2 = new THREE.Mesh(new THREE.BoxGeometry(), b);
  root.add(m1); m1.add(m2); root.add(new THREE.Object3D());
  const made = [];
  const undo = swapMaterials(root, m => { const x = new THREE.MeshBasicMaterial({ side: m.side }); made.push(x); return x; });
  let disposed = 0; for (const x of made) x.addEventListener('dispose', () => disposed++);
  check('during the swap every mesh shows a stand-in', m1.material !== a && m2.material.every(x => !b.includes(x)) && made.length === 3);
  undo();
  check('after it the very same material objects are back and the stand-ins are disposed', m1.material === a && m2.material === b && disposed === 3);
}
