import { coded, codedError } from '../core/base/errorHints.js';
import { DEV, warnOnce } from '../core/base/validate.js';
import { isObject } from '../core/base/util.js';
// UI theme and default CSS in <head> (part of ui/UI.js): the --threedog-* variables from createEngine({ ui: { theme } }), the engine's base classes, module
// defaults, the game's css. The classes use only var(--threedog-*), never a color of their own.
/** @import { UIOptions } from '../types/core' */

// The one set of picture variables every default part reads (table for games: recipes/26-ui-parts.md "Reskin"). The HUD values default to the main ones, not
// to grays of their own: a game that set bg / fg / accent got every window in its picture and a gray HUD, which read as "the engine UI cannot be reskinned"
const DEFAULT_UI = {
  bg: 'rgba(28,28,30,.92)', fg: '#ededed', muted: '#a0a0a0', accent: '#d0d0d0', good: '#c8c8c8', line: 'rgba(255,255,255,.15)',
  font: 'system-ui,"PingFang SC","Microsoft YaHei",sans-serif', radius: '12px', radiusSmall: '8px', loadingBg: '#202022', shadow: '0 20px 60px rgba(0,0,0,.35)',
  fadeBg: '#000', hudBg: 'color-mix(in srgb,var(--threedog-bg) 82%,transparent)', hudFg: 'var(--threedog-fg)', hudAccent: 'var(--threedog-accent)',
  shadowSmall: '0 1px 2px rgba(0,0,0,.6)',
};

// Game UI layers, low to high, in one place so a new part picks a slot instead of a number. title < window < toast < fade: a window opened from the title
// (Settings) must sit above it, and a toast above both. The tools' own panels (editor, gallery) are not part of the game and keep their own.
const LAYERS = { stick: 5, touch: 6, debug: 10, hud: 12, prompt: 15, letterbox: 18, dialogue: 20, title: 22, window: 25, toast: 35, fade: 90, loading: 100 };
const LAYER_VARS = Object.entries(LAYERS).map(([k, v]) => `--threedog-z-${k}:${v}`).join(';');

