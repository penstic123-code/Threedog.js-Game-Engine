// The canvas follows its own CSS box, not the window ("do not bypass" guard): a canvas inside a smaller page section renders at that size,
// the pointer's ndc is relative to the canvas, so pick at a screen point hits the object under it, and a resize of the section follows.
// Same format as the other files here. Run: npm test -- "canvas box"

export const specs = [
  {
    name: 'canvas box: a canvas in a smaller div sizes to the div, pointer ndc / pick hit the object under the mouse, resize follows, the UI root covers the canvas',
    url: '/tests/threads/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { createEngine, THREE } = threedogThreads;
        const frames = () => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
        // a canvas styled to fill the window (what games' index.html do) ends up window-sized through its CSS box
        const fc = document.createElement('canvas'); fc.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block';
        document.body.append(fc);
        const F = createEngine({ canvas: fc, headless: true, urlState: false, saveKey: 'canvas-box-full', ui: { loading: false } });
        const full = F.renderer.getSize(new THREE.Vector2()), fullRoot = F.uiRoot.getBoundingClientRect(), fullAuto = F._autoSize;
        F.dispose(); fc.remove();
        // the page's own canvas has no CSS size: the engine sizes it to the window (and warns) instead of growing it by the pixel ratio
        const bare = window.engine.renderer.getSize(new THREE.Vector2()), bareAuto = window.engine._autoSize;
        const host = document.createElement('div');
        host.style.cssText = 'position:absolute;left:120px;top:80px;width:400px;height:300px';
        const cv = document.createElement('canvas'); cv.style.cssText = 'width:100%;height:100%;display:block';
        host.append(cv); document.body.append(host);
        const E = createEngine({ canvas: cv, headless: true, urlState: false, saveKey: 'canvas-box', ui: { loading: false } });
        const box = x => { const m = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)); m.position.x = x; E.scene.add(m); return m; };
        const left = box(-4), right = box(4);
        E.camera.position.set(0, 0, 12); E.camera.lookAt(0, 0, 0); E.scene.updateMatrixWorld(true);
        // move the mouse over the right box (its pixel in the canvas + the canvas's place on the page) and pick where the pointer says
        const pickRight = () => {
          E.camera.updateMatrixWorld(); E.camera.updateProjectionMatrix();
          const v = right.position.clone().project(E.camera), b = cv.getBoundingClientRect();
          const cx = b.left + (v.x + 1) / 2 * b.width, cy = b.top + (1 - v.y) / 2 * b.height;
          cv.dispatchEvent(new PointerEvent('pointermove', { clientX: cx, clientY: cy, pointerId: 7, bubbles: true }));
          const p = E.input.pointer, hit = E.pick(p.ndcX, p.ndcY, { targets: [left, right] });
          // what the old window-based ndc would have picked: the same client point measured against the whole window
          const old = E.pick(cx / innerWidth * 2 - 1, -(cy / innerHeight) * 2 + 1, { targets: [left, right] });
          return { hit: hit?.object === right ? 'right' : hit?.object === left ? 'left' : null, old: old?.object === right ? 'right' : old ? 'left' : null,
            px: [Math.round(p.x - (cx - b.left)), Math.round(p.y - (cy - b.top))] };
        };
        const size = () => { const v = E.renderer.getSize(new THREE.Vector2()); return [v.x, v.y]; };
        const rootMatches = () => {
          const a = E.uiRoot.getBoundingClientRect(), b = cv.getBoundingClientRect();
          return [a.left - b.left, a.top - b.top, a.width - b.width, a.height - b.height].every(d => Math.abs(d) < 1);
        };
        const out = { full: [full.x, full.y], fullAuto, bare: [bare.x, bare.y], bareAuto, win: [innerWidth, innerHeight], fullRoot: [fullRoot.width, fullRoot.height],
          before: size(), aspect0: E.camera.aspect, pick0: pickRight(), root0: rootMatches(), rootAfterCanvas: cv.nextElementSibling === E.uiRoot };
        host.style.width = '200px'; host.style.height = '200px'; host.style.left = '300px';
        await frames();
        Object.assign(out, { after: size(), aspect1: E.camera.aspect, pick1: pickRight(), root1: rootMatches() });
        E.dispose(); host.remove();
        return out;
      });
      check('[guard] a canvas filling the window still renders at the window size, with the UI root over the whole window',
        r.full[0] === r.win[0] && r.full[1] === r.win[1] && r.fullRoot[0] === r.win[0] && r.fullRoot[1] === r.win[1], JSON.stringify(r));
      check('a canvas without a CSS size is sized to the window by the engine (no pixel-ratio growth loop)', r.bareAuto === true && r.fullAuto === false && r.bare.join() === r.win.join(), JSON.stringify(r));
      check('[guard] a canvas in a 400 x 300 div renders at 400 x 300 (aspect 4:3), not at the window size', r.before.join() === '400,300' && Math.abs(r.aspect0 - 4 / 3) < 1e-6, JSON.stringify(r));
      check('[guard] pointer ndc is relative to the canvas: pick at the mouse hits the box under it (window-based ndc would not)',
        r.pick0.hit === 'right' && r.pick0.old !== 'right' && r.pick0.px.join() === '0,0', JSON.stringify(r.pick0));
      check('[guard] resizing the div (no window resize) resizes the renderer and camera, and pick still hits', r.after.join() === '200,200' && Math.abs(r.aspect1 - 1) < 1e-6 && r.pick1.hit === 'right', JSON.stringify(r));
      check('the UI root sits right after the canvas and covers exactly its box, before and after the resize', r.rootAfterCanvas && r.root0 && r.root1, JSON.stringify(r));
    },
  },
  {
    name: 'canvas box: step() follows a viewport change with no frame in between (canvas, camera, UI root), and renderOnce does not add up draw counts',
    url: '/tests/threads/',
    async run({ check, ev }) {
      const r = await ev(() => {
        const { createEngine, THREE } = threedogThreads;
        const host = document.createElement('div');
        host.style.cssText = 'position:absolute;left:0;top:0;width:400px;height:300px';
        const cv = document.createElement('canvas'); cv.style.cssText = 'width:100%;height:100%;display:block';
        host.append(cv); document.body.append(host);
        const E = createEngine({ canvas: cv, headless: true, urlState: false, saveKey: 'canvas-box-step', ui: { loading: false } });
        E.scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
        host.style.width = '200px'; host.style.height = '100px';   // no await: no ResizeObserver callback or rAF can have run
        E.step(1 / 60, { describe: false });
        const v = E.renderer.getSize(new THREE.Vector2()), root = E.uiRoot.getBoundingClientRect();
        const out = { size: [v.x, v.y], aspect: E.camera.aspect, root: [root.width, root.height] };
        E.renderOnce(); const one = E.renderer.info.render.calls;
        E.renderOnce(); out.calls = [one, E.renderer.info.render.calls];
        E.dispose(); host.remove();
        return out;
      });
      check('step() after a viewport change: renderer, camera aspect and UI root have the new size', r.size.join() === '200,100' && Math.abs(r.aspect - 2) < 1e-6 && r.root.join() === '200,100', JSON.stringify(r));
      check('two renderOnce calls draw the same count (renderer.info is reset each call)', r.calls[0] > 0 && r.calls[0] === r.calls[1], JSON.stringify(r.calls));
    },
  },
];
