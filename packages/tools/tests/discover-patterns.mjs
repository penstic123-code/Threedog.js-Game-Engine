// Reminder code-shape bank (fixtures/discover/patterns.mjs) against rule R40's scanner. Guards the two ways a reminder goes wrong:
// it fires on ordinary code (readers learn to ignore it) or stays silent on the shape it exists for.
import { scanText } from '../rules/R40-bypass-hints.mjs';
import { PATTERNS } from './fixtures/discover/patterns.mjs';

export const name = 'discover patterns: reminders fire on hand-made shapes and stay quiet on ordinary code';

export async function run({ check }) {
  const kinds = code => scanText(code + '\n').map(r => r.kind);
  const quiet = PATTERNS.filter(p => !p.fires), loud = PATTERNS.filter(p => p.fires);
  const noisy = quiet.filter(p => kinds(p.code).length).map(p => `${p.id} -> ${kinds(p.code)}`);
  check(`must-stay-quiet lines: 0 reminders on ${quiet.length}${noisy.length ? ' (' + noisy.join('; ') + ')' : ''}`, noisy.length === 0);
  const missed = loud.filter(p => !kinds(p.code).includes(p.fires));
  const rate = (loud.length - missed.length) / loud.length;
  check(`must-fire lines: ${loud.length - missed.length}/${loud.length} (${Math.round(rate * 100)}%, at least 70%)${missed.length ? ' missed: ' + missed.map(p => p.id).join(', ') : ''}`, rate >= 0.7);
}
