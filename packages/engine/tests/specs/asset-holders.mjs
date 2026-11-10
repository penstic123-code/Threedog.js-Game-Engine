// engine.explain({ asset }): a lease says who took it, so "why is this model still in memory" is answered by name
// (docs/plans/2026-11-10-lease-holders.md). Headless engines on the loading test page.
const page = '/tests/loading/index.html';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export const specs = [
  {
    name: 'asset holders: explain({ asset }) names each holder, and a holder that let go disappears',
    url: page,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { make, gltfUrl } = threedogLoad;
        const E = make('ah-holders', { ui: { loading: false } }); await E.start();
        const A = E.assets;
        A.manifest({ models: { rock: gltfUrl() } });
        const l1 = await A.lease('rock', 'quests'), l2 = await A.lease('rock', 'minimap');
        const copy = await A.model('rock'); E.add(copy);
        const both = E.explain({ asset: 'rock' });
        l1.remove();
        const one = E.explain({ asset: 'rock' });
        const unknown = E.explain({ asset: 'nope' });
        E.remove(copy); l2.remove();
        const none = E.explain({ asset: 'rock' });
        E.dispose();
        return { both: both.text, one: one.text, none: none.text, detail: both.detail, unknown: unknown.ok };
      }).catch(err => ({ err: String(err) }));
      check('lists every holder label with the count', /3 holders/.test(r.both) && /quests/.test(r.both) && /minimap/.test(r.both) && /model copy/.test(r.both) && r.detail?.current?.holders?.quests === 1, JSON.stringify(r));
      check('a holder that removed its lease is gone from the answer', /2 holders/.test(r.one) && !/quests/.test(r.one) && /minimap/.test(r.one), JSON.stringify(r));
      check('with no holder left it says so and how to free it', /nothing holds it/.test(r.none) && !/minimap/.test(r.none), JSON.stringify(r));
      check('an unknown name is an answer, not a throw', r.unknown === false, JSON.stringify(r));
    },
  },
  {
    name: 'asset holders: a pinned build says why it stays; a retired build and a waiting release are told apart',
    url: page,
    async run({ check, ev }) {
      const r = await ev(async png => {
        const T = __threedogThree, { make, gltfUrl } = threedogLoad;
        const E = make('ah-pinned', { ui: { loading: false } }); await E.start();
        const A = E.assets;
        A.manifest({ name: 'ah', models: { rock: gltfUrl() } });
        await A.cached('ahBox', () => new T.BoxGeometry());
        const key = [...A.entries.keys()].find(k => k.startsWith('cached:ahBox'));
        const pinned = E.explain({ asset: key }).text;
        const lease = await A.lease('rock', 'quests');
        await E.debug.reloadAssets({ name: 'ah', models: { rock: gltfUrl(png) } });
        const swapped = E.explain({ asset: 'rock' });
        lease.remove();
        const gone = E.explain({ asset: 'rock' }).detail.retired.length;
        // a generated model rebuilt by a hot swap: its cache entry is deleted, the pinned old build is still drawn, and explain finds it under the name and under the old key
        const gen = () => new T.Mesh(new T.BoxGeometry(), new T.MeshBasicMaterial());
        A.manifest({ name: 'ah2', models: { gen } });
        const g = await A.cached('gen', gen), gk = [...A.entries.keys()].find(k => k.startsWith('cached:gen:'));
        E.add(g);
        await E.debug.reloadAssets({ name: 'ah2', models: { gen: () => new T.Mesh(new T.SphereGeometry(), new T.MeshBasicMaterial()) } });
        const byName = E.explain({ asset: 'gen' }), byKey = E.explain({ asset: gk });
        const copy = await A.model('rock'); E.add(copy);
        A.release('rock');
        const waiting = E.explain({ asset: 'rock' }).text;
        E.dispose();
        return { pinned, gone, byName: { ok: byName.ok, retired: byName.detail?.retired, text: byName.text }, byKey: { ok: byKey.ok, n: byKey.detail?.retired?.length }, retired: swapped.detail?.retired, swapped: swapped.text, waiting };
      }, PNG).catch(err => ({ err: String(err) }));
      check('a pinned generated build gives the reason', /pinned: generated model prototypes/.test(r.pinned ?? ''), JSON.stringify(r));
      check('a replaced build kept by a lease is listed as retired with its holder and why', r.retired?.length === 1 && r.retired[0].users === 1 && r.retired[0].holders?.quests === 1 && /retired build/.test(r.swapped) && /quests/.test(r.swapped) && /retired: replaced/.test(r.swapped), JSON.stringify(r));
      check('releasing the last holder of a retired build clears it', r.gone === 0, JSON.stringify(r));
      check('a pinned retired generated build is listed under its name and its old key, with the pinned reason', r.byName.ok && r.byName.retired?.length >= 1 && r.byName.retired[0].pinned === true && /stays until engine\.dispose/.test(r.byName.text) && r.byKey.ok && r.byKey.n >= 1, JSON.stringify(r));
      check('a release that waits for a copy says so', /release\(\) was asked/.test(r.waiting ?? ''), JSON.stringify(r));
    },
  },
];
