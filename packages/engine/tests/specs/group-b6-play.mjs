// Group B6-play: cross-change conflicts found in review. One test item per fix in a page; the contract engine and rule R67 are guarded in the tools tests
// (packages/tools/tests/contracts.mjs, atomic-parts-rule.mjs).
const PAGE = '/tests/threads/';

export const specs = [
  {
    // the bloom row follows effects by role, and the role's effects change while the row is off: the row must give back what it holds, not what a fresh query finds
    name: '[guard] group B6-play item 1: a legacy bloom switched off by settings comes back on after a glow effect joined the role, and unloading settings leaves nothing held',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(() => {
        const T = threedogThreads, E = T.mk(T.createEngine, 'b6-1');
        E.use(T.all.settings());
        E.start(); E.haltLoop();
        const stub = () => ({ render() {}, setSize() {}, dispose() {} });
        const old = E.post.add({ name: 'bloom', slot: 'hdr', create: stub });   // written before roles existed: no about.acts
        E.settings.set('bloom', false); const off = old.enabled;
        const glow = E.post.add({ name: 'glow', slot: 'hdr', order: 40, about: { acts: 'glow' }, create: stub });   // now the role has a declared member
        const glowOff = glow.enabled;
        E.settings.set('bloom', true);
        const on = { old: old.enabled, glow: glow.enabled };
        E.settings.set('bloom', false);
        E.unuse('settings');
        const unloaded = { old: old.enabled, glow: glow.enabled };
        E.dispose();
        return { off, glowOff, on, unloaded };
      });
      check('off holds the legacy bloom; the glow joining takes the row; on lifts both; unloading lifts what was held', r.off === false && r.glowOff === false && r.on.old && r.on.glow && r.unloaded.old && r.unloaded.glow, JSON.stringify(r));
    },
  },
];
