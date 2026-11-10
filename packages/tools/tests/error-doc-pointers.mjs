// Doc pointers of error codes and error hints (no browser). Why: an AI that reads an error should be sent to the paragraph that explains it, not to a 30 KB
// recipe page it then has to search. So every docs entry must parse (parseDocRef), name a file that exists, and a § / "heading" selector must resolve to a real
// section (readSection); a recipe entry with no section is an error unless the code is in PAGE_LEVEL below, with the reason no single section fits.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ERROR_HINTS, parseDocRef } from 'threedog/error-hints';
import { readSection } from '../how.mjs';
import { DOCS_REL, ROOT, ENGINE } from '../paths.mjs';

export const name = 'Error doc pointers: every code and hint docs entry parses, exists and points at one section';

// code (or code@recipe) -> why the whole page is the right pointer. A new entry here needs a reason a reader can check; the default is a section.
const PAGE_LEVEL = {
  'clock-interval': 'the time words are spread over the page (calendar seconds, fixed steps, timers); no one section holds the rule',
  'clock-time': 'time strings are used in many sections (URL, calendar, sky, schedules)',
  'calendar-option': 'calendar options are spread over the page',
  'asset-name-clash': 'the clash is across asset types; the page has no single paragraph for it',
  'asset-cache': 'the dev model cache is described in passing in several sections',
  'asset-misuse': 'covers three different misuses (unknown model, wrong copy, params), each in another section',
  'asset-missing-ref': 'a missing texture or .bin is a file problem the page mentions in several sections',
  'asset-not-loaded': 'modelNow is mentioned in passing, not taught in a section of its own',
  'asset-load': 'the reason is in the message; the page has no section for load failures',
  'pure-function@recipes/18-world.md': 'worker functions are taught in the perf page; the world page only mentions them',
  'stream-timeout': 'teleport loading is described in passing',
  'world-option': 'world options are spread over the page',
  'world-id': 'ids are explained in several sections',
  'world-record': 'a missing record has no section of its own',
  'world-add': 'world.add is used in every section',
  'world-present': 'present() is used in several sections',
  'module-needs': 'a module that is not installed: the page has no section on it',
  'module-name': 'the name rule is not in a section of its own',
  'input-keys': 'key names are listed in passing',
  'module-called': 'engine.use is used in every section',
  'interaction-setup': 'interactions() presets are mentioned in several sections',
  'open-world-camera': 'the camera option of openWorld is mentioned in passing',
  'batching-option': 'batching options are described in the props recipe, not in this page',
  'stream-option@recipes/33-stream-sources.md': 'the page is short and has no sections: source options sit in its one table',
  'grid-data': 'sampleGrid / gridFromImage input rules are spread over the page',
  'shadow-cascades': 'the page is short and its sections each cover part of the call',
  'camera-clamped': 'the clamps are listed in several sections',
  'camera-kind': 'camera kinds are spread over the page',
  'camera-none': 'no section covers installing a camera module',
  'character-option': 'character options are spread over the page',
  'content-misuse': 'covers many different content mistakes',
  'content-template': 'covers many different template mistakes',
  'inventory-misuse': 'covers item id rules spread over the page',
  'grids-misuse': 'covers many different grids() mistakes',
  'content-layer-ignored': 'collide.layer is mentioned in passing',
  'level-node': 'level nodes are described in several sections',
  'net-option': 'net() options are described in the install and security sections together',
  'sky-option': 'sky options are spread over the page',
  'terrain-option': 'terrain options are spread over the page',
  'water-option': 'water options are spread over the page',
  'weather-option': 'weather options are spread over the page',
  'ui-misuse': 'covers many different ui calls',
  'renderer-backend': 'the whole page is about the renderer route',
  'nav-build': 'the builder failure has no section of its own',
  'state-value': 'applyState keys are listed in the usage section together with others',
  'pickup-misuse': 'pickups.spawn is taught across sections',
  'tsl-misuse': 'covers many different threedog/tsl mistakes',
  'swarm-step': 'onStep is taught in passing',
  'swarm-field': 'columns are described in several sections',
  'swarm-disposed': 'dispose is mentioned in passing',
  'webgpu-records-unread': 'a three upgrade problem, no section teaches it',
  'describe-name': 'describe.add is described in several sections',
  'hud-option': 'hud options are spread over the page',
  'interaction-option': 'interactions.add options are spread over the page',
};
// a hint id (ERROR_HINTS) is allowed page-level only through this list too
const PAGE_LEVEL_HINTS = {
  'not-installed': 'a generic TypeError; the new-game page is the starting point, not one section',
  'null-value': 'a generic JavaScript null; the dev-bridge page is the starting point',
};

export async function run({ check }) {
  // the table by the engine path, as api-count reads it (tools never import the engine by a relative path: R-rule on tool imports)
  const { ERROR_CODES } = await import(pathToFileURL(join(ENGINE, 'core/base/errorCodes.js')).href);
  const docsDir = join(ROOT, DOCS_REL);
  const entries = [
    ...Object.entries(ERROR_CODES).flatMap(([id, v]) => v.docs.map(d => ({ id, d, allow: PAGE_LEVEL }))),
    ...ERROR_HINTS.flatMap(h => h.docs.map(d => ({ id: h.id, d, allow: PAGE_LEVEL_HINTS }))),
  ];
  const bad = { parse: [], file: [], section: [], page: [] };
  for (const { id, d, allow } of entries) {
    const r = parseDocRef(d);
    if (!r) { bad.parse.push(`${id}: ${d}`); continue; }
    if (!existsSync(join(docsDir, r.file))) { bad.file.push(`${id}: ${d}`); continue; }
    const hasSel = r.sec || r.title || r.anchor;
    if (hasSel && !readSection(docsDir, d)) bad.section.push(`${id}: ${d}`);
    if (!hasSel && r.file.startsWith('recipes/') && !(allow[id] || allow[id + '@' + r.file])) bad.page.push(`${id}: ${d}`);
  }
  check('every docs entry parses with parseDocRef', !bad.parse.length, bad.parse.join('; '));
  check('every docs entry names a file that exists', !bad.file.length, bad.file.join('; '));
  check('every § / "heading" selector resolves to a real section', !bad.section.length, bad.section.join('; '));
  check('[guard] a recipe entry without a section is an error unless the code is in the page-level list', !bad.page.length, bad.page.join('; '));
  // the list cannot rot: an entry that now has a section, or whose code is gone, must leave it
  const stale = Object.keys(PAGE_LEVEL).filter(k => !entries.some(e => e.allow === PAGE_LEVEL && (e.id === k || e.id + '@' + parseDocRef(e.d)?.file === k) && !/§|"/.test(e.d)));
  check('every page-level exception still applies (code exists and its entry has no section)', !stale.length, stale.join(', '));
  const staleH = Object.keys(PAGE_LEVEL_HINTS).filter(k => !entries.some(e => e.allow === PAGE_LEVEL_HINTS && e.id === k && !/§/.test(e.d)));
  check('every page-level hint exception still applies', !staleH.length, staleH.join(', '));
}
