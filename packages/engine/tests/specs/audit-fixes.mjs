// 审计修复（2026-11-02）的"不许绕开"检查：每条守一个根因，改回旧写法就红。
// 纯逻辑的（stacks / wrap / time 频道 / 着色器报错 / 补丁热重载 / describe 渲染归属 / 植被 mount / CLI 帮助）直接在 Node 里 import 模块跑，
// 不进页面；要真引擎的（move.* 在 setup 可用、densityMap 图片的错误与 dispose）在 /tests/terrain-edit/ 页面里起无头引擎。
// Run: npm test -- "AUDIT"      Same format as the other files here.
import * as THREE from 'three';
import { Stacks } from '../../core/ops/stacks.js';
import { Wraps } from '../../core/ops/wrap.js';
import { Time } from '../../core/time/time.js';
import { nameShaderErrors } from '../../render/shaderErrors.js';
import { patchMaterial, replacePatchCode } from '../../render/patches.js';
import { recordRender } from '../../core/inspect/describeRender.js';
import { Vegetation } from '../../modules/vegetation/Vegetation.js';
import { VegetationDraw } from '../../modules/vegetation/draw.js';

/** 吞掉 console.warn / error 跑 fn，返回打印的行（stacks 同层两个 set 会 warnOnce，着色器报错走 console.error） */
function quiet(fn) {
  const lines = [], w = console.warn, e = console.error;
  console.warn = console.error = (...a) => lines.push(a.map(String).join(' '));
  try { fn(); } finally { console.warn = w; console.error = e; }
  return lines;
}

