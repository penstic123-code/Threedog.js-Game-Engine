// Discoverability question bank for `threedog how` (design: docs/plans/2026-11-18-discoverability.md section 5.1).
// A question passes when a `how` hit's doc file is in `files` AND the hit's section text contains `must` (an interface name). Judging by the name
// and not by section number keeps the bank valid when a section is renumbered, and measures what matters: did the AI meet the name.
// `files` are paths under packages/engine/docs and list every place where the answer may live, so adding the name to a better page later only extends the list.
// `pending: true` = the name is written in no indexed doc yet, so the question cannot pass today; the test fails the day the name appears (drop the flag then).
// Discipline (same as ROUTES): a miss is fixed where `how` reads (headings, AI.md rows, how-words.mjs), never by editing the question.
const R = n => `recipes/${n}.md`;

/** Seeds: real wordings from the Fisher friction log (kind 'fisher'), blind-test reports and starter-game tasks (kind 'blind') */
export const seeds = [
  { id: 'F10', q: 'paint a procedural texture without blocking the main thread', files: [R('15-perf'), 'AI.md'], must: 'engine.jobs', kind: 'fisher' },
  { id: 'F10b', q: 'async canvas texture generation helper', files: [R('15-perf'), 'AI.md'], must: 'engine.jobs', kind: 'fisher' },
  { id: 'F33', q: 'time budget for a job slice', files: [R('15-perf')], must: 'yield', kind: 'fisher' },
  { id: 'F7', q: 'shot does not wait for background work to finish', files: [R('60-judge-the-picture'), R('15-perf'), R('14-custom-module'), R('05-props-bake')], must: 'isReady', kind: 'fisher' },
  { id: 'F7b', q: 'wait until the scene is ready before a screenshot', files: [R('60-judge-the-picture'), R('15-perf'), R('14-custom-module'), R('05-props-bake')], must: 'isReady', kind: 'fisher' },
  { id: 'F7c', q: 'register a ready hook for shot', files: [R('60-judge-the-picture'), R('15-perf'), R('14-custom-module'), R('05-props-bake')], must: 'isReady', kind: 'fisher' },
  { id: 'F8', q: 'read a key while the world is frozen', files: [R('58-input'), R('07-flow-scenes-pause'), R('16-dev-bridge')], must: 'pressedRaw', kind: 'fisher' },
  { id: 'F24', q: 'menu close key while a modal is open', files: [R('58-input'), R('26-ui-parts')], must: 'toggleOnKey', kind: 'fisher' },
  { id: 'F8c', q: 'input.pressed does not refresh when paused', files: [R('58-input'), R('07-flow-scenes-pause'), R('16-dev-bridge')], must: 'pressedRaw', kind: 'fisher' },
  { id: 'F21', q: 'does a timed modifier keep running while frozen', files: [R('06-clock-events'), R('55-mods-time-wrap')], must: 'for: seconds', kind: 'fisher' },
  { id: 'F6', q: 'hold a button down in a headless shot', files: [R('60-judge-the-picture'), R('16-dev-bridge')], must: 'input.simulate', kind: 'fisher' },
  { id: 'F4', q: 'import a game module inside a test page', files: [R('16-dev-bridge')], must: 'window.game', kind: 'fisher' },
  { id: 'F9', q: 'typed place for my game handle on engine', files: [R('14-custom-module')], must: 'declare module', kind: 'fisher' },
  { id: 'F9b', q: 'engine type has no property for my game object', files: [R('14-custom-module')], must: 'declare module', kind: 'fisher' },
  { id: 'F11', q: 'sun glow constants and horizon fog band', files: [R('08-weather-sky')], must: 'uSunGlow', kind: 'fisher' },
  { id: 'F11b', q: 'replace the fog function', files: [R('08-weather-sky'), R('44-water-weather-hooks'), R('34-environment-lighting'), R('43-shader-patches-surfaces'), R('56-webgpu-tsl')], must: 'fogNode', kind: 'fisher' },
  { id: 'F23', q: 'custom title screen gets no title text', files: [R('26-ui-parts')], must: 'show(', kind: 'fisher' },
  { id: 'F23b', q: 'title background camera', files: [R('26-ui-parts'), R('21-camera'), R('55-mods-time-wrap')], must: 'takeCamera', kind: 'fisher' },
  { id: 'F45', q: 'bumpMap from a procedural height', files: [R('56-webgpu-tsl')], must: 'detailBump', kind: 'fisher' },
  { id: 'F45b', q: 'normal detail from noise height in TSL', files: [R('56-webgpu-tsl'), R('53-ground-up-close')], must: 'detailBump', kind: 'fisher' },
  { id: 'F46', q: 'uniform re-uploaded for every draw', files: [R('56-webgpu-tsl')], must: 'setGroup', kind: 'fisher' },
  { id: 'F15', q: 'define a sound with play rules in code', files: [R('31-audio'), R('20-content-actions-save')], must: 'sounds', kind: 'fisher' },
  { id: 'F19', q: 'additive stat reads 1 with no base', files: [R('55-mods-time-wrap')], must: 'base', kind: 'fisher' },
  { id: 'F20', q: 'handle is stale after loading a save', files: [R('55-mods-time-wrap')], must: 'remove()', kind: 'fisher' },
  { id: 'F22', q: 'inventory unique items with per-item data', files: [R('03-items-pickups')], must: 'setData', kind: 'fisher' },
  { id: 'F30', q: 'threedog js multi-line script no return value', files: [R('16-dev-bridge'), 'COMMANDS.md'], must: 'own `return`', kind: 'fisher' },
  { id: 'F31', q: 'leave the title screen from the bridge', files: [R('16-dev-bridge'), R('07-flow-scenes-pause')], must: 'play=1', kind: 'fisher' },
  { id: 'F47', q: 'start the game from the command line', files: [R('16-dev-bridge'), R('07-flow-scenes-pause'), 'COMMANDS.md'], must: '--play', kind: 'fisher' },
  { id: 'F40', q: 'open the page with custom URL parameters', files: [R('16-dev-bridge'), 'COMMANDS.md'], must: '--page', kind: 'fisher' },
  { id: 'F32', q: 'show the latest errors', files: ['COMMANDS.md', R('16-dev-bridge')], must: 'errors latest', kind: 'fisher' },
  { id: 'F39', q: 'set time of day and weather from the cli', files: ['COMMANDS.md', R('16-dev-bridge')], must: 'time=', kind: 'fisher' },
  { id: 'F34', q: 'draw calls do not change while halted', files: [R('15-perf'), R('16-dev-bridge')], must: 'engine.step', kind: 'fisher' },
  { id: 'F36', q: 'snap returns a stale frame when paused', files: [R('15-perf'), R('16-dev-bridge')], must: 'engine.step', kind: 'fisher' },
  { id: 'F1', q: 'several agents building at the same time', files: [R('16-dev-bridge'), 'COMMANDS.md'], must: 'worktree', kind: 'fisher' },
  { id: 'M1', q: 'backpack with a weight limit', files: [R('03-items-pickups')], must: 'engine.inventory', kind: 'blind' },
  { id: 'M2', q: 'press a key near an ore vein to mine it', files: [R('03-items-pickups'), R('20-content-actions-save')], must: 'interactions.add', kind: 'blind' },
  { id: 'M3', q: 'dripping water sound in one part of the cave', files: [R('31-audio')], must: 'ambience', kind: 'blind' },
  { id: 'M4', q: 'game over screen when the lamp runs out', files: [R('07-flow-scenes-pause')], must: 'flow', kind: 'blind' },
  { id: 'M5', q: 'win screen', files: [R('07-flow-scenes-pause')], must: 'flow', kind: 'blind' },
  { id: 'M6', q: 'first person walk collide', files: [R('21-camera'), R('63-third-person-start')], must: 'firstPersonCamera', kind: 'blind' },
  { id: 'M7', q: 'light shafts through window', files: [R('34-environment-lighting')], must: 'lightShaft', kind: 'blind' },
  { id: 'M8', q: 'settings row label', files: [R('26-ui-parts')], must: 'settings.define', kind: 'blind' },
  { id: 'M9', q: 'echo reverb in a cave', files: [R('31-audio')], must: 'reverb', kind: 'blind' },
  { id: 'I1', q: 'talk to a villager', files: [R('02-npc')], must: 'engine.dialogue', kind: 'blind' },
  { id: 'I2', q: 'fetch quest with objectives', files: [R('04-quests')], must: 'engine.quests', kind: 'blind' },
  { id: 'I3', q: 'island terrain with hills', files: [R('28-terrain')], must: 'terrain', kind: 'blind' },
  { id: 'I4', q: 'sea water around the island', files: [R('44-water-weather-hooks'), R('08-weather-sky')], must: 'engine.water', kind: 'blind' },
  { id: 'I5', q: 'show a short message on screen', files: [R('26-ui-parts')], must: 'toast', kind: 'blind' },
  { id: 'I6', q: 'ride a boat that carries the player', files: [R('57-control')], must: 'support', kind: 'blind' },
  { id: 'I7', q: 'read the current game time', files: [R('06-clock-events'), R('08-weather-sky')], must: 'time.now', kind: 'blind' },
  { id: 'K1', q: 'pause the game with escape', files: [R('07-flow-scenes-pause')], must: 'flow', kind: 'blind' },
  { id: 'K2', q: 'save progress to localStorage', files: [R('20-content-actions-save')], must: 'saves.define', kind: 'blind' },
  { id: 'E1', q: 'make sure this value does not change again', files: [R('16-dev-bridge')], must: 'threedog expect', kind: 'blind' },
  { id: 'E2', q: 'guard draw calls against regression', files: [R('16-dev-bridge')], must: 'threedog expect', kind: 'blind' },
  { id: 'E3', q: 'remember why this threshold', files: [R('16-dev-bridge')], must: 'threedog expect', kind: 'blind' },
];

