// Content validation: checks that the data in content/ of every game folder (gameDirs in paths.mjs) has no mistakes. npm run check runs it automatically.
//   Run alone: node packages/tools/content-check.mjs
// It finds: duplicate ids, references to items/NPCs/dialogues/quests/places/nodes that do not exist, missing required fields, bad clock-time format,
//   misspelled condition/effect words and key names, flags/counters that are only checked and never set (warning), model names (against the asset
//   packs of assets.js) and places.
// Vocabulary: conditions = the engine's modules/content/rules.js + the game's own content/rules.js; effects = the engine's only (a game's own action is an op).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWorldData } from './content-check/world.mjs';
import { checkQuests } from './content-check/quests.mjs';
import { checkKinds, checkListed } from './content-check/kinds.mjs';
import { checkAudio } from './content-check/audio.mjs';
import { checkViews } from './content-check/views.mjs';
import { checkFields, isObj } from './content-check/fields.mjs';
import { sectionRefs } from './content-check/section-refs.mjs';
import { glbLevels } from './content-check/glb.mjs';
import { writeIndex } from './content-check/index-ids.mjs';
import { cli, within } from './paths.mjs';
import { item, result, startJson } from './lib/result.mjs';
import { KEYBOARD_CODE, gameCodeFiles, read } from './lib/text.mjs';
import { actionUsed } from './gamemap/codeScan.mjs';
import { noComments } from './gamemap/text.mjs';
import { rel, findGames, loadGame, dupKeys, gameAssets, missingAssetFiles, levelIsFile, mergeRules, CLOCK_RE, NO_GAME_EFFECTS } from './content-check/load.mjs';

// Mouse buttons and gamepad buttons are keys too (core/input/inputPointer.js, core/input/inputPad.js): an attack on Mouse0 or PadX is a normal content action
const KEY_RE = new RegExp(`^(${KEYBOARD_CODE}|Mouse[0-4]|Pad(A|B|X|Y|LB|RB|LT|RT|Select|Start|L3|R3|Up|Down|Left|Right))$`);

