// [vertical] Top-down audit of four chains: changing level and streaming, new game / save / load, physics and collision, asset loading.
// docs/testing/review/2026-11-07-1.0-audit/vertical-world.md explains each row. "[vertical FAILING]" rows are red on purpose while the fault stands, like [map FAILING]; a fix
// renames the row. Each row checks its setup first, so a red row is the fault in its name and not a broken setup. "[vertical]" rows drive a chain end to end and pass today.
const PAGE = '/tests/threads/';
const J = JSON.stringify;

const setup = () => {
  const { THREE } = threedogThreads;
  window.vFlat = (name, size = 120) => { const s = new THREE.Group(), m = new THREE.Mesh(new THREE.BoxGeometry(size, 0.2, size), new THREE.MeshBasicMaterial()); s.name = name; m.name = 'ground'; m.position.y = -0.1; s.add(m); return s; };
  window.vQuiet = () => { const was = [console.error, console.warn], said = []; console.error = console.warn = (...a) => said.push(a.join(' ').slice(0, 200)); return { said, back() { [console.error, console.warn] = was; } }; };
  // what a promise did within ms of wall clock: a wait that never ends shows as 'pending', and the row can go on and clean up
  window.vWithin = (p, ms) => Promise.race([p.then(v => ({ ended: 'resolved', v }), err => ({ ended: 'rejected', code: err?.code, message: String(err?.message ?? err).slice(0, 160) })), new Promise(res => setTimeout(() => res({ ended: 'pending' }), ms))]);
  // a level file that answers when the row says: a real manifest entry behind a generator
  window.vGate = () => { let open; const p = new Promise(res => { open = res; }); return { p, open }; };
  // a headless engine has no frame loop of its own: this stands in for the live one, for rows that wait on fades and sources
  window.vPump = E => { const h = setInterval(() => { if (!E.disposed) E.step(1 / 60); }, 4); return { stop: () => clearInterval(h) }; };
  window.vFiles = (E, extra = {}) => E.assets.manifest({ name: 'v', models: { vTown: { build: async () => vFlat('town') }, vCave: { build: async () => vFlat('cave') }, ...extra } });
};

