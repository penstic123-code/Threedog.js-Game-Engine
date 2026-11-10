// @threedog/terrain-noise: a biome rule with plain conditions and `any` needs both (the plain ones used to be ignored when `any` was present).
import { terrainPreset } from '@threedog/terrain-noise';

export const name = 'terrain-noise: a rule\'s plain conditions and its any-list both have to hold';

export async function run({ check }) {
  const p = terrainPreset({ biomes: [{ name: 'forest', minHeight: 20, any: [{ minMoist: 0.5 }, { minRiver: 0.9 }] }, { name: 'plain' }] });
  const n = { params: p.params, fbm: () => 0.8, waterLevel: 0 };   // fbm 0.8: moist 0.8, so the any-list holds everywhere
  check('height 0 is below minHeight: not forest even though the any-list holds', p.groundType(0, 0, 0, 0, n) === 'plain');
  check('[guard] height 30 and the any-list holds: forest', p.groundType(0, 0, 30, 0, n) === 'forest');
  check('[guard] height 30 but no alternative holds: not forest', p.groundType(0, 0, 30, 0, { ...n, fbm: () => 0.1 }) === 'plain');
}
