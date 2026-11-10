// The example pages and the first per-module test pages: open world, small town, level, placeables, settings, describe and step,
//   headless mode, runtime option checks, interface conventions, the four cameras.
export const specs = [
  {
    name: '开放世界示例',
    software: false,   // reads pixels only for the save photo, compares none
    url: '/',
    async run({ page, check, ev, frames }) {
      const info = await ev(() => ({ mods: engine.modules.size, loaded: engine.terrain.stats.loaded, player: !!engine.player }));
      check('模块全部装上', info.mods >= 20, `装了 ${info.mods} 个`);
      check('地形区块已加载', info.loaded >= 9, `${info.loaded} 个`);
      check('开场过场正在播放', await ev(() => engine.timeline.playing && !!engine.cameraOverride));
      await page.keyboard.press('Escape'); await frames(2);
      check('Esc 跳过过场且不打开设置菜单', await ev(() => !engine.timeline.playing && !engine.settings.isOpen && !engine.cameraOverride));
      await page.keyboard.press('Escape'); await frames(2);
      check('再按 Esc 打开设置菜单并锁住输入', await ev(() => __t.until(() => engine.settings.isOpen && !engine.input.enabled, 5000).then(() => true, () => false)));   // input contexts apply at the next fixed step
      await page.keyboard.press('Escape'); await frames(2);
      check('再按 Esc 关闭菜单', await ev(() => __t.until(() => !engine.settings.isOpen && engine.input.enabled, 5000).then(() => true, () => false)));

      // 起跳：暂停实时循环后按空格，再用 step 推进 0.3 游戏秒（和帧率、真实时间无关）
      await ev(() => engine.haltLoop());
      await page.keyboard.press('Space');
      const rise = await ev(() => { const y0 = engine.player.position.y; engine.step(0.3, { render: false }); return engine.player.position.y - y0; });
      await ev(() => engine._unhalt());
      check('空格起跳', rise > 0.3, rise.toFixed(2));

      await page.keyboard.press('KeyI'); await frames(2);
      check('I 打开背包', await ev(() => engine.ui.isOpen('inventory')));
      await page.keyboard.press('Escape'); await frames(2);
      check('Esc 关闭背包', await ev(() => !engine.ui.isOpen('inventory') && !engine.settings.isOpen));

      const chop = await ev(() => {
        const p = engine.player.position, t = engine.vegetation.instanceAt(p, { radius: 60, species: '松树' });
        if (!t) return 'no tree';
        engine.vegetation.removeInstance(t.species, t.cx, t.cz, t.id, { regrowSeconds: 600 });
        return engine.vegetation.isRemoved(t.species, t.cx, t.cz, t.id) && engine.saves.collect().parts?.vegetation?.removed?.[engine.vegetation.key(t.species, t.cx, t.cz, t.id)] > 0;
      });
      check('砍树：树被移除并记进植被存档', chop === true, String(chop));

      const save = await ev(() => {
        engine.inventory.add('film', 3, { silent: true }); const n = engine.inventory.count('film');
        engine.saves.save('test'); engine.inventory.remove('film', n); return engine.saves.load('test') && engine.inventory.count('film') === n;
      });
      check('存档后读档，背包数量恢复', save);

      const placed = await ev(async () => {
        await engine.world.whenReady;
        const c = engine.world.get('cabin');
        return { cabin: !!c && !!engine.world.view('cabin'), bodies: engine.world.query({ kind: 'body' }).length, rigid: engine.rigid.bodies.length };
      });
      check('关卡来自内容：小屋（模板实例）已建出，8 个物理道具是有 id 的记录，近处的有刚体', placed.cabin && placed.bodies === 8 && placed.rigid >= 7, JSON.stringify(placed));

      await ev(() => { engine.weather.set('storm', { seconds: 0.01 }); engine.i18n.setLocale('en'); });
      await frames(3);
      check('切换天气', await ev(() => engine.weather.name === 'storm' && engine.weather.current.rain > 0.5));
      check('切换成英文', await ev(() => engine.t('inventory.title') === 'Inventory' && engine.input.label('jump') === 'Space'));
      check('拍照', await ev(() => { const s = engine.ops.run('photo.take', {}, { source: 'test' }).value; return !!s && s.url.startsWith('data:image'); }));
    },
  },
  {
    name: '小城示例（关卡模块、无地形）',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const g = await ev(() => { let boxes = 0; engine.collision.forEachStatic(k => { if (k === 'box') boxes++; }); return { stage: engine.surface(0, -14), ramp: engine.surface(0, -7.2), street: engine.surface(10, 10), boxes }; });
      check('台子高度 1.2 米', Math.abs(g.stage - 1.2) < 0.05, g.stage);
      check('坡道在台子和地面之间', g.ramp > 0.2 && g.ramp < 1.2, g.ramp);
      check('街道高度 0', Math.abs(g.street) < 0.05, g.street);
      check('楼的碰撞盒都建好了', g.boxes >= 40, g.boxes);
      await ev(() => engine.player.position.set(0, engine.surface(0, -14), -14));
      await ev(() => { engine.haltLoop(); engine.step(1.2, { render: false }); engine._unhalt(); });   // 推进 1.2 游戏秒：触发区更新、箱子落地
      check('走上广场触发区', await ev(() => engine.triggers.byTag('plaza')[0]?.inside));
      check('箱子落在地面上', await ev(() => engine.rigid.bodies.every(b => b.body.translation().y > 0.3)));
    },
  },
  {
    name: '关卡模块测试页',
    url: '/tests/level/index.html',
    async run({ check, ev }) {
      const h = await ev(() => [engine.surface(0, 0), engine.surface(5, 0), engine.surface(11, 0)]);
      check('地板 0 / 斜坡 1 / 平台 2', Math.abs(h[0]) < 0.05 && Math.abs(h[1] - 1) < 0.1 && Math.abs(h[2] - 2) < 0.05, h.join(', '));
      check('标记点读出来了', await ev(() => !!engine.level.marker('spawn') && !!engine.level.marker('marker_chest')));
    },
  },
  {
    name: '模板物件与粒子测试页',
    url: '/tests/placeables/index.html',
    async run({ check, ev, wait }) {
      const before = await ev(() => engine.particles.count());
      await ev(() => engine.particles.emit('dust', engine.player.position, { count: 50 }));
      check('粒子爆发', await ev(n => engine.particles.count() > n, before));
      const placed = await ev(async () => { engine.ops.allow(() => engine.content.spawn('sapling', { x: 3, z: 3 }, { id: 'pt-1' })); engine.world.refresh(); await engine.world.whenReady; engine.step(0.2); return !!engine.world.view('pt-1')?.parent; });
      check('放下模板物件', placed);
      await wait(300);
    },
  },
  {
    name: '设置菜单测试页',
    url: '/tests/settings/index.html',
    async run({ page, check, ev, frames }) {
      await page.mouse.click(640, 360); await frames(2);
      await page.keyboard.press('Escape');
      check('Esc 打开设置', await ev(() => __t.until(() => engine.settings.isOpen, 5000).then(() => true, () => false)));
      await ev(() => { engine.settings.rebind('interact', 'KeyF'); engine.settings.set('vol.music', 0.25); });   // settings save to localStorage at once
      await page.keyboard.press('Escape'); await ev(() => __t.until(() => !engine.settings.isOpen, 5000).catch(() => {}));
      await page.reload(); await page.waitForFunction(() => window.engine?.stateApplied, null, { timeout: 60000 });
      check('改键在刷新后保留', await ev(() => engine.input.keysOf('interact').includes('KeyF')));
      check('音量在刷新后保留', await ev(() => Math.abs(engine.settings.get('vol.music') - 0.25) < 0.01));
      await ev(() => engine.settings.resetBindings());
    },
  },
  {
    name: 'settings limits: a game row restricts its own effect like the shadows row',
    url: '/tests/settings/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        const err = f => { try { f(); return ''; } catch (x) { return x.message; } };
        const S = engine.settings, P = 'post.tint.enabled', on = () => engine.stacks.get(P).value();
        const out = { missing: err(() => S.define('tint', true, { limits: P })) };   // the effect does not exist yet
        const h = engine.post.add({ name: 'tint', fuse: { glsl: 'color.rgb *= 0.98;' } });
        S.define('tint', true, { limits: P });
        out.start = on();
        S.set('tint', false); out.off = on();
        // a cutscene (system layer) turns it back on: the player's choice still wins
        const cut = engine.mod(P, { owner: 'cut', set: true, layer: 'system' }); out.cut = on();
        S.set('tint', true); out.back = on(); cut.remove();
        // a number row is a factor 0..1 on a number value
        const L = 'test.sunCap', base = engine.stacks.define(L, { base: 2, min: 0 }).value();
        S.define('sunCap', 1, { limits: L }); S.set('sunCap', 0.5); out.half = engine.stacks.get(L).value() / base;
        S.set('sunCap', 1); out.full = engine.stacks.get(L).value() / base;
        out.dup = err(() => S.define('tint2', true, { limits: P }));
        out.builtin = err(() => S.define('myShadows', true, { limits: 'shadows.enabled' }));
        out.kind = err(() => S.define('tintAmount', 0.5, { limits: P }));
        h.remove();
        return out;
      });
      check('a name that does not exist yet throws and says to define the row after the effect', /no shared value .*Define the row after the effect exists/.test(r.missing), r.missing);
      check('off holds it off; a system-layer write cannot turn it back on; on gives the scene its choice again',
        r.start === true && r.off === false && r.cut === false && r.back === true, JSON.stringify(r));
      check('a number row multiplies a number value (0.5 halves it, 1 frees it)', Math.abs(r.half - 0.5) < 1e-6 && Math.abs(r.full - 1) < 1e-6, JSON.stringify(r));
      check('one row per value: a second row or a built-in row on the same value throws; a factor row on a switch throws',
        r.dup.includes("row 'tint' already limits") && r.builtin.includes("row 'shadows' already limits") && r.kind.includes('holds a value'), JSON.stringify(r));
    },
  },
  {
    // 为什么：old-mine 用 settings.define 加了两行画质开关，菜单里却没有任何一页画它们，玩家够不着、也没人报错。
    // 这里守住一条不变式：每个没写 menu: false 的定义行，菜单所有页扫一遍后一定画出来；画不了、页不存在、被画两遍都要说一次。
    name: 'settings.define rows: the menu draws every defined row once, or says why not',
    url: '/tests/settings/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        const S = engine.settings, out = { warns: [] }, warn = console.warn;
        console.warn = (...a) => { out.warns.push(a.join(' ')); warn(...a); };
        const err = f => { try { f(); return ''; } catch (x) { return x.message; } };
        const applied = [];
        S.define('tRowSwitch', true, v => applied.push(v));                       // 默认进 options 页，标签回落为键名
        S.define('tRowLabel', false, { label: 'settings.shadows', menu: 'graphics' });   // i18n 键做标签，进图形页
        S.define('tRowNum', 2, { min: 1, max: 4, step: 0.5 });
        S.define('tRowPick', 'b', { options: ['a', ['b', 'Bee']] });
        S.define('tRowOwn', true, { menu: false });                             // 游戏自己的页画
        S.define('tRowNoEnds', 3);                                              // 画不了：数字没有两端
        S.define('tRowNowhere', true, { menu: 'nope' });
        S.addSection('tOwnTab', { title: 'Own', render: (t, e, s) => t.row('own', t.toggle('tRowOwn', s.get('tRowOwn'))) + t.row('dup', t.toggle('tRowSwitch', s.get('tRowSwitch'))) });
        out.typo = err(() => S.define('tRowTypo', true, { lable: 'x' }));
        // 'options' 是查找表里的页名：settings({ sections: ['options'] }) 和 addSection('options') 走同一个 _builtin
        out.named = err(() => S.addSection('options'));
        // 选项值只能是字符串/数字/布尔：对象在点击或读档后变成 JSON 副本，=== 永远不等，按钮就丢了选中状态
        out.objChoice = err(() => S.define('tRowObj', 'a', { options: ['a', [{ size: 2 }, 'Big']] }));
        // 全页扫描：每页的 HTML 拼起来，按不变式核对
        const html = {};
        for (const [id] of S._visibleSections()) { S.current = id; html[id] = S._data().body; }
        const all = Object.values(html).join('');
        const drawn = k => (all.match(new RegExp(`data-(set|range)="${k}"`, 'g')) || []).length;
        out.missing = [...S.custom].filter(([k, row]) => row.menu !== false && S.sections.has(row.menu) && !drawn(k)).map(([k]) => k);
        out.options = html.options || '';
        out.graphicsHasLabel = (html.graphics || '').includes(engine.t('settings.shadows')) && (html.graphics || '').includes('data-set="tRowLabel"');
        out.ownOnce = drawn('tRowOwn'); out.noEnds = drawn('tRowNoEnds');
        S.current = 'options'; S.open(); S.win.refresh();
        S.win.el.querySelector('[data-set="tRowSwitch"]')?.click(); out.after = S.get('tRowSwitch'); out.applied = applied.join();
        S.win.el.querySelector('[data-set="tRowPick"][data-value="\\"a\\""]')?.click(); out.pick = S.get('tRowPick');
        S.close(); console.warn = warn;
        return out;
      });
      check("'options' is a tab name the menu knows (sections list, addSection)", r.named === '', r.named);
      check('a choice value that is not a string, number or boolean throws at define', /choice value is a string, number or boolean/.test(r.objChoice), r.objChoice);
      check('every defined row without menu: false is drawn in some tab (scan of every tab)', r.missing.length === 0, r.missing.join());
      check('kinds: switch, slider with the given ends, buttons with [value, label]; label falls back to the key',
        /data-set="tRowSwitch"/.test(r.options) && />tRowSwitch</.test(r.options) && /min="1" max="4" step="0.5" value="2" data-range="tRowNum"/.test(r.options) && />Bee</.test(r.options), r.options.slice(0, 600));
      check('menu names the tab and label is an i18n key', r.graphicsHasLabel);
      check('a click on a drawn row sets it and runs its apply', r.after === false && r.applied === 'true,false' && r.pick === 'a', JSON.stringify(r));
      check('menu: false is left to the own tab (once); a row the menu cannot draw is not drawn', r.ownOnce === 1 && r.noEnds === 0, JSON.stringify(r));
      check('warns once each: undrawable row, missing tab, row drawn twice; a typo in the options throws',
        r.warns.some(w => /tRowNoEnds.*min, max/.test(w)) && r.warns.some(w => /no tab 'nope'/.test(w)) && r.warns.some(w => /draws 'tRowSwitch' itself/.test(w)) && /lable/.test(r.typo),
        JSON.stringify({ warns: r.warns, typo: r.typo }));
    },
  },
  {
    name: '状态描述与确定性步进（开放世界）',
    url: '/',
    async run({ check, ev }) {
      const d = await ev(() => { engine.timeline.skip(); return engine.describe(); });
      const keys = ['time', 'weather', 'player', 'camera', 'nearby', 'ui', 'cutscene', 'modules', 'perf'];
      check('describe 字段齐全', keys.every(k => k in d) && d.time.clock && d.time.season && d.player.ground && d.camera.type === 'follow' && d.perf.chunks, keys.filter(k => !(k in d)).join(','));
      check('describe 可以 JSON.stringify', await ev(() => { const s = JSON.stringify(engine.describe()); return s.length > 100 && JSON.parse(s).modules.length >= 20; }));
      check('附近的东西按距离排好、最多 15 个', d.nearby.length <= 15 && d.nearby.every((x, i, a) => !i || a[i - 1].dist <= x.dist) && d.nearby.some(x => x.kind === 'pickup'), JSON.stringify(d.nearby.slice(0, 3)));
      const text = await ev(() => engine.describeText());
      check('describeText is English and at most 30 lines', !/[一-鿿]/.test(text.split('\n')[0]) && text.includes('Time:') && text.split('\n').length <= 30, text.split('\n').length + ' lines');
      const r = await ev(() => {
        engine.haltLoop();
        const t0 = engine.time.now('real'), p0 = engine.player.position.clone();
        engine.input.autopilot = { x: 0, y: 1, speed: 4 };
        const d = engine.step(10);
        engine.input.autopilot = null;
        return { dt: engine.time.now('real') - t0, moved: engine.player.position.distanceTo(p0), paused: engine.halted, ret: !!d.time };
      });
      check('pause + step(10)：游戏时间前进约 10 秒', r.paused && r.ret && Math.abs(r.dt - 10) < 0.05, r.dt);
      check('step 期间 autopilot 让玩家移动了', r.moved > 5, r.moved);
      const s = await ev(() => { const t0 = performance.now(), c0 = engine.calendar.totalDays; engine.step(600, { render: false }); return { ms: performance.now() - t0, days: engine.calendar.totalDays - c0 }; });
      check('step(600) 在 30 秒内完成，天数前进', s.days > 1.5, `${Math.round(s.ms)} 毫秒（只打印，不判定），${s.days.toFixed(2)} 天`);
      // paused: the engine's onFrame does not run, so count browser animation frames (the loop's own tick) instead of milliseconds
      const still = await ev(async () => { const t = engine.time.now('real'); await new Promise(r => { let k = 0; const f = () => ++k >= 10 ? r() : requestAnimationFrame(f); requestAnimationFrame(f); }); return engine.time.now('real') === t; });
      check('暂停时实时循环不推进', still);
      check('resume 后恢复推进', await ev(async () => { engine._unhalt(); const t = engine.time.now('real'); await __t.until(() => engine.time.now('real') > t, 5000).catch(() => {}); return engine.time.now('real') > t && !engine.halted; }));
    },
  },
  {
    name: '无界面模式（?threedog-headless）',
    url: '/?threedog-headless',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const t0 = engine.time.now('real'); await new Promise(r => setTimeout(r, 300));
        const idle = engine.time.now('real') === t0;
        const d = engine.step(2);
        return { headless: engine.headless, paused: engine.halted, idle, dt: engine.time.now('real') - t0, ok: d.time.headless, loaded: d.perf.chunks.loaded };
      });
      check('启动后处于暂停、不自己推进', r.headless && r.paused && r.idle);
      check('step 可用，时间前进', r.ok && Math.abs(r.dt - 2) < 0.05, r.dt);
      check('地形在无界面模式下也加载了', r.loaded >= 9, r.loaded);
    },
  },
  {
    name: '状态描述（小城示例，无地形）',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const d = await ev(() => engine.describe());
      check('describe 不报错且没有地形/天气字段', !!d.player && !('weather' in d) && !d.perf.chunks && d.time.clock, Object.keys(d).join(','));
      check('附近能看到 NPC 店主', d.nearby.some(x => x.kind === 'npc' && x.name === '店主'), JSON.stringify(d.nearby));
      const text = await ev(() => { engine.haltLoop(); engine.step(1); return engine.describeText(); });
      check('describeText 正常', text.includes('Player:') && text.split('\n').length <= 30);
      const loc = await ev(() => {
        const I18n = engine.i18n.constructor, en = new I18n(engine, { locale: 'en' }), auto = new I18n(engine, { locale: 'auto' });
        return { en: en._t('common.close'), enLocale: en.locale, zh: engine.t('common.close'), auto: auto.locale, def: engine.i18n.locale };
      });
      check("locale: 'en' gives English UI text; 'auto' follows the browser (zh-CN here)", loc.en === 'Close' && loc.enLocale === 'en' && loc.zh === '关闭' && loc.auto === 'zh-CN' && loc.def === 'zh-CN', JSON.stringify(loc));
    },
  },
  {
    name: '运行时检查：选项名写错开发时直接报错带改法；动作名写错提示一次',
    url: '/tests/cameras/index.html?cam=fixed',
    async run({ check, ev }) {
      const r = await ev(async () => {
        // 为什么分两种：选项名拼错走 readParams，开发时抛错（2026-11-01 决定），写错就停在那一行；
        // 动作名每帧都可能查，写错只提示一次，不抛（抛了游戏每帧都死）
        const err = f => { try { f(); return ''; } catch (e) { return e.message; } };
        const out = {};
        const { warns } = await __t.warns(() => {
          for (let i = 0; i < 2; i++) {
            // createEngine 的选项（antialias 拼错）
            out.engine = err(() => { const e2 = new engine.constructor({ canvas: document.createElement('canvas'), ui: { loading: false }, antialas: false, saveKey: 'validate-test' }); e2.renderer.dispose(); });
            // 模块选项：fixedCamera 机位参数（position 拼错）
            out.shot = err(() => engine.cameraRig.add('test', { postion: [0, 5, 5], lookAt: [0, 0, 0] }));
            // 按键动作名（jump 拼错）
            engine.input.pressed('jupm'); engine.input.down('jupm');
          }
        });
        out.added = 'test' in (engine.cameraRig.shots ?? {});
        out.action = warns.filter(w => w.includes('jupm') && w.includes('did you mean')).length;
        out.all = warns;
        return out;
      });
      check('createEngine 选项写错：开发时抛错"你是不是想写 antialias"', r.engine.includes('antialas') && r.engine.includes('`antialias`?'), JSON.stringify(r));
      check('模块选项写错：开发时抛错"你是不是想写 position"，机位没加上', r.shot.includes('postion') && r.shot.includes('`position`?') && !r.added, JSON.stringify(r));
      check('按键动作写错：一条"你是不是想写 jump"', r.action === 1 && r.all.some(w => w.includes('`jump`?')), JSON.stringify(r.all));
      check('没有别的警告', r.all.length === 1, JSON.stringify(r.all));
    },
  },
  {
    name: '运行时检查：npcs.add 字段写错开发时报错（小城示例）',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        let msg = '';
        const { warns } = await __t.warns(() => {
          try { engine.npcs.remove(engine.npcs.add({ name: '路人', position: { x: 3, z: 3 }, scedule: [] })); } catch (e) { msg = e.message; }
        });
        return { msg, warns };
      });
      check('npcs.add 字段写错：抛错"你是不是想写 schedule"，不另外警告', r.msg.includes('scedule') && r.msg.includes('did you mean `schedule`?') && r.warns.length === 0, JSON.stringify(r));
    },
  },
  {
    name: '接口约定：句柄、位置参数、射线并入刚体、贴图缓存键、动作重定义（小城示例）',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        const out = {};
        let warns;
        try {
          ({ warns } = await __t.warns(async () => {
            // 句柄：add / on / clock 都返回 { remove() }，remove 两次无害
            const box = engine.collision.addBox([30, 0, 30], { halfWidth: 2, halfDepth: 1 });
            out.blocked = !engine.collision.walkable({ x: 30, z: 30 });
            box.remove(); box.remove();
            out.free = engine.collision.walkable({ x: 30, z: 30 });
            let n = 0; const sub = engine.events.on('conv:test', () => n++);
            engine.events.emit('conv:test'); sub.remove(); engine.events.emit('conv:test'); out.events = n;
            const t = engine.clock.after(1, () => n++); t.remove(); engine.step(2, { render: false }); out.clock = n;
            out.handles = [engine.onFrame(() => {}), engine.onFixed(() => {}), engine.rays.addStatic([]), engine.budget.metric('conv', () => 0)].every(h => typeof h.remove === 'function' && (h.remove(), true));
            // 位置参数：旧写法（数字）直接报错
            try { engine.collision.addBox(1, 2, 3, 4); out.oldThrows = false; } catch (e) { out.oldThrows = /options argument must be an object.*a position is one argument/.test(e.message) && e.code === 'module-params'; }
            // 射线 targets: 'all' 打到刚体，默认 'static' 打不到
            const b = engine.rigid.bodies.reduce((m, x) => x.object.position.y > m.object.position.y ? x : m), p = b.object.position;
            const from = { x: p.x, y: p.y + 5, z: p.z }, down = [0, -1, 0];
            const all = engine.raycast(from, down, { targets: 'all' }), st = engine.raycast(from, down);
            out.rigidHit = all?.kind === 'rigid' && all.entry === b && all.object === b.object;
            out.staticMiss = !st || st.entry !== b;
            // 贴图：同一张图不同 opts 得到两份
            const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
            const [a, c, a2] = [await engine.assets.texture(url), await engine.assets.texture(url, { color: false }), await engine.assets.texture(url)];
            out.texture = a !== c && a === a2 && c.colorSpace !== a.colorSpace;
            // the same owner binding again replaces its own keys, not a conflict
            engine.input.bind('convAct', ['KeyY']); engine.input.bind('convAct', ['KeyU']);
            out.redefine = engine.input.keysOf('convAct').includes('KeyU') && !engine.input.keysOf('convAct').includes('KeyY');
          }));
        } finally { engine._unhalt(); }
        out.warns = warns;
        return out;
      });
      check('collision.addBox(位置, 选项) 挡住；句柄 remove() 两次无害', r.blocked && r.free, JSON.stringify(r));
      check('events.on / clock.after 的句柄能取消', r.events === 1 && r.clock === 1, JSON.stringify(r));
      check('onFrame / onFixed / addStatic / metric 都返回 { remove() }', r.handles);
      check('旧的位置写法 addBox(x, z, …) 报错说明改法', r.oldThrows);
      check("engine.raycast targets: 'all' 打到刚体（kind 'rigid'、带 entry），默认不打", r.rigidHit && r.staticMiss, JSON.stringify(r));
      check('assets.texture 的 opts 算进缓存键', r.texture);
      check('input.bind 同一主人再绑：后绑的替换，不报警', r.redefine && !r.warns.some(w => w.includes('convAct')), JSON.stringify(r.warns));
    },
  },
  ...['follow', 'first', 'fixed', 'rts'].map(cam => ({
    name: `相机：${cam}`,
    url: `/tests/cameras/index.html?cam=${cam}`,
    async run({ page, check, ev }) {
      const f = await ev(() => engine.cameraRig.forward());
      const p0 = await ev(() => engine.player.position.clone());
      // hold W until the player has walked a bit (by condition, not milliseconds); a timeout leaves moved null and the check fails
      await page.keyboard.down('KeyW');
      await ev(p => __t.until(() => Math.hypot(engine.player.position.x - p.x, engine.player.position.z - p.z) > 1, 10000).catch(() => {}), p0);
      await page.keyboard.up('KeyW');
      const moved = await ev(([p, f]) => { const d = engine.player.position.clone().sub(p); const l = Math.hypot(d.x, d.z); return l > 0.3 ? (d.x * f.x + d.z * f.z) / l : null; }, [p0, f]);
      check('按 W 沿相机前方移动', moved !== null && moved > 0.9, String(moved));
    },
  })),
];
