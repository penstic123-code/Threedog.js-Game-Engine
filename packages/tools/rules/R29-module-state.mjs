// Detection: R29 no mutable module-level state. A top-level `let` in an engine file is shared by every engine on the page (tests and editor previews run
// several): one engine's setting silently changes another's. State belongs on the engine or the instance.
// Flags a `let` declared at column 0 in packages/engine/{core,modules,render,ui}. Level: error in core, warn elsewhere.
// Known limits: a top-level const holding a mutable object (const cache = new Map()) is not flagged; page-wide state written that way is a design choice to document.
import { engineFiles, lines, P } from './_lib.mjs';

// [file under packages/engine, reason]
const ALLOW = [
  ['core/base/validate.js', 'page-wide by design and documented there: one validate switch and one warn-once set per page'],
  ['modules/timeline/Tween.js', 'tweenId: owner names for the page-wide allowOwned set must be unique across engines'],
  ['render/patches.js', 'deriving: re-entrancy flag around one synchronous patchMaterial call, always cleared in finally'],
  ['core/scene/gameLights.js', 'areaTables: three keeps the RectAreaLight tables in page-wide statics, so loading them is once per page'],
];

export default {
  id: 'R29', title: 'No mutable module-level state (top-level let)',
  run() {
    const out = [];
    for (const f of engineFiles()) {
      const base = f.slice(P.ENGINE_REL.length + 1);
      if (ALLOW.some(([file]) => file === base)) continue;
      lines(f).forEach((l, i) => {
        if (!/^let\s/.test(l)) return;
        out.push({ level: base.startsWith('core/') ? 'error' : 'warn', file: f, line: i + 1, msg: `top-level let: ${l.trim().slice(0, 60)}`,
          fix: 'keep it on the engine or the instance that owns it; if it must be page-wide, say so at the declaration and add it to ALLOW in R29' });
      });
    }
    return out;
  },
};
