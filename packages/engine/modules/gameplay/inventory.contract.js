// What any inventory must provide so saves, describe, verify, ops and the other modules keep working when a game replaces the engine's inventory
// (docs/plans/done/2026-11-02-gameplay-architecture.md §1.3). Plain data; the shared check is @threedog/tools/contract, which the engine's
// inventory and any replacement both pass (tools test "contracts").
//   api: the methods other modules and games may call (the only cross-module calls allowed, §3.1; rule R50 fails engine code calling one not listed); engine.wrap works on these
//   ops / events / saves ({ key: version }): names other code relies on; describe: true = reports under describe().<name>
//   options: what the shared check installs it with; probe: the calls it makes (setup, one call per event that must fire, a value that survives
//   save -> fresh install -> load; copy: what one install reads comes back the same written into a fresh one: net's host -> client sync)
export default {
  name: 'inventory',
  api: ['define', 'item', 'add', 'remove', 'count', 'has', 'list', 'get', 'container', 'of', 'transfer', 'trade',
    'contents', 'setContents', 'renameIds'],   // contents / setContents: net syncs containers through these; renameIds: content renames move goods
  ops: ['inventory.transfer', 'inventory.trade', 'inventory.use', 'inventory.drop'],
  events: ['item:add', 'item:remove', 'item:use'],   // item:add / item:remove carry { container, actor } for every container
  saves: { inventory: 1, containers: 2 },
  describe: true,
  options: {},
  probe: {
    setup: [['define', 'fish', { name: 'Fish', stack: 20 }]],
    emits: [['item:add', ['add', 'fish', 3]], ['item:remove', ['remove', 'fish', 1]]],
    state: { read: ['count', 'fish'], expect: 2 },
    copy: { read: ['contents'], write: 'setContents' },
  },
};
