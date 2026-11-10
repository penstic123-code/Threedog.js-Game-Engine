// The picture menu (engine.catalog('picture'), core/inspect/pictureMenu.js) and the combination checks (core/inspect/pictureChecks.js).
// The non-bypassable checks: every effect @threedog/post-effects exports carries `about`, and what it says about where it runs is what its
// definition declares (one declaration, so the menu's "runs here" cannot drift from the chain's hold); every recipe pointer in the menu names a
// file and heading that exist; each combination rule fires on a scene that has the mistake and stays quiet on the same scene without it.
// Page: tests/probes (gray floor, red wall, headless); every case puts back what it changed.
import { readFileSync, existsSync } from 'node:fs';
import * as THREE from 'three';
import * as main from '@threedog/post-effects';
import * as tsl from '@threedog/post-effects/tsl';
import { runsOnWebGL, runsOnWebGPU, runsHere } from '../../render/postRuns.js';
import { parseDocRef } from '../../core/base/docRef.js';

const RECIPES = new URL('../../docs/recipes/', import.meta.url);
/** 'recipes/34-x.md §"Heading"' or '§3b' (the one pointer spelling, core/base/docRef.js) -> null when the file and heading exist, else what is missing */
function badPointer(p) {
  const r = parseDocRef(p ?? ''), m = r && /^recipes\/([\w.-]+\.md)$/.exec(r.file);
  if (!m) return `not a recipe pointer: ${p}`;
  const f = new URL(m[1], RECIPES);
  if (!existsSync(f)) return `no file ${m[1]}`;
  const heads = readFileSync(f, 'utf8').split('\n').filter(l => /^#+ /.test(l)).map(l => l.replace(/^#+\s+/, '').trim());
  const want = r.sec ? r.sec + '.' : r.title;   // §3b is the heading that starts "3b."; a written heading is its start, as `threedog how --read` reads it
  return !want || heads.some(h => h.startsWith(want)) ? null : `no heading "${want}" in ${m[1]}`;
}

// factories that need an argument to build a definition (the rest take none)
const ARGS = { lightVolumes: { bounds: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)) }, paletteLut: [0x000000, 0xffffff] };