const BASE_CSS = `
:root{${LAYER_VARS}}
:where(.threedog-root > *){pointer-events:auto}
.threedog-ui{font:14px/1.55 var(--threedog-font);color:var(--threedog-fg)}
.threedog-win{box-sizing:border-box;overflow-wrap:anywhere;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:min(480px,calc(100% - 32px));
  max-height:min(70%,560px);overflow:auto;
  background:var(--threedog-bg);border:1px solid var(--threedog-line);border-radius:var(--threedog-radius);padding:16px 18px;z-index:var(--threedog-z-window);
  box-shadow:var(--threedog-shadow)}
.threedog-win-head{margin:0 0 10px;font-size:16px;color:var(--threedog-accent);letter-spacing:.04em;display:flex;justify-content:space-between;
  align-items:center;gap:8px}
.threedog-win-hint{color:var(--threedog-muted);font-weight:400;font-size:12px}
.threedog-btn{background:none;border:1px solid var(--threedog-line);border-radius:var(--threedog-radius-small);color:var(--threedog-fg);font:inherit;padding:4px 10px;cursor:pointer}
.threedog-btn:hover,.threedog-btn:focus-visible{border-color:var(--threedog-accent);outline:none}
.threedog-ui .is-cursor{outline:2px solid var(--threedog-accent);outline-offset:1px}
.threedog-close{border:0;color:var(--threedog-muted);font-size:13px}
.threedog-empty{color:var(--threedog-muted)}
.threedog-list{display:flex;flex-direction:column}
.threedog-row{display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--threedog-line)}
.threedog-icon{width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:22px;flex:none}
.threedog-icon img{width:100%;height:100%;object-fit:contain}
.threedog-row-main{flex:1;min-width:0}.threedog-row-sub{color:var(--threedog-muted);font-size:12px}
.threedog-count{font-variant-numeric:tabular-nums;font-weight:700}
.threedog-quest{margin-bottom:12px}.threedog-quest-title{font-weight:700}.threedog-quest.is-done .threedog-quest-title{color:var(--threedog-muted)}
.threedog-steps{margin:6px 0 0;padding-left:20px}.threedog-step{color:var(--threedog-muted)}.threedog-step.is-current{color:var(--threedog-fg)}
  .threedog-step.is-done{color:var(--threedog-good)}
.threedog-toasts{position:fixed;top:calc(16px + env(safe-area-inset-top,0px));left:50%;transform:translateX(-50%);display:flex;flex-direction:column;
  gap:6px;align-items:center;z-index:var(--threedog-z-toast);pointer-events:none}
.threedog-toast{background:var(--threedog-bg);border:1px solid var(--threedog-accent);border-radius:var(--threedog-radius-small);
  padding:6px 14px;animation:threedogIn .25s ease-out;transition:opacity .4s}
.threedog-prompt{position:fixed;left:0;top:0;transform:translate(-50%,-100%);padding:6px 10px;border-radius:var(--threedog-radius-small);background:var(--threedog-bg);
  color:var(--threedog-fg);font:13px var(--threedog-font);cursor:pointer;z-index:var(--threedog-z-prompt);white-space:nowrap}
.threedog-prompt-hold{background:linear-gradient(90deg,var(--threedog-accent) calc(var(--progress,0)*100%),var(--threedog-bg) 0)}
.threedog-dlg{box-sizing:border-box;overflow-wrap:anywhere;position:fixed;left:50%;transform:translateX(-50%);bottom:calc(24px + env(safe-area-inset-bottom,0px));
  width:min(640px,calc(100% - 32px));
  background:var(--threedog-bg);color:var(--threedog-fg);border:1px solid var(--threedog-line);border-radius:var(--threedog-radius);
  padding:14px 18px 16px;font:15px/1.6 var(--threedog-font);z-index:var(--threedog-z-dialogue);cursor:pointer}
.threedog-dlg-name{display:block;color:var(--threedog-accent);font-size:13px;margin-bottom:4px;letter-spacing:.05em;font-weight:700}
.threedog-dlg-opts{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.threedog-dlg-opts .threedog-btn{text-align:left}
.threedog-dlg-hint{position:absolute;right:14px;bottom:8px;font-size:12px;opacity:.6}
.threedog-loading{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:var(--threedog-loading-bg);
  color:var(--threedog-fg);z-index:var(--threedog-z-loading);transition:opacity .6s;font-family:var(--threedog-font)}
.threedog-loading-box{display:flex;flex-direction:column;gap:14px;align-items:center;width:min(360px,80%)}
.threedog-loading-title{font-weight:600;font-size:20px;letter-spacing:.08em}
.threedog-loading-track{width:100%;height:4px;background:var(--threedog-line);border-radius:2px;overflow:hidden}
.threedog-loading-bar{height:100%;width:0;background:var(--threedog-accent);transition:width .2s}
.threedog-loading-msg{font-size:13px;color:var(--threedog-muted);min-height:1.5em}
.threedog-stick{position:fixed;left:calc(24px + env(safe-area-inset-left,0px));bottom:calc(28px + env(safe-area-inset-bottom,0px));width:110px;
  height:110px;border-radius:50%;
  background:var(--threedog-bg);opacity:.7;border:1px solid var(--threedog-line);touch-action:none;z-index:var(--threedog-z-stick)}
.threedog-touch-bar{position:fixed;right:calc(16px + env(safe-area-inset-right,0px));bottom:calc(96px + env(safe-area-inset-bottom,0px));display:flex;
  flex-wrap:wrap-reverse;gap:10px;justify-content:flex-end;width:160px;z-index:var(--threedog-z-touch)}
.threedog-touch-btn{width:64px;height:64px;border-radius:50%;border:1px solid var(--threedog-line);background:var(--threedog-bg);
  color:var(--threedog-fg);font:600 13px var(--threedog-font);touch-action:none}
.threedog-touch-btn:active{border-color:var(--threedog-accent)}
.threedog-stick-knob{position:absolute;left:35px;top:35px;width:40px;height:40px;border-radius:50%;background:var(--threedog-accent)}
.threedog-fade{position:fixed;inset:0;background:var(--threedog-fade-bg);opacity:var(--threedog-fade,0);pointer-events:none;z-index:var(--threedog-z-fade)}
.threedog-fade.is-on{pointer-events:auto}
@keyframes threedogIn{from{transform:translateY(-8px);opacity:0}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){.threedog-toast{animation:none}}
`;

