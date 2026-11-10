// Timeline letterbox bars and skip button (helper of Timeline.js): built once when the module installs; Timeline._refreshUI() toggles them per run.
import { injectUICSS } from '../../ui/UI.js';

export function buildLetterbox(t) {
  injectUICSS(`
.threedog-letterbox{position:fixed;left:0;right:0;height:0;background:var(--threedog-letterbox-bg,var(--threedog-loading-bg));z-index:18;pointer-events:none;transition:height var(--threedog-letterbox-speed,.5s) ease}
.threedog-letterbox-top{top:0}.threedog-letterbox-bottom{bottom:0}
.threedog-letterbox.is-on{height:var(--threedog-letterbox-size,11%)}
.threedog-letterbox-skip{position:absolute;right:calc(16px + env(safe-area-inset-right,0px));bottom:12px;font:12px var(--threedog-font);color:var(--threedog-muted);
background:none;border:0;cursor:pointer;pointer-events:auto;opacity:0;transition:opacity .4s}
.threedog-letterbox.is-on .threedog-letterbox-skip.is-on{opacity:.8}
.threedog-letterbox-skip:hover,.threedog-letterbox-skip:focus-visible{color:var(--threedog-fg);outline:none}
@media (prefers-reduced-motion:reduce){.threedog-letterbox{transition:none}}
`);
  const bar = cls => { const b = document.createElement('div'); b.className = `threedog-ui threedog-letterbox ${cls}`; t.engine.uiRoot.appendChild(b); return b; };
  /** @internal */ t.top = bar('threedog-letterbox-top');
  /** @internal */ t.bottom = bar('threedog-letterbox-bottom');
  /** @internal */ t.skipBtn = document.createElement('button');
  t.skipBtn.type = 'button'; t.skipBtn.className = 'threedog-letterbox-skip';
  t.skipBtn.addEventListener('click', () => { for (const r of t.runs) if (r.skippable) t.skip(r); });
  t.bottom.appendChild(t.skipBtn);
  t._track({ remove() { t.top.remove(); t.bottom.remove(); } });   // the bars own the button and its click listener
  t._track(t.engine.events.on('i18n:change', () => t._refreshUI()));
  t._track(t.engine.events.on('input:rebind', () => t._refreshUI()));
}
