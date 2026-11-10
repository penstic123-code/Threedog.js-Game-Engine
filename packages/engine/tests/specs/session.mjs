// Reliability guards: clean new game / continue / back to title (engine.session), save failure paths (engine.saves), window and device state (engine.page).
// Each test is the reproducible acceptance flow for one of them; same format as the other files here.

// describe() fields that move with real time or rendering, not with game state (camera: the view angle is not part of a playthrough yet; alive: ambient particles)
// ambient: wind and water time keeps moving behind a freeze by design (core/time/time.js), so a real frame during newGame()'s freeze moves it on a slow machine; it is picture time, not game state
const VOLATILE = /(^|\.)(fps|cpuMs|perf|budget|render|startup|tick|elapsed|frame|done|events|ops|recent|camera|rel|alive|ambient)(\.|$)/;

export const specs = [
  {
    name: 'Session: new game -> play -> back to title -> new game gives the same state as the first; nothing of the first playthrough runs (open world)',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async (vol) => {
        const re = new RegExp(vol);
        const flat = (o, p = '', out = {}) => {
          if (o && typeof o === 'object') { for (const k of Object.keys(o)) flat(o[k], p ? `${p}.${k}` : k, out); return out; }
          if (!re.test(p)) out[p] = o;
          return out;
        };
        const snap = () => flat({ d: engine.describe(), counts: engine.counts(), vars: { f: engine.vars.flags, c: engine.vars.counters }, clock: engine.clock.now, rand: engine.random.toJSON() });
        await engine.session.newGame();
        engine.step(3);   // presentation (camera easing) settles the same way after each new game
        const a = snap();
        // play: change state, leave timers / listeners / background results behind
        const hits = { timer: 0, tracked: 0, commit: 0, every: 0 };
        const W = fn => engine.ops.allow(fn);   // a test writes state directly, outside ops
        W(() => engine.vars.bump('s.gold', 99));
        engine.clock.after(3, () => hits.timer++);
        engine.clock.every(1, () => hits.every++);
        engine.session.track(engine.events.on('s:ping', () => hits.tracked++));
        const req = engine.commits.request({ apply: () => hits.commit++, fallback: () => 1, lag: 60 });
        W(() => engine.player?.placeAt({ x: 12, z: 9 }));
        engine.step(0.5);
        engine.random.next();
        await engine.session.quit();
        engine.events.emit('s:ping');
        engine.step(5);   // the title is up (when on) but step still runs: nothing from the old playthrough may fire
        const afterQuit = { ...hits };
        await engine.session.newGame();
        engine.events.emit('s:ping');
        engine.step(5);
        const afterNew = { ...hits };
        await engine.session.newGame();
        engine.step(3);
        const b = snap();
        const diff = Object.keys({ ...a, ...b }).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map(k => `${k}: ${JSON.stringify(a[k])} -> ${JSON.stringify(b[k])}`);
        req.resolve(1);
        return { diff, afterQuit, afterNew, gold: engine.vars.counter('s.gold'), tracked: engine.session.describe().tracked };
      }, VOLATILE.source);
      check('two new games give the same describe / counts / vars / clock / random', r.diff.length === 0, r.diff.slice(0, 8).join('\n'));
      check('timers, tracked listeners and background results of the old playthrough never fire after quit or new game',
        JSON.stringify(r.afterQuit) === JSON.stringify({ timer: 0, tracked: 0, commit: 0, every: 0 }) && JSON.stringify(r.afterNew) === JSON.stringify(r.afterQuit),
        JSON.stringify(r));
      check('vars are back to the new-game value; tracked handles are gone', r.gold !== 99 && r.tracked === 0, JSON.stringify(r));
    },
  },
  {
    name: 'Session: continue / retry loads a save onto a clean slate; a save that cannot be read leaves the game as it was (open world)',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const W = fn => engine.ops.allow(fn);
        await engine.session.newGame();
        W(() => engine.vars.bump('s.coins', 5));
        await engine.saves.save('checkpoint');
        let late = 0;
        engine.session.track(engine.clock.every(1, () => late++));
        W(() => engine.vars.bump('s.coins', -5));
        engine.step(2);
        const ok = await engine.session.load('checkpoint');
        engine.step(3);
        const coins = engine.vars.counter('s.coins'), lateAfter = late;
        // a corrupt save: refused before anything changes
        W(() => engine.vars.bump('s.coins', 2));
        engine.saves._json.set('broken', '{"parts": ');
        const bad = await engine.session.load('broken');
        return { ok, coins, lateAfter, bad, kept: engine.vars.counter('s.coins'), check: engine.saves.check('broken') };
      });
      check('session.load restores the save and drops tracked timers', r.ok === true && r.coins === 5 && r.lateAfter <= 2, JSON.stringify(r));
      check('a corrupt save is refused: false, the running game unchanged, check() says corrupt', r.bad === false && r.kept === 7 && r.check === 'corrupt', JSON.stringify(r));
    },
  },
  {
    name: 'Save failure: a failed write returns false, shows an error and keeps the previous save (city)',
    url: '/tests/city/index.html',
    expectErrors: /failed to write slot/,   // the provoked write failures
    async run({ check, ev }) {
      const r = await ev(async () => {
        let v = 'old', got = null, saved = 0;
        engine.saves.define('sfail', { save: () => v, load: d => { got = d; } });
        engine.events.on('save:written', () => saved++);
        await engine.saves.save('sf');
        const put = engine.saves.store.putSlot;
        engine.saves.store.putSlot = () => Promise.reject(new DOMException('quota', 'QuotaExceededError'));
        v = 'new'; saved = 0;
        const ok = await engine.saves.save('sf'), events = saved;
        engine.saves.store.putSlot = put;
        const toast = [...document.querySelectorAll('.threedog-toast, [class*=toast]')].map(t => t.textContent).join('|');
        engine.saves.load('sf');
        engine.saves.store.putSlot = () => Promise.reject(new Error('idb gone'));
        const ok2 = await engine.saves.save('brand-new');
        engine.saves.store.putSlot = put;
        return { ok, saved: events, got, toast, listed: engine.saves.list().some(s => s.slot === 'brand-new'), ok2 };
      });
      check('save() resolves false and no "save:written" event fires', r.ok === false && r.saved === 0, JSON.stringify(r));
      check('the error is shown to the player', /存档失败|Save failed/.test(r.toast), r.toast);
      check('loading the slot gives the previous save', r.got === 'old', JSON.stringify(r));
      check('a slot whose first write failed is not listed', r.ok2 === false && !r.listed, JSON.stringify(r));
    },
  },
  {
    name: 'Save failure: corrupt and too-new saves are refused before anything changes, the stored save stays (city)',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        let got = 'untouched';
        engine.saves.define('sver', { version: 2, migrate: { 1: d => d + '+m' }, save: () => 'x', load: d => { got = d; } });
        const tick0 = engine.commits.epoch;
        engine.saves._json.set('bad', 'not json');
        const bad = await engine.saves.load('bad');
        const newer = JSON.stringify({ savedAt: 1, versions: { sver: 3 }, parts: { sver: 'from the future' } });
        engine.saves._json.set('newer', newer);
        const nw = await engine.saves.load('newer');
        const old = JSON.stringify({ savedAt: 1, versions: { sver: 1 }, parts: { sver: 'v1' } });
        engine.saves._json.set('old', old);
        const ol = await engine.saves.load('old');
        return { bad, nw, got, ol, kept: engine.saves._json.get('newer') === newer, epoch: engine.commits.epoch - tick0,
          checks: [engine.saves.check('bad'), engine.saves.check('newer'), engine.saves.check('old'), engine.saves.check('nope')], versions: engine.saves.versions.sver };
      });
      check('corrupt and too-new loads return false and no part was loaded (nothing invalidated before the old save loaded)', r.bad === false && r.nw === false && r.epoch === 1, JSON.stringify(r));
      check('the stored too-new save is unchanged', r.kept, JSON.stringify(r));
      check('an old save migrates and loads', r.ol === true && r.got === 'v1+m', JSON.stringify(r));
      check('check() names the reason; versions lists what this build reads', JSON.stringify(r.checks) === '["corrupt","tooNew",null,"missing"]' && r.versions === 2, JSON.stringify(r));
    },
  },
  {
    name: 'Window: losing focus holds gameplay, coming back resumes without a catch-up burst; pauseOnBlur false keeps playing (city)',
    url: '/tests/city/index.html',
    expectErrors: /WebGL context lost/,   // provoked on purpose
    async run({ check, ev }) {
      const r = await ev(async () => {
        const frames = __t.frames;
        await frames(3);
        const c0 = engine.clock.now;
        dispatchEvent(new Event('blur'));
        const pageFrozen = () => engine.stacks.get('freeze').has('page'), held = pageFrozen();
        await frames(20);   // frame hooks keep running while held; only fixed steps (and the game clock) stop
        const during = engine.clock.now - c0;
        const c1 = engine.clock.now;
        dispatchEvent(new Event('focus'));
        await frames(2);
        const burst = engine.clock.now - c1;
        // a stalled frame (long task) must not be replayed in full either
        const c2 = engine.clock.now;
        const h = engine.onFrame(() => { h.remove(); const t = performance.now(); while (performance.now() - t < 400); });
        await frames(2);
        const stall = engine.clock.now - c2;
        engine.page.pauseOnBlur = false;
        dispatchEvent(new Event('blur'));
        const c3 = engine.clock.now;
        await __t.until(() => engine.clock.now - c3 > 0.15, 10000).catch(() => {});
        const kept = engine.clock.now - c3;
        dispatchEvent(new Event('focus'));
        engine.page.pauseOnBlur = true;
        const lost = engine.renderer.domElement;
        lost.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
        const gpuHeld = pageFrozen();
        lost.dispatchEvent(new Event('webglcontextrestored'));
        return { held, during, burst, stall, kept, gpuHeld, after: pageFrozen(), scale: engine.clock.rate };
      });
      const s = r.scale || 1;
      check('blur holds gameplay: the game clock does not move while away', r.held === true && r.during === 0, JSON.stringify(r));
      check('coming back does not fast-forward (at most two frames of time)', r.burst <= 0.25 * s, JSON.stringify(r));
      check('a 400 ms stall advances at most the catch-up cap (0.1 s per frame)', r.stall <= 0.25 * s, JSON.stringify(r));
      check('pauseOnBlur false keeps playing in the background', r.kept > 0.1 * s, JSON.stringify(r));
      check('WebGL context lost holds gameplay until restored', r.gpuHeld === true && r.after === false, JSON.stringify(r));
    },
  },
  {
    name: 'Session: terrain edits made during play are gone after newGame (open world)',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        await engine.session.newGame();
        const at = engine.actorPosition() ?? engine.focus, p = { x: at.x + 6, z: at.z + 6 };
        const h0 = engine.surface(p.x, p.z), g0 = engine.groundType(p.x, p.z);
        engine.ops.define('test.dig', { run: e => e.terrain.edit(p, { radius: 2, lower: 1.5, paint: 'tilled' }) });
        engine.ops.run('test.dig', {}, { source: 'test' });
        const h1 = engine.surface(p.x, p.z), g1 = engine.groundType(p.x, p.z);
        await engine.session.newGame();
        return { h0, g0, h1, g1, h2: engine.surface(p.x, p.z), g2: engine.groundType(p.x, p.z) };
      });
      check('the edit took effect during play', r.h1 < r.h0 - 0.5 && r.g1 === 'tilled', JSON.stringify(r));
      check('newGame gives back the generated height and ground type', Math.abs(r.h2 - r.h0) < 1e-6 && r.g2 === r.g0, JSON.stringify(r));
    },
  },
  {
    name: 'Session: per-playthrough state of every installed module resets on newGame (dialogue, triggers, hud quest markers) [guard]',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async (vol) => {
        const re = new RegExp(vol), W = fn => engine.ops.allow(fn);
        const flat = (o, p = '', out = {}) => {
          if (o && typeof o === 'object') { for (const k of Object.keys(o)) flat(o[k], p ? `${p}.${k}` : k, out); return out; }
          if (!re.test(p)) out[p] = o;
          return out;
        };
        // boot-time registrations (the game's, not the playthrough's): a once zone around the spawn, a quest with a target
        await engine.session.newGame();
        const spawn = engine.player.position.clone();
        let enters = 0;
        engine.triggers.add({ position: { x: spawn.x, z: spawn.z }, radius: 4, once: true, tag: 'spawn-intro', onEnter: () => enters++ });
        engine.quests.define('s-bread', { title: 'Bread', steps: [{ text: 'go', done: () => false, target: { x: spawn.x + 30, z: spawn.z } }] });
        engine.step(0.2);
        const enterFirst = enters;
        await engine.session.newGame();
        engine.step(0.2);
        // every installed module's describe, taken after a fresh new game
        const names = [...engine.modules.keys()];
        const snap = () => { const d = engine.describe(); return Object.fromEntries(names.map(n => [n, flat(d[n] ?? null)])); };
        const a = snap(), markers0 = engine.hud.markers.length;
        // play: a quest with a marker, a locking dialogue, a non-locking bark awaited by game code
        W(() => engine.quests.start('s-bread'));
        engine.step(0.1);
        const markersPlay = engine.hud.markers.length;
        let barkAfter = 0;
        engine.dialogue.say('bark, a long line that is still showing', { channel: 'bubble', at: engine.player.root, seconds: 30 }).then(() => barkAfter++);
        engine.step(0.1);
        const barking = engine.dialogue.bubbles().length, enterBefore = enters;
        await engine.session.newGame();
        engine.step(0.2);
        const b = snap(), diff = [];
        for (const n of names) for (const k of new Set([...Object.keys(a[n]), ...Object.keys(b[n])]))
          if (JSON.stringify(a[n][k]) !== JSON.stringify(b[n][k])) diff.push(`${n}.${k}: ${JSON.stringify(a[n][k])} -> ${JSON.stringify(b[n][k])}`);
        engine.step(3);
        const markersAfter = engine.hud.markers.length, barkActive = engine.dialogue.bubbles().length ? 'still showing' : null;
        // a locking dialogue: its UI focus entry and input context go with it
        const ctx0 = JSON.stringify(engine.input.contexts);
        engine.dialogue.define('s-talk', { start: { text: 'hello there, a long line' } });
        engine.dialogue.start('s-talk');
        engine.step(0.1);
        const open = !!engine.dialogue.active;
        await engine.session.newGame();
        engine.step(0.1);
        return { names: names.length, diff, enterFirst, enterBefore, enterAfter: enters, markers0, markersPlay, markersAfter, barking: !!barking, barkActive, barkAfter,
          open, active: engine.dialogue.active, ctx: JSON.stringify(engine.input.contexts) === ctx0, used: engine.triggers.byTag('spawn-intro')[0]?.used };
      }, VOLATILE.source);
      check('every installed module describes the same after the second new game', r.diff.length === 0 && r.names > 10, `${r.names} modules\n` + r.diff.slice(0, 8).join('\n'));
      check('a once trigger around the spawn fires again in each new playthrough', r.enterFirst === 1 && r.enterBefore === 2 && r.enterAfter === 4 && r.used === true, JSON.stringify(r));
      check('quest markers of the old playthrough are gone', r.markersPlay === r.markers0 + 1 && r.markersAfter === r.markers0, JSON.stringify(r));
      check('a bark of the old playthrough is dropped and code awaiting it never runs', r.barking && r.barkActive === null && r.barkAfter === 0, JSON.stringify(r));
      check('an open locking dialogue is closed with its input context', r.open && r.active === null && r.ctx, JSON.stringify(r));
    },
  },
  {
    name: 'Dialogue: a choice whose do starts another dialogue leaves the new one running [guard]',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        const d = engine.dialogue, seen = [];
        d.define('s-a', { start: { text: 'a', choices: [{ text: 'ask the guard', do: (s, e) => e.dialogue.start('s-guard') }, { text: 'jump', next: 'x', do: (s, e) => e.dialogue.start('s-guard') }] }, x: { text: 'a-x' } });
        d.define('s-guard', { start: { text: 'guard', next: 'more' }, more: { text: 'guard 2' }, x: { text: 'guard-x' } });
        engine.events.on('dialogue:line', l => seen.push(`${l.script}/${l.node}`));
        d.start('s-a'); engine.ops.run('dialogue.advance');   // finish typing
        engine.ops.run('dialogue.choose', { index: 0 });
        const first = d.speaking + '/' + d.active?.id;
        d.end();
        d.start('s-a'); engine.ops.run('dialogue.advance');
        engine.ops.run('dialogue.choose', { index: 1 });
        const second = d.speaking + '/' + d.active?.id;
        d.end();
        return { first, second, seen };
      });
      check('do starting a dialogue without next: the new dialogue stays open', r.first === 's-guard/start', JSON.stringify(r));
      check("the old choice's next is not applied to the new dialogue", r.second === 's-guard/start' && !r.seen.includes('s-guard/x'), JSON.stringify(r));
    },
  },
];
