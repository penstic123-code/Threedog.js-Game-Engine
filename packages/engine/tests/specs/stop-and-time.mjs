// "Stopped" has one meaning: a freeze. These guards go red when a system picks its own answer again (review 2026-11-05-conflicts.md).
export const specs = [
  {
    name: '[guard] physics follows the world channel: slow motion slows bodies, a hit-stop holds them',
    url: '/tests/vehicle/index.html', timeout: 90000,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.engine?.ready && window.engine.rigid?.ready, null, { timeout: 60000 });
      const r = await ev(async () => {
        const e = window.engine, R = e.rigid, T = __threedogThree;
        e.haltLoop();
        const drop = () => { const b = R.addBox(new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshBasicMaterial()), { size: [1, 1, 1], mass: 1 }); R.setPosition(b, [3, 80, 3]); return b; };
        const fall = (mod) => {
          const b = drop(), h = mod && e.mod('time.world', { owner: 't-time', ...mod }), y0 = b.body.translation().y;
          e.step(0.5, { render: false, describe: false });
          const d = y0 - b.body.translation().y;
          h?.remove(); R.remove?.(b);
          return d;
        };
        return { full: fall(), slow: fall({ mul: 0.2 }), stopped: fall({ set: 0 }) };
      });
      check('a body falls at full speed with no mod', r.full > 0.5, JSON.stringify(r));
      check('at 0.2 speed it falls far less (distance goes with time squared)', r.slow < r.full * 0.2, JSON.stringify(r));
      check('at speed 0 it does not move at all', r.stopped === 0, JSON.stringify(r));
    },
  },
  {
    name: '[guard] the press that opens a dialogue from a fixed step does not also act on it',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.timeline.skip(); engine.haltLoop();
        const key = code => { dispatchEvent(new KeyboardEvent('keydown', { code })); };
        const text = 'A line long enough that it cannot finish typing inside one frame of the test, whatever the speed.';
        let opened = false;
        const h = engine.onFixed(() => {
          if (opened || !engine.input.pressedRaw('confirm')) return;
          opened = true; engine.dialogue.say(text);
        });
        const code = engine.input.bindings?.confirm?.keys?.[0] ?? 'Enter';
        key(code);
        engine.step(1 / 60, { render: false, describe: false });   // one fixed step and the frame hooks of the same frame
        const first = { opened, typing: engine.dialogue.typing };
        dispatchEvent(new KeyboardEvent('keyup', { code }));
        h.remove();
        engine.dialogue.stop?.();
        return first;
      });
      check('the dialogue opened on that press', r.opened === true, JSON.stringify(r));
      check('it is still typing: the opening press did not finish the line', r.typing === true, JSON.stringify(r));
    },
  },
  {
    name: '[guard] a game finds no pause on the engine: the word that stops rendering is haltLoop, and freezing is the one way to stop gameplay',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.timeline.skip();
        await __t.frames(2);
        const before = engine.runState.state;
        const f = engine.freeze('t-menu'), frozen = engine.runState.state; f.remove();
        const h = engine.haltLoop('t-tool'), halted = engine.runState.state, inHolds = engine.describe().holds.halt?.[0]?.owner; h.remove();
        return { names: ['pause', 'paused', 'resume'].filter(n => n in engine), before, frozen, halted, inHolds, flag: engine.halted };
      });
      check('engine.pause, engine.paused and engine.resume do not exist', r.names.length === 0, r.names.join());
      check('runState tells the two apart', r.before === 'running' && r.frozen === 'frozen' && r.halted === 'halted', JSON.stringify(r));
      check('describe().holds names the halt, and it ends with its handle', r.inHolds === 't-tool' && r.flag === false, JSON.stringify(r));
    },
  },
  {
    name: '[guard] a page hold is a freeze: cutscene tweens stop, runState and describe say so',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const frames = __t.frames, out = {};
        engine.timeline.skip();
        await frames(3);
        let ended = false;
        const o = { v: 0 };
        engine.timeline.play([{ tween: { target: o, to: { v: 1 }, duration: 0.2, ease: 'linear' } }], { actors: [] }).then(() => { ended = true; });
        dispatchEvent(new Event('blur'));
        await frames(40);   // far past 0.2 s at any frame rate. A tween, not { wait }: a wait is a timer in fixed steps and always stopped
        out.waited = !ended && o.v === 0;
        out.frozen = engine.frozen;
        out.run = engine.runState;
        out.time = engine.describe().time.frozenBy;
        dispatchEvent(new Event('focus'));
        await __t.until(() => ended, 5000).catch(() => {});
        out.ended = ended;
        out.after = engine.runState.owners;
        // tools drive a page in a background window: a halted engine has no real-time loop to hold, so step() must still advance
        const h = engine.haltLoop('t-away');
        dispatchEvent(new Event('blur'));
        const t0 = engine.time.tick; engine.step(0.5, { render: false });
        out.stepped = engine.time.tick - t0;
        h.remove();
        out.backHeld = engine.frozen;   // the loop is back and the window is still away: the hold comes back
        dispatchEvent(new Event('focus'));
        // a settings toggle at runtime takes effect at once, not at the next blur
        dispatchEvent(new Event('blur'));
        engine.page.pauseOnBlur = false; out.toggledOff = engine.frozen;
        engine.page.pauseOnBlur = true; out.toggledOn = engine.frozen;
        dispatchEvent(new Event('focus'));
        return out;
      });
      check('a cutscene tween does not run while the page is away', r.waited === true, JSON.stringify(r));
      check('engine.frozen and runState name the page as the holder', r.frozen === true && r.run.owners.includes('page') && r.run.state !== 'running', JSON.stringify(r));
      check('describe().time lists it', r.time?.includes('page'), JSON.stringify(r));
      check('a halted engine steps while the window is away, and the hold returns with the loop', r.stepped === 30 && r.backHeld === true, JSON.stringify(r));
      check('page.pauseOnBlur written while away takes effect at once', r.toggledOff === false && r.toggledOn === true, JSON.stringify(r));
      check('coming back finishes the tween and ends the hold', r.ended === true && !r.after.includes('page'), JSON.stringify(r));
    },
  },
  {
    name: '[guard] freeze { still: true } is a still: animation stops, a plain freeze keeps it moving',
    url: '/tests/anim/index.html',
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready === true, null, { timeout: 20000 });
      const r = await ev(async () => {
        engine.haltLoop();
        const m = engine.player.anim.mixer, moved = () => { const t = m.time; engine.step(0.5, { render: false }); return m.time - t; };
        const still = engine.freeze('t-still', { still: true }), held = moved(); still.remove();
        const plain = engine.freeze('t-menu'), menu = moved(); plain.remove();
        return { held, menu };
      });
      check('no mixer time passes under a still', r.held === 0, JSON.stringify(r));
      check('behind a plain freeze (a pause menu) animation goes on', r.menu > 0.1, JSON.stringify(r));
    },
  },
  {
    name: '[guard] freeze { still: true } is a still: particles hold in the air',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        engine.timeline.skip(); engine.haltLoop();
        engine.particles.define('t-still', { max: 50, lifetime: [1, 1] });
        engine.particles.emit('t-still', [0, 1, 0], { count: 20 });
        const alive = () => engine.particles.effects.get('t-still').alive;
        const still = engine.freeze('t-still', { still: true });
        const before = alive(); engine.step(3, { render: false }); const held = alive();
        still.remove(); engine.step(3, { render: false });
        return { before, held, after: alive() };
      });
      check('no particle ages out under a still', r.before === 20 && r.held === 20, JSON.stringify(r));
      check('they finish when the still ends', r.after === 0, JSON.stringify(r));
    },
  },
];
