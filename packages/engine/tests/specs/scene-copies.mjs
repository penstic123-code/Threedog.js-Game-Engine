// [guard] Scene copies (core/scene/drawOnly.js): the engine marks what it draws for something else, and what copies the game's scene
// leaves every marked object out. Not to be bypassed: on WebGLRenderer the cascades' copies of the sun (render/cascades.js) carry the sun's
// colour and intensity, and the photo path trace and the gallery's 'game' light each saw one sun per cascade (3 x 2 = 6) before. The impostor
// cards' half of the rule is checked in tests/specs/impostor.mjs. Run: threedog test "scene copies"
const J = JSON.stringify;
export const specs = [
  {
    name: '[guard] scene copies: the path trace and the gallery see one sun under WebGL cascaded shadows, not one per cascade',
    url: '/tests/scene-copies/index.html',
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const r = await ev(() => window.sceneCopies());
      check(`the scene really holds the cascades' copies of the sun (${r.scene.n} directional lights shown)`, r.scene.n >= 3, J(r));
      check(`the path trace snapshot sees one sun at its own intensity (${r.traced.n} lights, ${r.traced.sum})`, r.traced.n === 1 && r.traced.sum === r.sun, J(r));
      check(`the gallery's game light copies one sun (${r.gallery.n} lights, ${r.gallery.sum})`, r.gallery.n === 1 && r.gallery.sum === r.sun, J(r));
      check("a game's clone of a marked cascade light is not marked (three's clone() must not carry the marker)", r.clone.marked && !r.clone.copied, J(r.clone));
      check('after the snapshot the copies of the sun are shown again', r.back.n === r.scene.n, J(r));
    },
  },
];
