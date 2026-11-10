// AI tools, node side: the error hint table (core/base/errorHints.js) and the describe snapshot comparison (describe-snapshot.mjs). Run: npm test -- "AI tools"
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ERROR_HINTS, hintFor, parseDocRef } from 'threedog/error-hints';
import { pickGameplay, diffDescribe, saveSnapshot, compareSnapshot, changeLine } from '../describe-snapshot.mjs';
import { DOCS_REL, ROOT } from '../paths.mjs';

export const name = 'AI tools: error hint table and describe snapshots (node)';

// Real messages: the engine's own carry their [code] tag (codedError / coded), JavaScript / browser ones are plain and land on a pattern;
// each must land on the listed id
const SAMPLES = {
  'fall-prevent': 'e.preventDefault is not a function',
  'thing-explain': 'engine.thing(...).explain is not a function',
  'frozen-definition': "Cannot assign to read only property 'opened' of object '#<Object>'",
  'module-requires': 'module npcs requires module "world", which is not installed [module-requires]',
  'module-cycle': 'module order forms a cycle: a -> b -> a (check before / after on these modules) [module-cycle]',
  'module-stage': 'module x has stage "gamplay", which is not a stage; available stages: control, gameplay [module-stage]',
  'module-name': 'module name sky clashes with an existing engine property; pick another name [module-name]',
  'module-called': 'engine.use received the module function sky itself; call it: sky() [module-called]',
  'describe-name': "describe.add('range'): this name is already taken; pick another (existing fields, module names and previously registered names cannot be reused) [describe-name]",
  'module-needs': 'characters.addPlayer() needs world() installed first: the player is a record in world [module-needs]',
  'world-plain': 'world data must be plain values (number, string, boolean, array, plain object): x is a function. Put models in world.present() [world-plain]',
  'world-id': 'world.add(): id "crate_1" already exists. Omit id to auto-number [world-id]',
  'world-record': 'world.get(): no record with id "ghost" (world.query({ kind }) lists what exists) [world-record]',
  'world-add': 'world.add() needs a kind (what sort of thing this is) [world-add]',
  'world-present': "build of world.present('crate') returned undefined (record c1): build must return a three.js object [world-present]",
  'bad-position': 'npcs.add: position is not a valid number (got [null,0,1]). Common cause: a Vector3 used as an array [bad-position]',
  'content-place': 'Place "dock" not found: give its coordinates in the places of content.load, or add this marker to the level [content-place]',
  'container': "inventory.transfer: from container 'chest' does not exist: create it first with inventory.container('chest', { capacity }) [container]",
  'npc-behavior': 'no NPC behavior named "patrol". Registered: wander. Register a custom behavior first [npc-behavior]',
  'unknown-option': 'npcs.add(): unknown option "shedule", did you mean `schedule`? [unknown-option]',
  'unknown-name': 'action "jupm" does not exist, did you mean `jump`? (available: jump, run) [unknown-name]',
  'event-typo': 'event "quest:compleet" was never emitted or listened to; did you mean `quest:complete`? [event-typo]',
  'owned-prop': 'sun.intensity was changed outside the engine, so the engine stopped writing it (auto-yield) [owned-prop]',
  'camera-kind': "setCamera() has no camera kind 'topdown'; available: follow, first [camera-kind]",
  'movement': 'movement.walk must be a positive number; got undefined [movement]',
  'commit-fallback': 'commits.request() needs a fallback: it is computed on the main thread when due [commit-fallback]',
  'asset-critical': 'Startup blocked: 1 critical item(s) failed to load, the game cannot start: [asset-critical]',
  'asset-missing-ref': 'Asset loaded with missing references: model "pig" <- /models/pig.gltf (missing /models/pig.png) [asset-missing-ref]',
  'asset-load': 'Asset failed to load: models/pig.glb (404 Not Found) [asset-load]',
  'audio-unsupported': 'Audio is not supported by this browser; check typeof AudioContext before calling [audio-unsupported]',
  'indexeddb': 'indexedDB is unavailable [indexeddb]',
  'gameplay-frozen': '[engine] listener of event quest:done threw and gameplay is frozen (in dev / tests a gameplay error fails hard) [gameplay-frozen]',
  'module-disabled': '[engine] picture module particles threw and was disabled (the game continues) [module-disabled]',
  'not-installed': "Cannot read properties of undefined (reading 'give')",
  // a read on null is not "not installed" (a three.js mergeGeometries that returned null got that hint once)
  'pause-guess': 'engine.time.pause is not a function',
  'null-value': "Cannot read properties of null (reading 'boundingSphere')",
  'not-function': 'engine.inventory.giv is not a function',
  'resource-load': 'Failed to load <img> /textures/grass.png',
};

