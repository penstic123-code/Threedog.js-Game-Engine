// 报告：benchmark 里 engine.post.add(new GTAOPass(scene, camera, w, h)) 后整屏只剩背景色，不报错。
// 根因：GTAOPass 也持有 scene 和 camera，被误认成"自己画场景、取代引擎场景渲染"的 pass，进了 scene 槽，场景就没人画了。
// 现在只认 RenderPass 家族 / SSAA·TAA / RenderPixelatedPass 为取代者，其余读上一级画面的 pass（GTAO、SAO、SSAO、SSR、Bokeh）进 hdr 槽。
export const specs = [
  {
    software: true,   // reads rendered pixels
    name: '[守] 后期：游戏自己 new 的 GTAOPass / SAOPass 这类读场景画面的 pass 进 hdr 槽，场景仍然画出来（不是只剩背景色）',
    url: '/tests/perf/index.html?mode=city',
    async run({ check, ev }) {
      const r = await ev(() => {
        const { GTAOPass } = threedogTest, p = engine.post, R = engine.renderer, gl = R.getContext(), sc = engine.scene, cam = engine.camera;
        const W = 200, H = 150, out = {}, css0 = R.getSize(new threedogTest.THREE.Vector2());
        R.setSize(W, H, false); cam.aspect = W / H; cam.updateProjectionMatrix();
        const colors = () => { const a = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, a); const s = new Set(); for (let i = 0; i < a.length; i += 4) s.add((a[i] >> 3) + ',' + (a[i + 1] >> 3) + ',' + (a[i + 2] >> 3)); return s.size; };
        p.render(0.016); out.off = colors();
        const h = p.add(new GTAOPass(sc, cam, W, H));
        p.render(0.016); out.on = colors(); out.slot = p.get(h.name)?.slot;
        h.remove(); R.setSize(css0.x, css0.y, false); cam.aspect = css0.x / css0.y; cam.updateProjectionMatrix();
        return out;
      });
      const j = JSON.stringify(r);
      check('GTAOPass 在 hdr 槽，不在 scene 槽', r.slot === 'hdr', j);
      check('加了之后画面颜色种数没有塌成一种（背景色）', r.on > 1 && r.on >= r.off, j);
    },
  },
];
