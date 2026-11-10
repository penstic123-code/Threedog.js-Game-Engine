// [guard] The engine rescues nothing on its own: the fall fact and the rule stay, 'rescue' is a built-in the game chooses, a walking preset declares it, and a dev build says
// once when a player is gone and nobody decided. Real Rapier. Run: threedog test "Fall default"
const PAGE = '/tests/threads/';
const J = JSON.stringify;

export const specs = [
  {
    name: '[guard] Fall default: no rule means no rescue, told once for a player; a rule set stays silent; openWorld chooses rescue and the game can override it',
    url: PAGE,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const { mk, createEngine, all: T, THREE } = threedogThreads, out = {};
        const warn = console.warn, told = []; console.warn = (...a) => { told.push(a.join(' ')); };
        const walker = async (key, rule, mods = () => [T.world(), T.collision(), T.characters({ npcs: false })]) => {
          const E = mk(createEngine, key);
          E.use(...mods());
          await E.start(); E.haltLoop();
          rule?.(E);
          const p = E.characters.addPlayer({ control: () => ({ x: 0, z: 0 }), spawn: [0, 0, 0], fall: { belowY: -50 } });
          E.step(1 / 60);
          return { E, p };
        };
        const pit = E => E.setGround({ height: () => -1000, slope: () => 0, type: () => 'default', waterLevel: -Infinity });   // the ground it stood on is gone
        const fell = () => told.filter(m => /no rule 'fall'/.test(m)).length;
        { // a rule set by the game: silent, and rescue is the game's choice
          const { E, p } = await walker('fd-rule', e => e.mod('fall', { owner: 'game', set: 'rescue' }));
          for (let i = 0; i < 20; i++) E.step(1 / 60);
          pit(E); p.root.position.y = -250; E.step(1 / 60);
          out.chosen = { y: p.position.y, told: fell() };
          E.dispose();
        }
        { // nothing set: character:fall still fires, the player stays down, and a dev build says what decides it, once
          const { E, p } = await walker('fd-none');
          const falls = []; E.events.on('character:fall', x => falls.push(x));
          for (let i = 0; i < 20; i++) E.step(1 / 60);
          pit(E); p.root.position.y = -250;
          for (let i = 0; i < 5; i++) E.step(1 / 60);
          out.none = { y: p.position.y, falls: falls.length, told: fell(), text: told.find(m => /no rule 'fall'/.test(m)) ?? '' };
          E.dispose();
        }
        { // a body with nothing set stays down
          const E = mk(createEngine, 'fd-body');
          E.use(T.collision(), T.rigid());
          await E.start(); E.haltLoop();
          const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
          const b = E.rigid.addBox(box, { mass: 1 });
          b.body.setTranslation({ x: 0, y: -201, z: 0 }, true);
          E.step(1 / 60);
          out.body = b.body.translation().y;
          E.dispose();
        }
        { // the walking preset declares rescue under the game's layer
          const E = mk(createEngine, 'fd-preset');
          E.use(T.openWorld({ camera: false, terrain: false, vegetation: false, sky: false, weather: false, water: false, ambience: false, settings: false, debug: false, rigid: false, calendar: false }));
          await E.start(); E.haltLoop();
          const rule = E.stacks.rule('fall', false, ['rescue']);
          out.preset = rule.value();
          const h = E.mod('fall', { owner: 'game', set: false });
          out.game = rule.value();
          h.remove();
          out.back = rule.value();
          E.dispose();
        }
        console.warn = warn;
        return out;
      });
      check('chosen rescue returns the player, and nothing is told', r.chosen.y > -1 && r.chosen.told === 0, J(r.chosen));
      check('no rule: character:fall fires once and the player stays down', r.none.falls === 1 && r.none.y < -200, J(r.none));
      check('a dev build tells once, naming the fix', r.none.told === 1 && /engine\.mod\('fall'/.test(r.none.text) && /'rescue'/.test(r.none.text), J(r.none));
      check('no rule: a body stays down', r.body < -200, J(r.body));
      check('openWorld chooses rescue, the game overrides it without a conflict, and it comes back', r.preset === 'rescue' && r.game === false && r.back === 'rescue', J(r));
    },
  },
];
