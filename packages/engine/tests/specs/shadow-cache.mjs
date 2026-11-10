// engine.shadows.cache (render/shadowCache.tsl.js, recipe 45). A guard: not called, a light is three's own; called, a static caster's shadow stays where it was drawn and a
// moving one's follows. software: false because the feature is the WebGPU backend's depth copy: a page that lands on any other backend fails here, it never passes unseen.
export const specs = [
  {
    name: '[guard] shadow cache: off changes nothing; on, a static caster stays in the kept map and a moving one updates',
    url: '/tests/shadow-cache/index.html',
    software: false,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const r = await ev(() => window.shadowCache());
      console.log('  shadow cache numbers:', JSON.stringify(r));
      const isDark = (v, lit) => v < lit * 0.7, isLit = (v, lit) => v > lit * 0.85, lit = r.off.lit;
      check('the page runs on the real WebGPU backend', r.backend === 'webgpu', r.backend);
      check('the spots tell shadow from light', lit > 60 && isDark(r.off.still, lit) && isDark(r.off.mover, lit), JSON.stringify(r.off));
      check('off: no shadow node, no patch listed', r.off.node && !r.off.patch, JSON.stringify(r.off));
      check('off: both shadows move with their boxes', isDark(r.offMoved.still, lit) && isDark(r.offMoved.mover, lit) && isLit(r.offMoved.oldStill, lit) && isLit(r.offMoved.oldMover, lit), JSON.stringify(r.offMoved));
      check('on: the node is on the light, the patch is listed, the picture is the same (< 0.5% of pixels)', r.on.node && r.on.patch && r.on.changed < 0.5, JSON.stringify(r.on));
      check('on: a static caster that moved keeps its old shadow and casts no new one', isDark(r.frozen.oldStill, lit) && isLit(r.frozen.newStill, lit), JSON.stringify(r.frozen));
      check('on: a moving caster updates on the very next frame', isDark(r.frozen.firstFrame, lit) && isDark(r.frozen.newMover, lit) && isLit(r.frozen.oldMover, lit), JSON.stringify(r.frozen));
      check('on: a static object added after the kept map was drawn casts at once', isDark(r.late, lit), String(r.late));
      check('redraw() brings the static shadow to where its caster is', isLit(r.redrawn.oldStill, lit) && isDark(r.redrawn.newStill, lit), JSON.stringify(r.redrawn));
      check('a moved light redraws the kept map with no redraw() call', isLit(r.sunMoved.oldSide, lit) && isDark(r.sunMoved.newSide, lit), JSON.stringify(r.sunMoved));
      check('under a box the light holds inside a quarter of the box and steps past it', r.box.held === 0 && r.box.stepped > 4.9, JSON.stringify(r.box));
      check('engine.shadows.mapSize resizes both maps and both shadows stay', r.resized.size === 1024 && r.resized.kept === 1024 && isDark(r.resized.still, lit) && isDark(r.resized.mover, lit), JSON.stringify(r.resized));
      check('remove(): three\'s own node again, the same picture', r.removed.node && r.removed.changed < 0.5, JSON.stringify(r.removed));
      check('a batch answers for its originals: static by their root, kept, and not static with one moving original', r.batch.made && r.batch.byRoot && r.batch.kept && !r.batch.oneMoving, JSON.stringify(r.batch));
      check('an instance that moved draws live at once and is kept again after the refill; a batch replaced redraws the kept map with no redraw() call', r.batch.liveFirst && r.batch.keptAgain && r.batch.replaced, JSON.stringify(r.batch));
      // 不许绕开: instance writes every frame (streaming) refill the kept map at most once per REFILL_EVERY (8) shadow frames, not once per write
      const st = r.batch.streaming;
      check(`instance writes every frame: ${st?.fills} refills for ${st?.writes} writes over ${st?.shadowFrames} shadow frames`, st && st.fills >= 1 && st.fills <= Math.ceil(st.shadowFrames / 8) + 1 && st.fills < st.writes, JSON.stringify(st));
      const t = await ev(() => window.transmitted());
      check('transmitted shadows: a static box with a red castShadowNode tints its shadow, and the kept map keeps the tint (its color copied with the depth)', t.off > 20 && Math.abs(t.on - t.off) < 0.25 * t.off, JSON.stringify(t));
      check('a kept instanced mesh hidden (a vegetation ring past maxRing, a dropped chunk) redraws the kept map: no shadow of what is gone', r.batch.hiddenRedrawn, JSON.stringify(r.batch));
    },
  },
];
