// Real-time light: the guards for @threedog/post-effects/tsl. Ordinary runs land on WebGPURenderer's WebGL2 backend, where voxel GI cannot run: there the check is that it
// says so. `node packages/tools/real-webgpu.mjs light-webgpu` runs the same specs on real WebGPU, where light must actually bounce.
export const specs = [
  {
    name: '[guard] voxel GI: a red wall tints its white neighbor on WebGPU, switching off removes the cost, low tier and the WebGL2 backend hold it off and say so',
    url: '/tests/light-webgpu/index.html',
    software: true,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const r = await ev(() => window.lightGI());
      console.log('  voxel GI numbers:', JSON.stringify(r));
      check('describe() says temporalAA stands in for MSAA, and the real samples without it', r.antialias.samples === 0 && r.antialias.replacedBy === 'temporalAA' && r.aaText && r.msaa.samples === 4 && r.msaaText, JSON.stringify([r.antialias, r.msaa]));
      if (r.backend !== 'webgpu') {
        check(`on the ${r.backend} backend it is held off, not silently dropped: describe() names why`, r.row.on === false && /forceWebGL/.test(r.row.held), JSON.stringify(r.row));
        check('nothing was built and the chain does not hold it', !r.built && !r.buffersWithoutGI);
        return;
      }
      const tint = c => c.r - c.g;
      check(`light bounces: red minus green on the white wall ${tint(r.plain)} -> ${tint(r.bounced)}`, tint(r.bounced) > tint(r.plain) + 4, JSON.stringify([r.plain, r.bounced]));
      check('the normal and diffuse buffers come from one merged scene render, with velocity for temporalAA', ['normal', 'diffuse', 'velocity'].every(b => r.buffersOn.includes(b)), JSON.stringify(r.buffersOn));
      check('describe() reports the voxel size, and nothing once the chain let it go', r.row.facts?.voxelSize > 0 && r.off.facts === null, JSON.stringify([r.row, r.off.facts]));
      // 不许绕开: voxelGI and occlusion together, what culling hides stays in the bounce
      check(`a wall occlusion culling hides still bounces: red minus green ${tint(r.plain)} -> ${tint(r.hiddenBounce)}`, tint(r.hiddenBounce) > tint(r.plain) + 4, JSON.stringify(r.hiddenBounce));
      check('low tier: held, out of the chain, and describe() says why', !r.lowTier.on && !r.lowTier.order && /low/.test(r.lowTier.held), JSON.stringify(r.lowTier));
      check(`off removes it: not in the chain, no extra scene outputs, ${r.costOn} ms -> ${r.off.cost} ms (base ${r.base} ms)`,
        !r.off.order.includes('voxelGI') && !r.off.mrt && r.off.cost < Math.max(r.base * 1.5, r.base + 0.5), JSON.stringify(r.off));
    },
  },
  {
    // 不许绕开: every reason an effect is held, without a GPU, so no run can skip them
    name: '[guard] voxel GI held: a fake effect through low tier, WebGL2 backend, the swap to WebGLRenderer, a game that chose WebGL, forceWebGL',
    url: '/tests/light-webgpu/index.html',
    software: true,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const r = await ev(() => window.lightHeld()), c = r.cases;
      check('real WebGPU on a good tier: nothing held', c.runs === null, JSON.stringify(c));
      check('low tier: follows the declaration and names it', /tier is 'low'.*skipOnLowTier/.test(c.low), c.low);
      check('the game has it off: not held, whatever the tier', c.lowOff === null, c.lowOff);
      check('the device has no WebGPU: says so', /this device has none/.test(c.webgl2), c.webgl2);
      check('swapped to WebGLRenderer: the device, not the game', /fell back to WebGLRenderer/.test(c.swapped), c.swapped);
      check('forceWebGL: the game, not the device', /game chose WebGL2 \(forceWebGL/.test(c.forced), c.forced);
      check('a WebGLRenderer the game chose: not held, on a low tier either', c.chose === null && c.choseLow === null, JSON.stringify([c.chose, c.choseLow]));
      check('the fake and all six effects throw the same named error there', r.errors.length === 7 && r.errors.every(m => /has only node\(\).*chose WebGLRenderer/.test(m)), JSON.stringify(r.errors));
      check('a hold is said once in the console', r.lowNotes === 1, String(r.lowNotes));
    },
  },
  {
    name: '[guard] sun shafts and light volumes: a missing light or missing bounds throw by name',
    url: '/tests/light-webgpu/index.html',
    software: true,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const r = await ev(() => window.lightMissing());
      check('lightVolumes() names bounds', /lightVolumes: bounds is required/.test(r.noBounds), r.noBounds);
      check('sunShafts() with no sun names the light', /sunShafts: no light/.test(r.noLight), r.noLight);
    },
  },
  {
    name: '[guard] sun shafts: a shaft stands out from the dark room',
    url: '/tests/light-webgpu/index.html',
    software: true,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const r = await ev(() => window.lightShafts());
      console.log('  sun shaft numbers:', JSON.stringify(r));
      const flat = r.rows.flat(), most = Math.max(...flat), least = Math.min(...flat);
      check(`shafts are local, not a haze over the whole frame: ${least} to ${most}`, most > 6 && most > 3 * Math.max(least, 0.5), JSON.stringify(r.rows));
    },
  },
  {
    name: '[guard] light volumes: a spot cone lights the air where it stands, the sun does nothing and describe() says so',
    url: '/tests/light-webgpu/index.html',
    software: true,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const r = await ev(() => window.lightCones());
      console.log('  light volume numbers:', JSON.stringify(r));
      const flat = r.cone.flat(), most = Math.max(...flat), least = Math.min(...flat);
      check(`the cone is local: ${least} to ${most}`, most > 6 && most > 3 * Math.max(least, 0.5), JSON.stringify(r.cone));
      check(`the sun adds nothing (${r.sunOnly}) and describe() says that`, Math.abs(r.sunOnly) < 1 && /sun does nothing/.test(r.fact.lights), JSON.stringify(r));
      check(`a scene.backgroundNode stays out of the air, only light is added (${r.skyOnly}), and the game keeps its node`, Math.abs(r.skyOnly) < 1 && r.atDraw?.backgroundNode === null && r.atDraw.background === null && r.atDraw.alpha === 0 && r.nodeKept, JSON.stringify(r.atDraw));
      check('removing it takes the layer off the lights it lit', r.lampLayer && r.lampBack, JSON.stringify([r.lampLayer, r.lampBack]));
    },
  },
  {
    // 不许绕开: the scene pass gives metalness / roughness through needsBuffers, so the effect never calls setMRT, and removing it leaves no target behind
    name: '[guard] reflections: a metal floor reflects a bright box, numbers change in place, follows metalness, order before bloom and temporalAA, low tier holds it, remove leaves nothing',
    url: '/tests/light-webgpu/index.html',
    software: true,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const r = await ev(() => window.lightMirror());
      console.log('  reflection numbers:', JSON.stringify(r));
      check(`the floor under the box's mirror image is brighter with the effect (${r.under})`, r.under > 8, JSON.stringify(r));
      check('normal and metalRough come from the one merged scene render', ['normal', 'metalRough'].every(b => r.buffers.includes(b)) && /metalness/.test(r.facts?.surfaces), JSON.stringify([r.buffers, r.facts]));
      check(`intensity 0 writes its uniform without a rebuild and the reflection goes (${r.live.under})`, r.live.same && Math.abs(r.live.under) < 2, JSON.stringify(r.live));
      check(`voxelGI + reflections + temporalAA: metalRough rides in velocity's target (four in all) and still reflects (${r.combo.under})`,
        r.combo.under > 8 && !r.combo.buffers.includes('metalRough') && r.combo.buffers.length === (r.combo.gi ? 4 : 3), JSON.stringify(r.combo));
      check('order in the hdr slot: reflections, then bloom, then temporalAA', r.order.join(',') === 'reflections,bloom,temporalAA', r.order.join(','));
      check(`a build-time setting (binaryRefine) rebuilds the chain and still reflects (${r.refine.under})`, r.refine.rebuilt && r.refine.under > 8, JSON.stringify(r.refine));
      check(`it follows metalness: a stone floor adds nothing (${r.stone}), metalness 0.3 some (${r.partial}), less than metal`, Math.abs(r.stone) < 2 && r.partial > 4 && r.partial < r.under, JSON.stringify([r.stone, r.partial]));
      check('low tier: held, out of the chain, describe() says why', !r.lowTier.order && /low/.test(r.lowTier.held), JSON.stringify(r.lowTier));
      check(`setup: s => { s.resolutionScale = 1 } holds (target ${r.leak.full}); the default is half (${r.facts.target})`, r.leak.full?.[0] === 320 && r.facts.target[0] === 160, JSON.stringify([r.leak.full, r.facts.target]));
      check(`add, draw, remove: its ${r.leak.made} textures go (${r.leak.left} left; with bloom and temporalAA ${r.leak.trio}) and no extra scene outputs`, r.leak.made > 0 && r.leak.left <= 0 && r.leak.trio <= 0 && !r.after.mrt, JSON.stringify([r.leak, r.after]));
    },
  },
  {
    name: '[guard] post buffers over the device limit: a named throw listing the effects, nothing added',
    url: '/tests/light-webgpu/index.html',
    software: true,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const r = await ev(() => window.lightRoom());
      if (r.backend === 'webgpu') return;   // real limits are read-only; the packing check above runs there
      check('throws naming the effect and its buffers, with the count and the limit', /many \(normal, diffuse, metalRough\) need 4 scene targets \(32 bytes.*takes 3/.test(r.msg) && !r.kept, JSON.stringify(r));
    },
  },
];
