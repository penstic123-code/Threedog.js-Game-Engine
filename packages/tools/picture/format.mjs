// The printed picture block: the numbers, then the hints ranked and cut to a few one-sentence lines. --json keeps everything.
import { pc, r2 } from './hint-text.mjs';

/** "noon 0.64 / midnight 0.22", with each time's exposure when the two differ (exposure that changes over the day): an AI then sees
 *  that its own curve lifts the night. Only the numbers, no hint */
function timeLums(t) {
  const en = t.at?.noon?.exposure?.value, em = t.at?.midnight?.exposure?.value;
  const ex = typeof en === 'number' && typeof em === 'number' && Math.abs(en - em) > 0.005;
  return `noon ${r2(t.noon)}${ex ? ` (exposure ${r2(en)})` : ''} / midnight ${r2(t.midnight)}${ex ? ` (exposure ${r2(em)})` : ''}`;
}

/** The printed picture block: at most this many hint lines (the last one says how many more) and this many characters per line */
const HINT_LINES = 4, LINE_MAX = 220;
/** One printed line within LINE_MAX: cut at the last clause break ('; ' or ', ') that fits, the full text stays in --json */
function clipLine(l) {
  if (l.length <= LINE_MAX) return l;
  const head = l.slice(0, LINE_MAX - 12), cut = Math.max(head.lastIndexOf('; '), head.lastIndexOf(', '));
  return (cut > 60 ? head.slice(0, cut) : head) + ' … (--json)';
}

/** Text lines of numbers + probe facts + hints */
export function formatPicture(N, probe, hints, ms = probe?.ms) {
  const sh = probe?.shadows;
  const shadow = !probe ? null : !sh ? 'shadows off' : !sh.sunLit ? 'shadows: sun down or dark' : `shadow area ${pc(sh.area)} (darkened by ${pc(sh.depth)} on average)`;
  const lines = [`Picture: luminance ${N.luminance.toFixed(2)} · contrast ${N.contrast.toFixed(2)} (range p5-p95 ${N.range.toFixed(2)}) · saturation ${N.saturation.toFixed(2)} · overexposed ${pc(N.overexposed)}${N.hotspots ? ` · ${N.hotspots} near-white spot(s)` : ''} · dark ${pc(N.dark)}${shadow ? ` · ${shadow}` : ''}` +
    (probe?.time ? ` · ${timeLums(probe.time)}` : '') + (ms != null ? ` (picture check ${ms} ms)` : '')];
  if (probe?.error) lines.push(`  picture probe skipped: ${probe.error}`);
  if (probe?.unread) lines.push(`  could not be read on a built page: ${probe.unread.join(', ')} (a dev page reads them)`);
  // Short by default, detail on demand: a rainy-night shot printed 4 lines of 400-600 characters (one listed ~17 post names) and the AI had to dig.
  // Contradictions first, then intent, then facts, each by measured size; at most HINT_LINES lines of one sentence, the rest counted
  const rank = { mistake: -1, contradiction: 0, intent: 1, fact: 2 };
  const sorted = [...hints].sort((a, b) => (rank[a.kind] - rank[b.kind]) || ((b.size ?? 0) - (a.size ?? 0)));
  // the fog before the time line, whatever their kinds: a picture mostly fog gets its picture from that fog, and "brightness stays with the lights off"
  // alone sent the AI after the lights (a dark fog at night ate three rounds of color changes)
  const fi = sorted.findIndex(h => h.id === 'fog-cover'), ti = sorted.findIndex(h => h.id === 'time-flat');
  if (fi > ti && ti >= 0) sorted.splice(ti, 0, sorted.splice(fi, 1)[0]);
  const shown = sorted.length > HINT_LINES ? sorted.slice(0, HINT_LINES - 1) : sorted;
  for (const h of shown) lines.push(clipLine(`  ${h.kind}: ${h.brief ?? h.text}`));
  if (shown.length < sorted.length) lines.push(`  ${sorted.length - shown.length} more: threedog shot --json (picture.hints)`);
  if (hints.length) lines.push('  (facts and likely causes, not targets: change what the game wants, or nothing)');
  return lines;
}
