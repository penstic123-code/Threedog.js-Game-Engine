// Asset check without a browser: GLBs built in code with glTF Transform go through the real read path (file on disk -> NodeIO -> manifest / review).
// Guards: marker counts of the level manifest, missing template, duplicate record id, content-check reading the glb (fromLevel trigger, places, template),
// color-space mix-ups (data texture in a color slot, one texture in both), BLEND hints, texture without UV, oversized texture.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { reportLines } from '../assets-check/report.mjs';
import { nameHintLines } from '../assets-check/names.mjs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { ROOT } from '../paths.mjs';
import { checkModel, runCheck } from '../assets-check/cli.mjs';
import { checkGame } from '../content-check.mjs';
import { declaredNeeds } from '../assets-check/needs.mjs';
import { assetFiles, isFileOf } from '../lib/asset-url.mjs';
import { loaderNames, partNode } from '../assets-check/names.mjs';
import { needsProblems, readNeeds } from 'threedog/model-needs';

export const name = 'assets check: level manifest, material review (glb built in code)';

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
/** A PNG header that only claims a size (enough for the size reader; never decoded) */
const bigPng = w => { const b = Buffer.alloc(33); PNG_1PX.copy(b, 0, 0, 33); b.writeUInt32BE(w, 16); b.writeUInt32BE(w, 20); return b; };

