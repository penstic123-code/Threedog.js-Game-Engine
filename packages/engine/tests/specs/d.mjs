// Batch 3, group D specs (same format as the other files here):
// game clock, story variables and old-save migration, content loader (custom conditions, props), game flow and fades, timeline fade, objective marker HUD.
export const specs = [
  {
    name: 'D 游戏时钟：at / daily / after 存档（开放世界）',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.timeline.skip(); engine.haltLoop();
        const cal = engine.calendar, out = {};
        let n18 = 0; const at18 = engine.calendar.at('18:00', () => n18++);
        cal.timeOfDay = (17 + 59 / 60) / 24; engine.step(0.05, { render: false });
        engine.saves.save('d-clock');
        engine.step(10, { render: false });
        out.at = n18;
        engine.saves.load('d-clock'); engine.step(0.05, { render: false });
        out.noReplay = n18 === 1;
        at18.remove();
        let days = 0; const daily = engine.calendar.daily(() => days++);
        engine.mod('clock.rate', { owner: 'test', set: 60 }); cal.timeOfDay = 0.5; engine.step(0.05, { render: false });
        engine.step(18, { render: false });   // a day is 360 calendar seconds ÷ 60x = 6 seconds per day
        out.daily = days; daily.remove(); engine.mod('clock.rate', { owner: 'test', set: 1 });
        return out;
      });
      check('at(18:00): step(10) from 17:59 fires once', r.at === 1, r.at);
      check('load only resets the baseline, no catch-up firing', r.noReplay);
      check('step 3 days: daily fires 3 times', r.daily === 3, r.daily);
      const a = await ev(() => {
        let fired = 0; engine.events.on('d:due', () => fired++);
        engine.clock.after(120, 'd:due', { data: { x: 1 } });
        engine.saves.save('d-after');
        engine.step(60, { render: false });
        engine.saves.load('d-after');
        engine.step(70, { render: false });
        const early = fired;
        engine.step(60, { render: false });
        return { early, fired };
      });
      check('after(120, eventName) still expires after load and fires only once', a.early === 0 && a.fired === 1, JSON.stringify(a));
    },
  },
  {
    name: 'D 剧情变量 engine.vars（开放世界）',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        const c = engine.content, v = engine.vars;
        c.run([{ setFlag: 'dTest' }, { bump: 'dCount' }, { bump: 'dCount' }]);
        const shared = engine.dialogue.state.flags === v.flags && v.counter('dCount') === 2;
        engine.saves.save('d-vars');
        v.setFlag('dTest', false); v.bump('dCount', 5);
        engine.saves.load('d-vars');
        const restored = v.flag('dTest') === true && v.counter('dCount') === 2 && engine.dialogue.state.flags.dTest === true;
        const parts = engine.saves.collect().parts;
        return { shared, restored, newFormat: !!parts.vars && parts.flags === undefined && !('counters' in parts.quests) };
      });
      check('dialogue flags and quest counters both point to engine.vars', r.shared);
      check('save → load restores flags and counters', r.restored);
      check('new saves write only vars / clock', r.newFormat);
    },
  },
  {
    name: 'D 内容装载器：游戏词表、摆放物（开放世界）',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        const c = engine.content, cal = engine.calendar;
        cal.timeOfDay = 0.8; const late = c.test({ timeAfter: '18:00' });
        cal.timeOfDay = 0.5; const early = c.test({ timeAfter: '18:00' });
        c.condition('dAlways', { ref: 'any', test: () => true });
        let ran = 0; if (!engine.ops.defs.has('d.effect')) engine.ops.define('d.effect', { run: (e, a) => { ran += a.v === 'x' ? 1 : 0; } }); c.run({ op: ['d.effect', { v: 'x' }] });
        const W = engine.world, props = W.query({ kind: 'prop' }), built = props.filter(p => W.view(p.id)), solid = props.filter(p => p.collide);
        return { late, early, custom: c.test({ dAlways: 1 }) && ran === 1, props: props.length, solid: solid.length, ids: props.every(p => /^prop:/.test(p.id)) && new Set(props.map(p => p.id)).size === props.length,
          home: c.place('home'), colliders: solid.filter(p => W.view(p.id)?.userData.colliders.length).length, solidBuilt: solid.filter(p => W.view(p.id)).length, built: built.length, inScene: built.every(p => !!W.view(p.id).parent) };
      });
      check('custom condition { timeAfter: "18:00" } works (game content/rules.js)', r.late && !r.early, JSON.stringify(r));
      check('conditions registered in code and game ops called from content ({ op }) are usable', r.custom, JSON.stringify(r));
      check('props are world records of kind prop, with stable unique ids', r.props === 7 && r.ids, JSON.stringify(r));
      check('props with collide (4): every built model has collision', r.solid === 4 && r.solidBuilt > 0 && r.colliders === r.solidBuilt, JSON.stringify(r));
      check('props near the start are built and in the scene', r.built > 0 && r.inScene, `${r.built} built`);
    },
  },
  {
    name: 'D 游戏流程：transition 渐黑与锁输入、paused 冻结（小城）',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const tick = () => new Promise(r => setTimeout(r, 0));
        engine.haltLoop();
        const fade = () => +getComputedStyle(document.querySelector('.threedog-fade')).opacity;
        const events = []; engine.events.on('flow:transition', x => events.push(x.phase));
        let ran = false;
        const p = engine.flow.transition(() => { ran = true; }, { fade: 0.2, autosave: false });
        await tick(); engine.step(0.25, { render: false }); await tick();
        const mid = { locked: !engine.input.enabled, dark: fade() > 0.99, ran };
        for (let i = 0; i < 10; i++) { engine.step(0.05, { render: false }); await tick(); }
        await p;
        const end = { unlocked: engine.input.enabled, clear: fade() < 0.01, events: events.join(',') };
        engine.flow.go('paused');
        const t0 = engine.time.now('real'); engine.step(1, { render: false });
        const frozen = engine.time.now('real') === t0 && engine.flow.state === 'paused' && !engine.input.enabled;
        engine.flow.go('playing');
        engine.step(0.5, { render: false });
        return { mid, end, frozen, resumed: engine.time.now('real') > t0 && engine.input.enabled };
      });
      check('input locked and .threedog-fade opaque during transition', r.mid.locked && r.mid.dark, JSON.stringify(r.mid));
      check('input restored, screen clear and fn ran after transition', r.end.unlocked && r.end.clear && r.mid.ran, JSON.stringify(r.end));
      check('flow:transition emits start and end', r.end.events === 'start,end', r.end.events);
      check("after go('paused'), step does not advance game time", r.frozen);
      check("go('playing') resumes", r.resumed);
      const tp = await ev(async () => {
        const tick = () => new Promise(r => setTimeout(r, 0));
        const it = engine.interactions.items.find(i => i.label === '传送到另一个台子');
        const target = engine.level.marker('marker_gate_b').position;
        it.onUse(it.object, { actor: engine.actor });
        for (let i = 0; i < 30; i++) { engine.step(0.05, { render: false }); await tick(); }
        const p = engine.player.position;
        return Math.hypot(p.x - target.x, p.z - target.z);
      });
      check('example: the teleport pad uses transition to send the player to the other pad', tp < 3, tp);
    },
  },
  {
    name: 'D 时间轴 fade 步骤与 cutscene=skip（小城）',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const tick = () => new Promise(r => setTimeout(r, 0));
        engine.haltLoop();
        const fade = () => +getComputedStyle(document.querySelector('.threedog-fade')).opacity;
        const p = engine.timeline.play([{ fade: 0.2 }, { wait: 5 }, { fade: 0.2, to: 0 }]);
        await tick(); engine.step(0.3, { render: false }); await tick();
        const dark = fade() > 0.99;
        engine.timeline.skip();
        for (let i = 0; i < 5; i++) { await tick(); engine.step(0.05, { render: false }); }
        await p;
        const cleared = fade() < 0.01 && !engine.timeline.playing;
        engine.modules.get('timeline').applyState(engine, { cutscene: 'skip' });
        const res = await engine.timeline.play([{ wait: 100 }]);
        engine.modules.get('timeline').applyState(engine, { cutscene: 'keep' });
        return { dark, cleared, skipped: res.ending === 'skipped', keep: !engine.timeline.skipAll };
      });
      check('{ fade: 0.2 } fades to black', r.dark);
      check('after skipping, the following { fade, to: 0 } completes at once and the screen clears', r.cleared);
      check("after applyState cutscene: 'skip', cutscenes are skipped from the start; 'keep' restores", r.skipped && r.keep);
    },
  },
  {
    name: 'D 目标指示 HUD（开放世界）',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.timeline.skip(); engine.haltLoop(); engine.step(0.1);
        const cam = engine.camera, dir = cam.getWorldDirection(new __threedogThree.Vector3());
        const behind = cam.position.clone().addScaledVector(dir, -30), front = cam.position.clone().addScaledVector(dir, 30);
        const m = engine.hud.marker(behind, { label: 'D 测试' });
        engine.step(0.05);
        const r = m.el.getBoundingClientRect(), W = innerWidth, H = innerHeight;
        const edge = m.el.classList.contains('threedog-hud-arrow') && (r.left < 60 || r.right > W - 60 || r.top < 60 || r.bottom > H - 60);
        m.target = front; engine.step(0.05);
        const onScreen = !m.el.classList.contains('threedog-hud-arrow') && m.onScreen;
        const d = engine.describe().hud;
        const zh = m.el.textContent;
        engine.i18n.setLocale('en'); engine.step(0.05);
        const en = m.el.textContent;
        engine.i18n.setLocale('zh-CN');
        m.remove();
        const quest = d.markers.some(x => x.label === engine.quests.defs.get('first-light').title);
        return { edge, onScreen, count: d.markers.length, quest, zh, en, film: d.counters.film };
      });
      check('target behind: arrow at the screen edge', r.edge);
      check('turned to face it: becomes an on-screen marker', r.onScreen);
      check('describe().hud.markers has a count (including automatic quest markers)', r.count >= 2 && r.quest, JSON.stringify(r));
      check('distance text changes after switching to English', /米/.test(r.zh) && / m/.test(r.en) && !/米/.test(r.en), `${r.zh} → ${r.en}`);
      check('example: film counter', r.film === 12, r.film);
      const u = await ev(() => {
        engine.hud.bar('dtest', { value: 0.5, label: '体力' });
        const el = [...document.querySelectorAll('.threedog-hud-bar')].at(-1), fill = el.querySelector('.threedog-hud-bar-fill');
        let n = 0; const mo = new MutationObserver(l => { n += l.length; }); mo.observe(el, { childList: true, subtree: true, attributes: true });
        engine.hud.bar('dtest', { value: 0.5, label: '体力' });
        return new Promise(res => setTimeout(() => {
          const same = n;
          engine.hud.bar('dtest', { value: 0.7 });
          setTimeout(() => { mo.disconnect(); const kept = el.querySelector('.threedog-hud-bar-fill') === fill; engine.hud.remove('dtest'); res({ same, kept, fill: el.style.getPropertyValue('--threedog-hud-fill') }); }, 0);
        }, 0));
      });
      check('hud.bar value unchanged: DOM untouched; value-only change: not rebuilt', u.same === 0 && u.kept && u.fill === '0.7', JSON.stringify(u));
    },
  },
  {
    name: 'D 游戏时钟：between 时段开关（登记、跨边界、回拨、读档都对齐）',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.timeline.skip(); engine.haltLoop();
        const cal = engine.calendar;
        let on = null, calls = 0;
        cal.timeOfDay = 0.5; engine.step(0.05, { render: false });
        const range = engine.calendar.between('18:00', '06:00', { on: () => { on = true; calls++; }, off: () => { on = false; calls++; } });
        const out = { noon: on };
        cal.timeOfDay = (17 + 59 / 60) / 24; engine.step(0.05, { render: false }); out.before = on;
        engine.step(10, { render: false }); out.after = on;
        const n = calls; engine.step(1, { render: false }); out.noRepeat = calls === n;
        engine.saves.save('d-between');
        await engine.applyState({ time: '12:00' }); out.rewound = on;
        await engine.saves.load('d-between'); out.loaded = on;   // the 'save:loaded' event (sky re-aligns its ranges) fires when the Promise settles
        cal.timeOfDay = 0.1; engine.step(0.05, { render: false }); out.night = on;
        range.remove();
        return out;
      });
      check('aligned to the current time on registration (12:00 → off)', r.noon === false, JSON.stringify(r));
      check('off at 17:59, on after step crosses 18:00, then no repeated calls', r.before === false && r.after === true && r.noRepeat, JSON.stringify(r));
      check('applyState back to 12:00 turns off at once; load back to 18:0x turns on at once', r.rewound === false && r.loaded === true, JSON.stringify(r));
      check('range crossing midnight: 02:24 is on', r.night === true, JSON.stringify(r));
    },
  },
  {
    name: 'D 时间概念：钟点定时在 calendar、倍速改变时游戏秒与日历钟点同步（固定步秒不变）',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.timeline.skip(); engine.haltLoop();
        const cal = engine.calendar, out = { moved: !engine.clock.at && !engine.clock.between && !engine.clock.daily && !engine.clock.onSeason };
        const dl = cal.dayLength;
        const run = scale => {
          engine.mod('clock.rate', { owner: 'test', set: scale }); cal.timeOfDay = 0.25;
          const n0 = engine.clock.now, t0 = cal.timeOfDay; let fixed = 0;
          const h = engine.onFixed(dt => { fixed += dt; });
          engine.step(2, { render: false }); h.remove();
          return { game: engine.clock.now - n0, sky: cal.timeOfDay - t0, fixed };
        };
        out.x1 = run(1); out.x10 = run(10);
        let nowt = 0; const s = engine.calendar.onSeason('summer', () => nowt++);
        cal.day = cal._ends[0]; cal.timeOfDay = 0.999; engine.mod('clock.rate', { owner: 'test', set: 60 }); engine.step(0.05, { render: false }); s.remove();
        engine.mod('clock.rate', { owner: 'test', set: 1 }); out.season = cal.season; out.seasonHits = nowt; out.dl = dl;
        return out;
      });
      check('clock no longer has at / between / daily / onSeason', r.moved);
      check('rate 1: 2 fixed-step seconds = 2 calendar seconds = sky advances 2/dayLength days', Math.abs(r.x1.game - 2) < 0.05 && Math.abs(r.x1.sky - 2 / r.dl) < 0.002 && Math.abs(r.x1.fixed - 2) < 0.05, JSON.stringify(r.x1));
      check('rate 10: fixed-step seconds stay 2; calendar seconds and sky time of day run 10x faster', Math.abs(r.x10.fixed - 2) < 0.05 && Math.abs(r.x10.game - 20) < 0.5 && Math.abs(r.x10.sky - 20 / r.dl) < 0.01, JSON.stringify(r.x10));
      check('cal.onSeason fires on entering summer', r.season === 'summer' && r.seasonHits === 1, JSON.stringify([r.season, r.seasonHits]));
    },
  },
  {
    name: 'D 对话走游戏时间（step 推进打字，打字中 choose 先补全）',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.timeline.skip(); engine.haltLoop();
        const d = engine.dialogue, ui = () => engine.describe().ui.dialogue;
        d.define('d-test', { start: { text: '一二三四五六七八九十', choices: [{ text: 'A', next: 'a' }, { text: 'B', next: 'b' }] }, a: { text: '选了A' }, b: { text: '选了B' } });
        d.start('d-test');
        const opened = ui().typing;
        engine.step(0.1, { render: false });
        const partial = document.querySelector('.threedog-dlg-text').textContent.length;   // the default 'dialogue' UI part draws the typed part
        engine.step(1, { render: false });
        const done = ui();
        d.end(); d.start('d-test');
        engine.ops.run('dialogue.choose', { index: 1 });
        const picked = ui()?.text;
        d.end();
        return { opened, partial, typing: done.typing, choices: done.choices.length, picked };
      });
      check('just opened and typing; step 0.1 s types a few characters', r.opened && r.partial > 0 && r.partial < 10, JSON.stringify(r));
      check('after step 1 s typing is done and 2 choices appear', !r.typing && r.choices === 2, JSON.stringify(r));
      check('choose(1) while typing completes the text first, then picks', r.picked === '选了B', JSON.stringify(r));
    },
  },
  {
    name: 'D 对话通用：节点 data 自定义字段传给界面件和 dialogue:line；气泡通道不锁输入、到时自己结束、和主对话同时在、NPC 用 npc.talk 走气泡；写错键报错指向 data',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.timeline.skip(); engine.haltLoop();
        const d = engine.dialogue, lines = [];
        let typo = '';
        const { warns } = await __t.warns(() => {
          d.define('d-gen', { start: { text: 'Hi', data: { portrait: 'fisher', mood: 'tired' }, next: 'b' }, b: { text: 'Bye', choices: [{ text: 'ok', data: { icon: 'x' } }] } });
          // 节点里写了不认识的键：开发时 define 就抛错（readParams 规矩），信息指向 data 字段
          try { d.define('d-typo', { start: { text: 'x', portrait: 'p' } }); } catch (e) { typo = e.message; }
        });
        engine.events.on('dialogue:line', x => lines.push(x));
        d.start('d-gen'); engine.step(1, { render: false });
        const o = { line0: lines[0], locked: !engine.input.enabled };
        engine.ops.run('dialogue.advance'); engine.step(1, { render: false });
        o.choiceData = document.querySelector('.threedog-dlg-opts button')?.textContent;
        d.end();
        // a bubble line: input stays free, it ends by itself after its seconds
        const p = d.say('Reloading!', { speaker: 'Mira', channel: 'bubble', at: engine.player.root, seconds: 2 });
        engine.step(1, { render: false });
        o.barkInput = !engine.input.contexts.includes('dialog'); o.locks = engine.input.contexts.slice(1); o.barkShown = engine.describe().ui.bubbles?.[0]?.text;
        let ended = false; p.then(() => { ended = true; });
        engine.step(0.5, { render: false }); await null; o.earlyEnd = ended;
        engine.step(3, { render: false }); await null; await null; o.barkEnded = ended && !d.bubbles().length;
        // a bubble never cuts into the main dialogue: both run at once
        d.start('d-gen');
        const hey = d.say('Hey!', { channel: 'bubble', seconds: 1 });
        engine.step(0.2, { render: false });
        o.kept = d.active?.speaker === 'd-gen' && d.bubbles().length === 1; hey.remove(); d.end();
        // an NPC's interact op npc.talk with channel 'bubble': its script plays over its head, input stays free, busy clears when the lines end
        d.define('d-bark', { start: { text: 'Fresh fish!' } });
        engine.npcs.add({ id: 'd-bark', name: 'Seller', interact: { op: 'npc.talk', args: { channel: 'bubble' } }, position: { x: 2, z: 2 }, schedule: [] });
        engine.step(0.2, { render: false });
        const talked = engine.ops.run('npc.talk', { npc: 'd-bark', channel: 'bubble' });
        engine.step(0.2, { render: false });
        o.npcTalk = { ok: talked.ok, code: talked.code, active: !!d.active, bubble: d.bubbles()[0]?.text, locked: engine.input.contexts.includes('dialog'), busy: engine.world.get('d-bark').busy };
        o.npcBubble = talked.ok && !d.active && o.npcTalk.bubble === 'Fresh fish!' && !o.npcTalk.locked && o.npcTalk.busy;
        engine.step(6, { render: false }); await null; await null;
        o.npcBubbleDone = !d.bubbles().length && !engine.world.get('d-bark').busy;
        engine.npcs.remove('d-bark');
        o.typo = typo; o.warns = warns;
        return o;
      });
      check('节点 data 原样随 dialogue:line 发出（含 script / node / speaker）', r.line0?.data?.portrait === 'fisher' && r.line0.script === 'd-gen' && r.line0.node === 'start' && r.locked, JSON.stringify(r.line0));
      check('默认对话框照常画出带数字键的选项', r.choiceData === '1. ok', r.choiceData);
      check('气泡不加输入锁、describe().ui.bubbles 列出它', r.barkInput && r.barkShown === 'Reloading!', JSON.stringify(r));
      check('气泡到 seconds 自己结束', !r.earlyEnd && r.barkEnded, JSON.stringify(r));
      check('气泡和主对话同时在，互不打断', r.kept, JSON.stringify(r));
      check('NPC 的 npc.talk { channel: bubble }：台词在头顶、不锁输入，说完 busy 清掉', r.npcBubble && r.npcBubbleDone, JSON.stringify(r));
      check('节点写了不认识的键：开发时报错并指向 data，没有另外的警告', /portrait/.test(r.typo) && /data: \{/.test(r.typo) && !r.warns.some(w => /portrait/.test(w)), JSON.stringify([r.typo, r.warns]));
    },
  },
  {
    name: 'D 目标 { nearest } / setTarget、雨雪可见',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.timeline.skip(); engine.haltLoop();
        const p = engine.player.position, ks = engine.world.query({ kind: 'pickup', where: k => k.item === 'berry' });
        const dist = k => Math.hypot(k.position.x - p.x, k.position.y - p.y, k.position.z - p.z);
        const best = ks.reduce((a, k) => (dist(k) < dist(a) ? k : a));
        const m = engine.hud.marker({ nearest: 'berry' });
        engine.step(0.05);
        const want = Math.round(Math.hypot(best.position.x - p.x, best.position.y + 2.2 - p.y, best.position.z - p.z));
        const nearestOk = m.dist === want;
        m.setTarget(() => null); engine.step(0.05);
        const hidden = m.el.hidden && engine.describe().hud.markers.at(-1).visible === false;
        m.remove();
        await engine.applyState({ weather: 'rain' }); engine.step(0.1);
        const w = engine.describe().weatherDraw, named = !!engine.scene.getObjectByName('weather-rain')?.visible, text = engine.describeText();
        await engine.applyState({ weather: 'clear' }); engine.step(0.1);
        const dry = engine.describe().weatherDraw.rainVisible;
        return { nearestOk, dist: m.dist, want, hidden, rain: w.rainVisible, named, dry, text };
      });
      check('{ nearest: berry } points at the nearest berry', r.nearestOk, JSON.stringify({ dist: r.dist, want: r.want }));
      check('setTarget(function returning null) → hidden, describe shows visible=false', r.hidden);
      check('rain: describe().weatherDraw.rainVisible, object name weather-rain, state text says "on screen: raindrops"; false when clear', r.rain && r.named && r.dry === false && /on screen: raindrops/.test(r.text), JSON.stringify({ ...r, text: r.text.split('\n')[2] }));
    },
  },
  // ---------- Seams (review 6.8): UI focus stack, trigger zone exit, freezing, repeated content load, load ----------
  {
    name: 'D 接缝：Esc 前台栈（对话吞掉 Esc、栈空才开菜单）（小城）',
    url: '/tests/city/index.html',
    async run({ page, check, ev, frames }) {
      await ev(() => { window.dSaid = engine.dialogue.say('测试台词'); });
      await frames(2);
      await page.keyboard.press('Escape'); await frames(3);
      check('Esc during dialogue: settings menu does not open, dialogue stays', await ev(() => !engine.ui.isOpen('settings') && !!engine.dialogue.active));
      await ev(() => engine.dialogue.end()); await frames(2);
      await page.keyboard.press('Escape'); await frames(3);
      check('Esc after dialogue ends: settings menu opens', await ev(() => engine.ui.isOpen('settings')));
      await page.keyboard.press('Escape'); await frames(3);
      check('Esc again: menu closes, input unlocked', await ev(() => !engine.ui.isOpen('settings') && engine.input.enabled));
      const r = await ev(() => {
        let ended = 0;
        engine.dialogue.start('写错的对话名', 'start', () => ended++);
        return { ended, active: !!engine.dialogue.active };
      });
      check('wrong dialogue name: onEnd is still called (the NPC is not stuck in dialogue)', r.ended === 1 && !r.active, JSON.stringify(r));
    },
  },
  {
    name: 'D 接缝：触发区删除发 exit、flow.transition 出错也亮回来、findSpawn 不假设地形（小城）',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.haltLoop();
        const p = engine.player.position, log = [];
        const sub = engine.events.on('trigger:exit', d => log.push(d.tag));
        const t = engine.triggers.add({ position: { x: p.x, z: p.z }, radius: 3, tag: 'dRemove' });
        const o = engine.triggers.add({ position: { x: p.x, z: p.z }, radius: 3, tag: 'dOnce', once: true });
        engine.step(0.1, { render: false });
        const inside = t.inside;
        t.remove(); t.remove();
        sub.remove();
        engine._unhalt();   // fades follow real-time frames: while paused it would wait forever
        let threw = false;
        try { await engine.flow.transition(() => { throw new Error('d-test'); }, { fade: 0.01, autosave: false }); } catch { threw = true; }
        await new Promise(r => { const h = engine.onFixed(() => { h.remove(); r(); }); });   // context pops apply on the next fixed step
        const fade = getComputedStyle(document.querySelector('.threedog-fade')).getPropertyValue('--threedog-fade').trim();
        const s = engine.characters.findSpawn({ x: 0, z: 8 });
        return { inside, log, once: o.used && engine.triggers.list().includes(o), threw, fade, unlocked: engine.input.enabled, transitioning: engine.flow.transitioning,
          spawn: { y: s.y, walk: engine.collision.walkable(s) } };
      });
      check('remove() on a zone the player is still inside: exit fires first', r.inside && r.log.includes('dRemove'), JSON.stringify(r.log));
      check('once zone used up after entering (kept, re-armed per playthrough): exit fires too', r.once && r.log.includes('dOnce'), JSON.stringify(r.log));
      check('transition fn throws: error propagates to the caller, screen fades back in, input unlocked', r.threw && Number(r.fade) === 0 && r.unlocked && !r.transitioning, JSON.stringify(r));
      check('findSpawn finds a walkable point in a flat level (height 0 m)', Math.abs(r.spawn.y) < 0.05 && r.spawn.walk, JSON.stringify(r.spawn));
    },
  },
  {
    name: 'D 接缝：冻结时任务不完成、时间轴不推进；内容重复装载不重复挂监听（开放世界）',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.timeline.skip(); engine.haltLoop();
        engine.quests.define('dFrozen', { title: 'd', steps: [{ text: 'd', done: () => true }] });
        engine.quests.start('dFrozen');
        let ended = false;
        engine.freeze('d-test');
        engine.timeline.play([{ wait: 0.5 }], { actors: [] }).then(() => { ended = true; });
        engine.step(2, { render: false });
        await Promise.resolve();
        const frozen = { quest: engine.quests.isDone('dFrozen'), timeline: ended || !engine.timeline.playing };
        engine.stacks.get('freeze').release('d-test');
        engine.step(1, { render: false });
        for (let i = 0; i < 5; i++) await Promise.resolve();
        const after = { quest: engine.quests.isDone('dFrozen'), timeline: ended };
        // content: running the same marker again leaves no stale one; trigger effects from two loads count once each
        const c = engine.content, n0 = engine.hud.markers.length;
        c.run({ marker: 'home' }); c.run({ marker: 'home' });
        const markers = engine.hud.markers.length - n0;
        c.run({ clearMarker: 'home' });
        // clearing names the marker: its id need be no place (a level marker that is gone with its level threw "Place not found" here)
        c.run({ marker: { id: 'dNoPlace', x: 1, z: 2 } });
        const idMarked = c.markers.has('dNoPlace');
        c.run({ clearMarker: 'dNoPlace' });
        const idCleared = idMarked && !c.markers.has('dNoPlace');
        const p = engine.player.position;
        c.load({ triggers: { dA: { position: { x: p.x + 200, z: p.z }, radius: 2, onEnter: [{ bump: 'dTrigA' }] } } });
        c.load({ triggers: { dB: { position: { x: p.x + 400, z: p.z }, radius: 2, onEnter: [{ bump: 'dTrigB' }] } } });
        engine.player.position.x += 200; engine.step(0.1, { render: false });
        const bumps = engine.vars.counter('dTrigA');
        engine.player.position.x -= 200; engine.step(0.1, { render: false });
        return { frozen, after, markers, bumps, ready: c.ready, idCleared };
      });
      check('[guard] clearMarker clears by id, whether or not the id is a place', r.idCleared, JSON.stringify(r));
      check('while frozen: quest does not complete even when its condition is met, timeline wait does not finish', !r.frozen.quest && !r.frozen.timeline, JSON.stringify(r));
      check('after unfreezing: quest completes, timeline finishes', r.after.quest && r.after.timeline, JSON.stringify(r));
      check('marker effect run repeatedly: only one marker remains', r.markers === 1, r.markers);
      check('content.load twice: trigger enter effect runs only once', r.bumps === 1, r.bumps);
      check('vegetation and prop models are all ready (content.ready)', r.ready);
    },
  },
  {
    name: 'D 接缝：跨关卡读档等关卡加载完、旧关卡的触发区被清掉、NPC 只拆模型（小城）',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.saves.save('d-level');
        const plaza0 = engine.triggers.byTag('plaza').length, npc0 = !!engine.npcs.get('店主');
        // second map: a flat plot (built in code, registered in the asset manifest)
        const T = __threedogThree;
        engine.assets.manifest({ models: { 'd-level2': () => {
          const g = new T.Group(), floor = new T.Mesh(new T.BoxGeometry(40, 1, 40), new T.MeshBasicMaterial());
          floor.name = 'ground'; floor.position.y = -0.5; g.add(floor); return g;
        } } });
        await engine.level.load('d-level2');
        engine.step(0.1);   // zone changed (world.zone); the next frame tears down the other level's models
        const swapped = { plaza: engine.triggers.byTag('plaza').length, npc: !!engine.npcs.get('店主'), npcModel: !!engine.npcs.get('店主')?.root };
        const ret = engine.saves.load('d-level');
        const promise = typeof ret?.then === 'function';
        await ret;
        return { plaza0, npc0, swapped, promise, back: engine.level.ready && !!engine.level.marker('trigger_plaza') };
      });
      check('level change: old level trigger zones removed; NPCs (using level markers) only lose their models, data stays', r.plaza0 === 1 && r.npc0 && r.swapped.plaza === 0 && r.swapped.npc && !r.swapped.npcModel, JSON.stringify(r));
      check('cross-level load: saves.load returns a Promise, level is loaded when it resolves', r.promise && r.back, JSON.stringify(r));
    },
  },
];
