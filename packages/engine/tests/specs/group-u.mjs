// Group U (input / UI / focus): one check per root cause. Run: npm test -- "group U"
export const specs = [
  {
    name: 'group U: touch view lets go on redraw / dispose; context switch clears seat keys; pointercancel is no click; editable targets; keyboard lock follows freeze',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.timeline.skip(); engine.step(1, { render: false }); await new Promise(r => setTimeout(r, 50)); engine.step(1, { render: false });
        const I = engine.input, o = {};
        // 1 touch: a held button removed by redraw / dispose releases its action
        
        const calls = [], part = engine.ui.get('touch');
        const view = labels => ({ stick: true, buttons: labels.map(l => ({ action: 'tA', label: l })), move: (x, y) => calls.push('move' + x + y), press: a => calls.push('p:' + a), release: a => calls.push('r:' + a) });
        part.show(view(['A']));
        const btn = () => engine.uiRoot.querySelector('.threedog-touch-btn');
        btn().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        part.update(view(['B']));   // language change: the button is rebuilt under the thumb
        o.redraw = calls.join();
        btn().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        calls.length = 0; part.dispose();
        o.dispose = calls.join();
        // 2 context: a seat key is cleared by a switch
        I.define('tSeat', { keys: ['KeyU'] });
        const seat = I.seat({ pad: 3, keys: { tSeat: 'F8' } });
        I.beginFixed(); I.endFixed();
        I._keyDown('F8', 'keyboard'); o.heldBefore = I.keys.has('F8');
        I.define('tOk', { keys: ['KeyO'], context: 'tmenu' });
        const h = I.push('tmenu', { owner: 't' }); I.beginFixed(); I.endFixed();
        o.seatKeyHeld = I.keys.has('F8'); o.dbg = [I.contexts.join(), I.keysOf('tSeat').join(), I.blockedBy('tSeat').join()];
        h.remove(); I.beginFixed(); I.endFixed();
        I._keyUp('F8'); seat.remove();
        // 6 editable: contenteditable (and its child) keeps the key
        const ed = document.body.appendChild(document.createElement('div')); ed.contentEditable = 'true'; const child = ed.appendChild(document.createElement('b'));
        const press = t => { const e = new KeyboardEvent('keydown', { code: 'KeyJ', bubbles: true, cancelable: true }); t.dispatchEvent(e); const d = I.keys.has('KeyJ'); I._keyUp('KeyJ'); return d; };
        o.editable = press(ed); o.editableChild = press(child); o.plain = press(document.body);
        ed.remove();
        // 8 pointer: cancel is no click, a foreign pointer up does not end the gesture
        const cv = engine.canvas ?? document.getElementById('view');
        const pe = (type, id) => new PointerEvent(type, { pointerId: id, pointerType: 'touch', bubbles: true, clientX: 5, clientY: 5 });
        cv.setPointerCapture = () => {};   // synthetic ids have no active pointer to capture
        I.pointer.clicked = false;
        cv.dispatchEvent(pe('pointerdown', 7)); cv.dispatchEvent(pe('pointerup', 9));
        o.foreignDown = I.pointer.down;
        cv.dispatchEvent(pe('pointercancel', 7)); o.cancelClick = I.pointer.clicked;
        cv.dispatchEvent(pe('pointerdown', 8)); cv.dispatchEvent(pe('pointerup', 8)); o.upClick = I.pointer.clicked; I.pointer.clicked = false;
        // 4 keyboard lock: a freeze gives the lock back (spy on the page's lock calls, fake fullscreen)
        const kb = navigator.keyboard;
        if (kb?.lock) {
          const n = { lock: 0, unlock: 0 }, L = kb.lock, U = kb.unlock;
          kb.lock = () => { n.lock++; }; kb.unlock = () => { n.unlock++; };
          Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => document.body });
          engine.events.emit('input:context', {});
          o.locked = n.lock; const u0 = n.unlock;
          const f = engine.freeze('t-lock'); o.unlockOnFreeze = n.unlock - u0; f.remove();
          o.relock = n.lock;
          delete document.fullscreenElement; kb.lock = L; kb.unlock = U;
        }
        return o;
      });
      check('touch: redraw released the held action', r.redraw === 'p:tA,r:tA', r.redraw);
      check('touch: dispose released the held action and the stick', r.dispose === 'r:tA,move00', r.dispose);
      check('context switch cleared the seat key', r.heldBefore === true && r.seatKeyHeld === false, JSON.stringify([r.heldBefore, r.dbg]));
      check('contenteditable and its child keep the key', r.editable === false && r.editableChild === false && r.plain === true, JSON.stringify([r.editable, r.editableChild, r.plain]));
      check('a foreign pointer up does not end the gesture', r.foreignDown === true);
      check('pointercancel is no click, pointerup is', r.cancelClick === false && r.upClick === true, JSON.stringify([r.cancelClick, r.upClick]));
      if (r.locked !== undefined) check('freeze releases the keyboard lock, unfreeze asks again', r.locked === 1 && r.unlockOnFreeze >= 1 && r.relock === 2, JSON.stringify([r.locked, r.unlockOnFreeze, r.relock]));
    },
  },
  {
    name: 'group U: an empty saved binding survives a reload; a slider drag applies its value once',
    url: '/tests/settings/index.html',
    async run({ page, check, ev }) {
      const n = await ev(async () => {
        const S = engine.settings, c = { n: 0 }, orig = S._apply.bind(S);
        S._apply = (k, v) => { if (k === 'vol.music') c.n++; return orig(k, v); };
        S.current = 'audio'; S.open(); S.win.refresh();
        const r = document.querySelector('[data-range="vol.music"]');
        r.value = 0.3; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true }));
        S.close();
        engine.input.rebind('interact', []); S.save();
        return c.n;
      });
      check('slider applied once', n === 1, String(n));
      await page.reload(); await page.waitForFunction(() => window.engine?.settings);
      check('empty binding restored (no default key back)', await ev(() => engine.input.keysOf('interact').length) === 0);
      await ev(() => { engine.input.rebind('interact', null); engine.settings.save(); });
    },
  },
];