export const specs = [
  {
    name: 'AUDIT pure logic: stack re-take is a new latest entry, wrap snapshots its chain, time channels load late, shader log kept, hot reload skips uniforms',
    url: '/tests/terrain-edit/',
    async run({ check }) {
      // 1. 同一 owner 再 take：成为"最新"（top 归它、同层 set 归它），旧句柄 remove() 不删新值
      const S = new Stacks({});
      const cam = S.define('cam', { kind: 'top' });
      S.mod('cam', { owner: 'a', value: 'A' }); S.mod('cam', { owner: 'b', value: 'B' }); S.mod('cam', { owner: 'a', value: 'A2' });
      check("stacks: kind 'top' a, b, a again → a's new value is in charge", cam.value() === 'A2' && cam.top().owner === 'a', JSON.stringify(cam.top()));
      S.define('x');
      const h1 = S.mod('x', { owner: 'o', mul: 0.5 }), h2 = S.mod('x', { owner: 'o', mul: 0.8 });
      h1.remove();
      check('stacks: the old handle of a re-taken owner ends nothing (new mul stays)', S.get('x').has('o') && Math.abs(S.get('x').value() - 0.8) < 1e-9, String(S.get('x').value()));
      h2.remove();
      check('stacks: the current handle still ends it', !S.get('x').has('o'));
      S.define('y');
      S.mod('y', { owner: 'a', set: 1 });
      let refused = false; try { S.mod('y', { owner: 'b', set: 2 }); } catch { refused = true; }
      S.mod('y', { owner: 'a', set: 3 });
      check('stacks: a second owner setting a value on one layer is refused, the first owner can still change it', refused && S.get('y').value() === 3, String(S.get('y').value()));

      // 8. 调用中 remove 某层包装：这一次调用照旧走完整条链，不跳不重
      const W = new Wraps({}), obj = { f: x => x }, log = [];
      let hb = null;
      const ha = W.wrap(obj, 'f', (next, x) => { log.push('a'); return next(x); }, { owner: 'a' });
      hb = W.wrap(obj, 'f', (next, x) => { log.push('b'); ha.remove(); return next(x); }, { owner: 'b' });
      W.wrap(obj, 'f', (next, x) => { log.push('c'); return next(x); }, { owner: 'c' });
      obj.f(1);
      check('wrap: removing a wrapper during a call neither skips nor repeats one (this call)', log.join('') === 'cba', log.join(''));
      log.length = 0; obj.f(1);
      check('wrap: the next call no longer has it', log.join('') === 'cb', log.join('')); hb.remove();

      // 9. 读档时还没定义的频道：channel() 定义时补上存档的 now 和事件定时
      const parts = {}, eng = { saves: { define: (n, o) => { parts[n] = o; } } };
      eng.stacks = new Stacks(eng);
      const T = new Time(eng);
      parts.time.load({ channels: { world: 5, player: 5, enemies: 42 }, timers: [{ channel: 'enemies', due: 50, event: 'boom', data: 1 }] });
      T.channel('enemies');
      check('time: a channel defined after load gets its saved now and event timers', T.now('enemies') === 42 && T._timers.filter(t => t.ch === 'enemies').length === 1,
        JSON.stringify({ now: T.now('enemies'), timers: T._timers }));

      // 7. 有 ERROR 行时，解释之后仍附完整原日志（警告不丢）
      const r = { debug: {} }; nameShaderErrors(r);
      const sh = (src, log, ok) => ({ src, log, ok });
      const gl = { getShaderInfoLog: s => s.log, getShaderParameter: s => s.ok, getShaderSource: s => s.src, getProgramInfoLog: () => '' };
      const out = quiet(() => r.debug.onShaderError(gl, {}, sh('void main(){}', '', true),
        sh('a\nb\nc\nd\ne\n', "WARNING: 0:3: 'x' : unused variable\nERROR: 0:5: 'y' : undeclared identifier", false))).join('\n');
      check('shader errors: the explanation is followed by the full log (warnings kept)', out.includes("shader error in the material's own fragment") && out.includes("WARNING: 0:3: 'x'"), out);

      // 6. GLSL 热重载只改补丁代码的已知字段：uniforms 里放成环的 Object3D 也无害；字符串 / 槽位 / 锚点写法都换得到
      const holder = new THREE.Group(); holder.add(new THREE.Object3D());   // parent <-> children: a cycle
      const mat = new THREE.MeshStandardMaterial();
      const pStr = { name: 'audit-str', slot: 'clipPosition', glsl: 'gl_Position.x += auditOld;', pars: 'uniform float auditOld;', uniforms: { auditOld: { value: holder } } };
      const pObj = { name: 'audit-obj', glsl: { vertex: { begin_vertex: { after: 'transformed.y += auditOld;' } } }, uniforms: { uHold: { value: holder } } };
      // 注：patchMaterial 入口的 toAnchors 把 glsl 换成只含字符串的新对象，所以经公开 API 成环对象进不了 p.glsl；这条是回归检查（热重载三种写法都换到、
      // uniforms 里的成环对象无害），不是能复现旧栈溢出的检查。replacePatchCode 只走已知字段是防内部表示以后变了再踩
      patchMaterial(mat, [pStr, pObj]);
      let changed = null, err = '';
      try { changed = replacePatchCode([mat], 'auditOld', 'auditNew'); } catch (e) { err = String(e).split('\n')[0]; }
      // 读回 onBeforeCompile 拼出的着色器：旧名一个不剩、新名在（补丁对象可能是内部拷贝，所以看产物不看对象）
      const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} };
      if (!err) try { mat.onBeforeCompile(shader, {}); } catch (e) { err = 'compile: ' + String(e).split('\n')[0]; }
      const vs = shader.vertexShader;
      check('patches: hot reload with an Object3D (cycle) in uniforms does not recurse into it, and swaps string glsl, pars and object glsl',
        !err && changed?.length === 1 && !vs.includes('auditOld') && (vs.match(/auditNew/g) ?? []).length >= 3, err || vs.split('\n').filter(l => /audit/.test(l)).join(' | '));

      // 5. 游戏自带渲染器（owned false）：色调曲线是游戏的，不是 engine。518b27ee 起"谁在写"由 owned 记录说（_oTone 交给 manual，
      //    describeRender 的 tone.writer 读它出 'game'），_renderBase 只记渲染器是不是引擎建的
      const e1 = { renderer: { toneMapping: 4 } }; recordRender(e1, { owned: false });
      const e2 = { renderer: { toneMapping: 4 } }; recordRender(e2, { owned: true });
      check("describeRender: a game-supplied renderer's tone mapping is the game's (owned record manual -> writer 'game'); the engine's own renderer is owned",
        e1._oTone.on === false && e2._oTone.on === true && e1._renderBase.owned === false && e2._renderBase.owned === true,
        JSON.stringify([e1._renderBase, e1._oTone.on, e2._renderBase, e2._oTone.on]));

      // 3. mount 一株不剩：数据里的记录和碰撞清空并告诉外观；外观把旧网格拆掉并释放
      let disposed = 0;
      const old = { dispose: () => { disposed++; } }, removed = [], told = [];
      const c = { cx: 0, cz: 0, plants: { grass: { n: 1 } }, colliders: { grass: [1] }, collidersAll: { grass: [1] } };
      const V = { species: new Map([['grass', {}]]), host: { CHUNK: 32 }, _removed: new Map(), applyEdits: Vegetation.prototype.applyEdits, _emit: (k, cc, n) => told.push(k + ':' + n) };
      Vegetation.prototype.mount.call(V, c, 'grass', { n: 0, k: [] });
      VegetationDraw.prototype.change.call({ kinds: new Map(), meshes: new Map([[c, { group: { remove: o => removed.push(o) }, ims: { grass: old } }]]) }, c, 'grass');
      check('vegetation mount: an empty result drops the record and its colliders, the picture drops the old mesh (removed + disposed)',
        !c.plants.grass && !c.colliders.grass && told.includes('change:grass') && disposed === 1 && removed[0] === old,
        JSON.stringify({ plants: Object.keys(c.plants), disposed, colliders: Object.keys(c.colliders), told }));
    },
  },
  {
    software: true,   // reads rendered pixels: stays on software rendering (same pixels on every machine)
    name: 'AUDIT engine: move.* exists right after characters() is installed; a late densityMap image error is caught, one arriving after dispose rebuilds nothing',
    url: '/tests/terrain-edit/',
    expectErrors: /densityMap url \/audit-no-such-map\.png did not load/,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine, vegetation, characters, THREE } = threedogTerrain;
        const out = {}, wait = ms => new Promise(res => setTimeout(res, ms));
        const make = key => createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, urlState: false, saveKey: key });
        // 2. 文档示例：setup 里先 mod 再造角色
        const M = make('audit-move');
        M.use(characters());
        try { M.mod('move.speed', { owner: 'mud', mul: 0.5 }); out.move = M.stacks.get('move.speed').value('player', 4); } catch (e) { out.move = String(e.message); }
        M.dispose();
        // 4a. init 取走 _pending 之后（engine 还没 ready）加的物种：没人 await，错误必须被接住，不成 unhandled rejection
        let unhandled = 0; const onU = ev2 => { if (String(ev2.reason).includes('audit-no-such-map')) { unhandled++; ev2.preventDefault(); } };
        window.addEventListener('unhandledrejection', onU);
        const geo = new THREE.ConeGeometry(0.4, 1, 4);
        const E = make('audit-veg');
        E.use(vegetation({ chunkSize: 16, viewChunks: 1 }), { name: 'audit-late', type: 'rules', after: ['vegetation'], init(e) {
          out.readyAtInit = e.ready;
          e.vegetation.define('late', { geometry: geo, rule: { perChunk: 5 }, densityMap: { url: '/audit-no-such-map.png', size: [64, 64] } });
          out.pendingLeft = e.vegetation._pending.length;
        } });
        E.setGround({ height: () => 0, slope: () => 0, type: () => 'lawn' });
        await E.start();
        await wait(600);
        out.unhandled = unhandled;
        // 4b. 图片到之前 dispose：之后不再 rebuild
        const cv = document.createElement('canvas'); cv.width = cv.height = 2; const g = cv.getContext('2d'); g.fillStyle = '#808080'; g.fillRect(0, 0, 2, 2);
        let rebuilt = 0; E.vegetation.host.rebuild = () => { rebuilt++; };
        E.vegetation.define('gone', { geometry: geo, rule: { perChunk: 5 }, densityMap: { url: cv.toDataURL(), size: [64, 64] } });
        E.dispose();   // registerSpecies and the ground host's own dispose() call rebuild themselves: count only what comes after
        const before = rebuilt;
        await wait(600);
        out.rebuilt = rebuilt - before;
        window.removeEventListener('unhandledrejection', onU);
        return out;
      });
      check("characters(): engine.mod('move.speed') works in setup before any character exists", r.move === 2, JSON.stringify(r.move));
      check('vegetation: a densityMap url added after init is not left in _pending and its failure is caught (no unhandled rejection)',
        r.readyAtInit === false && r.pendingLeft === 0 && r.unhandled === 0, JSON.stringify(r));
      check('vegetation: a density image arriving after engine.dispose() rebuilds nothing', r.rebuilt === 0, JSON.stringify(r));
    },
  },
];
