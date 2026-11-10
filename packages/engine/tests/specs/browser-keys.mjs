// Browser keys while playing: a bound Ctrl+S is defaultPrevented only while playing (not paused, no menu, no text field), an unbound key never, option off nothing.
// Run: npm test -- "browser keys"
export const specs = [
  {
    name: 'browser keys: bound Ctrl+S prevented while playing, not in a menu / paused / in a text field / unbound; blockBrowserKeys false prevents nothing',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.timeline.skip(); engine.step(1, { render: false }); await new Promise(r => setTimeout(r, 50)); engine.step(1, { render: false });
        const I = engine.input, o = {};
        I.define('tSave', { keys: ['KeyS'] });
        const press = (code, target = document.body) => { const e = new KeyboardEvent('keydown', { code, ctrlKey: true, bubbles: true, cancelable: true }); target.dispatchEvent(e); return e.defaultPrevented; };
        o.playing = press('KeyS');
        o.unbound = press('F9');
        const field = document.body.appendChild(document.createElement('input'));
        o.textField = press('KeyS', field); field.remove();
        const h = I.push('tmenu'); engine.step(1, { render: false });
        o.menu = press('KeyS'); h.remove(); engine.step(1, { render: false });
        const frz = engine.freeze('t-browser-keys'); o.paused = press('KeyS'); frz.remove();
        I.blockBrowserKeys = false; o.off = press('KeyS'); I.blockBrowserKeys = true;
        return o;
      });
      check('bound Ctrl+S prevented while playing', r.playing === true);
      check('unbound key not prevented', r.unbound === false);
      check('text field keeps the key', r.textField === false);
      check('menu releases the key', r.menu === false);
      check('pause releases the key', r.paused === false);
      check('option off prevents nothing', r.off === false);
    },
  },
];
