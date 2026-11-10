// API freeze guard (characters, HUD, dialogue, camera, weather, terrain): each renamed entry does its job under the new name and the old name is gone,
// so a stale recipe fails here instead of as `undefined is not a function` in a game. Run: threedog test "frozen names"
const PAGE = '/tests/threads/';

export const specs = [
  {
    name: 'frozen names: player, hud, dialogue, rts camera, weather and terrain answer under the 1.0 names; the old names are gone',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk } = threedogThreads, T = threedogThreads.all, out = {};
        const err = f => { try { f(); return null; } catch (e) { return String(e.code || e.message); } };

        const E = mk(T.createEngine, 'frozen-a');
        E.use(T.world(), T.collision(), T.characters({ npcs: false }), T.hud(), T.dialogue({ charsPerSecond: 17 }), T.calendar(),
          T.sky(), T.weather({ types: { clear: {}, ashfall: { ash: 1 } }, start: 'clear' }), T.terrain({ seed: 1 }));

        // hud.bump adds to a counter; add was the verb for placing things
        out.bump = [E.hud.bump('coins', 2), E.hud.bump('coins'), E.hud.value('coins')];
        out.hudAdd = typeof E.hud.add;

        out.chars = E.dialogue.charsPerSecond; out.cps = 'cps' in E.dialogue;

        out.field = err(() => E.weather.defineField('ash', { shape: 'soft', color: 0x555555 }));
        out.weatherDefine = typeof E.weather.define;

        out.terrain = { size: E.terrain.chunkSize === E.ground.chunkSize && E.terrain.chunkSize > 0, gen: typeof E.terrain.generator.surface, T: 'T' in E.terrain, CHUNK: 'CHUNK' in E.terrain };

        // the player is still put in the scene by the engine, with no public addTo; a hand-built Character goes through engine.add
        const p = E.characters.addPlayer({ control: 'camera' });
        out.player = { inScene: p.root.parent === E.scene, object: 'object' in p, addTo: 'addTo' in p };
        const c = new T.Character(E, {});
        out.hand = { before: c.root.parent === null };
        E.add(c.root);
        out.hand.after = c.root.parent === E.scene;

        // pitch reaches the camera: the higher it is, the less the camera backs off from the focus
        const back = pitch => {
          const F = mk(T.createEngine, 'frozen-rts-' + pitch);
          F.use(T.rtsCamera({ height: 20, pitch }));
          return { pitch: F.cameraRig.pitch, back: Math.hypot(F.camera.position.x, F.camera.position.z) };
        };
        out.low = back(0.4); out.high = back(1.4);
        out.angle = err(() => mk(T.createEngine, 'frozen-angle').use(T.rtsCamera({ angle: 1 })));
        return out;
      });
      const s = JSON.stringify(r);
      check('hud.bump counts up and hud.value reads it; hud.add is gone', r.bump.join() === '2,3,3' && r.hudAdd === 'undefined', s);
      check('dialogue.charsPerSecond is the option value; cps is gone', r.chars === 17 && !r.cps, s);
      check('weather.defineField draws a field of the table; weather.define is gone', r.field === null && r.weatherDefine === 'undefined', s);
      check('terrain.chunkSize and terrain.generator answer; T and CHUNK are gone', r.terrain.size && r.terrain.gen === 'function' && !r.terrain.T && !r.terrain.CHUNK, s);
      check('addPlayer still puts the player in the scene; object and addTo are gone', r.player.inScene && !r.player.object && !r.player.addTo, s);
      check('a hand-built Character enters the scene through engine.add(root)', r.hand.before && r.hand.after, s);
      check('rtsCamera({ pitch }) sets the view: a steeper pitch stands closer over the focus', r.low.pitch === 0.4 && r.high.pitch === 1.4 && r.high.back < r.low.back, s);
      check('rtsCamera({ angle }) is refused as an unknown option', !!r.angle, s);
    },
  },
];
