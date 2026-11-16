// A style pack is a module (recipe 62): switching looks twice leaves the scene, renderer and hooks as they were. Why a test: a leftover light or a stale fog shows only
// as a slightly wrong picture, long after the switch that caused it.
// 不许绕开: every pack and the template is installed for real through the real ctx, and the check reads the three.js objects, so a new direct write in any of their files fails here.
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINE } from '../paths.mjs';
import { copyTemplates } from '../lib/scaffold.mjs';

export const name = 'picture switch: every starter picture and the template are picture modules, and switching twice leaves nothing behind';
const url = (...p) => pathToFileURL(join(ENGINE, '..', ...p)).href;
const PACKS = [['starter-pictures', 'bright-cartoon'], ['starter-pictures', 'ascii-meadow']];

export async function run({ check }) {
  const { THREE } = await import('threedog');
  const { moduleMethods } = await import(pathToFileURL(join(ENGINE, 'core', 'engine', 'modules.js')).href);
  const hooks = new Set(), posts = new Set();
  const handle = (set, v) => { set.add(v); return { set() {}, remove() { set.delete(v); } }; };
  const scene = new THREE.Scene(), background = scene.background = new THREE.Color(0x123456);
  const uniform = v => ({ value: v });
  const e = Object.assign(Object.create(moduleMethods), {
    _modInst: new Map(), _modTracked: new Map(), _borrowed: new WeakMap(), disposed: false,
    scene, tier: 'high', focus: new THREE.Vector3(), camera: new THREE.PerspectiveCamera(),
    renderer: { toneMapping: THREE.LinearToneMapping, shadowMap: { type: THREE.PCFShadowMap }, getPixelRatio: () => 1 },
    uniforms: { uDaylight: uniform(1), uSunDir: uniform(new THREE.Vector3(0, 1, 0)), uWeatherLight: uniform(1), uTime: uniform(0) },
    sky: { dome: { visible: true }, rows: 'start', keyframes(r) { if (r === undefined) return this.rows; this.rows = r; } },   // the template sets the dome's day rows and gives them back (picture/sky.js)
    onRender: fn => handle(hooks, fn), post: { add: fx => handle(posts, fx) },
    shadows: { mapSize() {} }, events: { on: () => ({ remove() {} }) },   // the template sizes its shadow map from engine.tier and follows 'tier:change'
  });
  const state = () => JSON.stringify({ kids: scene.children.length, fog: scene.fog, same: scene.background === background, bg: background.getHex(), tone: e.renderer.toneMapping,
    shadow: e.renderer.shadowMap.type, dome: e.sky.dome.visible, rows: e.sky.rows, hooks: hooks.size, posts: posts.size });
  const start = state();

  // the template holds placeholders until new-game fills them, so it is made for real, inside the repository where 'threedog' resolves
  const game = mkdtempSync(join(ENGINE, '..', 'tools', 'td-pic-'));
  copyTemplates(game, { name: 'g' });
  try {
  for (const dir of [...PACKS, ['tools', basename(game), 'picture']]) {
    const label = dir.at(-1) === 'picture' ? 'template' : dir.at(-1), { createPicture } = await import(url(...dir, 'index.js'));
    const m = createPicture();
    check(`${label}: a type picture module holding the picture slot`, m.type === 'picture' && m.provides.includes('picture') && m.provides.includes('tone'), JSON.stringify(m.provides));
    for (let round = 1; round <= 2; round++) {
      e._modInst.set(m.name, { ac: new AbortController() });
      const api = m.install(e, e._modCtx(m));
      for (const made of [api.ground?.({ size: 2, segments: 1 }), api.water?.({ size: 2, segments: 1 })]) if (made) check(`${label}: ground and water enter the scene`, made.parent === scene);
      check(`${label}: its main light carries the name the sun slot looks for`, scene.getObjectByName('sun')?.isLight === true);
      const disposed = [];
      for (const mat of Object.values(api.materials)) mat.addEventListener('dispose', () => disposed.push(mat));
      for (const h of [...e._modTracked.get(m.name)]) h.remove();
      e._modTracked.delete(m.name);
      check(`${label}: round ${round} leaves scene, renderer and hooks as they were`, state() === start, state());
      check(`${label}: its materials are disposed`, disposed.length === Object.keys(api.materials).length);
    }
  }
  } finally { rmSync(game, { recursive: true, force: true }); }
}