/**
 * Variants: the same task asked another way, taken from the words of the Fisher friction log (ENGINE-FRICTION.md, columns "What happens" and
 * "Wanted from the engine"), not written by a helper who saw the doc changes. `of` = the seed whose files and must it shares.
 * Only seeds with a log entry have variants; the blind-test seeds (M, I, K) have none yet.
 */
export const variants = [
  { of: 'F10', id: 'F10v1', q: 'per-pixel texture painting blocks the main thread, is there a helper that slices it', kind: 'fisher' }, // F10 "What happens"
  { of: 'F10', id: 'F10v2', q: 'ready-made async texture painter instead of slicing by hand', kind: 'fisher' }, // F10 "Wanted"
  { of: 'F33', id: 'F33v1', q: 'generators have to guess a row count, run until N ms elapsed', kind: 'fisher' }, // F33 "Wanted"
  { of: 'F7', id: 'F7v1', q: 'a wait until ready or idle hook the game can register for', kind: 'fisher' }, // F7 "Wanted"
  { of: 'F7', id: 'F7v2', q: 'shots come out empty or half built, decor chunks and texture jobs still running', kind: 'fisher' }, // F7 "What happens"
  { of: 'F8', id: 'F8v1', q: 'input.pressed may not refresh while the world is frozen, modal open', kind: 'fisher' }, // F8 "What happens"
  { of: 'F24', id: 'F24v1', q: 'how does a menu read its own keys while frozen', kind: 'fisher' }, // F24 "Wanted"
  { of: 'F21', id: 'F21v1', q: 'whether a mod for seconds timer keeps running while the world is frozen, menu open', kind: 'fisher' }, // F21 "What happens"
  { of: 'F6', id: 'F6v1', q: 'headless runs cannot hold a button, press or hold option in shot', kind: 'fisher' }, // F6 "What happens" / "Wanted"
  { of: 'F4', id: 'F4v1', q: 'import inside a test page code returns 404 in the bundled test server', kind: 'fisher' }, // F4 "What happens"
  { of: 'F4', id: 'F4v2', q: 'serve source modules to test pages or the supported way to reach game code from a test', kind: 'fisher' }, // F4 "Wanted"
  { of: 'F9', id: 'F9v1', q: 'check reports type errors, a typed place for game-owned handles', kind: 'fisher' }, // F9 "Wanted"
  { of: 'F11', id: 'F11v1', q: 'low sun readable, horizon fog band and sun glow constants not exposed', kind: 'fisher' }, // F11 "What happens"
  { of: 'F23', id: 'F23v1', q: 'custom title part gets empty options so the title text is lost', kind: 'fisher' }, // F23 "What happens"
  { of: 'F23b', id: 'F23v2', q: 'hook for a title background camera, default title background is opaque', kind: 'fisher' }, // F23 "What happens"
  { of: 'F45', id: 'F45v1', q: 'bumpMap is useless for procedural non-texture heights', kind: 'fisher' }, // F45 "What happens"
  { of: 'F46', id: 'F46v1', q: 'TSL uniform defaults to objectGroup and is re-uploaded for every chunk draw', kind: 'fisher' }, // F46 "What happens"
  { of: 'F15', id: 'F15v1', q: 'code-defined sounds with play rules, define with a handle instead of writing config directly', kind: 'fisher' }, // F15 "What happens" / "Wanted"
  { of: 'F19', id: 'F19v1', q: 'number points default to base 1, additive stats read 1 silently', kind: 'fisher' }, // F19 "What happens"
  { of: 'F20', id: 'F20v1', q: 'entries restored by the stacks save leave callers with stale handles', kind: 'fisher' }, // F20 "What happens"
  { of: 'F22', id: 'F22v1', q: 'can engine.inventory hold unique instances with per-item data like affix rolls', kind: 'fisher' }, // F22 "Wanted"
  { of: 'F30', id: 'F30v1', q: 'accept multi-line scripts, threedog js returns nothing for several lines', kind: 'fisher' }, // F30 "What happens" / "Wanted"
  { of: 'F31', id: 'F31v1', q: 'a play flag on js and reload, reload returns the page to the title', kind: 'fisher' }, // F31 "Wanted"
  { of: 'F47', id: 'F47v1', q: 'a start-game bridge op to leave the title screen', kind: 'fisher' }, // F47 "Wanted"
  { of: 'F40', id: 'F40v1', q: 'no way to load the bridge page with custom URL parameters', kind: 'fisher' }, // F40 "What happens"
  { of: 'F32', id: 'F32v1', q: 'errors tool advertises latest but the CLI rejects it', kind: 'fisher' }, // F32 "What happens"
  { of: 'F39', id: 'F39v1', q: 'state tool accepts time and weather, how do I pass them from the CLI', kind: 'fisher' }, // F39 "What happens"
  { of: 'F34', id: 'F34v1', q: 'render stats that refresh on a forced render while the loop is halted', kind: 'fisher' }, // F34 "Wanted"
  { of: 'F36', id: 'F36v1', q: 'step one frame before snap, or mark the image as stale', kind: 'fisher' }, // F36 "Wanted"
  { of: 'F1', id: 'F1v1', q: 'per-session build directory so parallel agents do not break each other', kind: 'fisher' }, // F1 "Wanted" (F17, F43)
];

/**
 * Canaries: things the engine does not have. They must count as NOT passed, which proves the ruler can come out red.
 * `must` is a name that appears in no doc (the test checks that); if a doc ever grows it, pick another canary.
 */
export const canaries = [
  { id: 'C1', q: 'how do I configure ray traced global illumination hardware', files: [R('34-environment-lighting')], must: 'rayTracedGI', kind: 'canary' },
  { id: 'C2', q: 'rollback netcode for a fighting game lobby matchmaking', files: [R('27-net')], must: 'rollbackMatchmaker', kind: 'canary' },
];