export const specs = [
  {
    name: 'picture menu: every effect declares about once (runs-here facts match its definition, recipe pointers exist), rows read live, names reach menu and module, five checks fire and stay quiet',
    software: true,   // the lit-twice case bakes a small probe grid, which reads rendered pixels
    url: '/tests/probes/index.html',
    async run({ check, ev }) {
      // node side: the package itself, as the CLI reads it (tools/threedog/catalog.mjs offeredEffects)
      const facts = [], offered = [];
      for (const [k, f] of Object.entries({ ...main, ...tsl })) {
        if (typeof f !== 'function') continue;
        const d = f(ARGS[k]);
        if (!d?.slot) continue;   // paletteLut: a texture for lut(), not an effect
        const a = f.about, nodeOnly = !runsOnWebGL(d);
        facts.push({ k, ok: !!a && ['low', 'medium', 'high'].includes(a.cost) && [a.on, a.recipe, a.limits].every(s => typeof s === 'string' && s.length > 8)
          && d.about === a && !!a.webgpuOnly === nodeOnly && runsOnWebGPU(d) && d.backend === a.backend && !!d.skipOnLowTier === !!a.skipOnLowTier, pointer: badPointer(a?.recipe) });
        if (a) offered.push({ name: k, ...a });
      }
      const r = await ev(async (offered) => {
        const { THREE } = threedogTest, e = engine, s = e.scene, R = e.renderer, out = {};
        e.step(0.05);   // one frame drawn: the shadow-box rule waits for the first one (the game aims its sun per frame)
        const ids = () => e.describe().render.checks.map(c => `${c.id}/${c.kind}`);
        out.base = ids();
        // the menu
        const m0 = e.catalog('picture', { offered }), fog0 = s.fog;
        s.fog = new THREE.Fog(0x808080, 1, 50);
        const m1 = e.catalog('picture', { offered });
        s.fog = fog0;
        out.menu = { kind: m0.kind, env: m0.env, fogOff: m0.rows.find(x => x.id === 'fog')?.on, fogOn: m1.rows.find(x => x.id === 'fog')?.on,
          bloom: m0.rows.find(x => x.id === 'bloom'), voxelGI: m0.rows.find(x => x.id === 'voxelGI'), pointers: m0.rows.map(x => x.recipe), n: m0.rows.length,
          bare: e.catalog('picture').more, ownRow: null };
        const own = e.post.add({ name: 'myLook', slot: 'hdr', params: {}, create: () => ({ render() {}, setSize() {}, dispose() {} }) });
        out.menu.ownRow = e.catalog('picture').rows.find(x => x.id === 'myLook');
        own.remove();
        // metal-no-env
        const env0 = s.environment, ball = new THREE.Mesh(new THREE.SphereGeometry(0.5), new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.2 }));
        ball.name = 'metalBall'; ball.position.set(0, 1, 2); s.add(ball);
        s.environment = null; out.metalOn = ids();
        s.environment = new THREE.Texture(); out.metalOff = ids();
        s.environment = env0; ball.removeFromParent();
        // fog-horizon
        const bg0 = s.background;
        s.background = new THREE.Color(0x000000); s.fog = new THREE.Fog(0xffffff, 1, 50); out.fogOn = ids();
        s.fog = new THREE.Fog(0x000000, 1, 50); out.fogOff = ids();
        // a sky dome around the camera hides the background color (examples/webgpu-tsl): its horizon is the game's, so no claim
        const dome = new THREE.Mesh(new THREE.SphereGeometry(400), new THREE.MeshBasicMaterial({ side: THREE.BackSide, fog: false }));
        s.add(dome); s.fog = new THREE.Fog(0xffffff, 1, 50); out.fogDome = ids(); dome.removeFromParent();
        s.fog = fog0; s.background = bg0;
        // bloom-before-exposure: stand-ins that declare what they do (about.acts), under names of their own: the rule reads the declaration, never the name
        // (no frame runs between add and remove, so nothing is built)
        const tone0 = R.toneMapping, ex0 = R.toneMappingExposure, stub = () => ({ render() {}, setSize() {}, dispose() {} });
        const b = e.post.add({ name: 'glowy', slot: 'hdr', order: 30, params: { threshold: 0.85, strength: 0.35 }, about: { acts: 'glow' }, create: stub });
        R.toneMapping = THREE.ACESFilmicToneMapping; R.toneMappingExposure = 0.4; out.bloomOn = ids();
        R.toneMappingExposure = 1; out.bloomOff = ids();
        // an exposure effect after the glow: its value lives on the GPU, so the note says unknown even at renderer exposure 1; before the glow, quiet again
        const auto = e.post.add({ name: 'myExposure', slot: 'hdr', order: 800, about: { acts: 'exposure' }, create: stub });
        out.autoAfter = e.describe().render.checks.find(c => c.id === 'bloom-before-exposure')?.text ?? '';
        auto.remove();
        const autoFirst = e.post.add({ name: 'myExposure', slot: 'hdr', order: 10, about: { acts: 'exposure' }, create: stub });
        out.autoBefore = ids(); autoFirst.remove();
        R.toneMappingExposure = 0.4; b.set({ strength: 0 }); out.bloomZero = ids();   // no glow at all: nothing to say
        const named = e.post.add({ name: 'bloom2', slot: 'hdr', params: { threshold: 0.85, strength: 0.35 }, create: stub });   // bloom-like name, nothing declared
        out.undeclared = ids(); named.remove();
        b.remove(); R.toneMapping = tone0; R.toneMappingExposure = ex0;
        // shadow-box: a light whose box sits far away from the caster in front of the camera, then over it
        const sm0 = R.shadowMap.enabled, sun = new THREE.DirectionalLight(0xffffff, 1), box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
        sun.name = 'testSun'; sun.castShadow = true; Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 200 }); sun.shadow.camera.updateProjectionMatrix();
        box.name = 'crate'; box.castShadow = true; box.position.set(0, 0.5, 3);
        // the page's own shadow lights would cover the crate (the rule asks every box), so they are off for this case
        const others = []; s.traverse(o => { if (o.isLight && o.castShadow) { others.push(o); o.castShadow = false; } });
        s.add(sun, sun.target, box); R.shadowMap.enabled = true;
        sun.position.set(500, 50, 0); sun.target.position.set(500, 0, 0); s.updateMatrixWorld(true); out.boxOn = ids();
        sun.position.set(0, 50, 3); sun.target.position.set(0, 0, 3); s.updateMatrixWorld(true); out.boxOff = ids();
        out.boxOther = null; others.forEach(o => { o.castShadow = true; });
        sun.position.set(500, 50, 0); sun.target.position.set(500, 0, 0); s.updateMatrixWorld(true); out.boxOther = others.length ? ids() : null;   // another light covers it: quiet
        s.remove(sun, sun.target, box); R.shadowMap.enabled = sm0;
        // lit-twice: a small real bake, the engine's sky fill on (fires), then every fill light and the environment at 0 (quiet)
        const set = await e.bakeProbes({ bounds: { min: [-3, 0.5, -1], max: [3, 1.5, 1] }, spacing: 3, resolution: 8, owner: 'menu-test' });
        const fills = []; s.traverse(o => { if (o.isAmbientLight || o.isHemisphereLight) fills.push([o, o.intensity]); });
        fills.forEach(([o]) => { o.intensity = 1; }); out.twiceOn = ids(); out.twiceText = e.describe().render.text.split('\n').find(l => l.startsWith('picture check lit-twice'));
        fills.forEach(([o]) => { o.intensity = 0; }); const envI = s.environmentIntensity; s.environmentIntensity = 0; out.twiceOff = ids();
        fills.forEach(([o, v]) => { o.intensity = v; }); s.environmentIntensity = envI; set.remove();
        out.after = ids();
        // a game module named 'picture' (the game template has one): the bare name stays the menu, 'module:picture' reaches the module
        e.use({ name: 'picture' }); await e.loading.settled();
        const bare = e.catalog('picture'), mod = e.catalog('module:picture');
        out.names = { bare: bare?.kind, same: bare?.sameNameModule, mod: mod?.kind, modId: mod?.id, cap: e.catalog('capability:post')?.kind, op: e.catalog('op:nope') };
        return out;
      }, offered);
      const J = JSON.stringify, M = r.menu;
      check('[guard] every exported effect carries about (cost class, how, recipe, limits), and its definition carries the same object and the same backend / skipOnLowTier / WebGPU-only facts',
        facts.length >= 14 && facts.every(f => f.ok), J(facts.filter(f => !f.ok)));
      check('[guard] every recipe pointer names a file and heading that exist (effects and three\'s rows)', [...facts.map(f => f.pointer), ...M.pointers.map(badPointer)].every(x => !x),
        J([...facts.map(f => f.pointer), ...M.pointers.map(badPointer)].filter(Boolean)));
      check('menu: kind menu with renderer facts; fog row reads the scene live (off, then on)', M.kind === 'menu' && M.env.renderer && M.fogOff === false && M.fogOn === true, J(M));
      check('menu: an offered effect is a row with its own facts; voxelGI runs only on three\'s WebGPU backend, else says why', M.bloom?.cost === 'medium' && M.bloom.runs === 'yes' && M.bloom.on === false
        && (M.env.backend === 'webgpu' ? M.voxelGI.runs === 'yes' : /^(held|no): /.test(M.voxelGI.runs)), J([M.bloom, M.voxelGI, M.env]));
      check('menu: with nothing offered it says where the rest is; a game effect with no about is listed as not declared', /threedog catalog picture/.test(M.bare ?? '') && M.ownRow?.from === 'game' && /not declared/.test(M.ownRow.limits), J([M.bare, M.ownRow]));
      check('no check fires on the plain test scene, before or after the cases', r.base.length === 0 && r.after.length === 0, J([r.base, r.after]));
      // kind: 'mistake' only where the settings prove it; 'note' where only the drawn picture could (the rule in pictureChecks.js)
      const has = (l, id) => l.some(x => x.startsWith(id + '/'));
      const rule = (id, kind, on, off) => check(`[guard] ${id}: a ${kind} with the setting, quiet without it`, on.includes(`${id}/${kind}`) && !has(off, id), J({ on, off }));
      rule('metal-no-env', 'note', r.metalOn, r.metalOff);
      rule('fog-horizon', 'note', r.fogOn, r.fogOff);
      check('fog-horizon: quiet when a sky dome is around the camera (its horizon is not known)', !has(r.fogDome, 'fog-horizon'), J(r.fogDome));
      rule('bloom-before-exposure', 'note', r.bloomOn, r.bloomOff);
      check('bloom-before-exposure: quiet when bloom has strength 0', !has(r.bloomZero, 'bloom-before-exposure'), J(r.bloomZero));
      check('[guard] bloom-before-exposure reads the declared order: an exposure effect after the glow is named with its value unknown; one before it, quiet; a name alone is nothing; the package bloom and autoExposure declare glow / exposure',
        main.bloom.about.acts === 'glow' && tsl.autoExposure.about.acts === 'exposure' && /glowy .*runs before myExposure.*unknown/.test(r.autoAfter) && !has(r.autoBefore, 'bloom-before-exposure') && !has(r.undeclared, 'bloom-before-exposure'), J([r.autoAfter, r.autoBefore, r.undeclared]));
      rule('shadow-box', 'note', r.boxOn, r.boxOff);
      check('shadow-box: quiet when another shadow light covers that caster', r.boxOther === null || !has(r.boxOther, 'shadow-box'), J(r.boxOther));
      rule('lit-twice', 'mistake', r.twiceOn, r.twiceOff);
      const N = r.names;
      check("[guard] names: 'picture' is the menu even beside a module of that name, which 'module:picture' reaches; 'capability:' and 'op:' pick their kind",
        N.bare === 'menu' && N.same === 'module:picture' && N.mod === 'module' && N.modId === 'picture' && N.cap === 'capability' && N.op === null, J(N));
      // the shared rule on WebGPURenderer, which this WebGL page cannot show: what the chain refuses there, the menu must not call runnable
      const gpu = { renderer: { isWebGPURenderer: true, backend: { isWebGPUBackend: true } } }, quiet = () => {};
      const createOnly = runsHere({ create: quiet }, gpu), glslOnly = runsHere({ fuse: { glsl: 'c' } }, gpu), both = runsHere({ create: quiet, node: quiet }, gpu);
      check('[guard] runs here on WebGPURenderer: create()-only and GLSL-only fuse say no (switching on throws), node() runs', createOnly?.held === false && glslOnly?.held === false && both === null,
        J([createOnly, glslOnly, both]));
      check('describe text carries the check as one "what, then Fix:" line', /^picture check lit-twice: probe light .* Fix: /.test(r.twiceText ?? ''), r.twiceText);
    },
  },
];
