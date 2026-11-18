// The editor's whole loop in a real browser against a real dev server: click an entry in the running game, drag its handle with the mouse, the content file
// changes, reload, the entry stands there. A throwaway game under .threedog/ (inside the repo, so `threedog` resolves); the file it edits is its own.
// Why real mouse events and not a call into the editor: what can break here is the seam between pick, the handles, the page and the file.
// The guards: hand-kept text around the entry survives byte for byte; a write against a value someone changed is refused and changes nothing; a foreign
// page cannot reach the endpoint; the editor's move lands in the op log and not in the save; the build has no editor; the real model follows the drag and
// goes back when a write is refused; height, turning, a slope; what engine.pick cannot see; a physics body, a grid item, an NPC; property rows, add, delete,
// undo and redo, which give the file back byte for byte and are refused over a hand edit like any write. The ground is a plain slope (y = x / 4).
import { createServer, build } from 'vite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, viteOptions } from '../paths.mjs';
import { newGamePage, launchRealGPU } from '../browser.mjs';
import { waitEngine } from '../wait-engine.mjs';
import { problems } from '../rules/R54-editor-door.mjs';

export const name = 'editor: click, drag, saved to the content file, there after a reload; hand edits survive';

const PROPS = `// hand note at the top: stays
export default [
  // the crate by the door
  { id: 'crate',  model: 'box', x: 2,   z: -1, scale: 1 },   // aligned by hand
  { id: 'lamp',   model: 'box', place: 'yard', x: 1, z: 0 },
  { id: 'barrel', model: 'box', x: -4,  z: -2 },
  { id: 'gear',   model: 'box', x: 3 * 2, z: -2 },
  { id: 'cart',   model: 'box', x: -2, z: -5, static: false },   // moves in play: not registered for engine.pick
  { id: 'heavy',  template: 'heavy', x: -7, z: 1 },
  { id: 'bed-1',  grid: 'room', item: 'bed', cell: [1, 1] },
];
`;
const FILES = {
  'index.html': '<!doctype html><html><body style="margin:0"><canvas id="view" style="position:fixed;inset:0;width:100%;height:100%"></canvas><script type="module" src="/main.js"></script></body></html>\n',
  'main.js': `import { createEngine, world, content, grids, characters, collision, rigid, inventory, pickups, settings, THREE } from 'threedog';
import data from './content/index.js';
const engine = createEngine({ canvas: document.getElementById('view'), lights: true, ui: { title: { title: 'fixture' } } });
engine.use(world(), content(), grids(), characters(), collision(), rigid(), inventory(), pickups({ size: 1 }), settings());
engine.ground.height = x => x / 4;
engine.grids.define('bed', {});
engine.world.present('bed', { build: () => new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), new THREE.MeshStandardMaterial()), update: (rec, o) => { o.rotation.y = rec.rot ?? 0; } });   // world places the model; facing is the presenter's
engine.assets.manifest({ name: 'fixture', models: { box: { build: () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()) } } });
const coded = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()); coded.position.set(-1, 0.5, 3); engine.add(coded, { id: 'coded' }); engine.rays.addStatic(coded);
engine.camera.position.set(0, 8, 10); engine.camera.lookAt(0, 0, 0);
await engine.start();   // first: a body needs Rapier, which start() loads
engine.content.load(data, { places: data.places });
Object.assign(window, { engine });
document.body.insertAdjacentHTML('beforeend', '<div style="position:fixed;inset:0;z-index:50;background:#123"></div>');   // a title made by hand
`,
  'content/index.js': "import places from './places.js';\nimport props from './props.js';\nimport templates from './templates.js';\nimport grids from './grids.js';\nimport npcs from './npcs.js';\nimport items from './items.js';\nimport pickups from './pickups.js';\nexport default { places, props, templates, grids, npcs, items, pickups };\n",
  'content/items.js': "export default { apple: { name: 'Apple' } };\n",
  'content/pickups.js': "export default [\n  { id: 'fruit', item: 'apple', x: 2, z: 4 },   // ripe\n];\n",
  'content/templates.js': "export default { heavy: { model: 'box', body: { shape: 'box' } } };\n",
  'content/grids.js': "export default { room: { cell: 1, origin: [-8, 4], size: [6, 4] } };\n",
  'content/npcs.js': "export default {\n  guard: { name: 'Guard', model: 'box', start: { x: -2, z: 1 } },\n};\n",
  'content/places.js': "export default { yard: { x: 3, z: 2, rot: 1.5707963267948966 } };\n",
  'content/props.js': PROPS,
};

/**
 * The handles drawn on real WebGPU: the overlay scene goes through WebGPURenderer, which the default path never touches. Read from the pixels on screen: a handle that
 * does not draw there still answers the mouse, so only the picture can tell. Skipped, and said so, on a machine without Chrome or a WebGPU adapter.
 */