/** Validate one game folder, returning { errors: [], warnings: [] } (English) */
export async function checkGame(dir) {
  const { data: c, files, parts, errors, warnings } = await loadGame(dir);
  const at = kind => rel(files[kind] || join(dir, 'content', kind + '.js'));
  const known = (o, n = 8) => { const ks = Object.keys(o || {}); return ks.length ? ks.slice(0, n).join(', ') + (ks.length > n ? '…' : '') : '(none yet)'; };
  const err = (kind, msg) => errors.push(`${at(kind)}: ${msg}`);
  const warn = (kind, msg) => warnings.push(`${at(kind)}: ${msg}`);

  // 1. Duplicate ids / keys
  for (const [kind, list] of Object.entries(parts)) for (const { path } of list) {   // every file of a kind (a folder kind has several)
    for (const d of dupKeys(readFileSync(path, 'utf8'))) errors.push(`${rel(path)}: `
      + `"${d.key}" on line ${d.line} is a duplicate (line ${d.first} already has one); the later one silently overwrites the earlier`);
  }
  // The id index (.threedog/content-index.json) that content write-back uses to open only the one file it edits; cross-file duplicate ids land here
  const index = writeIndex(dir, c, parts);
  errors.push(...index.errors); warnings.push(...index.warnings);

  // The game's code outside content/ (main.js, game/, picture/, plugins/): what "used in code" and "set in code" below read
  const code = gameCodeFiles(dir).filter(f => !within(f, join(dir, 'content'))).map(f => noComments(read(f))).join('\n');
  const items = c.items || {}, quests = c.quests || {}, dialogues = c.dialogues || {}, npcs = c.npcs || {};
  const { conditions: CONDITIONS, effects: EFFECTS } = mergeRules(c.rules);
  if (c.rules?.effects) err('rules', NO_GAME_EFFECTS);
  const markers = c.level?.markers || {};
  const glb = await glbLevels(dir, c);   // markers read from the level .glb
  errors.push(...glb.errors);
  const places = { ...(c.places || {}), ...markers, ...glb.places };
  const flagsSet = new Set([...code.matchAll(/flags\.(\w+)\s*=(?!=)|setFlag\('(\w+)'/g)].map(m => m[1] ?? m[2]));
  const countersBumped = new Set([...code.matchAll(/bump\('(\w+)'/g)].map(m => m[1]));
  const flagsUsed = [], countersUsed = [];
  // Model / sound names: the asset packs the game exports from assets.js and registers at run time (one source, no scanning of source text)
  const assets = await gameAssets(dir), levelFile = levelIsFile(code);
  if (assets.error) errors.push(assets.error);
  errors.push(...missingAssetFiles(dir, assets));
  let noAssetsNoted = false;
  // Content is data that names assets: a file path or a function in a model field is an error (the file / generator belongs in an asset pack)
  const checkModel = (kind, what, m) => {
    if (typeof m === 'function') return err(kind, `${what} gives a function as its model; content is data: register the generator in an asset pack (engine.assets.manifest({ models: { name: fn } })) and write its name`);
    if (typeof m === 'string' && /[/\\]|\.(glb|gltf|fbx|obj|png|jpe?g|webp|ktx2)$/i.test(m)) return err(kind, `${what} names the model "${m}" as a file path; content names assets only: register the file in an asset pack or assets.manifest({ models: { name: '${m}' } }) and write the name`);
    if (assets.models.has(m) || assets.error) return;   // a broken assets.js is reported once above, not once per model
    if (!assets.file) { if (!noAssetsNoted) err(kind, `${what} names the model "${m}", but the game has no assets.js: export the asset packs main.js registers `
      + `(export default [pack, ...]; main.js: engine.assets.manifest(packs)) so this check reads the same names the game does`); noAssetsNoted = true; return; }
    err(kind, `the model "${m}" of ${what} is in no asset pack of assets.js (models: ${[...assets.models].join(', ') || '(none)'})`);
  };

  // Collect the flags/counters set by effects (scan once first, to later judge "only checked, never set")
  const walkEffects = (fn) => {
    for (const d of Object.values(dialogues)) for (const n of Object.values(d?.nodes || {})) { fn(n.do); for (const ch of n.choices || []) fn(ch.do); }
    for (const q of Object.values(quests)) { fn(q?.reward); fn(q?.onUnpaid); fn(q?.onFail); }
    for (const t of Object.values(c.triggers || {})) { fn(t?.onEnter); fn(t?.onExit); }
  };
  walkEffects(a => { for (const x of [a].flat()) if (isObj(x)) { if (x.setFlag) flagsSet.add(x.setFlag); if (x.bump) countersBumped.add(x.bump); } });

  // Every word in conditions / effects and the ids it references
  const checkRefs = (kind, where, v, vocab, what) => {
    if (!v || typeof v === 'function') return;
    for (const x of [v].flat()) {
      if (!isObj(x)) { err(kind, `${what} of ${where} must look like { word: value }, got ${JSON.stringify(x)}`); continue; }
      for (const [word, val] of Object.entries(x)) {
        const spec = vocab[word];
        if (!spec) { err(kind, `${what} of ${where} has an unknown word "${word}" (available: ${Object.keys(vocab).join(', ')})`); continue; }
        const type = spec.ref;
        if (type === 'itemCounts' || type === 'counterCounts') {
          if (!isObj(val)) { err(kind, `"${word}" of ${where} must be written as { name: count }`); continue; }
          for (const [id, n] of Object.entries(val)) {
            if (typeof n !== 'number' || n <= 0) err(kind, `the count of ${id} in "${word}" of ${where} must be positive, got ${JSON.stringify(n)}`);
            if (type === 'itemCounts' && !items[id]) err(kind, `${where} needs item ${id}, which does not exist (existing items: ${known(items)})`);
            if (type === 'counterCounts') countersUsed.push([kind, where, id]);
          }
        } else if (type === 'flag') { if (word !== 'setFlag') flagsUsed.push([kind, where, val, word]); }
        else if (type === 'quest' && !quests[val]) err(kind, `${where} starts quest ${val}, which does not exist (existing quests: ${known(quests)})`);
        else if (type === 'particles' && !(isObj(val) && val.name && Array.isArray(val.at) && val.at.length === 3))
          err(kind, `particles of ${where} must be written as { name: 'particleName', at: [x, y, z], count: number }`);
        else if (type === 'clock' && !(typeof val === 'string' && CLOCK_RE.test(val))) err(kind,
          `"${word}" of ${where} must be 'HH:MM' (24-hour), got ${JSON.stringify(val)}`);
        else if (type === 'position') checkPos(kind, `"${word}" of ${where}`, typeof val === 'string' ? { place: val } : val);
        else if (type === 'op' && !(Array.isArray(val) && /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/.test(val[0]) && (val[1] === undefined || isObj(val[1])))) err(kind,
          `"${word}" of ${where} must be ['noun.verb', { args }], e.g. ['shop.buy', { item: 'bread' }]; got ${JSON.stringify(val)}`);
      }
    }
  };
  const checkPos = (kind, where, p) => {
    if (!isObj(p)) { err(kind, `${where} has no position (write { place: 'placeName', x, z } or { x, z })`); return; }
    if (p.place !== undefined && !places[p.place]) err(kind,
      `${where} uses place ${p.place}, which does not exist (existing places: ${known(places)}; places are written in places.js or in the markers of level.js)`);
    if (p.place === undefined && (typeof p.x !== 'number' || typeof p.z !== 'number')) err(kind, `${where} has no place, so it must have numeric x and z`);
    for (const k of ['y', 'floor']) if (p[k] !== undefined && typeof p[k] !== 'number') err(kind,
      `${k} of ${where} must be a number (floor: reference height of the storey it stands on; y: meters above that ground)`);
  };

  // 2. Items
  for (const [id, it] of Object.entries(items)) if (!it?.name) err('items', `item ${id} has no name (the displayed name)`);
  for (const [id, n] of Object.entries(c.startItems || {})) {
    if (items[id] && !(n > 0)) err('startItems', `the count of starting item ${id} must be positive`);
  }

  // 3. Pickups
  (c.pickups || []).forEach((p, i) => {
    const where = `pickup #${i + 1}`;
    if (!p?.item) err('pickups', `${where} has no item (which item it is)`);
    checkPos('pickups', where, p);
  });

  // 4. Dialogues
  for (const [id, d] of Object.entries(dialogues)) {
    const nodes = d?.nodes;
    if (!isObj(nodes)) { err('dialogues', `dialogue ${id} has no nodes (the node table)`); continue; }
    if (!nodes.start) err('dialogues', `dialogue ${id} has no start node (a dialogue always begins at start)`);
    const goTo = (where, next) => { if (next !== undefined && next !== 'end' && !nodes[next]) err('dialogues',
      `dialogue ${id} ${where} goes to node ${next}, which does not exist (existing nodes: ${known(nodes, 12)}, or write 'end' to finish)`); };
    for (const [nid, n] of Object.entries(nodes)) {
      const where = `node ${nid} of dialogue ${id}`;
      if (n.text === undefined) err('dialogues', `${where} has no text (the line)`);
      if (Array.isArray(n.text)) {
        n.text.forEach((v, i) => { if (!v?.text) err('dialogues', `line variant #${i + 1} of ${where} has no text`); checkRefs('dialogues',
          `line variant #${i + 1} of ${where}`, v?.if, CONDITIONS, 'condition if'); });
        if (n.text.at(-1)?.if) warn('dialogues',
          `the last line variant of ${where} has a condition, so when none holds there is no line; better not to write if on the last one`);
      }
      checkRefs('dialogues', where, n.do, EFFECTS, 'effect do');
      goTo(`of node ${nid}`, n.next);
      (n.choices || []).forEach((ch, i) => {
        const w = `option #${i + 1} of ${where}`;
        if (!ch.text) err('dialogues', `${w} has no text`);
        checkRefs('dialogues', w, ch.if, CONDITIONS, 'condition if');
        checkRefs('dialogues', w, ch.do, EFFECTS, 'effect do');
        goTo(`of node ${nid} option #${i + 1}`, ch.next);
      });
    }
  }

  // 5. NPC
  const talked = new Set();
  for (const [id, n] of Object.entries(npcs)) {
    const where = `NPC ${id}`;
    if (!n?.name) err('npcs', `${where} has no name (the displayed name)`);
    // dialogue is the interact op npc.talk; its script defaults to the NPC id
    const talk = n?.interact?.op === 'npc.talk' ? n.interact.args?.script ?? id : undefined;
    if (talk !== undefined) { talked.add(talk); if (!dialogues[talk]) err('npcs',
      `the dialogue ${talk} that ${where} talks with (interact: { op: 'npc.talk' }) does not exist (existing dialogues: ${known(dialogues)})`); }
    if (n?.start) checkPos('npcs', `start of ${where}`, n.start);
    if ((n?.behavior ?? 'schedule') !== 'schedule') { if (!n.start) err('npcs', `${where} does not follow a schedule, so it needs start`); continue; }
    // no schedule + start = an NPC standing at start (a shopkeeper, quest giver): the schedule behavior with no stops has no goal (recipe 02)
    if (n?.schedule !== undefined && !Array.isArray(n.schedule)) { err('npcs', `the schedule of ${where} must be a list of stops [{ at: 'HH:MM', place }]`); continue; }
    if (!n?.schedule?.length) { if (!n?.start) err('npcs', `${where} has no position: give start (it stands there) or a schedule (at least one stop)`); continue; }
    let prev = '';
    n.schedule.forEach((s, i) => {
      const w = `schedule entry #${i + 1} of ${where}`;
      if (typeof s.at !== 'string' || !CLOCK_RE.test(s.at)) err('npcs',
        `the time at of ${w} must be 'HH:MM' (24-hour, e.g. '06:00', '19:30'), got ${JSON.stringify(s.at)}`);
      else { if (s.at <= prev) warn('npcs',
        `the time ${s.at} of ${w} is not later than the previous entry ${prev}; better to write the schedule in time order`); prev = s.at; }
      checkPos('npcs', w, s);
    });
  }
  for (const id of Object.keys(dialogues)) if (!talked.has(id) && !code.includes(`'${id}'`)) warn('dialogues',
    `dialogue ${id} is used by no NPC (talk in npcs.js) and is not mentioned in the code, so it may be unused`);

  // 6. Quests
  checkQuests({ c, items, npcs, code, err, warn, checkRefs, checkPos, isObj, known, CONDITIONS, EFFECTS });

  // 7. Key actions
  for (const [name, a] of Object.entries(c.actions || {})) {
    if (!Array.isArray(a?.keys) || !a.keys.length) { err('actions', `key action ${name} has no keys (the default key list, e.g. ['KeyK'])`); continue; }
    for (const k of a.keys) if (!KEY_RE.test(k)) err('actions',
      `the key name ${k} of key action ${name} is wrong (letter keys are 'KeyA', digits 'Digit1', space 'Space', function keys 'F5', mouse buttons 'Mouse0', gamepad 'PadA')`);
    if (!a.label) err('actions', `key action ${name} has no label (the text shown in the settings menu)`);
    if (!actionUsed(code, name)) warn('actions',
      `key action ${name} is registered but the game code never uses it (engine.input.pressed('${name}'))`);
  }

  // 8. Level markers, trigger zones
  for (const [name, m] of Object.entries(markers)) if (typeof m?.x !== 'number' || typeof m?.z !== 'number') err('level',
    `marker ${name} needs numeric x and z`);
  for (const [tag, t] of Object.entries(c.triggers || {})) {
    const where = `trigger zone ${tag}`;
    // trigger_ nodes of .glb levels come from glb.mjs; with no readable file, level.js need not have them
    if (t?.fromLevel) { if (!(glb.levels.length ? glb.tags.has(tag) : levelFile) && !markers['trigger_' + tag]) err('triggers',
      `${where} says it comes from the level, but level.js has no marker trigger_${tag} (existing markers: ${known(markers)})`); }
    else checkPos('triggers', `position of ${where}`, t?.position);
    checkRefs('triggers', `onEnter of ${where}`, t?.onEnter, EFFECTS, 'effect');
    checkRefs('triggers', `onExit of ${where}`, t?.onExit, EFFECTS, 'effect');
  }

  // Ids the sections name that name nothing: each section's own `references` (startItems, containers, pickups, quest targets), read once for every tool
  for (const r of await sectionRefs(c)) if (!c[r.names]?.[r.id]) err(r.at.split(/[.[]/)[0], `${r.at} names ${r.names.replace(/s$/, '')} ${r.id}, which does not exist (existing ${r.names}: ${known(c[r.names] || {})})`);

  // 9. Containers, vegetation, props
  checkWorldData({ c, items, err, warn, checkModel, checkPos, isObj, known });

  // 10. Audio (sounds by asset name, rules as data)
  checkAudio({ c, err, warn, isObj, known, code, sounds: assets.sounds });
  checkViews({ c, err, isObj });
  // every entry against its field table (keys, types, ranges, values): the tables engine.content.fields() returns
  checkFields({ c, err });

  // 11. The game's vocabulary and its own content kinds
  checkKinds({ c, err, warn, known });
  checkListed({ dir, c, files, code, err, warn });
  for (const [word, d] of Object.entries(c.rules?.conditions || {})) {
    if (typeof d?.test !== 'function') err('rules', `"${word}" in conditions has no test function`);
    if (!d?.desc) warn('rules', `"${word}" in conditions should have a one-line desc (the game map uses it)`);
  }

  // 12. Flags and counters that are only checked, never set
  for (const [kind, where, f, word] of flagsUsed) if (!flagsSet.has(f)) warn(kind,
    `${where} checks story flag ${f}, but nothing sets it (setFlag or flags.${f} = … in code), so this condition ${word === 'notFlag' ? 'always holds' : 'can never be met'}`);
  for (const [kind, where, k] of countersUsed) if (!countersBumped.has(k)) warn(kind,
    `${where} checks counter ${k}, but nothing increases it (bump or vars.bump('${k}') in code), so this condition can never be met`);

  return { errors, warnings };
}

// Run directly: validate all games
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let nErr = 0, nWarn = 0;
  // -w (or the current folder) narrows the run to the games inside that workspace (the engine's examples, or one game)
  const { dirs, named, opt } = cli(process.argv.slice(2), { workspace: 'targets', flags: ['json'] });
  const games = findGames().filter(g => !named || dirs.some(d => within(g, d)));
  // --json: one result (lib/result.mjs); the messages are "<file>: <text>" strings, so the file is split off. Content checks have no code of their own
  const jsonItems = [];
  const toItem = (level, s) => { const m = /^(\S+?): (.*)$/s.exec(s); return item({ code: 'content', level, file: m?.[1], message: m ? m[2] : s }); };
  if (opt.json) startJson(code => result(jsonItems, `content validation: ${nErr} errors, ${nWarn} warnings`, code === 0));
  for (const dir of games) {
    const { errors, warnings } = await checkGame(dir);
    jsonItems.push(...errors.map(e => toItem('error', e)), ...warnings.map(w => toItem('warn', w)));
    for (const e of errors) console.log('✗ ' + e);
    for (const w of warnings) console.log('! ' + w);
    nErr += errors.length; nWarn += warnings.length;
  }
  console.log(`Content validation: ${nErr} errors, ${nWarn} warnings (${games.map(rel).join(', ')})`);
  process.exit(nErr ? 1 : 0);
}
