// Second review before 1.0: lifecycle, settings, UI. Each item was a proven bug and stays as a [guard].

export const specs = [
  {
    // the default page adds its bloom after the settings module installed, the order any game's boot code gives
    name: "[guard] settings: bloom switched off in the menu is off again after a reload, and the menu shows the effect as it runs",
    url: '/?threedog-headless',
    async run({ check, ev, page }) {
      const menu = () => ev(async () => {
        engine.ui.open('settings'); await new Promise(r => setTimeout(r, 50));
        const row = [...engine.settings.win.el.querySelectorAll('[data-set="bloom"]')][0], out = { shown: row?.getAttribute('aria-pressed') ?? null, running: engine.post.get('bloom')?.enabled ?? null };
        engine.ui.close('settings'); return out;
      });
      const a = await menu();
      check('a running bloom reads on in the menu', a.running !== true || a.shown === 'true', JSON.stringify(a));
      const live = await ev(async () => { engine.settings.set('bloom', false); await new Promise(r => setTimeout(r, 200)); return { running: engine.post.get('bloom').enabled, stored: engine.settings.get('bloom') }; });
      check('off takes effect at once', live.running === false, JSON.stringify(live));
      await page.reload();
      await page.waitForFunction(() => window.engine?.phase === 'running', null, { timeout: 60000 });
      const b = await ev(() => ({ running: engine.post.get('bloom')?.enabled, stored: engine.settings.get('bloom') }));
      check('still off after the reload', b.running === false, JSON.stringify(b));
    },
  },
  {
    name: "[guard] settings: the player's ao off holds for an effect added after the settings loaded",
    url: '/?threedog-headless',
    async run({ check, ev }) {
      const r = await ev(() => {
        const fx = { name: 'ao', fuse: { glsl: 'color.rgb *= 0.9;', tsl: c => c }, slot: 'hdr' };
        const had = !!engine.post.get('ao');
        // what a reload does: the saved value is applied while the game has not added its effect yet (settings install before the game's boot code)
        engine.settings.set('ao', false, { save: false });
        const h = engine.post.add(fx);
        return { had, setting: engine.settings.get('ao'), running: h.enabled };
      });
      check('off in the menu means off in the picture', r.setting === false && r.running === false, JSON.stringify(r));
    },
  },
  {
    name: "[guard] settings: the player's bloom off survives the game adding the effect again (a level that rebuilds its post)",
    url: '/?threedog-headless',
    async run({ check, ev }) {
      const r = await ev(() => {
        const fx = { name: 'bloom', fuse: { glsl: 'color.rgb *= 0.9;', tsl: c => c }, slot: 'hdr' };
        engine.post.get('bloom')?.remove();
        const a = engine.post.add(fx);
        engine.settings.set('bloom', false, { save: false });
        const before = a.enabled;
        a.remove();
        const b = engine.post.add(fx);
        const out = { before, setting: engine.settings.get('bloom'), running: b.enabled };
        // another owner's hold rides through the same way; only the game's own word starts over with the effect
        engine.settings.set('bloom', true, { save: false });
        const cut = engine.mod('post.bloom.enabled', { owner: 'cutscene', layer: 'effect', set: false });
        b.enabled = false; b.remove();
        const c = engine.post.add(fx);
        out.held = c.enabled;
        cut.remove();
        out.gameStartsOver = c.enabled;
        return out;
      });
      check("another owner's hold survives, the game's own off does not", r.held === false && r.gameStartsOver === true, JSON.stringify(r));
      check('held off before', r.before === false, JSON.stringify(r));
      check('still held off after the effect came back', r.setting === false && r.running === false, JSON.stringify(r));
    },
  },
];
