// shot's picture hints (picture/check.mjs), node side: intent is judged only against what DESIGN.md declares, on pixels of generated pictures.
// A soft picture under low-contrast gets no intent hint, the same picture under high-contrast does; no Picture intent words = numbers only (the table is never read);
// night-only words do not judge a noon shot. Clipped, near-black, glare and a night not dark from lighting are facts unless DESIGN.md
// declares the opposite on the "Picture intent:" line; shot, snap and shot --image share one checker.
import { pictureNumbers, pictureHints, readIntent, formatPicture, imagePicture, shadowEdges, probeSource } from '../picture/check.mjs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TOOLS } from '../paths.mjs';
import { png } from './picture-tools.mjs';

export const name = 'picture hints: intent from DESIGN.md, pixel contradictions and glare facts (shot, snap, shot --image)';

const design = words => `# g: design\n\n## Loved / Not for this game\n- Not for this game: glaring lamps, pitch black\n\n## Picture and controls\nPicture intent (optional): ${words}\n\n| Item | Choice | Options (engine name) |\n|---|---|---|\n| Style | dark, high contrast, no glare | the game's own style/ |\n| Post effects | (not chosen) | none · bloom (soft glow) |\n\n## Systems\n`;
/** w×h RGBA where color(x, y) gives [r, g, b] */
const rgba = (w, h, color) => { const d = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([...color(x, y), 255], (y * w + x) * 4); return d; };