export async function run({ check }) {
  const ids = ERROR_HINTS.map(h => h.id);
  check('hint table: 3-8 classes (only messages the engine does not write) with unique ids', ids.length >= 3 && ids.length <= 8 && new Set(ids).size === ids.length, String(ids.length));
  const wrong = Object.entries(SAMPLES).filter(([id, msg]) => hintFor(msg)?.id !== id).map(([id, msg]) => `${id} -> ${hintFor(msg)?.id}`);
  check('a read-only property of a three.js object (position, rotation) gets no frozen-definition hint',
    hintFor("Cannot assign to read only property 'position' of object '#<Ca>'") === null && hintFor("Cannot assign to read only property 'position' of object '#<Mesh>'") === null);
  check('every sample message lands on its own class', wrong.length === 0, wrong.join('; '));
  check('every pattern class has a sample in this test', ids.every(id => id in SAMPLES), ids.filter(id => !(id in SAMPLES)).join(', '));
  const docs = ERROR_HINTS.flatMap(h => h.docs.map(d => [h.id, d])).filter(([, d]) => !existsSync(join(ROOT, DOCS_REL, parseDocRef(d)?.file ?? d)));
  check('every doc page a hint points at exists (relative to the package docs)', docs.length === 0, docs.map(x => x.join(': ')).join('; '));

  const d = { perf: { fps: 60 }, time: { real: 12.3, clock: '12:00' }, player: { x: 10, y: 1, z: 5, state: 'idle' }, nearby: [{ name: 'Hen', dist: 3 }, { name: 'Pig', dist: 8 }], quests: { active: [{ id: 'q1', step: 'talk' }] } };
  const pu = pickGameplay({ ui: { windows: [], parts: { 'hud.button': 'default', 'hud.hint': 'off', toast: 'custom' } }, warnings: ['engine said'], player: { x: 1 } });
  check('pickGameplay: ui keeps only the parts the game replaced, warnings are dropped (engine-owned data)', JSON.stringify(pu) === '{"player":{"x":1},"ui":{"parts":{"toast":"custom"},"windows":[]}}', JSON.stringify(pu));
  const p = pickGameplay(d);
  check('pickGameplay: drops perf and time.real, keeps the rest; only keeps dotted paths', !('perf' in p) && !('real' in p.time) && p.time.clock === '12:00' && JSON.stringify(Object.keys(pickGameplay(d, { only: ['player.x', 'quests'] }))) === '["player","quests"]');
  const cur = JSON.parse(JSON.stringify(d));
  cur.perf.fps = 5; cur.time.real = 99; cur.player.x = 10.3;   // noise only
  check('diff: perf / elapsed / jitter within tolerance are not differences', diffDescribe(pickGameplay(d), pickGameplay(cur)).length === 0);
  cur.player.x = 14; cur.nearby.reverse(); cur.nearby.push({ name: 'Cow', dist: 9 }); cur.quests.active[0].step = 'deliver'; cur.time.clock = '13:00';
  const lines = diffDescribe(pickGameplay(d), pickGameplay(cur));
  check('diff: readable lines for a number, an added item, a changed string; a reordered list is not a change',
    lines.length === 4 && lines.some(l => /^player\.x: 10 -> 14 \(changed 4, tolerance 0\.5\)/.test(l)) && lines.some(l => l.startsWith('nearby[Cow]: added'))
    && lines.some(l => l.includes('quests.active[q1].step: "talk" -> "deliver"')) && lines.some(l => l.includes('time.clock: "12:00" -> "13:00"')), lines.join(' | '));
  check('diff: tolerance per path overrides the default', diffDescribe(pickGameplay(d), pickGameplay(cur), { tolerance: { default: 0.5, player: 5 } }).every(l => !l.startsWith('player.x')));

  const dir = mkdtempSync(join(tmpdir(), 'threedog-snap-'));
  try {
    const miss = compareSnapshot(dir, 'x', d);
    check('compare without a baseline says how to create one', !miss.ok && /snap-describe save x/.test(miss.text), miss.text);
    saveSnapshot(dir, 'x', d, { only: ['player'] });
    check('compare: same state passes, a changed one gives text with the update command',
      compareSnapshot(dir, 'x', d, { only: ['player'] }).ok && /player\.x: 10 -> 14[\s\S]*snap-describe save x/.test(compareSnapshot(dir, 'x', cur, { only: ['player'] }).text));
    // [guard] an --only path that exists nowhere compares nothing, and nothing always "matches"
    check('[guard] an --only path that stops halfway compares nothing and fails', !compareSnapshot(dir, 'x', d, { only: ['player.typo'] }).ok);
const none = compareSnapshot(dir, 'x', d, { only: ['nosuch'] });
    check('compare: an only path on neither side fails, it does not pass on nothing', !none.ok && /nothing to compare at nosuch/.test(none.text), none.text);
    check('compare: a pass says how many values it compared', compareSnapshot(dir, 'x', d, { only: ['player'] }).values > 0);
    check('diff: a story counter has no tolerance', diffDescribe({ vars: { counters: { a: 1 } } }, { vars: { counters: { a: 1.25 } } }).length === 1);
    check('frame counters are not gameplay', !('writers' in (pickGameplay({ picture: { writers: { a: 1 }, fog: 1 } }).picture ?? {})));
    check('changeLine: names the change and leaves out what moves by itself', /vars\.flags\.a: added true/.test(changeLine({ vars: { flags: {} }, time: { clock: 1 } }, { vars: { flags: { a: true } }, time: { clock: 2 } })));
    check('changeLine: says when nothing changed', /nothing/.test(changeLine({ time: { clock: 1 } }, { time: { clock: 2 } })));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
