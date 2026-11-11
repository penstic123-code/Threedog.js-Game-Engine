// engine.applyState: what `threedog state` and `shot` stand on. A new run must not undo a pos given in the same call while the tool prints Set,
// and a view far from the player must load the world around what it looks at.
export const specs = [{
  name: 'applyState: pos survives the run that fresh / play starts; a view or a pose moves the world focus',
  url: '/?cutscene=skip',
  async run({ check, ev }) {
    const r = await ev(async () => {
      const at = () => ({ x: Math.round(engine.player.position.x), z: Math.round(engine.player.position.z) });
      const res = await engine.applyState({ fresh: 1, play: 1, pos: '37,-41' });
      const placed = at();
      engine.views.define('far-view', { position: [300, 40, 300], target: [320, 0, 320] });
      await engine.applyState({ view: 'far-view' });
      const focus = { x: engine.focus.x, z: engine.focus.z };
      engine.views.release();
      // a pose with no declared view: the text a URL or `threedog state view=` carries (and shot --cam), and the object form in code
      await engine.applyState({ view: '-120,30,-80,-100,2,-60,40' });
      const pose = { cam: engine.camera.position.toArray().map(Math.round), focus: [engine.focus.x, engine.focus.z], fov: engine.camera.fov, current: engine.views.current };
      engine.views.show({ position: [5, 6, 7], target: [0, 1, 0] });
      const object = engine.camera.position.toArray();
      engine.views.release();
      let bad = ''; try { engine.views.show({ position: [1, 2] }); } catch (err) { bad = err.code; }
      return { ok: res.ok, placed, focus, pose, object, bad };
    });
    check('[guard] applyState({ fresh, play, pos }) leaves the player at pos, not at the start of the new run', r.ok && r.placed.x === 37 && r.placed.z === -41, JSON.stringify(r));
    check('[guard] applyState({ view: "x,y,z,tx,ty,tz,fov" }) shows that pose with no view declared: camera, focus and lens',
      r.pose.cam.join() === '-120,30,-80' && r.pose.focus.join() === '-100,-60' && r.pose.fov === 40 && r.pose.current === '(pose)', JSON.stringify(r.pose));
    check('views.show({ position, target }) takes a pose in code; a malformed one throws views-define', r.object.join() === '5,6,7' && r.bad === 'views-define', JSON.stringify([r.object, r.bad]));
    check('[guard] a view moves engine.focus to its target, so the world loads there and not around the player', r.focus.x === 320 && r.focus.z === 320, JSON.stringify(r));
  },
}];
