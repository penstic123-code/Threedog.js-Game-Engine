// 第三次审查：文档代码块真的跑。tests/specs/review3-docs.mjs 把每篇文档的块发到这里（import 已改成 __mod 调用）。
// 为什么用一个"全家桶"引擎：配方的块默认读者已有一个在跑的游戏；每篇文档开一台新引擎，块之间共享顶层变量，和读者一路抄下来一样。
import * as THREE from 'three';
import * as WEBGPU from 'three/webgpu';
import * as THREE_TSL from 'three/tsl';
import * as TD from '../../index.js';
import * as TSL from '../../render/fx/index.js';
import * as NOISE from '@threedog/terrain-noise';
import * as POST from '@threedog/post-effects';
import { serve } from '../../core/threads/threadServe.js';
import * as PIXEL from '../../core/scene/pixel.js';
import * as GRID from '../../core/scene/grid.js';
import * as LAYERS from '../../render/layers.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import * as PASS from 'three/addons/postprocessing/Pass.js';
import { LUTPass } from 'three/addons/postprocessing/LUTPass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import * as BGU from 'three/addons/utils/BufferGeometryUtils.js';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import * as POST_TSL from '@threedog/post-effects/tsl';

const PRESETS = TD.presets;
const base = { ui: { loading: false }, urlState: false, pixelRatio: 1, adaptiveResolution: false };
let n = 0;
const made = [];
// pixelSize decides the render resolution itself, and createEngine refuses both
const createEngine = (o = {}) => { const { pixelRatio, ...own } = base, e = TD.createEngine({ ...own, ...(o.pixelSize ? null : { pixelRatio }), saveKey: `r3doc-${++n}`, ...o }); made.push(e); return e; };
const MODS = { three: THREE, 'three/webgpu': WEBGPU, 'three/tsl': THREE_TSL, threedog: { ...TD, createEngine }, 'threedog/tsl': TSL, 'threedog/worker': { serve },
  'threedog/pixel': PIXEL, 'threedog/grid': GRID, 'threedog/layers': LAYERS, '@threedog/terrain-noise': NOISE, '@threedog/post-effects': POST,
  'three/addons/loaders/GLTFLoader.js': { GLTFLoader }, 'three/addons/postprocessing/EffectComposer.js': { EffectComposer }, 'three/addons/postprocessing/Pass.js': PASS, 'three/addons/postprocessing/LUTPass.js': { LUTPass }, 'three/addons/objects/Reflector.js': { Reflector }, 'three/addons/utils/BufferGeometryUtils.js': BGU, 'three/addons/math/SimplexNoise.js': { SimplexNoise }, '@threedog/post-effects/tsl': POST_TSL, 'some-asset-pack': new Proxy({}, { has: () => true, get: () => () => ({}) }) };
// 相对路径指向读者自己的文件，这里没有：给空壳，让块继续往下跑
const mod = name => { if (name in MODS) return MODS[name]; if (/^\.\.?\//.test(name)) return new Proxy({}, { get: (t, k) => k === Symbol.toPrimitive ? undefined : function stub() {} }); throw new Error(`NOIMPORT ${name}`); };
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const host = window.engine = TD.createEngine({ canvas: document.getElementById('host'), ...base, saveKey: 'r3doc-host' });
await host.start();
host.haltLoop();

/** 读者手里那台已经在跑的游戏 */
async function kitchen() {
  document.getElementById('view')?.remove();
  document.body.appendChild(Object.assign(document.createElement('canvas'), { id: 'view', width: 160, height: 120 }));
  const e = createEngine({ canvas: document.getElementById('view'), bindings: { ...PRESETS.bindings.walk } });
  const T = TD;
  e.use(T.openWorld({ camera: 'follow', seed: 7, terrain: NOISE.terrainPreset(), calendar: PRESETS.calendar.fourSeasons, weather: PRESETS.weather.temperate }), T.interactions({ ...PRESETS.interactions.nearest }), T.dialogue(), T.inventory(), T.pickups(), T.quests(), T.hud(), T.content(), T.particles(), T.photo());
  e.characters.addPlayer({ ...PRESETS.player.thirdPerson, spawn: { x: 4, z: 7 } });
  await e.start();
  e.haltLoop();
  const use = e.use.bind(e);   // 配方里写的 engine.use(xxx()) 在已装了同名模块的全家桶里不算错
  e.use = (...ms) => use(...ms.flat().filter(m => !m?.name || !e.describe().modules.includes(m.name)));
  return e;
}

const withTime = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('TIMEOUT block did not settle')), ms))]);

