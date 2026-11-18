// A whole replacement camera module in ~35 lines against the public core only: the proof that modules/camera/contract.js is small enough to meet.
// A fixed-angle chase camera: it looks along one heading from behind the followed object. The shared contract check runs it in Node (no engine.camera:
// screenToGround answers null); the browser test (specs/ui-nav.mjs) installs it in place of followCamera() and walks the player with control: 'camera'.
// No three.js import: the vector class is taken from engine.camera, so the file runs in Node and in the page alike.
export function fakeCamera({ heading = 0, distance = 8, height = 5 } = {}) {
  let e = null, target = null;
  const f = { x: Math.sin(heading), z: -Math.cos(heading) };
  const api = {
    forward: () => ({ x: f.x, z: f.z }),
    right: () => ({ x: -f.z, z: f.x }),
    follow(obj) { target = obj ?? null; },
    get target() { return target; },
    get target() { return target; },
    focusPoint() { return target ? target.position : e.camera?.position ?? { x: 0, y: 0, z: 0 }; },
    screenToGround(ndcX, ndcY) {
      const cam = e.camera; if (!cam) return null;
      const V = cam.position.constructor, o = cam.position.clone(), d = new V(ndcX, ndcY, 0.5).unproject(cam).sub(o).normalize();
      if (Math.abs(d.y) < 1e-6) return null;
      const t = -o.y / d.y;
      return t > 0 ? o.add(d.multiplyScalar(t)) : null;
    },
  };
  return {
    name: 'cameraRig', type: 'picture', provides: ['cameraRig'], stage: 'control',
    install(engine) { e = engine; e.saves.define('cameraRig', { version: 1, save: () => ({}), load() {} }); return api; },
    frame() {
      const cam = e.camera; if (!cam || !target || e.cameraOverride) return;
      const p = target.position;
      cam.position.set(p.x - f.x * distance, p.y + height, p.z - f.z * distance); cam.lookAt(p.x, p.y + 1, p.z);
    },
    describe() { return { following: !!target }; },
  };
}
