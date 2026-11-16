// The post effect handle (render/PostFX.js) and the moved sky options. Water: water-material.mjs. Weather: living-picture.mjs.
// Same format as the other files here.

const MAKE = `
  const { createEngine, water, weather, terrain, sky } = threedogTest;
  const make = mods => { const e = createEngine({ canvas: document.createElement('canvas'), headless: true, ui: { loading: false }, saveKey: 'picture-wp' }); e.use(...mods); return e; };
  const err = f => { try { f(); return ''; } catch (x) { return x.message; } };
`;
const page = fn => new Function(`${MAKE}\nreturn (${fn})();`);

export const specs = [
  {
    name: '[guard] one entry per picture value: sky keeps its start values as options; start values are live',
    url: '/tests/perf/index.html?mode=world',
    async run({ check, ev }) {
      const r = await ev(page(() => {
        const out = {};
        out.kept = [err(() => sky({ time: '12:00', dim: { stars: false } }))];
        // sky: start values land on the dome; engine.uniforms, plain fields and keyframes() are live
        const s = make([sky({ dim: { stars: false } })]), U = s.sky.uniforms, EU = s.uniforms;
        s.sky.update(s.focus);
        out.s0 = [EU.uMoonSize.value, U.uMoonSize === EU.uMoonSize, U.uStarCloudDim.value];
        EU.uMoonSize.value = 500; EU.uSkyCurve.value = 0.3; s.sky.orbit.tilt = 0.1; s.sky.dim.stars = true; s.sky.update(s.focus);
        out.s1 = [U.uMoonSize.value, U.uSkyCurve.value, U.uStarCloudDim.value];
        out.sBad = err(() => s.sky.keyframes([[0.5, 0, 0, 0, 1, 1]]));
        // keyframes() reads the rows back (a picture keeps them to give back on leaving); a copy, so editing it changes nothing
        const rows = [[0, 0x101828, 0x202838, 0x8090b0, 0.3], [0.5, 0x4080c0, 0xc0d8e8, 0xffffff, 1.2], [1, 0x101828, 0x202838, 0x8090b0, 0.3]];
        const before = s.sky.keyframes(); s.sky.keyframes(rows); const got = s.sky.keyframes(); got[1][1] = 0;
        out.kfRead = [Array.isArray(before) && before.length > 1, JSON.stringify(s.sky.keyframes()) === JSON.stringify(rows)];
        s.sky.keyframes(before); out.kfRead.push(JSON.stringify(s.sky.keyframes()) === JSON.stringify(before));
        s.dispose();
        return out;
      }));
      check('structural options stay (sky time and start values)', r.kept.join('') === '', JSON.stringify(r.kept));
      check('sky: start values are on the dome through engine.uniforms; .value and plain fields move it; bad keyframes throw', r.s0.join() === '1400,true,0'
        && r.s1.join() === '500,0.3,1' && /keyframes/.test(r.sBad), JSON.stringify([r.s0, r.s1, r.sBad]));
      check('sky.keyframes() with no argument returns the rows in use, as a copy; giving the old rows back restores them', r.kfRead.every(Boolean), JSON.stringify(r.kfRead));
    },
  },
  {
    name: 'post handle: add / get / set / enabled / remove; describe().render.post reads the chain',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(() => {
        const { vignette } = threedogTest.postEffects, p = engine.post, out = {};
        const err = f => { try { f(); return ''; } catch (x) { return x.message; } };
        const rp = n => engine.describe().render.post.find(x => x.name === n);
        p.antialias = false;
        const names = p.list().map(x => x.name);
        const h = p.add(vignette({ enabled: true, strength: 0.5 }));
        out.add = [rp('vignette').writer, rp('vignette').params.strength, rp('vignette').point];
        h.set({ strength: 0.9 });
        out.set = [h.params.strength, rp('vignette').params.strength, h.enabled];
        out.badParam = err(() => h.set({ nothing: 1 }));
        out.enabledKey = err(() => h.set({ enabled: false }));
        out.badEnabled = err(() => { h.enabled = 'off'; });
        // a pixel snippet is an effect with a fuse, added like every other one
        const tint = p.add({ name: 'tint', fuse: { glsl: 'color.rgb *= vec3(1.0, 0.9, 0.8);' }, slot: 'ldr', order: 5 });
        out.patch = [p.get('tint')?.slot, rp('tint').on];
        out.taken = err(() => p.add({ name: 'vignette', fuse: { glsl: 'color.rgb *= 0.5;' } }));
        tint.enabled = false; out.tintOff = [p.get('tint').enabled, rp('tint').on, rp('tint').writer];
        tint.remove(); tint.remove(); out.gone = !p.get('tint');
        tint.enabled = true;   // a stale handle reaches nothing
        const again = p.add({ name: 'tint', fuse: { glsl: '' }, slot: 'ldr' });
        out.fresh = [again.enabled, rp('tint').writer]; again.remove(); h.remove();
        out.restored = p.list().map(x => x.name).join() === names.join();
        p.render(0.016);
        return out;
      });
      const j = JSON.stringify(r);
      check('describe().render.post shows the effect, its point and its params', r.add.join() === 'default,0.5,post.vignette.enabled', j);
      check('set() changes the params; unknown names and a non-boolean enabled throw', r.set.join() === '0.9,0.9,true' && r.badParam.includes('unknown: nothing') && r.enabledKey.includes('handle.enabled') && r.badEnabled.includes('true or false'), j);
      check('a fuse effect sits in its slot; a taken name throws', r.patch.join() === 'ldr,true' && r.taken.includes('already added'), j);
      check('enabled = false shows in describe with writer game; remove() takes it out, twice is fine', r.tintOff.join() === 'false,false,game' && r.gone, j);
      check('a stale handle changes nothing: a new effect of that name starts on, nobody writing it', r.fresh.join() === 'true,default' && r.restored, j);
    },
  },
];
