// hud.button: a clickable HUD button. The click must not reach the game (no pointer.down / click on the canvas input), the label goes through engine.t, the button gives focus back.
export const specs = [
  {
    name: 'hud.button: click runs once, never reaches the game input, label is translated, focus is returned to the game',
    url: '/tests/ui/index.html?mode=default',
    async run({ check, ev }) {
      const r = await ev(async () => {
        await __t.until(() => engine.stateApplied, 10000);
        engine.i18n.add({ en: { 'wave.start': 'Start wave' }, 'zh-CN': { 'wave.start': '开始下一波' } });
        engine.i18n.setLocale('en');
        let runs = 0;
        engine.hud.button('wave', { label: 'wave.start', run: () => { runs++; }, anchor: 'bottom' });
        engine.step(0.1);
        const b = document.querySelector('.threedog-hud-button');
        const o = { exists: !!b, text: b?.textContent, auto: b && getComputedStyle(b).pointerEvents };
        b.focus();
        for (const t of ['pointerdown', 'pointerup']) b.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerType: 'mouse', pointerId: 1 }));
        b.click();
        o.runs = runs; o.down = engine.input.pointer.down; o.clicked = engine.input.pointer.clicked; o.focused = document.activeElement === b;
        engine.i18n.setLocale('zh-CN'); engine.step(0.1);
        o.zh = document.querySelector('.threedog-hud-button')?.textContent;
        engine.hud.remove('wave');
        o.gone = !document.querySelector('.threedog-hud-button');
        try { engine.hud.button('bad', { label: 'x' }); } catch (e) { o.err = e.message; }
        return o;
      });
      check('the button shows the translated label and takes mouse events', r.exists && r.text === 'Start wave' && r.auto === 'auto', JSON.stringify(r));
      check('a click runs the callback once and the game input sees nothing', r.runs === 1 && !r.down && !r.clicked, JSON.stringify(r));
      check('focus is not left on the button (Space / Enter go to the game)', !r.focused, JSON.stringify(r));
      check('the label follows a language change, remove() takes the button away, no run is an error', /开始下一波/.test(r.zh ?? '') && r.gone && /run/.test(r.err ?? ''), JSON.stringify(r));
    },
  },
  {
    name: 'hud.hint: shows key · label from input.label, follows rebind and device, button action shows its key',
    url: '/tests/ui/index.html?mode=default',
    async run({ check, ev }) {
      const r = await ev(async () => {
        await __t.until(() => engine.stateApplied, 10000);
        engine.i18n.setLocale('en');
        engine.input.define('hintJump', { label: 'Jump', keys: ['Space', 'PadA'] });
        engine.hud.hint('hj', { action: 'hintJump', label: 'Jump' });
        engine.hud.button('hb', { label: 'Go', run() {}, action: 'hintJump' });
        const txt = sel => document.querySelector(sel)?.textContent;
        engine.step(0.1);
        const o = { first: txt('.threedog-hud-hint'), btn: txt('.threedog-hud-button') };
        engine.input.rebind('hintJump', ['KeyJ']); engine.step(0.1);
        o.rebound = txt('.threedog-hud-hint');
        engine.input.rebind('hintJump', null); engine.input.lastDevice = 'pad'; engine.step(0.1);
        o.pad = txt('.threedog-hud-hint');
        try { engine.hud.hint('x', { action: 'nope' }); } catch (e) { o.err = e.message; }
        // an action that goes away while its hint shows (a module's action handle removed): the hint loses its key, the frame does not throw
        const gone = engine.input.define('hintGone', { label: 'Gone', keys: ['KeyG'] });
        engine.hud.hint('hg', { action: 'hintGone', label: 'Gone' }); engine.step(0.1);
        o.goneBefore = [...document.querySelectorAll('.threedog-hud-hint')].map(x => x.textContent).find(t => /Gone/.test(t));
        gone.remove();
        try { engine.step(0.1); } catch (e) { o.goneErr = e.message; }
        o.goneAfter = [...document.querySelectorAll('.threedog-hud-hint')].map(x => x.textContent).find(t => /Gone/.test(t));
        // a declared action with no key: the same 'No key' text the interaction prompt shows (one key-text helper for both)
        engine.input.define('hintNone', { label: 'None' }); engine.hud.hint('hn', { action: 'hintNone', label: 'None' }); engine.step(0.1);
        o.none = [...document.querySelectorAll('.threedog-hud-hint')].map(x => x.textContent).find(t => /None/.test(t));
        engine.hud.remove('hj'); engine.hud.remove('hb'); engine.hud.remove('hg'); engine.hud.remove('hn');
        return o;
      });
      check('the hint shows the key of the action and its label; a button with action shows it too', /^.+ · Jump$/.test(r.first ?? '') && /^.+ · Go$/.test(r.btn ?? ''), JSON.stringify(r));
      check('a rebind and a switch to the pad change the shown key', /J/.test(r.rebound ?? '') && r.pad !== r.rebound && r.pad !== r.first, JSON.stringify(r));
      check('an unknown action is an error', /not an input action/.test(r.err ?? ''), JSON.stringify(r));
      check('a hint whose action was removed shows its label alone, without an error', / · Gone$/.test(r.goneBefore ?? '') && r.goneAfter === 'Gone' && !r.goneErr, JSON.stringify(r));
      check('a declared action with no key shows the input.noKey text, as the interaction prompt does', r.none === 'No key · None', JSON.stringify(r));
    },
  },
];
