// Stable error codes: errors the engine raises by name end their message with "[code]" and carry err.code / err.fix / err.docs (codedError in errorHints.js).
// Plain data with no imports (node tools load it through threedog/error-hints). A code never changes meaning once shipped: tools and tests match on it.

// Naming rule for a NEW code: `<area>-<problem>` in lowercase with hyphens (save-version, unknown-name): the area first so the codes sort
// and grep by subsystem. Codes already published keep their names even where they do not follow it (renaming would break the tools and tests that match them).
// One code per kind of misuse per module: the message names the exact call, the value it got and the accepted values; the fix says what to change.
// The engine used something other than what the game gave (design.md 2.4) and the game can go on: a warnOnce(coded(code, text)), never silent, with a code
// named by what happened: `<area>-clamped` kept to a documented range, `<area>-fallback` another way or value used because the asked one cannot run here,
// `<area>-ignored` not applied at all, `<area>-replaced` the engine works on its own copy or name in its place. The text names the value, what was used
// instead and the option to change; describe().warnings lists them.

/**
 * Errors the engine raises by name (the message ends with "[code]"): code -> { fix, docs }. Codes are stable: tools and tests may match on them.
 * brief: a hint that stays one line on the console, because its message already says where the rest is; err.fix and errorInfo still give it.
 * @type {Record<string, { fix: string, docs: string[], brief?: boolean }>}
 */
