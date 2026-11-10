// Rule R33 on fixture texts: startup calls that create something saved whole are warnings, world.add initial anywhere is the one error, code managing a
// world model is a warning; startup engine.add / colliders / interactions (rebuilt by code every start) are fine.
import { scanText } from '../rules/R33-authored-placement.mjs';

export const name = 'rule R33: saved-whole creation at setup, world models managed by code';

const found = (text, level) => scanText(text).filter(r => !level || r.level === level).length;
const flagged = (text, n = 1, level) => found(text, level) === n;

export async function run({ check }) {
  // warnings: saved whole, so a load restores it and the startup code makes it again; the rule cannot see whether the game saves
  check('top-level world.add warns', flagged("engine.world.add({ kind: 'crate', position: [0, 0, 0] });\n", 1, 'warn'));
  check('level:loaded handler with world.add warns', flagged("engine.events.once('level:loaded', () => engine.world.add({ kind: 'gate', position: p }));\n", 1, 'warn'));
  check('content.spawn at setup warns (each call)', flagged("engine.content.spawn('chest', { x: 1, z: 2 });\nengine.content.spawn('chest', { x: 3, z: 4 });\n", 2, 'warn'));
  check('pickups.spawn / npcs.add / content.spawn in engine:ready warn', flagged("engine.events.on('engine:ready', () => {\n  engine.pickups.spawn(p, { give: 'apple' });\n  engine.npcs.add(def);\n  engine.content.spawn('wolf', {});\n});\n", 3, 'warn'));
  check('a function called from setup is setup (one level)', flagged("function seed() { engine.content.spawn('chest', p); }\nseed();\n", 1, 'warn'));
  check('install method of a module is setup', flagged("const mod = { install(e) { e.world.add({ kind: 'a' }); } };\n", 1, 'warn'));
  check('forEach at top level keeps the setup context', flagged("[1, 2].forEach(i => engine.content.spawn('rock', { x: i, z: 0 }));\n", 1, 'warn'));
  check('world.add with initial: true is an error even inside an op', flagged("engine.ops.define('x', { run: e => e.world.add({ id: 'a', kind: 'a' }, { initial: true }) });\n", 1, 'error'));

  check('[guard] only { initial: true } is an error: setup findings never fail a game', !scanText("engine.world.add({ kind: 'a' });\nengine.content.spawn('b', p);\n").some(r => r.level === 'error'));
  check('[guard] the fix names the // runtime: tag', /\/\/ runtime: <reason>/.test(scanText("engine.content.spawn('b', p);\n")[0]?.fix ?? ''));

  // a save part: the engine calls load(data), a second parameter means the data went to the wrong name
  check('saves.define with load(e, data) warns, arrow, method and function alike', flagged("engine.saves.define('a', { save, load: (e, d) => go(d) });\nengine.saves.define('b', { save, load(e, d) { go(d); } });\nengine.saves.define('c', { save, load: function (e, d) { go(d); } });\n", 3, 'warn'));
  check('load(data), an optional second parameter and a part held in a variable are fine', flagged("engine.saves.define('a', { save, load: d => go(d) });\nengine.saves.define('b', { save, load(d, opts = {}) { go(d, opts); } });\nengine.saves.define('c', part);\n", 0));

  // allowed: rebuilt by code every start
  check('startup engine.add / scene.add / colliders / rigid / interactions / rays / grids / stream are fine', flagged('engine.add(windmill, { id: \'windmill\' });\nengine.scene.add(sky);\n'
    + "engine.collision.addBox({ x: 0, z: 0 }, { halfWidth: 1, halfDepth: 1 });\nengine.rigid.addBox(m, { mass: 4 });\nengine.interactions.add(m, { label: 'Use' });\n"
    + "engine.rays.addStatic(m);\nengine.grids.add('farm', {});\nengine.stream.add({ at, build });\nengine.inventory.container('chest', { items: { gold: 3 } });\n", 0));
  check('world.add with save: false at setup is fine (not saved)', flagged("engine.world.add({ kind: 'marker' }, { save: false });\n", 0));
  // guard: the world.add fix leads with the { save: false } exit (startup things that need no save), content comes second
  const fix = scanText("engine.world.add({ kind: 'marker' });\n", 'main.js')[0]?.fix ?? '';
  check('[guard] world.add at setup: the fix starts with { save: false }', /^rebuilt by this code on every start .*\{ save: false \}/.test(fix), fix);
  check('content.spawn inside an op run is fine', flagged("engine.ops.define('chest.build', { run: (e, { x, z }) => e.content.spawn('chest', { x, z }).id });\n", 0));
  check('spawns in onFixed / onFrame / other events are fine', flagged("engine.onFixed(() => engine.content.spawn('wolf', {}));\n"
    + "engine.events.on('item:add', () => engine.pickups.spawn(p, { give: 'apple' }));\n", 0));
  check('a line tagged // runtime: <reason> is not flagged', flagged("engine.world.add({ kind: 'a' });   // runtime: debug marker, removed before save\n", 0));
  check('a tag without a reason does not count', flagged("engine.world.add({ kind: 'a' });   // runtime:\n"));
  check('Set.add / group.add are not findings', flagged('const s = new Set(); s.add(1); group.add(mesh);\n', 0));

  // warnings: code managing a model world places every frame
  check('engine.add of a world.view() model warns', flagged("engine.onFrame(() => engine.add(engine.world.view('chest-1')));\n", 1, 'warn'));
  check('writing a world model transform warns (direct, through a const, .set)', flagged("engine.world.view('a').position.x = 3;\nconst m = engine.world.view('b');\nm.rotation.y += 1;\nm.position.set(0, 1, 0);\n", 3, 'warn'));
  const wield = "async function wield() {\n  const m = prepareModel(await engine.assets.model(w.model));\n  m.position.set(0, 0, 0); m.quaternion.identity(); m.scale.setScalar(1);\n  bone.add(m);\n}\n";
  check('a model loaded by assets.model and hung on a bone may have its transform written, even when another function names a world.view() model m', flagged(wield, 0)
    && flagged(wield + "function other() { const m = engine.world.view(id); }\n", 0));
  check('[guard] a world.view() model in the same function or an outer scope is still flagged', flagged("function a() { const m = engine.world.view(id); m.position.set(0, 1, 0); }\n", 1, 'warn')
    && flagged("const m = engine.world.view(id);\nfunction a() { m.scale.setScalar(2); }\n", 1, 'warn')
    && flagged("function a(m) { m.position.x = 1; }\nfunction b() { const m = engine.world.view(id); m.position.x = 1; }\n", 1, 'warn'));
  check('the model in present update is not flagged', flagged("engine.world.present('chest', { build, update(rec, obj) { obj.rotation.y = rec.rot; } });\n", 0));
}
