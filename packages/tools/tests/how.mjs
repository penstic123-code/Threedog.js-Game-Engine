// threedog how "<task>": keyword search over AI.md rows, recipe headings and the plain three.js answers (THREE.md), offline, no browser.
// Why a unit test: the ranking must be deterministic and must not match inside other words ("rain" in "terrain"), or the top hit sends an AI to the
// wrong recipe; and a task three.js does on its own (tone mapping, a render target) must answer with the three.js way first, not an engine wrapper.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGINE } from '../paths.mjs';
import { search, tryNext, libraryHits, queryTokens } from '../how.mjs';
import { answer, routeModules, exampleLines, readDoc } from '../how-answer.mjs';
import { docRef, parseDocRef, docReadCommand } from 'threedog/error-hints';
import { STATIC_TOOLS } from '../threedog/mcp-extra.mjs';

export const name = 'how: offline doc search is deterministic, matches word starts only, plain three.js first, weighs rare words, knows synonyms, says when nothing fits';

export async function run({ check }) {
  const docs = join(ENGINE, 'docs');
  // one answer: a game with world() only, so pickups is absent and inventory() too; the CLI and the MCP tool print the same text
  const game = mkdtempSync(join(tmpdir(), 'how-game-'));
  try {
    writeFileSync(join(game, 'package.json'), '{"name":"g","dependencies":{"threedog":"*"}}');
    writeFileSync(join(game, 'main.js'), "import { createEngine, world } from 'threedog';\nconst engine = createEngine({});\nengine.use(world());\n");
    const a = await answer(game, 'items and pickups'), lines = a.text.split('\n');
    check('[guard] an answer leads with one route, and it does not read as the only way', /^Recommended \(.*not the only allowed one\): /.test(lines[0]) && lines.filter(l => l.startsWith('Recommended')).length === 1, lines[0]);
    check('[guard] it says what this project has and lacks', /Installed: world\(\)|Not installed: .*pickups\(\)/.test(a.text) && /Not installed: .*pickups\(\)/.test(a.text) && /Missing dependency: /.test(a.text), a.text.slice(0, 500));
    check('[guard] a module a route needs and the game lacks is named with who requires it', a.data.install.absent.includes('pickups()'), JSON.stringify(a.data.install));
    // the section text replaces the old ten-line example; the limit is the output rule's bytes (docs/testing/tool-output-sizes.md), not a line count
    check('it has the section or an example and a next route, within the 4 KB output rule', /^(Example|The section)/m.test(a.text) && /^When it does not fit: /m.test(a.text) && Buffer.byteLength(a.text) <= 4096, String(Buffer.byteLength(a.text)));
    const full = await answer(game, 'items and pickups', { full: true });
    check('--full lists the other routes, the default only counts them', /^Other routes:$/m.test(full.text) && /^Other routes: \d+ more/m.test(a.text));
    // [guard] a game that exists gets the lines to add, not a second createEngine; with no game the whole file stays the answer
    for (const q of ['pickup', 'saved game value', 'press a key on a thing', 'after a delay', 'steer the hero']) {
      const t = await answer(game, q), code = t.data.example?.join('\n') ?? '';
      check(`[guard] "${q}" in a game leads with the lines to add`, /in-an-existing-game/.test(t.data.recommended?.at ?? '') && /^Add to your game, reuse what is there/m.test(t.text) && !code.includes('createEngine') && t.data.example.length === 2, t.text.slice(0, 300));
    }
    const mcp = await STATIC_TOOLS.how.run(game, { task: 'items and pickups' });
    check('[guard] CLI and MCP how are one answer', mcp.text === a.text);
    // the most asked tasks answer with their whole example from recipe 66 (the spec "recipe 66" runs those blocks)
    for (const q of ['pickup', 'custom picture piece', 'saved game value', 'input action', 'rain effect', 'custom npc behaviour', 'custom path source']) {
      const t = await answer(ENGINE, q);
      check(`[guard] "${q}" leads with its recipe 66 section, whole`, /66-common-tasks/.test(t.data.recommended?.at ?? '') && t.data.example.length === 2 && /^Example \(complete/m.test(t.text) && t.data.next.length > 0, t.text.slice(0, 300));
    }
    check('no game folder: installed is unknown, not a guess', /Installed: unknown/.test((await answer(join(game, 'nowhere'), 'items and pickups')).text));
    check('an optional use (engine.particles?.emit) does not count as a needed module', !routeModules('engine.particles?.emit(1)').length && routeModules('engine.particles.emit(1)').length === 1);
    check('a plain three.js answer needs nothing installed', /Installed: nothing to install/.test((await answer(game, 'tone mapping')).text));
    // health check D3: the Installed line reads the recipe page's own module list, not one phrase's section text
    const talk = (await answer(ENGINE, 'talk to npc')).text, folder = (await answer(ENGINE, 'picture folder')).text;
    check('[guard] a recipe route takes its modules from the page: the NPC section says characters(), a picture section does not say calendar()', /characters\(\)/.test(talk) && !/Installed: nothing to install/.test(talk) && /Installed: nothing to install/.test(folder), `${talk.slice(0, 400)} | ${folder.slice(0, 400)}`);
    check('a weak query names no recommendation',!/^Recommended/.test((await answer(game, 'qqzzxx wibble game')).text));
  } finally { rmSync(game, { recursive: true, force: true }); }
  const rain = search(docs, 'rain'), again = search(docs, 'rain');
  check('"rain" finds the weather recipe in the top 3 and never terrain', rain.slice(0, 3).some(h => /weather/.test(h.line)) && !rain.some(h => /28-terrain/.test(h.line)), JSON.stringify(rain.map(h => h.line)));
  check('same query twice gives the same list', JSON.stringify(rain) === JSON.stringify(again));
  check('a hit names a recipe path, an AI.md row or THREE.md, at most 5', rain.length <= 5 && rain.every(h => /recipes\/|AI\.md|THREE\.md/.test(h.line)));
  check('English task words find the (picture) rows (brush strokes, colored shadows)', search(docs, 'brush strokes').length > 0 && search(docs, 'colored shadows').length > 0);
  check('nonsense gives no hit', search(docs, 'qqzzxx').length === 0);
  const tone = search(docs, 'tone mapping'), rt = search(docs, 'mirror render target'), bvh = search(docs, 'raycast');
  check('"tone mapping" answers with the plain three.js row first (THREE.md: set renderer.toneMapping)', /^plain three\.js .*toneMapping.*THREE\.md/.test(tone[0]?.line ?? ''), JSON.stringify(tone.map(h => h.line)));
  check('"mirror render target" answers with the plain three.js row first', /^plain three\.js · Render targets/.test(rt[0]?.line ?? ''), JSON.stringify(rt.map(h => h.line)));
  check('THREE.md is indexed: "raycast" finds the page-wide BVH change', bvh.some(h => /THREE\.md/.test(h.line) && /raycast/i.test(h.line)), JSON.stringify(bvh.map(h => h.line)));
  const rigid = search(docs, 'rigid bodies').map(h => h.line);
  check('a THREE.md row that names an engine API is labelled engine + three.js, not plain three.js', rigid.some(l => /^engine \+ three\.js · Rigid bodies/.test(l)) && !rigid.some(l => /^plain three\.js · Rigid bodies/.test(l)), JSON.stringify(rigid));
  check('the engine route stays in the list: at most 3 plain hits', [rain, tone, rt, bvh, search(docs, 'fog')].every(r => r.filter(h => h.line.startsWith('plain three.js')).length <= 3));
  // 时间归 calendar、天空只画：第一条是 engine.calendar（06），画天空的 08 紧跟在前三，都在 plain three.js 之前
  const dn = search(docs, 'day night').map(h => h.line), firstPlain = dn.findIndex(l => l.startsWith('plain three.js'));
  check('"day night" answers with the engine route: calendar first (time), the sky recipe in the top 3 (drawing), both before plain three.js',
    /engine\.calendar/.test(dn[0] ?? '') && /06-clock-events/.test(dn[0] ?? '') && dn.slice(0, 3).some(l => /08-weather-sky/.test(l)) && (firstPlain === -1 || firstPlain >= 2), JSON.stringify(dn));
  // [守] 一件事一个入口：常见任务用平常话问，第一条必须是那一个推荐入口（CONVENTIONS.md "One task, which entry"），技巧示例只能排在后面。
  // 不过时改文档关键词（AI.md 行、THREE.md、菜谱标题），不改这里的期望
  const TASKS = [
    ['recoil', /32-action-game/],
    ['stealth vision cone', /12-navmesh/],
    ['pixel art', /62-picture-code/],
    ['pixel perfect camera', /62-picture-code/],
    ['smooth movement fixed step', /06-clock-events/],
    ['isometric camera pan', /21-camera/],
    ['sprite character', /13-animation/],
    ['hitscan raycast weapon', /32-action-game/],
    ['win lose', /32-action-game/],
    ['chase camera behind car', /21-camera/],
    ['leaderboard best time', /20-content-actions-save/],
    ['data that outlives saves', /20-content-actions-save/],
    ['save high scores persist best lap times', /20-content-actions-save/],
    ['ride a boat', /57-control/],
    ['choice cursor', /26-ui-parts/],
    ['applyEffects', /THREE\.md/],
    ['move the player by script', /57-control/],
    ['elevator', /57-control/],
    ['climb', /66-common-tasks/],
    ['moving platform', /32-action-game|57-control/],
    ['playthrough script clean start', /16-dev-bridge/],
    ['make windows glow at night', /uNight/],
    ['close a dialogue', /close a dialogue/],
    ['pick a dialogue choice', /Pick a dialogue choice/],
    ['teleport the player in a test', /applyState\(\{ pos \}\)/],
    // 0.5 acceptance: "game test" led to the dev bridge, the spec-file example sat unindexed in COMMANDS.md
    ['game test', /A game test.*tests\/specs\/.*COMMANDS\.md/],
    ['write a test for my game', /A game test.*tests\/specs\//],
    ['teleport the player far away', /stream\.teleport/],
    ['settings turn off my effect', /26-ui-parts/],
    ['quality menu disable custom post effect', /limits: 'post\./],
    ['set the time of day', /engine\.calendar/],
    ['day night cycle', /engine\.calendar/],
    ['seasons', /engine\.calendar/],
    ['speed up time', /engine\.mod\('clock\.rate'/],
    ['timer after 3 seconds', /engine\.clock \(after/],
    ['bullet time on enemies', /engine\.mod/],
    ['many bullets', /engine\.swarm/],
    ['enemy crowd', /engine\.swarm/],
    ['thousands of projectiles', /65-swarm/],
    ['add a fixed camera', /fixedCamera/],
    ['switch camera at runtime', /setCamera/],
    ['third person camera', /followCamera/],
    ['soft shadows under props', /engine\.post\.add\(ao\(\)\)/],
    ['ambient occlusion in a code-built model', /bakeVertexAO/],
    ['wet road after rain', /engine\.weather/],
    ['puddles', /engine\.weather/],
    ['many torches', /lightPool/],
    ['change the sun intensity', /sun\.intensity/],
    ['environment lighting reflections', /engine\.sky\.environment/],
    ['baked light probes', /bakeProbes/],
    ['bloom', /post-effects/],
    // 0.8: words a player uses for depth of field must name dof (they used to land on the shadows row)
    ['blur background', /dof/], ['focus blur', /dof/], ['bokeh', /dof/], ['miniature', /dof/], ['tilt shift', /dof/], ['cinematic', /dof/],
    ['add a post processing pass', /engine\.post\.add/],
    ['tone mapping', /toneMapping/],
    ['save game', /saves\.define/],
    ['pathfinding', /findPath/],
    ['pick up items', /engine\.pickups/],
    ['talk to an npc', /02-npc\.md §1/],   // the conversation first; the bubble form is the next test (health check D3)
    ['bark over an npc head', /channel: 'bubble'/],
    ['pause the game for a menu', /engine\.freeze/],
    ['build on a grid', /engine\.grids/],
    ['inventory', /engine\.inventory/],
    // WebGPU 路线只有一个入口：recipe 56（开法、TSL 材质、引擎函数都从那里读）
    ['webgpu', /56-webgpu-tsl/],
    ['webgpu renderer', /56-webgpu-tsl/],
    ['tsl', /56-webgpu-tsl/],
    ['tsl shader', /56-webgpu-tsl/],
    ['node material', /56-webgpu-tsl/],
  ];
  // library hits come from name and summary, show the pull command, and are printed after the docs hits (they are not part of search())
  const libList = [{ name: 'rain', kind: 'picture', summary: 'Rain: slanted line segments in the vertex shader' }, { name: 'sea-night', kind: 'picture', summary: 'night sea colors' }];
  const lh = libraryHits(libList, 'rain'), none2 = libraryHits(libList, 'qqzzxx');
  check('how also lists library entries by name and summary, with the pull command', lh.length === 1 && /library · rain \(picture\).*threedog lib pull rain/.test(lh[0]) && none2.length === 0, JSON.stringify(lh));
  // [guard] full sentences, casual and player wording (queries a first-time AI actually typed, which the old version answered wrong first): rarity weighs common words down, how-words.mjs synonym groups,
  // camelCase splitting. The first result must be on target. When it is wrong, first see whether the docs lack the word (an AI.md line, a recipe title) or a synonym group does, and fix that, not the expectation here
  const SPOKEN = [
    ['game is slow, find why fps drops', /15-perf/],
    ['low fps stutter', /15-perf/],
    // look-dev lives in the gallery (recipe 05), textures from nodes in recipe 56: no tool of their own, so how must reach the sections
    ['look at one material alone under studio light', /Look-dev/],
    ['turntable a shader', /Look-dev/],
    ['seamless tiling texture', /Textures from nodes/],
    ['bake a tsl node into a texture', /Textures from nodes/],
    ['performance', /15-perf/],
    ['custom sky', /engine\.sky\.replace/],
    ['volumetric fog', /59-depth-post-effects/],
    ['god rays', /59-depth-post-effects/],
    ['top-down farm: place on grid, crops grow over days, sell at shop', /18-world\.md §3|29-grid|engine\.grids/],
    ['save', /saves\.define/],
    ['2D side-scroller with sprites and dynamic lights', /sideScroller.*rc2d/],
    ['sprite lighting normal map 2d', /rc2d/],
    ['push boxes with physics puzzle', /engine\.rigid|11-vehicles/],
    ['can the player push rigid bodies', /11-vehicles/],
    ['third person character running and jumping on terrain', /addPlayer|presets\.player/],
    ['my own toon material with color bands and outline', /ShaderMaterial|43-shader/],
    ['rainy night street with wet ground, street lamps and fog', /weather|lightPool/],
    ['sky color for my shader', /uSkyHorizon|Sky color for my shader/],
    ['horizon color', /Sky color for my shader/],
    ['title start continue', /Title -> start -> continue/],
    // the judging map (recipe 60): asked as a wish, not as a knob name
    ['make it look good', /60-judge-the-(picture)/],
    ['tune the (picture)', /60-judge-the-picture/],
    ['look prettier', /60-judge-the-(picture)/],
    ['visual polish', /60-judge-the-(picture)/],
    // a game-wide model setup and one node of a kit file (05-props-bake.md 2f), asked the way a game report put them
    ['post-process every model the engine spawns', /05-props-bake.*Every model through one setup/],
    ['reference a node inside a multi-part glb', /05-props-bake.*multi-part GLB/],
  ];
  const off = SPOKEN.map(([q, want]) => [q, search(docs, q)[0]?.line ?? '(none)', want]).filter(([, first, want]) => !want.test(first));
  check(`${SPOKEN.length} whole-sentence / spoken queries: the first answer is the right recipe or row`, off.length === 0, off.map(([q, l]) => `"${q}" -> ${l}`).join('\n'));
  // say so when nothing fits: no entry covers enough of the query's weight -> weak, plus the words that appear nowhere in the docs; the CLI then says "not found, try these words / read AI.md line ..."
  const weak = search(docs, 'camera wibble boss'), none = search(docs, 'qqzzxx');
  check('a query the docs barely cover is marked weak and names the words the docs never use', weak.weak === true && weak.unknown.includes('wibble') && !weak.unknown.includes('boss'), JSON.stringify({ weak: weak.weak, unknown: weak.unknown }));
  check('a word only its synonym appears for is not reported as unknown (rainy, the docs say rain)', !search(docs, 'rainy street').unknown.includes('rainy'), JSON.stringify(search(docs, 'rainy street').unknown));
  check('a good hit is not marked weak (a long sentence with a right first answer)', SPOKEN.every(([q]) => !search(docs, q).weak), SPOKEN.filter(([q]) => search(docs, q).weak).map(([q]) => q).join(', '));
  // [guard] the weak verdict reads the list: a query spread over rows is answered even though no one row holds a third of it (judged on one row, rewording that row flipped the answer to "no match")
  const fake = mkdtempSync(join(tmpdir(), 'how-weak-'));
  writeFileSync(join(fake, 'AI.md'), ['alpha', 'bravo', 'charlie', 'delta'].map(w => `| ${w} task | \`engine.${w}\` | 01-a.md |`).join('\n'));
  const spread = search(fake, 'alpha bravo charlie delta echo foxtrot golf'), thin = search(fake, 'alpha echo foxtrot golf hotel india');
  rmSync(fake, { recursive: true });
  check('[guard] weak reads the whole list: words spread over rows are a match, one word of six is not', spread.weak === false && thin.weak === true, JSON.stringify({ spread: spread.weak, thin: thin.weak }));
  // [guard] a recipe's card and a section's first bullet do not rank: they name other sections and one item, not this section
  const fake2 = mkdtempSync(join(tmpdir(), 'how-rank-'));
  mkdirSync(join(fake2, 'recipes'));
  writeFileSync(join(fake2, 'recipes', '01-a.md'), '# Top\n\n> **Sections:** 1 Zebra crossing\n\n## 1. Zebra crossing\nHow to paint one.\n\n## 2. Rules\n- one lamp near a yak\n');
  const zebra = search(fake2, 'zebra crossing'), yak = search(fake2, 'yak');
  rmSync(fake2, { recursive: true });
  check('[guard] the section answers, not the list of sections above it; a bullet word ranks nothing', /Zebra crossing/.test(zebra[0]?.line) && zebra.length === 1 && yak.length === 0, JSON.stringify([zebra, yak]));
  check('the "nothing found" hint says what to try and where to read', /2-4 English task words/.test(tryNext(none)) && /AI\.md/.test(tryNext(none)) && /qqzzxx/.test(tryNext(none)), tryNext(none));
  // [guard] the MCP how tool gives the same hint as the CLI (it once answered a bare "No match" with no words to try)
  const mNone = await STATIC_TOOLS.how.run(ENGINE, { task: 'qqzzxx' }), mWeak = await STATIC_TOOLS.how.run(ENGINE, { task: 'camera shake boss' });
  check('[guard] MCP how: no match and a weak match carry the CLI hint (words the docs never use, 2-4 task words)',
    /Search words are English/.test(mNone.text) && /qqzzxx/.test(mNone.text) && /No good match/.test(mWeak.text) && /boss/.test(mWeak.text), mNone.text + ' | ' + mWeak.text.slice(0, 200));
  // [guard] words the search cannot read get one short line, not a page of closest hits; English beside them still gets its answer, with the line first
  // [guard] a route without code never shows another system's example as its own
  const quiet = { line: 'api/hud.md · hud.show', at: 'api/hud.md', para: '', blocks: [] }, foreign = { at: 'recipes/08-weather-sky.md#rain', blocks: ['engine.use(weather());'], line: '' }, sameSystem = { at: 'recipes/20-x.md#a', blocks: ['engine.hud.show();'], line: '' };
  check('[guard] how: an example from another system is not borrowed', exampleLines(quiet, [quiet, foreign], false).code.length === 0 && /none in the docs/.test(exampleLines(quiet, [quiet, foreign], false).lines[0]));
  check('[guard] how: a route may show a block of its own module', exampleLines(quiet, [quiet, foreign, sameSystem], false).code[0] === sameSystem.blocks[0]);
  const oneLine = t => !t.includes('\n') && t.length < 140 && /how --browse/.test(t) && /Search words are English/.test(t) && /docs\/AI\.md/.test(t);
  const zh = await answer(game, '下雨'), ru = await answer(game, 'дождь'), mixed = await answer(game, '下雨 rain'), accent = await answer(game, 'música');
  check('[guard] how: non-English text answers in one short line', oneLine(zh.text) && oneLine(ru.text) && oneLine(accent.text) && zh.ok, zh.text);
  // English words that match nothing: the short line, then AI.md's domains (pick one instead of guessing more words), still short
  const miss = (await answer(game, 'qqzzxx')).text, [first, next] = miss.split('\n');
  check('[guard] how: nothing found answers in one short line, then the domains', oneLine(first.replace('No match for "qqzzxx". ', '')) && /^Domains/.test(next) && miss.length < 2048, miss);
  // [guard] section pointers (review 2026-11-09): a heading with quotes reads back as itself, a broken selector is no pointer, and the printed command
  // needs no quotes, so a heading with an apostrophe cannot break it in bash or PowerShell
  const quoted = 'Check "advance 10h normally == skip 10h"';
  check('[guard] docRef: a heading with quotes round-trips', parseDocRef(docRef('recipes/49-x.md', quoted))?.title === quoted);
  check('[guard] docRef: a broken selector is no pointer', ['recipes/21-camera.md §不存在', 'recipes/21-camera.md §1.2', 'recipes/21-camera.md §1 tail'].every(r => parseDocRef(r) === null) && parseDocRef('recipes/a.md#中文-x')?.anchor === '中文-x');
  const cmd = docReadCommand(docRef('recipes/02-npc.md', "Avoidance (NPCs don't clump)"));
  check('[guard] docRef: the read command has no quote of any kind', !/['"]/.test(cmd) && /--read recipes\/02-npc\.md#avoidance-npcs-dont-clump --full$/.test(cmd), cmd);
  const back = readDoc(cmd.replace(/^threedog how --read | --full$/g, ''));
  check('[guard] how --read: the printed command opens the section, and always says how to get all of it', back.ok && /^##+ Avoidance/.test(back.text) && /threedog how --read \S+ --full$/.test(back.text), back.text.slice(0, 200));
  // [guard] how --read <api name> (how-field.mjs): one option by name from the API pages, through a method's option type, the createEngine options and a page's
  // properties; a typo gets close names, never a guess. The MCP tool takes the same field, so the two cannot answer differently
  const field = n => readDoc(n).text;
  check('[guard] how --read interactions.add.once prints that one option of InteractionOptions', /^InteractionOptions\.once \(api\/interactions\.md\)\n {2}`once\?: boolean`/.test(field('interactions.add.once')) && field('interactions.add.once').split('\n').length <= 4, field('interactions.add.once'));
  check('[guard] how --read: createEngine options, engine.<module>.<method>, a type with its fields', /`budget\?: BudgetLimits`/.test(field('createEngine.budget')) && /saves\.autosave\(minutes/.test(field('engine.saves.autosave'))
    && /fields: .*\bonce\b.*\bcounter\b/.test(field('InteractionOptions')), field('InteractionOptions'));
  check('[guard] how --read: an unknown name is not ok and lists close names', !readDoc('interactions.ad.once').ok && /Close: .*interactions\.add/.test(field('interactions.ad.once')), field('interactions.ad.once'));
  // [guard] review 2026-11-09 (research/2026-11-09-gpt-review-agent-entry.md): a named option heading ("followCamera options"), two levels through a field's type,
  // a type it extends, an inline { files? } in the signature, and a namespace typed wrong; each once answered "unknown"
  for (const [name, re] of [['followCamera.pointerLock', /^FollowCameraOptions\.pointerLock /], ['createEngine.budget.fps', /^BudgetLimits\.fps /], ['characters.addPlayer.speed', /^CharacterOptions\.speed /],
    ['saves.exportFile.files', /^saves\.exportFile\.files \(an inline option/], ['engine.onFixed.channel', /^engine\.onFixed\.channel /]]) check(`[guard] how --read ${name}`, readDoc(name).ok && re.test(field(name)), field(name));
  check('[guard] how --read: a namespace typed wrong gets the whole name back', /Close: interactions\.add\.once\./.test(field('interactons.add.once')), field('interactons.add.once'));
  check('[guard] the MCP how tool reads the same name', (await STATIC_TOOLS.how.run(game, { read: 'interactions.add.once' })).text === field('interactions.add.once'));
  // [guard] the whole answer, with its section, stays within the output rule in bytes and lines
  const long = await answer(game, 'save and load the game');
  check('[guard] how: the answer with its section is at most 4000 bytes and 40 lines', Buffer.byteLength(long.text) <= 4000 && long.text.split('\n').length <= 40 && /^The section/m.test(long.text) && /--read \S+ --full$/m.test(long.text), `${Buffer.byteLength(long.text)} B, ${long.text.split('\n').length} lines`);
  check('[guard] how: English beside other text keeps its answer, the line first', /^Search words are English/.test(mixed.text) && /Recommended/.test(mixed.text), mixed.text.slice(0, 200));
  check('[guard] how: a plain English task is not told to use English', !/Search words are English/.test((await answer(game, 'rain')).text));
  check('[guard] how: word forms reach the docs word (losing -> lose, enemies -> enemy)', queryTokens('losing').concepts[0].alts.some(x => x.a === 'lose') && queryTokens('enemies').concepts[0].alts.some(x => x.a === 'enemy'));
  // [guard] plain task words reach api pages and recipe/COMMANDS text, not only the AI.md rows; "never used" is said only after a search of every docs line.
  // The queries are not the ones from the test reports: a word of an api line (jingle is not in it, victory is), a word that is only a form of a docs word, a word only in a body line
  const at = (q, re, n = 5, o) => search(docs, q, n, o).some(h => re.test(h.line));
  check('api names are found by task words: "victory jingle" -> music.stinger, "interrupt keys typo" does not fail, "wheel suspension" -> rigid',
    at('victory jingle', /music\.stinger/) && at('wheel suspension', /rigid/), JSON.stringify(search(docs, 'victory jingle').map(h => h.line)));
  check('a word only in a recipe body line is found ("dissolve" sits in recipe 09 under a heading about something else)', at('dissolve', /09-materials/),
    JSON.stringify(search(docs, 'dissolve').map(h => h.line)));
  const fakeDocs = mkdtempSync(join(tmpdir(), 'how-lines-'));
  mkdirSync(join(fakeDocs, 'recipes'));
  writeFileSync(join(fakeDocs, 'recipes', '01-a.md'), '# Alpha\n\n## 1. Basics\nStart here.\n\nThe zeppelin mooring is a body line, under no heading that names it.\n');
  const zep = search(fakeDocs, 'zeppelin mooring'), nope = search(fakeDocs, 'zeppelin submarine');
  rmSync(fakeDocs, { recursive: true });
  check('a word only in a recipe body line is found, and a word in no line is the only one reported unused', zep.length > 0 && zep.unknown.length === 0 && nope.unknown.join() === 'submarine', JSON.stringify({ zep, unknown: nope.unknown }));
  // renderer: in a TSL game the GLSL-only row is not the first answer for a shader task; in a GLSL game it still is a good answer
  const own = search(docs, 'custom shader material', 5, { renderer: 'webgpu' }), ownGl = search(docs, 'custom shader material', 5, { renderer: 'webgl' });
  check('the game\'s renderer orders shader answers: TSL game does not start with the GLSL-only row; the same row stays in the list', !/onBeforeCompile/.test(own[0]?.line ?? '') && /onBeforeCompile/.test(ownGl[0]?.line ?? '') && own.length > 0, JSON.stringify([own.map(h => h.line.slice(0, 80)), ownGl.map(h => h.line.slice(0, 80))]));
  const shaderHits = ['custom sky shader', 'custom shader on a material'].flatMap(q => search(docs, q, 5, { renderer: 'webgpu' }));
  check('[guard] a WebGPU game is not shown GLSL as the answer: no GLSL sample printed under a row, and no onBeforeCompile row first',
    !shaderHits.some(h => /ShaderMaterial|onBeforeCompile/.test(h.para ?? '')) && !/onBeforeCompile/.test(search(docs, 'custom sky shader', 5, { renderer: 'webgpu' })[0]?.line ?? ''), JSON.stringify(shaderHits.map(h => h.para)));
  const wrong = TASKS.map(([q, want]) => [q, search(docs, q)[0]?.line ?? '(none)', want]).filter(([, first, want]) => !want.test(first) || /technique examples/.test(first));
  check(`${TASKS.length} common tasks: the first answer is the one recommended entry, never a technique example`, wrong.length === 0, wrong.map(([q, l]) => `"${q}" -> ${l}`).join('\n'));
}