export const ERROR_CODES = {
  'save-part-threw': {
    docs: ['recipes/20-content-actions-save.md §"Save failures and versions"', 'api/saves.md'],
    fix: 'A save part\'s save() threw or returned what a save cannot hold, so nothing was written and the previous save is kept. Fix the save() named in the message ' +
      '(it must return plain data; NaN and Infinity at any depth count, and the message gives the path).' },
  'save-load-threw': {
    docs: ['recipes/20-content-actions-save.md §"Save failures and versions"', 'api/saves.md'],
    fix: 'A save part\'s load() threw, so the game was rolled back to how it was before the load. Fix the load() named in the ' +
      'message.' },
  'save-refused': {
    docs: ['recipes/20-content-actions-save.md §"Save failures and versions"', 'api/saves.md'],
    fix: 'The save is unreadable, from a newer build, or a migrate step is missing; nothing changed. Add the migrate step, or run ' +
      'the newer build.' },
  'save-version': {
    docs: ['recipes/20-content-actions-save.md §"Save format"', 'api/saves.md'],
    fix: 'saves.define(key, { version, migrate }): version is a whole number >= 1; migrate keys are older versions, each a ' +
      'function data => newData.' },
  'save-import': {
    docs: ['recipes/20-content-actions-save.md §"Save failures and versions"', 'api/saves.md'],
    fix: 'Import only text or files made by saves.export / exportFile; attachments must be data: URLs. Nothing was fetched or ' +
      'changed.' },
  'save-key-taken': {
    docs: ['recipes/20-content-actions-save.md §"Save format"', 'api/saves.md'],
    fix: 'One owner per save key: pick another key, or call remove() on the handle of the first saves.define before defining it again.' },
  'save-busy': {
    docs: ['recipes/20-content-actions-save.md §"Save failures and versions"', 'api/saves.md'],
    fix: 'Wait for the load to end (await it) before collecting. engine.saves.save waits by itself.' },
  'save-nested': {
    docs: ['recipes/20-content-actions-save.md §"Save failures and versions"', 'api/saves.md'],
    fix: "Something waits behind a state replacement that has not ended; with no sign of life for loading.timeoutMs it fails with this code. If a save part's load() or a module's afterLoad awaits it, it waits for itself: pass the turn they are given to " +
      'level.load / content.load ({ turn }). A new saves.apply / load / save or session.newGame / load / quit starts after the running one: do not await it there, or ask from a save:loaded or session:start listener.' },
  'save-autosave': {
    docs: ['recipes/20-content-actions-save.md §2', 'api/saves.md'],
    fix: 'saves.autosave(minutes) takes a positive number of minutes of play.' },
  'session-early': {
    docs: ['recipes/20-content-actions-save.md §4', 'api/engine.md'],
    fix: 'engine.session needs the new-game state that start() captures: call it from a button or after `await engine.start()`.' },
  'session-start-missed': {
    docs: ['recipes/20-content-actions-save.md §4', 'api/engine.md'],
    fix: "The first playthrough began inside engine.start() (?play, or newGame / load during start), so a session:start listener added after `await engine.start()` missed it. Add the listener before start(), or read the state after it: engine.session.playing, engine.events.recent('session:start')." },
  'clock-interval': {
    docs: ['recipes/06-clock-events.md', 'api/clock.md'],
    fix: 'clock.after / every take a finite number of calendar seconds (every needs > 0). For every fixed step use engine.onFixed.' },
  'threads-option': {
    docs: ['recipes/15-perf.md §4', 'api/engine.md'],
    fix: 'createEngine({ threads }) takes \'auto\', a worker count (0 = none) or false.' },
  'threads-transfer': {
    docs: ['recipes/15-perf.md §4', 'api/engine.md'],
    fix: 'The worker died after the task moved its buffers away (transfer), so the task cannot rerun on the main thread. Resend ' +
      'it, or send it without transfer.' },
  'pure-function': {
    docs: ['recipes/18-world.md', 'recipes/15-perf.md §4'],
    fix: 'A worker function sees only its parameters and worker-safe globals (Math, JSON, Number...): no closure variables, ' +
      'engine, window or document. Pass values in, or store them on the record.' },
  'asset-name-clash': {
    docs: ['recipes/05-props-bake.md', 'api/assets.md'],
    fix: 'One name was registered as two asset types (models / textures / sounds). Give each its own name, e.g. grass and ' +
      'grass_tex.' },
  'audio-synth-gone': {
    docs: ['recipes/31-audio.md §1', 'api/audio.md'],
    fix: 'A synthesized sound is an asset: register the function in assets.manifest({ sounds: { ding: fn } }); audio.sounds entries only say ' +
      'how it plays (src: the sound name, volume, variants, bus).' },
  'audio-name-clash': {
    docs: ['recipes/31-audio.md §8', 'api/audio.md'],
    fix: 'One audio name is defined twice: a sound / footstep in both createEngine({ audio }) and a content pack, or a rule key that ' +
      'is both a condition and a measure. Keep each name in one place.' },
  'engine-disposed': {
    docs: ['api/engine.md'],
    fix: 'engine.dispose() ran, so start() stopped or refused to run. Create a new engine instead of starting a disposed one.' },
  'skip-amount': {
    docs: ['recipes/06-clock-events.md §2', 'api/engine.md'],
    fix: 'engine.skip takes { to: \'06:00\' } (needs the calendar module) or { seconds: 600 } (calendar seconds, > 0).' },
  'skip-busy': {
    docs: ['recipes/06-clock-events.md §2', 'api/engine.md'],
    fix: 'Await the skip that is running (engine.skip returns its Promise), then call engine.skip again.' },
  'stream-timeout': {
    docs: ['recipes/18-world.md', 'api/stream.md'],
    fix: 'The teleport destination did not finish loading in time (terrain, colliders, nearby models). Read describe().loading or ' +
      '`threedog loading`; raise { timeout } or check the place exists.' },
  'stream-removed': {
    docs: ['recipes/18-world.md §6', 'api/stream.md'],
    fix: 'A stream source was removed (remove(), its until, or engine.dispose) before it was ready, so its whenReady rejects. Await ' +
      'whenReady only on a source you keep. stream.teleport also rejects with it when a new game or a load replaced the state during the trip: start the trip again from the new state if it is still wanted.' },
  'stream-option': {
    docs: ['recipes/33-stream-sources.md', 'api/stream.md'],
    fix: 'stream.source(position, { detail }) takes \'full\' or \'simple\'; stream.radius takes a finite number of meters or null.' },
  'op-misuse': {
    docs: ['recipes/23-ops.md §1', 'api/engine.md'],
    fix: 'Ops are defined with ops.define(name, { can, run }) and run with ops.run(name, args); args are plain data and can() only ' +
      'reads. The message says which rule was broken.' },
  'halt-owner': {
    docs: ['recipes/23-ops.md §11', 'api/engine.md'],
    fix: 'const h = engine.haltLoop(owner); ... h.remove() ends that owner\'s halt; the loop restarts only when every owner has removed theirs.' },
  'mod-owner': {
    docs: ['recipes/55-mods-time-wrap.md §"The rules in full"', 'api/engine.md'],
    fix: "engine.mod(point, { owner, set | add | mul | clamp, layer?, for?, clock?, id? }): owner is a non-empty string, exactly one of set / add / mul / clamp for a number (set for a value point); in a module ctx.mod(point, { mul }) names the module itself. haltLoop / freeze / takeCamera / debug.view name their owner the same way. Only that owner ends it, with the handle's remove()." },
  'shared-conflict': {
    docs: ['recipes/55-mods-time-wrap.md §"The rules in full"'],
    fix: "Two owners set one shared value on the same layer, so nothing says which one decides (every build throws; the first value stays). Copy one fix from the message: contribute instead (mul / add), decide on another layer ({ layer }), or take it over on purpose (manual, or a set on the system layer)." },
  'shared-taken': {
    docs: ['recipes/55-mods-time-wrap.md §"Replacing a module"', 'recipes/14-custom-module.md §2'],
    fix: "Two modules provide the same exclusive slot (provides: ['inventory']; terrain and level both hold 'ground'). Install only one, or swap: engine.use(mine(), { replaces: 'inventory' }) unloads the holder and its changes. Terrain and level together: give both { part: true } and add compositeGround({ parts })." },
  'shared-settings': {
    docs: ['recipes/55-mods-time-wrap.md §"Picture points follow"'],
    fix: "The settings layer only restricts what the scene chose: clamp or mul on a number, set: false on a value point. It cannot switch something on or raise it; leave the setting out to allow the scene's value." },
  'shared-value': {
    docs: ['recipes/55-mods-time-wrap.md §"The rules in full"'],
    fix: 'A number shared value got a value it cannot combine: set / add / mul take a finite number; clamp takes { min?, max? } with each given bound a finite number and min <= max. The same check runs on engine.mod and on handle.change, so a NaN never reaches the value.' },
  'shared-layer': {
    docs: ['recipes/55-mods-time-wrap.md §"The rules in full"'],
    fix: "layer is one of engine < game < effect < system < settings < debug (default game); most code never passes it." },
  'views-define': {
    docs: ['recipes/46-blender-art-route.md §"The same shot"', 'api/engine.md'],
    fix: "engine.views.define(name, { position: [x, y, z], target?: [x, y, z], fov? }): position and target are 3-number arrays." },
  'ops-guard': {
    docs: ['recipes/23-ops.md §5'],
    fix: 'Gameplay state (world, containers, vars, quests) was changed outside a fixed step and outside an op. Do it inside ' +
      'engine.ops.run(...) or an onFixed / module fixed hook.' },
  'quest-step': {
    docs: ['recipes/04-quests.md §1', 'api/quests.md'],
    fix: "A quest step is wrong. In a definition: each step has done (a function) or all: [parts] with at least one part not optional, and step ids are unique. In a save: a step id the definition no longer has restarts the quest from its first step; keep step ids stable, or add a migrate step to the quests save part." },
  'save-write': {
    docs: ['recipes/20-content-actions-save.md §"Save failures and versions"', 'api/saves.md'],
    fix: 'The browser refused to store the save (storage full, private mode, blocked IndexedDB); the previous save is kept. Free ' +
      'space or export the save as a file.' },
  'save-bad-record': {
    docs: ['recipes/20-content-actions-save.md §"Save failures and versions"', 'api/saves.md'],
    fix: "A core field of saved data is malformed (a position that is not three finite numbers, a record without kind, a swarm without its columns); the load was refused and rolled back. The save was edited by hand or damaged: fix the field the message names, or load another save." },
  'save-value': {
    docs: ['recipes/20-content-actions-save.md §"Save failures and versions"', 'api/saves.md'],
    fix: 'A saved number was not finite or out of range (a negative clock, a count beyond any stack), or a saved shared value broke a rule engine.mod checks; it was clamped or dropped and the ' +
      'rest of the part loaded. The save was edited by hand or damaged; save again to write the fixed values.' },
  'save-stale': {
    docs: ['recipes/20-content-actions-save.md §"Save failures and versions"', 'api/saves.md'],
    fix: 'Another tab or window of this game saved into this slot after this one last loaded or saved it, so it was not overwritten ' +
      '(that would lose the newer progress). Load the slot to continue from it, save into another slot, or close the other tab.' },
  'budget-over': {
    docs: ['recipes/15-perf.md §2', 'api/budget.md'],
    fix: 'A performance budget set with createEngine({ budget }) was exceeded; the message names the biggest costs. Measure with ' +
      'describe().perf or npm run perf.' },
  'budget-option': {
    docs: ['recipes/15-perf.md §2', 'api/budget.md'],
    fix: 'A budget limit was set that this renderer cannot measure (gpuMemoryMB is counted by three only on WebGPURenderer), so it is not checked. ' +
      'Use createEngine({ renderer: "webgpu" }) to check it, or watch engine.counts() (geometries, textures) instead.' },
  'webgpu-records-unread': {
    docs: ['recipes/56-webgpu-tsl.md'],
    fix: 'three.js changed the private list of draw records the WebGPU sweep reads (usually a three upgrade), so the sweep is off and the game runs on. ' +
      'Until the engine is updated, send the event yourself when a mesh is gone for good: mesh.dispatchEvent({ type: \'dispose\' }).' },
  'geometry-undisposed': {
    docs: ['recipes/56-webgpu-tsl.md §"Dropping a mesh"'],
    fix: 'Meshes are leaving the scene with their geometry never disposed, so the renderer keeps counting it. Call mesh.geometry.dispose() when a mesh is gone for good, ' +
      'or engine.remove(mesh). Geometry parked for reuse is fine; this warns only about a steady climb.' },
  'jobs-slow': {
    docs: ['recipes/15-perf.md §4', 'api/jobs.md'],
    fix: 'A job step ran too long or a job queued too many steps. Yield more often inside the generator (engine.jobs.add(function* ' +
      '() { ...; yield; })).' },
  'jobs-endless': {
    docs: ['api/jobs.md'],
    fix: 'A job with apply reached its due tick and engine.jobs.maxSteps steps were not enough to finish it, so its promise rejected and apply did not run. ' +
      'A generator that loops forever needs an end; one that is only long needs a later lag or a higher engine.jobs.maxSteps.' },
  'threads-crash': {
    docs: ['recipes/15-perf.md §4', 'api/engine.md'],
    fix: 'A worker failed or went silent past the lane timeout (the reason is printed with it); the lane now runs on the main thread with the same ' +
      'results, only slower. Fix the worker file or its imports; a lane whose tasks really take longer passes a bigger lane({ timeout }).' },
  'input-bound-twice': {
    docs: ['recipes/58-input.md §4', 'api/input.md'],
    fix: "Two different owners bound the same action (createEngine({ bindings }) of the game and a module, or two modules). One owner binds an action: keep one of the two, or bind another action name. The same owner binding again just replaces its keys." },
  'input-action-context': {
    docs: ['recipes/58-input.md §4', 'api/input.md'],
    fix: 'Two owners declared one action in different input contexts. An action belongs to one context: rename one of them, or declare both in ' +
      'the same context (then they share the action).' },
  'input-seat': {
    docs: ['recipes/58-input.md §"Local players on one"', 'api/input.md'],
    fix: 'A seat owns its pad and keys alone. Give each seat its own pad index and keys, or remove() the seat that holds them; one seat drives one player.' },
  'input-unbound': {
    docs: ['recipes/58-input.md §4', 'api/input.md'],
    fix: "An action a module needs is read but no key is bound, so it never fires. Modules bind no keys: bind it with " +
      "engine.input.bind('action', ['KeyX']), createEngine({ bindings }) or a presets.bindings.* map." },
  'interaction-no-key': {
    docs: ['recipes/63-third-person-start.md §4', 'recipes/58-input.md §4', 'api/interactions.md'],
    fix: 'Interactions were added but their action has no key, so no key press reaches them; the game keeps running. Bind it in createEngine({ bindings }) or with ' +
      'engine.input.bind; any key works, and bind it to [] if the game reaches them another way (a click, a touch, its own button): that ends this warning.' },
  'signal-overwritten': {
    docs: ['recipes/62-picture-code.md §2'],
    fix: 'This signal has one writer that rewrites it every frame, so a direct write lasts at most a frame. The message names the entry that changes it.' },
  'asset-cache': {
    docs: ['recipes/05-props-bake.md', 'api/assets.md'],
    fix: 'The dev model cache could not be used, so code-generated models are built from code. Run the game through its vite ' +
      'config (threedog gameConfig); npm run bake once a model is final.' },
  'webgl-lost': {
    docs: ['api/engine.md'],
    fix: 'The browser dropped the WebGL context (GPU reset, too many tabs); gameplay waits until it is restored. Nothing to fix ' +
      'unless it repeats: then lower quality or texture sizes.' },
  'module-params': {
    docs: ['recipes/51-capability-catalog.md §3'],
    fix: "A module option or call argument does not fit (unknown key, wrong type, out of range or not one of the allowed values). The message names it and what it should be; engine.catalog(name).params lists every option with its default." },
  'module-dispose': {
    docs: ['recipes/14-custom-module.md §2'],
    fix: 'A module\'s dispose(e) threw; the other modules and core were still cleaned up. Fix that module\'s dispose.' },
  'module-order': {
    docs: ['recipes/14-custom-module.md §2', 'api/engine.md'],
    fix: 'A module\'s before / after contradicts the stage order (stages always run in order; before / after only order modules inside one ' +
      'stage). Give both modules the same stage, or remove the before / after.' },
  'module-critical': {
    docs: ['recipes/14-custom-module.md §2', 'api/engine.md'],
    fix: 'A module declared critical: true failed in init(), or a provider it requires failed, so start() stopped instead of starting a broken game. The message names the module ' +
      'and the reason: fix that init(), or drop critical if the game can run without it.' },
  'module-contract': {
    docs: ['recipes/14-custom-module.md §2', 'recipes/49-game-module-contract.md §"The five contracts"'],
    fix: "A module provides (or another module requires) a capability the engine has a contract for, and its API lacks methods or fields that contract lists. Add them, or accept the risk " +
      "if your game calls none of them: the module still runs. The behavior half of the contract is checked by runContract from @threedog/tools/contract." },
  'module-not-ready': {
    docs: ['recipes/14-custom-module.md §2', 'api/engine.md'],
    fix: 'start() waited longer than engine.loading.timeoutMs for modules whose isReady(e) stays false. Fix what that module waits for, ' +
      'or raise engine.loading.timeoutMs if the load is only slow. engine.loading.view().waiting names the current item.' },
  'step-during-load': {
    docs: ['api/engine.md'],
    fix: 'engine.step() ran during a load nobody awaited. Await engine.start(), or the session.newGame / load / quit that is running, then step.' },
  'step-seconds': {
    docs: ['api/engine.md'],
    fix: 'engine.step(seconds) takes a finite number >= 0 in real seconds: 0 advances nothing, 0.5 is half a second, 1 / 60 is one fixed step.' },
  'player-control': {
    docs: ['recipes/01-new-game.md §3', 'api/characters.md'],
    fix: "addPlayer() has no default feel: give control. Usually addPlayer({ ...presets.player.thirdPerson, spawn }); else control: 'camera' | " +
      "(player, input, dt) => ({ x, z }) (null stands still), plus cameraFollow as wanted (run / jump keys: presets.bindings.walk). The game moving the player itself " +
      "takes control: engine.control.take(player, { owner, layer: 'script', step })." },
  'control-conflict': {
    docs: ['recipes/57-control.md §"Who takes what"'],
    fix: "Two owners want the same character on the same control layer, so nothing says which one steers, and the first keeps it (every build). " +
      "End the old one first (its handle.remove()), or take another layer: base < script < cutscene (higher pauses lower)." },
  'control-net': {
    docs: ['recipes/57-control.md §"Who takes what"', 'recipes/27-net.md §4'],
    fix: "That character is driven by another machine (net holds its control for good). Change it where it is driven: run an op the host runs " +
      "(engine.ops.run), or steer the character that is yours (engine.player)." },
  'control-bypass': {
    docs: ['recipes/57-control.md §"Moved by script"'],
    fix: "character.move() was called on a character someone controls, from outside that owner. Take control and move through it: " +
      "const h = engine.control.take(ch, { owner, layer: 'script', step }) (or h.move(x, z, run, dt)), then h.remove() to hand it back." },
  'control-layer': {
    docs: ['recipes/57-control.md §"Who takes what"'],
    fix: "engine.control.take(character, { owner, layer?, step? }): a character (or its id), a non-empty owner name, layer 'base' | 'script' | 'cutscene' (physics and net are the engine's own), step a function (dt, ch) => ({ x, z, run }) or left out." },
  'interaction-setup': {
    docs: ['recipes/02-npc.md', 'api/interactions.md'],
    fix: 'interactions() has no default pick: use interactions({ ...presets.interactions.nearest }) or interactions({ pick }); the game binds ' +
      "the 'interact' keys (createEngine({ bindings: presets.bindings.interact }))." },
  'open-world-camera': {
    docs: ['recipes/21-camera.md', 'api/openWorld.md'],
    fix: "openWorld() installs no camera on its own: pass camera: 'follow' | 'firstPerson' | 'rts' | 'fixed' | a camera module | false." },
  'lightpool-dusk': {
    docs: ['api/lightPool.md', 'recipes/09-materials-lights-models.md §"Night glow: emissive"'],
    fix: 'A lightPool source has a wrong dusk value, or follows daylight while nothing tells day from night: install sky() or calendar(), or register the daylight measure.' },
  'engine-terms': {
    docs: ['recipes/52-around-the-picture.md §"Surfaces: ground, plants"'],
    fix: 'engine.shaderTerms was given a spec it cannot draw: a term is { glsl, tsl, uniforms?, pars?, slot? } with the form this renderer needs, or false for none.' },
  'engine-two-copies': {
    docs: ['THREE.md'],
    fix: "vite.config.js: resolve: { dedupe: ['threedog', 'three'] }. Two copies of threedog are loaded (the message names both paths); each hooks THREE.Mesh.prototype for shadows, so keep one: `npm ls threedog`, and packs / tools list threedog as a peerDependency." },
  'debug-override': {
    docs: ['recipes/40-scene.md §9'],
    fix: "engine.debug.override(owner, target, patch): owner names who sets it (engine.debug.clear(owner) removes all of them), target is a thing id or Object3D, " +
      "patch is { visible?, material?: 'flat' | 'wire', apply? }; a three.js value: override(owner, object, key, value). Overrides change only what the screen shows and are never saved." },
  'plugin-shape': {
    docs: ['THREE.md', 'recipes/40-scene.md §1'],
    fix: 'A file in the plugins folder is plugged by what it exports: an Object3D, a three.js Pass, a post effect { name, create | node | fuse }, ' +
      'a module { name, type, install }, or an array of these (default export, else every named export). ' +
      'A function is never a plugin (on either renderer): export what a factory returns (export default makeIt({ ... })), a node pass as { name, node }; threedog lib pull writes that line for library code. plugins.json names only files that exist.' },
  'thing-id': {
    docs: ['recipes/40-scene.md §4'],
    fix: "Ids given to engine.add(obj, { id }) are non-empty strings without '#', unique across engine.add objects and world records. " +
      'engine.thing(id) takes such an id, a world record id, an object name or an Object3D; the message suggests the closest id.' },
  'thing-owned': {
    docs: ['recipes/40-scene.md §4b', 'recipes/18-world.md §4b'],
    fix: "Two systems manage one object: a world model is placed by world every frame. Change the record (ops.run('thing.set', { id, " +
      "position }), world.set / world.move) instead of the model, and never engine.add a model world built." },
  'thing-unsaved': {
    docs: ['recipes/40-scene.md §3'],
    fix: 'An object you expect to keep cannot be saved: it has no stable id or was added during play. Give it an id at setup ' +
      "(engine.add(obj, { id })), or make it a template and create it inside an op with engine.content.spawn(name, at)." },
  'thing-orphan': {
    docs: ['recipes/40-scene.md §4c'],
    fix: "The 'scene' save part names an id no engine.add object has: the code that added it changed its id or no longer runs. " +
      'The data is kept in the save; restore the id, or ignore it if the object was deleted on purpose.' },
  'engine-misuse': {
    docs: ['api/engine.md'],
    fix: 'An engine call got an argument it cannot use; the message names the call and the accepted forms.' },
  'pixel-conflict': {
    docs: ['recipes/62-picture-code.md §4b', 'api/engine.md'],
    fix: 'pixelSize decides the render resolution, and a camera\'s pixelSnap its view height, while they are on; something else asked for it too. The message names both: keep one, or turn it off first (engine.setPixelSize(null), or drop pixelSnap).' },
  'many-lights': {
    docs: ['recipes/09-materials-lights-models.md §1b', 'api/lightPool.md'],
    fix: "Too many real-time lights are in the scene (the message has the count). Use engine.use(lightPool({ point: 8 })) and register torches / lamps with engine.lightPool.add(...), so a fixed small set of real lights follows the nearest sources." },
  'light-recompile': {
    docs: ['recipes/09-materials-lights-models.md §1b', 'api/lightPool.md'],
    fix: 'The number of lights changed during play, so three.js compiled new shader programs (a long frame). Keep the light ' +
      'count fixed: engine.use(lightPool({ point: 8 })) before engine.start() and register torches / lamps with ' +
      'engine.lightPool.add(...), or create your own lights before start and fade them with intensity instead of adding, ' +
      'removing or hiding them.' },
  'preset-option': {
    docs: ['api/openWorld.md', 'api/engine.md'],
    fix: 'An openWorld() / preset option has a wrong value or a part name it does not know. The message lists the accepted values; ' +
      'use one of them, or leave the key out for the default.' },
  'asset-misuse': {
    docs: ['api/assets.md', 'recipes/05-props-bake.md'],
    fix: "An engine.assets call got a model it does not know, an object that is not an assets.model() copy, or setParams on a model with no params schema. Register the model (engine.assets.manifest) and pass its name, or the object assets.model() returned." },
  'batching-option': {
    docs: ['recipes/15-perf.md'],
    fix: "createEngine({ batching }) takes false or an object with the keys named in the message." },
  'debug-view': {
    docs: ['recipes/15-perf.md §1', 'api/engine.md'],
    fix: 'engine.debug.defineView(name, { what, apply }): the name must be new (not a built-in view mode) and apply(scene) returns ' +
      'what to restore. Pick another name or fix the definition.' },
  'probes-option': {
    docs: ['recipes/34-environment-lighting.md §"Light probes (baked indirect light)"', 'api/engine.md'],
    fix: 'engine.bakeProbes / loadProbes got a wrong option: bounds must be a Box3 or { min, max }, spacing a positive number of meters ' +
      '(raise it when the grid has too many probes). On a device that cannot render to float textures, bake elsewhere and ship the file.' },
  'probes-check': {
    docs: ['recipes/34-environment-lighting.md §"Light probes (baked indirect light)"'],
    fix: 'A probe grid is live and something around it will look wrong: lit objects reach outside it (widen bounds or light them another way) ' +
      'or other light adds to what the bake saw (lower it where the probes take over). The details are in describe().render.probes.' },
  'probes-data': {
    docs: ['recipes/34-environment-lighting.md §"Light probes (baked indirect light)"', 'api/engine.md'],
    fix: 'engine.loadProbes(json) was given data that is not a probe file (or a damaged one), so nothing was added. Pass what ' +
      'handle.toJSON() returned, or bake again with engine.bakeProbes.' },
  'lightmap-data': {
    docs: ['recipes/34-environment-lighting.md §"Lightmaps (baked light on what never moves)"', 'api/engine.md'],
    fix: 'engine.loadLightmap(file) was given something that is not a file from `threedog bake light`, or a damaged one, so nothing was changed. Bake it again.' },
  'lightmap-check': {
    docs: ['recipes/34-environment-lighting.md §"Lightmaps (baked light on what never moves)"'],
    fix: 'A lightmap is on and something around it will look wrong: a baked mesh moved or is missing, a baked material is shared with an unbaked mesh, ' +
      'or ambient light adds to what the bake saw. The details are in describe().render.lightmap.' },
  'grid-data': {
    docs: ['recipes/29-grid.md', 'api/grids.md'],
    fix: 'sampleGrid / gridFromImage / decodePng got data it cannot read: wrong width * height, an unknown interp or channel, or a PNG ' +
      'kind it does not decode (interlaced, palette). Fix the numbers, or re-save the image as plain 8 / 16-bit gray or RGB.' },
  'ground-missing': {
    docs: ['api/ground.md'],
    fix: 'Nothing provides ground height at that spot: install terrain() or a level with a heightfield, or place the object at an ' +
      'explicit y instead of snapping it.' },
  'input-owner': {
    docs: ['api/input.md'],
    fix: 'input.push(name, { owner }) needs a non-empty owner string (who pushed the context), so pop / describe can tell owners apart.' },
  'owned-misuse': {
    docs: ['recipes/52-around-the-picture.md §"Who writes it"', 'THREE.md'],
    fix: 'defineOwned / engine.autoView.manual(key) was called wrongly: a module definition misses id / part / read / levels.manual, or ' +
      'manual() named a key the part does not write. Use a key listed in the message.' },
  'shadow-cascades': {
    docs: ['recipes/45-cascaded-shadows.md'],
    fix: 'engine.shadows (cascades, box, budget, include, enabled) was called wrongly: the message names what to change. ' +
      'An engine draws one set of cascades, and a light takes a box or cascades, not both.' },
  'wrap-misuse': {
    docs: ['recipes/55-mods-time-wrap.md §"Wrapping a module"'],
    fix: "engine.wrap(target, method, fn): target is an object, fn a function, and method the name of a method that exists on it (the message lists the public ones). A name with a leading _ is the object's inside: it can be wrapped, a dev warning says so once, and an engine update may change it without notice." },
  'ambience-rule': {
    docs: ['api/ambience.md', 'api/audio.md'],
    fix: 'An ambience rule names no sound: give sound: a name registered in audio.sounds.' },
  'camera-clamped': {
    docs: ['recipes/21-camera.md', 'api/cameraRig.md'],
    fix: 'A camera value the game asked for is outside the range of the rig, so the rig kept it inside, as documented. Widen the range the message names: followCamera({ minDistance, maxDistance, minPitch, maxPitch }), or set it on engine.cameraRig.' },
  'camera-option': {
    docs: ['recipes/21-camera.md §6', 'api/cameraRig.md'],
    fix: 'A camera option is wrong: projection is \'perspective\' or \'orthographic\' (orthographic needs size > 0 and an EngineCamera or a real OrthographicCamera), engine.camera takes a THREE.PerspectiveCamera or THREE.OrthographicCamera, ' +
      'ground / shots use the values the message lists.' },
  'character-option': {
    docs: ['api/characters.md', 'recipes/13-animation.md', 'recipes/02-npc.md'],
    fix: "A character / NPC option or model name is wrong: the message names the option and the accepted forms, and an unknown model lists the registered ones. An NPC's interact is { op: 'name', args?, ... } or null; characters.support(object, { carry, id }) takes an Object3D with meshes, a listed carry mode and a unique id." },
  'collision-misuse': {
    docs: ['api/collision.md'],
    fix: 'A collision call got a wrong argument, e.g. collision.addBlocked needs fn(x, z) => boolean.' },
  'content-id': {
    docs: ['recipes/20-content-actions-save.md §"Save format"', 'api/content.md'],
    fix: 'A content id is invalid (contains # or /) or defined twice across content files, or a rename table is malformed. Ids are ' +
      'unique per kind across files; saves match on them, so rename through the rename table.' },
  'content-misuse': {
    docs: ['recipes/20-content-actions-save.md', 'api/content.md'],
    fix: 'content.load / content files hold something the loader cannot use (an unknown key, a rule needing a module that is not ' +
      'installed, a malformed field table). Install the module named in the message or fix the entry it points at.' },
  'content-pack': {
    docs: ['recipes/20-content-actions-save.md §1b', 'api/content.md'],
    fix: 'A content pack is not a plain object, carries code where data is expected, or defines a key another pack already has. ' +
      'Give each pack its own ids.' },
  'content-template': {
    docs: ['recipes/30-templates.md', 'api/content.md'],
    fix: 'A content template definition or instance is invalid (missing model, an onUse without op, a key that is not a template ' +
      'field, a module it needs not installed). The message names the template and the field to fix.' },
  'inventory-misuse': {
    docs: ['recipes/03-items-pickups.md', 'api/inventory.md'],
    fix: "inventory.define(id): an item id may not contain '#', which marks entry keys (sword#3). Pick an id without it." },
  'grids-misuse': {
    docs: ['recipes/29-grid.md', 'api/grids.md'],
    fix: "grids(): a grid or item name is unknown or defined twice, a mapping lacks toCell / center, or a layer / preview material is not a three.js material or has nothing to draw on. Use a listed name, or the form in the message." },
  'content-layer-ignored': {
    docs: ['recipes/05-props-bake.md'],
    fix: 'collide.layer works on an upright prop only (a tilted one is held by collider3d, which has no layers): stand the model up, or drop the layer; until then it stops every mover.' },
  'level-layer-ignored': {
    docs: ['recipes/10-blender-level.md §1', 'api/level.md'],
    fix: 'The custom property layer on a col_ mesh must be one non-empty text (the name a character lists in passes). Fix it in Blender; until then the wall stops every mover.' },
  'level-node': {
    docs: ['recipes/10-blender-level.md', 'api/level.md'],
    fix: 'A level node points at content that is not defined, clashes with another record, or is used before the level loaded. Define ' +
      'the content id, or wait for level:loaded.' },
  'light-type': {
    docs: ['api/lightPool.md'],
    fix: 'lights / lightPool got a light type it does not pool. Use one of the listed types and reserve slots for it.' },
  'music-track': {
    docs: ['api/music.md'],
    fix: 'A music track is defined twice or has neither url nor stems. Define each track once with { url } or { stems }.' },
  'net-option': {
    docs: ['recipes/27-net.md', 'api/net.md'],
    fix: 'net() needs role \'host\' or \'client\' and a transport; reconnect() is for clients only.' },
  'rigid-misuse': {
    docs: ['recipes/11-vehicles.md §3', 'api/rigid.md'],
    fix: "The message says which: an id already used by another body or vehicle (give each its own id); a mesh that another body or a character already owns (one object, one physics owner: remove the first, or give the second its own object); joints lost when newGame / a load rebuilt the physics world (re-create them in a rigid:rebuilt listener, recipe 11 section 3 \"Joints\"); rigid.ragdoll() got something it cannot drive (a skinned character out of its vehicle, with the bones named when they cannot be read); or a moving body left the terrain colliders and froze (raise rigid({ terrainRing }) if it must keep moving there, recipe 11 section 3)." },
  'settings-row': {
    docs: ['api/settings.md'],
    fix: 'A settings row nobody owns or nobody draws. settings.set() with a key no row owns: use a listed key, add the tab that has the row (settings({ sections })) or define it: settings.define(key, default, apply). A defined row the menu cannot draw, in a missing tab, or drawn twice: give it min/max or options, a tab that exists, or menu: false when your own tab draws it.' },
  'settings-tab': {
    docs: ['api/settings.md'],
    fix: 'settings({ sections }) contains a built-in section that does not exist. Use a listed name, or register one with engine.settings.addSection(id, { title, render }).' },
  'time-owner-conflict': {
    docs: ['recipes/06-clock-events.md §"The time table (the single source; other docs link here)"', 'api/calendar.md'],
    fix: 'calendar() and sky({ time }) both set the time of day. calendar owns time while it is installed: move the starting time to calendar({ time }) and remove sky({ time }).' },
  'save-provider-changed': {
    docs: ['recipes/20-content-actions-save.md §"Save failures and versions"', 'api/saves.md'],
    fix: 'The module of a save part was unloaded or replaced while an earlier part of the same load was still loading, so the data read for it has nobody to take it. The load failed and rolled back (the data stays in the save). Do not unload or replace modules while a load is in flight; retry the load.' },
  'rollback-incomplete': {
    docs: ['recipes/20-content-actions-save.md §"Save failures and versions"', 'api/saves.md'],
    fix: 'A rollback could not restore one save part: its save() gave nothing before and it has no new-game state to go back to, so it keeps what the failed load or op wrote. ' +
      'Make that part\'s save() return restorable data (or give it a new-game state), then reload the page before retrying.' },
  'clock-time': {
    docs: ['recipes/06-clock-events.md', 'api/calendar.md'],
    fix: "A clock time (?time= in the URL, calendar({ time }), sky({ time }), a schedule's at, calendar.at / between, skip({ to })) is 'HH:MM' such as '18:30' or a fraction of the day 0-1 such as 0.75; words like 'night' are not times." },
  'calendar-option': {
    docs: ['recipes/06-clock-events.md', 'api/calendar.md'],
    fix: 'A calendar option, season name or scenario season is wrong (day length not > 0, a season list entry without name / days, a season the ' +
      'calendar does not have). Day, time, seasons and hours per day are calendar({...}) options; sky({ time }) is only the fixed time drawn without a calendar.' },
  'sky-option': {
    docs: ['recipes/08-weather-sky.md', 'api/sky.md'],
    fix: 'A sky or clouds option has a wrong value (day length, days and seasons are calendar() options). Own GLSL goes through ' +
      'engine.sky.clouds() and engine.sky.layer(), not an option key. The message lists the accepted values.' },
  'terrain-chunk-failed': {
    docs: ['recipes/28-terrain.md §7', 'api/terrain.md'],
    fix: 'A terrain chunk failed on every try and stays empty (no ground, no collision there). Usually the height / groundType / placement rule ' +
      'throws at that spot: fix what it reads, then engine.terrain.retry() sends the failed chunks again (terrain:chunkFailed names each one).' },
  'terrain-option': {
    docs: ['recipes/28-terrain.md', 'api/terrain.md'],
    fix: 'A terrain option or terrain edit is wrong (shape mask missing, a brush number not a number, an unknown paint). Use the form ' +
      'in the message.' },
  'vegetation-option': {
    docs: ['api/vegetation.md', 'recipes/36-ground-plants.md §"Plants and wind"'],
    fix: 'A vegetation option is wrong: positions entries, densityMap form, fade range or a model with several materials. Fix the ' +
      'entry the message points at.' },
  'vegetation-ignored': {
    docs: ['api/vegetation.md', 'recipes/36-ground-plants.md §"Plants and wind"'],
    fix: 'A model given to vegetation.define has an attribute (uv, color ...) on only some meshes; one instanced geometry keeps only what every mesh has, so its ' +
      'material draws without it. Give every mesh the attribute (a plain uv / white color on the parts that need none), or define the parts as separate species.' },
  'water-option': {
    docs: ['api/water.md', 'recipes/44-water-weather-hooks.md'],
    fix: 'A water option is wrong; own GLSL goes through engine.water.shader({ wave, surface }) and must define the function the message names.' },
  'weather-option': {
    docs: ['api/weather.md', 'recipes/44-water-weather-hooks.md'],
    fix: "A weather type, field, pool, particle definition or weather.set argument is wrong. The message lists the defined types and the accepted forms." },
  'world-option': {
    docs: ['recipes/18-world.md', 'api/world.md'],
    fix: 'A world option is wrong (an anchor shape, a simulate channel that is not a time channel). Use the form in the message.' },
  'material-option': {
    docs: ['recipes/09-materials-lights-models.md §1', 'recipes/43-shader-patches-surfaces.md §"Ready-made effects: `detail`"'],
    fix: 'A material / surface / detail / lighting spec is wrong: an unknown type, texture slot or setting, or GLSL that does not define ' +
      'the function the slot expects. The message names the key and the accepted values.' },
  'post-effect': {
    docs: ['api/post.md', 'recipes/52-around-the-picture.md §"Post effect chain"'],
    fix: 'A post effect is malformed or clashes: engine.post.add takes a three.js Pass, a node function (WebGPU) or { name, create | node | fuse }, ' +
      'with a unique name and a known slot. Change an existing effect with its handle (engine.post.get(name).set(params), .enabled); add one with engine.post.add (the one way).' },
  'own-frame': {
    docs: ['THREE.md', 'recipes/52-around-the-picture.md §"Post effect chain"'],
    fix: 'The game draws the canvas itself (its own composer.render() / renderer.render outside engine.onRender), so the engine yielded ' +
      'the frame. Intended: nothing to do. To get the engine frame back delete your render call; to add a pass to it use engine.post.add(pass).' },
  'shader-patch': {
    docs: ['recipes/43-shader-patches-surfaces.md §"Patch a slot"'],
    fix: 'A shader patch is malformed: glsl goes with a slot name (a string per slot), raw anchors use vertex / fragment, and the ' +
      'material must provide what the patch needs. The message lists the slot names.' },
  'renderer-backend': {
    docs: ['recipes/50-own-renderer.md'],
    fix: "The WebGPU route could not start as asked: WebGPU is unavailable with fallback: 'error', a NodeMaterial met fallback: 'webgl' " +
      "(WebGLRenderer cannot draw TSL; use fallback: 'webgl2'), a WebGL-only material is in the scene, or threedog/tsl is not imported. The message names which." },
  'photo-path-trace': {
    docs: ['recipes/26-ui-parts.md §"Photo mode: the picture"', 'api/photo.md'],
    fix: "photo.trace() could not trace: the game's import is missing (npm i -D three-gpu-pathtracer three-mesh-bvh, then photo({ pathTracer: () => import('three-gpu-pathtracer/webgpu') }), or 'three-gpu-pathtracer' on WebGL), " +
      'the page runs the WebGL2 fallback, no sample arrived in time, a traced photo is still accumulating, or the engine was disposed. The message names which.' },
  'ui-misuse': {
    docs: ['recipes/26-ui-parts.md', 'api/hud.md'],
    fix: 'A UI part, theme or toast call is wrong (an unknown part or verb, a value of the wrong type, the engine not passed first). ' +
      'The message lists the defined parts and the accepted forms.' },
  'module-needs': {
    docs: ['recipes/14-custom-module.md', 'recipes/18-world.md', 'api/engine.md'],
    fix: "A call needs a module that is not installed or not ready yet (the data of NPCs, props and pickups lives in world(), pickups need interactions(), timeline say needs dialogue(), rigid bodies need engine.start() first). Install the module named in the message before the one that needs it (openWorld() already includes world()), or call after engine:ready." },
  'tween-property': {
    docs: ['api/timeline.md'],
    fix: 'A tween names a property path that does not exist or is not a number / color / vector. Check the path (a.b.c) against the object.' },
  'level-size': {
    docs: ['api/level.md'],
    fix: 'The level is larger than the heightfield resolution allows, so the cell was enlarged (coarser ground). Pass a larger ' +
      'cellSize on purpose, or split the level.' },
  'nav-build': {
    docs: ['recipes/12-navmesh.md', 'api/nav.md'],
    fix: 'The navmesh could not be built from this geometry; paths fall back. The message has the builder\'s reason (usually too few ' +
      'walkable triangles or wrong cell sizes).' },
  'fog-fallback': {
    docs: ['recipes/56-webgpu-tsl.md §"Sky and fog hooks"', 'recipes/34-environment-lighting.md §"Fog: plain three.js, signals, your own math"'],
    fix: "On WebGPU the engine reads the color of scene.fogNode = fog(color, factor) only when color is a THREE.Color, color(..) or uniform(Color) (new THREE.Color(0xaabbcc), color(0xaabbcc)). With a computed color the sky dome's fog band, the water's grazing reflection and the horizon check cannot follow your fog. Give fog() a color(..) or uniform(Color), or set scene.fog too." },
  'nav-fallback': {
    docs: ['recipes/12-navmesh.md §5', 'api/nav.md'],
    fix: 'nav() builds its mesh from the ground of a level. With none (procedural terrain, or a level still loading) paths use collision A*: they work but ignore nav links, crowds and floor changes. Load a level for a navmesh, or ignore this if A* is what you want.' },
  'nav-link': {
    docs: ['recipes/12-navmesh.md §6', 'api/nav.md'],
    fix: 'A nav link needs both ends within its radius of the mesh (which stops about the agent radius short of every edge) and within maxClimb of its height, and the places ' +
      'where they meet the mesh in the same tile or neighbouring tiles (a tile is tileSize x cellSize meters). Move the end onto walkable ground, raise radius, split a long link in two, or raise tileSize.' },
  'nav-height': {
    docs: ['recipes/12-navmesh.md §5', 'api/nav.md'],
    fix: 'A height given to a path or a stop is more than a body height from every walkable surface at that spot, so the nearest surface was used. Leave y out to mean the ground, or give the height of the floor you mean.' },
  'grid-overlap': {
    docs: ['recipes/29-grid.md §2', 'api/grids.md'],
    fix: 'Two grid items claim the same cell; the second is skipped. Move one, or remove the other first.' },
  'grid-orphan': {
    docs: ['recipes/29-grid.md §2', 'api/grids.md'],
    fix: 'A placed record names an item the content no longer defines, so it has no size and takes no cells; the record is kept. Define the item again, or remove the record with grid.remove.' },
  'module-requires': {
    docs: ['recipes/14-custom-module.md §2', 'api/engine.md'],
    fix: "A module requires a capability ('world', 'inventory') no installed module provides yet. Install the engine's part of that name first (engine.use(world(), mine())), or your own module with provides: ['<name>'] (a typo is suggested in the message)." },
  'module-provides': {
    docs: ['recipes/14-custom-module.md §2'],
    fix: "provides is a list of exclusive slot names (provides: ['inventory']); a slot name must not be a shared value's name." },
  'module-replaces': {
    docs: ['recipes/14-custom-module.md §2'],
    fix: "engine.use(mine(), { replaces: 'slot' }): an installed module must hold the slot, a module in the same call must provide it, and no other module may require the old one by its module name (require the slot). The world holds every record, so it is never replaced under modules that use it or after start(): install your world before the modules that need it." },
  'module-cycle': {
    docs: ['recipes/14-custom-module.md §2'],
    fix: 'before / after constraints of two or more modules point at each other. Remove one of them or give a module a different stage.' },
  'module-type': {
    docs: ['recipes/14-custom-module.md §"Type: what the module"'],
    fix: "A module's type names what it owns: 'rules' (game logic, the default), 'world' | 'picture' | 'actor' | 'ui' | 'net' | 'tool' (core/engine/moduleTypes.js). This one is not a type: a typo?" },
  'module-type-rule': {
    docs: ['recipes/14-custom-module.md §"Type: what the module"'],
    fix: 'A warning, the call went through: a module did something its type does not usually own (a picture module defining an op or writing world records, a ui module binding keys or registering a save part). Move that part into a module of the right type, or change the type, as the message says, or leave it if the game means it.' },
  'module-stage': {
    docs: ['recipes/14-custom-module.md §2'],
    fix: 'Modules sort by stage (+ before / after), not by number. Use one of the listed stage names.' },
  'module-name': {
    docs: ['recipes/14-custom-module.md'],
    fix: 'The module name becomes engine.<name>; it must not be an existing engine property, another module name or a capability another module provides (requires and engine.<name> would reach different modules).' },
  'module-handle': {
    docs: ['recipes/14-custom-module.md §2', 'api/engine.md'],
    fix: "ctx.track(handle) (the ctx install / init receive) and engine.session.track(handle) take something with remove(), such as the result of events.on / onFixed / clock.after; ctx.borrow(obj, values) takes two objects, and one property has one holder at a time: end the first borrow, or use a shared point (engine.mod) when several parties want the value. A handle tracked after its module was unloaded (an async init resuming after replaces / unload) is removed at once: check what the init does after its await." },
  'module-called': {
    docs: ['recipes/01-new-game.md', 'api/engine.md'],
    fix: 'engine.use() takes the module object: write engine.use(sky()), not engine.use(sky).' },
  'describe-name': {
    docs: ['recipes/16-dev-bridge.md', 'api/engine.md'],
    fix: 'describe.add names share one namespace with the standard fields and module names. Pick a unique name.' },
  'input-keys': {
    docs: ['recipes/01-new-game.md', 'api/input.md'],
    fix: "Keys are names like 'KeyE', 'Space', 'PadA', 'Mouse0'. The engine binds no gameplay key on its own and modules take no keys option: bind the action the module declares, createEngine({ bindings: { ...presets.bindings.<name> } }) or engine.input.bind('<action>', ['KeyX']); [] = deliberately no key." },
  'interaction-option': {
    docs: ['api/interactions.md', 'recipes/03-items-pickups.md'],
    fix: "interactions.add(): hold is seconds the key stays down (a number >= 0), radius is meters > 0 (Infinity = from anywhere), counter is a HUD counter name, and a once item needs its own stable id or mesh.name. Fix the option the message names." },
  'hud-option': {
    docs: ['api/hud.md', 'recipes/26-ui-parts.md'],
    fix: "A hud element option is wrong: anchor is one of the listed corners / edges, a counter value is a number or text, and hud.bump needs a counter that shows a number. Fix the option the message names." },
  'describe-threw': {
    docs: ['recipes/14-custom-module.md §2', 'api/engine.md'],
    fix: "A module's describe(e, ctx) hook threw; describe() put { error, code } under that module's name and kept the rest. Fix the " +
      'hook named in the message (it must return plain data or nothing).' },
  'world-plain': {
    docs: ['recipes/18-world.md §9', 'api/world.md'],
    fix: "A saved record holds a three.js object, function or class instance. World data must be JSON-like (it is saved and may go to a worker): write { x, y, z } for a vector. A model: world.present('crate', { build: rec => mesh }), then world.view(id) gets it. Nothing to save: world.add(rec, { save: false }) may hold anything." },
  'pickup-misuse': {
    docs: ['recipes/03-items-pickups.md', 'api/inventory.md'],
    fix: "pickups.spawn() got a wrong value (give is an item id, which needs inventory(), or a function (e, { actor }) => result; radius is a positive number), or engine.pickups.material got something that is not a three.js material." },
  'world-id': {
    docs: ['recipes/18-world.md', 'api/world.md', 'recipes/03-items-pickups.md'],
    fix: "Two things claim one id: every world record (props, pickups, NPCs, template instances) shares one id space. Omit id to auto-number, give each its own id, or use world.set(id, patch) to update the existing record." },
  'world-record': {
    docs: ['recipes/18-world.md', 'api/world.md'],
    fix: 'The id was never added, was removed, or is misspelled. world.query({ kind }) lists what exists.' },
  'world-add': {
    docs: ['recipes/18-world.md', 'api/world.md'],
    fix: 'world.add({ kind, position, ... }) needs a kind; initial records need a stable id; id and kind of an existing record cannot be changed by set().' },
  'world-present': {
    docs: ['recipes/18-world.md', 'api/world.md'],
    fix: 'present(kind, { build }) must return a three.js object (or use show: rec => false to hide). Errors inside build also land here.' },
  'bad-position': {
    docs: ['CONVENTIONS.md', 'api/world.md'],
    fix: "A position was NaN, out of range or the wrong shape: a Vector3 used like an array (v[0]), a missing field, a division by zero upstream, or the old (x, z) number form. A position is one argument: a Vector3, [x, y, z] or { x, z }; a 2-element [x, z] array does not work." },
  'state-value': {
    docs: ['recipes/16-dev-bridge.md'],
    fix: 'applyState got a value it cannot use: the message names the key and the accepted forms. Nothing was applied.' },
  'content-place': {
    docs: ['recipes/20-content-actions-save.md §1b', 'api/content.md'],
    fix: 'content.load references a place that has no coordinates, or needs world() for props / pickups. Give the place in content.load({ places }) or add the marker to the level.' },
  'container': {
    docs: ['recipes/03-items-pickups.md §"Chests / corpses"', 'api/inventory.md'],
    fix: 'Container id / capacity / count was invalid, or a container used in transfer was never created. Create it first with inventory.container(id, { capacity }).' },
  'npc-behavior': {
    docs: ['recipes/02-npc.md §"Changing behavior / custom"', 'api/characters.md'],
    fix: 'The schedule / behavior name is unknown. Register it with engine.npcs.behavior(name, { near, far }) before npcs.add, or use a listed built-in.' },
  'unknown-option': {
    docs: ['api/engine.md', 'CONVENTIONS.md'],
    fix: 'An options key is misspelled or does not exist for this call (ignored, so the feature silently does nothing). Use the suggested key or one of the listed options.' },
  'unknown-name': {
    docs: ['CONVENTIONS.md', 'api/engine.md'],
    fix: 'A name (action, item, asset, weather, text key, ...) was never registered or has a typo. The message lists the registered names.' },
  'event-typo': {
    docs: ['api/events.md'],
    fix: "This event name is one letter or so from an engine event, and nothing emits it. Use the suggested name; if this really is a new event of your own, ignore the warning." },
  'owned-prop': {
    docs: ['recipes/52-around-the-picture.md §"Who writes it"', 'THREE.md'],
    fix: 'The engine wrote this value on its own (sky, camera, fog distance ...); your direct write took it over, so the engine no longer changes it. Intended: say so with the manual() call in the message. Not intended: give it back with manual(key, false) and adjust it with set(...).' },
  'picture-held': {
    docs: ['recipes/62-picture-code.md §3f'],
    fix: 'A picture value is held by a part (provides) and other code wrote it, so one of the two never reaches the screen. Delete the stray write; or swap the holder with engine.use(mine(), { replaces: slot }); or, when both need a say, make it a shared value the holder reads (recipes/62-picture-code.md §3f).' },
  'picture-leftover': {
    docs: ['recipes/62-picture-code.md §3f'],
    fix: "A picture part was removed and what it added stayed. In its install, hand each thing to ctx.track({ remove() { ... } }) (or undo it in dispose), so it goes with the part (recipes/62-picture-code.md §3f)." },
  'module-unuse': {
    docs: ['recipes/14-custom-module.md §2'],
    fix: "engine.unuse(name): the module must be installed, and no other module may still require it or a slot only it provides. Unload the dependent first, or swap the provider with engine.use(mine(), { replaces: 'slot' })." },
  'picture-conflict': {
    brief: true,
    docs: ['recipes/62-picture-code.md §3e'],
    fix: 'Two places write this value, so one write never shows. Pick the one that owns the value and delete the other, or turn the second into a signal the owner reads (recipes/62-picture-code.md §3c). Both lines are in the message.' },
  'camera-kind': {
    docs: ['recipes/21-camera.md', 'api/cameraRig.md'],
    fix: 'setCamera() got an unknown camera kind. Use one of the listed kinds; for a camera of your own, take it with engine.takeCamera(owner) and place engine.camera yourself (recipes/21-camera.md).' },
  'camera-none': {
    docs: ['recipes/21-camera.md', 'api/cameraRig.md'],
    fix: 'setCamera() switches between camera kinds once a camera module is installed. Install one first: engine.use(fixedCamera({ position, lookAt })) (or followCamera / firstPersonCamera / rtsCamera), or name one: openWorld({ camera: \'follow\' }).' },
  'movement': {
    docs: ['api/characters.md', 'api/engine.md'],
    fix: "createEngine({ movement }): every movement value is a number > 0. A typo in a name gives undefined; the message names the key." },
  'commit-fallback': {
    docs: ['api/jobs.md'],
    fix: "commits.request() needs fallback: () => result. Async results apply at fixed steps; when a result is late, the fallback computes it on the main thread, so the outcome never depends on machine speed." },
  'asset-critical': {
    docs: ['recipes/05-props-bake.md §3', 'api/assets.md'],
    fix: 'An asset marked critical: true in the manifest (or an engine.loading.track step) failed, so start() stopped instead of starting a broken game. The line names the file, HTTP status and manifest. Fix the path or the file; if the game can run without it, drop critical so it falls back. engine.loading.list({ phase: "failed" }) or threedog loading shows every failure.' },
  'asset-missing-ref': {
    docs: ['recipes/05-props-bake.md', 'api/assets.md'],
    fix: 'The model file loaded, but a file it references (texture image or .bin) is missing, usually after moving the .gltf without its folder or a case mismatch in the referenced name. Export as .glb (everything in one file) or copy the referenced files next to it.' },
  'asset-needs': {
    docs: ['recipes/05-props-bake.md §2f', 'api/assets.md'],
    fix: 'A model file lacks a node or animation clip its manifest entry declares in needs: { nodes, clips }, usually a re-export that dropped or renamed it. The line names each missing part and the closest name in the file. Restore it in the model (Blender: keep the name, check the action is not unused and has a fake user or is in an NLA track), or change needs. `threedog assets check` reads the same declaration from the glb without running the game.' },
  'asset-not-loaded': {
    docs: ['api/assets.md', 'recipes/05-props-bake.md'],
    fix: 'assets.modelNow only hands out a model something already loaded; it never starts a load. A code-built model loads too (built, or read from the bake cache). Write `modelNow(name) ?? await model(name)`, or mark it preload: true and await assets.preload() before the code that must not wait.' },
  'asset-lod': {
    docs: ['recipes/15-perf.md §4a', 'api/assets.md'],
    fix: 'assets.lod and a prop\'s lod need level files from `threedog assets optimize --lod` (skipped models say why in its report), distances as rising meters, and levels made from the same version of the model. A LOD object is never batched, so for many copies of a light model drop lod and let engine.batching draw them.',
  },
  'asset-fallback-cycle': {
    docs: ['api/assets.md'],
    fix: 'Entries name each other as fallback (A falls back to B, B back to A), so a failed load would wait on itself forever. The line lists the chain. Give one of them no fallback, or point it at a file that loads.' },
  'asset-load': {
    docs: ['api/assets.md', 'recipes/05-props-bake.md'],
    fix: "Read the reason in the message first. \"called before the backend is initialized\" means the load ran before engine.start() finished: await engine.start() first, or register the file in a manifest. Otherwise the file was not found (404) or is not valid. Check the path (files under public/ are served from /), the extension, and the case of the name. A file that is not critical falls back (a registered fallback, a stand-in texture, silence) and the game runs on; engine.loading.get(name) has the details." },
  'audio-unsupported': {
    docs: ['api/audio.md'],
    fix: 'No AudioContext in this browser / test environment. Guard calls with typeof AudioContext, or skip audio in headless tests.' },
  'indexeddb': {
    docs: ['api/saves.md', 'recipes/20-content-actions-save.md §"Save failures and versions"'],
    fix: 'Saves use IndexedDB, which is blocked in private windows and some embedded browsers. Test in a normal window, or export / import the save as a file.' },
  'gameplay-frozen': {
    docs: ['recipes/16-dev-bridge.md §8', 'recipes/14-custom-module.md §2'],
    fix: 'In dev / tests a gameplay error freezes the game on purpose, so half-applied state is not mistaken for normal. Read the error printed with it (engine.error has where + message), fix it, reload.' },
  'canvas-released': {
    docs: ['api/engine.md'],
    fix: 'engine.dispose() gave the WebGL context back to the browser, so that canvas cannot draw again. Create the new engine on a new canvas, or dispose the old one with engine.dispose({ keepContext: true }).' },
  'dispose-options': {
    docs: ['api/engine.md'],
    fix: 'engine.dispose() takes nothing or { keepContext: true }.' },
  'tsl-misuse': {
    docs: ['recipes/43-shader-patches-surfaces.md'],
    fix: "A threedog/tsl function cannot work here; the message says why. Usually: pass the engine, draw with the engine renderer, on a Mesh or InstancedMesh." },
  'vertex-inputs': {
    docs: ['recipes/56-webgpu-tsl.md §"The engine\'s shader"'],
    fix: "One program needs more vertex inputs than the device has (16 on most; WebGPU also 8 vertex buffers). The message counts what stacked up: geometry attributes the " +
      "material reads, the instance matrix (4) and color (1), last frame's matrix for temporalAA's velocity buffer (4), engine patches, your own attribute nodes. " +
      'Drop what is not read, pack per-instance values into one vec4, or move them to a storage buffer (instancedArray from three/tsl); temporalAA off frees 4.' },
  'webgpu-needs-tsl': {
    docs: ['recipes/56-webgpu-tsl.md §"Turning it on"'],
    fix: "On WebGPURenderer the engine draws with node materials. Either threedog/tsl is not loaded (add import 'threedog/tsl' at the top of the entry), " +
      'or a part is written only as GLSL text: give it a tsl form too (a patch: tsl next to glsl; sky / fog hooks: { glsl, tsl }; a weather glsl spec: ' +
      'create(engine) returning your own node-material object). The message names the part.' },
  'swarm-full': {
    docs: ['recipes/65-swarm.md §"Time, saves, limits"'],
    fix: 'The swarm holds capacity objects and spawn returned -1, so that object does not exist. Raise capacity in engine.swarm({ capacity }), or remove objects sooner; describe().swarm.<name>.dropped counts the refused spawns.' },
  'swarm-handle': {
    docs: ['recipes/65-swarm.md §"The id rule"'],
    fix: 'free takes a handle, not a row: rows move when objects are removed. Inside onStep or near pass d.id[i]; to remove the object onStep is on, return false.' },
  'swarm-step': {
    docs: ['recipes/65-swarm.md'],
    fix: "swarm.onStep(fn) sets the one function that runs every fixed step: pass a function, once at setup, not from onFixed. Do several jobs in one function, or h.remove() the old one first." },
  'swarm-field': {
    docs: ['recipes/65-swarm.md'],
    fix: 'spawn() was given a name that is no column. Columns are x, y, z, the names in engine.swarm({ fields }), and with { color: true } r, g, b and the spawn key color.' },
  'swarm-name': {
    docs: ['recipes/65-swarm.md §"Time, saves, limits"'],
    fix: 'Swarm names are unique: they are the keys in describe() and in saves. Pick another name, or dispose() the old swarm first.' },
  'swarm-disposed': {
    docs: ['recipes/65-swarm.md'],
    fix: 'This swarm was disposed. Make a new one with engine.swarm(options), or keep it and call clear() to empty it.' },
  'module-disabled': {
    docs: ['recipes/14-custom-module.md §2'],
    fix: 'A picture or ui module (particles, sky, music, a panel...) threw and was switched off; the game keeps running without it. The error printed with it is the real cause.' },
};
