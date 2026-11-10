// Cascaded shadows on WebGPURenderer (docs/plans/2026-11-03-webgpu-phase2.md section 7 step 6, user decision 4). A guard: on the WebGPU
// route engine.shadows.cascades(sun) is three's CSMShadowNode on the sun (render/cascades.tsl.js), so a game's MeshStandardMaterial
// and its NodeMaterial are each lit once (ground as bright as with one shadow map), no material is patched or listed in describe().owned,
// the cascades really cast (E2 drew none: the cascade shadow cameras kept the sky's far), include() is a no-op with a hint, budget
// reaches the cascades' own switches, and switching off restores the plain sun shadow. The WebGL side stays tests/specs/cascades.mjs.
export const specs = [
  {
    name: '[guard] cascaded shadows on WebGPU: CSMShadowNode on the sun, every material lit once, nothing patched or owned, shadows drawn, off restores',
    url: '/tests/cascades-webgpu/index.html',
    software: true,   // reads rendered pixels: same numbers on every machine
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const r = await ev(() => window.cascadesWebGPU());
      console.log('  cascades webgpu numbers:', JSON.stringify(r));
      check('cascades 3 is one CSMShadowNode on engine.lights.sun with 3 cascades; the scene has one DirectionalLight (no extra lights to light anything twice)',
        r.csm.node && r.csm.onSun && r.csm.cascades === 3 && r.csm.dirLights === 1, JSON.stringify(r.csm));
      check(`the budget counts the caster once per cascade map: shadow draws ${r.budget.one - 1} -> ${r.budget.three - 1} (cascades 1 -> 3, x3)`,
        r.budget.one > 1 && r.budget.three - 1 === 3 * (r.budget.one - 1), JSON.stringify(r.budget));
      check('engine.shadows.mapSize (photo mode) resizes every cascade map, drawn at the new size, and back',
        r.mapSize.cascades.every(s => s === 1024) && r.mapSize.sun === 1024 && r.mapSize.drawn.every(w => w === 1024) && r.mapSize.back.every(s => s === r.mapSize.size0), JSON.stringify(r.mapSize));
      check('light.shadow.intensity reaches every cascade', r.shadowIntensity.length === 3 && r.shadowIntensity.every(s => s === 0.3), JSON.stringify(r.shadowIntensity));
      check('the cascade shadow cameras reach lightMargin + 2 x maxFar (100 + 240 m), so the far cascades reach the ground',
        r.csm.far === 340 && r.csm.cascadeFar?.every(f => f === 340), JSON.stringify(r.csm));
      check(`the brightness measure can tell "lit twice": a second sun-like light takes the same spots ${r.one.std} / ${r.one.node} -> ${r.twice.std} / ${r.twice.node}`,
        r.twice.std > r.one.std * 1.2 && r.twice.node > r.one.node * 1.2, JSON.stringify(r.twice));
      check(`a game MeshStandardMaterial is lit once: lit ground ${r.one.std} -> ${r.three.std} (cascades 1 -> 3, < 2%)`,
        Math.abs(r.ratio.std) < 0.02 && r.one.std > 20, JSON.stringify(r.ratio));
      check(`a game MeshStandardNodeMaterial is lit once: lit ground ${r.one.node} -> ${r.three.node} (cascades 1 -> 3, < 2%)`,
        Math.abs(r.ratio.node) < 0.02 && r.one.node > 20, JSON.stringify(r.ratio));
      check(`the cascades cast: the box casting or not changes ${r.shadow.changed}% of the picture (> 0.5%)`, r.shadow.changed > 0.5, JSON.stringify(r.shadow));
      check('no material is patched (no csm patch) and describe().owned has no csm row', r.patches.std === '' && r.patches.node === '' && r.patches.box === '' && r.owned.length === 0,
        JSON.stringify({ patches: r.patches, owned: r.owned }));
      check('engine.shadows.include(mat) does nothing on WebGPU and says so once', r.include.same && r.include.warned, JSON.stringify(r.include));
      check('budget every 3 turns off autoUpdate on every cascade shadow (per-light switch on WebGPU, render/backend.js)',
        r.every.auto.length === 3 && r.every.auto.every(a => a === false) && r.every.sunAuto === false, JSON.stringify(r.every));
      check('three frames with cascades and budget every 3 walk the scene 0 times (shadow lights are tracked on add / remove, not found by traverse)',
        r.every.walks === 0, JSON.stringify(r.every));
      check('cascades removed: no node on the sun, stand-in lights out of the scene, the sky shadow box back, the same picture as before',
        r.off.csm === null && r.off.node && r.off.gone && r.off.far === 250 && r.off.sameAsOne < 0.5, JSON.stringify(r.off));
    },
  },
];
