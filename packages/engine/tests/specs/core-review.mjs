// Guards for the engine core: saves and the save format, session, threads, core guards. Each test builds fresh headless engines on the
// threads test page, so no game content gets in the way. Same format as the other files here. Run: npm test -- "Core review"

import { existsSync } from 'node:fs';
import { unregistered } from '../errorCodeScan.mjs';

const PAGE = '/tests/threads/';

export const specs = [
  {
    // read in node (no page work): a code raised without an ERROR_CODES entry ships with err.fix null and no docs, the part an AI needs most
    name: '[guard] error codes: every [code] the engine source raises is registered in ERROR_CODES, and every docs link exists',
    url: PAGE,
    async run({ check }) {
      const missing = await unregistered();
      check('no code is raised without an entry (add it to core/base/errorCodes.js with fix + docs)', missing.length === 0, missing.join('; '));
      const { ERROR_CODES } = await import(new URL('../../core/base/errorCodes.js', import.meta.url).href);
      // a link is "file §section" (docRef.js, the one spelling): here only that it parses and the file exists; whether the section exists is
      // tools/tests/error-doc-pointers.mjs (readSection), so the two checks do not drift apart
      const { parseDocRef } = await import(new URL('../../core/base/docRef.js', import.meta.url).href);
      const dead = Object.entries(ERROR_CODES).flatMap(([k, v]) => (v.docs || []).filter(d => { const r = parseDocRef(d); return !r || !existsSync(new URL('../../docs/' + r.file, import.meta.url)); }).map(d => `${k}: ${d}`));
      check('every docs link of every code points at an existing page', dead.length === 0, dead.join('; '));
      check('plugin-shape lists only what plugs in (a Material or ShaderPatch is refused)', !/a Material|ShaderPatch/.test(ERROR_CODES['plugin-shape'].fix), ERROR_CODES['plugin-shape'].fix);
      check('camera-none does not promise a camera openWorld only installs when named', !/openWorld installs followCamera/.test(ERROR_CODES['camera-none'].fix), ERROR_CODES['camera-none'].fix);
      const { vec3 } = await import(new URL('../../core/base/math.js', import.meta.url).href);
      let zero = null;
      try { vec3(0); } catch (err) { zero = err.code; }
      check('vec3: the old (x, z) form starting at 0 throws like any other number, it does not become the origin', zero === 'bad-position', String(zero));
    },
  },
  {
    name: "Core review: a module whose describe hook throws fills only its own entry ({ error, code }); describe() and engine.step() go on",
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine } = threedogThreads;
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, urlState: false, saveKey: 'cr-describe' });
        E.use({ name: 'crBroken', type: 'rules', install: () => ({}), describe() { throw new Error('crBroken hook broke'); } },
          { name: 'crFine', type: 'rules', install: () => ({}), describe: () => ({ ok: 1 }) });
        await E.start();
        let stepErr = null, d = null;
        const { warns } = await __t.warns(() => { try { E.haltLoop(); E.step(0.1); d = E.describe(); } catch (e) { stepErr = e.message; } });
        E.dispose?.();
        return { stepErr, broken: d?.crBroken, fine: d?.crFine, time: typeof d?.time, warns };
      });
      check('step() and describe() do not throw', r.stepErr === null && r.time === 'object', JSON.stringify(r));
      check('the broken module entry is { error, code: describe-threw }; the other module is intact', /crBroken hook broke/.test(r.broken?.error) && r.broken?.code === 'describe-threw' && r.fine?.ok === 1, JSON.stringify(r));
      check('one warning names the module [describe-threw]', r.warns.filter(w => /'crBroken'/.test(w) && /describe-threw/.test(w)).length === 1, JSON.stringify(r.warns));
    },
  },
  {
    name: 'Core review: saves -- a throwing save() keeps the old save; envelope format, unknown parts kept and adopted; a throwing load() rolls back; load is a Promise',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine } = threedogThreads;
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, urlState: false, saveKey: 'cr-saves' });
        await E.start();
        const S = E.saves, quiet = [console.error, console.warn]; console.error = console.warn = () => {};
        let a = 1, bad = false;
        S.define('crA', { save: () => ({ a }), load: d => { a = d.a; } });
        S.define('crB', { save: () => { if (bad) throw new Error('crB broke'); return { b: 1 }; }, load: d => { if (d.boom) throw new Error('crB load broke'); } });
        const first = await S.save('cr1');
        a = 2; bad = true;
        const second = await S.save('cr1');
        const kept = JSON.parse(S._json.get('cr1')).parts.crA.a, saveCode = E.error?.code;
        E.error = null; E.stacks.get('freeze').release('error'); bad = false;
        const env = S.collect();
        S._json.set('cr-f2', JSON.stringify({ ...env, format: 2 }));
        const f2 = S.check('cr-f2');
        S._json.set('cr-ghost', JSON.stringify({ ...env, parts: { ...env.parts, ghost: { keep: 7 } }, versions: { ...env.versions, ghost: 3 } }));
        const ghostLoad = await S.load('cr-ghost');
        await S.save('cr-ghost2');
        const g2 = JSON.parse(S._json.get('cr-ghost2'));
        let adopted = null;
        S.define('ghost', { version: 3, save: () => adopted, load: d => { adopted = d; } });   // the module arrives later: it gets its part
        a = 5;
        S._json.set('cr-boom', JSON.stringify({ ...env, parts: { ...env.parts, crA: { a: 99 }, crB: { boom: true } } }));
        const p = S.load('cr-boom'), isPromise = typeof p?.then === 'function', boom = await p, afterBoom = a, boomCode = E.error?.code;
        E.error = null; E.stacks.get('freeze').release('error');
        const missing = S.load('nope'), missingIsPromise = typeof missing?.then === 'function', missingOk = await missing;
        [console.error, console.warn] = quiet;
        E.dispose();
        return { first, second, kept, saveCode, format: env.format, f2, ghostLoad, ghost: g2.parts.ghost, ghostV: g2.versions.ghost, adopted, isPromise, boom, afterBoom, boomCode, missingIsPromise, missingOk };
      });
      check('a part whose save() throws: save returns false, the slot keeps the previous save, code save-part-threw', r.first === true && r.second === false && r.kept === 1 && r.saveCode === 'save-part-threw', JSON.stringify(r));
      check('the envelope has format 1; a save with format 2 is refused as tooNew', r.format === 1 && r.f2 === 'tooNew', JSON.stringify(r));
      check('a part no module owns survives load -> save with its version, and a module registering later receives it', r.ghostLoad === true && r.ghost?.keep === 7 && r.ghostV === 3 && r.adopted?.keep === 7, JSON.stringify(r));
      check('a part whose load() throws: load resolves false, earlier parts go back to their pre-load state, code save-load-threw', r.isPromise && r.boom === false && r.afterBoom === 5 && r.boomCode === 'save-load-threw', JSON.stringify(r));
      check('saves.load always returns a Promise (also for a missing slot)', r.missingIsPromise && r.missingOk === false, JSON.stringify(r));
    },
  },
  {
    name: 'Core review: save import is offline and checked -- a non-data: attachment is refused without fetching; __proto__ keys in a save are dropped',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine } = threedogThreads;
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, urlState: false, saveKey: 'cr-import' });
        await E.start();
        const S = E.saves, quiet = console.warn; console.warn = () => {};
        const env = S.collect();
        let fetched = 0; const of = window.fetch; window.fetch = (...x) => { fetched++; return of(...x); };
        const file = { threedog: 'save', format: 1, data: env, files: [{ group: 'photo', id: 'x', url: 'https://example.com/a.png', type: 'image/png' }] };
        const remote = await S.importFile(new File([JSON.stringify(file)], 'x.json'));
        const ok = await S.importFile(new File([JSON.stringify({ ...file, files: [{ group: 'photo', id: 'y', type: 'text/plain', url: 'data:text/plain;base64,aGk=' }] })], 'y.json'));
        const blob = (await S.store.blobs('photo')).find(b => b.id === 'y');
        const newer = await S.importFile(new File([JSON.stringify({ ...file, format: 2, files: [] })], 'z.json'));
        window.fetch = of;
        const flags = '{"__proto__": {"evil": true}, "ok": true}';
        S._json.set('cr-proto', JSON.stringify(env).replace('"flags":{}', '"flags":' + flags));
        const loaded = await S.load('cr-proto');
        const text = await S.import(S.export('cr-proto'), 'cr-text');
        console.warn = quiet;
        const out = { remote, ok, blobText: blob ? await blob.blob.text() : null, newer, fetched, loaded, text, evil: E.vars.flags.evil ?? null, flagOk: E.vars.flags.ok, plain: Object.getPrototypeOf(E.vars.flags) === null };
        E.dispose();
        return out;
      });
      check('an https attachment refuses the whole file, and nothing is fetched', r.remote === null && r.fetched === 0, JSON.stringify(r));
      check('a data: attachment is decoded offline into the blobs store; the default slot is "imported"', r.ok === 'imported' && r.blobText === 'hi', JSON.stringify(r));
      check('an export file of a newer file format is refused', r.newer === null, JSON.stringify(r));
      check('"__proto__" in save data does not reach the flags object (no prototype swap), other flags load', r.loaded === true && r.evil === null && r.flagOk === true && r.plain, JSON.stringify(r));
      check('import(text) resolves true once stored', r.text === true, JSON.stringify(r));
    },
  },
  {
    name: 'Final review: time and session -- real and repeating event timers survive a load; requests and real mods survive a tick restart; a double Restart is one',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine } = threedogThreads;
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, urlState: false, saveKey: 'fr-time' });
        await E.start();
        const hits = { real: 0, rep: 0 };
        E.events.on('fr:real', () => hits.real++); E.events.on('fr:rep', () => hits.rep++);
        E.step(4);
        E.clock.after(1, 'fr:real', { channel: 'real' });
        E.clock.every(1, 'fr:rep', { channel: 'real' });
        await E.saves.save('t');
        await E.session.load('t');   // tick restarts: 'real' due times must shift with it
        E.step(0.5); const early = hits.real;
        E.step(3); const fired = { ...hits };
        // a request that outlives the load, and a mod no save holds
        E.step(5);
        let late = false; const p = E.nextFixed(() => { late = true; });
        E.stacks.define('fr.point', { save: false });
        const gone = []; E.events.on('mod:end', d => gone.push(d.target));
        E.mod('fr.point', { owner: 'fr', mul: 2, for: 1 });
        const a = E.session.newGame(), b = E.session.newGame();   // a double-clicked Restart
        let starts = 0; E.events.on('session:start', () => starts++);
        await Promise.all([a, b]);
        E.step(0.1); await p;
        E.step(1.1);
        const out = { early, fired, late, starts, modEnded: gone.includes('fr.point'), same: a === b };
        E.ops.allow(() => { E.vars.flags.frKept = true; });
        await E.saves.save('t');
        const asked = [E.session.newGame(), E.session.load('t')];   // a load asked while ?play's new game runs
        out.loaded = (await Promise.all(asked))[1]; out.kept = E.vars.flags.frKept === true;
        E.dispose();
        return out;
      });
      check('a real timer keeps its time left through session.load', r.early === 0 && r.fired.real === 1, JSON.stringify(r));
      check('a repeating event timer still repeats after a load', r.fired.rep >= 3, JSON.stringify(r));
      check('a nextFixed made before newGame lands soon after it', r.late === true, JSON.stringify(r));
      check('an unsaved real-clock mod keeps its time left through the restart', r.modEnded === true, JSON.stringify(r));
      check('two overlapping newGame calls are one replacement', r.starts === 1 && r.same === true, JSON.stringify(r));
      check('a load asked during a new game waits for it and then loads', r.loaded === true && r.kept === true, JSON.stringify(r));
    },
  },
  {
    name: 'Final review: hooks and bus -- a removed hook or listener does not fire later in the same pass; dispose in a hook ends step; no canvas works; disabled name is free again',
    url: PAGE,
    expectErrors: /picture/,   // the module that throws on purpose
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine } = threedogThreads;
        const E = createEngine({ headless: true, urlState: false, saveKey: 'fr-hooks' });   // no canvas: three makes one
        const noCanvas = E.renderer.domElement === E.input.canvas;
        await E.start();
        const n = { frame: 0, fixed: 0, ev: 0, hook: 0, disposed: 0 };
        let hb, hf, he;
        const killer = E.onFrame(() => hb.remove()); hb = E.onFrame(() => n.frame++);
        E.onFixed(() => hf.remove()); hf = E.onFixed(() => n.fixed++);
        E.events.on('fr:x', () => he.remove()); he = E.events.on('fr:x', () => n.ev++);
        E.use({ name: 'frA', stage: 'control', frame(dt, e) { if (e.has('frB')) e.unuse('frB'); } }, { name: 'frB', frame() { n.hook++; }, dispose() { n.disposed++; } });
        E.step(1 / 60, { describe: false }); E.events.emit('fr:x');
        killer.remove();
        // a picture module that threw and was disabled: a new one of that name gets its hooks
        let good = 0;
        E.use({ name: 'frP', type: 'picture', frame() { throw new Error('picture'); } });
        E.step(1 / 60, { describe: false });
        E.unuse('frP'); E.use({ name: 'frP', type: 'picture', frame() { good++; } });
        E.step(1 / 60, { describe: false });
        const undoRev = (() => {
          E.ops.define('fr.u', { run: () => 1, undo: () => {} });
          const a = E.ops.run('fr.u').revision; E.ops.undo('fr.u', {}, 1);
          return E.ops.revision > a;
        })();
        E.saves._replace.begin(); const undoHeld = E.ops.undo('fr.u', {}, 1).code; E.saves._replace.end();
        let nullLoad = false;
        E.saves.define('frNull', { atomic: true, save: () => null, load: () => { nullLoad = true; } });
        E.ops.define('fr.bad', { atomic: true, run: () => ({ ok: false, code: 'no' }) });
        E.ops.run('fr.bad');
        let after = 0;
        E.onFixed(() => { E.dispose(); }); E.onFixed(() => after++);
        const stepped = E.step(1, { describe: false });
        return { n, noCanvas, good, undoHeld, undoRev, nullLoad, after, stepped, disposed: E.disposed };
      });
      check('createEngine without a canvas binds input to the canvas three made', r.noCanvas === true, JSON.stringify(r));
      check('hooks and listeners removed earlier in the pass stay silent', r.n.frame === 0 && r.n.fixed === 0 && r.n.ev === 0, JSON.stringify(r.n));
      check('a module unloaded by an earlier hook gets no hook after its dispose', r.n.hook === 0 && r.n.disposed === 1, JSON.stringify(r.n));
      check('a disabled module name does not disable its replacement', r.good === 1, JSON.stringify(r));
      check('ops.undo moves the revision', r.undoRev === true, JSON.stringify(r));
      check('ops.undo refuses like ops.run while save parts load', r.undoHeld === 'loading', JSON.stringify(r));
      check('an atomic rollback never hands load() null', r.nullLoad === false, JSON.stringify(r));
      check('dispose inside a fixed hook stops the pass and the step', r.after === 0 && r.stepped === null && r.disposed === true, JSON.stringify(r));
    },
  },
  {
    name: 'Final review: input -- chorded mouse buttons, a muted key forgotten on blur, an action two owners share',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine } = threedogThreads;
        const canvas = document.createElement('canvas'); canvas.setPointerCapture = () => {}; document.body.append(canvas);
        const E = createEngine({ canvas, headless: true, urlState: false, saveKey: 'fr-input' });
        await E.start();
        const I = E.input, pe = (t, button, buttons) => canvas.dispatchEvent(new PointerEvent(t, { pointerType: 'mouse', pointerId: 1, button, buttons, bubbles: true }));
        pe('pointerdown', 0, 1);
        pe('pointermove', 2, 3);   // right pressed while left is held: no pointerdown in a real browser
        const chord = [I.keys.has('Mouse0'), I.keys.has('Mouse2')];
        pe('pointermove', 0, 2);   // left let go first
        const leftUp = !I.keys.has('Mouse0');
        pe('pointerup', 2, 0);
        const allUp = !I.keys.has('Mouse0') && !I.keys.has('Mouse2');
        I._muted.add('KeyW'); E.events.emit('page:blur', { focused: false, visible: true });
        const muted = I._muted.size;
        const a = I.define('frShared', { owner: 'a', optional: true }), b = I.define('frShared', { owner: 'b', optional: true });
        a.remove(); const kept = I.actions.has('frShared'); b.remove(); const freed = !I.actions.has('frShared');
        E.dispose(); canvas.remove();
        return { chord, leftUp, allUp, muted, kept, freed };
      });
      check('a second button while one is held is seen', r.chord[0] && r.chord[1], JSON.stringify(r));
      check('releasing in any order leaves no key stuck', r.leftUp && r.allUp, JSON.stringify(r));
      check('blur forgets muted keys', r.muted === 0, JSON.stringify(r));
      check('a shared action lives until its last owner goes', r.kept && r.freed, JSON.stringify(r));
    },
  },
  {
    name: 'Final review: saves and scenarios -- a bad attachment is refused, a slot another tab deleted saves again, a scenario that throws still ends',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine } = threedogThreads;
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, urlState: false, saveKey: 'fr-saves' });
        await E.start();
        const S = E.saves, file = JSON.stringify({ threedog: 'save', format: 1, data: S.collect(), files: [{ group: 'a', id: 'b', url: 'data:text/plain;base64,@@@' }] });
        let imported = 'threw'; try { imported = await S.importFile(new Blob([file])); } catch { /* the bug */ }
        await S.save('x'); await S.flush();
        await S.store.deleteSlot('x'); S._show('x', null);   // what a note from the other tab does
        const again = await S.save('x');
        await E.applyState({ pos: 'abc' }).catch(() => {});
        const applied = E.stateApplied;
        await S.remove('x'); E.dispose();
        return { imported, again, applied };
      });
      check('an attachment with bad base64 resolves null', r.imported === null, JSON.stringify(r));
      check('a slot deleted elsewhere can be saved again', r.again === true, JSON.stringify(r));
      check('stateApplied comes back after a scenario that failed', r.applied === true, JSON.stringify(r));
    },
  },
  {
    name: 'Final review: debug overrides -- material.clone works after a view, a game swap survives the undo, an owned value stays driven',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine, THREE } = threedogThreads;
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, urlState: false, saveKey: 'fr-debug' });
        await E.start();
        const mat = new THREE.MeshStandardMaterial(), m = new THREE.Mesh(new THREE.BoxGeometry(), mat);
        E.scene.add(m);
        const h = E.debug.override('fr', m, { material: 'wire' });
        const stand = m.material;
        h.remove();
        let cloned = true; try { mat.clone(); stand.clone(); } catch { cloned = false; }
        const h2 = E.debug.override('fr', m, { material: 'wire' }), swap = new THREE.MeshBasicMaterial();
        m.material = swap; h2.remove();
        const kept = m.material === swap;
        const far = E.camera.far, h3 = E.debug.override('fr', E.camera, 'far', 500);
        E.step(1 / 60, { describe: false }); h3.remove();
        const back = E.camera.far === far;
        let bare = ''; try { E.debug.override('fr', m); } catch (err) { bare = err.code; }
        E.dispose();
        return { cloned, kept, back, bare };
      });
      check('a material and its stand-in clone after a debug view', r.cloned === true, JSON.stringify(r));
      check('undo leaves a material the game swapped in', r.kept === true, JSON.stringify(r));
      check('an override gives an owned value back', r.back === true, JSON.stringify(r));
      check('override with no patch names the fix', r.bare === 'debug-override', JSON.stringify(r));
    },
  },
  {
    name: 'Final review: stream and batching -- a throwing attach keeps queued at zero; whenReady after remove rejects; a same-count child swap redraws; mirrored stays out; refresh of a child',
    url: PAGE,
    expectErrors: /attach boom/,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine, THREE } = threedogThreads;
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, urlState: false, saveKey: 'fr-batch', batching: { minCount: 2 } });
        await E.start();
        let built = 0; const ownAdd = E.add;
        E.add = () => { throw new Error('attach boom'); };
        E.stream.add({ position: [0, 0, 0], radius: 6, build: () => { built++; return new THREE.Object3D(); } });
        E.step(0.1, { describe: false }); await new Promise(res => setTimeout(res, 0));
        delete E.add; if (E.add !== ownAdd) E.add = ownAdd;
        const queued = E.stream.queued;
        const src = E.stream.source([900, 0, 900], { name: 'fr' });
        let rejected = false;
        src.remove(); await Promise.race([src.whenReady.catch(() => { rejected = true; }), new Promise(res => setTimeout(res, 200))]);
        const geo = new THREE.BoxGeometry(), mat = new THREE.MeshStandardMaterial();
        const block = new THREE.Group(), kids = []; block.userData.batch = true;
        for (let i = 0; i < 3; i++) { const k = new THREE.Mesh(geo, mat); k.position.x = i; block.add(k); kids.push(k); }
        const flagA = new THREE.Object3D(), flagB = new THREE.Object3D(); block.add(flagA);
        E.scene.add(block); E.step(1 / 60);
        const batched = kids.every(k => k.userData.batched);
        E.batching.skip(); E.batching.unskip();   // the draw list exists before the swap
        block.remove(flagA); block.add(flagB);
        let drawn = null; const h = E.onRender(() => {}, { when: 'before' });
        E.batching.skip(); drawn = [...block.children]; E.batching.unskip(); h.remove();
        const swapped = drawn.includes(flagB) && !drawn.includes(flagA);
        const mirror = new THREE.Group(), left = []; mirror.userData.batch = true;
        for (let i = 0; i < 3; i++) { const k = new THREE.Mesh(geo, mat); k.scale.x = -1; k.position.z = 5 + i; mirror.add(k); left.push(k); }
        E.scene.add(mirror); E.step(1 / 60);
        const mirrored = left.some(k => k.userData.batched);
        const tracked = E.batching.roots.size; E.batching.refresh(kids[0]); E.step(1 / 60);
        const refreshed = E.batching.roots.size === tracked;
        E.dispose();
        return { built, queued, rejected, batched, swapped, mirrored, refreshed };
      });
      check('a build whose attach throws is counted down once', r.built >= 1 && r.queued === 0, JSON.stringify(r));
      check('whenReady after remove() rejects instead of hanging', r.rejected === true, JSON.stringify(r));
      check('batching ran on the block', r.batched === true, JSON.stringify(r));
      check('a child swapped in the same frame is drawn, the removed one is not', r.swapped === true, JSON.stringify(r));
      check('a mirrored mesh is not batched', r.mirrored === false, JSON.stringify(r));
      check('refresh of a child mesh keeps its root tracked', r.refreshed === true, JSON.stringify(r));
    },
  },
  {
    name: 'Core review: session -- autosave waits outside play and stops with remove(); session.load resets parts the save lacks; newGame cancels a running skip',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine } = threedogThreads;
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, urlState: false, saveKey: 'cr-session', ui: { title: { title: 'T' } } });
        let part = 'new';
        E.saves.define('crP', { save: () => ({ v: part }), load: d => { part = d.v; } });
        await E.start();
        const S = E.saves; let saved = 0; E.events.on('save:written', () => saved++);
        const atTitle = E.session.playing;
        const h = S.autosave(0.01);   // 0.6 fixed seconds of play
        E.step(2); await S.flush();
        const duringTitle = saved;
        await E.session.newGame(); E.ui.close('title');
        E.step(2); await S.flush(); await new Promise(res => setTimeout(res, 30));
        const duringPlay = saved;
        h.remove(); E.step(2); await S.flush(); await new Promise(res => setTimeout(res, 30));
        const afterRemove = saved;
        let badMinutes = ''; try { S.autosave(0); } catch (e) { badMinutes = e.code; }
        // a save made without crP (an older version of the game): continuing gives crP its new-game state, not the current run's
        await S.save('cr-old');
        const old = JSON.parse(S._json.get('cr-old')); delete old.parts.crP; delete old.versions.crP; S._json.set('cr-old', JSON.stringify(old));
        part = 'played';
        const loadOk = await E.session.load('cr-old'), afterLoad = part;
        // newGame during a fading skip: the skip resolves null, time does not jump, nothing stays frozen
        const t0 = E.clock.now, sk = E.skip({ seconds: 600, fade: 0.2 }), ng = E.session.newGame();
        for (let i = 0; i < 40; i++) { E.step(0.05); await new Promise(res => setTimeout(res, 0)); }
        const skipped = await sk; await ng;
        const fadeCase = { skipped, jumped: E.clock.now - t0 > 500, frozen: E.frozen };
        // a timer starts a new game in the middle of a skip without fade: the skip stops there
        E.clock.after(10, () => { E.session.newGame(); });
        const quick = await E.skip({ seconds: 600 });
        await new Promise(res => setTimeout(res, 20));
        const timerCase = { quick, now: E.clock.now, frozen: E.frozen };
        E.dispose();
        return { atTitle, duringTitle, duringPlay, afterRemove, badMinutes, loadOk, afterLoad, fadeCase, timerCase };
      });
      check('autosave writes nothing while the title screen is up', r.atTitle === false && r.duringTitle === 0, JSON.stringify(r));
      check('autosave writes during play, and stops after remove(); a bad interval throws save-autosave', r.duringPlay >= 1 && r.afterRemove === r.duringPlay && r.badMinutes === 'save-autosave', JSON.stringify(r));
      check('session.load: a part missing from the save gets its new-game state', r.loadOk === true && r.afterLoad === 'new', JSON.stringify(r));
      check('newGame during a fading skip: the skip resolves null, time does not jump, nothing stays frozen', r.fadeCase.skipped === null && !r.fadeCase.jumped && !r.fadeCase.frozen, JSON.stringify(r));
      check('a timer that starts a new game mid-skip stops the skip there', r.timerCase.quick === null && r.timerCase.now < 600 && !r.timerCase.frozen, JSON.stringify(r));
    },
  },
  {
    name: 'Core review: threads -- a crashed worker rejects tasks that transferred buffers and reruns the others; pure functions refuse main-thread-only globals',
    url: PAGE,
    expectErrors: /boom|worker failed/,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = engine.threads;
        const src = "self.onmessage = e => { if (e.data.id) setTimeout(() => { throw new Error('boom'); }, 10); };";
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        const L = T.lane({ create: () => new Worker(url), local: () => m => m.x * 2 });
        const buf = new Float32Array(4);
        const moved = L.run({ x: 1, buf }, [buf.buffer]).then(v => ({ value: v }), e => ({ code: e.code }));
        const copied = L.run({ x: 21 }).then(v => ({ value: v }), e => ({ code: e.code }));
        const wait = p => Promise.race([p, new Promise(res => setTimeout(() => res('timeout'), 8000))]);
        const out = { size: T.size, moved: await wait(moved), copied: await wait(copied) };
        const refuse = fn => { try { T.pure(fn, 'cr'); return null; } catch (e) { return e.code; } };
        out.engineName = refuse(rec => { rec.x = engine.time.tick; });
        out.documentName = refuse(rec => { rec.t = document.title; });
        out.mathOk = refuse(rec => { rec.x = Math.max(rec.a, 1) + Number.parseFloat('2'); });
        out.numbersOk = refuse(rec => { rec.x = rec.a > 1e9 ? 0xff : 2.5e-3; });   // 'e9' and 'xff' are parts of numbers, not outer variables
        L.dispose();
        return out;
      });
      check('the task that transferred its buffer rejects with threads-transfer', r.size === 0 || r.moved.code === 'threads-transfer', JSON.stringify(r));
      check('the task without transfer is answered on the main thread', r.size === 0 || r.copied.value === 42, JSON.stringify(r));
      check('a pure function reading engine or document is refused (pure-function); Math / Number are fine', r.engineName === 'pure-function' && r.documentName === 'pure-function' && r.mathOk === null && r.numbersOk === null, JSON.stringify(r));
    },
  },
  {
    name: 'Core review: core guards -- clock.every(0), asset name clash, late use() init, dispose during start, repeated start, animator removal, teleport timeout, pad release, coded errors',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine } = threedogThreads;
        const make = key => createEngine({ canvas: document.createElement('canvas'), headless: true, urlState: false, saveKey: key });
        const code = fn => { try { fn(); return null; } catch (e) { return e.code ?? e.message; } };
        const out = {};
        const D = make('cr-dispose'), started = D.start(); D.dispose();
        out.disposed = await started.then(() => 'resolved', e => e.code);
        // what start() awaits can stay pending for good after dispose (a model by rule, a game's init): start() must answer all the same, and at once
        const answer = p => Promise.race([p.then(() => 'resolved', e => e.code), new Promise(res => setTimeout(() => res('pending'), 500))]);
        const late = await (async () => {
          const during = fn => { const G = make('cr-gone'); fn(G); const p = G.start(); return new Promise(res => setTimeout(() => { G.dispose(); res(answer(p)); }, 50)); };
          const init = await during(G => G.use({ name: 'crStuck', type: 'rules', label: 'stuck', init: () => new Promise(() => {}) }));
          const model = await during(G => { G.assets.manifest({ models: { crHeld: { build: () => new Promise(() => {}), cache: false } } }); G.use({ name: 'crHeld', type: 'rules', label: 'held', init: e => e.assets.model('crHeld') }); });
          const preload = await during(G => G.assets.manifest({ models: { crPre: { build: () => new Promise(() => {}), preload: true, cache: false } } }));
          const N = make('cr-never'); N.dispose();
          const R = make('cr-ran'); await R.start(); const src = R.stream.player.whenReady; R.dispose();
          return { init, model, preload, never: await answer(N.start()), ran: await answer(R.start()), builtIn: await answer(src), source: await answer(R.stream.source([0, 0, 0]).whenReady), teleport: await answer(R.stream.teleport([0, 0, 0])), nextFixed: await answer(R.nextFixed(() => 1)), job: await answer(R.jobs.add(() => 1)) };
        })();
        out.late = late;
        const E = make('cr-core');
        out.sameStart = E.start() === E.start();
        await E.start();
        out.every0 = code(() => E.clock.every(0, () => {}));
        out.everyNaN = code(() => E.clock.every(NaN, () => {}));
        out.afterNaN = code(() => E.clock.after(NaN, 'x:y'));
        out.clash = code(() => E.assets.manifest({ models: { grass: '/m/grass.glb' }, textures: { grass: '/t/grass.png' } }));
        let inited = 0;
        E.use({ name: 'crLate', type: 'rules', label: 'late', init: () => { inited++; } });
        await new Promise(res => setTimeout(res, 0));
        out.lateInit = inited;
        const THREE = __threedogThree, g = new THREE.Group();
        g.animations = [new THREE.AnimationClip('idle', 1, [])];   // a model with a clip (one without clips gets no per-frame hook)
        E.add(g);
        const f0 = E.counts().frame;
        E.assets.animate(g, {});
        const f1 = E.counts().frame;
        E.remove(g);
        out.animator = { f0, f1, f2: E.counts().frame };
        const never = E.stream.addReadyCheck('cr-never', s => s.name !== 'teleport');
        const tp = E.stream.teleport([30, 0, 30], { timeout: 0.5 }).then(() => 'moved', e => ({ code: e.code, names: /cr-never/.test(e.message) }));
        for (let i = 0; i < 20; i++) E.step(0.1);
        out.teleport = await tp;
        never.remove();
        const height = E.ground.height; E.ground.height = () => -Infinity;   // off a shaped terrain's outline
        const off = E.stream.teleport([31, 0, 31]);
        for (let i = 0; i < 5; i++) E.step(0.1);
        await off; E.ground.height = height; out.offGroundY = E.focus.y;
        out.badRadius = [Infinity, NaN].map(v => { try { E.stream.radius = v; return null; } catch (e) { return e.code; } });
        const src = E.stream.source([0, 0, 0]), gone = src.whenReady.then(() => 'ready', e => e.code); src.remove();
        out.removed = await gone;
        E.input._keyDown('PadRT', 'pad'); E.input._padOn = true; E.input.poll(1 / 60);
        out.padHeld = E.input.keys.has('PadRT');
        const quiet = console.error; console.error = () => {};
        E.clock.after(0.01, () => { E.clock.every(0, () => {}); });
        E.step(0.1);
        console.error = quiet;
        out.error = E.error && { code: E.error.code, fix: !!E.error.fix, docs: E.error.docs.length, where: E.error.where };
        E.error = null; E.stacks.get('freeze').release('error');
        const text = E.describeText().split('\n');
        out.text = { lines: text.length, last: text.at(-1), path: E.describeText({ path: 'time' }).split('\n')[0], full: E.describeText({ full: true }).includes('More:') };
        E.i18n.setLocale('auto'); out.locale = E.i18n.locale;
        E.dispose();
        return out;
      });
      check('dispose during start: start() rejects with engine-disposed; a second start() returns the first Promise', r.disposed === 'engine-disposed' && r.sameStart === true, JSON.stringify(r));
      check('[guard] dispose answers start() at once with engine-disposed, whatever it awaits; a start() after dispose rejects the same way, also on an engine that had finished starting', ['init', 'model', 'preload', 'never', 'ran'].every(k => r.late[k] === 'engine-disposed'), JSON.stringify(r.late));
      check('[guard] after dispose a stream source answers stream-removed instead of waiting for a frame, built-in ones and teleport too', ['builtIn', 'source', 'teleport'].every(k => r.late[k] === 'stream-removed'), JSON.stringify(r.late));
      check('after dispose a wait in game code stays pending by rule (nextFixed, jobs.add): the code after it belongs to a dead engine', r.late.nextFixed === 'pending' && r.late.job === 'pending', JSON.stringify(r.late));
      check('clock.every(0 / NaN) and after(NaN) throw clock-interval', r.every0 === 'clock-interval' && r.everyNaN === 'clock-interval' && r.afterNaN === 'clock-interval', JSON.stringify(r));
      check('one name as a model and a texture throws asset-name-clash', r.clash === 'asset-name-clash', JSON.stringify(r));
      check('a module installed after start() has its init run', r.lateInit === 1, JSON.stringify(r));
      check('engine.remove of an animated model stops its animator (counts().frame back)', r.animator.f1 === r.animator.f0 + 1 && r.animator.f2 === r.animator.f0, JSON.stringify(r.animator));
      check('teleport off the ground leaves engine.focus finite; a radius that would hang or build nothing is refused', Number.isFinite(r.offGroundY) && r.badRadius.every(c => c === 'stream-option'), JSON.stringify([r.offGroundY, r.badRadius]));
      check('teleport timeout rejects with stream-timeout naming the waiting loader; a removed source rejects whenReady', r.teleport?.code === 'stream-timeout' && r.teleport.names && r.removed === 'stream-removed', JSON.stringify(r));
      check('a gamepad that disconnects releases its buttons', r.padHeld === false, JSON.stringify(r));
      check('a clock timer error goes through the error tiers with a code, fix and docs', r.error?.code === 'clock-interval' && r.error.fix && r.error.docs > 0 && /clock timer/.test(r.error.where), JSON.stringify(r.error));
      check('describeText: a summary within 30 lines ending with how to expand; path and full modes', r.text.lines <= 30 && /^More:/.test(r.text.last) && /^time: /.test(r.text.path) && !r.text.full, JSON.stringify(r.text));
      check("i18n.setLocale('auto') resolves to a real locale", r.locale === 'en' || r.locale === 'zh-CN', r.locale);
    },
  },
  {
    name: 'Core review: save format -- quest progress by stable step ids with a migration from positions; world owes time only for far kinds and keys records by id',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine, quests, world } = threedogThreads;
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, urlState: false, saveKey: 'cr-format' });
        E.use(world({ farEvery: 0.05 }), quests({ notify: false }));
        let doneA = false;
        const step = (id, done = () => false) => ({ id, text: id, done });
        E.quests.define('q', { title: 'Q', steps: [step('a', () => doneA), step('b'), step('c')] });
        await E.start();
        const W = E.world, quiet = console.warn; console.warn = () => {};
        E.ops.allow(() => {
          E.quests.start('q');
          W.simulate('crop', { far: (rec, dt) => { rec.g = (rec.g ?? 0) + dt; } });
          for (let i = 0; i < 30; i++) W.add({ id: 'prop' + i, kind: 'crprop', position: [i, 0, 0] });
          for (let i = 0; i < 3; i++) W.add({ id: 'crop' + i, kind: 'crop', position: [500 + i, 0, 500] });
        });
        W.anchor = { x: -900, z: -900 };
        doneA = true; E.step(1.5);
        const saved = E.saves.collect(), qs = saved.parts.quests.state.q, w = saved.parts.world;
        // content inserts a step before b: progress stays on b
        E.quests.define('q', { title: 'Q', steps: [step('a', () => true), step('new'), step('b'), step('c')] });
        await E.saves.apply(saved);
        const afterInsert = E.quests.state('q').step;
        // an old (version 1) save stored the position 2: migrated through the current definition
        const v1 = { ...saved, versions: { ...saved.versions, quests: 1 }, parts: { ...saved.parts, quests: { state: { q: { step: 2, done: false } } } } };
        const v1ok = await E.saves.apply(v1);
        const migratedStep = E.quests.state('q').step, migratedId = E.saves.collect().parts.quests.state.q.step;
        // a step id the definition lost: restarts the quest
        const lost = { ...saved, parts: { ...saved.parts, quests: { state: { q: { step: 'gone', done: false } } } } };
        await E.saves.apply(lost);
        const lostStep = E.quests.state('q').step;
        // old world format (records as an array) still loads
        const oldWorld = { ...saved, versions: { ...saved.versions, world: 1 }, parts: { ...saved.parts, world: { ...w, records: Object.entries(w.records).map(([id, rec]) => ({ id, ...rec })) } } };
        const oldOk = await E.saves.apply(oldWorld);
        console.warn = quiet;
        const out = { qs, qVersion: saved.versions.quests, wVersion: saved.versions.world, owed: Object.keys(w.owed), recordsIsObject: !Array.isArray(w.records),
          afterInsert, v1ok, migratedStep, migratedId, lostStep, oldOk, propsBack: W.query({ kind: 'crprop' }).length };
        E.dispose();
        return out;
      });
      check('quest progress is saved by step id (version 3)', r.qs?.step === 'b' && r.qVersion === 3, JSON.stringify(r));
      check('a step inserted before the saved one: progress stays on the same step', r.afterInsert === 2, JSON.stringify(r));
      check('a version-1 save (positions) migrates to ids through the definition', r.v1ok === true && r.migratedStep === 2 && r.migratedId === 'b', JSON.stringify(r));
      check('a saved step id the quest no longer has restarts the quest', r.lostStep === 0, JSON.stringify(r));
      check('world: owed is written only for kinds simulated with far; records are keyed by id (version 5)', r.owed.length > 0 && r.owed.every(id => id.startsWith('crop')) && r.recordsIsObject && r.wVersion === 5, JSON.stringify(r));
      check('a version-1 world save (records as an array) still loads', r.oldOk === true && r.propsBack === 30, JSON.stringify(r));
    },
  },
  {
    // the game's dispose may free what the scene walk never sees (a lease, a body, a pooled buffer): a build that lands after engine.dispose was dropped without it
    name: 'stream: a build that lands after engine.dispose goes to the entry\'s own dispose, once, and counts nothing',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine, THREE } = threedogThreads;
        const E = createEngine({ canvas: document.createElement('canvas'), headless: true, urlState: false, saveKey: 'fr-stream-late' });
        await E.start();
        let land; const late = new Promise(res => { land = res; }), freed = [];
        const obj = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
        E.stream.add({ position: [0, 0, 0], radius: 6, build: () => late, dispose: o => freed.push(o) });
        E.step(0.1, { describe: false }); await new Promise(res => setTimeout(res, 0));
        const started = E.stream.queued;
        E.dispose();
        land(obj); await new Promise(res => setTimeout(res, 20));
        return { started, freed: freed.length, same: freed[0] === obj, queued: E.stream.queued, attached: !!obj.parent };
      });
      const J = JSON.stringify(r);
      check('the build was in flight when the engine went', r.started === 1, J);
      check('it reaches the entry\'s dispose exactly once, never the scene', r.freed === 1 && r.same && !r.attached, J);
      check('nothing is counted down after dispose zeroed the queue', r.queued === 0, J);
    },
  },
];