async function onWebGPU(dir, check) {
  const gpu = await launchRealGPU().catch(e => { console.log(`  (no WebGPU run: ${e.message})`); return null; });
  if (!gpu) return;
  const main = join(dir, 'main.js');
  writeFileSync(main, "import 'threedog/tsl';\n" + FILES['main.js'].replace("lights: true }", "lights: true, renderer: 'webgpu' }"));
  const server = await createServer(await viteOptions(dir, { server: { port: 0, host: 'localhost' }, logLevel: 'error' }));
  await server.listen();
  const errors = [], missing = [], page = await newGamePage(gpu, { errors });
  page.on('response', r => { if (r.status() === 404 && !r.url().endsWith('/favicon.ico')) missing.push(r.url()); });   // full Chrome asks for a favicon; Vite answers 504 once while it optimizes three/webgpu, found only now, and reloads by itself
  try {
    await page.goto(`http://localhost:${server.httpServer.address().port}/?edit=1`);
    await waitEngine(page, { dir });
    await page.waitForSelector('#threedog-editor');
    const r = await page.evaluate(() => window.engine.describe().renderer);
    console.log(`  (renderer seen: ${r.backend}, ${JSON.stringify(r.gpu)})`);
    if (r.backend !== 'webgpu') { console.log('  (no WebGPU adapter here: skipped)'); return; }
    /** Pixels of the screenshot near a page point that are the X handle's red or the box's white and were not before */
    const shot = async () => (await page.screenshot()).toString('base64');
    const count = (b64, p) => page.evaluate(async ({ b64, p }) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()), c = new OffscreenCanvas(img.width, img.height).getContext('2d', { willReadFrequently: true });
      c.drawImage(img, 0, 0);
      const d = c.getImageData(Math.round(p.x) - 12, Math.round(p.y) - 12, 24, 24).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 170 && d[i + 1] < 90 && d[i + 2] < 90) n++;
      return n;
    }, { b64, p });
    const at = await recordOf(page, 'barrel'), reach = await page.evaluate(at => { const c = window.engine.camera; return c.position.distanceTo(new __threedogThree.Vector3(at.x, at.y, at.z)) * 1.9 * Math.tan(c.fov * Math.PI / 360) / 4 * 0.45; }, at);
    const arrow = await toScreen(page, { ...at, x: at.x + reach }), bare = await shot();
    await selectEntry(page, 'barrel');
    await page.waitForFunction(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
    const redBefore = await count(bare, arrow), red = await count(await shot(), arrow);
    check('[guard] WebGPU: the handles are drawn on screen after the game frame', red > 10 && redBefore < 3, JSON.stringify({ red, redBefore }));
    const file = () => readFileSync(join(dir, 'content/props.js'), 'utf8'), was = file();
    let during = null;
    await dragEntry(page, 'barrel', 'x', 2, async () => { during = await modelAt(page, 'barrel'); });
    await stateIs(page, 'saved');
    check('[guard] WebGPU: a drag moves the real model and saves', during?.x > at.x + 1 && file() !== was, JSON.stringify({ during, at }));
    check('WebGPU: no page errors', !missing.length && !errors.filter(e => !/status of 404|Outdated Optimize Dep/.test(e)).length, [...missing, ...errors].join('\n'));
  } finally { await page.close(); await server.close(); await gpu.close(); }
}

/** Screen point of a world point, in page pixels */
const toScreen = (page, p) => page.evaluate(p => {
  const e = window.engine, v = new __threedogThree.Vector3(p.x, p.y, p.z).project(e.camera), r = e.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
}, p);
const recordOf = (page, id) => page.evaluate(id => { const p = window.engine.world.get(id).position; return { x: p.x, y: p.y, z: p.z }; }, id);
const state = page => page.$eval('#threedog-editor', el => ({ state: el.dataset.state, text: el.textContent }));
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise(r => setTimeout(r, 50)); } };
const stateIs = (page, s) => until(async () => (await state(page)).state === s);

