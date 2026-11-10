// [guard] One way to add a post effect (docs/plans/done/2026-11-03-one-post-entry.md). engine.post.add takes a plain three.js Pass, a node
// function or an effect { name, create, node, fuse }; game code, the plugins folder and a style pack's plugins all go through it, so every
// effect has a name and on / off through its handle. Why a guard: before, there were five entries (engine.post.addPass,
// add, patch, postAdd, plugins) with different on / off rules, a plugin could not hold an effect for both
// renderers, a library factory in plugins/ became a WebGPU post pass, and a pass that draws the scene was stacked after the engine's scene
// render (the scene drawn twice a frame). If a second entry comes back or any of these regresses, this fails.
// Page: perf city (WebGL); the WebGPU half runs on the post-webgpu page. Same format as the other files here.

export const specs = [
  {
    name: '[guard] one post entry (WebGL): Pass, effect and plugin effects all switch through their handle; a scene-drawing pass replaces the scene render; function plugins and the old entries fail clearly',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(async () => {
        await engine.loading.settled();
        engine.haltLoop();
        const { ShaderPass, CopyShader, postEffects: E } = window.threedogTest, out = {}, err = f => { try { f(); return ''; } catch (e) { return e.message; } };
        const names = () => engine.post.list().map(e => `${e.name}:${e.slot}:${e.enabled}`);
        // 1. one verb for each shape; each is switched through its handle
        const copy = new ShaderPass(CopyShader), hp = engine.post.add(copy, { name: 'myCopy' });
        const hv = engine.post.add(E.vignette({ strength: 0.5 }));
        engine.step(0.05);
        hp.enabled = false; engine.post.get('vignette').enabled = false; engine.step(0.05);
        out.set = { names: names(), inChain: engine.post.object().passes.includes(copy) };
        hp.remove(); hv.remove(); engine.step(0.05);
        // 2. a plugin file (game folder) exporting an effect description: the same verb, its own name, set switches it, off() removes it
        engine.plugins.add({ './plugins/50-grain.js': { default: E.grain({ animated: false }) } });
        engine.step(0.05);
        out.plugin = { on: names().filter(n => n.startsWith('grain')), slot: engine.describe().slots.find(s => s.file === 'plugins/50-grain.js')?.affects.join() };
        engine.post.get('grain').enabled = false;
        out.plugin.setOff = engine.post.get('grain')?.enabled;
        engine.plugins.off('50-grain');
        out.plugin.gone = !engine.post.get('grain');
        // 3. a function export is not a plugin on either renderer (a library factory): plugin-shape, nothing plugged
        out.fnPlugin = err(() => engine.plugins.add({ './plugins/60-sparks.js': { sparks: () => ({}) } }));
        // 4. a pass that draws engine.scene itself goes in the scene slot: the scene is drawn once a frame, not twice
        const Pass = Object.getPrototypeOf(ShaderPass);
        class PixelScene extends Pass {
          constructor(scene, camera) { super(); this.scene = scene; this.camera = camera; }
          render(renderer, writeBuffer) { renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer); renderer.clear(); renderer.render(this.scene, this.camera); }
        }
        const pix = new PixelScene(engine.scene, engine.camera), hs = engine.post.add(pix);
        engine.step(0.05);
        const R = engine.renderer, real = R.render; let draws = 0;
        R.render = function (s, c) { if (s === engine.scene) draws++; return real.call(this, s, c); };
        engine.step(0.05);
        R.render = real;
        out.scene = { slot: engine.post.get(hs.name)?.slot, draws, second: err(() => engine.post.add(new PixelScene(engine.scene, engine.camera))) };
        hs.remove(); engine.step(0.05);
        // 5. the old entries are gone (one way in)
        out.old = { addPass: typeof engine.post.addPass, insertPass: typeof engine.post.insertPass, removePass: typeof engine.post.removePass };
        return out;
      });
      console.log('  one post entry:', JSON.stringify(r));
      check('the handle switches a plain Pass (by its given name) and an effect (by its own name) the same way',
        r.set.names.includes('myCopy:hdr:false') && r.set.names.includes('vignette:ldr:false') && !r.set.inChain, JSON.stringify(r.set));
      check('a plugin file exporting an effect description plugs through engine.post.add under the effect name; its handle switches it; off() removes it',
        r.plugin.on.join() === 'grain:ldr:true' && /post chain/.test(r.plugin.slot ?? '') && r.plugin.setOff === false && r.plugin.gone, JSON.stringify(r.plugin));
      check('a function export is a plugin-shape error that says to export the result or { name, node }', r.fnPlugin.includes('[plugin-shape]') && r.fnPlugin.includes('{ name:') && r.fnPlugin.includes('sparks'), r.fnPlugin);
      check('a pass that draws engine.scene goes in the scene slot and the scene is drawn once per frame', r.scene.slot === 'scene' && r.scene.draws === 1, JSON.stringify(r.scene));
      check('a second scene-drawing pass is refused by name (the scene slot holds one)', r.scene.second.includes("slot 'scene' already holds"), r.scene.second);
      check('engine.post.addPass / insertPass / removePass are gone',
        r.old.addPass === 'undefined' && r.old.insertPass === 'undefined' && r.old.removePass === 'undefined', JSON.stringify(r.old));
    },
  },
  {
    // the fuse is the reason add() goes through the engine at all: if a rewrite of the entry stops grouping, every light effect costs a full-screen pass again
    name: '[guard] engine.post.add: a fuse effect and its neighbor share one full-screen pass; a wrong shape adds nothing; engine.post.own() holds the chain; a settings restriction sits above the handle',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(() => {
        const p = engine.post, out = {}, err = f => { try { f(); return ''; } catch (e) { return e.message; } };
        engine.haltLoop();
        const before = p.list().length;
        const a = p.add({ name: 'gateA', slot: 'ldr', params: { k: 0.5 }, fuse: { uniforms: { uGateA: 'float' }, values: q => ({ uGateA: q.k }), glsl: 'color.rgb *= uGateA + 0.0 * fxHash(vUv * uResolution);' } });
        const b = p.add({ name: 'gateB', slot: 'ldr', fuse: { glsl: 'color.rgb *= 0.9;' } });
        p.render(0.016);
        const fused = () => p.composer.passes.filter(x => x.items);
        out.fused = fused().map(x => x.items.map(i => i.name).join('+'));
        out.source = fused()[0]?.material.fragmentShader ?? '';
        a.set({ k: 0.25 }); out.uniform = fused()[0].material.uniforms.uGateA.value;
        out.same = p.get('gateA') === a;
        // the rollback: nothing of a wrong shape, a bad option or a failing create stays
        const n = p.list().length;
        out.wrong = [err(() => p.add({})), err(() => p.add(a, { owner: 'x' })), err(() => p.add({ name: 'bad', create: () => { throw new Error('no'); } }))];
        out.rolled = p.list().length === n && !p.get('bad');
        // the settings layer of post.<name>.enabled is above the handle's game layer
        const point = engine.stacks.get('post.gateB.enabled');
        const hold = engine.mod('post.gateB.enabled', { owner: 'menu', layer: 'settings', set: false });
        out.held = b.enabled; b.enabled = true; out.stillHeld = b.enabled; hold.remove(); out.released = b.enabled;
        out.gameEntry = point.holders().map(h => `${h.owner}:${h.layer}`).join();
        // own(): the built chain stays through a chain change; own(false) rebuilds
        p.own(); const owned = p.composer.passes.length; b.enabled = false; out.kept = p.composer.passes.filter(x => x.items)[0].items.length === 2 && p.composer.passes.length === owned;
        out.writer = engine._owned.get('post.chain').info().writer;
        p.own(false); out.back = fused()[0].items.length;
        a.remove(); b.remove(); a.remove();
        out.clean = p.list().length === before;
        return out;
      });
      const j = JSON.stringify({ ...r, source: undefined });
      check('two fuse effects added with add() share one full-screen pass', r.fused.join() === 'gateA+gateB', j);
      check('the shared pass carries fxHash and uResolution; set() writes the uniform in place', r.source.includes('#define fxHash threedogHash') && r.source.includes('uniform vec2 uResolution') && Math.abs(r.uniform - 0.25) < 1e-6, j);
      check('add() and get() give the same handle', r.same, j);
      check('a wrong shape, an unknown option and a failing create throw and add nothing', r.wrong.every(Boolean) && r.wrong[0].includes('[post-effect]') && r.wrong[1].includes('owner') && r.rolled, j);
      check("a settings restriction holds the effect off over the handle's enabled = true, and ending it shows the game's choice", r.held === false && r.stillHeld === false && r.released === true && r.gameEntry === 'game:game', j);
      check('own() keeps the built chain through a change, writer manual:game; own(false) rebuilds from the list', r.kept && r.writer === 'manual:game' && r.back === 1, j);
      check('remove() twice is fine and leaves the chain as it was', r.clean, j);
    },
  },
  {
    name: '[guard] one post entry, post on WebGPU: node function and { create, node } effect through engine.post.add; remove() frees the nodes the engine built',
    url: '/tests/post-webgpu/index.html',
    software: true,
    async run({ check, ev }) {
      const r = await ev(() => window.postAddPass());
      console.log('  one post entry webgpu:', JSON.stringify({ leak: r.leak, both: r.both }));
      check('WebGPU: remove() of a node effect using ctx.display.bloom disposes its nodes (no leaked mip targets)', r.leak.built && r.leak.freed === 1 && r.leak.gone, JSON.stringify(r.leak));
      for (const k of ['gl', 'gpu'])
        check(`${k}: one { name, create, node } effect darkens the picture, and handle.enabled = false gives it back`,
          r.both[k].on < r.both[k].base * 0.5 && Math.abs(r.both[k].off - r.both[k].base) < 1.5, JSON.stringify(r.both[k]));
    },
  },
];
