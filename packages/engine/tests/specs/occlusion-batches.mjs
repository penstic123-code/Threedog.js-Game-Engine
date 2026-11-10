// Occlusion culling and engine.batching together (render/occlusion.js, core/stream/batchGroups.js). A batch cell is 256 m, so the camera stands over the footprint of
// the batches of its cell: what is around it is drawn whatever stands in front, yet each drew its box (one draw call, from inside it fills the screen) and asked a query every frame.
// Measured on the perf page's props scene (3000 props, 4 models, 20 batches) at eye height among the props.
export const specs = [
  {
    // 不许绕开：装着镜头的批次不画遮挡测试盒、不发查询（反正永远不会被藏）；镜头走出去后照常测试
    name: '[guard] occlusion with batching: a batch the camera stands in (over its footprint) draws no test box and asks no query; outside, it is tested again',
    url: '/tests/perf/index.html?mode=props',
    software: true,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.bench, null, { timeout: 60000 });
      const r = await ev(async () => {
        const e = engine, O = e.occlusion, cam = e.camera;
        e.haltLoop();
        const frames = async n => { for (let i = 0; i < n; i++) { e.step(1 / 60, { describe: false }); await new Promise(requestAnimationFrame); } };
        cam.position.set(10, 1.7, 10); cam.lookAt(-30, 1.7, -30); cam.updateMatrixWorld();
        await frames(3);
        O.enabled = true;
        await frames(20);
        const batches = () => [...O._items].filter(it => it.meshes[0]?.isInstancedMesh);
        const holds = it => it.box && cam.position.x >= it.box.min.x && cam.position.x <= it.box.max.x && cam.position.z >= it.box.min.z && cam.position.z <= it.box.max.z;   // over its footprint
        const inside = batches().filter(holds), outside = batches().filter(it => !holds(it));
        const out = { batches: batches().length, inside: inside.length, hidden: O.stats.hidden, draws: e.renderer.info.render.calls,
          insideBoxes: inside.filter(it => it.proxy?.visible).length, insideQueries: inside.filter(it => it.pending || it.open).length,
          outsideBoxes: outside.filter(it => it.proxy?.visible).length };
        O.enabled = false; await frames(2);
        out.drawsOff = e.renderer.info.render.calls;
        // walk out of the props field: no footprint holds the camera, every batch is tested again
        O.enabled = true;
        cam.position.set(0, 60, 300); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
        await frames(4);
        out.above = { inside: batches().filter(holds).length, boxes: batches().filter(it => it.proxy?.visible).length };
        O.enabled = false;
        return out;
      });
      console.log('  occlusion + batching numbers:', JSON.stringify(r));
      check('the camera stands inside some batches and outside others', r.inside > 0 && r.batches > r.inside, JSON.stringify(r));
      check('a batch holding the camera draws no test box and has no query in flight', r.insideBoxes === 0 && r.insideQueries === 0, JSON.stringify(r));
      check('the batches around it are still tested', r.outsideBoxes > 0, JSON.stringify(r));
      check('from outside the props field every batch is tested again', r.above.inside === 0 && r.above.boxes === r.batches, JSON.stringify(r.above));
    },
  },
];
