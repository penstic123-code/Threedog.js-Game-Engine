// Input contexts: menu shadows walking, no stuck hold after closing, vehicle context shadows same-key actions, blur / tab hide releases all keys.
export const specs = [
  {
    name: '输入情境：菜单遮蔽攻击、关菜单后不留按住、载具情境遮蔽同键动作、失焦与切标签页清空按住',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.timeline.skip(); engine.step(1, { render: false }); await new Promise(r => setTimeout(r, 50)); engine.step(1, { render: false });   // the sample starts with an intro cutscene (it holds an opaque context)
        const I = engine.input, o = {};
        // one fixed step's view, taken the way the engine does at the start of each step
        const fx = names => { I.beginFixed(); const v = names.map(n => [I.pressed(n), I.down(n)]); I.endFixed(); return v; };
        I.define('tAtk', { keys: ['KeyU'] });
        I.define('tOk', { keys: ['KeyU'], context: 'tmenu' });
        I.define('tUse', { keys: ['KeyF'] }); I.define('tExit', { keys: ['KeyF'], context: 'tcar' }); I.define('tWalk', { keys: ['KeyG'] });

        I._keyDown('KeyU', 'keyboard');
        o.base = fx(['tAtk', 'tOk']);                       // attack pressed; menu action not on the stack
        o.baseWhy = I.blockedBy('tOk');
        const h = I.push('tmenu');
        o.pendingEnabled = I.enabled;                        // not applied before the next fixed step
        fx([]);
        o.menu = { enabled: I.enabled, ctx: I.contexts.join(), held: I.keys.has('KeyU') };
        o.menuWhy = I.blockedBy('tAtk');
        I._keyUp('KeyU'); fx([]); I._keyDown('KeyU', 'keyboard');
        o.inMenu = fx(['tAtk', 'tOk']);                      // confirm-style key does not attack; the menu action sees it
        I._keyUp('KeyU'); fx([]);
        // hold in gameplay, open menu, close menu: nothing left held, auto-repeat does not revive it
        h.remove(); fx([]); I._keyDown('KeyU', 'keyboard'); fx(['tAtk']);
        const h2 = I.push('tmenu'); fx([]);
        h2.remove(); const after = fx(['tAtk']);
        I._keyDown('KeyU', 'keyboard');                      // keyboard auto-repeat while still physically held
        o.afterClose = { after, repeat: fx(['tAtk']) };
        I._keyUp('KeyU'); fx([]); I._keyDown('KeyU', 'keyboard');
        o.repress = fx(['tAtk']);
        I._keyUp('KeyU'); fx([]);
        // vehicle: pass context; same key F switches meaning, unrelated G keeps working
        const car = I.push('tcar', { pass: true }); fx([]);
        I._keyDown('KeyF', 'keyboard'); I._keyDown('KeyG', 'keyboard');
        o.car = { enabled: I.enabled, v: fx(['tUse', 'tExit', 'tWalk']) };
        o.carWhy = { use: I.blockedBy('tUse'), exit: I.blockedBy('tExit'), walk: I.blockedBy('tWalk'), shadowed: engine.describe().holds.shadowed ?? null };
        car.remove(); car.remove(); I._keyUp('KeyF'); I._keyUp('KeyG'); fx([]);
        o.carOut = { ctx: I.contexts.join() };
        // blur / tab hidden release everything
        I._keyDown('KeyU', 'keyboard'); I._keyDown('KeyG', 'keyboard');
        dispatchEvent(new Event('blur'));
        o.blur = I.keys.size;
        dispatchEvent(new Event('focus'));                   // back, then hide the tab (core/engine/page.js emits page:blur, Input releases)
        I._keyDown('KeyU', 'keyboard');
        Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        delete document.visibilityState;
        o.hidden = I.keys.size;
        document.dispatchEvent(new Event('visibilitychange'));
        return o;
      });
      const J = JSON.stringify(r);
      check('menu pushes apply at the next fixed step', r.pendingEnabled === true && r.menu.enabled === false && r.menu.ctx === 'walk,tmenu', J);
      check('gameplay attack is pressed, menu action unreadable before the menu', r.base[0][0] && r.base[0][1] && !r.base[1][0], J);
      check('with the menu open the same key does not attack but triggers the menu action', !r.inMenu[0][0] && !r.inMenu[0][1] && r.inMenu[1][0], J);
      check('closing the menu leaves no held key (and auto-repeat does not bring it back)', !r.afterClose.after[0][1] && !r.afterClose.repeat[0][1], J);
      check('a fresh press after the menu works again', r.repress[0][0] && r.repress[0][1], J);
      check('vehicle context: F means exit, walk-F is shadowed, G still works, enabled stays true', r.car.enabled && !r.car.v[0][0] && r.car.v[1][0] && r.car.v[2][1], J);
      check('remove() twice is harmless and pops the context', r.carOut.ctx === 'walk', J);
      // blockedBy names every cause (it used to name only opaque holders, so a shadowed or switched-off action read as unblocked)
      check('blockedBy: an action whose context is not on the stack says context-off', JSON.stringify(r.baseWhy) === '["context-off:tmenu"]', J);
      check('blockedBy: an opaque menu above names the menu', JSON.stringify(r.menuWhy) === '["tmenu"]', J);
      check('blockedBy: a pass-through vehicle binding the same key says shadowed-by; readable actions say nothing', JSON.stringify(r.carWhy.use) === '["shadowed-by:tcar"]' && !r.carWhy.exit.length && !r.carWhy.walk.length, J);
      check('describe().holds.shadowed lists the shadowed action with the same causes', JSON.stringify(r.carWhy.shadowed?.tUse) === '["shadowed-by:tcar"]', J);
      check('window blur and tab hidden release all held keys', r.blur === 0 && r.hidden === 0, J);
    },
  },
  {
    name: '运行状态：每个界面件各用自己的冻结者与输入情境，关一个不放开另一个；runState 说清原因',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.timeline.skip(); engine.step(1, { render: false });
        const o = {};
        engine.haltLoop('threedog'); o.test = engine.runState;
        engine.haltLoop('player'); o.two = engine.runState;
        engine._unhalt('threedog'); o.after = engine.runState; engine._unhalt('player');
        engine.freeze('ui-help'); engine.freeze('ui-inventory'); engine.stacks.get('freeze').release('ui-help'); o.still = engine.runState;
        engine.stacks.get('freeze').release('ui-inventory'); engine.haltLoop('threedog'); engine._unhalt('threedog'); o.run = engine.runState.state;
        const h = engine.freeze({ owner: 'menu' }); o.handle = engine.runState.owners.join(); h.remove(); o.handleGone = engine.runState.owners.join();
        engine.haltLoop({ owner: 'obj' }); engine._unhalt({ owner: 'obj' }); o.objForm = engine.runState.state; o.blocked = engine.runState.blockedBy;
        o.desc = engine.describe().time.run.state; o.pl = engine.describe().camera.pointerLock;
        return o;
      });
      const J = JSON.stringify(r);
      check('only the bridge halted: halted', r.test.state === 'halted', J);
      check('a second halt on top lists both; ending the bridge keeps the other', r.two.state === 'halted' && r.two.owners.join() === 'threedog,player' && r.after.state === 'halted' && r.after.owners.join() === 'player', J);
      check('closing help releases only help: inventory still holds the freeze', r.still.state === 'frozen' && r.still.owners.join() === 'ui-inventory', J);
      check('freeze returns a handle: remove() releases only that owner; { owner } works for pause / resume too', r.handle === 'menu' && r.handleGone === '' && r.objForm === 'running', J);
      check('blockedBy is a list of input contexts / error / loading', Array.isArray(r.blocked), J);
      check('everyone released: running; describe carries it; the pointer-lock block always has a state', r.run === 'running' && r.desc === 'running' && typeof r.pl?.state === 'string', J);
    },
  },
  {
    name: '指针锁定：浏览器拒绝时 lastFailure 说明原因与时间、状态变 refused；画布中心有别的元素盖住时 covered 指出是谁',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.timeline.skip(); engine.step(1, { render: false }); await new Promise(r => setTimeout(r, 50)); engine.step(1, { render: false });   // intro cutscene holds the camera and input until skipped
        const c = engine.renderer.domElement, o = {}, saved = c.requestPointerLock;
        // headless Chromium may really grant or refuse a lock; stub the request so both outcomes are deterministic
        c.requestPointerLock = () => new Promise(() => {});          // a request that never answers
        engine.setCamera('firstPerson', { pointerLock: true });      // a runtime switch asks for the lock at once
        o.before = engine.describe().camera.pointerLock;
        c.requestPointerLock = () => Promise.reject(new Error('not allowed without a user gesture'));
        c.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise(r => setTimeout(r, 50));
        o.refused = engine.describe().camera.pointerLock;
        c.requestPointerLock = saved;
        // an element above the canvas centre: describe names it
        const b = c.getBoundingClientRect(), cover = document.createElement('div');
        cover.id = 'test-cover'; cover.style.cssText = `position:fixed;left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;z-index:99999`;
        document.body.appendChild(cover);
        o.covered = engine.describe().camera.pointerLock.covered;
        cover.remove();
        o.clear = engine.describe().camera.pointerLock.covered;
        engine.setCamera('follow');
        return o;
      });
      const J = JSON.stringify(r);
      check('configured and asked, no answer yet: requesting, no failure recorded', r.before.state === 'requesting' && r.before.lastFailure === null, J);
      check('a refused lock: state refused, lastFailure carries the reason and an age in seconds', r.refused.state === 'refused' && /user gesture/.test(r.refused.lastFailure?.reason) && typeof r.refused.lastFailure.agoSec === 'number', J);
      check('an element over the canvas centre is named in covered (#id); nothing over it gives null', r.covered === '#test-cover' && r.clear === null, J);
    },
  },
  {
    name: 'pointer lock: Esc under lock never reaches the page, so a lock the player ended opens the menu; one the engine ended does not',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.timeline.skip(); engine.step(1, { render: false }); await new Promise(r => setTimeout(r, 50)); engine.step(1, { render: false });   // intro cutscene holds
        // a stand-in lock: this test drives the events by hand (tests/specs/pointer-release.mjs has the real one). An end only counts after a start, as in a browser
        const change = () => document.dispatchEvent(new Event('pointerlockchange')), o = {};
        const locked = () => { Object.defineProperty(document, 'pointerLockElement', { value: engine.renderer.domElement, configurable: true }); change(); };
        const lost = () => { delete document.pointerLockElement; change(); };
        locked(); engine.page.releaseLock(); lost(); o.byEngine = engine.settings.isOpen;
        locked(); lost(); o.byPlayer = engine.settings.isOpen;
        locked(); lost(); o.again = engine.settings.isOpen;   // the menu is on the stack: a second end of a lock changes nothing
        engine.settings.close();
        const h = engine.freeze('test'); locked(); lost(); o.frozen = engine.settings.isOpen; h.remove();   // a game's own frozen screen keeps the mouse free, no menu over it
        return o;
      });
      const J = JSON.stringify(r);
      check('the engine releasing the lock opens nothing', r.byEngine === false, J);
      check('the player ending the lock opens the menu, once', r.byPlayer === true && r.again === true, J);
      check('with the game frozen nothing opens', r.frozen === false, J);
    },
  },
];
