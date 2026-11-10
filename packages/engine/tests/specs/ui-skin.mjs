// Reskin in one place: the short ui.theme of recipe 26 must reach every default part. Agents wrote their own dialogue box and HUD because the defaults were
// gray and the HUD ignored the main colors; this file goes red when a default part stops reading the shared variables.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '../..');
const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(f => f.isDirectory() ? walk(join(d, f.name)) : f.name.endsWith('.js') ? [join(d, f.name)] : []);

export const specs = [
  {
    name: '[guard] UI skin: one short ui.theme reaches the title, toast, prompt, dialogue, HUD and menu, and no default CSS rule holds a color or corner of its own',
    url: '/tests/ui/index.html?mode=skin',
    async run({ check, ev }) {
      // the debug panel is a dev tool (R39 exempts it too); every player-facing rule must go through a variable, or that part cannot follow the game's picture
      const own = [...walk(join(ENGINE, 'ui')), ...walk(join(ENGINE, 'modules'))].filter(f => !/[\\/]debug[\\/]/.test(f)).flatMap(f => readFileSync(f, 'utf8').split('\n')
        .filter(l => /^\s*(\.threedog|[a-z-]+:[^\s'"])/.test(l) && /#[0-9a-f]{3,8}\b|rgba?\(|border-radius:(?!0|50%)\d{2,}|border-radius:[89]px/i.test(l))
        .map(l => f.slice(ENGINE.length + 1) + ': ' + l.trim().slice(0, 70)));
      check('default CSS rules use only var(--threedog-*) for colors and corners', !own.length, own.join(' | '));
      // one road: every part reads createEngine({ ui }) through engine.ui, never a style section
      const road = [...walk(join(ENGINE, 'ui')), join(ENGINE, 'modules/hud/parts.js'), join(ENGINE, 'modules/gameplay/questLog.js'), join(ENGINE, 'modules/gameplay/inventoryOps.js'), join(ENGINE, 'modules/gameplay/Interactions.js')]
        .filter(f => /\b(engine|e|this)\.(style|look)\b|makeMaterial/.test(readFileSync(f, 'utf8')));
      check('UI code reaches no engine.style / engine.look / makeMaterial', !road.length, road.join(' | '));

      const look = await ev(async () => {
        const css = sel => { const el = document.querySelector(sel); if (!el) return null; const c = getComputedStyle(el);
          return { bg: c.backgroundColor, fg: c.color, font: c.fontFamily, corner: c.borderTopLeftRadius, border: c.borderTopColor }; };
        await __t.until(() => engine.ui.isOpen('title'), 5000);
        await engine.ui.settled();
        const title = css('.threedog-title');
        await engine.session.newGame(); engine.ui.close('title');
        await __t.until(() => engine.input.enabled, 5000);
        window.toast('hello');
        engine.hud.addCounter('shells', { label: 'Shells', value: 1, max: 4 }); engine.hud.bar('hp', { value: 0.5, label: 'HP' });
        engine.step(0.1);
        const parts = { toast: css('.threedog-toast'), prompt: css('.threedog-prompt'), counter: css('.threedog-hud-counter'), hudText: css('.threedog-hud'), fill: css('.threedog-hud-bar-fill') };
        engine.dialogue.start('npc'); engine.step(0.1);
        const dlg = css('.threedog-dlg');
        engine.dialogue.end(); engine.step(0.1);
        engine.settings.open(); engine.step(0.1);
        const menu = css('.threedog-win'), menuButton = css('.threedog-win .threedog-btn'); engine.settings.close();
        return { skin: window.skin, title, ...parts, dlg, menu, menuButton };
      });
      const { skin: s, title, toast, prompt, counter, hudText, fill, dlg, menu, menuButton } = look;
      const font = p => p?.font?.includes('SkinTestFont');
      check('title screen: loadingBg, fg, font', title?.bg === s.loadingBg && title.fg === s.fg && font(title), JSON.stringify(title));
      check('toast: bg, accent border, small corner', toast?.bg === s.bg && toast.border === s.accent && toast.corner === s.radiusSmall, JSON.stringify(toast));
      check('prompt: bg, fg, font, small corner', prompt?.bg === s.bg && prompt.fg === s.fg && font(prompt) && prompt.corner === s.radiusSmall, JSON.stringify(prompt));
      check('dialogue box: bg, fg, font, corner', dlg?.bg === s.bg && dlg.fg === s.fg && font(dlg) && dlg.corner === s.radius, JSON.stringify(dlg));
      check('menu button: small corner', menuButton?.corner === s.radiusSmall, JSON.stringify(menuButton));
      // the HUD background is the game's bg made a little see-through: its channels must be the game's, whatever form the browser prints it in
      const ch = (counter?.bg.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map(v => /color\(/.test(counter.bg) ? Math.round(v * 255) : v);
      check('HUD: counter background from bg, text from fg, bar from accent, with no HUD values set', ch.join() === '10,20,30' && hudText?.fg === s.fg && fill?.bg === s.accent, JSON.stringify({ counter, hudText, fill }));
      check('menu window: bg, corner, line', menu?.bg === s.bg && menu.corner === s.radius && menu.border === s.line, JSON.stringify(menu));

      const entry = await ev(() => {
        const make = ui => window.createEngine({ canvas: document.createElement('canvas'), headless: true, saveKey: 'ui-entry', ui: { loading: false, ...ui } });
        const err = ui => { try { make(ui).dispose(); return ''; } catch (x) { return x.message; } };
        const e = make({ theme: { accent: 'rgb(1, 2, 3)' }, templates: { quests: () => '<p>mine</p>' }, toast: false });
        const out = { accent: e.uiRoot.style.getPropertyValue('--threedog-accent'), tpl: e.ui.templates.quests(), toastOff: e.ui.get('toast') === null };
        e.ui.templates.other = () => '';   // plain and writable, read each time a window draws
        out.live = typeof e.ui.templates.other;
        e.dispose();
        return { ...out, flat: err({ bg: '#123' }), height: err({ theme: { promptHeight: 3 } }), font: err({ fonts: ['/x.woff2'] }) };
      });
      check('picture keys and part names live side by side in createEngine({ ui })', entry.accent === 'rgb(1, 2, 3)' && entry.tpl === '<p>mine</p>' && entry.toastOff && entry.live === 'function', JSON.stringify(entry));
      check('a color outside theme says where it goes', /ui: \{ theme: \{ bg/.test(entry.flat), entry.flat);
      check('theme.promptHeight no longer stops the game (a dev warning points at interactions({ promptHeight }))', entry.height === '', entry.height);
      check('ui.fonts with a path is refused', /font asset names/.test(entry.font), entry.font);
    },
  },
];
