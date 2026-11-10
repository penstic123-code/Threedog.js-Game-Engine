// Real key presses and clicks across modules, and what the picture settings must leave alone. Direct ops and engine.input calls are covered elsewhere: here the browser delivers the input.
const facts = () => { const d = engine.saves.collect(); delete d.savedAt; delete d.at; delete d.parts.time.real; return JSON.stringify(d); };   // real: wall-clock seconds, not a game fact

export const specs = [
  {
    name: '[guard] real keys: rebinding in the open menu with a held key, Space and Enter on the focused button, then playing with the new key',
    url: '/?cutscene=skip',
    async run({ page, check, ev, frames }) {
      await ev(() => { engine.input.define('audit', { keys: ['KeyO'] }); window.pressed = 0; engine.onFixed(() => { if (engine.input.pressed('audit')) window.pressed++; }); });
      await page.keyboard.down('KeyW'); await frames(3);
      const held = await ev(() => engine.input.down('moveForward'));
      await ev(() => { engine.settings.open(); }); await frames(3);
      await page.keyboard.up('KeyW');                // let go while the menu holds input: nothing may stay held behind it
      const tab = await ev(() => { const t = [...document.querySelectorAll('[data-tab]')].find(b => /key|control|按键|操作/i.test(b.dataset.tab + b.textContent)); t?.click(); return t?.dataset.tab; });
      await frames(3);
      for (const [key, code] of [['Space', 'Space'], ['Enter', 'Enter'], ['k', 'KeyK']]) {
        await page.locator('[data-rebind="audit"]').click(); await frames(2);
        const before = await ev(() => engine.settings.capturing);
        await page.keyboard.press(key); await frames(4);
        const after = await ev(() => ({ cap: engine.settings.capturing, keys: engine.input.keysOf('audit') }));
        check(`rebinding to ${code}: the press lands once and the button does not open again`, before === 'audit' && !after.cap && after.keys[0] === code, JSON.stringify({ tab, before, after }));
      }
      // no mouse: the menu cursor walks to the row, confirm opens it, and that press is not the new key
      for (let i = 0; i < 80 && !await ev(() => document.querySelector('.is-cursor')?.dataset.rebind === 'audit'); i++) { await page.keyboard.press('ArrowDown'); await frames(2); }
      await page.keyboard.press('Enter'); await frames(4);
      const nav = await ev(() => ({ cap: engine.settings.capturing, keys: engine.input.keysOf('audit') }));
      check('confirm on a row waits for a key', nav.cap === 'audit' && nav.keys[0] === 'KeyK', JSON.stringify(nav));
      await page.keyboard.press('Escape'); await frames(4);
      check('Esc cancels the wait and leaves the menu open', await ev(() => !engine.settings.capturing && engine.settings.isOpen && engine.input.keysOf('audit')[0] === 'KeyK'));
      await page.locator('[data-rebind="audit"]').click(); await frames(2);
      await ev(() => { engine.settings.win.toggle(false); }); await frames(3);
      check('a window closed while waiting holds no focus', await ev(() => !engine.settings.capturing && engine.settings.focus.top === null), String(await ev(() => engine.settings.focus.top)));
      await ev(() => { engine.settings.open(); }); await frames(3);
      await page.keyboard.press('KeyO'); await frames(3);
      await ev(() => { engine.settings.close(); }); await frames(4);
      const s = await ev(() => ({ open: engine.settings.isOpen, pressed: window.pressed, fwd: engine.input.down('moveForward'), enabled: engine.input.enabled, contexts: engine.input.contexts.join() }));
      check('a key held into the menu was really held', held === true);
      check('the menu kept its presses from the game, and nothing stays held or locked', !s.open && s.pressed === 0 && !s.fwd && s.enabled, JSON.stringify(s));
      await page.keyboard.press('KeyO'); await frames(4);
      check('the old key is gone', await ev(() => window.pressed) === 0);
      await page.keyboard.down('KeyK'); await frames(4); await page.keyboard.up('KeyK'); await frames(3);
      check('the new key plays', await ev(() => window.pressed) === 1, String(await ev(() => window.pressed)));
    },
  },
  {
    name: '[guard] real keys: blur and a hidden tab during a pointer lock leave nothing held; the lock comes back by click; look still works',
    url: '/?cutscene=skip',
    async run({ page, check, ev, frames }) {
      await ev(() => { engine.cameraRig.pointerLock = true; });
      const box = await page.locator('#view').boundingBox(), cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      await page.mouse.click(cx, cy);
      check('locked', await ev(() => __t.until(() => engine.page.pointerLocked, 3000).then(() => true, () => false)));
      await page.keyboard.down('KeyW'); await page.mouse.down(); await frames(3);
      const held = await ev(() => engine.input.down('moveForward'));
      await ev(() => { window.dispatchEvent(new Event('blur')); }); await frames(3);
      const a = await ev(() => ({ fwd: engine.input.down('moveForward'), keys: [...engine.input.keys], enabled: engine.input.enabled, state: engine.runState.state }));
      await page.keyboard.up('KeyW'); await page.mouse.up(); await frames(2);
      check('blur drops what was held', held && !a.fwd && !a.keys.length, JSON.stringify(a));
      await ev(() => document.exitPointerLock());
      await ev(() => __t.until(() => !engine.page.pointerLocked, 3000));
      await frames(3);
      await page.mouse.click(cx, cy);
      check('a click locks again', await ev(() => __t.until(() => engine.page.pointerLocked, 3000).then(() => true, () => false)));
      const y0 = await ev(() => engine.cameraRig.yaw);
      await page.mouse.move(cx + 80, cy, { steps: 4 }); await frames(4);
      const y1 = await ev(() => engine.cameraRig.yaw);
      check('mouse look still turns the camera', y1 !== y0, JSON.stringify([y0, y1]));
      await page.keyboard.down('KeyW'); await frames(3);
      check('keys are heard again', await ev(() => engine.input.down('moveForward')));
      await page.keyboard.up('KeyW');
    },
  },
  {
    name: '[guard] outside text: a name with markup stays text in every default window, line, prompt and toast',
    url: '/?cutscene=skip',
    async run({ page, check, ev, frames }) {
      const r = await ev(async () => {
        const bad = `<img src=x onerror="window.__xss=(window.__xss||0)+1">"'&<b data-x=1>`, e = engine, o = {}, wait = n => __t.frames(n);
        e.inventory.define('xss', { name: bad, desc: bad, icon: bad, iconUrl: `x" onerror="window.__xss=1` });
        e.inventory.bag.add('xss', 1);
        e.quests.define('xss', { title: bad, desc: bad, steps: [{ text: bad, done: () => false }, { all: [{ text: bad, done: () => false }] }] });
        e.ops.allow(() => e.quests.start('xss'));
        e.npcs.add({ id: 'xss-npc', name: bad, position: { x: e.player.position.x + 1, z: e.player.position.z }, interact: { label: bad, op: 'interaction.use' } });
        e.pickups?.spawn([e.player.position.x, 0, e.player.position.z + 1], { give: 'xss', name: bad });
        e.ui.toast?.(bad);
        await e.saves.save(bad); await e.saves.flush();
        e.dialogue.define(bad, { start: { speaker: bad, text: bad, choices: [{ text: bad, next: 'end' }] } });
        e.dialogue.start(bad); e.dialogue.say(bad, { channel: 'bubble', speaker: bad });
        await wait(30);
        e.ops.run('dialogue.advance', {}); await wait(3);
        e.dialogue.end();
        e.quests.win.toggle(true); await wait(3); e.quests.win.toggle(false); await wait(2);
        e.ui.open('inventory'); await wait(3); o.bagShown = !!document.querySelector('.threedog-win-inventory .threedog-row'); e.ui.close('inventory'); await wait(2);
        e.settings.open(); await wait(3);
        for (const t of document.querySelectorAll('[data-tab]')) { t.click(); await wait(2); }
        e.settings.close(); await wait(2);
        o.xss = window.__xss ?? 0;
        o.imgs = document.querySelectorAll('body img[src="x"]').length;
        o.bold = document.querySelectorAll('[data-x]').length;
        return o;
      });
      await frames(3);
      check('no markup from a name ran or became an element', r.bagShown && !r.xss && !r.imgs && !r.bold, JSON.stringify(r));
    },
  },
  {
    name: '[guard] small screen: long unbroken names stay inside the phone-size view in the dialogue box, the menu, quest and bag windows, and their buttons can be reached',
    url: '/?cutscene=skip',
    async run({ page, check, ev }) {
      await page.setViewportSize({ width: 360, height: 640 });
      const r = await ev(async () => {
        const e = engine, long = 'Donaudampfschifffahrtsgesellschaftskapitänsmützenabzeichenverleihung'.repeat(2), wait = n => __t.frames(n), bad = [];
        const fits = (name, sel) => { for (const el of document.querySelectorAll(sel)) { const b = el.getBoundingClientRect(); if (!b.width) continue; if (el.scrollWidth > el.clientWidth + 1) bad.push(`${name} text wider than its box: ${el.scrollWidth} / ${el.clientWidth}`); if (b.left < -1 || b.right > innerWidth + 1 || b.bottom > innerHeight + 1 || b.top < -1) bad.push(`${name}: ${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.right)},${Math.round(b.bottom)}`); } };
        e.inventory.define('long', { name: long, desc: long }); e.inventory.bag.add('long', 1);
        e.quests.define('long', { title: long, desc: long, steps: [{ text: long, done: () => false }] }); e.ops.allow(() => e.quests.start('long'));
        e.dialogue.define('long', { start: { speaker: long, text: long, choices: [{ text: long, next: 'end' }, { text: long, next: 'end' }] } });
        e.dialogue.start('long'); e.ops.run('dialogue.advance', {}); await wait(4);
        fits('dialogue', '.threedog-dlg');
        const pick = document.querySelector('.threedog-dlg button'), pb = pick?.getBoundingClientRect();
        const hit = pb && document.elementFromPoint(pb.left + pb.width / 2, pb.top + pb.height / 2);
        const reach = !!hit && (hit === pick || pick.contains(hit));
        e.dialogue.end(); await wait(2);
        e.quests.win.toggle(true); await wait(3); fits('quests', '.threedog-win'); e.quests.win.toggle(false); await wait(2);
        e.ui.open('inventory'); await wait(3); fits('bag', '.threedog-win-inventory'); e.ui.close('inventory'); await wait(2);
        e.settings.open(); await wait(3); fits('settings', '.threedog-win'); e.settings.close(); await wait(2);
        return { bad, reach, width: document.documentElement.scrollWidth };
      });
      check('every box stays on the screen', !r.bad.length, JSON.stringify(r.bad));
      check('a choice under a long name is what a tap there hits', r.reach, JSON.stringify(r));
      check('the page itself does not scroll sideways', r.width <= 361, JSON.stringify(r));
    },
  },
  {
    name: '[guard] tools change nothing: describe, inspect, a photo, the settings menu and the debug panel leave saved facts and random numbers alone; a new game with the menu open ends with no freeze or lock',
    url: '/?cutscene=skip',
    software: true,
    async run({ check, ev }) {
      const r = await ev(async (src) => {
        const facts = new Function('return (' + src + ')()'), E = engine, o = {};
        E.haltLoop();
        const f0 = facts(), r0 = JSON.stringify(E.random.state ?? null);
        E.describe(); E.inspect?.perf?.(); E.inspect?.scene?.();
        await E.ops.run('photo.take', {}, { source: 'test' }).value;
        E.settings.open(); E.step(0.1, { render: false }); E.settings.close();
        const a = JSON.parse(f0), b = JSON.parse(facts()); delete a.parts.photo; delete b.parts.photo;
        for (const d of [a, b]) { delete d.parts.time; delete d.parts.world?.step; delete d.parts.world?.time; delete d.parts.clock; }   // the 0.1 s the menu stepped
        o.same = JSON.stringify(a.parts.vars) === JSON.stringify(b.parts.vars) && JSON.stringify(a.parts.quests?.state) === JSON.stringify(b.parts.quests?.state) && JSON.stringify(a.parts.random) === JSON.stringify(b.parts.random);
        o.random = JSON.stringify([a.parts.vars, b.parts.vars, a.parts.quests, b.parts.quests]).slice(0, 400);
        E.settings.open();
        await E.session.newGame();
        E.step(0.1, { render: false });
        o.after = { open: E.settings.isOpen, frozen: E.frozen, enabled: E.input.enabled, ctx: E.input.contexts.join(), top: E.settings.focus.top };
        E.settings.close(); E.step(0.1, { render: false });
        o.closed = { frozen: E.frozen, enabled: E.input.enabled, ctx: E.input.contexts.join(), top: E.settings.focus.top };
        return o;
      }, facts.toString());
      check('saved facts and the random stream stay', r.same, r.random);
      check('closing the menu after a new game frees everything', !r.closed.frozen && r.closed.enabled && r.closed.top === null, JSON.stringify(r));
    },
  },
  {
    name: '[guard] settings unloaded with its menu open and its limits on: the lock, the freeze, the focus and the limits leave with it',
    url: '/tests/threads/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = threedogThreads.all, E = threedogThreads.mk(T.createEngine, 'settings-off');
        E.use(T.settings({ freezeWorld: true, storageKey: 'settings-off-test' }));
        await E.start(); E.haltLoop();
        const P = E.stacks.get('shadows.enabled');
        E.settings.set('shadows', false, { save: false });
        E.settings.open(); E.settings.capturing = 'confirm';
        E.step(0.05, { render: false });
        const during = { held: P.has('settings'), frozen: E.frozen, enabled: E.input.enabled };
        const focus = E.settings.focus;
        await E.unuse('settings');
        E.step(0.05, { render: false });
        return { during, held: P.has('settings'), frozen: E.frozen, enabled: E.input.enabled, top: focus.top, ctx: E.input.contexts.join() };
      });
      check('the menu held what it should', r.during.held && r.during.frozen && !r.during.enabled, JSON.stringify(r));
      check('nothing stays held after the unload', !r.held && !r.frozen && r.enabled && r.top === null, JSON.stringify(r));
    },
  },
  {
    name: '[guard] on-screen stick by a real pointer: it moves the axis, a menu rests it, and blur leaves nothing pushed',
    url: '/tests/threads/',
    async run({ page, check, ev }) {
      await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, c = document.createElement('canvas');
        c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%'; document.body.append(c);
        const E = window.E = mk(T.createEngine, 'stick', { canvas: c, headless: false, joystick: true });
        await E.start(); await __t.until(() => document.querySelector('.threedog-stick'), 3000);
      });
      const b = await page.locator('.threedog-stick').boundingBox(), cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      const axis = () => ev(() => { const a = E.input.axis; return [+a.x.toFixed(2), +a.y.toFixed(2)]; });
      const tick = () => ev(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx, cy - b.height, { steps: 3 }); await tick();
      const pushed = await axis();
      check('the stick pushes the axis forward', Math.abs(pushed[1]) > 0.9, JSON.stringify(pushed));
      await ev(() => { window.h = E.input.push('menu'); }); await tick(); await tick();
      const menu = await axis();
      await ev(() => { h.remove(); }); await tick();
      check('a menu context rests it', !menu[0] && !menu[1], JSON.stringify(menu));
      await ev(() => { window.dispatchEvent(new Event('blur')); }); await tick();
      const away = await ev(() => [E.input.stick.x, E.input.stick.y]);
      await ev(() => { window.dispatchEvent(new Event('focus')); }); await tick();
      check('blur leaves nothing pushed, like a held key', !away[0] && !away[1], JSON.stringify(away));
      await page.mouse.up(); await tick();
      check('letting go centres it', (await axis()).every(v => !v));
      await ev(() => { E.dispose(); });
    },
  },
  {
    name: '[guard] picture settings against game facts: density, view distance, shadows and bloom change no saved fact, no random number and no walked path',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(async (src) => {
        const facts = new Function('return (' + src + ')()');
        const E = engine, o = {};
        E.haltLoop();
        const walk = async (vals) => {
          await E.saves.load('start');
          for (const [k, v] of Object.entries(vals)) E.settings.set(k, v, { save: false });
          E.input._keyDown('KeyW', 'keyboard');
          for (let i = 0; i < 180; i++) { E.input.poll(1 / 60); E.step(1 / 60, { render: i % 30 === 0, describe: false }); }
          E.input._keyUp('KeyW');
          const p = E.player.position;
          return { at: [p.x, p.y, p.z].map(n => +n.toFixed(4)).join(), rnd: E.random.next(), facts: facts() };
        };
        await E.saves.save('start'); await E.saves.flush();
        const f0 = facts();
        for (const [k, v] of [['density', 0.2], ['viewChunks', 1], ['shadows', false], ['bloom', false]]) { if (k in E.settings.values) E.settings.set(k, v, { save: false }); }
        o.sameAtOnce = facts() === f0;
        o.low = await walk({ density: 0.2, viewChunks: 1, shadows: false, bloom: false });
        o.high = await walk({ density: 1, viewChunks: 3, shadows: true, bloom: true });
        o.diff = o.low.facts === o.high.facts ? null : (() => { const a = JSON.parse(o.low.facts), b = JSON.parse(o.high.facts); const out = []; const go = (x, y, p) => { if (out.length > 8) return; if (JSON.stringify(x) === JSON.stringify(y)) return; if (x && y && typeof x === 'object' && typeof y === 'object') { for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) go(x[k], y[k], p + '.' + k); } else out.push(p + ': ' + JSON.stringify(x)?.slice(0, 60) + ' / ' + JSON.stringify(y)?.slice(0, 60)); }; go(a, b, ''); return out; })();
        o.low.facts = o.high.facts = undefined;
        o.saveHasSettings = /"density"|"viewChunks"/.test(f0);
        return o;
      }, facts.toString());
      check('switching changes no saved fact', r.sameAtOnce, JSON.stringify(r.diff));
      check('the same walk ends in the same place with the same next random number', r.low.at === r.high.at && r.low.rnd === r.high.rnd, JSON.stringify(r));
      check('and the same saved facts', !r.diff, JSON.stringify(r.diff));
      check('picture preferences are not in the save', !r.saveHasSettings);
    },
  },
];
