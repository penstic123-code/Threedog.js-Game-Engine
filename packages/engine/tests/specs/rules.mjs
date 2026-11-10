// Browser test for rule R3 "save round trip" (same format as the other files here):
// For every key registered with engine.saves.define:
//   1. apply(JSON.parse(JSON.stringify(collect())))         → collect must not change (real saves go through JSON; catches Map/Set/class instances being saved, and fields lost on load)
//   2. apply(collect())                                      → collect must not change (loading what was just saved must not change state; catches bugs like "save returns the original object, load clears then merges")
// Comparison uses "JSON with sorted keys", so a different key order does not count as a difference. One check per key; on failure it shows the start of the before/after difference.
// First build a little state through the public API (story flag, counter, inventory), otherwise an empty-state round trip is always equal and finds nothing.
// Only the public API (saves.providers / collect / apply) is used; private fields starting with _ are not read.
function roundTrip() {
  const stable = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));
  engine.timeline?.skip?.();
  engine.haltLoop();
  // Build state (skipped if the module is not installed)
  try { engine.vars.setFlag('r3.flag', true); engine.vars.bump('r3.count', 2); } catch { /* no vars */ }
  try { const id = engine.inventory && [...(engine.inventory.defs?.keys?.() ?? [])][0]; if (id) engine.inventory.add(id, 1, { silent: true }); } catch { /* no inventory */ }
  engine.step(0.1, { render: false });
  const S = engine.saves, keys = [...S.providers.keys()];
  // Turn into a text snapshot immediately: collect() may return a module's internal object, and a later apply changes it, so the snapshot must not follow
  const snap = () => { const p = S.collect().parts; return Object.fromEntries(keys.map(k => [k, stable(p[k]) ?? 'undefined'])); };
  // Do the JSON round trip first (it reads a copy and does not break the scenario), then apply(collect()) (which may clear the scenario), so the two do not affect each other
  const c1 = snap();
  S.apply(JSON.parse(JSON.stringify(S.collect())));
  const c3 = snap();
  S.apply(S.collect());
  const c2 = snap();
  const diff = (x, y) => { let i = 0; while (i < x.length && x[i] === y[i]) i++; return `…${x.slice(Math.max(0, i - 30), i + 50)} → …${y.slice(Math.max(0, i - 30), i + 50)}`; };
  return keys.map(k => ({ k, self: c1[k] === c2[k], json: c1[k] === c3[k], d1: diff(c1[k], c2[k]), d2: diff(c1[k], c3[k]) }));
}

const page = (name, url) => ({
  name: `rule R3 save round trip (${name})`,
  url,
  async run({ check, ev }) {
    const res = await ev(roundTrip);
    check('at least one save key is registered', res.length > 0, String(res.length));
    for (const r of res) {
      check(`save key ${r.k}: collect unchanged after apply(collect())`, r.self, r.d1);
      check(`save key ${r.k}: collect unchanged after a JSON round trip`, r.json, r.d2);
    }
  },
});

export const specs = [
  page('open world', '/'),
  page('town', '/tests/city/index.html'),
];
