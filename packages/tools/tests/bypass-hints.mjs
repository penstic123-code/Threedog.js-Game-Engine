// Rule R40 (bypass hints) on fixture texts: each hint fires on the hand-rolled pattern, stays quiet on the neighbouring plain use, is warn-only,
// and can be switched off per line, per file and per project.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { metadata } from 'threedog/metadata';
import { scanText, activeKinds, KINDS } from '../rules/R40-bypass-hints.mjs';
import { silent } from '../rules/R64-how-reach.mjs';
import { kindsFirst } from '../rules/index.mjs';
import { checkDigest } from '../threedog/mcp-extra.mjs';
import { HINTS_SHOWN } from '../lib/result.mjs';
import { ENGINE, TOOLS, isArtFile } from '../paths.mjs';
import { walk } from '../lib/text.mjs';

export const name = 'rule R40: bypass hints (positive and negative samples, switches)';

const kinds = (text, active) => scanText(text, active).map(r => r.kind).join();

export async function run({ check }) {
  // timers
  check('setInterval for game timing -> timers', kinds('setInterval(() => spawnWave(), 5000);\n') === 'timers');
  check('setTimeout with a delay -> timers', kinds('setTimeout(() => door.open(), 1500);\n') === 'timers');
  check('an await-delay new Promise(r => setTimeout(r, ms)) -> timers, naming the clock', kinds('await new Promise(r => setTimeout(r, 200));\n') === 'timers'
    && kinds('await new Promise(resolve => setTimeout(resolve, 200));\n') === 'timers' && /engine\.clock\.after\(s, r\)/.test(scanText('await new Promise(r => setTimeout(r, 9));\n')[0].fix));
  check('engine.clock.after as the awaited delay is not flagged', kinds('await new Promise(r => engine.clock.after(0.2, r));\n') === '');
  check('setTimeout(fn, 0) is not flagged', kinds('setTimeout(() => init(), 0);\n') === '');
  check('a presentation tag lets timers through', kinds('setTimeout(fade, 300);   // presentation: fade-out\n') === '');
  check('engine.clock.after is not flagged', kinds('engine.clock.after(2, () => door.open());\n') === '');
  check('the word in a comment or a string is not flagged', kinds('// we used setInterval( once\nconst s = "setTimeout(x)";\n') === '');

  // random
  check('Math.random in gameplay -> random', kinds('const drop = Math.random() < 0.2 ? "gem" : "coal";\n') === 'random');
  check('engine.random is not flagged', kinds('const drop = engine.random.chance(0.2) ? "gem" : "coal";\n') === '');
  check('Math.random for something only seen is fine: a particle line, a picture module, a picture file', kinds('const v = spark.speed * Math.random();\n') === '' && kinds("const m = { type: 'picture' };\nconst a = Math.random();\n") === ''
    && scanText('const a = Math.random();\n', new Set(KINDS), { art: true }).length === 0);
  check('a preference in browser storage is fine, a save is not', kinds("localStorage.setItem('music-volume', '1');\n") === '' && kinds("localStorage.setItem('progress', s);\n") === 'save');
  check('a native loader for a format of its own is fine', kinds("const m = await new FBXLoader().loadAsync(url);\n") === '');
  check('a hand-managed input lock -> lock; one beside engine.input.push is quiet', kinds('let inputLocked = false;\n') === 'lock' && kinds("let inputLocked = false;\nconst h = engine.input.push('ride');\n") === '');
  check('a word alone does not fire lock', kinds('const controlsEnabled = true;\nlet locked = 1;\n') === '');
  check('Math.random tagged presentation is fine (line and line above)', kinds('const j = Math.random();   // presentation\n') === '' && kinds('// presentation: pitch jitter\nconst j = Math.random();\n') === '');

  // inventory
  check('a hand-made inventory array -> inventory', kinds('const inventory = [];\nfunction pick(i) { inventory.push(i); }\n') === 'inventory');
  check('this.backpack = {} counts too', kinds('class P { constructor() { this.backpack = {}; } }\n') === 'inventory');
  check('a file that uses engine.inventory is not flagged', kinds('const bag = {};\nengine.inventory.add("gem", 1);\n') === '');
  check('inventory() installed in the file is not flagged', kinds('const inv = [];\nengine.use(inventory({}));\n') === '');
  check('unrelated arrays are not flagged', kinds('const items = [];\nconst bagOfTricks = foo();\nconst invoice = {};\n') === '');

  // grid
  const bilinear = 'const x0 = Math.floor(u), z0 = Math.floor(v), tx = u - x0, tz = v - z0;\nconst a = heights[z0 * W + x0], b = heights[z0 * W + x0 + 1];\nreturn a * (1 - tx) + b * tx;\n';
  check('bilinear over a heights array -> grid (one finding)', kinds(bilinear) === 'grid');
  check('a file that uses sampleGrid is not flagged', kinds('const h = sampleGrid(heights, o);\n' + bilinear) === '');
  check('a plain height read without a blend is not flagged', kinds('const y = heights[j * W + i];\n') === '');
  check('a blend over something else is not flagged', kinds('const t = Math.floor(x);\nconst c = colors[t] * (1 - f) + colors[t + 1] * f;\n') === '');

  // warnings only, with the three parts of the message
  const r = scanText('setInterval(tick, 1000);\n')[0];
  check('level is warn, message names what was seen, the system and how to switch off', r.level === 'warn' && /setInterval/.test(r.msg) && /engine\.clock/.test(r.fix) && /DESIGN\.md/.test(r.fix) && /hint-off\(timers\)/.test(r.fix));

  // save
  check('a save written to localStorage -> save', kinds("localStorage.setItem('keeper-save-v1', JSON.stringify(state));\n") === 'save');
  check('a remembered preference is not a save', kinds("localStorage.setItem('volume', String(v));\n") === '');
  check('a file on engine.saves is not flagged', kinds("await engine.saves.save();\nlocalStorage.setItem('lastSave', String(t));\n") === '');

  check('setItem with the JSON made elsewhere -> save', kinds('localStorage.setItem(key, v);\n') === 'save' && kinds("localStorage.setItem('hiscore', data);\n") === 'save');
  check('preference keys stay quiet (volume, language, theme, quality)', ['volume', 'lang', 'ui-theme', 'quality'].every(k => kinds(`localStorage.setItem('${k}', v);\n`) === ''));
  check('a save-like key wins over a preference word', kinds("localStorage.setItem('settings-save', v);\n") === 'save');

  // keys
  check('keydown on window / document / canvas -> keys', kinds("window.addEventListener('keydown', e => go(e));\n") === 'keys'
    && kinds("document.addEventListener('keyup', up);\n") === 'keys' && kinds("renderer.domElement.addEventListener('keydown', f);\n") === 'keys' && kinds('document.onkeydown = f;\n') === 'keys');
  check('keydown on a text field or tagged tool code is quiet', kinds("nameInput.addEventListener('keydown', e => e.key === 'Enter' && ok());\n") === ''
    && kinds("window.addEventListener('keydown', f);   // debug: dev overlay\n") === '' && kinds("window.addEventListener('resize', f);\n") === '');
  check('engine.input.define is not flagged', kinds("engine.input.define('jump', { keys: ['Space'] });\n") === '');

  // audio
  check('AudioContext / new Audio -> audio', kinds('const ctx = new AudioContext();\n') === 'audio' && kinds("new Audio('hit.mp3').play();\n") === 'audio' && kinds('new webkitAudioContext();\n') === 'audio');
  check('engine.audio.play is not flagged', kinds("engine.audio.play('hit.mp3', { bus: 'sfx' });\n") === '');

  // dialogue
  check('a hand-made dialogue box -> dialogue', kinds("const box = document.createElement('div'); box.id = 'dialogue-box';\n") === 'dialogue');
  check('a box named in its variable or its markup -> dialogue', kinds("const speechBox = document.createElement('div');\n") === 'dialogue' && kinds("el.innerHTML = '<div class=\"dialogue\">';\n") === 'dialogue');
  check('one createEngine line with the canvas lookup and a title screen subtitle is not a dialogue box', kinds("const engine = createEngine({ canvas: document.getElementById('view'), ui: { title: { title: 'FLOOD', subtitle: 'A house' } }, audio: { sounds: { door: {} } } });\n") === '');
  check('a file on engine.dialogue, or another element, is not flagged', kinds("engine.dialogue.define('a', {});\nconst b = document.createElement('div'); b.id = 'dialog';\n") === ''
    && kinds("const b = document.createElement('div'); b.id = 'score';\n") === '');

  // reach
  check('a distance check beside the interact key -> reach', kinds("if (key === 'KeyE' && player.position.distanceTo(npc.position) < 2) talk();\n") === 'reach'
    && kinds('const near = Math.hypot(dx, dz) < 3;\nif (pressed.interact) open();\n') === 'reach');
  check('a distance check with no interact word, or with engine.interactions, is not flagged', kinds('if (a.position.distanceTo(b.position) < 2) bump();\n') === ''
    && kinds("engine.interactions.add(npc, {});\nif (p.distanceTo(npc) < 2 && key === 'KeyE') talk();\n") === '');

  // collision
  check('a hand-written box overlap -> collision', kinds('if (Math.abs(p.x - w.x) < w.hw && Math.abs(p.z - w.z) < w.hd) block();\n') === 'collision'
    && kinds('if (p.x > w.minX && p.x < w.maxX) block();\n') === 'collision');
  check('one axis, or engine.collision in the file, is not flagged', kinds('if (Math.abs(p.x - w.x) < 2) block();\n') === ''
    && kinds('engine.collision.addBox(w, {});\nif (Math.abs(p.x - w.x) < 1 && Math.abs(p.z - w.z) < 1) hit();\n') === '');

  // pause
  check('an Esc handler of its own -> pause', kinds("addEventListener('keydown', e => { if (e.code === 'Escape') togglePause(); });\n") === 'pause');
  check('a paused flag of its own -> pause', kinds('let paused = false;\n') === 'pause');
  check('a file with the settings menu or engine.freeze is not flagged', kinds("engine.use(settings({ freezeWorld: true }));\nlet paused = false;\n") === '' && kinds("const h = engine.freeze('map');\nlet paused = false;\n") === '');

  // switches
  check('// hint-off on the line silences every hint there', kinds('setInterval(tick, 1000);   // hint-off: poller for the backend\n') === '');
  check('// hint-off(random) names a kind; others still fire', kinds('const a = Math.random(), t = setInterval(f, 9);   // hint-off(random)\n') === 'timers');
  check('// hint-off on the whole line above works', kinds('// hint-off(timers)\nsetInterval(tick, 1000);\n') === '');
  check('a hint-off two lines up does not', kinds('// hint-off(timers)\nconst x = 1;\nsetInterval(tick, 1000);\n') === 'timers');
  check('// hint-off-file at the top silences the file (all or named)', kinds('// hint-off-file\nsetInterval(a, 1);\nMath.random();\n') === ''
    && kinds('// hint-off-file(random)\nsetInterval(a, 1);\nMath.random();\n') === 'timers');
  check('project setting: false switches all off, a map switches named kinds', activeKinds(false, undefined).size === 0 && activeKinds({ random: false }, undefined).has('timers')
    && !activeKinds({ random: false }, undefined).has('random') && activeKinds(undefined, undefined).size === KINDS.length);
  check('THREEDOG_HINTS=off switches all off', activeKinds(undefined, 'off').size === 0);
  check('scanText honors the active set', kinds('Math.random();\nsetInterval(a, 1);\n', new Set(['timers'])) === 'timers');
  // kinds added with the owners' declarations: each fires on the hand-made shape and stays quiet on the plain use beside it
  const fires = (kind, yes, ...no) => {
    check(`${kind} fires`, kinds(yes) === kind, kinds(yes));
    for (const n of no) check(`${kind} stays quiet: ${n.split('\n')[0].slice(0, 50)}`, !kinds(n).split(',').includes(kind), kinds(n));
  };
  fires('animation', 'const mixer = new THREE.AnimationMixer(model);\n', "const anim = engine.assets.animate(model, {});\nconst m = new THREE.AnimationMixer(model);\n", 'const clip = model.animations[0];\n');
  fires('loop', 'function tick() { draw(); requestAnimationFrame(tick); }\n', 'engine.onFrame(dt => draw(dt));\n', 'requestAnimationFrame(() => { el.style.opacity = 0; });\n', 'await new Promise(requestAnimationFrame);\n', 'requestAnimationFrame(tick);   // main-loop: my own tool page\n');
  fires('follow', 'engine.onFrame(dt => {\n  camera.position.lerp(player.position, 0.1);\n});\n', 'camera.position.set(0, 5, 10);\n', 'camera.position.copy(start);\n', "camera.position.copy(player.position);\n", "engine.use(followCamera());\nengine.onFrame(() => {\n  camera.position.lerp(player.position, 0.1);\n});\n", "const h = engine.takeCamera('intro');\nengine.onFrame(() => {\n  camera.position.lerp(target, 0.1);\n});\n");
  fires('particles', 'for (const p of particles) {\n  p.life -= dt;\n}\n', 'for (const p of players) {\n  p.life -= dt;\n}\n', 'for (const p of particles) draw(p);\n', "engine.particles.emit('dust');\nfor (const p of particles) {\n  p.life -= dt;\n}\n");
  fires('tween', 'const k = Math.min(1, elapsed / duration);\n', 'const k = hp / maxHp;\n', 'await engine.timeline.tween(door, { y: 2 }, { duration: 1 });\n', 'const avg = total / count;\n');
  check('tween fires on a tween library', kinds("import gsap from 'gsap';\n") === 'tween', kinds("import gsap from 'gsap';\n"));
  fires('pool', 'const bulletPool = [];\n', 'const bullets2 = foo();\n', 'const lightPool = [];\n', 'const pool = [];\nengine.swarm.define("shot", {});\n');
  fires('picking', 'raycaster.setFromCamera(mouse, camera);\n', 'const hit = engine.pick(x, y);\n', 'const r = new THREE.Raycaster(origin, dir);\n', 'engine.raycast(a, b);\nraycaster.setFromCamera(mouse, camera);\n');
  fires('loading', "const bar = document.getElementById('loading-bar');\n", "const bar = document.getElementById('health-bar');\n", "engine.loading.track('x');\nconst b = document.getElementById('loading');\n", 'const loading = true;\n');
  fires('language', "const translations = {\n  en: { hi: 'Hi' },\n  zh: { hi: 'Ni hao' },\n};\n", 'const strings = { a: 1 };\n', "engine.i18n.add('en', {});\nconst strings = {\n  en: {},\n};\n");
  fires('settings', "const m = document.createElement('div'); m.id = 'settings-menu';\n", "const m = document.createElement('div'); m.id = 'score';\n", "engine.use(settings());\nconst m = document.getElementById('settings');\n");
  fires('quests', 'const quests = [];\n', 'const quest = getQuest();\n', 'engine.quests.start("a");\nconst quests = [];\n');
  fires('physics', "import * as CANNON from 'cannon-es';\n", "import * as THREE from 'three';\n", "engine.use(rigid({}));\nimport RAPIER from '@dimforge/rapier3d-compat';\n");
  check('a pathfinder of its own is never hinted', kinds('const open = [start];\nfunction astar(a, b) { return path; }\n') === '');

  // the patterns live with their owners: R40 holds none, every kind says where it came from, and a hint-off of a new kind works like the old ones
  const src = readFileSync(join(TOOLS, 'rules/R40-bypass-hints.mjs'), 'utf8');
  check('R40 keeps no pattern of a system', !/localStorage|AudioContext|setInterval\b.*test|Math\.random\b.*test/.test(src.split('\n').filter(l => !l.startsWith('//')).join('\n')));
  check('the first twelve kinds are all there, each from its owner', ['timers', 'random', 'inventory', 'grid', 'save', 'pause', 'keys', 'audio', 'dialogue', 'reach', 'collision', 'lock'].every(k => KINDS.includes(k)) && Object.values(metadata.hints).every(h => /packages\/engine\/(core|modules)\//.test(h.file)));
  check('a new kind switches off like the old ones', kinds('// hint-off-file(tween)\nconst k = elapsed / duration;\n') === '' && kinds('const k = elapsed / duration;   // hint-off(tween)\n') === '' && !activeKinds({ picking: false }, undefined).has('picking'));
  check('a module with no answer is reported, an answer is enough', silent({ a: { file: 'a.js' }, b: { file: 'b.js', handRolled: 'none: no code shape' }, c: { file: 'c.js', handRolled: ['x'] } }).length === 1 && !silent(metadata.modules).length, JSON.stringify(silent(metadata.modules)).slice(0, 200));

  check('a new game is told about the hints', /threedog check. hints .*hint-off/.test(readFileSync(join(TOOLS, 'templates/game/CLAUDE.md'), 'utf8')));

  // nothing false in what ships: the examples and the templates are correct engine use, so a warning there is a pattern that fires too wide
  const samples = [join(ENGINE, 'examples'), join(TOOLS, 'templates')].flatMap(d => walk(d, { unscoped: true, skip: ['tests', 'docs', 'scripts', 'node_modules', 'dist'] }));
  const found = samples.flatMap(f => scanText(readFileSync(f, 'utf8'), new Set(KINDS), { art: isArtFile(f.replaceAll('\\', '/')) }).map(r => `${f.slice(-40)}:${r.line} ${r.kind}`));
  check('examples and templates give no warning', samples.length > 20 && !found.length, found.slice(0, 5).join(' | '));

  // MCP check: the hints a terminal sees must reach an AI that only has the tool
  const hint = n => ({ code: 'R40', level: 'warn', file: 'src/main.js', line: n, message: `hand-made bag ${n}`, short: 'use engine.inventory · off: // hint-off(inventory)' });
  const passed = { items: [hint(3)], summary: 'check passed: 0 errors, 1 warnings' }, digest = checkDigest(passed, 2000);
  check('MCP check keeps a hint: file, line, advice, switch', ['src/main.js:3', 'hand-made bag', 'use engine.inventory', 'hint-off(inventory)'].every(t => digest.includes(t)), digest);
  const many = checkDigest({ items: Array.from({ length: 9 }, (_, i) => hint(i + 1)), summary: 'S' }, 2000);
  check('MCP check lists the same number as check and says how to get the rest', many.split('\n').filter(l => l.startsWith('!')).length === HINTS_SHOWN && many.includes('4 more hints: ask with hints: 9'), many);
  check('a long list of hints never cuts the summary', checkDigest({ items: Array.from({ length: 9 }, (_, i) => hint(i + 1)), summary: 'SUMMARY' }, 200, 9).endsWith('SUMMARY'));
  const order = kindsFirst([{ kind: 'timers', n: 1 }, { kind: 'timers', n: 2 }, { kind: 'inventory', n: 3 }]).map(r => r.n);
  check('one hint of each kind comes before a second of any', order.join() === '1,3,2', order.join());
}