/** Click the entry's model, then drag the handle of one axis by `by` metres; the arrow's middle is grabbed, where three.js's own picker stands */
async function dragEntry(page, id, axis, by, during = null) {
  await selectEntry(page, id);
  const at = await recordOf(page, id);
  await fresh(page);
  const grab = await page.evaluate(at => {
    const c = window.engine.camera, d = c.position.distanceTo(new __threedogThree.Vector3(at.x, at.y, at.z));
    return d * 1.9 * Math.tan(c.fov * Math.PI / 360) / 4 * 0.45;   // TransformControls' on-screen size (size 1), then most of the way up its arrow
  }, at);
  const from = await toScreen(page, { ...at, [axis]: at[axis] + grab }), to = await toScreen(page, { ...at, [axis]: at[axis] + grab + by });
  await page.mouse.move(from.x, from.y);
  await page.waitForFunction(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await during?.();
  await page.mouse.up();
}

/** Forget the last state, so the next wait is for the next change and not the one before */
const fresh = page => page.$eval('#threedog-editor', el => { el.dataset.state = 'waiting'; });
async function selectEntry(page, id) {
  const p = await toScreen(page, await recordOf(page, id));
  await fresh(page);
  await page.mouse.click(p.x, p.y);
  await until(async () => { const s = await state(page); return s.state === 'selected' && s.text.includes(id); });
}
/** A row the file leaves empty may wait behind More */
const openMore = page => page.click('#threedog-editor details:not([open]) summary', { timeout: 500 }).catch(() => {});
/** Type into a property row and leave it, as a user does */
async function setRow(page, key, value) {
  await fresh(page);
  await openMore(page);
  await page.fill(`[data-field="${key}"]`, value);
  await page.press(`[data-field="${key}"]`, 'Tab');
  return stateIs(page, 'saved');
}
const refusedRow = async (page, key, value) => { await fresh(page); await page.fill(`[data-field="${key}"]`, value); await page.press(`[data-field="${key}"]`, 'Tab'); return stateIs(page, 'refused'); };
const press = async (page, keys) => { await fresh(page); await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press(keys); };
const button = async (page, name) => { await fresh(page); await page.click(`#threedog-editor-${name}`); };
const modelAt = (page, id) => page.evaluate(id => { const o = window.engine.world.view(id); return o ? { x: o.position.x, y: o.position.y, z: o.position.z, scale: o.scale.x, yaw: o.rotation.y } : null; }, id);
const near = (a, b, d = 1e-3) => Math.abs(a - b) < d;
const reloaded = async page => { await until(async () => { try { return await page.evaluate(() => !window.__sameLoad && !!window.engine?.ready); } catch { return false; } }); await page.waitForSelector('#threedog-editor'); };
const sameLoad = page => page.evaluate(() => window.__sameLoad === true);
const saveText = page => page.evaluate(() => JSON.stringify(window.engine.saves._collect().data ?? {}));

export async function run({ check, browser }) {
  mkdirSync(join(ROOT, '.threedog'), { recursive: true });
  const dir = mkdtempSync(join(ROOT, '.threedog', 'zz-editor-'));
  for (const [f, text] of Object.entries(FILES)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), text); }
  const propsFile = join(dir, 'content/props.js'), text = () => readFileSync(propsFile, 'utf8');
  const server = await createServer(await viteOptions(dir, { server: { port: 0, host: 'localhost' }, logLevel: 'error' }));
  await server.listen();
  const url = `http://localhost:${server.httpServer.address().port}/`, errors = [];
  const page = await newGamePage(browser, { errors });
  try {
    await page.goto(url + '?edit=1');
    await waitEngine(page, { dir });
    await page.waitForSelector('#threedog-editor');
    await page.evaluate(() => { window.__sameLoad = true; });
    const was = await recordOf(page, 'crate');
    check('[guard] the title screen goes when the editor opens: it covers the canvas, and a new game always has one', await page.evaluate(() => !window.engine.ui.isOpen('title') && !document.querySelector('.threedog-title')));
    check('[guard] a title the game wrote by hand is out of the way too: the canvas takes the clicks', await page.evaluate(() => { const r = window.engine.renderer.domElement.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === window.engine.renderer.domElement; }));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
    check('[guard] Esc does not open the game\'s menu over the scene', await page.evaluate(() => !window.engine.ui.isOpen('settings')));

    // 1. the loop: select, drag, saved
    await dragEntry(page, 'crate', 'x', 2);
    check('a click selects the entry and the panel names its file and line', /crate/.test((await state(page)).text), JSON.stringify(await state(page)));
    check('letting go saves', await stateIs(page, 'saved'), JSON.stringify(await state(page)));
    const after = /\{ id: 'crate',\s+model: 'box', x: ([-\d.]+),\s+z: -1, scale: 1 \}/.exec(text());
    check('the file has the new x, near where the mouse put it', !!after && Math.abs(+after[1] - (was.x + 2)) < 0.3, text());
    const live = await recordOf(page, 'crate');
    check('[guard] the running game moved to the written value', Math.abs(live.x - +after?.[1]) < 1e-6 && live.z === was.z, JSON.stringify(live));
    const model = await page.evaluate(() => window.engine.thing('crate').object.position.x);
    const movedTo = await toScreen(page, live), oldSpot = await toScreen(page, was);
    const pickAt = p => page.evaluate(({ x, y }) => { const e = window.engine, r = e.renderer.domElement.getBoundingClientRect(); return e.pick((x - r.left) / r.width * 2 - 1, 1 - (y - r.top) / r.height * 2)?.thing?.id ?? null; }, p);
    check('[guard] the model and its ray target moved with it: the new spot picks it, the old one does not', Math.abs(model - live.x) < 1e-6 && await pickAt(movedTo) === 'crate' && await pickAt(oldSpot) !== 'crate', JSON.stringify({ model, live }));
    const others = l => l.split('\n').filter(x => !x.includes("id: 'crate'")).join('\n');
    check('[guard] everything but that one value is byte for byte what the author wrote', others(text()) === others(PROPS) && /x: [-\d.]+,\s+z: -1, scale: 1 \},   \/\/ aligned by hand/.test(text()), text());
    check('a save of our own does not reload the page', await page.evaluate(() => window.__sameLoad === true));
    const log = await page.evaluate(() => window.engine.ops.recent().filter(o => o.name === 'thing.set').map(o => ({ source: o.source, ok: o.ok })));
    check('[guard] the move is in the op log, from the editor', log.length > 0 && log.every(o => o.source === 'editor' && o.ok), JSON.stringify(log));
    const world = await page.evaluate(() => window.engine.saves._collect().data);
    check('[guard] the move is design, not a saved change', !JSON.stringify(world ?? {}).includes('crate'), JSON.stringify(world));

    // 2. an entry on a turned place: the file gets the offset from the place, not the world position
    const lampWas = await recordOf(page, 'lamp');
    await dragEntry(page, 'lamp', 'z', 1.5);
    check('a move on a place saves', await stateIs(page, 'saved'), JSON.stringify(await state(page)));
    const lamp = /\{ id: 'lamp',\s+model: 'box', place: 'yard', x: ([-\d.]+), z: ([-\d.]+) \}/.exec(text());
    // the place is turned a quarter: a world z move is a local x move, so x changes and z (0) stays as written
    check('[guard] a place with rot: the offset is turned back', !!lamp && +lamp[2] === 0 && Math.abs(+lamp[1] - 1 + 1.5) < 0.3 && Math.abs(+lamp[1] - 1) > 0.5, text());
    const lampNow = await recordOf(page, 'lamp');

    // 3. the reload
    await page.reload();
    await waitEngine(page, { dir });
    await page.waitForSelector('#threedog-editor');
    const back = await recordOf(page, 'crate'), lampBack = await recordOf(page, 'lamp');
    check('after a reload the entry stands where it was saved', Math.abs(back.x - live.x) < 1e-6 && back.z === was.z, JSON.stringify({ back, live }));
    check('after a reload an entry on a place too', Math.abs(lampBack.x - lampNow.x) < 1e-3 && Math.abs(lampBack.z - lampNow.z) < 1e-3 && Math.abs(lampNow.z - lampWas.z) > 0.5, JSON.stringify({ lampBack, lampNow }));

    // 4. hand edits while the editor is open
    const saved = text(), edited = saved.replace("x: -4,", "x: -5,");
    await page.evaluate(() => { window.__sameLoad = true; });
    writeFileSync(propsFile, edited);
    check('a hand edit reloads the page, so it never goes on with old values', await until(async () => {
      try { return await page.evaluate(() => !window.__sameLoad && !!window.engine?.ready && window.engine.world.get('barrel')?.position.x === -5); } catch { return false; }
    }), 'page kept the old value');
    await page.waitForSelector('#threedog-editor');
    const write = body => page.evaluate(b => fetch('/__threedog/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()), body);
    const stale = await write({ op: 'write', id: 'barrel', fields: { x: 9 }, expect: { x: -4, z: -2, place: null } });
    check('[guard] a write against a value someone changed is refused and changes nothing', !stale.ok && stale.conflict && text() === edited, JSON.stringify(stale));
    const added = await write({ op: 'write', id: 'barrel', fields: { z: 9 }, expect: { x: -5, z: -2, place: 'yard' } });
    check('[guard] expecting a field the file does not have is a conflict too (the page may hold an older shape)', !added.ok && added.conflict && text() === edited, JSON.stringify(added));
    const appeared = await write({ op: 'write', id: 'lamp', fields: { x: 0 }, expect: { place: null } });
    check('[guard] a field that appeared since the read (null: there was none) is a conflict', !appeared.ok && appeared.conflict, JSON.stringify(appeared));

    // 5. what cannot be saved says so
    const coded = await toScreen(page, { x: -1, y: 0.5, z: 3 });
    await page.mouse.click(coded.x, coded.y);
    await stateIs(page, 'selected');
    const st = await state(page);
    check('a thing added by code can be selected, and the panel says it cannot be saved', /cannot be saved/.test(st.text), st.text);
    const gear = await toScreen(page, await recordOf(page, 'gear'));
    await page.mouse.click(gear.x, gear.y);
    check('[guard] an entry whose x is code gets no handles, the panel says why', await until(async () => /x is computed by code/.test((await state(page)).text)), (await state(page)).text);
    const foreign = await fetch(url + '__threedog/design', { method: 'POST', headers: { origin: 'http://evil.example' }, body: '{"op":"read","id":"crate"}' });
    check('[guard] a foreign page is refused', foreign.status === 403, String(foreign.status));
    const got = await fetch(url + '__threedog/design');
    check('[guard] only POST: a GET carries no Origin to check', got.status === 403, String(got.status));
    const nowhere = await write({ op: 'write', id: 'nope', fields: { x: 1 } });
    check('an unknown id is refused by name', !nowhere.ok && /nope/.test(nowhere.error), JSON.stringify(nowhere));

    // 6. the real model follows the drag; a refused write puts it back
    await page.evaluate(() => { window.__sameLoad = true; });
    const before = await recordOf(page, 'barrel');
    let during = null;
    await dragEntry(page, 'barrel', 'x', 2, async () => { during = await modelAt(page, 'barrel'); });
    check('[guard] the real model moves while the handle is held, and on a slope it stays on the ground', during && during.x > before.x + 1 && near(during.y, during.x / 4), JSON.stringify({ during, before }));
    await stateIs(page, 'saved');
    const slid = await recordOf(page, 'barrel'), fileBefore = text();
    check('[guard] a sideways move on a slope writes no height, and the model stands on the new ground', !/id: 'barrel'.*\by:/.test(text()) && near(slid.y, slid.x / 4), text() + JSON.stringify(slid));
    await page.route('**/__threedog/design', r => (JSON.parse(r.request().postData()).op === 'write' ? r.fulfill({ json: { ok: false, conflict: true, error: 'changed by someone else' } }) : r.continue()));
    await dragEntry(page, 'barrel', 'x', 2);
    await stateIs(page, 'refused');
    await page.unroute('**/__threedog/design');
    await page.evaluate(() => new Promise(requestAnimationFrame));   // a model follows its record on the next frame
    const refused = await modelAt(page, 'barrel');
    check('[guard] a refused write puts the model back where the file has it', near(refused.x, slid.x) && near(refused.y, slid.y) && text() === fileBefore, JSON.stringify({ refused, slid }));

    // [guard] a click on another entry ends the typing, so the refusal of that save comes back with the selection already moved: it was dropped without a word
    await page.route('**/__threedog/design', r => (JSON.parse(r.request().postData()).op === 'write' ? r.fulfill({ json: { ok: false, conflict: true, error: 'changed by someone else' } }) : r.continue()));
    await selectEntry(page, 'barrel');
    await page.fill('[data-field="scale"]', '3');
    const other = await toScreen(page, await recordOf(page, 'crate'));
    await fresh(page);
    await page.mouse.click(other.x, other.y);
    await stateIs(page, 'refused');
    const lost = await state(page);
    await page.unroute('**/__threedog/design');
    check('[guard] a refused save stays on screen when the selection moves on', /barrel not saved: changed by someone else/.test(lost.text), JSON.stringify(lost));

    // 7. height and turning
    await dragEntry(page, 'barrel', 'y', 1);
    await stateIs(page, 'saved');
    const raised = /id: 'barrel',.*\by: ([-\d.]+)/.exec(text()), up = await modelAt(page, 'barrel');
    check('[guard] the height handle writes y, metres above the ground, and the model stands there', !!raised && Math.abs(+raised[1] - 1) < 0.3 && near(up.y, up.x / 4 + +raised[1]), text() + JSON.stringify(up));
    await selectEntry(page, 'lamp');
    await button(page, 'turn');
    const ring = await page.evaluate(id => { const e = window.engine, p = e.world.get(id).position, c = e.camera; return c.position.distanceTo(new __threedogThree.Vector3(p.x, p.y, p.z)) * 1.9 * Math.tan(c.fov * Math.PI / 360) / 4 * 0.5; }, 'lamp');
    const lampAt = await recordOf(page, 'lamp'), yawWas = (await modelAt(page, 'lamp')).yaw;
    const spin = a => toScreen(page, { x: lampAt.x + ring * Math.sin(a), y: lampAt.y, z: lampAt.z + ring * Math.cos(a) });
    const r0 = await spin(0), r1 = await spin(0.4), r2 = await spin(0.8);
    await page.mouse.move(r0.x, r0.y);
    await page.waitForFunction(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
    await fresh(page);
    await page.mouse.down(); await page.mouse.move(r1.x, r1.y, { steps: 4 }); await page.mouse.move(r2.x, r2.y, { steps: 4 }); await page.mouse.up();
    await stateIs(page, 'saved');
    const rot = /id: 'lamp',.*\brot: ([-\d.]+)/.exec(text()), yawNow = (await modelAt(page, 'lamp')).yaw;
    check('[guard] the turn handle writes rot, relative to the place, and the model faces that way', !!rot && Math.abs(+rot[1]) > 0.2 && near(yawNow, Math.PI / 2 + +rot[1], 0.01), text() + JSON.stringify({ yawNow, yawWas }));
    // three.js's outer rings (turn about the view axis, free turn) are off: only the yaw ring is shown, because a tilt is nothing a file value can mean. So where the view-axis ring
    // would stand there is no handle: a drag there must move the camera and write nothing. Comparing the camera is what proves the drag was not on a handle that happened to write the same
    const turnedText = text(), camWas = await page.evaluate(() => window.engine.camera.position.toArray());
    const outer = await page.evaluate(id => {
      const e = window.engine, p = e.world.get(id).position, c = e.camera, s = c.position.distanceTo(new __threedogThree.Vector3(p.x, p.y, p.z)) * 1.9 * Math.tan(c.fov * Math.PI / 360) / 4 * 0.75;
      c.updateMatrixWorld();
      const m = c.matrixWorld.elements, pt = a => ({ x: p.x + s * (m[0] * Math.cos(a) + m[4] * Math.sin(a)), y: p.y + s * (m[1] * Math.cos(a) + m[5] * Math.sin(a)), z: p.z + s * (m[2] * Math.cos(a) + m[6] * Math.sin(a)) });
      return [Math.PI, Math.PI + 0.4, Math.PI + 0.8].map(pt);   // the left side: the right one lies under the panel, where a drag never reaches the canvas
    }, 'lamp');
    const o = [];
    for (const p of outer) o.push(await toScreen(page, p));
    await page.mouse.move(o[0].x, o[0].y);
    await page.waitForFunction(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
    await fresh(page);
    await page.mouse.down(); await page.mouse.move(o[1].x, o[1].y, { steps: 4 }); await page.mouse.move(o[2].x, o[2].y, { steps: 4 }); await page.mouse.up();
    await until(async () => (await state(page)).state !== 'waiting', 1000);
    const tilt = await page.evaluate(() => { const r = window.engine.world.view('lamp').rotation; return { x: r.x, y: r.y, z: r.z }; });
    const camMoved = await page.evaluate(was => window.engine.camera.position.distanceTo(new __threedogThree.Vector3(...was)) > 0.05, camWas);
    check('[guard] a drag where the outer ring would stand moves the camera, and the file and the model keep the turn they had', camMoved && text() === turnedText && near(tilt.x, 0, 0.01) && near(tilt.z, 0, 0.01) && near(tilt.y, yawNow, 0.01), JSON.stringify({ tilt, yawNow, camMoved, same: text() === turnedText }));
    await page.evaluate(was => window.engine.camera.position.fromArray(was), camWas);   // the steps below aim from this view, and the reload keeps the view
    await page.reload();
    await waitEngine(page, { dir });
    await page.waitForSelector('#threedog-editor');
    const yawBack = (await modelAt(page, 'lamp')).yaw, rotBack = +/id: 'lamp',.*\brot: ([-\d.]+)/.exec(text())[1];
    check('[guard] after a reload the model faces what the file says, and upright', near(yawBack, Math.PI / 2 + rotBack, 0.002) && near(rotBack, +rot[1]), JSON.stringify({ yawBack, rotBack }));
    await page.evaluate(() => { window.__sameLoad = true; });

    // 8. what engine.pick cannot see, a body, a grid item, an NPC
    await dragEntry(page, 'cart', 'x', 1.5);
    check('[guard] a static: false entry can be picked, moved and saved', await stateIs(page, 'saved') && !/id: 'cart',\s+model: 'box', x: -2,/.test(text()), text());
    const heavyWas = await recordOf(page, 'heavy');
    await dragEntry(page, 'heavy', 'x', 2);
    await stateIs(page, 'saved');
    const heavy = await page.evaluate(() => { const e = window.engine, t = e.world.view('heavy')?.userData.body?.body.translation(); return { body: t && { x: t.x, z: t.z }, rec: e.world.get('heavy').position.x }; });
    const heavyFile = +/id: 'heavy',\s+template: 'heavy', x: ([-\d.]+)/.exec(text())?.[1];
    check('[guard] an entry with a physics body moves without a reload: file, record and body agree', heavy.body && near(heavy.body.x, heavyFile) && near(heavy.rec, heavyFile) && heavyFile > heavyWas.x + 1 && await sameLoad(page), JSON.stringify({ heavy, heavyFile }));
    await dragEntry(page, 'bed-1', 'x', 2);
    await stateIs(page, 'saved');
    const bed = await recordOf(page, 'bed-1'), cell = /id: 'bed-1',.*cell: \[(\d+), (\d+)\]/.exec(text());
    check('[guard] a grid item moves by its cell: the file has the cell, the record stands on its centre', !!cell && +cell[1] === 3 && +cell[2] === 1 && near(bed.x, -8 + 3.5) && near(bed.z, 4 + 1.5), text() + JSON.stringify(bed));
    const npcs = () => readFileSync(join(dir, 'content/npcs.js'), 'utf8'), npcsWas = npcs();
    await dragEntry(page, 'guard', 'x', 1.5);
    await until(() => npcs() !== npcsWas);
    await reloaded(page);
    await until(async () => (await state(page)).text.includes('guard'));
    const guard = await recordOf(page, 'guard'), wrote = +/start: \{ x: ([-\d.]+)/.exec(npcs())?.[1];
    check('[guard] an NPC moves by its start; the page reloads, keeps the selection, and stands it there', wrote > -1 && near(guard.x, wrote) && /z: 1 \}/.test(npcs()) && (await state(page)).text.includes('guard'), npcs() + JSON.stringify(guard));
    const npcsMoved = npcs();
    check('[guard] an NPC keeps its start: without one the game stops at load, with no editor to undo in', await refusedRow(page, 'start', '') && npcs() === npcsMoved, npcs());
    await page.evaluate(() => { window.__sameLoad = true; });
    await press(page, 'Control+z');
    await until(() => npcs() === npcsWas);
    await reloaded(page);
    check('[guard] the history survives the reload: undo after it gives the file back', npcs() === npcsWas, npcs());

    // 9. property rows, undo, redo
    await page.evaluate(() => { window.__sameLoad = true; });
    const plain = text();
    await selectEntry(page, 'cart');
    check('a property saves and the model shows it, without a reload', await setRow(page, 'scale', '2') && /id: 'cart'.*scale: 2/.test(text()) && (await modelAt(page, 'cart')).scale === 2 && await sameLoad(page), text());
    const notCart = t => t.split('\n').filter(l => !l.includes("id: 'cart'")).join('\n');
    check('[guard] only that entry\'s line changed, and it is design, not a saved change', notCart(text()) === notCart(plain) && !(await saveText(page)).includes('cart'), text());
    const beforeBad = text();
    await fresh(page);
    await openMore(page);
    await page.fill('[data-field="place"]', 'nowhere');
    await page.press('[data-field="place"]', 'Tab');
    check('[guard] a value the game cannot load does not stay in the file: the panel says why, the model still stands', await stateIs(page, 'refused') && text() === beforeBad && /not kept/.test((await state(page)).text) && !!(await modelAt(page, 'cart')), text() + JSON.stringify(await state(page)));
    await press(page, 'Control+z');
    await stateIs(page, 'saved');
    check('[guard] undo takes an added field back out, byte for byte', text() === plain && (await modelAt(page, 'cart')).scale === 1, text());
    await press(page, 'Control+y');
    await stateIs(page, 'saved');
    check('redo puts it back', /id: 'cart'.*scale: 2/.test(text()) && (await modelAt(page, 'cart')).scale === 2, text());
    await selectEntry(page, 'cart');
    check('an empty row takes the field out', await setRow(page, 'scale', '') && text() === plain, text());
    await press(page, 'Control+z');
    await stateIs(page, 'saved');
    const handEdited = text().replace('scale: 2', 'scale: 3');
    writeFileSync(propsFile, handEdited);
    await reloaded(page);
    await press(page, 'Control+z');
    await stateIs(page, 'refused');
    check('[guard] undo over a hand edit is refused and leaves the hand edit', text() === handEdited, text());
    await page.evaluate(() => { window.__sameLoad = true; });
    writeFileSync(propsFile, plain);
    await reloaded(page);

    // 10. add and delete
    await page.evaluate(() => { window.__sameLoad = true; });
    await page.selectOption('#threedog-editor-pick', { label: 'box' });
    await button(page, 'add');
    await stateIs(page, 'saved');
    const centre = await page.evaluate(() => { const p = window.engine.world.get('box-1').position, c = p.clone?.() ?? new __threedogThree.Vector3(p.x, p.y, p.z); return c.project(window.engine.camera).toArray(); });
    check('[guard] add stands on the ground under the middle of the view, which engine.pick cannot see', near(centre[0], 0, 0.02) && near(centre[1], 0, 0.02), JSON.stringify(centre));
    check('[guard] add writes a new line from what the game has, and the model is there without a reload', /\{ id: 'box-1', model: 'box', x: [-\d.]+, z: [-\d.]+ \}/.test(text()) && !!(await modelAt(page, 'box-1')) && (await state(page)).text.includes('box-1') && await sameLoad(page), text());
    await button(page, 'add');
    await stateIs(page, 'saved');
    const [first, second] = [await modelAt(page, 'box-1'), await modelAt(page, 'box-2')];
    check('[guard] a second add from the same view lands beside the first, not inside it', !!second && Math.hypot(first.x - second.x, first.z - second.z) > 0.4, JSON.stringify({ first, second }));
    await press(page, 'Control+z');
    await stateIs(page, 'saved');
    await press(page, 'Control+z');
    await stateIs(page, 'saved');
    check('undo of an add: file back byte for byte, record gone', text() === plain && await page.evaluate(() => !window.engine.world.get('box-1')), text());
    await press(page, 'Control+y');
    await stateIs(page, 'saved');
    check('redo of an add', text().includes("id: 'box-1'") && !!(await modelAt(page, 'box-1')), text());
    await press(page, 'Control+z');
    await stateIs(page, 'saved');
    await selectEntry(page, 'crate');
    await button(page, 'delete');
    await stateIs(page, 'saved');
    check('[guard] delete cuts the entry and its comment, and the record goes, with no "removed" mark in the save', !text().includes("id: 'crate'") && !text().includes('aligned by hand') && text().includes('the crate by the door') && await page.evaluate(() => !window.engine.world.get('crate')) && !(await saveText(page)).includes('crate'), text());
    await press(page, 'Control+z');
    await stateIs(page, 'saved');
    check('[guard] undo of a delete gives the same bytes back in the same spot', text() === plain && !!(await modelAt(page, 'crate')), text());
    // 11. pickups: move, height, a property, add from the panel, delete
    await page.evaluate(() => { window.__sameLoad = true; });
    const pickups = () => readFileSync(join(dir, 'content/pickups.js'), 'utf8'), pickupsWas = pickups();
    const fruitWas = await recordOf(page, 'fruit');
    await dragEntry(page, 'fruit', 'x', 1.5);
    await stateIs(page, 'saved');
    const fruitX = +/id: 'fruit', item: 'apple', x: ([-\d.]+)/.exec(pickups())?.[1];
    check('[guard] a pickup moves by its handle and the file has the new x, comment kept', fruitX > fruitWas.x + 0.8 && pickups().includes('// ripe') && near((await recordOf(page, 'fruit')).x, fruitX), pickups());
    await dragEntry(page, 'fruit', 'y', 1);
    await stateIs(page, 'saved');
    const fruitY = +/id: 'fruit'.*\by: ([-\d.]+)/.exec(pickups())?.[1];
    check('[guard] a pickup has a height handle: y is written', fruitY > 0.4 && fruitY < 1.6, pickups());
    check('a pickup property saves', await setRow(page, 'count', '3') && /count: 3/.test(pickups()), pickups());
    await press(page, 'Control+z'); await stateIs(page, 'saved');
    await press(page, 'Control+z'); await stateIs(page, 'saved');
    await press(page, 'Control+z'); await stateIs(page, 'saved');
    check('undo takes the three pickup changes back, byte for byte', pickups() === pickupsWas, pickups());
    await page.selectOption('#threedog-editor-pick', { label: 'apple (pickup)' });
    await button(page, 'add');
    await stateIs(page, 'saved');
    check('[guard] add from the panel writes a pickup of the chosen item, and it is in the running game', /\{ id: 'apple-1', item: 'apple', x: [-\d.]+, z: [-\d.]+ \}/.test(pickups()) && await page.evaluate(() => !!window.engine.world.get('apple-1')), pickups());
    await button(page, 'delete');
    await stateIs(page, 'saved');
    check('a pickup can be deleted, the record goes', !pickups().includes('apple-1') && await page.evaluate(() => !window.engine.world.get('apple-1')), pickups());
    await press(page, 'Control+z'); await stateIs(page, 'saved');
    await press(page, 'Control+z'); await stateIs(page, 'saved');
    check('undo of the delete and then of the add leaves the file as it was', pickups() === pickupsWas, pickups());

    // 12. a quarter turn for a grid item
    await selectEntry(page, 'bed-1');
    await button(page, 'turn');
    const bedAt = await recordOf(page, 'bed-1'), bedRing = await page.evaluate(p => { const e = window.engine, c = e.camera; return c.position.distanceTo(new __threedogThree.Vector3(p.x, p.y, p.z)) * 1.9 * Math.tan(c.fov * Math.PI / 360) / 4 * 0.5; }, bedAt);
    const bedSpin = a => toScreen(page, { x: bedAt.x + bedRing * Math.sin(a), y: bedAt.y, z: bedAt.z + bedRing * Math.cos(a) });
    const b0 = await bedSpin(Math.PI), b1 = await bedSpin(Math.PI + 0.6), b2 = await bedSpin(Math.PI + 1.2);   // the far side: the near side of the ring lies below the bottom edge of the view
    await page.mouse.move(b0.x, b0.y);
    await page.waitForFunction(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
    await fresh(page);
    await page.mouse.down(); await page.mouse.move(b1.x, b1.y, { steps: 4 }); await page.mouse.move(b2.x, b2.y, { steps: 4 }); await page.mouse.up();
    await stateIs(page, 'saved');
    const turned = +/id: 'bed-1',.*\brotation: (\d)/.exec(text())?.[1], bedRot = await page.evaluate(() => window.engine.world.get('bed-1').rot), bedYaw = await until(async () => { const y = (await modelAt(page, 'bed-1')).yaw; return near(((y % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2), turned * Math.PI / 2, 0.02) ? y : 0; }, 3000);
    const tau = Math.PI * 2, wrapped = ((bedYaw % tau) + tau) % tau;
    check('[guard] the turn handle of a grid item writes rotation in quarter turns, and the model faces that way', [1, 2, 3].includes(turned) && near(wrapped, turned * Math.PI / 2, 0.02) && /cell: \[3, 1\]/.test(text()), text() + JSON.stringify({ turned, bedYaw, bedRot, now: await modelAt(page, 'bed-1') }));
    const gridText = text();
    check('[guard] a cell typed in the row is asked of the grid like a drag', await refusedRow(page, 'cell', '[99, 1]') && text() === gridText, text());
    await button(page, 'move');
    await press(page, 'Control+z'); await stateIs(page, 'saved');
    check('undo of the turn takes rotation out again', !/id: 'bed-1'.*rotation/.test(text()), text());

    // 13. a field cut from the middle comes back in its place; an entry with computed values can be deleted
    await selectEntry(page, 'lamp');
    const lampLine = text();
    check('an empty row cuts a field from the middle of the entry', await setRow(page, 'x', '') && !/id: 'lamp'.*\bx: 1,/.test(text()), text());
    check('[guard] the panel says the row went back to its default and that undo brings the value back', /x emptied.*default.*Undo brings back/.test((await state(page)).text), (await state(page)).text);
    await press(page, 'Control+z'); await stateIs(page, 'saved');
    check('[guard] undo puts the cut field back in front of the one that followed it', text() === lampLine, text());
    await selectEntry(page, 'gear');
    const gearLine = text();
    await button(page, 'delete');
    await until(() => !text().includes("id: 'gear'"));
    await reloaded(page);   // an entry with code in it cannot be taken out of the running game alone
    check('[guard] an entry with a computed value can be deleted, the file keeps the rest', !text().includes("id: 'gear'") && text().includes("id: 'barrel'"), text());
    await press(page, 'Control+z');
    await until(() => text() === gearLine);
    await reloaded(page);
    check('[guard] undo of that delete gives the entry back with its computed value', text() === gearLine, text());

    // 14. saves that overlap: a reply lands by id, a drag keeps the anchor, a row being typed in is not redrawn
    const slow = r => { const b = JSON.parse(r.request().postData() ?? '{}'); return b.op === 'write' && b.fields?.scale !== undefined ? new Promise(s => setTimeout(s, 1500)).then(() => r.continue()) : r.continue(); };
    await page.route('**/__threedog/design', slow);
    const hold = text();
    await selectEntry(page, 'cart');
    await page.fill('[data-field="scale"]', '2');
    await page.press('[data-field="scale"]', 'Tab');   // the save starts and is held back; the focus moves to the next row
    await page.evaluate(() => { window.__row = document.activeElement; });
    await fresh(page);
    await page.keyboard.type('1');
    check('[guard] a save that lands does not redraw the row the user has moved on to', await stateIs(page, 'saved') && await page.evaluate(() => document.activeElement === window.__row && document.contains(window.__row)), JSON.stringify(await state(page)));
    await press(page, 'Control+z'); await stateIs(page, 'saved');
    await selectEntry(page, 'cart');
    await page.fill('[data-field="scale"]', '2');
    await page.press('[data-field="scale"]', 'Tab');
    await selectEntry(page, 'crate');   // another entry is selected while the reply for the cart is on its way
    await new Promise(s => setTimeout(s, 2000));
    check('[guard] a reply lands by id: the panel stays on the entry now selected', /crate/.test((await state(page)).text) && /id: 'cart'.*scale: 2/.test(text()), JSON.stringify(await state(page)));
    await page.unroute('**/__threedog/design', slow);
    await press(page, 'Control+z'); await stateIs(page, 'saved');
    await page.route('**/__threedog/design', slow);
    await selectEntry(page, 'cart');
    await page.fill('[data-field="scale"]', '2');
    await page.press('[data-field="scale"]', 'Tab');
    const startX = (await recordOf(page, 'cart')).x;
    await dragEntry(page, 'cart', 'x', 2, async () => { await stateIs(page, 'saved'); });   // the reply for the scale lands while the handle is held
    await page.unroute('**/__threedog/design', slow);
    await stateIs(page, 'saved');
    const cartX = +/id: 'cart'.*\bx: ([-\d.]+)/.exec(text())?.[1];
    check('[guard] a save landing under a drag does not take the anchor: the drag still saves where the hand put it', cartX > startX + 1 && text() !== hold, text());
    check('no page errors along the way', !errors.length, errors.join('\n'));
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
  finally { await page.close(); await server.close(); }

  try {
    await build(await viteOptions(dir, { logLevel: 'error' }));
    const js = readdirSync(join(dir, 'dist/assets')).filter(f => f.endsWith('.js')).map(f => readFileSync(join(dir, 'dist/assets', f), 'utf8')).join('');
    const html = readFileSync(join(dir, 'dist/index.html'), 'utf8');
    check('[guard] a production build has no editor', existsSync(join(dir, 'dist/index.html')) && !js.includes('__threedog/design') && !js.includes('threedog-editor') && !html.includes('threedog-editor'));
    await onWebGPU(dir, check);
  } finally { rmSync(dir, { recursive: true, force: true }); }

  check('[guard] R54 catches a screen that goes around design.js', problems('index.js', "fetch('/__threedog/design')").length > 0 && problems('index.js', 'engine.world.get(id)').length > 0
    && problems('index.js', 'entry.template').length > 0 && problems('design.js', "engine.world.move('a', p)").length > 0 && !problems('design.js', "fetch('/x')").length);
}
