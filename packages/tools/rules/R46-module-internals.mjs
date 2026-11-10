// R46 a module does not import another module's internal files (error; R25 is the same boundary for _private members): modules talk through the public engine.<module> API or events,
// so one module's file layout can change without breaking another. Flags any import in packages/engine/modules/<module>/ (`from '...'`, `import '...'`,
// dynamic `import('...')`) whose path, resolved, lands in another module folder ('../nav/x.js' and '../../modules/nav/x.js' alike).
// Allowed pairs below, each with its reason: only worker-safe files that the owning module itself says it shares with a worker (the module's
// public entry imports core/base/math.js and with it three.js, which a worker must not load). R25 covers the same boundary for _private members.
import { lines, walk, importSpecs, moduleTarget, P } from './_lib.mjs';

// [importing module, target path prefix, why]
const ALLOW = [
  ['characters', 'collision/grid.js', 'the path worker (characters/pathJob.js) rebuilds the collider grid with the same code collision uses'],
  ['nav', 'collision/grid.js', 'collider layers: the navmesh cut for a layer list skips the colliders walking and A* skip, through the same passesOf / passesThrough'],
  ['characters', 'nav/navPath.js', 'the path worker runs the one navmesh search on its imported copy of the mesh (navPath.js says so)'],
];

export default {
  id: 'R46', title: 'A module does not import another module\'s internal files',
  run() {
    const out = [];
    for (const f of walk(P.MODULES_REL)) {
      const mod = f.slice(P.MODULES_REL.length + 1).split('/')[0];
      lines(f).forEach((raw, i) => {
        for (const spec of importSpecs(raw)) {
          const t = moduleTarget(f, spec);
          if (!t || t.folder === mod || ALLOW.some(([a, b]) => a === mod && t.path.startsWith(b))) continue;
          out.push({ level: 'error', file: f, line: i + 1, msg: `module "${mod}" imports ${t.path} directly${spec === `../${t.path}` ? '' : ` (written '${spec}')`}`,
            fix: 'go through the public engine.<module> API or an event; a worker-safe shared file is added to ALLOW in R46 with its reason' });
        }
      });
    }
    return out;
  },
};
