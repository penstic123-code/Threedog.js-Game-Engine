// Guards: each module here gets its picture from its own options and a plain three.js material, never from a style section or a material role. A swap through
// .material must reach what is on screen as given, and the module source must not reach back for engine.look / engine.style / makeMaterial.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '../..');
const FORBIDDEN = /\b(engine|e|assets\.engine|this\.engine|pk\.engine|ch\.engine)\.(style|look)\b|\bmakeMaterial\(|defineLookPart/;
/** Source files of a module group that still reach for the removed look layer */
const reaching = files => files.filter(f => FORBIDDEN.test(readFileSync(join(ENGINE, f), 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')));

export const specs = [
  {
    name: '[guard] pickups picture: pickups({ color, size, lift }) and engine.pickups.material; a swap reaches every box as given, own colors stay as copies',
    url: '/tests/perf/index.html?mode=world',
    async run({ check, ev, page }) {
      const bad = reaching(['modules/gameplay/pickups.js', 'modules/gameplay/Interactions.js', 'modules/gameplay/inventoryOps.js', 'modules/gameplay/questLog.js']);
      check('no engine.look / engine.style / makeMaterial in pickups', !bad.length, bad.join(' | '));
      await page.waitForFunction(() => window.engine?.ready, null, { timeout: 60000 });
      const r = await ev(async () => {
        const { THREE, materialPatches, createEngine, world, pickups } = threedogTest, W = fn => engine.ops.allow(fn), p = engine.actorPosition();
        const fn = () => {};
        W(() => { engine.pickups.spawn({ x: p.x + 1, z: p.z + 1 }, { give: fn, id: 'lk-plain', name: 'plain' }); engine.pickups.spawn({ x: p.x + 2, z: p.z + 1 }, { give: fn, id: 'lk-red', name: 'red', color: 0xff0000 }); });
        engine.world.refresh(); engine.step(0.1);
        await __t.until(() => ['lk-plain', 'lk-red'].every(id => engine.world.view(id)?.children.length), 15000).catch(() => {});
        const mesh = id => { let m = null; engine.world.view(id)?.traverse(o => { if (o.isMesh) m = o; }); return m; };
        const a = mesh('lk-plain'), b = mesh('lk-red'), before = engine.pickups.material;
        const out = { sameDefault: a.material === before, redBefore: b.material.color.getHex() };
        const mine = new THREE.MeshPhongMaterial({ color: 0x00ff00, shininess: 7 });
        engine.pickups.material = mine;
        out.got = engine.pickups.material === mine; out.plainSwapped = a.material === mine;
        out.red = { type: b.material.type, color: b.material.color.getHex(), shininess: b.material.shininess };
        out.mineColor = mine.color.getHex(); out.minePatches = materialPatches(mine).length;
        W(() => engine.pickups.spawn({ x: p.x + 3, z: p.z + 1 }, { give: fn, id: 'lk-late', name: 'late' }));
        engine.world.refresh(); engine.step(0.1);
        await __t.until(() => engine.world.view('lk-late')?.children.length, 15000).catch(() => {});
        out.lateIsMine = mesh('lk-late').material === mine;
        out.bad = (() => { try { engine.pickups.material = 'gold'; return ''; } catch (x) { return x.code; } })();
        const e2 = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, saveKey: 'picture-pk' });
        e2.use(world(), pickups({ color: 0x112233, size: 0.5, lift: 1.5 }));
        out.opts = { color: e2.pickups.material.color.getHex(), size: e2.pickups.size, lift: e2.pickups.lift };
        e2.dispose();
        return out;
      });
      check('the default is the module\'s own material, a colored pickup draws a copy in its color', r.sameDefault && r.redBefore === 0xff0000, JSON.stringify(r));
      check('a set material is on the plain box at once and reads back', r.got && r.plainSwapped, JSON.stringify(r));
      check('a pickup with its own color follows the swap as a copy in that color, the game\'s material is untouched', r.red.type === 'MeshPhongMaterial' && r.red.color === 0xff0000 && r.red.shininess === 7 && r.mineColor === 0x00ff00 && r.minePatches === 0, JSON.stringify(r));
      check('a pickup built after the swap uses it', r.lateIsMine, JSON.stringify(r));
      check('a non-material is refused', r.bad === 'pickup-misuse', r.bad);
      check('module options set the default color, box size and lift', r.opts.color === 0x112233 && r.opts.size === 0.5 && r.opts.lift === 1.5, JSON.stringify(r.opts));
    },
  },
  {
    name: '[guard] grid picture: grids({ ... }) options, layer.material and pv.material swap the tiles and the preview as given',
    url: '/tests/level/index.html',
    async run({ check, ev }) {
      const bad = reaching(['modules/grid/index.js', 'modules/grid/tiles.js', 'modules/grid/preview.js', 'modules/grid/Layer.js']);
      check('no engine.look / engine.style / makeMaterial in the grid module', !bad.length, bad.join(' | '));
      const r = await ev(async () => {
        if (!engine.grids) engine.use(window.grids({ ok: 0x00ff00, bad: 0xff0000, previewOpacity: 0.3, previewHeight: 0.2, tileLift: 0.1, tiles: { lkSoil: { wet: 0x112233 } } }));
        const G = engine.grids, g = G.add('lk', { cell: 1, origin: [-4, -4], size: [8, 8] });
        G.define('lkItem', {});
        const soil = g.layer('lkSoil'), none = g.layer('lkData');
        engine.ops.define('test.lkWet', { run: () => { soil.set([1, 1], { wet: true }); } });
        engine.ops.run('test.lkWet');
        engine.step(1 / 30, { render: false });
        const mesh = engine.scene.getObjectByName('grid:lk.lkSoil'), pos = mesh.geometry.attributes.position;
        const out = { defaultIsMesh: soil.material === mesh.material, dataLayer: none.material, tiles: mesh.userData.tiles, lift: +(pos.getY(0) - engine.surface(pos.getX(0), pos.getZ(0))).toFixed(3) };
        const Mat = mesh.material.constructor, mine = new Mat({ vertexColors: true }), key = mine.customProgramCacheKey?.();
        soil.material = mine;
        out.tileSwapped = mesh.material === mine && soil.material === mine;
        out.noTiles = (() => { try { none.material = mine; return ''; } catch (x) { return x.code; } })();
        const pv = G.preview({ grid: 'lk', item: 'lkItem', rotate: false, from: () => ({ x: 0.5, z: 0.5 }) });
        engine.step(1 / 30, { render: false });
        const box = engine.scene.getObjectByName('grid:preview');
        out.pvDefault = { same: pv.material === box.material, opacity: box.material.opacity, height: +box.scale.y.toFixed(3), color: box.material.color.getHex() };
        const pm = new Mat({ transparent: true, opacity: 0.9 });
        pv.material = pm; engine.step(1 / 30, { render: false });
        out.pvSwapped = { on: box.material === pm && pv.material === pm, opacity: pm.opacity, color: pm.color.getHex() };
        pv.remove();
        const off = G.preview({ grid: 'lk', item: 'lkItem', rotate: false, draw: false, from: () => null });
        out.lookOff = { read: off.material, set: (() => { try { off.material = pm; return ''; } catch (x) { return x.code; } })() };
        off.remove();
        out.key = key === mine.customProgramCacheKey?.();
        engine._unhalt?.();
        return out;
      });
      check('tiles: the table and lift come from grids({ tiles, tileLift }), layer.material is the tile mesh\'s', r.defaultIsMesh && r.tiles === 1 && r.lift === 0.1, JSON.stringify(r));
      check('a data layer has no material and refuses one with the fix', r.dataLayer === null && r.noTiles === 'grids-misuse', JSON.stringify(r));
      check('layer.material swaps the tile mesh, no patches added', r.tileSwapped && r.key, JSON.stringify(r));
      check('preview: opacity, height, ok color come from grids({ ... })', r.pvDefault.same && r.pvDefault.opacity === 0.3 && r.pvDefault.height === 0.2 && r.pvDefault.color === 0x00ff00, JSON.stringify(r.pvDefault));
      check('pv.material swaps the box as given; its color still shows ok', r.pvSwapped.on && r.pvSwapped.opacity === 0.9 && r.pvSwapped.color === 0x00ff00, JSON.stringify(r.pvSwapped));
      check('draw: false: no material, and setting one says why', r.lookOff.read === null && r.lookOff.set === 'grids-misuse', JSON.stringify(r.lookOff));
    },
  },
  {
    name: '[guard] characters picture: engine.characters.material reaches every capsule as given, colors.body stays a copy, characters({ animation }) reaches the Animator',
    url: '/tests/perf/index.html?mode=world',
    async run({ check, ev, page }) {
      const bad = reaching(['Character', 'NPC', 'assetModel', 'proceduralRig', 'useModel', 'npcView', 'index'].map(f => `modules/characters/${f}.js`));
      check('no engine.look / engine.style / makeMaterial in characters', !bad.length, bad.join(' | '));
      await page.waitForFunction(() => window.engine?.ready, null, { timeout: 60000 });
      const r = await ev(async () => {
        const { THREE, Character, materialPatches, createEngine, world, characters } = threedogTest;
        const body = c => { let m = null; c.root.traverse(o => { if (o.isMesh) m = o; }); return m; };
        const a = new Character(engine, {}), b = new Character(engine, { colors: { body: 0xff0000 } }), before = engine.characters.material;
        const out = { sameDefault: body(a).material === before, gray: before.color.getHex(), redBefore: body(b).material.color.getHex() };
        const mine = new THREE.MeshPhongMaterial({ color: 0x00ff00, shininess: 7 });
        engine.characters.material = mine;
        out.got = engine.characters.material === mine; out.plainSwapped = body(a).material === mine;
        const red = body(b).material;
        out.red = { type: red.type, color: red.color.getHex(), shininess: red.shininess };
        out.mineColor = mine.color.getHex(); out.minePatches = materialPatches(mine).length;
        const late = new Character(engine, {});
        out.lateIsMine = body(late).material === mine;
        let freed = 0; mine.addEventListener('dispose', () => freed++);   // kept (keepPart): removing one character leaves the material every capsule draws with
        a.dispose(); out.survives = freed === 0 ? 'shared' : 'freed';
        b.dispose(); late.dispose();
        out.bad = (() => { try { engine.characters.material = 'gold'; return ''; } catch (x) { return x.code; } })();
        const e2 = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, saveKey: 'picture-ch' });
        e2.use(world(), characters({ animation: { fade: 0.07 } }));
        const hero = new THREE.Group(); hero.animations = [];
        out.fade = new Character(e2, { model: hero }).anim?.fade ?? null;
        e2.dispose();
        return out;
      });
      check('the default capsule draws with engine.characters.material, neutral gray', r.sameDefault && r.gray === 0x8a8a8a, JSON.stringify(r));
      check('a swap reaches the capsule and the next one as given, no patches added', r.got && r.plainSwapped && r.lateIsMine && r.minePatches === 0 && r.mineColor === 0x00ff00, JSON.stringify(r));
      check('colors.body keeps its color on a copy of the new material', r.redBefore === 0xff0000 && r.red.type === 'MeshPhongMaterial' && r.red.color === 0xff0000 && r.red.shininess === 7, JSON.stringify(r.red));
      check('the shared material outlives one character; a wrong value is refused with the code', r.survives === 'shared' && r.bad === 'character-option', JSON.stringify(r));
      check('characters({ animation }) is what a model\'s Animator starts from', r.fade === 0.07, JSON.stringify(r.fade));
    },
  },
  {
    name: '[guard] triggers picture: triggers({ debugColor, debugOpacity }) colors the debug view; gray without them; nothing reads a style',
    url: '/tests/perf/index.html?mode=world',
    async run({ check, ev, page }) {
      const bad = reaching(['modules/triggers/index.js']);
      check('no engine.look / engine.style / makeMaterial in triggers', !bad.length, bad.join(' | '));
      await page.waitForFunction(() => window.engine?.ready, null, { timeout: 60000 });
      const r = await ev(() => {
        const { createEngine, triggers } = threedogTest;
        const look = o => {
          const e = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, saveKey: 'picture-tr' });
          e.use(triggers(o));
          e.triggers.add({ position: { x: 0, y: 0, z: 0 }, tag: 'lk' });
          e.debug.view('triggers');
          const m = e.scene.getObjectByName('triggers-debug').children[0].material, out = { color: m.color.getHex(), opacity: m.opacity, depthTest: m.depthTest };
          e.dispose();
          return out;
        };
        const bad = (() => { try { triggers({ debugColour: 1 }); return ''; } catch (x) { return x.code; } })();
        return { mine: look({ debugColor: 0xff00ff, debugOpacity: 0.25 }), plain: look({}), bad };
      });
      check('the options reach the wireframe', r.mine.color === 0xff00ff && r.mine.opacity === 0.25 && !r.mine.depthTest, JSON.stringify(r.mine));
      check('without them it stays neutral gray', r.plain.color === 0x9a9a9a && r.plain.opacity === 0.8, JSON.stringify(r.plain));
      check('a misspelled option throws', r.bad === 'module-params', r.bad);
    },
  },
  {
    name: '[guard] assets palette: this.palette reads engine.assets.palette, and a write reaches every cache: cached key, named model, code texture, model prototype, modelNow',
    url: '/tests/perf/index.html?mode=world',
    async run({ check, ev, page }) {
      const bad = reaching(['core/assets/Assets.js', 'core/assets/assetEntry.js', 'core/assets/assetLoad.js', 'core/assets/namedModel.js', 'modules/characters/assetModel.js']);
      check('no engine.look / engine.style / makeMaterial in the asset path', !bad.length, bad.join(' | '));
      await page.waitForFunction(() => window.engine?.ready, null, { timeout: 60000 });
      const r = await ev(async () => {
        const { THREE, createEngine, protoOf } = threedogTest;
        const e = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, saveKey: 'picture-pal' }), A = e.assets, n = { box: 0, tex: 0, file: 0 };
        const out = { empty: JSON.stringify(A.palette) };
        A.manifest({
          models: { lkBox: function () { n.box++; return new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ color: this.palette.hue ?? 0x123456 })); } },
          textures: { lkTex: function () { n.tex++; const t = new THREE.Texture(); t.userData.hue = this.palette.hue; return t; } },
        });
        const hex = o => { let c = null; o.traverse(x => { if (x.isMesh) c = x.material.color.getHex(); }); return c; }, api = {};
        const m0 = await A.model('lkBox'), t0 = await A.texture('lkTex'), p0 = await protoOf(e, api, 'lkBox'), c0 = await A.cached('lkBox', A.builder('lkBox'));
        out.before = [hex(m0), t0.userData.hue ?? null, hex(p0.obj), hex(c0)];
        const again = await A.model('lkBox');
        out.builtOnce = n.box === 2 && hex(again) === 0x123456 && (await protoOf(e, api, 'lkBox')) === p0;
        A.palette.hue = 0xff0000;   // a write to one key, no setter involved
        out.nowStale = A.modelNow('lkBox');
        const m1 = await A.model('lkBox'), t1 = await A.texture('lkTex'), p1 = await protoOf(e, api, 'lkBox'), c1 = await A.cached('lkBox', A.builder('lkBox'));
        out.after = [hex(m1), t1.userData.hue, hex(p1.obj), hex(c1)];
        out.nowFresh = hex(A.modelNow('lkBox'));
        out.placed = hex(m0);
        A.palette = { hue: 0x00ff00 };   // replacing the whole object works the same
        out.replaced = hex(await A.model('lkBox'));
        e.dispose();
        return out;
      });
      check('the palette starts empty and a generator without one keeps its own color', r.empty === '{}' && r.before[0] === 0x123456 && r.before[1] === null, JSON.stringify(r));
      check('no write, no rebuild', r.builtOnce, JSON.stringify(r));
      check('after a write every path gives the new color; modelNow does not hand out the old build', r.after.every(c => c === 0xff0000) && r.nowStale === null && r.nowFresh === 0xff0000, JSON.stringify(r));
      check('a copy already placed keeps its color; a replaced object is read too', r.placed === 0x123456 && r.replaced === 0x00ff00, JSON.stringify(r));
    },
  },
  {
    name: '[guard] baked materials: a neutral material and a plain three.js one come back from the GLB as recorded, the neutral one still engine-made; no style is asked',
    url: '/tests/perf/index.html?mode=world',
    async run({ check, ev, page }) {
      const bad = reaching(['core/assets/Baked.js', 'core/assets/assetReport.js', 'core/inspect/MaterialInfo.js']);
      check('no engine.look / engine.style / makeMaterial in the bake path', !bad.length, bad.join(' | '));
      await page.waitForFunction(() => window.engine?.ready, null, { timeout: 60000 });
      const r = await ev(async () => {
        const { THREE, toGLB, neutralMaterial, isEngineMade } = threedogTest;
        const root = new THREE.Group(), add = (name, m, g = new THREE.BoxGeometry()) => { const o = new THREE.Mesh(g, m); o.name = name; root.add(o); };
        add('gray', neutralMaterial('prop'));
        add('tinted', neutralMaterial('prop', { color: 0x336699, flatShading: true }));
        add('plain', new THREE.MeshPhysicalMaterial({ color: 0x884422, roughness: 0.3, clearcoat: 0.7, transparent: true, opacity: 0.5 }));
        const url = URL.createObjectURL(new Blob([await toGLB(root, 'lk-baked')], { type: 'model/gltf-binary' })) + '#lk-baked.glb';
        const back = await engine.assets.model(url), m = n => back.getObjectByName(n).material;
        const row = x => ({ type: x.type, color: x.color.getHex(), purpose: x.userData.purpose ?? null, made: isEngineMade(x), flat: !!x.flatShading });
        const geo = await toGLB(new THREE.BoxGeometry());   // a bare geometry is drawn with neutral gray for the trip, and comes back a geometry
        const info = engine.inspect.scene({ limit: 1 });
        return { gray: row(m('gray')), tinted: row(m('tinted')), plain: { ...row(m('plain')), rough: m('plain').roughness, coat: m('plain').clearcoat, opacity: m('plain').opacity }, geo: geo.byteLength > 0, info: !!info };
      });
      check('neutral gray stays Lambert, gray, engine-made, with its purpose', r.gray.type === 'MeshLambertMaterial' && r.gray.color === 0x8c8c8c && r.gray.purpose === 'prop' && r.gray.made, JSON.stringify(r.gray));
      check('neutralMaterial params come back', r.tinted.color === 0x336699 && r.tinted.flat && r.tinted.made, JSON.stringify(r.tinted));
      check('a plain three.js material stays the game\'s, every setting as recorded', r.plain.type === 'MeshPhysicalMaterial' && !r.plain.made && r.plain.purpose === null && r.plain.color === 0x884422 && r.plain.rough === 0.3 && r.plain.coat === 0.7 && r.plain.opacity === 0.5, JSON.stringify(r.plain));
      check('a bare geometry still exports', r.geo && r.info, JSON.stringify(r));
    },
  },
];