export async function run({ check }) {
  const { Document, NodeIO } = createRequire(resolve(ROOT, 'package.json'))('@gltf-transform/core');
  const dir = mkdtempSync(join(tmpdir(), 'threedog-assets-'));
  try {
    const doc = new Document(), buf = doc.createBuffer(), scene = doc.createScene();
    const tri = () => doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buf)));
    const node = (n, extras, parent = scene, mesh) => { const o = doc.createNode(n).setTranslation([1, 2, 3]); if (extras) o.setExtras(extras); if (mesh) o.setMesh(mesh); parent.addChild(o); return o; };
    node('spawn'); node('spawn_2');
    node('col_wall', null, scene, tri()); node('col_box', null, scene, tri()); node('crate', { collider: true }, scene, tri());
    node('col_empty');
    node('trigger_gate', { shape: 'box', radius: 2 }); node('npc_shop'); node('marker_chest');
    node('door_front', { template: 'door' }); node('door_back', { template: 'door' }); node('well', { template: 'well' }); node('rock', { id: true });
    node('rock', { id: true });   // same record id town/rock twice
    // materials: data texture in a color slot / one texture in two kinds of slot / BLEND / texture on a mesh without UV / huge texture
    const tex = (n, bytes = PNG_1PX) => doc.createTexture(n).setImage(new Uint8Array(bytes)).setMimeType('image/png');
    const mats = {
      wrongSlot: doc.createMaterial('wrongSlot').setBaseColorTexture(tex('rock_normal.png')),
      shared: (() => { const t = tex('mix.png'); return doc.createMaterial('shared').setBaseColorTexture(t).setNormalTexture(t); })(),
      glass: doc.createMaterial('glass').setAlphaMode('BLEND').setBaseColorFactor([1, 1, 1, 0.4]),
      pointless: doc.createMaterial('pointless').setAlphaMode('BLEND'),
      leaves: doc.createMaterial('leaves_fence').setAlphaMode('BLEND').setBaseColorTexture(tex('leaf_albedo.png')),
      big: doc.createMaterial('big').setBaseColorTexture(tex('huge_albedo.png', bigPng(4096))),
      fine: doc.createMaterial('fine').setBaseColorTexture(tex('wood_albedo.png')).setNormalTexture(tex('wood_normal.png')),
    };
    const withUv = tri(); withUv.listPrimitives()[0].setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(6)).setBuffer(buf));
    withUv.listPrimitives()[0].setMaterial(mats.fine);
    node('good_mesh', null, scene, withUv);
    const noUv = tri(); noUv.setName('noUvMesh').listPrimitives()[0].setMaterial(mats.big);
    node('big_mesh', null, scene, noUv);
    for (const m of ['wrongSlot', 'shared', 'glass', 'pointless', 'leaves']) { const mesh = tri(); mesh.listPrimitives()[0].setMaterial(mats[m]); node('m_' + m, null, scene, mesh); }

    const file = join(dir, 'art/models/town.glb');
    mkdirSync(join(dir, 'art/models'), { recursive: true });
    await new NodeIO().write(file, doc);

    const r = await checkModel(file, { templates: { door: { model: 'x' } } });
    const L = r.level, has = (list, code, re) => list.some(i => i.code === code && (!re || re.test(i.msg + (i.where || ''))));
    check('manifest counts: 2 spawns, 4 colliders (col_ x3 + collider property), 1 trigger, 1 npc, 1 marker', L.counts.spawns === 2 && L.counts.colliders === 4 && L.counts.triggers === 1 && L.counts.npcs === 1 && L.counts.markers === 1, JSON.stringify(L.counts));
    check('trigger parameters come from the custom properties', L.triggers[0].tag === 'gate' && L.triggers[0].shape === 'box' && L.triggers[0].radius === 2, JSON.stringify(L.triggers[0]));
    check('templates counted: door x2, well x1', L.templates.door === 2 && L.templates.well === 1, JSON.stringify(L.templates));
    check('template missing from content/templates.js is an error', has(L.issues, 'missing-template', /town\/well/) && !has(L.issues, 'missing-template', /door_\w+ uses/));
    check('duplicate record id is an error', has(L.issues, 'duplicate-id', /town\/rock/));
    check('collider without a mesh warns', has(L.issues, 'empty-collider', /col_empty/));
    check('model statistics: 7 materials, PNG textures', r.stats.materials === 7 && r.stats.textures.formats.join() === 'PNG', JSON.stringify(r.stats.textures.formats));
    const M = r.materials;
    check('data texture in a color slot is flagged', has(M, 'data-in-color-slot', /rock_normal/));
    check('one texture in a color slot and a data slot is flagged', has(M, 'shared-color-and-data', /shared/));
    check('correct slots are not flagged', !M.some(i => /fine/.test(i.where)));
    check('BLEND hint: translucent glass is info, opaque BLEND warns, foliage suggests MASK', M.some(i => i.code === 'blend' && /glass/.test(i.where) && i.severity === 'info') && has(M, 'blend-opaque', /pointless/) && has(M, 'blend', /MASK/));
    check('texture on a mesh without UV is flagged', has(M, 'texture-without-uv', /noUvMesh/));
    check('4096 px texture is flagged as large', has(M, 'big-texture', /huge_albedo/));

    // names GLTFLoader renames: a bone and a mesh node both called weapon -> the second becomes weapon_1
    const clash = async (fn, name, code = 'renamed-name') => { const d = new Document(); d.createBuffer(); const sc = d.createScene(); fn(d, sc); const f = join(dir, name); await new NodeIO().write(f, d); return (await checkModel(f, {})).level.issues.filter(i => i.code === code); };
    const bad = await clash((d, sc) => { const arm = d.createNode('Armature'); arm.addChild(d.createNode('weapon')); const m = d.createNode('weapon').setMesh(d.createMesh('gun')); sc.addChild(arm); sc.addChild(m); }, 'clash.glb');
    check('a bone and a mesh node both called weapon: warns, names both and the new name weapon_1', bad.length === 1 && bad[0].severity === 'info' && /weapon_1/.test(bad[0].msg) && /Armature\/weapon\]/.test(bad[0].msg) && /\[weapon \(has mesh\)\]/.test(bad[0].msg), JSON.stringify(bad));
    const spaced = await clash((d, sc) => { sc.addChild(d.createNode('hand r')); sc.addChild(d.createNode('hand_r')); }, 'spaced.glb');
    check('names equal after three.js sanitizing (space -> underscore) clash too', spaced.length === 1 && /hand_r_1/.test(spaced[0].msg), JSON.stringify(spaced));
    const dot = await clash((d, sc) => { sc.addChild(d.createNode('Wall.001')); sc.addChild(d.createNode('Plain')); }, 'dot.glb', 'sanitized-name');
    check('Wall.001 warns with authored -> runtime name Wall001; a plain name does not', dot.length === 1 && /"Wall.001"/.test(dot[0].msg) && /"Wall001"/.test(dot[0].msg), JSON.stringify(dot));
    const both = await clash((d, sc) => { sc.addChild(d.createNode('Wall001')); sc.addChild(d.createNode('Wall.001')); }, 'both.glb', 'sanitized-name');
    check('[guard] a sanitized name that also clashes is reported once (as the clash)', both.length === 0 && (await clash((d, sc) => { sc.addChild(d.createNode('Wall001')); sc.addChild(d.createNode('Wall.001')); }, 'both2.glb')).length === 1);
    // [guard] name hints are informational: one line per kind (count + first 3 names, all with --full), and they never count as warnings (--strict would fail every Blender export)
    const many = await clash((d, sc) => { for (let i = 1; i <= 8; i++) sc.addChild(d.createNode(`Wall.00${i}`)); }, 'many.glb', 'sanitized-name');
    const hl = nameHintLines(many, false), hf = nameHintLines(many, true);
    check('[guard] 8 sanitized names are ONE hint line with the count and 3 names; --full lists all; hints are not warnings',
      hl.length === 1 && /8 names that differ/.test(hl[0]) && (hl[0].match(/Wall\.00\d/g) ?? []).length === 3 && /--full/.test(hl[0]) && /getObjectByName/.test(hl[0]) && /Wall\.008/.test(hf[0]) && many.every(i => i.severity === 'info'), hl.join(' | '));
    const fine = await clash((d, sc) => { sc.addChild(d.createNode('weapon').setMesh(d.createMesh('weapon'))); sc.addChild(d.createNode('hand')); }, 'fine.glb');
    check('[guard] distinct names, and a node whose single-primitive mesh has the same name (Blender default), do not warn', fine.length === 0, JSON.stringify(fine));

    // content-check reads the same glb: no places.js description for markers, fromLevel trigger checked against the file
    mkdirSync(join(dir, 'content'));
    writeFileSync(join(dir, 'main.js'), "import { level } from 'threedog'; level({ url: '/models/town.glb' });\n");
    writeFileSync(join(dir, 'content/templates.js'), "export default { door: { model: 'door' } };\n");
    writeFileSync(join(dir, 'content/triggers.js'), "export default { gate: { fromLevel: true, onEnter: {} }, lost: { fromLevel: true, onEnter: {} } };\n");
    writeFileSync(join(dir, 'content/pickups.js'), "export default [{ item: 'bread', place: 'marker_chest' }];\n");
    // KHR_node_visibility: the check lists hidden nodes (the loader half is a spec in engine/tests/specs/collision-layers.mjs)
    {
      const ext = createRequire(resolve(ROOT, 'package.json'))('@gltf-transform/extensions'), d = new Document(); d.createBuffer();
      const vis = d.createExtension(ext.KHRNodeVisibility), sc = d.createScene(), hid = d.createNode('hidden_part'), kid = d.createNode('kid');
      hid.setExtension('KHR_node_visibility', vis.createVisibility().setVisible(false)); hid.addChild(kid); sc.addChild(hid); sc.addChild(d.createNode('shown'));
      const f = join(dir, 'vis.glb'); await new NodeIO().registerExtensions([ext.KHRNodeVisibility]).write(f, d);
      const r = await checkModel(f, {});
      check('assets check lists a node hidden with KHR_node_visibility, in one line', JSON.stringify(r.report.hidden) === '["hidden_part"]' && reportLines(r.report).filter(l => /hidden /.test(l)).length === 1, JSON.stringify(r.report.hidden));
    }
    // model contract (manifest needs): a re-exported hero lost the node Hand_R and the clip Run; checked statically and with the same function the load uses
    {
      const d = new Document(); d.createBuffer();
      const sc = d.createScene(), root = d.createNode('hero'); root.addChild(d.createNode('Hand_L')); sc.addChild(root);
      d.createAnimation('Idle').addChannel(d.createAnimationChannel().setTargetNode(root).setTargetPath('translation'));
      mkdirSync(join(dir, 'public/models'), { recursive: true });
      const f = join(dir, 'public/models/hero.glb'); await new NodeIO().write(f, d);
      const needs = { nodes: ['hero', 'Hand_R'], clips: ['Idle', 'Run'] };
      const declared = declaredNeeds([{ models: { hero: { url: '/models/hero.glb?v=2', needs }, other: { url: '/models/other.glb', needs } } }], dir);
      const msgs = (await checkModel(f, {}, declared)).level.issues.filter(i => i.code === 'model-needs').map(i => i.msg);
      check('assets check: one error for the model that lost a node and a clip, naming both and the closest name', msgs.length === 1 && /node "Hand_R" \(closest in the file: "Hand_L"\)/.test(msgs[0]) && /clip "Run"/.test(msgs[0]), msgs.join('|'));
      // the one url-to-file rule, as the engine resolves it (assetManifest.js): ?v= / # dropped, a pack base gets its slash, remote urls and bases are not ours, no folder name is assumed
      const at = (url, base) => assetFiles(dir, url, base), up = f => f.replace(/[a-z]/g, c => c.toUpperCase());
      check('url to file: tags and base are dropped, case is ignored on Windows, a folder keeps its own file',
        isFileOf(at('hero.glb?v=3#x', '/models/'), f) && isFileOf(at('/models/hero.glb'), f) && !isFileOf(at('/models/sub/hero.glb'), f) && !isFileOf(at('/other/hero.glb'), f)
        && (process.platform !== 'win32' || isFileOf(at('/models/HERO.glb'), up(f))));
      check('url to file: a base without a slash, a relative base, a CDN base or url, // and data: (remote = null)', at('oak.glb', '/packs/forest').path === '/packs/forest/oak.glb'
        && at('oak.glb', 'packs/forest/').path === '/packs/forest/oak.glb' && at('oak.glb', 'https://cdn.x/p/') === null && at('https://x/a.glb') === null && at('//x/a.glb') === null
        && at('data:model/gltf;base64,AA') === null);
      check('url to file: a /root url in a pack with a CDN base is still the game\'s own file (the base places relative urls only)', isFileOf(at('/models/hero.glb', 'https://cdn.x/p/'), f) && isFileOf(at('/models/hero.glb', '//cdn.x/p/'), f));
      // the optimized pack wins the url and keeps the needs (assetManifest.js): the file checked is public/optimized/hero.glb
      const win = declaredNeeds([{ models: { hero: { url: '/models/hero.glb', needs } } }, { name: 'optimized', models: { hero: '/optimized/hero.glb' } }], dir);
      check('needs follow the winning entry: the optimized pack takes the url, the needs stay', win.length === 1 && win[0].files.path === '/optimized/hero.glb' && win[0].needs === needs && isFileOf(win[0].files, join(dir, 'public/optimized/hero.glb')), JSON.stringify(win));
      check('assets check: a model with everything declared present has no needs error', !(await checkModel(f, {}, declaredNeeds([{ models: { hero: { url: '/models/hero.glb', needs: { nodes: ['Hand_L'], clips: ['Idle'] } } } }], dir))).level.issues.some(i => i.code === 'model-needs'));
      // two nodes called Fence: the loader names them Fence and Fence_1, and needs and a { url, node } part read the same names
      const dd = new Document(); dd.createBuffer(); const ds = dd.createScene(); ds.addChild(dd.createNode('Fence')); ds.addChild(dd.createNode('Fence'));
      const ff = join(dir, 'public/models/fence.glb'); await new NodeIO().write(ff, dd);
      const verdict = async entry => (await checkModel(ff, {}, declaredNeeds([{ models: { f: { url: '/models/fence.glb', ...entry } } }], dir))).level.issues.filter(i => i.code === 'model-needs').length;
      check('duplicate names: Fence_1 is found as a needs node and as a part, Fence_2 as neither', await verdict({ needs: { nodes: ['Fence', 'Fence_1'] } }) === 0 && await verdict({ node: 'Fence_1', needs: { nodes: ['Fence_1'] } }) === 0 && await verdict({ needs: { nodes: ['Fence_2'] } }) === 1);
      // load order is the scene's, depth first: node 0 "Fence" is a child of "Post", node 2 "Fence" is a scene root listed first, so the root is "Fence" and the child "Fence_1"
      const od = new Document(); od.createBuffer(); const os = od.createScene(), kid = od.createNode('Fence'), post = od.createNode('Post'), top = od.createNode('Fence');
      post.addChild(kid); os.addChild(top); os.addChild(post);
      const names = loaderNames(od);
      check('node names follow the loader order (scene roots in order, depth first), not the file index', names.get(top) === 'Fence' && names.get(kid) === 'Fence_1' && partNode(od, 'Fence').node === top, JSON.stringify([...names.values()]));
      const gone = (await checkModel(ff, {}, declaredNeeds([{ models: { f: { url: '/models/fence.glb', node: 'Fenc', needs: { nodes: ['a'], clips: ['b'] } } } }], dir))).level.issues.filter(i => i.code === 'model-needs');
      check('a missing part node is one message with the closest name, not every need', gone.length === 1 && /part node "Fenc" is not in the file \(closest in the file: "Fence"\)/.test(gone[0].msg) && !/clip/.test(gone[0].msg), JSON.stringify(gone));
      // runCheck as the CLI calls it: the needs are read from the served file public/models/x.glb (not the source in art/models), for a folder run only
      {
        const gd = join(dir, 'game'); mkdirSync(join(gd, 'art/models'), { recursive: true }); mkdirSync(join(gd, 'public/models'), { recursive: true });
        const mk = async (file, ...names) => { const x = new Document(); x.createBuffer(); const sc = x.createScene(); for (const n of names) sc.addChild(x.createNode(n)); await new NodeIO().write(file, x); };
        await mk(join(gd, 'art/models/x.glb'), 'Hand'); await mk(join(gd, 'public/models/x.glb'), 'Body'); await mk(join(gd, 'public/models/y.glb'), 'Body');
        writeFileSync(join(gd, 'assets.js'), `export default [{ models: { x: { url: '/models/x.glb', needs: { nodes: ['Hand'] } }, y: { url: '/models/y.glb', node: 'Arm' } } }];\n`);
        const out = []; const log = console.log; console.log = (...a) => out.push(a.join(' '));
        let folder, one; try { folder = await runCheck(gd, {}); one = await runCheck(gd, {}, join(gd, 'art/models/x.glb')); } finally { console.log = log; }
        const txt = out.join('\n');
        check('assets check (folder run): needs and a part node are read from the served files and fail the run; a single named file does not report them', folder === 1 && one === 0
          && /model "x".*node "Hand"/.test(txt) && /model "y".*part node "Arm"/.test(txt) && (txt.match(/model "x"/g) || []).length === 1, txt.slice(0, 400));
      }
      const THREE = await import('three'), scene = new THREE.Group(), h = new THREE.Group(); h.name = 'hero'; scene.add(h); const hl = new THREE.Group(); hl.name = 'Hand_L'; h.add(hl);
      const nodes = []; scene.traverse(o => { if (o !== scene && o.name) nodes.push(o.name); });
      const loaded = needsProblems(needs, { nodes, clips: [new THREE.AnimationClip('Idle', 1, [])].map(c => c.name) });
      check('load: the same declaration finds the same two missing parts', loaded.length === 2 && loaded.map(p => p.name).join() === 'Hand_R,Run', JSON.stringify(loaded));
      // dev throws, a release build warns once and ignores the typo (params.js, decision 2026-11-01): either way the message must name the key
      let threw = '';
      const warn = console.warn; console.warn = m => { threw += m; };
      try { readNeeds('models.hero', { node: ['Hand_R'] }); } catch (e) { threw += e.message; } finally { console.warn = warn; }
      check('an unknown key in needs is rejected, with a did-you-mean', /node/.test(threw) && /nodes/.test(threw), threw);
    }
    const g = await checkGame(dir), text = g.errors.join('\n');
    check('content-check: glb marker is a valid place (no description file)', !/marker_chest/.test(text), text);
    check('content-check: fromLevel trigger with no node in the glb is an error, one with a node is fine', /trigger zone lost/.test(text) && !/trigger zone gate/.test(text), text);
    check('content-check: template named in the glb but undefined is an error', /town\/well.*template "well"/.test(text), text);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