// <head> styles. Engine and module defaults go before every game's CSS, so ui.css wins ties of equal specificity
// whatever order modules inject their defaults in. Defaults are deduped by text and shared by every engine on the page (removed
// with the last one); a game's CSS and theme variables belong to its engine and go with its dispose().
const defaults = new Map();   // css text -> its <style>
const live = new Set();       // engines whose ui picture is applied
const kebab = k => k.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
/**
 * Add default CSS (engine or module picture, built only from var(--threedog-*)) once per page, ahead of every game's CSS
 * @internal
 */
export function injectUICSS(css = '') {
  for (const text of [BASE_CSS, css]) {
    if (!text || defaults.has(text)) continue;
    const el = document.createElement('style'); el.dataset.threedog = 'default'; el.textContent = text;
    document.head.insertBefore(el, document.head.querySelector('[data-threedog-pack]'));   // no pack yet: appended
    defaults.set(text, el);
  }
}
/**
 * Apply createEngine({ ui }): ui.theme as variables (--threedog-*) on engine.uiRoot and ui.css after every default. Fonts are asset names
 * (ui.fonts: ['pixel'], registered with engine.assets.manifest({ fonts: { pixel: '/fonts/pixel.woff2' } }) and loaded at start()),
 * then used in ui.theme.font, e.g. '"pixel", system-ui'. The returned handle removes what it added (engine.dispose).
 * @internal
 * @param {{ uiRoot: HTMLElement }} engine
 * @param {UIOptions} [ui]
 * @returns {{ remove(): void }}
 */
export function applyUITheme(engine, ui = {}) {
  checkUiOptions(ui);
  live.add(engine);
  injectUICSS();
  const t = { ...DEFAULT_UI, ...ui.theme }, r = engine.uiRoot.style;
  for (const k in t) if (typeof t[k] === 'string' || typeof t[k] === 'number') r.setProperty('--threedog-' + kebab(k), String(t[k]));
  const nodes = [];
  const add = (tag, props) => { const n = Object.assign(document.createElement(tag),
    props); n.dataset.threedogPack = ''; document.head.appendChild(n); nodes.push(n); };
  if (ui.css) add('style', { textContent: ui.css });
  return {
    remove() {
      for (const n of nodes.splice(0)) n.remove();
      live.delete(engine);
      if (!live.size) { for (const el of defaults.values()) el.remove(); defaults.clear(); }
    },
  };
}
// The picture keys sit beside the part names in createEngine({ ui }), so a wrong shape would otherwise do nothing or reach a part: refuse it with the right form.
/** @param {UIOptions} ui */
function checkUiOptions({ theme, css, fonts, templates }) {
  const plain = v => v == null || isObject(v);
  if (!plain(theme)) throw codedError('ui-misuse', `ui.theme is an object of CSS values, got ${JSON.stringify(theme)}. Example: ui: { theme: { bg: '#1c140e', accent: '#e8a13a' } }`);
  if (DEV && theme?.promptHeight != null) warnOnce(coded('ui-misuse', `ui.theme.promptHeight moves nothing: the interaction prompt's height is interactions({ promptHeight: ${theme.promptHeight} })`));
  if (css != null && typeof css !== 'string') throw codedError('ui-misuse', `ui.css is CSS text placed after every default, got ${typeof css}`);
  if (!plain(templates)) throw codedError('ui-misuse', 'ui.templates is { windowName: (data, { esc, t, icon }) => html }');
  // a font file is an asset, so the game names it here: a path would load nothing
  if (fonts != null && !(Array.isArray(fonts) && fonts.every(n => typeof n === 'string' && !/[/\.]/.test(n))))
    throw codedError('ui-misuse', `ui.fonts must be a list of font asset names, got ${JSON.stringify(fonts)}. Example: fonts: ['pixel'] with `
      + "engine.assets.manifest({ fonts: { pixel: '/fonts/pixel.woff2' } })");
}