export async function run({ check }) {
  // soft: a gentle gradient of warm mid tones (low contrast)
  const soft = pictureNumbers(rgba(64, 36, (x) => { const v = 120 + Math.round(x / 63 * 40); return [v + 10, v, v - 10]; }));
  check('soft picture: low contrast measured', soft.contrast < 0.1 && soft.range < 0.2, JSON.stringify(soft));
  const intentOf = text => pictureHints({ numbers: soft, intent: readIntent(design(text)), isDay: true }).filter(h => h.kind === 'intent');
  check('low-contrast with a soft picture: no intent hint', intentOf('low-contrast').length === 0, JSON.stringify(intentOf('low-contrast')));
  const hi = intentOf('high-contrast');
  check('high-contrast with the same picture: an intent hint quoting the word, the measure and levers, no target value',
    hi.length === 1 && /differs from DESIGN\.md: you wrote 'high-contrast'/.test(hi[0].text) && /measured contrast/.test(hi[0].text) && /levers:/.test(hi[0].text) && !/should|target/.test(hi[0].text), JSON.stringify(hi));
  // one mechanism: only the Picture intent line declares; the table's and "Not for this game"'s free words are never read
  check('no Picture intent words ("(none)", or no line) -> no declaration, whatever the table and Not-for list say',
    readIntent('Picture intent:\n\nThe mood is calm').length === 0 && readIntent('Picture intent: (none yet)').length === 0 && readIntent('- **Picture intent:** dark')[0]?.want === 'dark' &&
    readIntent(design('(none)')).length === 0 && readIntent(design('').replace(/Picture intent.*\n/, '')).length === 0
    && pictureHints({ numbers: soft, intent: readIntent(design('(none)')) }).length === 0);
  check('words separated by commas or spaces, any case', readIntent(design('Bright  muted,strong-light')).map(a => a.want).join() === 'bright,muted,strongLight');
  check('night-only words do not judge a noon shot', intentOf('dark-nights').length === 0 && readIntent(design('dark-nights'))[0]?.when === 'night');
  // pictures that are mostly clipped / crushed: facts with the value that sets them (a game may want them); a contradiction only under the wish
  const white = pictureNumbers(rgba(20, 20, (x) => (x < 16 ? [255, 255, 255] : [90, 90, 90]))), black = pictureNumbers(rgba(20, 20, (x) => (x < 12 ? [0, 0, 0] : [90, 90, 90])));
  const expo = { params: { exposure: { name: 'renderer.toneMappingExposure', value: 1.4 } } };
  const hOf = (n, intent) => pictureHints({ numbers: n, probe: expo, intent });
  const kindOf = (n, id, intent) => hOf(n, intent).find(h => h.id === id)?.kind;
  check('mostly white -> clipped, mostly black -> crushed: facts naming the exposure value, no verdict', kindOf(white, 'clipped') === 'fact' && kindOf(black, 'crushed') === 'fact'
    && /renderer\.toneMappingExposure 1\.4/.test(hOf(white)[0].text) && !/likely cause|should|too /i.test(hOf(white)[0].text + hOf(black)[0].text));
  // the optional "Picture intent:" line: listed words, read before the table; a word it does not know is reported, never guessed
  const lineDesign = design;
  check('Picture intent line: no-glare / no-pitch-black turn clipped / crushed into contradictions quoting the line',
    kindOf(white, 'clipped', readIntent(lineDesign('no-glare'))) === 'contradiction' && kindOf(black, 'crushed', readIntent(lineDesign('no-pitch-black'))) === 'contradiction'
    && /you wrote 'no-glare' \(Picture intent\)/.test(hOf(white, readIntent(lineDesign('no-glare')))[0].text));
  check('Picture intent line: each word maps to one wish, night words carry when: night',
    readIntent(lineDesign('dark-nights, strong-light')).map(a => `${a.want}/${a.when}`).join() === 'dark/night,strongLight/null');
  const unk = pictureHints({ numbers: soft, intent: readIntent(lineDesign('no-glare, moody-ish')) }).find(h => h.id === 'intent-word');
  check('Picture intent line: an unknown word is a fact listing the words read', unk?.kind === 'fact' && /'moody-ish'/.test(unk.text) && /no-pitch-black/.test(unk.text), JSON.stringify(unk));
  check('a plain mid-gray picture -> no hint at all', pictureHints({ numbers: pictureNumbers(rgba(8, 8, () => [128, 128, 128])) }).length === 0);

  // ── round-2 demo fixes ──
  // warm blow-out (255, 240, 200) counts as clipped; a saturated pure red does not; small near-white spots are counted
  const warm = pictureNumbers(rgba(20, 20, (x) => (x < 16 ? [255, 240, 200] : [90, 90, 90])), 20), red = pictureNumbers(rgba(20, 20, () => [255, 0, 0]), 20);
  check('warm clipping (255,240,200) is overexposed; pure red is not', warm.overexposed >= 0.75 && red.overexposed === 0, `${warm.overexposed} ${red.overexposed}`);
  const dots = pictureNumbers(rgba(40, 20, (x, y) => ((x % 10 < 2 && y % 10 < 2) ? [250, 236, 210] : [40, 40, 50])), 40);
  check('three 2x2 near-white dots in a dark picture: tiny share, but counted as spots', dots.hotspots === 8 && dots.overexposed < 0.05, JSON.stringify(dots));
  const P = { exposure: { name: 'renderer.toneMappingExposure', value: 1 }, toneMapping: { name: 'renderer.toneMapping', value: 'aces' } };
  const glare = pictureHints({ numbers: dots, probe: { params: P, glare: { clipped: 0.04, bloom: { enabled: true, strength: 0.35, threshold: 0.85, radius: 0.5 }, sources: [
    { kind: 'light', name: 'lightPool_point_0', type: 'PointLight', intensity: 30, distance: 14, decay: 2, toCamera: 4.8, clipped: 0.01, halo: 0.02 },
    { kind: 'material', name: 'lampglow', meshes: 3, emissive: '#ffc46b', emissiveIntensity: 3.5, clipped: 0.005, halo: 0 }] } } }).find(h => h.id === 'glare');
  check('glare names the light and the glowing material with their current values, exposure / tone mapping / bloom, and no target value',
    !!glare && /lightPool_point_0 \(PointLight\).*intensity 30, distance 14, decay 2/.test(glare.text) && /material 'lampglow'.*emissive #ffc46b x emissiveIntensity 3\.5/.test(glare.text)
    && /renderer\.toneMappingExposure 1/.test(glare.text) && /bloom strength 0\.35, threshold 0\.85/.test(glare.text) && !/should|target|lower it|try /i.test(glare.text), glare?.text);
  check('no glare sources (a bright day: sky near white, no light or material to blame) -> no glare hint',
    !pictureHints({ numbers: dots, probe: { params: P, glare: { clipped: 0.04, sources: [] } } }).some(h => h.id === 'glare'));
  const sh = { casters: 9, receivers: 9, sunLit: true, area: 0, intensity: 1, mask: { area: 0.02 } };
  // time: the game's own street lamps make midnight as bright as noon -> no contradiction when the rest follows the time
  const tAt = { noon: {}, midnight: {} };
  const lamps = { noon: 0.4, midnight: 0.38, base: { noon: 0.4, midnight: 0.15 }, driven: ['lightPool_point_0'], unlit: 0.02, at: tAt };
  check('time: lamps the game switches on at night do not count as "lighting does not follow the time"', !pictureHints({ numbers: soft, probe: { params: {}, time: lamps } }).some(h => h.id === 'time-flat'));
  const flatT = intent => pictureHints({ numbers: soft, probe: { params: {}, time: { ...lamps, base: { noon: 0.4, midnight: 0.37 } } }, intent }).find(h => h.id === 'time-flat');
  check('time: flat without the game\'s lamps too -> a fact naming the lamps taken out; a contradiction only under DESIGN.md dark nights',
    /without the 1 light\(s\) the game switches with the time \(lightPool_point_0\)/.test(flatT()?.text) && flatT()?.kind === 'fact'
    && flatT(readIntent(design('dark-nights')))?.kind === 'contradiction' && flatT(readIntent(design('bright-nights')))?.kind === 'fact');
  // round-1 demo: noon clearly brighter, but the night stays bright with every light off (gray background, lit windows) -> still reported
  const r1 = pictureHints({ numbers: soft, probe: { params: {}, time: { noon: 0.49, midnight: 0.41, base: { noon: 0.49, midnight: 0.4 }, driven: ['lightPool_point_0'], unlit: 0.28,
    glow: [{ name: "material 'window' emissiveIntensity", value: 1.75 }], at: { noon: {}, midnight: { background: { name: 'scene.background', value: '#8c8c8c' } } } } } }).find(h => h.id === 'time-flat');
  check('time: a night lit by what is not lighting is reported even when noon is brighter, naming the time-switched glow', /not lighting/.test(r1?.text) && /window' emissiveIntensity 1\.75/.test(r1?.text), r1?.text);
  // a lamp at dusk outshone by the sun is no "light changes no pixel"
  const lamp = { name: 'lightPool_point_6', type: 'PointLight', intensity: 9, distance: 14, decay: 2, toCamera: 6, changed: false, layers: 1, cameraLayers: 1 };
  check('light-no-effect: not when the light shows once the sun / fill are dimmed (outshone); still when it does not',
    !pictureHints({ numbers: soft, probe: { params: {}, lights: [{ ...lamp, outshone: true }] } }).some(h => h.id === 'light-no-effect')
    && pictureHints({ numbers: soft, probe: { params: {}, lights: [{ ...lamp, outshone: false }] } }).some(h => h.id === 'light-no-effect'));
  // both times black: only the black frame is the fact (crushed), not a "brightness is not lighting" time-flat; unknown day/night skips day/night words
  const allBlack = pictureNumbers(rgba(64, 36, () => [0, 0, 0]));
  const blackT = { noon: 0, midnight: 0, unlit: 0, at: tAt };
  const bh = pictureHints({ numbers: allBlack, probe: { params: {}, time: blackT }, isDay: true });
  check('time: noon and midnight both fully black -> the black frame reported once (crushed), no time-flat', bh.filter(h => h.id === 'crushed').length === 1 && !bh.some(h => h.id === 'time-flat'), JSON.stringify(bh));
  const nightWords = readIntent(design('dark-nights'));
  const bright = pictureNumbers(rgba(64, 36, () => [235, 235, 235]));
  const nightIntent = isDay => pictureHints({ numbers: bright, intent: nightWords, isDay }).filter(h => h.kind === 'intent').length;
  check('intent: day/night words are skipped when isDay is unknown (no sky), still judged at night', nightIntent(null) === 0 && nightIntent(false) === 1, `${nightIntent(null)} / ${nightIntent(false)}`);

  // ── round 3: glare is a fact with its cost; a contradiction only against DESIGN.md; the check reaches every way a picture is taken ──
  const gProbe = { params: P, glare: { clipped: 0.04, sources: [{ kind: 'material', name: 'sign', meshes: 1, emissive: '#ffe6c0', emissiveIntensity: 2.2, clipped: 0.01, halo: 0,
    detail: { on: 0.01, off: 0.08 } }] } };
  const gFact = pictureHints({ numbers: dots, probe: gProbe }).find(h => h.id === 'glare');
  check('glare without a DESIGN.md wish is a "fact", naming the detail lost under it (on vs off), no target value',
    gFact?.kind === 'fact' && /luma edge 0\.01 on, 0\.08 off\) 88% lost/.test(gFact.text) && !/should|target|lower it|try /i.test(gFact.text), JSON.stringify(gFact));
  const gNo = pictureHints({ numbers: dots, probe: gProbe, intent: readIntent(design('no-glare')) }).find(h => h.id === 'glare');
  check('glare under Picture intent no-glare is a contradiction quoting it', gNo?.kind === 'contradiction' && /you wrote 'no-glare' \(Picture intent\)/.test(gNo.text), JSON.stringify(gNo));
  const flat = pictureHints({ numbers: dots, probe: { ...gProbe, glare: { ...gProbe.glare, sources: [{ ...gProbe.glare.sources[0], detail: { on: 0, off: 0.002 } }] } } }).find(h => h.id === 'glare');
  check('glare over a flat area says no detail was lost', /flat area underneath \(no detail lost\)/.test(flat?.text), flat?.text);
  const pix = pictureHints({ numbers: dots });
  check('no page (a saved picture): near-white spots are a fact that says the source needs the running page (shot / snap)',
    pix.some(h => h.id === 'hotspots' && h.kind === 'fact' && /threedog shot or threedog snap/.test(h.text)), JSON.stringify(pix));
  check('formatPicture labels each hint with its kind and keeps the closing "not targets" line; no "shadows off" without a probe',
    (() => { const t = formatPicture(dots, null, pix, null).join('\n'); return /\n {2}fact: /.test(t) && /not targets: change what the game wants, or nothing/.test(t) && !/shadows/.test(t); })());
  // ── round 4: key / fill balance, camera inside a mesh, the exposure curve next to noon / midnight, a short printed block ──
  const LP = { sun: { name: 'engine.lights.sun intensity', value: 1.2 }, hemi: { name: 'engine.lights.hemi intensity', value: 2.5 } };
  const flatDay = { params: LP, key: { base: 0.6, noKey: 0.55, noFill: 0.2, body: 'sun' }, shadows: { casters: 4, receivers: 4, sunLit: true, area: 0.08, depth: 0.12, intensity: 1 } };
  const lb = pictureHints({ numbers: soft, probe: flatDay, isDay: true }).find(h => h.id === 'light-balance');
  check('light-balance: a fact naming the key / fill shares, how much darker the shadows are and the parameters with values, no target',
    lb?.kind === 'fact' && /sun \/ key gives 11% of the lit brightness, the fill 89%/.test(lb.text) && /shadowed areas are 12\.0% darker/.test(lb.text)
    && /engine\.lights\.sun intensity 1\.2; fill engine\.lights\.hemi intensity 2\.5/.test(lb.text) && !/should|target/.test(lb.text), JSON.stringify(lb));
  const lbStrong = pictureHints({ numbers: soft, probe: flatDay, isDay: true, intent: readIntent(design('strong-light')) }).find(h => h.id === 'light-balance');
  const lbStrongOk = pictureHints({ numbers: soft, probe: { ...flatDay, key: { base: 0.6, noKey: 0.15, noFill: 0.5 }, shadows: { ...flatDay.shadows, depth: 0.45 } }, isDay: true,
    intent: readIntent(design('strong-light')) }).find(h => h.id === 'light-balance');
  check('light-balance: a contradiction only under a DESIGN.md strong-light the numbers do not show',
    lbStrong?.kind === 'contradiction' && /you wrote 'strong-light'/.test(lbStrong.text) && lbStrongOk?.kind === 'fact', JSON.stringify([lbStrong, lbStrongOk]));
  const farH = pictureHints({ numbers: soft, probe: { params: {}, far: { far: 1500, beyond: 12, total: 40, nearest: 1800, fogFar: 2600 } } }).find(h => h.id === 'far-clip');
  check('far-clip: a fact with the counts, the plane and the fog, naming the documented way, no target', farH?.kind === 'fact' && /12 of 40 visible meshes/.test(farH.text) && /camera\.far \(1500 m/.test(farH.text) && /scene\.fog far \(2600 m\)/.test(farH.text) && /autoView\.manual\('far'\)/.test(farH.text) && !/should|target/.test(farH.text), JSON.stringify(farH));
  check('far-clip: nothing beyond the plane (no probe field) -> no hint', !pictureHints({ numbers: soft, probe: { params: {} } }).some(h => h.id === 'far-clip'));
  const inside = pictureHints({ numbers: soft, probe: { params: {}, cameraInside: { name: 'house_walls', camera: [3, 1.6, -2] } } }).find(h => h.id === 'camera-inside');
  check('camera-inside: a fact naming the mesh and the camera position', inside?.kind === 'fact' && /inside mesh 'house_walls'/.test(inside.text) && /\(3, 1\.6, -2\)/.test(inside.text), JSON.stringify(inside));
  const tEx = (en, em) => formatPicture(soft, { params: {}, time: { noon: 0.64, midnight: 0.22, at: { noon: { exposure: { value: en } }, midnight: { exposure: { value: em } } } } }, [], null)[0];
  check('noon / midnight print each exposure only when the two differ (an exposure curve over the day)',
    /noon 0\.64 \(exposure 0\.95\) \/ midnight 0\.22 \(exposure 1\.35\)/.test(tEx(0.95, 1.35)) && /noon 0\.64 \/ midnight 0\.22/.test(tEx(1, 1)), tEx(0.95, 1.35));
  // [guard] a busy scene (clipped, glare from 5 sources, flat time with a long post list, 3 dead lights, key / fill, camera inside) prints a short
  // block: numbers + at most 4 hint lines (the last "N more") + the closing line, each line within the budget; --json (pictureHints) keeps them all
  const busyP = { ...P, ...LP, post: { name: 'engine.post', value: Array.from({ length: 17 }, (_, i) => `pass${i}`).join(' ') } };
  const busy = { params: busyP, key: flatDay.key, shadows: flatDay.shadows, cameraInside: { name: 'tower', camera: [1, 2, 3] },
    lights: [0, 1, 2].map(i => ({ ...lamp, name: `deadLamp${i}`, outshone: false })),
    time: { noon: 0.5, midnight: 0.47, unlit: 0.4, glow: Array.from({ length: 6 }, (_, i) => ({ name: `material 'w${i}' emissiveIntensity`, value: 2 })), at: { noon: {}, midnight: { background: { name: 'scene.background', value: '#8c8c8c' } } } },
    glare: { clipped: 0.12, sources: Array.from({ length: 5 }, (_, i) => ({ kind: 'light', name: `lightPool_point_${i}`, type: 'PointLight', intensity: 40, distance: 14, decay: 2, toCamera: 5, clipped: 0.02, halo: 0.01, detail: { on: 0.02, off: 0.09 } })) } };
  const busyH = pictureHints({ numbers: white, probe: busy, isDay: false });
  const block = formatPicture(white, busy, busyH, 300), hintLines = block.slice(1, -1);
  check('[guard] busy scene: the printed picture block is ≤ 6 lines and every hint line ≤ 220 characters; a "N more: threedog shot --json" line counts the rest',
    block.length <= 6 && hintLines.every(l => l.length <= 220) && /^ {2}\d+ more: threedog shot --json \(picture.hints\)$/.test(hintLines.at(-1)) && /not targets/.test(block.at(-1)),
    block.map(l => `${l.length}: ${l.slice(0, 90)}`).join(' | '));
  check('[guard] busy scene: pictureHints (what --json prints) keeps every hint with its full text; contradictions are printed first',
    busyH.length >= 7 && ['clipped', 'glare', 'time-flat', 'light-no-effect', 'light-balance', 'camera-inside'].every(id => busyH.some(h => h.id === id))
    && busyH.find(h => h.id === 'glare').text.includes('lightPool_point_4') && /^ {2}contradiction: /.test(hintLines[0]), JSON.stringify(busyH.map(h => h.id)));
  // ── the check points the way: a measured problem names the engine feature and one line of its real API, and that line survives the printed block ──
  const printed = (probe, hints) => formatPicture(soft, probe, hints, null).join('\n');
  const texel = split => ({ params: { extent: { name: 'engine.lights.sun shadow camera half width', value: 70 }, mapSize: { name: 'engine.lights.sun shadow.mapSize', value: 512 } },
    shadows: { casters: 9, receivers: 9, sunLit: true, area: 0, intensity: 1, texel: 0.8, split } });
  const tx = split => pictureHints({ numbers: soft, probe: texel(split) }).find(h => h.id === 'shadow-invisible');
  check('[guard] one shadow texel covers X m: the engine sun gets engine.shadows.cascades(engine.lights.sun, { count: 3 }), a game light engine.shadows.cascades(light, { count: 3 }), already-split shadows nothing; printed too',
    /large scene: engine\.shadows\.cascades\(engine\.lights\.sun, \{ count: 3 \}\)/.test(tx('engine').text) && /large scene: engine\.shadows\.cascades\(light, \{ count: 3 \}\)/.test(tx('own').text)
    && !/cascade/.test(tx(null).text) && /engine[.]shadows[.]cascades[(]engine[.]lights[.]sun, [{] count: 3 [}][)]/.test(printed(texel('engine'), [tx('engine')])) && /engine\.shadows\.cascades\(light, \{ count: 3 \}\) \(recipe 45\)/.test(printed(texel('own'), [tx('own')])), tx('own').text);
  const bud = (o, pool = false) => ({ params: {}, budget: { tier: 'low', pool, casters: [{ name: 'my-lamp', type: 'PointLight', size: 2048 }], over: [o] } });
  const ob = (o, pool) => pictureHints({ numbers: soft, probe: bud(o, pool) }).filter(h => h.id === 'over-budget');
  const dflt = ob({ category: 'lights', value: 12, limit: 8, own: false }), mine = ob({ category: 'lights', value: 12, limit: 6, own: true });
  check('[guard] over budget: the engine\'s default line is a fact, a limit the game wrote is intent; value, limit and tier are named; lightPool is quoted in the printed line',
    dflt[0]?.kind === 'fact' && mine[0]?.kind === 'intent' && /12 real point \/ spot lights lit, over the engine's default guide 8/.test(dflt[0].text) && /your engine\.budget limit 6/.test(mine[0].text) && /tier low/.test(dflt[0].text)
    && /engine\.use\(lightPool\(\{ point: 8 \}\)\) then engine\.lightPool\.add\(torch/.test(printed(bud({}), dflt)), JSON.stringify(dflt));
  check('over budget: with lightPool installed the hint does not say to install it',
    !/engine\.use\(lightPool/.test(ob({ category: 'lights', value: 12, limit: 8 }, true)[0].text));
  const maps = ob({ category: 'shadowMaps', value: 13, limit: 4, own: true })[0], size = ob({ category: 'shadowMapSize', value: 4096, limit: 1024, own: true })[0];
  check('[guard] shadow maps and map size over budget name the casting light with its size and the three.js field to change',
    /13 shadow maps drawn/.test(maps?.text) && /castShadow = false/.test(maps.text) && /my-lamp \(PointLight, 2048\)/.test(maps.text) && /light\.shadow\.mapSize from engine\.tier/.test(size?.text), JSON.stringify([maps, size]));
  const deep = (depth, fill) => ({ params: {}, shadows: { casters: 4, receivers: 4, sunLit: true, area: 0.2, depth, intensity: 1, dark: { luma: 0.01, fill } } });
  const sb = p => pictureHints({ numbers: soft, probe: p }).find(h => h.id === 'shadow-black');
  check('[guard] near-black shadows with almost no fill: a fact pointing to engine.bakeProbes or a fill light, also in the printed line; not with fill there, not with shallow shadows',
    sb(deep(0.95, 0.01))?.kind === 'fact' && /no hemisphere, ambient or environment light/.test(sb(deep(0.95, 0.01)).text)
    && /engine\.bakeProbes\(\{ bounds, spacing: 4 \}\).*HemisphereLight/.test(printed(deep(0.95, 0.01), [sb(deep(0.95, 0.01))])) && !sb(deep(0.95, 0.3)) && !sb(deep(0.5, 0.01)));
  // shadowEdges reads the mask only: bands are stripes; one band, a clean diagonal and a solid shadow are not, and pixels that can show no shadow split nothing
  const mask = (w, h, f) => { const m = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = f(x, y) ? 1 : 0; return m; };
  const E = f => shadowEdges(mask(256, 128, f), 256, 128);
  const acne = E((x, y) => y % 4 < 2), solid = E(x => x < 100), smooth = E((x, y) => x < y * 1.3 + 20), beam = E((x, y) => y % 16 >= 6 && y % 16 < 10);
  const cracks = shadowEdges(Uint8Array.from({ length: 256 * 128 }, (_, i) => (i % 256) % 4 < 2 ? 2 : 1), 256, 128);
  check('[guard] shadowEdges: bands read as stripes; a solid shadow, a smooth slanted edge and one thin shadow read as nothing; so do unread lines through a shadow',
    acne.stripes === 1 && solid.stripes === 0 && smooth.stripes === 0 && beam.stripes === 0 && cracks.stripes === 0, JSON.stringify({ acne, solid, smooth, beam, cracks }));
  const edgeProbe = edges => ({ params: {}, shadows: { casters: 4, receivers: 4, sunLit: true, area: 0.2, depth: 0.4, intensity: 1, texel: 0.5, depthRange: 200, split: 'own', edges,
    settings: [{ name: 'DirectionalLight shadow.bias', value: -0.00005 }, { name: 'DirectionalLight shadow.mapSize', value: 512 }, { name: 'DirectionalLight shadow camera half width', value: 60 }] } });
  const edgeH = edges => pictureHints({ numbers: soft, probe: edgeProbe(edges) });
  const def = dflt[0];
  check('[guard] over a default budget: the line says why the number exists and that nothing is cut at it', /adds work per lit pixel/.test(def?.text) && /nothing is cut/.test(def?.text) && /a guide: each adds work/.test(def?.brief), JSON.stringify(def));
  // a picture that changes by itself (moving film grain): 92% "stripes" on a picture with none. The stripe lines give way to one saying so
  const noisy = pictureHints({ numbers: soft, probe: { ...edgeProbe({ stripes: 0.9, jag: 0.5 }), shadows: { ...edgeProbe({ stripes: 0.9, jag: 0.5 }).shadows, edgeNoise: 0.5 } } });
  check('[guard] edges of a picture that moves by itself are not read: no stripes line, one line saying why', !noisy.some(h => /shadow-(stripes|jag)/.test(h.id)) && noisy.some(h => h.id === 'shadow-edges-unread' && /50\.0%/.test(h.text)), JSON.stringify(noisy.map(h => h.id)));
  const st = edgeH({ stripes: 0.2, jag: 0 }).find(h => h.id === 'shadow-stripes'), jg = edgeH({ stripes: 0, jag: 0.2 }).find(h => h.id === 'shadow-jag');
  check('[guard] stripes and stepped edges: facts with the share of the picture, bias, map size and shadow range; a clean shadow has neither line',
    st?.kind === 'fact' && jg?.kind === 'fact' && /20\.0% of the picture/.test(st.text) && /shadow\.bias -0\.00005/.test(st.text) && /shadow\.mapSize 512/.test(jg.text) && /half width 60/.test(jg.text) && /depth range 200 m/.test(st.text)
    && !edgeH({ stripes: 0, jag: 0 }).some(h => /shadow-(stripes|jag)/.test(h.id)), JSON.stringify([st, jg]));
  // fog with time-flat: the fog line comes first and the time line says so, even though a contradiction ranks above a fact
  const fogT = { params: {}, fog: { share: 0.6, color: '#101820', setting: 'near 1 far 14' }, time: { noon: 0.3, midnight: 0.28, unlit: 0.26, at: { noon: {}, midnight: {} } } };
  const fogH = pictureHints({ numbers: soft, probe: fogT, intent: readIntent(design('dark-nights')) }), fogLines = formatPicture(soft, fogT, fogH, null);
  const lineOf = re => fogLines.findIndex(l => re.test(l));
  check('[guard] fog over a large share is printed before "brightness stays with the lights off", and that line names the fog first',
    fogH.find(h => h.id === 'time-flat')?.kind === 'contradiction' && lineOf(/fog covers/) > 0 && lineOf(/fog covers/) < lineOf(/time barely|not dark from lighting/) && /the fog first \(it covers 60\.0%/.test(fogLines.join('\n')), fogLines.join(' | '));
  check('time-flat says it is the calendar time that was varied, and that lights switched by the game own presets are not moved by it', /engine\.calendar\.timeOfDay to 12:00 and 00:00/.test(fogH.find(h => h.id === 'time-flat')?.text ?? '') && /your own presets/.test(fogH.find(h => h.id === 'time-flat')?.text ?? ''));
  const thin = pictureHints({ numbers: soft, probe: { ...fogT, fog: { ...fogT.fog, share: 0.1 } } });
  check('a little fog changes neither the time line nor the order', !thin.some(h => h.id === 'fog-cover') && !/the fog first/.test(thin.find(h => h.id === 'time-flat')?.text));
  // [guard] no way around the check: every command that takes a picture of the running game calls the one pagePicture, and a saved picture has shot --image
  const src = f => readFileSync(join(TOOLS, f), 'utf8');
  check('[guard] shot and snap both run pagePicture (one checker), shot --image runs imagePicture; neither keeps a private copy of the probe call',
    /pagePicture\(/.test(src('shot.mjs')) && /imagePicture\(/.test(src('shot.mjs')) && /pagePicture\(/.test(src('threedog/commands.mjs'))
    && !/probePicture\.toString/.test(src('shot.mjs') + src('threedog/commands.mjs')));
  // a probe that fails while it sets up (here: no document) must not leave the engine marked as probing: the who-wrote-it record and the light watch would stay off
  const failed = { _tools: { probing: false } };
  await (0, eval)(`(${probeSource})`)(failed, {}).catch(() => {});
  check('[guard] a probe that throws in its setup leaves probing off', failed._tools.probing === false);
  const tmp = mkdtempSync(join(tmpdir(), 'threedog-picture-'));
  try {
    writeFileSync(join(tmp, 'g.png'), png(480, 270, (x, y) => ((x % 60 < 6 && y % 60 < 6) ? [255, 245, 225] : [30, 32, 40])));
    writeFileSync(join(tmp, 'DESIGN.md'), design('no-glare'));
    const im = await imagePicture(join(tmp, 'g.png'), { dir: tmp });
    check('imagePicture: a saved picture read at the probe width gives numbers and the spots, judged against DESIGN.md (contradiction here)',
      im.size.join() === '480,270' && im.numbers.hotspots > 0 && im.hints.some(h => h.id === 'hotspots' && h.kind === 'contradiction'), JSON.stringify(im));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
