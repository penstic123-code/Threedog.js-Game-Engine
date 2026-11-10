// engine.inspect.scene(): "the mesh exists but is not drawn, why?" Every kind of invisibility is built by hand and its reason must be reported.
export const specs = [
  {
    name: 'INSPECT-SCENE 场景检查：各种看不见的原因都被报出，可见的不误报',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        const E = engine, THREE = __threedogThree, scene = E.scene, cam = E.camera;
        E.haltLoop();
        const fog0 = scene.fog; scene.fog = null;
        cam.position.set(0, 5, 20); cam.lookAt(0, 5, 0); cam.updateMatrixWorld(true);
        const G = new THREE.Group(); G.name = 'is-root'; scene.add(G);
        const box = () => new THREE.BoxGeometry(1, 1, 1), mat = (o = {}) => new THREE.MeshBasicMaterial(o);
        const add = (name, o, x = 0, y = 5, z = 0, parent = G) => { o.name = name; o.position.set(x, y, z); parent.add(o); return o; };
        const m = (name, o = {}, geo = box()) => add(name, new THREE.Mesh(geo, mat(o)));
        m('ok');
        m('self').visible = false;
        const hid = new THREE.Group(); hid.name = 'hidden-group'; hid.visible = false; G.add(hid);
        add('child-of-hidden', new THREE.Mesh(box(), mat()), 0, 5, 0, hid);
        m('layer').layers.set(5);
        m('mat-visible', { visible: false });
        m('opacity0', { transparent: true, opacity: 0 });
        m('opacity0-opaque', { opacity: 0 });
        m('colorwrite', { colorWrite: false });
        m('depthwrite', { depthWrite: false });
        m('scale0').scale.set(0, 0, 1);   // two axes flat = a line, nothing left (one flat axis leaves a plane: inspect-group-i)
        m('scale-nan').scale.set(NaN, 1, 1);
        m('pos-nan').position.x = NaN;
        const nanGeo = box(); nanGeo.attributes.position.setX(0, NaN); m('geo-nan', {}, nanGeo);
        const empty = new THREE.BufferGeometry(); empty.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3)); m('geo-empty', {}, empty);
        const dr = box(); dr.setDrawRange(0, 0); m('drawrange0', {}, dr);
        const inst = add('inst0', new THREE.InstancedMesh(box(), mat(), 4)); inst.count = 0;
        m('behind').position.z = 40;
        m('beyond-far').position.z = -(cam.far + 500);
        m('outside').position.x = 800;
        const pt = new THREE.BufferGeometry(); pt.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3)); m('radius0', {}, pt);
        const mu = m('multi', { colorWrite: false }); mu.visible = false; mu.layers.set(7);
        const pts = new THREE.BufferGeometry(); pts.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 5, 0, 1, 5, 0]), 3));
        add('points-ok', new THREE.Points(pts, new THREE.PointsMaterial({ size: 0.5 })));
        add('points-size0', new THREE.Points(pts, new THREE.PointsMaterial({ size: 0 })));
        const ln = new THREE.BufferGeometry(); ln.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 5, 0, 1, 5, 0]), 3));
        add('line-ok', new THREE.Line(ln, new THREE.LineBasicMaterial()));
        add('sprite-ok', new THREE.Sprite(new THREE.SpriteMaterial()));
        add('sprite-hidden', new THREE.Sprite(new THREE.SpriteMaterial({ visible: false })));
        const purpose = m('purposed'); purpose.material.userData.purpose = 'prop';
        const res = E.inspect.scene({ limit: 1000 });
        const by = n => res.items.find(i => i.name === n);
        const codes = n => (by(n)?.reasons ?? []).filter(x => x.level === 'hidden').map(x => x.code);
        const maybe = n => (by(n)?.reasons ?? []).filter(x => x.level === 'maybe').map(x => x.code);
        const out = { codes: {}, maybe: {}, drawn: {}, texts: {} };
        for (const i of res.items) if (i.path.includes('is-root')) { out.codes[i.name] = codes(i.name); out.maybe[i.name] = maybe(i.name); out.drawn[i.name] = i.drawn; out.texts[i.name] = (i.reasons ?? []).map(x => x.text + '|' + (x.fix ?? '')).join(' ; '); }
        const only = E.inspect.scene({ hidden: true, limit: 1000 }), few = E.inspect.scene({ limit: 3 });
        out.onlyHidden = only.items.every(i => !i.drawn) && only.items.length === only.counts.notDrawn;
        out.fewLen = few.items.length; out.fewTrunc = few.truncated; out.counts = res.counts; out.text = res.text.split('\n')[0];
        out.purposed = by('purposed').material; out.types = Object.keys(res.counts.byType).sort().join(',');
        out.undrawnFirst = res.items.findIndex(i => i.drawn) >= res.items.findIndex(i => !i.drawn);
        out.pos = by('behind').position; out.hasCam = !!res.camera;
        // fog: far 30 from a camera 20 m away from the plane z = 0: an object at z = -100 is 120 m deep
        scene.fog = new THREE.Fog(0x888888, 1, 30);
        const fogged = E.inspect.scene({ limit: 1000 }); out.fog = { behind: fogged.items.find(i => i.name === 'ok')?.reasons?.map(x => x.code) ?? [] };
        const far = m('fogfar'); far.position.z = -100; const f2 = E.inspect.scene({ limit: 1000 });
        out.fog.far = f2.items.find(i => i.name === 'fogfar').reasons.map(x => x.code + ':' + x.level); out.fog.farDrawn = f2.items.find(i => i.name === 'fogfar').drawn;
        scene.fog = fog0; scene.remove(G); E._unhalt();
        return out;
      });
      const c = r.codes, has = (n, code) => c[n]?.includes(code);
      check('可见的网格不误报：ok / points-ok / line-ok / sprite-ok / purposed 都是 drawn 且没有 hidden 原因', ['ok', 'points-ok', 'line-ok', 'sprite-ok', 'purposed'].every(n => r.drawn[n] && !c[n].length), JSON.stringify(c));
      check('自身 visible=false → hidden-self', has('self', 'hidden-self') && r.drawn.self === false && /visible = true/.test(r.texts.self));
      check('祖先 visible=false → hidden-ancestor，并说出是哪个祖先', has('child-of-hidden', 'hidden-ancestor') && /hidden-group/.test(r.texts['child-of-hidden']));
      check('层不匹配相机 → layers', has('layer', 'layers') && /camera/.test(r.texts.layer));
      check('材质 visible=false → material-hidden', has('mat-visible', 'material-hidden'));
      check('transparent 且 opacity=0 → opacity-zero（hidden）；非 transparent 的 opacity=0 只算 maybe，因为 three 会按不透明画', has('opacity0', 'opacity-zero') && !has('opacity0-opaque', 'opacity-zero') && r.maybe['opacity0-opaque'].includes('opacity-zero') && r.drawn['opacity0-opaque']);
      check('colorWrite=false → color-write-off；depthWrite=false 只算 maybe（仍 drawn）', has('colorwrite', 'color-write-off') && r.drawn.depthwrite && r.maybe.depthwrite.includes('depth-write-off'));
      check('缩放 0 或 NaN → scale-zero', has('scale0', 'scale-zero') && has('scale-nan', 'scale-zero'));
      check('位置 NaN → position-nan', has('pos-nan', 'position-nan'));
      check('几何里有 NaN → geometry-nan', has('geo-nan', 'geometry-nan'));
      check('几何为空 / drawRange 为 0 / InstancedMesh.count=0 → geometry-empty，各自说清', has('geo-empty', 'geometry-empty') && has('drawrange0', 'geometry-empty') && /draw range/.test(r.texts.drawrange0) && has('inst0', 'geometry-empty') && /count is 0/.test(r.texts.inst0));
      check('在相机后方 → behind-camera', has('behind', 'behind-camera') && r.pos.z === 40);
      check('超出 camera.far → beyond-far，并给出数字', has('beyond-far', 'beyond-far') && /far is/.test(r.texts['beyond-far']));
      check('视锥外（侧面）→ outside-frustum，并说出是哪一面', has('outside', 'outside-frustum') && /right plane|left plane/.test(r.texts.outside));
      check('所有顶点在同一点（包围球半径 0）的网格 → radius-zero', has('radius0', 'radius-zero'));
      check('Points 的 size=0 → points-size-zero；被隐藏的 Sprite 材质 → material-hidden', has('points-size0', 'points-size-zero') && has('sprite-hidden', 'material-hidden'));
      check('一个对象有多条原因时按可能性排序：自己被隐藏排在层、颜色写入之前', c.multi[0] === 'hidden-self' && c.multi.includes('layers') && c.multi.includes('color-write-off'), JSON.stringify(c.multi));
      check('材质 purpose 被带出来', r.purposed.purpose === 'prop' && r.purposed.type === 'MeshBasicMaterial');
      check('类型都列出（Mesh / Points / Line / Sprite），摘要行有数量', /Line/.test(r.types) && /Mesh/.test(r.types) && /Points/.test(r.types) && /Sprite/.test(r.types) && /drawable objects/.test(r.text) && r.counts.notDrawn > 10);
      check('hidden:true 只列没画出来的；limit 截断并报 truncated；没画出来的排在前面', r.onlyHidden && r.fewLen === 3 && r.fewTrunc > 0 && r.undrawnFirst === true);
      check('雾：整个在雾里的对象是 fogged-out（maybe，不算没画出来）', r.fog.far.includes('fogged-out:maybe') && r.fog.farDrawn === true);
    },
  },
  {
    name: 'INSPECT-SCENE-MATERIAL inspect.scene 给出 colorPath 和 tint 提示，分得清引擎做的和游戏做的',
    url: '/',
    async run({ check, ev }) {
      const r = await ev(() => {
        const E = engine, THREE = __threedogThree; E.haltLoop();
        const a = new THREE.MeshLambertMaterial({ color: '#3b5168' }), tex = new THREE.Texture();
        const b = new THREE.MeshBasicMaterial({ color: 0x3b5168, map: tex }); b.name = 'tinted';
        const ma = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), a), mb = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), b); ma.name = 'zz-a'; mb.name = 'zz-b';
        E.scene.add(ma, mb);
        const res = E.inspect.scene({ limit: 5000 }), ia = res.items.find(i => i.name === 'zz-a').material.info[0], ib = res.items.find(i => i.name === 'zz-b').material.info[0];
        E.scene.remove(ma, mb); E._unhalt();
        return { ia, ib, render: res.render, engineMade: res.items.some(i => i.material?.info?.some(m => m.from === 'engine')) };
      });
      check('colorPath 说明 color 与 vertexColors；没有 map 时无 tint 提示', /color #3b5168/.test(r.ia.colorPath) && /vertexColors off/.test(r.ia.colorPath) && !r.ia.notes);
      check('map 且 color 非白 → colorPath 写 map x color，并给 note（不是错误）', /map x color #3b5168/.test(r.ib.colorPath) && r.ib.notes?.length === 1 && r.ib.from === 'game' && r.ia.from === 'game' && r.engineMade);
      check('结果带 renderer 行（复用 describe().render）', /^renderer:/.test(r.render ?? ''));
    },
  },
];
