// 界面件 engine.ui：每块界面（加载、提示、标题、HUD 标记 / 计数 / 进度条、对话框、交互提示、任务日志、触屏摇杆按钮）都能换成游戏自己的或关掉；设置可选分页。页面 tests/ui。
// [守] 全关模式下引擎不许画出任何界面 DOM：谁绕开 engine.ui 直接建元素，这条就会红。

const DOM = ['.threedog-loading', '.threedog-toast', '.threedog-title', '.threedog-hud-marker', '.threedog-hud-counter', '.threedog-hud-bar', '.threedog-hud-button', '.threedog-hud', '.threedog-dlg', '.threedog-prompt', '.threedog-win-quests', '.threedog-stick', '.threedog-touch-bar'];

export const specs = [
  {
    // the acceptance game had to add its own ?play because shot could not get past the engine's title
    name: 'UI title: the ?play URL key (shot --play) starts a run the way Start does: title closed, unfrozen, session:start fired',
    url: '/tests/ui/index.html?mode=default&play',
    async run({ check, ev }) {
      const r = await ev(() => __t.until(() => engine.stateApplied, 10000).then(() => ({ open: engine.ui.isOpen('title'), dom: !!document.querySelector('.threedog-title'),
        frozen: engine.stacks.get('freeze').has('ui-title'), playing: engine.session.playing, run: engine.runState.state })));
      check('title closed and gameplay unfrozen once the URL state is applied', !r.open && !r.dom && !r.frozen && r.playing && r.run !== 'title-frozen', JSON.stringify(r));
    },
  },
  {
    // a rerun by keys used to play the last autosave (Enter picks Continue), and a bare inputLocked sent a script through describe to learn why
    name: 'UI title: inputLocked names the title in its facts; applyState({ fresh }) deletes the saves, so the title has no Continue',
    url: '/tests/ui/index.html?mode=default',
    async run({ check, ev }) {
      const r = await ev(async () => {
        await __t.until(() => engine.stateApplied, 10000);
        engine.interactions.add(engine.player.root, { id: 'lock-test', label: 'x', radius: Infinity, onUse() {} });
        const locked = engine.ops.run('interaction.use', { id: 'lock-test' });
        await engine.saves.save('auto');
        engine.ui.close('title'); engine.ui.open('title');   // drawn again now that a save exists: Continue appears
        const before = engine.saves.list().length, labels = () => [...document.querySelectorAll('.threedog-title .threedog-btn')].length;
        const had = labels();
        await engine.applyState({ fresh: true });
        return { code: locked.code, by: locked.facts?.by, fix: locked.facts?.fix, before, after: engine.saves.list().length, had, now: labels(), open: engine.ui.isOpen('title') };
      });
      check('interaction.use on the title: inputLocked with facts.by title and a fix', r.code === 'inputLocked' && r.by === 'title' && /applyState/.test(r.fix), JSON.stringify(r));
      check('fresh removes the saves and leaves the title up, one button fewer', r.before > 0 && r.after === 0 && r.open && r.now === r.had - 1, JSON.stringify(r));
    },
  },
  {
    name: '界面件：默认件照常工作，标题画面开着时冻结并吞掉 Esc，开始后关闭；设置可选分页 game / camera 生效',
    url: '/tests/ui/index.html?mode=default',
    async run({ page, check, ev, frames }) {
      // settled()：等所有 hide() 返回的淡出 promise 结束；threedog shot 靠它不截到半透明的加载界面
      const fade = await ev(async () => {
        await engine.ui.settled();
        const loading = !!document.querySelector('.threedog-loading');
        let done = false;
        engine.ui.define('fadeTest', () => ({ hide: () => new Promise(res => setTimeout(() => { done = true; res(); }, 80)) }));
        engine.ui.get('fadeTest').hide(); const early = done;
        await engine.ui.settled();
        return { loading, early, done };
      });
      check('settled 返回时加载界面已淡出移除；会等件的淡出 promise', !fade.loading && !fade.early && fade.done, JSON.stringify(fade));
      const r = await ev(() => ({
        parts: engine.ui.describe(), title: engine.ui.isOpen('title'), dom: !!document.querySelector('.threedog-title'),
        frozen: engine.stacks.get('freeze').has('ui-title'), locked: !engine.input.enabled,
        items: [...document.querySelectorAll('.threedog-title button')].map(b => b.textContent),
      }));
      check('describe 列出全部界面件且标题为默认开', r.parts.title === 'default' && r.parts['hud.marker'] === 'default' && r.parts.loading === 'default', JSON.stringify(r.parts));
      check('启动后标题画面打开、冻结玩法、锁输入', r.title && r.dom && r.frozen && r.locked, JSON.stringify(r));
      check('没有存档时不显示"继续"，装了设置时有"设置"', r.items.length === 2 && !r.items.some(t => /继续|Continue/.test(t)), r.items.join(','));
      await page.keyboard.press('Escape'); await frames(2);
      check('标题画面上按 Esc 不打开设置菜单', await ev(() => engine.ui.isOpen('title') && !engine.settings.isOpen));
      await page.click('.threedog-title button[data-i="0"]'); await frames(2);
      // input contexts apply at the next fixed step: wait for it instead of a fixed number of frames
      const after = await ev(() => __t.until(() => engine.input.enabled, 5000).catch(() => {}).then(() => ({ open: engine.ui.isOpen('title'), dom: !!document.querySelector('.threedog-title'), frozen: engine.stacks.get('freeze').has('ui-title'), input: engine.input.enabled })));
      check('点"开始"关闭标题、解冻、解锁输入', !after.open && !after.dom && !after.frozen && after.input, JSON.stringify(after));

      const t = await ev(async () => {
        engine.haltLoop();
        engine.quests.start('walk'); engine.step(0.6);
        engine.hud.addCounter('fish', { label: 'Fish', value: 2, max: 5 }); engine.hud.bar('hp', { value: 0.5, label: 'HP' });
        engine.step(0.1);
        const o = {
          toast: [...document.querySelectorAll('.threedog-toast')].map(x => x.textContent).join('|'),
          marker: engine.describe().hud.markers.length, counter: document.querySelector('.threedog-hud-counter')?.textContent,
          bar: document.querySelector('.threedog-hud-bar')?.style.getPropertyValue('--threedog-hud-fill'),
        };
        engine.hud.remove('hp');
        o.barGone = !document.querySelector('.threedog-hud-bar');
        engine.hud.addCounter('gun', { value: 12, max: 48 }); engine.step(0.1);
        o.noLabel = [...document.querySelectorAll('.threedog-hud-counter')].at(-1)?.textContent;
        engine.hud.remove('gun');
        engine.hud.bar('nolabel', { value: 0.5 }); engine.step(0.1);
        o.noLabelBar = !![...document.querySelectorAll('.threedog-hud-bar')].at(-1)?.querySelector('.threedog-hud-bar-fill');
        engine.hud.remove('nolabel');
        o.prompt = document.querySelector('.threedog-prompt')?.textContent; o.stick = !!document.querySelector('.threedog-stick');
        document.querySelector('.threedog-prompt')?.click(); o.lever = window.leverUsed;
        engine.quests.win.toggle(true); engine.step(0.1);   // input contexts switch at the next fixed step
        o.log = { open: engine.ui.isOpen('questLog'), text: document.querySelector('.threedog-win-quests')?.textContent, locked: !engine.input.enabled };
        engine.quests.win.toggle(false); engine.step(0.1);
        o.logClosed = !engine.ui.isOpen('questLog') && document.querySelector('.threedog-win-quests')?.hidden && engine.input.enabled;
        return o;
      });
      check('a counter with no label shows its value alone, not its id', t.noLabel === '12 / 48', JSON.stringify(t));
      check('a bar with no label still draws its track', t.noLabelBar, JSON.stringify(t));
      check('任务开始弹默认提示（kind quest）', /Walk/.test(t.toast), t.toast);
      check('交互提示默认件画出"键 · 标签"，点它走 interaction.use；默认摇杆画出', /Lever/.test(t.prompt || '') && t.lever === 1 && t.stick, JSON.stringify(t));
      check('任务日志默认件：打开时列出任务并锁输入，关上后隐藏解锁', t.log.open && /Walk[\s\S]*Go north/.test(t.log.text || '') && t.log.locked && t.logClosed, JSON.stringify(t));
      check('HUD 默认件：任务标记、计数、进度条都画出来，remove 后进度条消失', t.marker === 1 && t.counter === 'Fish 2 / 5' && t.bar === '0.5' && t.barGone, JSON.stringify(t));

      const s = await ev(async () => {
        const st = engine.settings, ids = [...st.sections.keys()];
        st.set('camera.sensitivity', 2.5); st.set('camera.invertY', true); st.set('camera.fov', 80);
        const o = { ids, sens: engine.cameraRig.sensitivity, inv: engine.cameraRig.invertY, fov: engine.camera.fov };
        let changed = null; engine.events.on('camera:change', x => { changed = x; });
        engine.setCamera('firstPerson');
        o.switched = { changed, kind: engine.cameraRig.kind, sens: engine.cameraRig.sensitivity, inv: engine.cameraRig.invertY, fov: engine.camera.fov };
        engine.setCamera('follow');
        st.open(); st.current = 'game'; st.win.refresh();
        o.toTitleBtn = !!st.win.el.querySelector('[data-game="title"]');
        st.win.el.querySelector('[data-game="title"]').click();
        await new Promise(r => setTimeout(r, 0));
        o.backToTitle = engine.ui.isOpen('title') && !st.isOpen;
        engine.ui.close('title');
        try { st.addSection('nope'); } catch (err) { o.err = err.message; }
        return o;
      });
      check('可选分页按名字装上（game、camera），默认分页列表不含它们', s.ids.includes('game') && s.ids.includes('camera') && !s.ids.includes('audio'), s.ids.join(','));
      check('camera 分页的灵敏度 / 反转 Y / 视野写到当前相机', s.sens === 2.5 && s.inv === true && s.fov === 80, JSON.stringify(s));
      check('切换相机发 camera:change，camera 分页的设置重新套到新相机上', s.switched.changed?.kind === 'firstPerson' && s.switched.changed?.previous === 'follow' && s.switched.sens === 2.5 && s.switched.inv === true && s.switched.fov === 80, JSON.stringify(s.switched));
      check('game 分页"回到标题"关菜单并打开标题画面', s.toTitleBtn && s.backToTitle, JSON.stringify(s));
      check('写错分页名报错并列出可选项和改法', /optional: options, game, camera/.test(s.err || '') && /addSection\('nope', \{ title, render \}\)/.test(s.err || ''), s.err);
    },
  },
  {
    name: '[守] 界面件全关：加载、提示、标题、HUD 都不画任何 DOM，逻辑照常（任务、计数、describe）',
    url: '/tests/ui/index.html?mode=off',
    async run({ check, ev }) {
      const r = await ev(async (DOM) => {
        engine.haltLoop();
        engine.quests.start('walk'); engine.step(0.6);
        engine.hud.addCounter('fish', { value: 3 }); engine.hud.bar('hp', { value: 0.2 });
        engine.inventory?.add('x');
        engine.dialogue.start('npc'); engine.step(1);
        const dlg = engine.describe().ui.dialogue?.choices.join();
        const chose = engine.ops.run('dialogue.choose', { index: 0 }).ok && !engine.dialogue.active;
        await engine.saves.load('no-such-slot');
        engine.step(0.1);
        const logOpened = engine.ui.open('questLog');
        const lever = engine.ops.run('interaction.use', { id: 'lever' }).ok;
        return { logOpened, lever,
          dom: DOM.filter(s => document.querySelector(s)), rootKids: [...engine.uiRoot.querySelectorAll('*')].filter(x => x.parentElement === engine.uiRoot).map(x => x.className), opened: engine.ui.open('title'),
          dlg, chose, quest: engine.quests.isActive('walk'), markers: engine.describe().hud.markers.length, counters: engine.describe().hud.counters,
        };
      }, DOM);
      check('没有任何引擎界面 DOM', r.dom.length === 0, r.dom.join(','));
      // 更严：engine.uiRoot 下除了还没做成界面件的设置菜单窗口，什么都不许有（新加的界面绕开 engine.ui 也会被抓到）
      check('engine.uiRoot 下只剩设置菜单窗口（设置菜单本身不是界面件）', r.rootKids.every(c => /threedog-win-settings/.test(c)), JSON.stringify(r.rootKids));
      check('关掉的标题件 open 返回 false', r.opened === false);
      check('关掉的任务日志打不开；交互提示关掉后 interaction.use 照常可用', r.logOpened === false && r.lever, JSON.stringify(r));
      check('对话关掉界面件照常走：describe 有选项，dialogue.choose 结束对话', r.dlg === 'Bye' && r.chose, JSON.stringify(r));
      check('逻辑照常：任务进行中、标记和计数仍在 describe 里', r.quest && r.markers === 1 && r.counters.fish === 3, JSON.stringify(r));
    },
  },
  {
    name: '界面件换成游戏自己的：引擎只调 show / update / hide / dispose 传数据；写错名字和返回值报错给改法',
    url: '/tests/ui/index.html?mode=custom',
    async run({ check, ev }) {
      const r = await ev(async (DOM) => {
        engine.haltLoop();
        const tv = uiLog.find(x => x[0] === 'touch' && x[1] === 'show')?.[2];   // shown at start()
        const startLog = uiLog.map(x => x[0] + '.' + x[1]);
        uiLog.length = 0;
        engine.ui.close('title');
        engine.quests.start('walk'); engine.step(0.6);
        engine.hud.addCounter('fish', { label: 'Fish', value: 1 }); engine.hud.remove('fish');
        engine.dialogue.start('npc'); engine.step(1);
        uiLog.filter(x => x[0] === 'dialogue' && x[1] === 'update').at(-1)[2].choose(0);   // the part answers by calling choose(): that is the op
        const dlgOp = engine.ops.recent('dialogue.choose').at(-1);
        engine.step(0.1);
        const pr = uiLog.filter(x => x[0] === 'prompt' && x[1] === 'update').at(-1)?.[2];
        pr?.use();
        const useOp = engine.ops.recent('interaction.use').at(-1);
        engine.quests.win.toggle(true); engine.quests.start('walk2'); engine.quests.win.refresh();
        const lv = uiLog.filter(x => x[0] === 'questLog' && x[1] === 'update').at(-1)?.[2];
        lv?.close();
        const logClosed = !engine.ui.isOpen('questLog');
        tv?.move(0.5, 1); const axis = { ...engine.input.stick }; tv?.move(0, 0);
        const o = { startLog, log: uiLog.map(x => [x[0], x[1], x[2] && JSON.stringify(x[2]).slice(0, 240)]), dom: DOM.filter(s => document.querySelector(s)), dlgOp: dlgOp && `${dlgOp.ok}/${dlgOp.source}`, dlgActive: !!engine.dialogue.active,
          useOp: useOp && `${useOp.args.id}/${useOp.ok}/${useOp.source}`, logClosed, axis, touchShow: tv && { stick: tv.stick, buttons: tv.buttons } };
        const bad = (fn) => { try { fn(); return null; } catch (err) { return err.message; } };
        o.badValue = bad(() => engine.ui.set('toast', 'red'));
        o.badPart = bad(() => { engine.ui.set('hud.bar', () => 42); engine.hud.bar('z', { value: 1 }); });
        const E = engine.constructor;
        o.unknown = await (async () => { const e2 = new E({ canvas: document.createElement('canvas'), ui: { 'hud.counte': false, loading: false }, saveKey: 'ui-typo', headless: true }); try { await e2.start(); return null; } catch (err) { return err.message; } finally { e2.dispose(); } })();
        return o;
      }, DOM);
      const has = (part, verb, re) => r.log.some(([p, v, d]) => p === part && v === verb && (!re || re.test(d || '')));
      check('加载件按 show → update → hide 被调用', ['loading.show', 'loading.update', 'loading.hide'].every(x => r.startLog.includes(x)), r.startLog.join(','));
      check('标题件 show 收到 title 和 items', r.startLog.includes('title.show'), r.startLog.join(','));
      check('提示件收到 { text, kind: quest }', has('toast', 'show', /"kind":"quest"/), JSON.stringify(r.log));
      check('标记件每帧收到屏幕坐标和距离', has('hud.marker', 'update', /"x":.*"distance"/), JSON.stringify(r.log.filter(x => x[0] === 'hud.marker').slice(0, 2)));
      check('计数件 update 收到数据，remove 时 dispose', has('hud.counter', 'update', /"value":1/) && has('hud.counter', 'dispose'), JSON.stringify(r.log));
      check('对话件 show → update（说话人、整句、节点 data、选项）→ hide', has('dialogue', 'show') && has('dialogue', 'update', /"speaker":"npc".*"full":"Hello".*"choices":\[\{"text":"Bye"/) && has('dialogue', 'update', /"data":\{"portrait":"p1"\}/) && has('dialogue', 'hide'), JSON.stringify(r.log.filter(x => x[0] === 'dialogue')).slice(0, 600));
      check('对话件调 choose(i) 走 dialogue.choose 操作并结束对话', r.dlgOp === 'true/player' && !r.dlgActive, JSON.stringify(r));
      check('提示件每帧收到 { x, y, key, label, text }，调 use() 走 interaction.use', has('prompt', 'update', /"key":"E","label":"Lever","text":"E · Lever","x":/) && r.useOp === 'lever/true/player', JSON.stringify(r.useOp));
      check('任务日志件 show / update 收到 { title, key, quests }，close() 关闭并 hide', has('questLog', 'show', /"key":"J","quests":\[/) && has('questLog', 'update', /walk2|Walk 2/) && has('questLog', 'hide') && r.logClosed, JSON.stringify(r.log.filter(x => x[0] === 'questLog')).slice(0, 400));
      check('触屏件 show 收到 { stick, buttons }，move() 写进 input.stick', r.touchShow?.stick === true && Array.isArray(r.touchShow.buttons) && r.axis.x === 0.5 && r.axis.y === 1, JSON.stringify(r));
      check('换掉的件引擎不画自己的 DOM', r.dom.length === 0, r.dom.join(','));
      check('值写错报错并给出可选写法', /pass false \(off\), true \(default\)/.test(r.badValue || ''), r.badValue);
      check('件函数返回值写错报错', /must return an object/.test(r.badPart || ''), r.badPart);
      check('名字写错 start() 报错并列出已有件', /no UI part has that name.*Known parts: loading, toast, title/.test(r.unknown || ''), r.unknown);
    },
  },
];