export const specs = [
  // ---------- Chain H: asset loading ----------
  {
    name: '[guard] asset fallback: a level file that fails keeps the old level and rejects, also when the manifest names it',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, world, level } = threedogThreads, q = vQuiet(), E = mk(createEngine, 'v-fallback');
        E.assets.manifest({ name: 'v', models: { vTown: { build: async () => vFlat('town') } } });
        E.use(world(), level({ url: 'vTown' }));
        await E.start();
        E.assets.manifest({ name: 'v-late', models: { vGone: '/vertical-no-such-file.glb', vGoneHard: { url: '/vertical-no-such-file-2.glb', critical: true } } });   // after start: a critical file that fails stops start() itself
        const events = []; E.events.on('level:failed', () => events.push('failed')); E.events.on('level:loaded', () => events.push('loaded'));
        const opened = E.level.root?.name;
        const path = await vWithin(E.level.load('/vertical-no-such-file-3.glb'), 5000), afterPath = E.level.root?.name;
        const hard = await vWithin(E.level.load('vGoneHard'), 5000), afterHard = E.level.root?.name;
        const named = await vWithin(E.level.load('vGone'), 5000);
        const out = { opened, path: path.ended, afterPath, hard: hard.ended, afterHard, named: named.ended, afterNamed: E.level.root?.name, saved: E.saves.collect().parts.level, events };
        E.dispose(); q.back();
        return out;
      });
      check('control: a plain path that fails rejects and keeps the level', r.path === 'rejected' && r.afterPath === 'town', J(r));
      check('control: a critical entry that fails rejects and keeps the level', r.hard === 'rejected' && r.afterHard === 'town', J(r));
      check('a manifest entry that fails rejects too', r.named === 'rejected', J(r));
      check('and the old level stands, the save still names it', r.afterNamed === 'town' && r.saved === 'vTown', J(r));
    },
  },
  {
    name: '[guard] asset fallback in a load: a save whose level file fails is refused, not played on a gray box',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, world, level } = threedogThreads, q = vQuiet(), E = mk(createEngine, 'v-fallback-load');
        E.assets.manifest({ name: 'v', models: { vTown: { build: async () => vFlat('town') } } });
        E.use(world(), level({ url: 'vTown' }));
        await E.start();
        E.assets.manifest({ name: 'v-late', models: { vGone: '/vertical-no-such-file-4.glb', vGoneHard: { url: '/vertical-no-such-file-5.glb', critical: true } } });
        const snap = E.saves.collect();
        snap.parts.level = 'vGoneHard';
        const hard = await E.saves.apply(snap), hardRoot = E.level.root?.name;
        snap.parts.level = 'vGone';
        const ok = await E.saves.apply(snap);
        const out = { hard, hardRoot, ok, root: E.level.root?.name, kids: E.level.root?.children.map(c => c.name), loading: E.loading.view().ok };
        E.dispose(); q.back();
        return out;
      });
      check('control: a critical file refuses the load and keeps the level', r.hard === false && r.hardRoot === 'town', J(r));
      check('control: the loading record knows the file failed', r.loading === false, J(r));
      check('the load answers false', r.ok === false, J(r));
      check('the game stays on its level', r.root === 'town', J(r));
    },
  },
  {
    name: '[guard] stuck file: start() and level.load give up after engine.loading.timeoutMs, as start() does for a module',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, world, level } = threedogThreads, q = vQuiet();
        const C = mk(createEngine, 'v-stuck-c');
        C.use({ name: 'vNever', isReady: () => false });
        C.loading.timeoutMs = 150;
        const notReady = await vWithin(C.start(), 3000);
        C.dispose();
        const A = mk(createEngine, 'v-stuck-a');
        A.assets.manifest({ name: 'v', models: { vStuck: { build: () => new Promise(() => {}) } } });
        A.use(world(), level({ url: 'vStuck' }));
        A.loading.timeoutMs = 150;
        const atStart = await vWithin(A.start(), 1000);
        A.dispose();
        const E = mk(createEngine, 'v-stuck-b');
        vFiles(E, { vStuck: { build: () => new Promise(() => {}) } });
        E.use(world(), level({ url: 'vTown' }));
        await E.start();
        E.loading.timeoutMs = 150;
        const load = await vWithin(E.level.load('vStuck'), 1500);
        const out = { notReady: notReady.ended, atStart: atStart.ended, load: load.ended, ready: E.level.ready, root: E.level.root?.name };
        E.dispose(); q.back();
        return out;
      });
      check('control: start() stops at the limit for a module that never turns ready', r.notReady === 'rejected', J(r));
      check('start() stops at the same limit for a file that never comes', r.atStart === 'rejected', J(r));
      check('level.load ends at the same limit', r.load === 'rejected', J(r));
      check('and the level is ready again, on the old level', r.ready === true && r.root === 'town', J(r));
    },
  },
  {
    name: '[guard] stuck file in a load: it does not hold saves and new game for good',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, world, level } = threedogThreads, q = vQuiet(), E = mk(createEngine, 'v-stuck-save');
        vFiles(E, { vStuck: { build: () => new Promise(() => {}) } });
        E.use(world(), level({ url: 'vTown' }));
        await E.start();
        E.loading.timeoutMs = 150;
        const snap = E.saves.collect(); snap.parts.level = 'vStuck';
        const apply = E.saves.apply(snap);
        const save = E.saves.save('later'), fresh = E.session.newGame();
        const a = await vWithin(apply, 1500), s = await vWithin(save, 100), n = await vWithin(fresh, 100);
        const out = { apply: a.ended, ok: a.v, save: s.ended, fresh: n.ended, replacing: E.saves.replacing };
        E.dispose(); q.back();
        return out;
      });
      check('the load ends', r.apply !== 'pending', J(r));
      check('what was in line behind it runs', r.save !== 'pending' && r.fresh !== 'pending', J(r));
      check('and the game is not left frozen in a replacement', r.replacing === false, J(r));
    },
  },
  {
    name: '[guard] overtaken file: a level load that lost stops its download and answers its caller',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, world, level } = threedogThreads, q = vQuiet(), E = mk(createEngine, 'v-overtaken');
        const real = window.fetch; let signal = null;
        window.fetch = (u, o) => String(u).includes('vertical-slow') ? (signal = o?.signal, new Promise((_, rej) => o?.signal?.addEventListener('abort', () => rej(o.signal.reason)))) : real(u, o);
        vFiles(E);
        E.use(world(), level({ url: 'vTown' }));
        await E.start();
        E.assets.manifest({ name: 'v-late', models: { vSlow: { url: '/vertical-slow.glb', critical: true } } });   // after start: its preload would wait without end too (the stuck file row)
        const lost = E.level.load('vSlow');
        await new Promise(res => setTimeout(res, 30));
        const asked = !!signal;
        await E.level.load('vCave');
        const end = await vWithin(lost, 300);
        const out = { asked, root: E.level.root?.name, aborted: signal?.aborted, lost: end.ended, loading: E.loading.view().done };
        E.dispose(); window.fetch = real; q.back();
        return out;
      });
      check('control: the slow file was asked for and the newer level stands', r.asked && r.root === 'cave', J(r));
      check('the download nobody wants any more is ended', r.aborted === true, J(r));
      check('the caller of the lost load gets its answer', r.lost !== 'pending', J(r));
      check('and the loading record is clean', r.loading === true, J(r));
    },
  },
  // ---------- Chain E: changing level and streaming ----------
  {
    name: '[vertical] level chain: door, fade, new level, teleport, save, new game and load end on the right level with the right record',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, all: T } = threedogThreads, q = vQuiet(), E = mk(createEngine, 'v-happy');
        vFiles(E);
        E.use(T.world(), T.collision(), T.characters(), T.level({ url: 'vTown' }), T.flow(), T.rigid());
        E.characters.addPlayer({ control: 'camera', spawn: { x: 1, z: 1 } });
        await E.start();
        for (let i = 0; i < 3; i++) E.step(1 / 60);
        await E.loading.settled();
        const seen = [], pump = vPump(E);
        for (const n of ['level:loading', 'level:unloaded', 'level:loaded', 'level:playable']) E.events.on(n, () => seen.push(n.slice(6)));
        await E.flow.transition(async () => { await E.level.load('vCave'); await E.stream.teleport([10, 0, 10]); }, { fade: 0 });
        for (let i = 0; i < 3; i++) E.step(1 / 60);
        const inCave = { root: E.level.root?.name, zone: E.world.zone, x: Math.round(E.player.position.x), playable: E.level.playable };
        await E.saves.save('v1');
        await E.session.newGame();
        const fresh = { root: E.level.root?.name, zone: E.world.zone, x: Math.round(E.player.position.x) };
        await E.session.load('v1');
        for (let i = 0; i < 3; i++) E.step(1 / 60);
        const back = { root: E.level.root?.name, zone: E.world.zone, x: Math.round(E.player.position.x) };
        pump.stop();
        const out = { inCave, fresh, back, seen, lock: E.flow.transitioning };
        await E.saves.remove('v1');
        E.dispose(); q.back();
        return out;
      });
      check('the level changed and the player is at the far end of the door', r.inCave.root === 'cave' && r.inCave.zone === 'vCave' && r.inCave.x === 10, J(r));
      check('every moment was told, in order', r.seen.join().includes('loading,unloaded,loaded') && r.seen.includes('playable'), J(r));
      check('new game opens on the first level, at the start', r.fresh.root === 'town' && r.fresh.zone === 'vTown' && r.fresh.x === 1, J(r));
      check('the load returns to the saved level and place', r.back.root === 'cave' && r.back.zone === 'vCave' && r.back.x === 10, J(r));
    },
  },
  {
    name: '[guard] black screen: flow.transition gives the screen back when the world never settles, as stream.teleport does',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, all: T } = threedogThreads, q = vQuiet(), E = mk(createEngine, 'v-black');
        vFiles(E);
        E.use(T.world(), T.level({ url: 'vTown' }), T.flow());
        await E.start();
        E.loading.timeoutMs = 150;
        E.stream.radius = 50;
        E.stream.add({ position: [0, 0, 0], radius: 5, build: () => new Promise(() => {}) });   // a game's nearby build that never ends
        const pump = vPump(E);
        const trip = await vWithin(E.stream.teleport([1, 0, 1], { timeout: 0.05 }), 2000);
        const fade = await vWithin(E.flow.transition(async () => {}, { fade: 0 }), 1500);
        pump.stop();
        const out = { trip: trip.ended, code: trip.code, fade: fade.ended, transitioning: E.flow.transitioning };
        E.dispose(); q.back();
        return out;
      });
      check('control: a teleport to the same world gives up by name', r.trip === 'rejected' && r.code === 'stream-timeout', J(r));
      check('the transition ends', r.fade !== 'pending', J(r));
      check('and the game is not left on a locked black screen', r.transitioning === false, J(r));
    },
  },
  {
    name: '[guard] level against load: a level.load made during a load does not replace the level the save asked for',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, world, level } = threedogThreads, q = vQuiet(), E = mk(createEngine, 'v-race');
        const gate = vGate();
        vFiles(E, { vSlowCave: { build: async () => { await gate.p; return vFlat('slowcave'); } } });
        E.use(world(), level({ url: 'vTown' }));
        await E.start();
        const snap = E.saves.collect(); snap.parts.level = 'vSlowCave';
        const apply = E.saves.apply(snap);
        await new Promise(res => setTimeout(res, 20));
        const during = E.saves.replacing;
        const door = E.level.load('vCave');   // a door, a timer or a menu: nothing stops gameplay code reaching the level
        const settled = door.then(() => 'ok', e => 'refused:' + e.code);
        gate.open();
        let atAnswer;
        const ok = await apply.then(v => { atAnswer = E.level.root?.name; return v; }), d = await settled;
        await E.loading.settled();
        const out = { during, ok, door: d, atAnswer, root: E.level.root?.name, saved: E.saves.collect().parts.level, zone: E.world.zone };
        E.dispose(); q.back();
        return out;
      });
      check('control: the load was under way when the other request came', r.during === true, J(r));
      check('the load that answered true is the level that stands when it answers', r.ok === true && r.atAnswer === 'slowcave', J(r));
      check('and the door asked during it goes after it, in line', r.door === 'ok' && r.root === 'cave' && r.saved === 'vCave' && r.zone === 'vCave', J(r));
    },
  },
  {
    name: '[guard] rollback off a code-built level: a load that fails after its level part puts the old level back',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, world, level } = threedogThreads, q = vQuiet();
        const go = async (name, opts) => {
          const E = mk(createEngine, name);
          vFiles(E);
          E.use(world(), level(opts));
          let bad = false;
          E.saves.define('vLate', { save: () => 1, load: () => { if (bad) throw new Error('v boom'); } });
          await E.start();
          const snap = E.saves.collect(); snap.parts.level = 'vCave';
          bad = true;
          const ok = await E.saves.apply(snap);
          bad = false;
          for (let i = 0; i < 20 && !E.level.ready; i++) await new Promise(res => setTimeout(res, 50));
          const o = { ok, root: E.level.root?.name, zone: E.world.zone };
          E.dispose();
          return o;
        };
        const out = { file: await go('v-rb-file', { url: 'vTown' }), coded: await go('v-rb-code', { scene: vFlat('home') }) };
        q.back();
        return out;
      });
      check('control: the load failed in both cases', r.file.ok === false && r.coded.ok === false, J(r));
      check('control: from a file level the old level is back', r.file.root === 'town' && r.file.zone === 'vTown', J(r));
      check('from a code-built level the old level is back too', r.coded.root === 'home', J(r));
    },
  },
  {
    name: '[guard] save inside a door: an autosave during a transition does not store the new level with the player still at the old door',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, all: T } = threedogThreads, q = vQuiet(), E = mk(createEngine, 'v-mid');
        vFiles(E);
        E.use(T.world(), T.collision(), T.characters(), T.level({ url: 'vTown' }), T.flow());
        await E.start();
        await E.session.newGame();
        E.characters.addPlayer({ control: 'camera', spawn: { x: 1, z: 1 } });
        const written = []; E.events.on('save:written', () => written.push({ level: E.saves.collect().parts.level, x: Math.round(E.player.position.x) }));
        const pump = vPump(E);
        E.saves.autosave(0.0005);   // every 0.03 s of play, so the slow destination below is sure to meet it, as a three-minute timer may
        await E.flow.transition(async () => {
          await E.level.load('vCave');
          await new Promise(res => setTimeout(res, 120));   // the destination still loading
          E.player.placeAt([10, 0, 10]);
        }, { fade: 0 });
        for (let i = 0; i < 100 && !written.length; i++) await new Promise(res => setTimeout(res, 10));   // the save that waited goes on the first step after the trip
        pump.stop(); E.saves.autosave(1e6);
        await E.saves.flush(); await E.saves.remove('auto');
        const mixed = written.filter(w => w.level === 'vCave' && w.x !== 10);
        const out = { n: written.length, mixed: mixed.length, x: Math.round(E.player.position.x) };
        E.dispose(); q.back();
        return out;
      });
      check('control: autosave ran and the trip ended at the far door', r.n > 0 && r.x === 10, J(r));
      check('no save holds the new level with the old door', r.mixed === 0, J(r));
    },
  },
  {
    name: '[guard] loads: the limit holds for every kind of file and a shared load outlives a waiter that leaves',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, world, level } = threedogThreads, q = vQuiet(), E = mk(createEngine, 'v-class');
        const gate = vGate(), real = window.fetch;
        let tries = 0;
        window.fetch = (u, o) => /vertical-hung/.test(String(u)) ? new Promise((_, rej) => o?.signal?.addEventListener('abort', () => rej(o.signal.reason))) : real(u, o);
        vFiles(E, { vShared: { build: async () => { await gate.p; return vFlat('shared'); } }, vBack: { url: '/vertical-back.glb' } });
        E.use(world(), level({ url: 'vTown' }));
        await E.start();
        // a wait that stays keeps the load alive for the one that left
        const stays = E.assets.model('vShared'), lost = E.level.load('vShared');
        await new Promise(res => setTimeout(res, 20));
        await E.level.load('vCave');
        gate.open();
        const kept = await vWithin(stays, 1000), left = await vWithin(lost, 1000);
        // a name that fell back answers a plain caller and refuses a level, and the level tries the file again
        E.loading.timeoutMs = 120;
        E.assets.manifest({ name: 'v-hung', textures: { vHungTex: '/vertical-hung.png' }, models: { vHung: '/vertical-hung.glb' } });
        const plain = await vWithin(E.assets.model('vHung'), 1000);
        const tex = await vWithin(E.assets.texture('vHungTex'), 1000);
        window.fetch = (u, o) => /vertical-hung/.test(String(u)) ? (tries++, real('/no-such-vertical-file.glb', o)) : real(u, o);
        const level2 = await vWithin(E.level.load('vHung'), 1000);
        const out = { kept: kept.ended, left: left.ended, plain: plain.ended, tex: tex.ended, level: level2.ended, code: level2.code, tries, root: E.level.root?.name, ready: E.level.ready };
        E.dispose(); window.fetch = real; q.back();
        return out;
      });
      check('a load another caller still waits for goes on', r.kept === 'resolved', J(r));
      check('and the caller that lost is answered', r.left !== 'pending', J(r));
      check('a plain caller of a stuck model gets its fallback at the limit', r.plain === 'resolved', J(r));
      check('so does a texture: the limit is on the load, not on one kind', r.tex === 'resolved', J(r));
      check('a level asks the file again and refuses the stand-in', r.tries > 0 && r.level === 'rejected' && r.code === 'asset-load', J(r));
      check('and stays where it stood', r.root === 'cave' && r.ready === true, J(r));
    },
  },
  {
    name: '[guard] state turns: a save the game asks for inside a door is not held back, and a dispose in a session turn ends quietly',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, all: T } = threedogThreads, q = vQuiet(), E = mk(createEngine, 'v-turns');
        vFiles(E);
        E.use(T.world(), T.level({ url: 'vTown' }), T.flow());
        await E.start();
        const pump = vPump(E);
        let inside = null;
        const trip = await vWithin(E.flow.transition(async () => { await E.level.load('vCave'); inside = await E.saves.save('mine'); }, { fade: 0 }), 1500);
        pump.stop();
        const D = mk(createEngine, 'v-turns-dispose'), errs = [];
        await D.start();
        const seen = ev2 => errs.push(String(ev2.reason ?? ev2.message).slice(0, 120));
        window.addEventListener('unhandledrejection', seen); window.addEventListener('error', seen);
        const fresh = D.session.newGame();
        D.dispose();
        const ended = await vWithin(fresh, 500);
        await new Promise(res => setTimeout(res, 30));
        window.removeEventListener('unhandledrejection', seen); window.removeEventListener('error', seen);
        const out = { trip: trip.ended, inside, ended: ended.ended, v: ended.v, message: ended.message, errs };
        E.dispose(); q.back();
        return out;
      });
      check('the trip ends and the save inside it went through', r.trip === 'resolved' && r.inside !== null, J(r));
      check('a session turn on an engine disposed under it answers false', r.ended === 'resolved' && r.v === false && !r.errs.length, J(r));
    },
  },
  {
    name: '[guard] pack in a load: a content pack does not commit inside a state replacement',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, all: T } = threedogThreads, q = vQuiet(), E = mk(createEngine, 'v-pack');
        const gate = vGate(), seen = [];
        vFiles(E, { vSlowCave: { build: async () => { await gate.p; return vFlat('slowcave'); } } });
        E.use(T.world(), T.content(), T.level({ url: 'vTown' }), { name: 'vProbe', content: { vProbe: { desc: 'a probe', commit: () => { seen.push(E.saves.replacing); } } } });
        await E.start();
        const snap = E.saves.collect(); snap.parts.level = 'vSlowCave';
        const apply = E.saves.apply(snap);
        await new Promise(res => setTimeout(res, 20));
        const during = E.saves.replacing;
        const pack = E.content.load({ vProbe: 1 });
        const early = seen.length;
        gate.open();
        const ok = await apply;
        await pack; await E.loading.settled();
        const out = { during, early, ok, seen };
        E.dispose(); q.back();
        return out;
      });
      check('control: the load was under way, and answered true', r.during === true && r.ok === true, J(r));
      check('the pack waits for it', r.early === 0, J(r));
      check('and lands once, outside it', r.seen.length === 1 && r.seen[0] === false, J(r));
    },
  },
  // ---------- Chain G: physics and collision ----------
  {
    name: '[guard] body without a model: a crate whose model left the scene does not stay as an invisible solid',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, all: T, THREE } = threedogThreads, q = vQuiet(), E = mk(createEngine, 'v-ghost');
        vFiles(E);
        E.use(T.world(), T.collision(), T.level({ url: 'vTown' }), T.rigid());
        await E.start();
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial()); mesh.position.set(5, 1, 0); E.level.root.add(mesh);   // a crate placed in the level
        E.rigid.addBox(mesh, { mass: 5, id: 'v-ghost' });
        for (let i = 0; i < 20; i++) E.step(1 / 60);
        const before = E.collider3d.overlap([5, 1, 0], 0.2);
        await E.level.load('vCave');
        for (let i = 0; i < 20; i++) E.step(1 / 60);
        let inScene = false; E.scene.traverse(o => { if (o === mesh) inScene = true; });
        const out = { before, inScene, solid: E.collider3d.overlap([5, 1, 0], 0.2), bodies: E.rigid.stats.bodies };
        E.dispose(); q.back();
        return out;
      });
      check('control: the crate was solid and its model left with the level', r.before === true && r.inScene === false, J(r));
      check('nothing solid stands where nothing is drawn', r.solid === false, J(r));
    },
  },
  {
    name: '[vertical] arrival kick: a player placed beside a resting crate does not fire it across the room',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, all: T, THREE } = threedogThreads, q = vQuiet(), E = mk(createEngine, 'v-kick');
        E.use(T.world(), T.collision(), T.characters(), T.level({ scene: vFlat('home', 400) }), T.rigid());
        await E.start();
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()); mesh.position.set(50, 0.5, 0); E.add(mesh);
        const crate = E.rigid.addBox(mesh, { mass: 5 });
        E.characters.addPlayer({ control: 'camera', spawn: { x: 0, z: 0 } });
        for (let i = 0; i < 40; i++) E.step(1 / 60);
        const rest = crate.body.translation().x;
        E.player.placeAt([49.8, 0, 0]);   // the capsule lands touching the crate: a door or a checkpoint set down in a room
        let top = 0;
        for (let i = 0; i < 30; i++) { E.step(1 / 60); const v = crate.body.linvel(); top = Math.max(top, Math.hypot(v.x, v.y, v.z)); }
        const out = { rest, x: crate.body.translation().x, top, p: E.player.position.x };
        E.dispose(); q.back();
        return out;
      });
      check('control: the crate had come to rest at its place and the capsule reached it', Math.abs(r.rest - 50) < 0.05 && r.top > 0.05, J(r));
      check('a placement has no speed, so the crate does not leave at a jump speed', r.top < 10, J(r));
      check('and it stays near where it stood', Math.abs(r.x - 50) < 2, J(r));
    },
  },
  {
    name: '[vertical] load kick: loading a save with the player beside a crate leaves the crate where the save put it',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, all: T, THREE } = threedogThreads, q = vQuiet(), E = mk(createEngine, 'v-load-kick');
        E.use(T.world(), T.collision(), T.characters(), T.level({ scene: vFlat('home', 400) }), T.rigid());
        await E.start();
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()); mesh.position.set(50, 0.5, 0); E.add(mesh);
        const crate = E.rigid.addBox(mesh, { mass: 5, id: 'v-crate' });
        E.characters.addPlayer({ control: 'camera', spawn: { x: 49.3, z: 0 } });
        for (let i = 0; i < 60; i++) E.step(1 / 60);
        const before = { x: crate.body.translation().x, p: E.player.position.x };
        const snap = E.saves.collect();
        const ok = await E.saves.apply(snap);
        let top = 0;
        for (let i = 0; i < 30; i++) { E.step(1 / 60); const v = crate.body.linvel(); top = Math.max(top, Math.hypot(v.x, v.y, v.z)); }
        const out = { ok, before, x: crate.body.translation().x, top };
        E.dispose(); q.back();
        return out;
      });
      check('control: the load went through', r.ok === true && r.top > 0.01, J(r));
      check('the crate does not jump on the first step after the load', r.top < 2, J(r));
      check('and stays where the save put it', Math.abs(r.x - r.before.x) < 0.1, J(r));
    },
  },
  {
    name: '[guard] bad number: rigid refuses a NaN at its door, before it reaches the solver, the picture and the save',
    url: PAGE,
    async run({ check, ev }) {
      await ev(setup);
      const r = await ev(async () => {
        const { mk, createEngine, all: T, THREE } = threedogThreads, q = vQuiet(), E = mk(createEngine, 'v-nan');
        E.use(T.collision(), T.rigid());
        await E.start();
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()); mesh.position.set(0, 2, 0); E.add(mesh);
        const crate = E.rigid.addBox(mesh, { mass: 5, id: 'v-nan-crate' });
        const other = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()); other.position.set(9, 6, 0); E.add(other);
        const neighbour = E.rigid.addBox(other, { mass: 5 });   // nothing touches it, so it must fall whatever happens to the first
        for (let i = 0; i < 5; i++) E.step(1 / 60);
        const fell = 6 - neighbour.body.translation().y;
        let refused = null;
        try { E.rigid.impulse(crate, [NaN, 0, 0]); } catch (e) { refused = e.code ?? e.message; }
        let thrown = null;
        try { for (let i = 0; i < 30; i++) E.step(1 / 60); } catch (e) { thrown = String(e.message).slice(0, 120); }
        const saved = await vWithin(E.saves.save('v-nan'), 1000);
        const third = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()); third.position.set(-9, 6, 0); E.add(third);
        const moved = E.rigid.addBox(third, { mass: 5, id: 'v-nan-moved' });
        let placed = null;
        try { E.rigid.setPosition(moved, [NaN, 3, 0]); } catch (e) { placed = e.code ?? e.message; }
        try { for (let i = 0; i < 5; i++) E.step(1 / 60); } catch (e) { thrown = String(e.message).slice(0, 120); }
        const after = await vWithin(E.saves.save('v-nan'), 1000);
        await E.saves.remove('v-nan');
        const t = crate.body.translation(), v = crate.body.linvel();
        const out = { fell, fellMore: 6 - neighbour.body.translation().y, refused, placed, after: after.v ?? after.ended, movedX: String(moved.body.translation().x), thrown, x: String(t.x), y: String(t.y), vx: String(v.x), meshX: String(mesh.position.x), meshY: String(mesh.position.y), sleeping: crate.body.isSleeping(), saved: saved.v ?? saved.ended, part: E.saves.collect().parts.rigid };
        E.dispose(); q.back();
        return out;
      });
      check('control: a body nothing touched goes on falling', r.fellMore > r.fell, J(r));
      check('the impulse is refused by name', !!r.refused, J(r));
      check('the position is refused by name', !!r.placed, J(r));
      check('the crate is not left hanging in the air', +r.y < 0.8, J(r));
      check('the body keeps a real position', Number.isFinite(+r.x) && Number.isFinite(+r.meshX) && Number.isFinite(+r.y), J(r));
      check('and the game can still save', r.saved === true && r.after === true, J(r));
    },
  },
];
