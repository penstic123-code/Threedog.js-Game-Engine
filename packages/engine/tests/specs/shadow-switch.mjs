// [guard] The shadow master switch only moves the renderer's switch, and no engine code copies its state into a light's castShadow.
// Why: a castShadow written from "is the switch on now" is never written again, so a player who entered with shadows off and turned them on in the menu
// got a sun with no shadow, or cascades with only the nearest map, and nothing reported it (review 2026-11-04 finding 2).
// Also guards what the game wrote on the placeholder sun: installing a sky changes none of it (finding 8).
// Same format as the other files here.

export const specs = [
  {
    name: '[guard] shadow switch: off then on keeps every caster (placeholder sun under a sky, every cascade of a game light); sky() leaves what the game wrote on engine.lights.sun',
    software: true,   // photo.take reads the canvas
    url: '/tests/threads/',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, THREE } = threedogThreads, T = threedogThreads.all, out = {};
        // the placeholder sun: the switch off before the sky goes in
        let E = mk(T.createEngine, 'sw-sky');
        E.shadows.enabled = false;
        E.use(T.sky());
        await E.start(); E.step(0.05);
        E.shadows.enabled = true; E.step(0.05);
        out.sky = { on: E.shadows.enabled, renderer: E.renderer.shadowMap.enabled, cast: E.lights.sun.castShadow };
        E.dispose();
        // a game's light: cascades made while the switch is off
        E = mk(T.createEngine, 'sw-csm');
        const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(40, 80, 30); sun.castShadow = true; E.scene.add(sun, sun.target);
        await E.start(); E.step(0.05);
        E.shadows.enabled = false;
        E.lights.sun.castShadow = false;   // on WebGL the cascades must be the only shadow-casting DirectionalLight (render/shadows.js 'other')
        const h = E.shadows.cascades(sun, { count: 3, low: { count: 3 } }); E.step(0.05);
        out.hidden = h.csm.lights.filter(l => l !== sun).map(l => l.visible);
        E.shadows.enabled = true; E.step(0.05);
        out.csm = h.csm.lights.map(l => ({ cast: l.castShadow, visible: l.visible }));
        // the game's own choice survives the switch both ways
        E.shadows.enabled = false; sun.castShadow = false; E.shadows.enabled = true; E.step(0.05);
        out.gameOff = { cast: sun.castShadow, extras: h.csm.lights.filter(l => l !== sun).map(l => l.visible) };
        h.remove(); E.dispose();
        // what the game wrote on engine.lights.sun before the sky stays
        E = mk(T.createEngine, 'sw-kept');
        const s = E.lights.sun, c = s.shadow.camera;
        s.castShadow = false; s.shadow.bias = -0.01; s.shadow.normalBias = 0.5; s.shadow.radius = 7; s.shadow.blurSamples = 3; s.shadow.mapSize.set(256, 256);
        c.left = -11; c.right = 11; c.far = 77;
        E.use(T.sky());
        await E.start(); E.step(0.05);
        out.kept = { cast: s.castShadow, bias: s.shadow.bias, normalBias: s.shadow.normalBias, radius: s.shadow.radius, blur: s.shadow.blurSamples, map: s.shadow.mapSize.x, left: c.left, right: c.right, far: c.far };
        E.dispose();
        // photo mode raises the map of the game's own sun for the shot (the placeholder sun is not in this scene) and puts it back, on a map that already exists
        E = mk(T.createEngine, 'sw-photo', { lights: false });
        E.use(T.photo());
        const own = new THREE.DirectionalLight(0xffffff, 2); own.castShadow = true; own.shadow.mapSize.set(512, 256); E.scene.add(own, own.target);
        const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()); m.castShadow = m.receiveShadow = true; E.scene.add(m);
        await E.start(); E.step(0.05);
        const once = E.renderOnce; let shot = null;
        E.renderOnce = function (...a) { const v = once.apply(this, a); shot = { size: own.shadow.mapSize.x, drawn: own.shadow.map?.width ?? null }; return v; };
        E.photo.take({ shadowMapSize: 1024, scale: 1 });
        E.renderOnce = once; E.step(0.05);
        out.photo = { shot, back: [own.shadow.mapSize.x, own.shadow.mapSize.y], drawn: own.shadow.map?.width };
        E.dispose();
        E = mk(T.createEngine, 'sw-bad');
        const bad = f => { try { f(); return ''; } catch (err) { return err.code ?? err.message; } };
        out.bad = [bad(() => E.shadows.mapSize({}, 512)), bad(() => E.shadows.mapSize(E.lights.sun, 0.5))];
        E.dispose();
        return out;
      });
      check('sky installed with the switch off, then on: the sun casts', r.sky.on && r.sky.renderer && r.sky.cast, JSON.stringify(r.sky));
      check('cascades made with the switch off show nothing extra while it is off', r.hidden.length === 2 && r.hidden.every(v => !v), JSON.stringify(r.hidden));
      check('cascades made with the switch off, then on: all three cast and show', r.csm.length === 3 && r.csm.every(l => l.cast && l.visible), JSON.stringify(r.csm));
      check("the game's castShadow false stays through the switch and the cascades follow it", !r.gameOff.cast && r.gameOff.extras.every(v => !v), JSON.stringify(r.gameOff));
      check("photo.take with no sky: the game's own sun gets the photo size for the shot, drawn at it, and its old non-square size back", r.photo.shot?.size === 1024 && r.photo.shot?.drawn === 1024 && r.photo.back.join() === '512,256' && r.photo.drawn === 512, JSON.stringify(r.photo));
      check('engine.shadows.mapSize refuses a non-light and a broken size', r.bad.every(c => /shadow-cascades/.test(c)), JSON.stringify(r.bad));
      check('sky() leaves castShadow and every shadow value the game wrote on engine.lights.sun',
        JSON.stringify(r.kept) === JSON.stringify({ cast: false, bias: -0.01, normalBias: 0.5, radius: 7, blur: 3, map: 256, left: -11, right: 11, far: 77 }), JSON.stringify(r.kept));
    },
  },
];
