// Model assets: npm run assets
//   npm run assets -- optimize [--dry] [--force] [--budget MB] [--strict] [--lod [--lod-shares 0.5,0.2]]   Meshopt + KTX2 copies of art/models/ in public/optimized/ (assets-optimize.mjs)
//   the verb is required: optimize writes files, so it never runs by a bare `assets`
//   npm run assets -- check [glb or folder] [--json] [--strict] [--full]   inspect without building: level manifest, material review, statistics
//   -w my-game selects a game (or run inside the game directory)
import { cli } from './paths.mjs';

// one parse for both forms: optimize (--dry --force --budget --strict) and `check [glb or folder]` (--json --strict --against)
const { dir, opt, rest } = cli(process.argv.slice(2), { positional: true, flags: ['force', 'strict', 'json', 'dry', 'lod', 'full'], values: ['against', 'budget', 'lod-shares'] });
if (rest[0] === 'check') {
  if (rest.length > 2) { console.error(`✗ assets check takes one glb or folder, got ${rest.slice(1).join(' ')}`); process.exit(1); }
  process.exit(await (await import('./assets-check/cli.mjs')).runCheck(dir, opt, rest[1]));
}
if (!rest.length) { console.error('✗ say which: `threedog assets optimize` (writes compressed copies to public/optimized/) or `threedog assets check` (only reads)'); process.exit(1); }
if (rest[0] !== 'optimize' || rest.length > 1) { console.error(`✗ unexpected argument "${rest[rest[0] === 'optimize' ? 1 : 0]}": npm run assets -- optimize [--dry] [--force] [--budget MB] · npm run assets -- check [glb or folder]`); process.exit(1); }
if (opt.json || opt.against) { console.error('✗ --json and --against belong to `assets check`'); process.exit(1); }
process.exit(await (await import('./assets-optimize.mjs')).runOptimize(dir, opt));
