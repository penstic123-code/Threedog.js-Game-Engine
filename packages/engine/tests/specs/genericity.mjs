// Genericity: interaction picking and actors, quest fail / parallel / optional goals,
// game content kinds, content positions with y / floor, item words without an inventory. Same format as the other files here.
export const specs = [
  {
    name: 'genericity: content item words without an inventory say which module is missing',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(() => ({ inv: !!engine.inventory, msgs: ['has', 'lacks', 'give', 'take'].map(w => {
        try { if (w === 'has' || w === 'lacks') engine.content.test({ [w]: { coin: 1 } }); else engine.content.run({ [w]: { coin: 1 } }); return null; } catch (e) { return e.message; }
      }) }));
      check('[guard] has / lacks / give / take without inventory() throw naming the word and the fix',
        !r.inv && r.msgs.every((m, i) => m && m.includes(`{ ${['has', 'lacks', 'give', 'take'][i]} }`) && m.includes('inventory()')), JSON.stringify(r));
    },
  },
  {
    name: 'genericity: game content kinds (rules.js kinds) load after the engine data; unknown content names fail with how to register them',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(() => {
        const got = [], C = engine.content, err = f => { try { f(); return null; } catch (e) { return e.message; } };
        const kinds = { 'g-waves': { desc: 'enemy waves', load: (e, data, content) => got.push(`${data.length}:${typeof content.where}`) } };
        C.load({ rules: { kinds }, 'g-waves': [{ n: 3 }, { n: 5 }] });
        C.load({ 'g-waves': [{ n: 8 }] });   // later loads still know the kind
        return {
          got: got.join(), unknown: err(() => C.load({ enemies: {} })),
          clash: err(() => C.load({ rules: { kinds: { npcs: { load() {} } } } })), noLoad: err(() => C.load({ rules: { kinds: { loot: { desc: 'x' } } }, loot: { a: 1 } })), badLoad: err(() => C.load({ rules: { kinds: { gold: { load: 'x' } } } })),
        };
      });
      check('[guard] a registered kind gets its data (and the content api); a later load without rules still finds it', r.got === '2:function,1:function', r.got);
      check('an unregistered content name throws, naming kinds in content/rules.js', /unknown content "enemies".*kinds: \{ enemies:/.test(r.unknown || ''), r.unknown);
      check('a kind clashing with an engine file, or with a load that is no function, throws; a kind with no load loads (the game imports its file itself)',
        /"npcs" is an engine content file name/.test(r.clash || '') && /"gold": load must be a function/.test(r.badLoad || '') && !r.noLoad, JSON.stringify(r));
    },
  },
  {
    name: 'genericity: content positions take floor / y on multi-layer ground (where, places with height, trigger zones, props)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const C = engine.content, old = engine.ground, p = engine.player.position, x = p.x + 40, z = p.z + 40;
        // two storeys everywhere: ground floor at 0, upper floor at 6 (the top layer without a reference height)
        engine.setGround({ height: (_x, _z, refY) => refY !== undefined && refY < 5 ? 0 : 6 });
        const out = {
          plain: JSON.stringify(C.where({ x, z })),
          low: C.where({ x, z, floor: 1 }).y, high: C.where({ x, z, floor: 7 }).y, lifted: C.where({ x, z, y: 1.5 }).y,
        };
        C.load({ triggers: { 'g-low': { position: { place: 'g-cellar' }, radius: 1 } } }, { places: { 'g-cellar': { x, y: 0, z } } });
        out.marker = C.where({ place: 'g-cellar', x: 1 }).y;
        out.trigger = engine.triggers.list().find(t => t.tag === 'g-low')?.y;
        C.load({ props: [{ id: 'g-shelf', model: 'rock', x: x + 2, z, floor: 0, y: 1 }] });
        const rec = engine.world.get('g-shelf');
        out.prop = rec && `${rec.position.y}/${rec.floor}`;
        const item = [...engine.inventory.defs.keys()][0], lift = engine.pickups.lift;
        C.load({ pickups: [{ id: 'g-pk-low', item, x: x + 3, z, floor: 0 }, { id: 'g-pk-top', item, x: x + 4, z }] });
        out.pickups = [engine.world.get('g-pk-low')?.position.y - lift, engine.world.get('g-pk-top')?.position.y - lift].map(v => Math.round(v * 100) / 100).join('/');
        engine.ground = old;
        engine._unhalt();
        return out;
      });
      check('without floor / y a position stays { x, z } (top layer, as before)', !r.plain.includes('"y"'), r.plain);
      check('[guard] floor picks the storey, y lifts above it, a place with height lends its storey', r.low === 0 && r.high === 6 && r.lifted === 7.5 && r.marker === 0, JSON.stringify(r));
      check('trigger zones and props from content stand on that storey (props remember floor)', r.trigger === 0 && r.prop === '1/0', JSON.stringify(r));
      check('content pickups with floor stand on that storey, without it on the top layer', r.pickups === '0/6', JSON.stringify(r));
    },
  },
  {
    name: 'genericity: quests with parallel goals, optional goals and a fail condition (code and content)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const Q = engine.quests, V = engine.vars, out = {}, said = [], evs = [];
        const p = engine.player.position, A = [p.x + 20, 0, p.z], B = [p.x - 20, 0, p.z];
        const subs = ['quest:part', 'quest:fail', 'quest:done'].map(n => engine.events.on(n, d => evs.push(`${n}:${d.id}${d.part !== undefined ? '#' + d.part : ''}`)));
        const notify = Q.notify; Q.notify = m => said.push(m.type);
        const markers = () => engine.hud.markers.filter(m => m.o.label?.startsWith?.('hold')).map(m => m.o.label).sort().join();
        // 进度只经公开的 list() 读：state(id) 是方法、只给 step / done 这些，parts 不外露（内部 _progress 不许测试直接摸）
        const partsOf = (id, step) => Q.list().find(q => q.id === id).steps[step].parts.map(x => x.done).join();
        let reward = 0, failed = 0;
        engine.ops.allow(() => {
          Q.define('g-defend', { title: 'defend', steps: [
            { text: 'reach camp', done: e => e.vars.flag('gAtCamp') },
            { all: [{ text: 'hold A', done: e => e.vars.flag('gA'), target: A }, { text: 'hold B', done: e => e.vars.flag('gB'), target: B }, { text: 'nobody hurt', done: e => e.vars.flag('gSafe'), optional: true }] },
          ], reward: () => reward++, fail: e => e.vars.flag('gLost') });
          Q.start('g-defend'); V.setFlag('gAtCamp'); Q.check();
          out.group = Q.list().find(q => q.id === 'g-defend').steps[1];
          out.m0 = markers();
          V.setFlag('gA'); Q.check();
          out.m1 = markers(); out.mid = Q.isActive('g-defend') && partsOf('g-defend', 1);
          out.explain = engine.explain({ quest: 'g-defend' }).text;
          V.setFlag('gB'); Q.check();
          out.done = Q.isDone('g-defend') && reward === 1;
          out.after = partsOf('g-defend', 1);
          // fail, then take it again
          Q.define('g-order', { title: 'order', steps: [{ text: 'deliver', done: e => e.vars.flag('gDelivered') }], fail: e => e.vars.flag('gLate'), onFail: () => failed++ });
          Q.start('g-order'); V.setFlag('gLate'); Q.check();
          out.failed = Q.isFailed('g-order') && !Q.isActive('g-order') && failed === 1 && engine.describe().quests?.failed >= 1;
          V.setFlag('gLate', false); Q.start('g-order'); out.retry = Q.isActive('g-order') && !Q.isFailed('g-order');
          // content: the same shapes as data
          engine.content.load({ quests: { 'g-c': { title: 'c', steps: [{ all: [{ text: 'x', done: { flag: 'gX' } }, { text: 'y', done: { flag: 'gY' }, optional: true }] }], fail: { flag: 'gZ' }, onFail: { setFlag: 'gZZ' } } } });
          Q.start('g-c'); V.setFlag('gY'); Q.check(); out.cPart = partsOf('g-c', 0);
          V.setFlag('gZ'); Q.check(); out.cFail = Q.isFailed('g-c') && V.flag('gZZ');
        });
        const errs = [];
        for (const def of [{ title: 't', steps: [{ text: 'a', done: () => true, optional: true }] }, { title: 't', steps: [{ all: [{ text: 'a', done: () => true, optional: true }] }] }])
          try { Q.define('g-bad', def); errs.push(null); } catch (e) { errs.push(e.message); }
        out.errs = errs;
        Q.notify = notify; for (const s of subs) s.remove();
        engine._unhalt();
        out.said = said.join(); out.evs = evs.join();
        return out;
      });
      check('a parallel step lists its parts; text defaults to the required parts', r.group?.text === 'hold A / hold B' && r.group.parts.length === 3 && r.group.current, JSON.stringify(r.group));
      check('[guard] parts complete in any order and stay done; the step ends when no required part is left (the optional one does not hold it)',
        r.mid === 'true,false,false' && r.done && r.after === 'true,true,false' && r.evs.includes('quest:part:g-defend#0') && r.evs.includes('quest:done:g-defend'), JSON.stringify(r));
      check('hud marks each unfinished part of the current parallel step', r.m0 === 'hold A,hold B' && r.m1 === 'hold B', JSON.stringify([r.m0, r.m1]));
      check('[guard] fail: onFail runs, quest:fail fires, notify gets type fail; start() takes a failed quest again', r.failed && r.retry && r.evs.includes('quest:fail:g-order') && r.said.includes('fail'), JSON.stringify(r));
      check('content quests: all / optional / fail / onFail', r.cPart === 'false,true' && r.cFail, JSON.stringify(r));
      check('optional on a plain step, or only optional parts, throws with the fix', /optional goes on a part inside all/.test(r.errs[0] || '') && /at least one part without optional/.test(r.errs[1] || ''), JSON.stringify(r.errs));
      check('explain({ quest }) on a parallel step names the required parts still open', /required parts not done yet: "hold B"/.test(r.explain) && !/nobody hurt/.test(r.explain), r.explain);
    },
  },
  {
    name: 'genericity: interaction pick modes (nearest / facing / aim / function), two actions on one object, default radius',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const I = engine.interactions, inp = engine.input, pl = engine.player, p = pl.position, used = [];
        pl.face(0);   // facing +z
        const front = I.add([p.x, p.y, p.z + 2], { id: 'g-front', label: 'front', onUse: () => used.push('front') });
        const back = I.add([p.x, p.y, p.z - 1], { id: 'g-back', label: 'back', onUse: () => used.push('back') });
        const far = I.add([p.x + 2.8, p.y, p.z], { id: 'g-far', label: 'far' });
        const out = { radius: I.get('g-far').radius };
        I.pickMode = 'nearest'; out.nearest = I.pick()?.id;
        I.pickMode = 'facing'; out.facing = I.pick()?.id;
        I.pickMode = 'aim';
        const cam = engine.camera, eye = [p.x, p.y + 1.6, p.z];
        cam.position.set(...eye); cam.lookAt(p.x, p.y + 1, p.z + 2); cam.updateMatrixWorld(); out.aimFront = I.pick()?.id;
        cam.lookAt(p.x, p.y + 1, p.z - 1); cam.updateMatrixWorld(); out.aimBack = I.pick()?.id;
        cam.lookAt(p.x - 5, p.y + 5, p.z); cam.updateMatrixWorld(); out.aimNone = I.pick()?.id ?? null;
        I.pickMode = (list, ctx) => list.find(c => c.label === 'front') ?? null;
        out.fn = I.pick()?.id;
        I.pickMode = 'nearest';
        // second verb on the same object: its own key, its own pick
        inp.bind('g-harvest', ['KeyG']);
        const harvest = I.add(I.get('g-back').object, { id: 'g-back-harvest', label: 'harvest', action: 'g-harvest', onUse: () => used.push('harvest') });
        engine.step(1 / 30, { render: false });
        inp._keyDown('KeyG', 'keyboard'); engine.step(1 / 30, { render: false }); inp._keyUp('KeyG'); engine.step(1 / 30, { render: false });
        out.keyG = engine.ops.recent('interaction.use').at(-1)?.args.id;
        I.update(); out.options = I.options.map(o => `${o.action}:${o.id}`).sort().join();
        out.byAction = engine.ops.can('interaction.use', { action: 'g-harvest' }).ok;
        let bad = null;
        try { new I.constructor(engine, { pick: 'closest' }); } catch (e) { bad = e.message; }
        out.bad = bad;
        for (const h of [front, back, far, harvest]) h.remove();
        engine._unhalt();
        out.used = used.join();
        return out;
      });
      check('default radius is 2.5 m', r.radius === 2.5, String(r.radius));
      check("'nearest' picks the closer one behind; 'facing' picks the one ahead", r.nearest === 'g-back' && r.facing === 'g-front', JSON.stringify(r));
      check("'aim' picks what the screen-center ray passes, nothing when aiming at the sky", r.aimFront === 'g-front' && r.aimBack === 'g-back' && r.aimNone === null, JSON.stringify(r));
      check('a pick function chooses among the candidates', r.fn === 'g-front', JSON.stringify(r));
      check('[guard] one object, two actions: the second key runs interaction.use with its own interaction; options lists both',
        r.keyG === 'g-back-harvest' && r.used === 'harvest' && r.options === 'g-harvest:g-back-harvest,interact:g-back' && r.byAction, JSON.stringify(r));
      check('an unknown pick mode fails with the list of modes', /'closest' is not a pick mode.*'nearest' \| 'facing' \| 'aim'/.test(r.bad || ''), r.bad);
    },
  },
  {
    name: 'genericity: engine.actor drives interactions, trigger zones and ops ctx.actor (single player unchanged)',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.haltLoop();
        const I = engine.interactions, p = engine.player.position, out = {};
        out.def = engine.actor === 'player' && engine.actorPosition() === engine.player.position;
        const cx = p.x + 30, cz = p.z + 30, cy = engine.surface(cx, cz);
        engine.ops.allow(() => engine.world.add({ id: 'g-cart', kind: 'g-cart', position: { x: cx, y: cy, z: cz } }));
        const atCart = I.add([cx + 1, cy, cz], { id: 'g-at-cart', label: 'cart lever' });
        const atPlayer = I.add([p.x + 1, p.y, p.z], { id: 'g-at-player', label: 'player lever' });
        let entered = 0;
        const zone = engine.triggers.add({ position: { x: cx, y: cy - 1, z: cz }, radius: 2, onEnter: () => entered++ });
        let actor = null;
        const op = engine.ops.define('g.who', { run: (e, a, ctx) => { actor = ctx.actor; } });
        out.player = I.pick()?.id;
        engine.step(1 / 30, { render: false }); out.enteredAsPlayer = entered;
        engine.actor = 'g-cart';
        out.cart = I.pick()?.id; out.cartPos = engine.actorPosition()?.x === cx;
        engine.step(1 / 30, { render: false }); out.enteredAsCart = entered;
        engine.ops.run('g.who'); out.opActor = actor;
        out.useNear = engine.ops.run('interaction.use', {}).ok && engine.ops.recent('interaction.use').at(-1).actor;
        engine.actor = 'player';
        engine.ops.run('g.who'); out.opBack = actor;
        out.back = I.pick()?.id;
        for (const h of [atCart, atPlayer, zone, op]) h.remove();
        engine.ops.allow(() => engine.world.remove('g-cart'));
        engine._unhalt();
        return out;
      });
      check('default actor is the player', r.def && r.player === 'g-at-player' && r.enteredAsPlayer === 0, JSON.stringify(r));
      check('[guard] engine.actor = a world record: interactions pick around it and trigger zones fire for it', r.cartPos && r.cart === 'g-at-cart' && r.enteredAsCart === 1, JSON.stringify(r));
      check('ops default ctx.actor to engine.actor; interaction.use logs it', r.opActor === 'g-cart' && r.useNear === 'g-cart' && r.opBack === 'player' && r.back === 'g-at-player', JSON.stringify(r));
    },
  },
  {
    // a calendar the game does not ask for must not appear: a soulslike or a shooter gets no seasons and no season:change, ever
    name: 'genericity: the calendar is the game\'s (no seasons by default, seasons of their own length, a time of day that never moves)',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        engine.timeline.skip(); engine.haltLoop();
        const Cal = engine.calendar.constructor, made = [];
        // extra Calendars, only to read them (not installed): they view a clock of their own that the test moves, as the time source would
        const clk = { now: 0 }, view = Object.create(engine, { clock: { value: clk } });
        const make = o => { const s = new Cal(view, o); made.push(s); return s; };
        const run = (s, n) => { for (let i = 0; i < n; i++) { clk.now += 1; s.moved(); } };
        const out = {}, changes = [];
        const off = engine.events.on('season:change', n => changes.push(n));
        const none = make({ dayLength: 1 });
        run(none, 100);
        out.none = { season: none.season, idx: none.seasonIndex, progress: none.seasonProgress, dayOf: none.dayOfSeason, day: none.day, changes: changes.length };
        try { none.onSeason('summer', () => {}); } catch (err) { out.noSeasonErr = err.message; }
        const wd = make({ dayLength: 1, seasons: [{ name: 'wet', days: 10 }, { name: 'dry', days: 20 }] });
        const at = d => { wd.day = d; return wd.season + wd.dayOfSeason; };
        out.lengths = [at(1), at(10), at(11), at(30), at(31)].join(',');
        wd.day = 1; wd._season = wd.season; changes.length = 0;
        run(wd, 30);
        out.wdChanges = changes.join(',');
        const still = make({ dayLength: Infinity, time: 0.5 });
        run(still, 600);
        out.still = { t: still.timeOfDay, day: still.day, mark: still.untilMark() };
        try { make({ seasons: 'spring' }); } catch (err) { out.badSeasons = err.message; }
        try { make({ dayLength: 0 }); } catch (err) { out.badDay = err.message; }
        off.remove();
        for (const s of made) s._sched.dispose();
        return out;
      });
      check('[guard] no seasons unless named: 100 days pass, season null, no season:change', r.none.season === null && r.none.idx === -1 && r.none.changes === 0 && r.none.day === 101 && r.none.progress === 0 && r.none.dayOf === 0, JSON.stringify(r.none));
      check('onSeason on a season the calendar lacks throws with the fix instead of waiting forever', /no such season/.test(r.noSeasonErr), r.noSeasonErr);
      check('seasons of their own length: wet 10 days then dry 20, then wet again', r.lengths === 'wet1,wet10,dry1,dry20,wet1' && r.wdChanges === 'dry,wet', JSON.stringify(r));
      check('dayLength Infinity: the time of day never moves, no day passes, no clock mark ahead', r.still.t === 0.5 && r.still.day === 1 && r.still.mark === Infinity, JSON.stringify(r.still));
      check('bad seasons / dayLength throw with the fix', /a list of names/.test(r.badSeasons) && /must be a number > 0/.test(r.badDay), JSON.stringify([r.badSeasons, r.badDay]));
    },
  },
  {
    // the game's weather table is the whole list: a type it does not have can never be switched to, and the style cannot add one
    name: 'genericity: weather types are the game\'s table (no built-ins mixed in, own fields blend, no particles without rain or snow)',
    url: '/',
    async run({ check, ev }) {
      const { presets } = await import('../../presets.js');   // node side: the page gets the plain table as an argument
      const r = await ev(temperate => {
        engine.timeline.skip(); engine.haltLoop();
        const Weather = engine.weather.constructor, out = {};
        {
          const w = new Weather(engine, { types: { clear: { cloud: 0.1 }, dust: { fog: 0.3, wind: 2, heat: 1 } } });
          out.names = Object.keys(w.types).join(',');
          out.start = w.name; out.pool = w.autoPool.join(',');
          out.calm = w.types.dust.cloud === 0 && w.types.dust.rain === 0 && w.types.dust.sun === 1;
          out.gameWins = w.types.clear.cloud === 0.1;
          out.heatOnClear = w.types.clear.heat;
          out.stateOnly = !('systems' in w);   // particles are the drawing half's (weatherDraw.js); appearance-water checks none are built without rain / snow
          w.set('snow', { seconds: 1 }); out.afterSnow = w.name;
          w.set('dust', { seconds: 1 }); for (let i = 0; i < 120; i++) w.tick(1 / 60);
          out.heat = w.current.heat; out.dust = w.name;
          // no table: the engine assumes no climate, only a calm clear (no rain particles); the preset is opt-in
          const def = new Weather(engine, {});
          out.bare = Object.keys(def.types).join(',') + (def.types.rain ? '+rain' : '');
          const t = new Weather(engine, { types: { ...temperate, storm: { lightning: 1 } } });
          out.preset = Object.keys(t.types).length;
          try { new Weather(engine, { types: { dust: {} }, start: 'clear' }); } catch (err) { out.badStart = err.message; }
          try { new Weather(engine, { types: { dust: { wind: 'strong' } } }); } catch (err) { out.badField = err.message; }
        }
        return out;
      }, presets.weather.temperate.types);
      check('[guard] the table is the whole list: no built-in type mixed in; switching to a missing type is refused', r.names === 'clear,dust' && r.afterSnow === 'clear', JSON.stringify(r));
      check('start defaults to clear, autoPool to each type once; left-out fields are calm; the game\'s numbers stand', r.start === 'clear' && r.pool === 'clear,dust' && r.calm && r.gameWins, JSON.stringify(r));
      check('a field of the game\'s own (heat) is 0 on other types and blends to 1', r.heatOnClear === 0 && r.dust === 'dust' && Math.abs(r.heat - 1) < 1e-6, JSON.stringify(r));
      check('weather state holds no particles (they are the drawing half, engine.weatherDraw)', r.stateOnly, JSON.stringify(r));
      check('[guard] no table: only a calm clear and no rain particles (the engine assumes no climate); the temperate preset is opt-in', r.bare === 'clear' && r.preset === 7, JSON.stringify(r));
      check('bad start / non-number field throw with the fix', /not one of this game's weather types/.test(r.badStart) && /must be a number/.test(r.badField), JSON.stringify([r.badStart, r.badField]));
    },
  },
  {
    // [守] 引擎核心不带玩法按键：Shift 跑 / E 交互 / 空格跳不在核心默认表里，只有游戏（或它挑的预设）给了才有；interactions() 没有默认选法和按键
    name: 'genericity: no gameplay keys unless the game binds them (no core run / interact / jump), interactions needs a pick',
    url: '/tests/a/',   // addPlayer({ ...presets.player.thirdPerson }) and no interactions module: run / jump come from presets.bindings.walk, interact from nobody
    async run({ check, ev }) {
      const r = await ev(() => {
        const inp = engine.input, keys = a => inp.actions.has(a) ? inp.keysOf(a).filter(k => !k.startsWith('Pad')).join('+') : null;
        const out = { interact: keys('interact'), run: keys('run'), jump: keys('jump'), confirm: keys('confirm'), move: keys('moveForward') };
        // the 'camera' control with no run key bound never runs, and reading it does not warn about a missing action
        const warns = [], warn0 = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); };
        const keep = inp.actions.get('run'); inp.actions.delete('run');
        engine.characters.moveInput(); out.runWithout = engine.characters.moveInput().run; out.warned = warns.some(w => /action "run"/.test(w));
        inp.actions.set('run', keep); console.warn = warn0;
        return out;
      });
      check('[guard] interact is not bound when the game gave no key (no core E)', r.interact === null, JSON.stringify(r));
      check('run / jump keys exist only because the game bound presets.bindings.walk; move and confirm stay neutral core keys', r.run === 'ShiftLeft+ShiftRight' && r.jump === 'Space' && !!r.confirm && !!r.move, JSON.stringify(r));
      check('camera control without a run action just walks (no missing-action warning)', r.runWithout === false && !r.warned, JSON.stringify(r));
    },
  },
  {
    // [守] interactions() 不替游戏选"哪个算在面前"和"按哪个键"
    name: 'genericity: interactions() has no default pick (the error names the preset) and takes no keys; presets.bindings.interact gives E',
    url: '/?cutscene=skip',
    async run({ check, ev }) {
      const r2 = await ev(() => {
        const Ctor = /** @type {any} */ (engine.interactions?.constructor), out = {};
        // the page of the examples installs interactions with the nearest preset; a second constructor only to read its argument checks (it throws before touching the engine)
        try { new Ctor(engine, {}); } catch (err) { out.noPick = String(err.message); out.code = err.code; }
        out.declBy = engine.input.actions.get('interact')?.by;
        out.interactKeys = engine.input.keysOf('interact').filter(k => !k.startsWith('Pad'));
        return out;
      });
      check('[guard] interactions() without pick throws interaction-setup and names the preset', r2.code === 'interaction-setup' && /presets\.interactions\.nearest/.test(r2.noPick), JSON.stringify(r2));
      check('[guard] interactions declares the interact action (the game binds it)', r2.declBy === 'interactions', JSON.stringify(r2));
      check('with presets.bindings.interact the game gets E', r2.interactKeys.join() === 'KeyE', JSON.stringify(r2));
    },
  },
];
