// [guard] Impostor cards for far plants (docs/plans/2026-11-09-impostors.md). Not to be bypassed: beyond lodRing an impostor species is drawn by one
// card mesh per species (render/impostor.tsl.js, built by modules/vegetation/draw.js updateCards), baked from its own model and materials, and it
// reads the chunk meshes' instance arrays, so felling (zero-scale slots) reaches the cards with no path of its own. Run: threedog test "impostor"
export const specs = [
  {
    name: '[guard] impostor cards: fewer draws beyond lodRing than meshes, non-black and close to the mesh colour, felled plants lose their card',
    url: '/tests/impostor/index.html',
    software: true,   // reads rendered pixels
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const r = await ev(() => window.impostorCards());
      console.log('  impostor numbers:', JSON.stringify(r));
      check('no frame error on either engine', r.errors.length === 0, JSON.stringify(r.errors));
      check(`the camera looks over far chunks (${r.far} past lodRing) and the card mesh holds their trees (${r.cardMesh.count}, ${r.cardMesh.layers} baked views)`,
        r.far >= 3 && r.cardMesh.made && r.cardMesh.count > 50 && r.cardMesh.layers === 8, JSON.stringify(r.cardMesh));
      check(`fewer draw calls with cards: ${r.mesh.draws} (meshes) -> ${r.card.draws} (cards)`, r.card.draws < r.mesh.draws, JSON.stringify({ mesh: r.mesh.draws, card: r.card.draws }));
      const [a, b] = [r.mesh.color, r.card.color];
      check(`cards draw the trees, not black or missing: tree pixels ${r.mesh.trees} (meshes) / ${r.card.trees} (cards), within 0.5x to 2x`,
        r.card.trees > 0.5 * r.mesh.trees && r.card.trees < 2 * r.mesh.trees && r.mesh.trees > 100, JSON.stringify({ mesh: r.mesh.trees, card: r.card.trees }));
      check(`card colour close to the mesh colour: ${JSON.stringify(a)} vs ${JSON.stringify(b)} (each channel within 40 levels)`,
        !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) <= 40), JSON.stringify({ mesh: a, card: b }));
      check('a species\' own material: the bake reads a copy without the engine patches (no wind, no season baked in), the drawn material keeps them',
        r.bakeSource.drawn.includes('wind') && !r.bakeSource.baked.some(n => n === 'wind' || n === 'season'), JSON.stringify(r.bakeSource));
      check('the photo path trace leaves the card mesh out (outside its shader it is one quad at the origin) and shows it again after the snapshot',
        r.traced.cardSeen === false && r.traced.shownAgain, JSON.stringify(r.traced));
      check('the untraced line says in plain words that the far plants drawn as impostor cards are not in the traced photo', /far plants drawn as impostor cards/.test(r.traced.untraced), r.traced.untraced);
      check('impostor values that would size a render target wrong throw (views 0 / NaN / 2.5, size 1e5, a string)', r.refused.every(Boolean), JSON.stringify(r.refused));
      check(`felling every far tree hides its card: tree pixels ${r.card.trees} -> ${r.felled.trees}, card slots kept (${r.felledCount})`,
        r.felled.trees < 0.05 * r.card.trees && r.felledCount === r.cardMesh.count, JSON.stringify({ felled: r.felled, count: r.felledCount }));
    },
  },
];
