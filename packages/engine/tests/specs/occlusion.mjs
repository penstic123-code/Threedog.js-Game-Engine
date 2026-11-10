// Occlusion culling (render/occlusion.js) on every renderer it serves: hidden things are skipped, the picture does not change (shadows of hidden things included), and a thing coming into
// view is drawn in the same frame it would show. `node packages/tools/real-webgpu.mjs r=gpu` runs the WebGPU one on real WebGPU.
const run = async ({ page, check, ev }) => {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await ev(() => window.occlusionRun());
  console.log('  occlusion numbers:', JSON.stringify(r));
  check('everything behind the wall is hidden, and describe() reports it', r.still.hidden === 21 && r.row?.hidden === 21 && r.row.trianglesSkipped > 100000 && r.text, JSON.stringify([r.still, r.row, r.text]));
  check("hiding is for the view camera: the game's visible and layers stay as they were", r.hiddenFromView && r.visibleKept);
  check(`the picture does not change (${r.changed} pixels), hidden shadow casters included (the shadow itself is ${r.shadowMatters} pixels)`, r.changed === 0 && r.shadowMatters > 20, JSON.stringify([r.changed, r.shadowMatters]));
  check(`rays still hit a hidden thing: ${r.rayHit}`, r.rayHit === true, JSON.stringify(r.rayHit));
  check(`no visible gap while things come into view: worst frame ${r.gap.worst} pixels off, ${r.gap.shown} of 21 came back`, r.gap.worst === 0 && r.gap.shown > 3, JSON.stringify(r.gap));
  check('a camera cut shows everything in the first frame after it', r.cut.before > 0 && r.cut.differs === 0, JSON.stringify(r.cut));
  check("the boxes' group is the engine's, not a thing of the game (describe().scene, saves)", r.rootOwner === 'engine:occlusion', JSON.stringify(r.rootOwner));
  check('off puts every layer back and removes the boxes', r.off.boxes === 0 && r.off.layerBack && r.off.stats === 0, JSON.stringify(r.off));
  check('while off, watching reads no box', r.offCost.reads === 0 && r.offCost.boxes === 0, JSON.stringify(r.offCost));
  check('shadow cameras see hidden things, not the boxes, and off gives their mask back', r.shadowSeesHidden && !r.shadowSeesBoxes && r.off.shadowMaskBack, JSON.stringify([r.shadowSeesHidden, r.shadowSeesBoxes, r.off.shadowMaskBack]));
  // 不许绕开: outline's extra renders of the camera never draw the boxes
  const o = await ev(() => window.occlusionOutline());
  console.log('  outline numbers:', JSON.stringify(o));
  check(`outline with occlusion: ${o.boxes} boxes in view change no line (${o.differs} pixels)`, o.boxes > 0 && o.differs === 0, JSON.stringify(o));
  // 不许绕开: shadow lights the engine makes (cascades on a settings / tier change) get the hidden layer at once, not at the next timed walk (~1 s of missing shadows)
  const s = await ev(() => window.occlusionCascades());
  check(`cascades built while culling hides: every fresh shadow camera sees hidden casters within 2 frames (took ${s.frames})`, s.hidden === 21 && s.lights >= 2 && s.frames >= 1 && s.frames <= 2, JSON.stringify(s));
  // 不许绕开: fallback 'webgl' rebuilds the boxes for the renderer that stayed
  const f = await ev(() => window.occlusionFallback());
  check('start() falling back to WebGLRenderer keeps culling running, on a WebGL query', f.webgl && f.query && !f.gpuHook, JSON.stringify(f));
};
export const specs = [
  { name: '[guard] occlusion culling on WebGLRenderer: hidden skipped, picture and shadows unchanged, no gap coming into view', url: '/tests/occlusion/index.html', software: true, run },
  { name: '[guard] occlusion culling on WebGPURenderer: hidden skipped, picture and shadows unchanged, no gap coming into view', url: '/tests/occlusion/index.html?r=gpu', software: true, run },
];
