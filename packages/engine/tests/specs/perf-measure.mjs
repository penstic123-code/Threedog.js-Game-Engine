// Performance measurement: cpuMs covers a whole frame and the budget samples this frame (not the previous one); the cost of applying background
// results (terrain chunks, vegetation, colliders, GPU upload, stream builds) is split in stages and readable from describe().perf.apply and the budget.
export const specs = [
  {
    // a module first timed after start got a ring of zeros and was judged by the global sample count, so it read 0 ms for up to 300 cycles;
    // and a level loaded during play counted its start-up cost as play (the settle clear ran only once, after start)
    name: '[guard] PERF module timing: a late module is judged on its own cycles, and a load during play clears timing again once it settles',
    url: '/tests/threads/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, all: T, THREE } = threedogThreads, out = {};
        const burn = ms => { const t = performance.now(); while (performance.now() - t < ms); };
        const gate = { open: true };
        const E = mk(T.createEngine, 'pm-late');
        E.use(T.world(), T.level(), { name: 'pmGate', type: 'rules', isReady: () => gate.open });
        await E.start(); E.haltLoop(); E.profile(true);
        const steps = n => { for (let i = 0; i < n; i++) E.step(1 / 60, { render: false, describe: false }); };
        steps(60);
        out.playing = E._playTiming;
        E.use({ name: 'pmLate', type: 'rules', frame() { burn(1.5); } });
        await E.loading.settled();
        steps(20);
        out.late = E.profile().pmLate?.ms ?? null;
        gate.open = false;   // the level's load has something to wait for
        await E.level.load(new THREE.Group());
        out.loading = E._playTiming;
        gate.open = true; steps(31);
        out.again = E._playTiming;
        E.dispose();
        return out;
      });
      check('timing started after start-up settled', r.playing === true, JSON.stringify(r));
      check('a module used 60 cycles after start reads its own median (about 1.5 ms), not the zeros of cycles before it existed', r.late >= 1, JSON.stringify(r));
      check('a level load during play re-arms the settle clear', r.loading === false, JSON.stringify(r));
      check('once that load settles, timing starts again from there', r.again === true, JSON.stringify(r));
    },
  },
  {
    // one frame-time reading: the panel used to show its own half-second average of the last frame while describe / inspect / the notice read the
    // budget median, so the F3 panel and describe disagreed on the same frames
    name: '[guard] PERF one frame-time reading: the F3 panel shows and judges the budget median, not its own average',
    url: '/tests/threads/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, all: T } = threedogThreads;
        const E = mk(T.createEngine, 'pm-panel', { budget: { cpuMs: 5 } });
        E.use(T.debug());
        await E.start(); E.haltLoop();
        const b = E.budget, ring = b._cpu;
        b._clearFrames();
        for (const v of [2, 2, 2, 2, 20]) { ring.buf[ring.i++] = v; ring.n++; }   // four plain frames and one spike
        E._cpuMs = 20;   // the last frame is the spike: an average of last frames would read high
        E.modules.get('debugPanel').afterRender(0.6, E);
        const o = E.debug.panel.out, out = { shown: o.ms.textContent, judged: o.ms.className, median: b._frameMs().ms };
        E.dispose();
        return out;
      });
      check('the panel shows the budget median (2.0 ms), the same number describe().perf.cpuMs reads', r.shown === '2.0' && r.median === 2, JSON.stringify(r));
      check('and judges that median against the cpuMs limit (within 5 ms: ok)', r.judged === 'ok', JSON.stringify(r));
    },
  },
  {
    serial: true,   // timing assertion: runs alone, not beside other pages
    name: 'PERF cpuMs：一帧 CPU 含 fixed/frame/render/afterRender 四段，Budget 采到的是本帧而不是上一帧',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const burn = ms => { const t = performance.now(); while (performance.now() - t < ms); };
        engine.budget.enable({});
        engine.use({ name: 'perfburn', type: 'rules', frame() { burn(3); }, afterRender() { burn(4); } });
        const log = [], b = engine.budget, orig = b.sample;
        b.sample = function (dt) {   // the engine calls this once per real-time frame, after the afterRender hooks
          orig.call(this, dt);
          const p = engine._cpuPhases;
          log.push({ cpu: engine._cpuMs, sampled: this._cpu.buf[(this._cpu.i + this._cpu.buf.length - 1) % this._cpu.buf.length], sum: p.fixed + p.frame + p.render + p.afterRender, frame: p.frame, after: p.afterRender });
        };
        await __t.until(() => log.length >= 14, 20000);
        b.sample = orig;
        const rows = log.slice(2);   // the burn hooks may be installed mid-frame
        const desc = engine.describe().perf;
        b._clearFrames();   // the state before the first timed frame (also right after the settle clear)
        const empty = [engine.inspect.perf().cpuMs, engine.describe().perf.cpuMs];
        return { n: rows.length, rows, desc, empty };
      });
      check('collected frames from the real-time loop', r.n >= 10, String(r.n));
      check('what Budget samples is the cpuMs of the same frame', r.rows.every(x => x.sampled === x.cpu), JSON.stringify(r.rows[0]));
      check('cpuMs is the sum of the four phases', r.rows.every(x => Math.abs(x.cpu - x.sum) < 1e-6), JSON.stringify(r.rows[0]));
      check('frame hooks (3 ms burned) and afterRender hooks (4 ms burned) are inside cpuMs, already in the frame that sampled',
        r.rows.every(x => x.frame >= 2.8 && x.after >= 3.8 && x.cpu >= 6.8), JSON.stringify(r.rows[0]));
      check('no frame timed yet: inspect.perf().cpuMs and describe().perf.cpuMs read 0 (as in 1.1), not null', JSON.stringify(r.empty) === '[0,0]', JSON.stringify(r.empty));
      check('describe().perf.cpu (the 1.1 key) gives the phases of the last frame', r.desc.cpu && r.desc.cpu.afterRender >= 3.5 && r.desc.cpu.frame >= 2.5 && !('lastFrame' in r.desc), JSON.stringify(r.desc.cpu));
    },
  },
  {
    serial: true,   // timing assertion: runs alone, not beside other pages
    name: 'PERF 后台结果回到主线程：传输 / 建 three 对象 / 碰撞体 / GPU 上传按段计时，流式进入新区域能出一份数字',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = engine.terrain, cost = engine.budget.cost, pl = engine.player.position;
        const first = cost.report();   // everything from startup: the first-screen chunks
        cost.reset();
        engine.player.placeAt({ x: pl.x + 700, z: pl.z });   // far enough that the whole ring around the player is new
        const ok = await __t.until(() => T.stats.builtThisFrame === 0 && T.stats.queued === 0 && T.chunks.size > 0 && cost.t.build.n >= 9 && cost.t.collider.n > 0, 90000).then(() => true, () => false);
        await new Promise(res => setTimeout(res, 500));
        const moved = cost.report();
        const e = engine.stream.add({ position: [pl.x, 0, pl.z], radius: 30, build: () => new __threedogThree.Mesh() });
        await __t.until(() => cost.t.stream.n >= 1, 20000).catch(() => {});
        e.remove();
        const values = engine.budget.enable({ applyBuildMs: 1000 }).values();
        engine.budget.disable();
        return { first, moved, ok, stream: cost.report().stream, desc: engine.describe().perf.apply, values, keys: Object.keys(cost.report()) };
      });
      check('startup chunks were counted', r.first.build.n > 0 && r.first.transit.n > 0 && r.first.transit.bytes > 0, JSON.stringify(r.first));
      check('moving 700 m: chunks arrive, every stage has results', r.ok && r.moved.transit.n > 0 && r.moved.build.n > 0 && r.moved.collider.n > 0 && r.moved.upload.n > 0, JSON.stringify(r.moved));
      check('times are finite and not negative', Object.values(r.moved).every(s => Number.isFinite(s.totalMs) && s.totalMs >= 0 && s.maxMs <= s.totalMs + 1e-6));
      check('stream build() callback is timed', r.stream.n >= 1, JSON.stringify(r.stream));
      check('describe().perf.apply lists the five stages', r.keys.join() === 'transit,build,collider,upload,stream' && Object.keys(r.desc).join() === r.keys.join(), JSON.stringify(r.desc));
      check('budget.values() has applyBuildMs and friends', ['applyTransitMs', 'applyBuildMs', 'applyColliderMs', 'applyUploadMs', 'applyStreamMs'].every(k => typeof r.values[k] === 'number'), JSON.stringify(r.values));
    },
  },
  {
    serial: true,   // timing assertion: runs alone, not beside other pages
    name: 'PERF 近处植被某种类在区块里一棵都没有时，结果应用后不会无限重发 detail 任务',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = engine.terrain, cost = engine.budget.cost, pl = engine.player.position;
        engine.player.placeAt({ x: pl.x + 700, z: pl.z });
        await __t.until(() => T.stats.queued === 0 && T.stats.builtThisFrame === 0 && T.chunks.size > 0, 90000);
        await new Promise(res => setTimeout(res, 1500));   // let every first-ring detail job come back
        // 碰撞体按固定步数分批建（每步 1 块，不看墙钟，回放才一致），所以"多久到齐"取决于这台机器每秒跑几个固定步：
        // 无头软件渲染下帧率低、每帧补的固定步有上限，原来睡固定 4 秒只到 1/9。这里等到齐（带上限），检查的仍是"全部到齐"
        const CH = T.generator.CHUNK, pcx = Math.floor(engine.player.position.x / CH), pcz = Math.floor(engine.player.position.z / CH);
        const ring = () => { let n = 0; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (engine.rigid.terrain.get((pcx + dx) + ',' + (pcz + dz))?.ready) n++; return n; };
        await __t.until(() => ring() === 9, 30000).catch(() => {});
        const ringReady = ring();
        cost.reset();
        await new Promise(res => setTimeout(res, 2500));   // standing still: nothing should be requested any more
        return { ringReady, ringWant: 9, idle: cost.report().transit.n, chunks: T.chunks.size, near: engine.vegetation.nearNames().length, pending: engine.rigid._srcPending };
      });
      check('colliders of a new ring are built over several steps but all arrive (and nothing is left pending)', r.ringReady === r.ringWant && r.ringWant >= 9 && r.pending === false, JSON.stringify(r));
      check('scene has a near-only species', r.near > 0, JSON.stringify(r));
      check('standing still: worker results stay bounded (no resend loop)', r.idle <= 3, JSON.stringify(r));
    },
  },
];