window.hasImport = (src, name) => !(src in MODS) || name in MODS[src];
window.freshKitchen = kitchen;
window.TD = TD;

/** 跑一篇文档的所有块。每块：{ n, line, code } → { n, line, kind, msg } */
window.runDoc = async blocks => {
  for (const e of made.splice(0)) { try { e.dispose(); } catch { /* 上一篇的块可能已把它弄坏 */ } }
  const engine = await kitchen();
  // A block's own `const engine = createEngine(...)` shows how to start one; the blocks after it read as code in the reader's running game, so they stay on the kitchen
  const scope = Object.assign(Object.create(null), TD, { createEngine, engine, e: engine, THREE, canvas: document.getElementById('view'), player: engine.player, dt: 1 / 60, opts: {}, game: {}, __keep(o) { for (const k in o) if (o[k] !== undefined && k !== 'engine' && k !== 'e') scope[k] = o[k]; } });
  const renew = async () => { const fresh = await kitchen(); scope.engine = scope.e = fresh; scope.canvas = document.getElementById('view'); scope.player = fresh.player; };
  const out = [];
  for (const b of blocks) {
    let kind = 'ok', msg = '';
    const late = [];
    const onErr = ev => late.push(String(ev.reason?.message ?? ev.reason ?? ev.message));
    window.addEventListener('unhandledrejection', onErr); window.addEventListener('error', onErr);
    try {
      // with 需要非严格函数；块本身在内层 async 函数里，这样 await 和顶层 var 都成立
      const f = new Function('__mod', '__s', `with (__s) { return (async () => {\n${b.code}\n})(); }`);
      // 引擎的循环停着，块里等帧的东西（传送、过场）要有人推
      const pump = setInterval(() => { try { scope.engine?.step?.(1 / 60); } catch { /* 块结束后再看 engine.error */ } }, 8);
      try { await withTime(f(mod, scope), 8000); } finally { clearInterval(pump); }
      for (const live of new Set([scope.engine, made.at(-1)])) {
        if (live?.step) for (let i = 0; i < 4; i++) { live.step?.(1 / 60); await Promise.resolve(); }
        if (live?.error) throw live.error;
      }
      // a block that swaps a part (engine.use(x, { replaces })) leaves a game the next block does not assume
      if (/\breplaces:/.test(b.code)) await renew();
    } catch (err) {
      kind = err instanceof ReferenceError || / is not defined$/.test(err?.message) ? 'ref' : err instanceof SyntaxError ? 'syntax' : /^TIMEOUT/.test(err?.message) ? 'timeout' : /^NOIMPORT/.test(err?.message) ? 'import' : 'error';
      msg = `${err?.name}: ${String(err?.message ?? err).split('\n')[0]}`.slice(0, 260);
      // 被错误冻住的游戏不走公开接口救不回来：下一块换一台新的，这样不碰内部字段
      if (scope.engine?.error) await renew();
    }
    await new Promise(r => setTimeout(r, 0));
    window.removeEventListener('unhandledrejection', onErr); window.removeEventListener('error', onErr);
    if (kind === 'ok' && late.length) { kind = 'late'; msg = late[0].slice(0, 260); }
    out.push({ n: b.n, line: b.line, kind, msg });
  }
  return out;
};
