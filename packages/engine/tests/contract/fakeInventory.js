// A whole replacement inventory in ~50 lines, written only against the public core (events, ops, saves): the proof that the inventory contract
// (modules/gameplay/inventory.contract.js) is small enough to meet. The shared contract check runs it exactly like the engine's own inventory.
// Deliberately plain: one bag of counts, no stacks / slots / weight / UI. A game that wants those wraps or replaces methods, not the engine.
export function fakeInventory() {
  const defs = new Map(), bags = new Map([['player', new Map()]]);
  const bag = id => { if (!bags.has(id)) bags.set(id, new Map()); return bags.get(id); };
  let e = null;
  const change = (id, item, n, type) => {
    const b = bag(id), have = b.get(item) ?? 0, next = have + n;
    if (next < 0) return false;
    if (next) b.set(item, next); else b.delete(item);
    e.events.emit(type === 'add' ? 'item:add' : 'item:remove', { container: id, actor: e.ops.actor, id: item, count: Math.abs(n), total: next });   // every bag, named
    return true;
  };
  const api = {
    define(id, def = {}) { defs.set(id, { name: id, ...def }); return api; },
    item: id => defs.get(id) ?? { name: id },
    add: (id, n = 1) => change(e.actor, id, n, 'add'),   // the player inventory = the bag of engine.actor
    remove: (id, n = 1) => change(e.actor, id, -n, 'remove'),
    count: id => bag(e.actor).get(id) ?? 0,
    has: (id, n = 1) => api.count(id) >= n,
    list: () => [...bag(e.actor)].map(([id, count]) => ({ id, count })),
    get: id => api.count(id) ? { key: id, id, count: api.count(id) } : null,
    container: id => ({ id, count: item => bag(id).get(item) ?? 0, has: (item, n = 1) => (bag(id).get(item) ?? 0) >= n, add: (item, n = 1) => change(id, item, n, 'add'), remove: (item, n = 1) => change(id, item, -n, 'remove') }),
    of: (actor = e.actor) => api.container(actor),   // an actor's bag is the container with its id
    transfer(from, to, item, n = 1) { if ((bag(from).get(item) ?? 0) < n) return false; change(from, item, -n, 'remove'); return change(to, item, n, 'add'); },
    trade(take, give) { for (const [k, n] of Object.entries(give)) if (!api.has(k, n)) return false; for (const [k, n] of Object.entries(give)) api.remove(k, n); for (const [k, n] of Object.entries(take)) api.add(k, n); return true; },
    // net sync: every bag as plain data and back (silent, like a load); a null entry empties that bag, only: true empties the bags not in data
    contents: () => Object.fromEntries([...bags].map(([id, b]) => [id, Object.fromEntries(b)])),
    setContents(data, { only = false } = {}) {
      if (only) for (const id of bags.keys()) if (!(id in data)) bags.set(id, new Map());
      for (const [id, items] of Object.entries(data)) bags.set(id, new Map(Object.entries(items ?? {})));
    },
    // content renames: a bag saved under an old authored id moves to the new one (null drops it)
    renameIds(map) { for (const [a, b] of Object.entries(map)) if (bags.has(a)) { if (b !== null) bags.set(b, bags.get(a)); bags.delete(a); } },
  };
  return {
    name: 'inventory', type: 'rules',
    install(engine) {
      e = engine;
      e.saves.define('inventory', { version: 1, save: () => ({ items: Object.fromEntries(bag('player')) }), load: d => { bags.set('player', new Map(Object.entries(d?.items ?? {}))); } });
      e.ops.define('inventory.transfer', { args: { from: 'string', to: 'string', item: 'string', n: 'int?' }, run: (e, a) => api.transfer(a.from, a.to, a.item, a.n) });
      e.ops.define('inventory.trade', { args: { take: 'any', give: 'any' }, run: (e, a) => api.trade(a.take, a.give) });
      e.ops.define('inventory.use', { args: { item: 'string' }, can: (e, a) => api.has(a.item) || 'notEnough', run: (e, a) => { e.events.emit('item:use', { id: a.item }); return api.remove(a.item, 1); } });
      e.ops.define('inventory.drop', { args: { item: 'string' }, can: (e, a) => api.has(a.item) || 'notEnough', run: (e, a) => api.remove(a.item, 1) });
      return api;
    },
    describe: () => ({ items: Object.fromEntries(bag('player')) }),
  };
}
