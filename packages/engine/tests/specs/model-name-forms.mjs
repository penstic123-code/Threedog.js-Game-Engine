// A character's model takes the two forms a prop's does. Why a guard: ['villager', tint] worked on props, reached Object3D.add as an array on NPCs, and check could not see it.
export const specs = [{
  name: '[guard] model name forms: an NPC takes [name, ...args] like a prop, and a file model refuses the arguments out loud',
  url: '/?cutscene=skip',
  async run({ check, ev, frames }) {
    await ev(async () => {
      await __t.until(() => engine.stateApplied, 10000);
      engine.assets.manifest({ models: { formBody(tint) { window.tint = tint; return new (Object.getPrototypeOf(Object.getPrototypeOf(engine.scene)).constructor)(); } } });
      const p = engine.actorPosition();
      engine.npcs.add({ id: 'form-npc', name: 'Form', model: ['formBody', 7], position: [p.x + 1, 0, p.z], schedule: [] });
    });
    await frames(6);
    const r = await ev(() => ({ tint: window.tint, look: engine.world.get('form-npc').look?.model, error: engine.error?.message ?? null }));
    check('the arguments reach the generator, with no error', r.tint === 7 && !r.error, JSON.stringify(r));
    check('the name stays plain data in the save', JSON.stringify(r.look) === '["formBody",7]', JSON.stringify(r.look));
    const refused = await ev(() => {
      engine.assets.manifest({ models: { formFile: '/models/form.glb' } });
      try { engine.characters.addPlayer({ control: 'camera', model: ['formFile', 1] }); return 'no error'; } catch (err) { return err.message; }
    });
    check('a file model with arguments stops and says why', refused.includes('arguments work on a generator'), refused);
  },
}, {
  // A plain clone of a skinned model keeps the prototype's bones: every copy would draw where the prototype stands, not where it was placed
  name: '[guard] a skinned model placed by name: a prop and a pickup each get bones of their own',
  url: '/tests/threads/',
  async run({ check, ev }) {
    const r = await ev(async () => {
      const { mk, THREE } = threedogThreads, T = threedogThreads.all;
      const E = mk(T.createEngine, 'skinned-prop');
      E.use(T.world(), T.inventory(), T.pickups(), T.content());
      await E.start(); E.haltLoop();
      E.assets.manifest({ models: { skinny() {
        const g = new THREE.BoxGeometry(1, 1, 1), n = g.attributes.position.count;
        g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(n * 4).fill(0), 4));
        g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Array(n).fill([1, 0, 0, 0]).flat(), 4));
        const bone = new THREE.Bone(), m = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial()), root = new THREE.Group();
        root.add(bone, m); m.bind(new THREE.Skeleton([bone])); return root;
      } } });
      E.inventory.define('skin', { name: 'Skin', model: 'skinny' });
      E.content.load({ name: 'sk', props: [{ id: 'p1', model: 'skinny', at: [6, 0, 0] }] });
      E.pickups.spawn([-6, 0, 0], { id: 'k1', give: 'skin' });
      await E.world.whenReady; await new Promise(r => setTimeout(r, 50)); E.step(0.1); await new Promise(r => setTimeout(r, 50));
      const own = id => { const o = E.world.view(id); if (!o) return null; let m = null; o.traverse(c => { if (c.isSkinnedMesh) m = c; }); if (!m) return 'no skin'; let p = m.skeleton.bones[0]; while (p && p !== o) p = p.parent; return p === o; };
      return { prop: own('p1'), pickup: own('k1'), error: E.error?.message ?? null };
    });
    check('the prop owns its bones', r.prop === true, JSON.stringify(r));
    check('the pickup owns its bones', r.pickup === true, JSON.stringify(r));
  },
}];
