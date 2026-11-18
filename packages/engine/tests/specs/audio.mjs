// Audio system (recipes/31-audio.md): buses are real GainNodes, sounds by name (variants never repeat back to back, cooldown, voice limit,
// 3D following an object), the ambience rule table, music rules + stems, ducking that stacks and restores, a settings slider per bus.
// Guards (cannot be bypassed): a built-in synth the game did not name stays silent; an unknown bus or condition says the fix.
const READY = { timeout: 60000 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const specs = [
  {
    name: '[guard] Audio lifecycle in a real page: music asked before the first click and ended with the playthrough stays silent; away the sound waits with the game; a suspended context comes back on the next press',
    url: '/tests/audio/index.html',
    async run({ page, check, ev, frames }) {
      await page.waitForFunction(() => window.engine?.stateApplied, null, READY);
      const a = await ev(async () => {
        engine.music.rules([]); engine.music.play('calm');
        const pending = engine.music.pending?.name ?? null;
        await engine.session.quit(); await engine.session.newGame();
        return { pending, after: engine.music.pending?.name ?? null };
      });
      const box = await page.locator('#view').boundingBox(), click = () => page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await click();
      const state = want => ev(w => __t.until(() => engine.audio.ctx?.state === w, 3000).then(() => true, () => engine.audio.ctx?.state), want);
      check('the first click unlocks', await state('running') === true);
      await frames(5);
      check('music asked for in the ended playthrough does not start on the click', a.pending === 'calm' && !await ev(() => engine.music.playing), JSON.stringify(a));
      await ev(() => { engine.music.play('calm'); }); await frames(3);
      await ev(() => { window.dispatchEvent(new Event('blur')); });
      check('the window goes away: gameplay and sound both wait', await state('suspended') === true && await ev(() => engine.frozen));
      await ev(() => { window.dispatchEvent(new Event('focus')); });
      check('it comes back: they go on, the same music', await state('running') === true && await ev(() => !engine.frozen && engine.music.playing?.name === 'calm'));
      await ev(() => { engine.page.pauseOnBlur = false; window.dispatchEvent(new Event('blur')); });
      await frames(3);
      check('pauseOnBlur false: the sound goes on with the game', await ev(() => engine.audio.ctx.state === 'running'));
      await ev(async () => { window.dispatchEvent(new Event('focus')); engine.page.pauseOnBlur = true; await engine.audio.ctx.suspend(); });   // what a phone does on a call or an app switch
      await click();
      check('a context the system suspended resumes on the next press', await state('running') === true);
    },
  },
  {
    name: 'Audio: before the first click a volume change and a removed bus are not reported as a bus mistake',
    url: '/tests/threads/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine } = threedogThreads, E = mk(createEngine, 'au-early'), a = E.audio;
        const { warns } = await __t.warns(() => { a.setVolume('music', 0.2); a.addBus('auEarly', { level: 0.5 }).remove(); });
        let bad = null;
        try { a.setVolume('auNope', 1); } catch (err) { bad = err.code; }
        const out = { ctx: !!a.ctx, level: a.levels.music, warns: warns.filter(w => /audio\.buses/.test(w)), bad };
        E.dispose();
        return out;
      });
      check('audio is still locked in this test', !r.ctx, JSON.stringify(r));
      check('setVolume keeps the level and no warning says the bus is missing', r.level === 0.2 && r.warns.length === 0, JSON.stringify(r));
      check('a name that is no bus still throws', r.bad === 'unknown-name', JSON.stringify(r));
    },
  },
  {
    name: 'Audio: buses, variants / cooldown / voices, 3D, ambience rule table, music rules and stems, ducking, settings sliders',
    url: '/tests/audio/index.html',
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.engine?.ready, null, READY);
      await page.mouse.click(400, 300);   // browsers unlock audio on the first click
      check('audio unlocks on the first click', await ev(() => __t.until(() => engine.audio.running, 5000).then(() => true, () => false)));

      const b = await ev(() => {
        const a = engine.audio, o = { buses: Object.keys(a.buses).sort().join(','), voice: a.buses.voice.gain.value };
        a.setVolume('voice', 0.4); o.set = a.buses.voice.gain.value;
        a.setVolume('master', 0.7); o.master = a.master.gain.value;
        try { a.setVolume('nope', 1); } catch (err) { o.err = err.message; }
        a.addBus('radio', { level: 0.6 }); o.added = a.buses.radio?.gain.value;
        // a wrong bus name must not throw at connect: in dev a throw in a game callback freezes gameplay
        const warned = []; const warn = console.warn; console.warn = (...m) => warned.push(m.join(' '));
        const wrong = a.buses.reverbb; console.warn = warn;
        o.master2 = a.buses.master === a.master; o.wrong = wrong === a.master; o.wrongWarn = warned.some(w => /reverbb.*\[unknown-name\]/.test(w));
        const n = a.ctx.createGain(); n.connect(a.buses.master); n.connect(a.buses.reverbb); n.disconnect();
        return o;
      });
      check('buses.master is the master node; a wrong bus name warns and gives master, so connect does not throw', b.master2 && b.wrong && b.wrongWarn, JSON.stringify(b));
      check('buses are GainNodes: music sfx ambience ui + the game\'s voice bus', b.buses === 'ambience,master,music,sfx,ui,voice' && Math.abs(b.voice - 0.9) < 1e-6, b.buses);
      check('setVolume sets the bus / master gain', Math.abs(b.set - 0.4) < 1e-6 && Math.abs(b.master - 0.7) < 1e-6, JSON.stringify(b));
      check('[guard] an unknown bus throws and names the fix (addBus)', /addBus/.test(b.err || ''), b.err);
      check('addBus makes a live bus at once', Math.abs(b.added - 0.6) < 1e-6, b.added);

      const s = await ev(async () => {
        const a = engine.audio, seen = [], load = a.load;
        a.load = url => { seen.push(url); return load.call(a, url); };
        for (let i = 0; i < 20; i++) a.sfx('hit');
        a.load = load;
        const o = { seen, repeats: seen.filter((u, i) => i && u === seen[i - 1]).length, kinds: new Set(seen).size };
        o.first = !!a.sfx('slow'); o.second = a.sfx('slow') === null;
        for (let i = 0; i < 3; i++) a.sfx('buzz');
        o.buzz = a.info.voices.buzz;
        o.builtin = a.sfx('wind') === null;   // ambience() registers wind as a built-in synth; this game never named it
        const obj = new window.THREE.Object3D(); obj.position.set(5, 0, 0); engine.add(obj);
        const h = a.sfx('ping', { at: obj }); o.panner = !!h?.panner; o.spatial = a._spatial.size;
        obj.position.set(-7, 1, 2);
        await __t.until(() => Math.abs(h.panner.positionX.value + 7) < 0.01, 3000).catch(() => {});
        o.followX = h.panner.positionX.value;
        h.stop({ fade: 0 });
        await __t.until(() => a._spatial.size === 0, 3000).catch(() => {});
        o.spatialAfter = a._spatial.size;
        return o;
      });
      check('variants: 20 plays, never the same file twice in a row, all 3 used', s.seen.length === 20 && s.repeats === 0 && s.kinds === 3, s.seen.map(u => u.slice(-4)).join(' '));
      check('cooldown: a second play inside it returns null', s.first && s.second, JSON.stringify(s));
      check('voices: 2 at most, the oldest stops for a new one', s.buzz === 2, s.buzz);
      check('[guard] a built-in synth the game did not name stays silent (sfx returns null)', s.builtin);

      // 声音只有一条来源：manifest（文件或合成函数）。audio.register 和 'synth' / { synth } 写法都没有了，写了就报错并给出改法
      const g = await ev(() => {
        const a = engine.audio, o = {}, code = f => { try { f(); return null; } catch (e) { return e.code ?? e.message; } };
        o.register = typeof a.register;
        o.synthWord = code(() => engine.content.load({ name: 'old1', audio: { sounds: { zap: 'synth' } } }));
        o.synthKey = code(() => engine.content.load({ name: 'old2', audio: { sounds: { zap: { synth: 'ping' } } } }));
        let n = 0;
        engine.assets.manifest({ name: 'guard-synth', sounds: { guardBeep: (au, p, out) => { n++; au.tone({ freq: 500 * p.pitch, dur: 0.05, out }); return 0.05; } } });
        o.noRule = !!a.sfx('guardBeep');   // a manifest synth plays by name with no rule, like a manifest file
        o.calls = n;
        return o;
      });
      check('[guard] audio.register is gone: synths are manifest sounds', g.register === 'undefined', g.register);
      check("[guard] 'synth' and { synth } rules throw audio-synth-gone (one way to say where a sound comes from)", g.synthWord === 'audio-synth-gone' && g.synthKey === 'audio-synth-gone', JSON.stringify(g));
      check('a synth function in assets.manifest({ sounds }) plays through audio.sfx(name)', g.noRule && g.calls === 1, JSON.stringify(g));
      check('3D: a PannerNode follows the Object3D every frame', s.panner && s.spatial === 1 && Math.abs(s.followX + 7) < 0.01, s.followX);
      check('zero cost: stopped positional voices leave the per-frame set empty', s.spatialAfter === 0, s.spatialAfter);

      const c = await ev(() => {
        const a = engine.audio, o = {};
        o.day = a.matches({ time: 'day' }); o.night = a.matches({ time: 'night' }); o.range = a.matches({ time: ['11:00', '13:00'] });
        o.clear = a.matches({ weather: ['clear', 'cloudy'] }); o.rain = a.matches({ weather: 'rain' });
        o.zone = a.matches({ zone: 'cave' }); o.fn = a.matches(e => e === engine);
        o.unknown = a.matches({ inside: true });
        return o;
      });
      check('conditions: time (calendar), weather, zone (triggers), functions', c.day && !c.night && c.range && c.clear && !c.rain && !c.zone && c.fn, JSON.stringify(c));
      check('[guard] an unknown condition key never matches (warns with the fix)', c.unknown === false);

      await ev(() => { engine.audio.state = 'combat'; engine.music.intensity = 1; });
      await sleep(900);
      const on = await ev(() => ({ amb: engine.ambience.info, voices: engine.audio.info.voices, music: engine.music.state }));
      check('ambience rule turns on with its condition (state combat): loop at volume 0.5', on.amb[0].on && on.amb[0].volume === 0.5 && on.voices.hum === 1, JSON.stringify(on.amb));
      check('music rule with an object condition picks fight', on.music.current === 'fight', JSON.stringify(on.music));
      await ev(() => __t.until(() => engine.music.state.stems[0] > 0.9, 5000).catch(() => {}));
      check('stems follow intensity (intensity 1 -> stem full)', await ev(() => engine.music.state.stems[0] > 0.9), JSON.stringify(await ev(() => engine.music.state)));
      await ev(() => { engine.audio.state = null; });
      await sleep(900);
      const off = await ev(() => ({ amb: engine.ambience.info, voices: engine.audio.info.voices, music: engine.music.state.current }));
      check('rule off: the loop fades out and stops (no voice left)', !off.amb[0].on && !off.voices.hum, JSON.stringify(off));
      check('music falls back to the rule without when', off.music === 'calm', off.music);

      const d = await ev(() => {
        const a = engine.audio, o = {};
        const d1 = a.duck({ music: 0.5 }, { fade: 0 }), d2 = a.duck({ music: 0.5, ambience: 0.2 }, { fade: 0 });
        o.both = a.info.ducks;
        d2.remove(0); o.one = a.info.ducks;
        d1.remove(0); o.none = a.info.ducks;
        o.levelUntouched = a.buses.music.gain.value === a.levels.music;
        try { a.duck({ musik: 0.5 }); } catch (err) { o.err = err.message; }
        return o;
      });
      check('ducks stack (0.5 x 0.5 = 0.25) and restore in any order', d.both.music === 0.25 && d.both.ambience === 0.2 && d.one.music === 0.5 && d.one.ambience === 1 && d.none.music === 1, JSON.stringify(d));
      // a duck with a fade ramps on the audio clock (still on a headless page): info.ducks and describe().audio say the TARGET at once
      const f = await ev(() => { const dk = engine.audio.duck({ music: 0.3 }, { fade: 2 }); const o = { info: engine.audio.info.ducks.music, text: engine.describeText(), d: engine.describe().audio?.ducks?.music }; dk.remove(0); return o; });
      check('a fading duck reads its target level in info and describe().audio', f.info === 0.3 && f.d === 0.3 && /music ducked to 0.3/.test(f.text), JSON.stringify(f));
      check('ducking never changes the bus level the player set', d.levelUntouched);
      check('[guard] ducking a misspelled bus throws with a suggestion', /music/.test(d.err || ''), d.err);

      const st = await ev(() => {
        const set = engine.settings, o = { keys: ['master', 'music', 'sfx', 'ambience', 'ui', 'voice'].every(b => set.get('vol.' + b) != null) };
        set.set('vol.voice', 0.3); o.voice = engine.audio.buses.voice.gain.value;
        engine.ui.open('settings'); const tab = set.win.el.querySelector('[data-tab="audio"]'); tab?.click();
        o.sliders = set.win.el.querySelectorAll('[data-range^="vol."]').length;
        o.label = set.win.el.textContent.includes(engine.t('settings.vol.master'));
        engine.ui.close('settings');
        return o;
      });
      check('settings: a slider per bus (master first, the game\'s own too), and it drives the bus', st.keys && Math.abs(st.voice - 0.3) < 1e-6 && st.sliders >= 7 && st.label, JSON.stringify(st));
    },
  },
  {
    name: 'Audio: [guard] content audio: sounds by asset name, data rules on measures, packs merge by id, functions dropped, code names clash',
    url: '/tests/audio/index.html',
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.engine?.ready, null, READY);
      await page.mouse.click(400, 300);
      await ev(() => __t.until(() => engine.audio.running, 5000).catch(() => {}));
      const r = await ev(async () => {
        const a = engine.audio, o = {}, err = f => { try { f(); return null; } catch (e) { return e.message; } };
        engine.assets.manifest({ name: 'tones', sounds: { toneA: window.toneUrl } });
        const warn = console.warn; let w = ''; console.warn = m => { w += m; };
        o.load = err(() => engine.content.load([
          { name: 'p1', audio: { sounds: { chime: 'toneA', drone: { src: 'ping', loop: true } }, music: { tracks: { packTrack: 'toneA' } },
            ambience: [{ sound: 'drone', when: { daylight: { gt: 0.1 } }, volume: { base: 0.1, add: { rain: 1 }, max: 0.3 }, fade: 0.1 }] } },
          { name: 'p2', audio: { ambience: [{ sound: 'drone', when: () => true }], footsteps: { sand: 'chime' } } },
        ]));
        engine.content.load({ name: 'p3', audio: { sounds: { pathy: '/sfx/pathy.ogg' } } });
        console.warn = warn; o.warn = w;
        o.rules = engine.ambience.info.map(i => i.sound).join(',');
        o.cfg = 'chime' in a.config.sounds && a.config.footsteps.sand === 'chime' && engine.music.tracks.has('packTrack');
        o.dup = err(() => engine.content.load([{ name: 'x', audio: { sounds: { s1: 'toneA' } } }, { name: 'y', audio: { sounds: { s1: 'toneA' } } }]));
        o.code = err(() => engine.content.load({ name: 'z', audio: { sounds: { hit: 'toneA' } } }));
        o.measures = ['daylight', 'rain', 'snow', 'wind', 'nearWater', 'altitude'].filter(n => typeof a.value(n) !== 'number');
        o.cmp = [a.matches({ daylight: { gt: 0.1 } }), a.matches({ daylight: { lt: 0.1 } }), a.matches({ rain: { lte: 0, gte: 0 } })];
        o.vol = [a.volumeOf({ base: 0.1, add: { rain: 1 }, max: 0.3 }), a.volumeOf({ base: 2, max: 0.3 }), a.volumeOf({ base: -1, min: 0 })];
        o.clash = err(() => a.measure('time', () => 1));
        o.chime = !!a.sfx('chime');
        await __t.until(() => engine.assets.entries.get('toneA')?.value, 3000).catch(() => {});
        o.viaAssets = !!engine.assets.entries.get('toneA')?.value;
        await __t.until(() => engine.ambience.info.find(i => i.sound === 'drone')?.on, 3000).catch(() => {});
        o.drone = engine.ambience.info.find(i => i.sound === 'drone');
        engine.content.load({ name: 'p1', audio: { ambience: [{ sound: 'drone', volume: 0.2 }] } });   // the same pack again: replaces its rules
        o.reload = engine.ambience.info.filter(i => i.sound === 'drone').length;
        return o;
      });
      check('content audio loads; a rule holding a function is dropped with a warning (hum from code + drone from p1 only)', r.load === null && r.rules === 'hum,drone' && /dropped/.test(r.warn), JSON.stringify(r));
      check('[guard] a sound written as a file path in content warns with the asset pack form', /pathy/.test(r.warn) && /asset pack/.test(r.warn), r.warn);
      check('sounds / footsteps / tracks merge into engine.audio and engine.music', r.cfg);
      check('[guard] the same sound name in two packs of one load: error naming both', /audio\.sounds\.s1/.test(r.dup ?? '') && /pack "x"/.test(r.dup) && /pack "y"/.test(r.dup), r.dup);
      check('[guard] a sound name defined in code and in content: error', /audio-name-clash/.test(r.code ?? ''), r.code);
      check('measures: sky daylight, weather rain / snow / wind, ambience nearWater / altitude', r.measures.length === 0, r.measures.join(','));
      check('measure comparisons in when (gt / lt / gte+lte)', r.cmp[0] && !r.cmp[1] && r.cmp[2], JSON.stringify(r.cmp));
      check('data volume: base + measure x factor, clamped by max / min', Math.abs(r.vol[0] - 0.1) < 1e-9 && r.vol[1] === 0.3 && r.vol[2] === 0, JSON.stringify(r.vol));
      check('[guard] a measure may not reuse a condition key', /condition key and a measure/.test(r.clash ?? ''), r.clash);
      check('a content sound name resolves through the asset pack (engine.assets loads toneA)', r.chime && r.viaAssets);
      check('a data rule plays: drone on at volume 0.1 by day', r.drone?.on && Math.abs(r.drone.volume - 0.1) < 1e-6, JSON.stringify(r.drone));
      check('loading the same named pack again replaces its rules instead of doubling them', r.reload === 1, r.reload);
    },
  },
  {
    name: 'Audio: [guard] decoded sounds follow the asset lifetime: release, trim and the memory budget free long sounds, playing ones play on, freed ones load again',
    url: '/tests/audio/index.html',
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.engine?.ready, null, READY);
      await page.mouse.click(400, 300);
      await ev(() => __t.until(() => engine.audio.running, 5000).catch(() => {}));
      const r = await ev(async () => {
        const a = engine.audio, A = engine.assets, o = {}, held = n => !!A.entries.get(n)?.value;
        const tune = window.wav(330, 12), kept = window.wav(330, 12), short = window.wav(440), track = window.wav(220, 12);
        A.manifest({ name: 'memory', sounds: { tune, kept: { url: kept, preload: true } } });
        await a.load(short); await a.load('kept');
        // a music track by path: the same cache, the same lifetime
        engine.music.define('long', track); engine.music.override('long', { fade: 0 });
        await __t.until(() => engine.music.playing?.srcs.length, 5000);
        const h = await a.play('tune', { loop: true });
        o.trimmed = A.trim();
        o.isTrack = o.trimmed.includes(track); o.isTune = o.trimmed.includes('tune');
        o.after = { short: held(short), kept: held('kept'), tune: held('tune'), track: held(track) };
        o.playing = { voice: h.playing && h.source.buffer?.duration > 11, music: engine.music.playing?.srcs[0].buffer?.duration > 11, name: engine.music.state.playing };
        o.again = (await a.play('tune')).source.buffer?.duration; o.cached = held('tune');
        A.release(short); o.released = held(short); o.shortAgain = (await a.load(short)).duration;
        h.stop({ fade: 0 }); engine.music.override(null);
        const long = [0, 1, 2].map(() => window.wav(220, 300));   // about 55 MB decoded each: three are over the budget
        for (const u of long) await a.load(u);
        o.budget = long.map(held); o.budgetShort = held(short); o.budgetKept = held('kept');
        o.back = (await a.load(long[0])).duration; o.budgetAfter = long.map(held);
        o.oneCache = a.buffers === undefined;
        return o;
      });
      check('[guard] trim frees long sounds and leaves short effects and preload ones', r.after.short && r.after.kept && !r.after.tune && !r.after.track && r.trimmed.length === 2 && r.isTrack && r.isTune, JSON.stringify(r.after) + r.trimmed);
      check('[guard] a sound and a music track still playing keep sounding after trim', r.playing.voice && r.playing.music && r.playing.name === 'long', JSON.stringify(r.playing));
      check('[guard] a freed sound loads again when played', r.again > 11 && r.cached, JSON.stringify(r));
      check('assets.release takes a path too; the sound loads again', !r.released && r.shortAgain > 0.9, JSON.stringify(r));
      check('[guard] over the budget the long sound asked for longest ago goes, the newest stays, short and preload ones are not touched', !r.budget[0] && r.budget[1] && r.budget[2] && r.budgetShort && r.budgetKept, JSON.stringify(r.budget));
      check('[guard] a sound the budget freed loads again and pushes out the next oldest', r.back > 299 && r.budgetAfter[0] && !r.budgetAfter[1] && r.budgetAfter[2], JSON.stringify(r.budgetAfter));
      check('one cache: audio.buffers is gone', r.oneCache);
    },
  },
  {
    name: '[guard] audio.addNode: a node on one bus silences that bus after master and in the reverb send, remove() gives it back; a generated music track goes through play (output is its node, stop on fade, end() ends it); generate with url is refused',
    url: '/tests/audio/index.html',
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.engine?.ready, null, READY);
      await page.mouse.click(400, 300);
      check('audio unlocks on the first click', await ev(() => __t.until(() => engine.audio.running, 5000).then(() => true, () => false)));
      const r = await ev(async () => {
        const a = engine.audio, ctx = a.ctx, wait = () => new Promise(res => setTimeout(res, 600));
        const probe = n => { const an = ctx.createAnalyser(); an.fftSize = 256; n.connect(an); return an; };
        const level = an => { const d = new Float32Array(an.fftSize); an.getFloatTimeDomainData(d); return Math.max(...d.map(Math.abs)); };
        engine.music.rules(null); engine.music.stop({ fade: 0 });   // the page's rules start a track: master must carry only this test's source
        a.reverb({ sends: { sfx: 1 } });
        const dry = probe(a.master), send = probe(a._reverb.nodes.input);
        const src = ctx.createConstantSource(); src.connect(a.buses.sfx); src.start();
        await __t.until(() => level(dry) > 0.1, 4000).catch(() => {}); const before = [level(dry), level(send)];
        const mute = a.addNode('sfx', c => { const g = c.createGain(); g.gain.value = 0; return g; });
        await wait(); const muted = [level(dry), level(send)];
        mute.remove(); mute.remove();
        await wait(); const back = [level(dry), level(send)];
        let bad = null; try { a.addNode('nope', c => c.createGain()); } catch (err) { bad = err.message; }
        src.stop();
        return { before, muted, back, bad };
      });
      check('an sfx source is heard at master and in the reverb send', r.before[0] > 0.1 && r.before[1] > 0.1, JSON.stringify(r));
      // 0.05 not 0: master also carries whatever else the page sounds faintly; a leak would be the source's 0.64
      check('[guard] a zero-gain node on sfx: silent after master, and the reverb send is silent too', r.muted[0] < 0.05 && r.muted[1] < 1e-4, JSON.stringify(r));
      check('remove() (twice) links the path back', r.back[0] > 0.1 && r.back[1] > 0.1, JSON.stringify(r));
      check('an unknown bus throws and lists the buses', /nope/.test(r.bad ?? '') && /sfx/.test(r.bad ?? ''), r.bad);
      const g = await ev(async () => {
        const m = engine.music, calls = [], stops = [], changes = [];
        m.rules(null);
        let end = null;
        m.define('gen', { generate(arg) { calls.push(arg); end = arg.end; const o = arg.ctx.createOscillator(); o.connect(arg.output); o.start(arg.start); return { stop: at => { stops.push(at); o.stop(at); } }; } });
        engine.events.on('music:change', e => changes.push(e.to));
        m.play('gen', { fade: 0 });
        await __t.until(() => calls.length === 1, 5000);
        const first = { n: calls.length, own: calls[0].output === m.playing.gain, start: typeof calls[0].start === 'number' };
        m.play('calm', { fade: 0.1 });
        await __t.until(() => stops.length === 1, 5000);
        m.play('gen', { fade: 0 });
        await __t.until(() => calls.length === 2, 5000);
        end();
        await __t.until(() => changes.at(-1) === null, 5000).catch(() => {});
        let both = null; try { m.define('bad', { url: 'x.ogg', generate() {} }); } catch (err) { both = err.code; }
        return { first, stops: stops.length, changes, both, playing: m.playing };
      });
      check('[guard] generate is called once with the track gain node and a start time', g.first.n === 1 && g.first.own && g.first.start, JSON.stringify(g.first));
      check('[guard] switching to another track calls the generated track stop', g.stops === 1, JSON.stringify(g));
      check('[guard] end() ends the track: music:change to null', g.changes.at(-1) === null && !g.playing, JSON.stringify(g.changes));
      check('[guard] a track with url and generate is refused with music-track', g.both === 'music-track', String(g.both));
    },
  },
  {
    name: 'Audio: the open-world example sounds through its rule table (wind loop on, footsteps map to sounds it defines)',
    url: '/?cutscene=skip',
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.engine?.stateApplied, null, READY);
      await page.mouse.click(640, 360);
      await ev(() => __t.until(() => engine.audio.running, 5000).catch(() => {}));
      await ev(() => __t.until(() => engine.audio.info.voices.wind === 1, 5000).catch(() => {}));
      const r = await ev(() => {
        const cfg = engine.audio.config, missing = Object.values(cfg.footsteps).filter(n => !(n in cfg.sounds));
        return { amb: engine.ambience.info.map(i => i.sound).join(','), wind: engine.audio.info.voices.wind, missing };
      });
      check('the five ambience rules are installed and the wind loop plays', r.amb === 'wind,rain,water,birds,crickets' && r.wind === 1, JSON.stringify(r));
      check('[guard] every footstep sound name is defined in audio.sounds', r.missing.length === 0, r.missing.join(','));
    },
  },
];
