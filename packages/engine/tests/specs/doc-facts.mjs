// Facts that AI-built games guessed wrong because a recipe left them out (docs/testing/capability/composite-round-1.md). Each check reads the code and the recipe together,
// so a change to the value that leaves the recipe behind fails here. Run: npm test -- "doc facts"
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeNoise } from '../../core/stream/scatter.js';
import { bloom } from '../../../post-effects/hdr.js';
import { unknownContent } from '../../modules/content/rules.js';

const recipe = name => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../docs/recipes', name), 'utf8');

export const specs = [
  {
    name: '[guard] doc facts: what the recipes state about noise, bloom, pool lights, content kinds and the canvas holds in the code',
    url: '/tests/terrain-edit/',
    async run({ check }) {
      const n = makeNoise(7);
      let lo = 1, hi = 0;
      for (let i = 0; i < 20000; i++) { const v = n.fbm(i * 0.37, i * 0.11); lo = Math.min(lo, v); hi = Math.max(hi, v); }
      check('fbm stays in 0 to 1 and recipe 28 says so', lo >= 0 && hi <= 1 && hi - lo > 0.3 && /fbm, noise and hash all give 0 to 1/.test(recipe('28-terrain.md')), `${lo} ${hi}`);
      const { strength, radius, threshold } = bloom().params, r52 = recipe('52-around-the-picture.md');
      check('recipe 52 names every bloom option with its real default', r52.includes('`bloom({ strength, radius, threshold })`') && r52.includes(`defaults ${strength}, ${radius}, ${threshold}`), `${strength} ${radius} ${threshold}`);
      check('recipe 09 warns that pool lights pass through walls, and gives a way out', /knows nothing of rooms/.test(recipe('09-materials-lights-models.md')) && /set\(\{ intensity: 0 \}\)/.test(recipe('09-materials-lights-models.md')));
      check('an unknown content kind and recipe 20 both say rules goes in content/index.js', /list `rules` in content\/index\.js/.test(unknownContent('towers', { kinds: {} })) && /Add `recipes` and `rules` to `content\/index\.js`/.test(recipe('20-content-actions-save.md')));
      check('recipe 01 says where the canvas is', recipe('01-new-game.md').includes('engine.renderer.domElement'));
      // the calendar can stop or run fast (recipe 06), so a delay on the scale of an action names its channel; world timers of half a minute and more may stay on the calendar
      const dir = join(dirname(fileURLToPath(import.meta.url)), '../..'), sources = [...readdirSync(join(dir, 'docs/recipes')).map(f => `docs/recipes/${f}`), ...['core', 'modules'].flatMap(d => readdirSync(join(dir, d), { recursive: true }).filter(f => f.endsWith('.js')).map(f => `${d}/${f}`))];
      const short = sources.flatMap(f => readFileSync(join(dir, f), 'utf8').split('\n').filter(l => [...l.matchAll(/clock\.(?:after|every)\((\d+(?:\.\d+)?),/g)].some(m => Number(m[1]) < 30) && !/channel/.test(l)).map(l => `${f}: ${l.trim().slice(0, 90)}`));
      check('no short clock.after / clock.every in the recipes and source examples runs on calendar seconds', !short.length, short.join(' | '));
      check('recipes 02 and 04 send a game to public pages, not engine source or engine tests', !/modules\/content\/rules\.js|npcSim\.js|npm test/.test(recipe('02-npc.md') + recipe('04-quests.md')));
    },
  },
];
