// Chunk generation handler: the same code answers in the terrain worker (chunkWorker.js) and on the main thread when there are no workers (engine.threads lane fallback).
// Runs in a Worker: must not import three.js (see CONVENTIONS "Worker limits"); vegetation rules arrive as plain data.
import { createTerrain } from './terrainGen.js';

/** @returns {(msg: any) => any} handler for { type: 'init' | 'species' | 'job' } messages */
export function chunkHandler() {
  let T = null, species = {};
  return d => {
    if (d.type === 'init') { T = createTerrain(d.terrain); species = d.species || {}; return null; }
    if (d.type === 'species') { if (d.rule == null) delete species[d.name]; else species[d.name] = d.rule; return null; }
    const t0 = performance.now();   // measure
    T.setEdits(d.edits);   // only the edits around this chunk travel with the job (null when there are none)
    const out = { regrow: !!d.regrow, gen: d.gen, cid: d.cid, vgen: d.vgen, ev: d.ev, cx: d.cx, cz: d.cz, terrain: d.terrain ? T.buildChunk(d.cx, d.cz) : null, veg: {}, ms: 0 };
    for (const name of d.species) out.veg[name] = T.place(d.cx, d.cz, species[name], d.density);
    // compute time: the main thread subtracts it from the round trip to get the transit cost (Budget.js ApplyCost)
    out.ms = performance.now() - t0;   // measure
    return out;
  };
}
