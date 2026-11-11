// Engine core: the Engine class, events, input, i18n, saves, assets, audio, the ground interface, module definitions.
import type { Object3D, Vector3, Vector2, Color, Texture, BufferGeometry, Handle, PositionLike, Vec3Like, ColorLike, Material } from './common';
import type {
  Terrain, TerrainDraw, Vegetation, VegetationDraw, Sky, Calendar, Weather, WeatherDraw, Water, WaterBody, WaterBodyOptions, VegetationRemoveEvent, Hlod, LightPool, Budget, BudgetLimits, BudgetReport,
} from './world';
import type { World } from './generated/modules/world/World';
import type { Net } from './generated/modules/net/Net';
import type { PostEffect } from './generated/render/PostFX';
import type { Grids } from './generated/modules/grid/index';
import type { Collision, RigidBodies, Collider3D, CameraRig, CameraKind, CameraShotEvent, Animator, AnimatorOptions, Vehicle, Rideable } from './physics';
import type { Nav, LinkCrossing } from './nav';
import type { Stream } from './generated/core/stream/Stream';
import type { Batching } from './generated/core/stream/Batching';
import type { Rays } from './generated/core/scene/Rays';
import type { Control } from './generated/core/ops/control';
import type { I18n } from './generated/core/base/I18n';
import type { Audio } from './generated/core/audio/Audio';
import type { Input } from './generated/core/input/Input';
import type { Saves } from './generated/core/saves/Saves';
import type { Session } from './generated/core/saves/session';
import type { Page } from './generated/core/engine/page';
import type { Events } from './generated/core/base/Events';
import type { Commits } from './generated/core/threads/Commits';
import type { Threads } from './generated/core/threads/Threads';
import type { Ops } from './generated/core/ops/Ops';
import type { Views } from './generated/core/scene/Views';
import type { DebugOverrides } from './generated/core/inspect/DebugOverrides';
import type { Jobs } from './generated/core/threads/Jobs';
import type { Random } from './generated/core/base/Random';
import type { PostFX } from './generated/render/PostFX';
import type { Occlusion } from './generated/render/occlusion';
import type {
  Timeline, Level, LevelLoadedEvent, LevelLoadingEvent, LevelFailedEvent, LevelPlayableEvent, LevelUnloadedEvent, Triggers, TriggerEvent, TemplateStageEvent,
  Particles, SwarmMaker, Settings, Music, MusicChangeEvent, CharactersApi, NPCManager, Character,
  Interactions, Dialogue, Inventory, ItemEvent, ItemUseEvent, PickupEvent, Pickups, PickupsOptions, Quests, Photo, PhotoShot, Ambience, DebugPanel,
  Clock, Vars, Content, Flow, Hud,
} from './gameplay';

// ======================================================================
// Events
// ======================================================================

declare global {
  /**
   * Your game's own events, declared in the game's folder without touching the engine: games/<game>/events.d.ts
   * @example
   * // games/my-game/events.d.ts
   * interface GameEvents { 'fighter:hit': [{ attacker: string; victim: string; damage: number }] }
   */
  interface GameEvents {}
  /**
   * Vite's import.meta.glob, the documented way a game lists its plugins folder (import.meta.glob('./plugins/*.js', { eager: true }))
   * and engine.plugins.add takes one. Declared here because a game's tsconfig has no vite/client types ("types": []), so the documented line
   * failed the type check of a fresh game; with vite/client too, the two declarations merge as overloads.
   */
  interface ImportMeta { glob(pattern: string | string[], options?: { eager?: boolean; import?: string; query?: string | Record<string, string> }): Record<string, any>; }
}
/**
 * Events the engine and modules emit, and the arguments callbacks receive (written as an array: what each argument is).
 * A game adds its own to the global GameEvents interface (games/<game>/events.d.ts); undeclared names still work, their arguments just aren't checked.
 */
export interface EventMap extends GameEvents {
  /** Loading finished; the world is playable */
  'engine:ready': [];
  /** Audio can play (after the player's first click / key press) */
  'audio:ready': [];
  /** UI language changed; the argument is the new language */
  'i18n:change': [locale: string];
  /** Key bindings changed; action null means everything was reset to defaults */
  'input:rebind': [{ action: string | null; keys: string[] | null }];
  'input:context': [{ stack: string[] }];
  /** Save written to disk; the argument is the slot name (not emitted when the write fails, a toast is shown instead) */
  'save:written': [slot: string];
  /**
   * Restore from a save file (saves.importFile) finished; the argument is the slot name. Attachments in the file (such as photos) are written to storage
   * too
   */
  'save:imported': [slot: string];
  /** A save was loaded onto the running playthrough (saves.load / session.load); the argument is the slot name */
  'save:loaded': [slot: string];
  /** A window was opened (the argument is the window id, e.g. 'inventory') */
  'ui:open': [id: string];
  /** A window was closed */
  'ui:close': [id: string];
  /** Shadows were toggled */
  'settings:shadows': [on: boolean];
  /** A value in the settings menu changed (the argument is all setting values) */
  'settings:change': [values: Record<string, any>];
  /** A post effect was added (its name) */
  'post:add': [name: string];
  /** A water body was added */
  'water:add': [body: WaterBody];
  /** A water body was removed */
  'water:remove': [body: WaterBody];
  /** A new day (the argument is the day number, starting at 1; needs the calendar module) */
  'day:start': [day: number];
  /** Season changed (the argument is the season name, e.g. 'autumn') */
  'season:change': [season: string];
  /** A mod with `for` ran out (engine.mod(target, { owner, for })): target is the quantity's name, id the record for per-record ones */
  'mod:end': [{ target: string; owner: string; id: string | null }];
  /** engine.skip jumped game time forward (seconds = calendar seconds skipped); timers and world catch-up already ran */
  'time:skip': [{ seconds: number }];
  /** Lightning strike (weather module) */
  'weather:lightning': [];
  /** engine.weather.set switched to another weather name (once, when the blend starts; setting the same name again does not fire) */
  'weather:change': [change: { from: string; to: string }];
  /** The fixed-shot camera switched shots */
  'camera:shot': [CameraShotEvent];
  /** engine.setCamera switched the camera kind; settings that belong to the camera (sensitivity, invert Y, field of view) are re-applied on it */
  'camera:change': [{ kind: string; previous: string }];
  /** A character jumped */
  'character:jump': [{ character: Character; air: boolean; index: number }];
  'character:launch': [{ character: Character; speed: number; owner: string }];
  /** A walker reached a nav link. Set crossing.seconds here to say how long it takes @experimental */
  'link:enter': [{ id: string; character: Character; crossing: LinkCrossing }];
  /** A crossing ended: landed, or cut short (npc.placeAt, walk.remove()). character is null for an NPC that went out of range mid-crossing @experimental */
  'link:exit': [{ id: string; character: Character | null; crossing: LinkCrossing }];
  'character:fall': [{ character: Character; safe: Vector3 | null }];
  /** A character's model named by asset finished loading and replaced the placeholder body (same root; anim is now set) */
  'character:model': [{ character: Character; model: Object3D }];
  /** A foot of a walking character came down; character.groundType() is what it stepped on */
  'character:step': [{ character: Character }];
  /** A character landed; impact is the landing speed (m/s), the larger the harder the fall */
  'character:land': [{ character: Character; impact: number }];
  /**
   * A character went into or out of deep water (water option): in true on entering, mode what the water option did there ('swim' | 'block' | 'wade',
   * or what the function returned)
   */
  'character:water': [{ character: Character; in: boolean; mode: string; depth: number }];
  /** Dialogue started; the argument is the dialogue script name */
  'dialogue:start': [speaker: string];
  /**
   * A dialogue line started (after its do ran): data is the node's own fields (portrait, voice...), {} when none. Use it for voice, portraits, camera
   * shots without replacing the UI part
   */
  'dialogue:line': [{ script: string; node: string; speaker: string; text: string; data: Record<string, any> }];
  /** A bubble line started showing (the bubble channel: lines over their speakers while play goes on); at is what it is attached to, null = a screen line */
  'dialogue:bubble': [{ speaker: string; text: string; at: any }];
  /** Dialogue ended; the argument is the dialogue script name */
  'dialogue:end': [speaker: string];
  /** An item was added to a container (any bag or chest: container names it, actor says who did it) */
  'item:add': [ItemEvent];
  /** An item was removed from a container (container names it, actor says who did it) */
  'item:remove': [ItemEvent];
  /** A pickup was taken off the ground (pickup = world id, item = its item id or null for a give function, actor = who took it) */
  'pickup:take': [PickupEvent];
  /** A hold interaction started (the key went down on it); seconds is its hold */
  'interaction:hold': [{ id: string; action: string; seconds: number }];
  /** A hold interaction stopped before it completed: 'released' | 'tooFar' | 'disabled' | 'removed' | 'inputLocked' */
  'interaction:interrupt': [{ id: string; action: string; reason: string; progress: number }];
  /** An item was used through the inventory.use op (after use ran) */
  'item:use': [ItemUseEvent];
  /** A quest started */
  'quest:start': [{ id: string }];
  /** A quest moved to the next step; step is the new step index (starting at 0) */
  'quest:step': [{ id: string; step: number }];
  /** A quest completed */
  'quest:done': [{ id: string }];
  /** A part of a parallel quest step was met; step and part are indexes (starting at 0) */
  'quest:part': [{ id: string; step: number; part: number }];
  /** A quest failed (its fail condition held); quests.start(id) may begin it again */
  'quest:fail': [{ id: string }];
  /** A finished quest's reward was not given. failed: each word that failed; owed: the items the quest still owes, null when none or when onUnpaid took it */
  'quest:unpaid': [{ id: string; code: string; failed: { word: string; code: string; facts: any }[]; owed: Record<string, number> | null }];
  /** A content effect word failed ({ give } in a full bag, { op } refused), wherever it ran: a dialogue do, a trigger, a reward, content.run. actor: whose effect it was */
  'content:failed': [{ code: string; failed: { word: string; code: string; facts: any }[]; actor: string | null }];
  /** A photo was taken */
  'photo:taken': [PhotoShot];
  /** The photo key was pressed but the op photo.take was refused (reason from photo.canTake(), 'denied' when it returned false) */
  'photo:denied': [{ reason: string }];
  /** Entered a trigger zone */
  'trigger:enter': [TriggerEvent];
  /** Left a trigger zone */
  'trigger:exit': [TriggerEvent];
  /** Level finished loading */
  'level:loading': [LevelLoadingEvent];
  'level:loaded': [LevelLoadedEvent];
  'level:unloaded': [LevelUnloadedEvent];
  'level:playable': [LevelPlayableEvent];
  'level:failed': [LevelFailedEvent];
  /** A cutscene started */
  'timeline:start': [{ id: number }];
  /** A cutscene ended; ending says how, error why it failed */
  'timeline:end': [{ id: number; ending: 'finished' | 'skipped' | 'dropped' | 'failed'; error?: string }];
  /** A content template instance entered a new stage by growing (templates with stages) */
  'template:stage': [TemplateStageEvent];
  /** The ground's shape or type changed in this world-space box (engine.terrain.edit): cached ground samples (path rasters) inside it are stale */
  'ground:change': [{ x0: number; z0: number; x1: number; z1: number }];
  /**
   * rigid: newGame / a load rebuilt the physics world (a fresh page for physics) and the engine's bodies are back (entry.body is the rebuilt Rapier
   * body; bodies maps the ids given to addBox / addBall / addHull / addWheeled). The old world's joints were freed with it: re-create the game's
   * joints here (recipes/11-vehicles.md, Joints). Not emitted while a vehicle exists (the world is kept then, joints included)
   */
  'rigid:rebuilt': [{ world: any; player: any; bodies: Record<string, any> }];
  /** terrain({ shape }): the player or a moving rigid body dropped below engine.terrain.voidY (once per fall). The engine does not respawn: the game decides */
  'terrain:void': [{ who: any; position: { x: number; y: number; z: number } }];
  /** A terrain chunk job failed every try (usually the game's height / groundType / placement rule throws there): the chunk stays empty and the error is reported. engine.terrain.retry() sends failed chunks again */
  'terrain:chunkFailed': [{ cx: number; cz: number; error: any }];
  /** A vegetation instance was chopped / removed */
  'vegetation:remove': [VegetationRemoveEvent];
  /** A vegetation instance was restored */
  'vegetation:restore': [VegetationRemoveEvent];
  /** Background music changed track (null means silence) */
  'music:change': [MusicChangeEvent];
  /** A stinger was played */
  'music:stinger': [{ name: string; played: boolean }];
  /** Scenario parameters were applied (URL parameters or engine.applyState) */
  'state:applied': [StateParams];
  /** A scenario (at, pos) moved the player: a camera or view that eases jumps there */
  'state:placed': [{ x: number; z: number }];
  /** A one-shot action of the animation state machine finished */
  'anim:end': [{ root: Object3D; state: string }];
  /** A record was added to world */
  'world:add': [{ id: string; kind: string }];
  /** world.set changed fields (keys lists which) */
  'world:change': [{ id: string; kind: string; keys: string[] }];
  /** A record was removed from world */
  'world:remove': [{ id: string; kind: string }];
  /** world finished loading a save (the data is now the save's; caches holding a rec object should refresh on this, count is the record count after loading) */
  'world:load': [{ count: number }];
  /** Host (net): a peer connected; actor is its world record / container id */
  'net:join': [{ peer: number; actor: string }];
  /** Host (net): a peer disconnected (its bag stays; a reconnect with its key gets the same actor) */
  'net:leave': [{ peer: number; actor: string }];
  /** Client (net): connected to the host (the first snapshot follows) */
  'net:open': [{}];
  /** Client (net): connection lost */
  'net:close': [{}];
  /** Client (net): host state applied (full: a whole snapshot, else a diff); redraw UI from state here */
  'net:sync': [{ tick: number; full: boolean }];
  /** Client (net): the host's answer to an op request (seq from ops.run's return value; tick is the host's), sent after the state it caused */
  'net:result': [{ seq: number; name: string; ok: boolean; code: string | null; value?: any; tick: number }];
  /** A gameplay error: in development / testing gameplay is frozen; a release build keeps running and sends it once per site (engine.error holds the first; error severity levels, see engine.error) */
  'engine:error': [EngineError];
  /** A picture or ui module errored and was disabled (the game continues) */
  'module:disabled': [{ name: string; message: string }];
  'module:restored': [{ modules: any[] }];
  /** An atomic op failed and its parts were put back (its own events already went out and stay): read derived state again. Not sent for a load's rollback (that ends in state:replaced) */
  'op:rolledBack': [{ op: string; parts: number }];
  /** @internal The state was replaced by something other than a step, from any door (core/saves/stateReplace.js); undone: a failed load put the old state back */
  'state:replaced': [{ undone: boolean }];
  /** A character boarded a vehicle */
  'vehicle:enter': [{ character: Character; vehicle: Rideable }];
  /** A character exited a vehicle */
  'vehicle:exit': [{ character: Character; vehicle: Rideable }];
  /** Game flow state changed */
  'flow:change': [{ from: string; to: string }];
  /** Scene transition: phase 'start' begins fading to black, 'end' finishes fading back in */
  'flow:transition': [{ phase: 'start' | 'end' }];
  /** A playthrough ends (engine.session.newGame / load / quit), before the reset */
  'session:end': [];
  /** A playthrough started from a clean slate: kind 'new' (newGame) or 'load' (session.load, with the slot) */
  'session:start': [{ kind: 'new' | 'load'; slot?: string }];
  /** newGame / session.load failed (a save part's load() threw) and the game was rolled back: the old playthrough goes on, no session:start */
  'session:failed': [{ kind: 'new' | 'load' | 'quit'; slot?: string }];
  /** The page went away: the window lost focus or the tab was hidden (engine.page) */
  'page:blur': [{ focused: boolean; visible: boolean }];
  /** The page came back: focused and visible again */
  'page:focus': [{ focused: boolean; visible: boolean }];
  /** The mouse lock on the canvas started or ended (Esc, alt-tab); cameras with pointerLock lock again on the next click */
  'page:pointerlock': [{ locked: boolean }];
  /** The WebGL context was lost: gameplay waits and the player sees a message */
  'page:contextlost': [];
  /** The WebGL context is back: gameplay resumes */
  'page:contextrestored': [];
}
/** The renderer behind engine.renderer: a WebGLRenderer by default, three's WebGPURenderer on the WebGPU route (createEngine({ renderer: 'webgpu' })).
 * Narrow before using one side's API: `if ('isWebGPURenderer' in r)`, or engine.describe().renderer.backend */
export type EngineRenderer = import('three').WebGLRenderer | import('three/webgpu').WebGPURenderer;

/** Arguments a callback of the given event receives: known events follow EventMap, other names are not checked */
export type EventArgs<K extends string> = K extends keyof EventMap ? EventMap[K] : any[];
/** Event name: known events get autocompletion, any string is also allowed */
export type EventName = keyof EventMap | (string & {});


// ======================================================================
// Input
// ======================================================================

/** Per-engine shader uniforms (engine.uniforms): { value } objects shared by every material of that engine */
export interface EngineUniforms {
  /** Ambient seconds (= engine.time.now('ambient')): keeps moving while gameplay is frozen; written only by the time source */
  uTime: { value: number };
  /** Wind strength multiplier (weather) */
  uWind: { value: number };
  /** Sway frequency multiplier */
  uWindFreq: { value: number };
  /** Sway amplitude multiplier: every wind patch's amplitude is scaled by it */
  uWindAmp: { value: number };
  /** Cloud cover 0-1 (weather) @experimental */
  uWeatherCloud: { value: number };
  /** Rain amount 0-1 (weather state, every frame): a signal for the game's own wet surfaces */
  uRain: { value: number };
  /** Snow amount 0-1 (weather state, every frame) @experimental */
  uSnow: { value: number };
  /** Weather's light multiplier (weather state, every frame; 1 = clear): your picture/ code multiplies its own lights by it */
  uWeatherLight: { value: number };
  /** Weather's fog multiplier (weather state, every frame; 1 = clear): your picture/ code multiplies its fog distance by it */
  uWeatherFog: { value: number };
  /** How far the world is meant to be seen, meters (default 600; terrain({ viewFog: true }) writes it): a fog's far, the stream radius without terrain */
  uViewDistance: { value: number };
  /** Darkest cloud shadow 0-1 (0 = none) */
  uCloudShadow: { value: number };
  /** Cloud size: smaller = bigger clouds @experimental */
  uCloudShadowScale: { value: number };
  /** Cloud drift per second @experimental */
  uCloudShadowSpeed: { value: Vector2 };
  /** Unit vector toward the sun (sky, every frame); share the object in your own sky: mySky.material.uniforms.sunPosition = engine.uniforms.uSunDir */
  uSunDir: { value: Vector3 };
  /** Sun color now, from the sky's keyframes (white with no sky): what a game's own sun takes. Linear, like every THREE.Color */
  uSunColor: { value: Color };
  /** 0 at night .. 1 at noon (sky, the sun it draws) */
  uDaylight: { value: number };
  /** 0 by day, 1 at night: the curve lightPool sources with `dusk` fade on. For emissive windows and signs: mat.emissiveIntensity = 2 * engine.uniforms.uNight.value */
  uNight: { value: number };
  /** Time of day 0-1 the sky draws (calendar time, or the sky's fixed time) */
  uTimeOfDay: { value: number };
  /** Zenith color the sky draws this frame (keyframes, engine.sky.top, weather tint, lightning); linear, like every THREE.Color */
  uSkyTop: { value: Color };
  /** Horizon color the sky draws this frame (or the backdrop color). Read it for a shader that should meet the sky */
  uSkyHorizon: { value: Color };
  /** Sun disk sharpness (larger = smaller), shared with the dome: write .value; sky({ sunSize }) sets the start. The same for every value below @experimental */
  uSunSize: { value: number };
  /** @experimental */ uSunGlow: { value: number };
  /** Sun disk brightness (sky({ sunBrightness })) */
  uSunBrightness: { value: number };
  /** Moon disk sharpness (larger = smaller) @experimental */
  uMoonSize: { value: number };
  /** Moon disk brightness (sky({ moonBrightness })) @experimental */
  uMoonBrightness: { value: number };
  /** @experimental */ uMoonColor: { value: Color };
  /** Share of sky grid cells holding a star at night, 0-1 (sky({ starDensity })) @experimental */
  uStars: { value: number };
  /** Star grid resolution: larger = smaller, more numerous stars @experimental */
  uStarScale: { value: number };
  /** Horizon-to-zenith gradient exponent (engine.uniforms.uSkyCurve) @experimental */
  uSkyCurve: { value: number };
  /** Dome cloud amount 0..1+ (sky({ clouds: { coverage } })), multiplied by the weather's uWeatherCloud */
  uCloudCover: { value: number };
  /** Dome cloud size, smaller = bigger clouds (sky({ clouds: { scale } })); uCloudShadowScale is the cloud shadows' */
  uSkyCloudScale: { value: number };
  /** Dome cloud drift [x, z] per second; uCloudShadowSpeed is the cloud shadows' */
  uSkyCloudSpeed: { value: Vector2 };
  /** @experimental */ uCloudOpacity: { value: number };
  /** Dome cloud edge softness @experimental */
  uCloudSoft: { value: number };
  /** Lit side of the dome's clouds */
  uCloudColor: { value: Color };
  /** Shaded side of the dome's clouds */
  uCloudShade: { value: Color };
  /** Season tint of foliage (sky, by the calendar's season) @experimental */
  uFoliageTint: { value: Color };
  /** Season tint of the ground (sky, by the calendar's season) @experimental */
  uGroundTint: { value: Color };
  /** @experimental */ uFoliageMix: { value: number };
  /** @experimental */ uGroundMix: { value: number };
  /** Snow / ash cover amount alone, x foliage, y ground, 0-1 (the 'ground.cover' point); the tints above already hold it blended in @experimental */
  uGroundCover: { value: Vector2 };
}

/** Mouse / touch pointer. ndcX/ndcY are screen coordinates in -1..1 */
export interface Pointer {
  /** Pixels from the canvas's top-left corner (not the window's): the same space as worldToScreen and the UI root */
  x: number; y: number;
  /** -1..1 across the canvas box (engine.pick / screenToGround take these) */
  ndcX: number; ndcY: number;
  /** Held down */
  down: boolean;
  /**
   * Clicked once this frame (not a drag). Only for in-frame uses such as UI and clicking the ground; bind fire / attack to the action 'Mouse0' and read
   * pressed in onFixed
   */
  clicked: boolean;
  /** Mouse button pressed: 0 left, 1 middle, 2 right */
  button: number;
}
/** Autopilot: movement direction replacing player input (x right-positive, y forward-positive) and speed (m/s) */
export interface Autopilot { x: number; y: number; speed?: number }


// ======================================================================
// i18n
// ======================================================================

/** String table: { 'zh-CN': { key: text }, en: {...} }. {name} in the text is replaced by arguments, {key:action} shows the key name */
export type StringTables = Record<string, Record<string, string>>;


// ======================================================================
// Saves
// ======================================================================

/** Which state replacement a call belongs to: handed to a part's load() and a module's afterLoad, opaque, valid until that replacement ends */
export type SaveTurn = Readonly<object>;

/** Save provider: save() returns JSON-able data, load(data) reads it back (may return a Promise, e.g. for changing level;
 *  later parts wait for it to finish before loading).
 *  first: true providers load first (parts such as the level, where the rest only makes sense after it is loaded); first may be a number, lower loads earlier, true counts as 0 */
export interface SaveProvider {
  /** This part's data now: plain data (structuredClone can copy it; no functions, DOM nodes or three objects). It may be the live object the
   *  part keeps: the engine copies it for its rollback point before a load, so a load() that writes into that same object can still be undone.
   *  Data that cannot be copied makes a load refuse before anything changes (save-part-threw) */
  save: () => any;
  /** Read data back; may return a Promise (later parts wait). Listener errors of events it emits count as the load throwing, also after an await.
   *  turn: this replacement's identity. Pass it on as level.load(x, { turn }) / content.load(x, { turn }): awaited without it, those wait for this load, so for ever (dev warns after 3 s, save-nested) */
  load: (data: any, turn: SaveTurn) => void | Promise<void>;
  /** Load before the other parts (such as the level) */
  first?: boolean | number;
  /** Join atomic ops: copied before an atomic op runs, put back if it fails (plain data; afterLoad does not run on rollback; load() must be synchronous: an async function is refused at define, a returned Promise at rollback as engine-misuse) */
  atomic?: boolean;
  /** Why an atomic op leaves this part alone. Every engine part gives atomic: true or this (rule R67); a game's part may */
  notAtomic?: string;
  /** Dev only: called once start() finished with this part's data in the new-game state, to warn about what should not be there yet (world: records placed by code) */
  checkNewGame?: (data: any) => void;
  /** This part's format version, default 1: raise it by 1 when what save() returns changes shape. A save with a newer version is refused */
  version?: number;
  /** Upgrade steps: old version -> data => data in the next version's shape, e.g. { 1: d => ({ ...d, beds: [] }) }.
   *  The second argument is the whole save as read ({ parts, versions }, read only), for a step that depends on another part */
  migrate?: Record<number, (data: any, save: { parts: Record<string, any>, versions: Record<string, number> }) => any>;
}


// ======================================================================
// Assets
// ======================================================================

/** Function that generates a model in code: returns a three object or geometry (may be async) */
export type ModelBuilder = (params?: any) => Object3D | BufferGeometry | Promise<Object3D | BufferGeometry>;
/**
 * One asset manifest entry: a path; or { url, preload?, ... }; models can also be a generator function, or { build, params?, preload? } (generated on
 * demand, cached automatically, reads the baked file if there is one)
 */
export type AssetEntry = string | ModelBuilder | {
  /** File path (a file under public/ is written as '/models/x.glb') */
  url?: string;
  /** Model: generator function (instead of url) */
  build?: ModelBuilder;
  /**
   * Model: a params schema (core/base/params.js format plus 'color'), e.g. { height: { type: 'number', min: 1, max: 8, default: 3 } }: build gets one
   * object (defaults < dev panel values < a call's own ['name', { ... }]) and the dev panel shows the fields
   */
  params?: Record<string, string | { type: string; default?: any; min?: number; max?: number; values?: any[]; desc?: string; optional?: boolean }>;
  /**
   * Model generator: false = never stored in the dev cache (.threedog/cache); for materials the GLB round trip cannot keep
   * (own onBeforeCompile, ShaderMaterial uniforms that code keeps a reference to)
   */
  cache?: boolean;
  /**
   * Model: every mesh casts (receives) shadows, or none does. Left out: a generator that set the flag on any mesh keeps its own,
   * otherwise (files, generators that set nothing) all meshes cast and receive
   */
  castShadow?: boolean;
  /** Model: see castShadow */
  receiveShadow?: boolean;
  /**
   * Model: one node of the file at url as its own model ('Wall.001', or three's spelling Wall001; a second node of the same name is Fence_1).
   * Placed at the origin, keeping its turn and size; the file loads once for every part. A name the file lacks fails naming the close ones
   */
  node?: string;
  /** Model: nodes and animation clips the game relies on; `threedog assets check` errors and the load warns (asset-needs) when the file lost one. Optional */
  needs?: { nodes?: string[]; clips?: string[] };
  /** Bake manifest (bake.js) only: 'file' = the baked file is the source of truth (edited in Blender), npm run bake no longer overwrites it */
  source?: 'file';
  /** Preload at startup */
  preload?: boolean;
  /** start() stops with the reason if this fails (default false: a failed file falls back and the game continues) */
  critical?: boolean;
  /** Name of another entry of the same type to use if this one fails (default: a gray placeholder model / gray texture / silence) */
  fallback?: string;
  /** Texture: whether it is a color texture (write false for normal and roughness maps) */
  color?: boolean;
  /** Texture: pixel-art style (no smoothing) */
  pixelated?: boolean;
  /** Texture: repeat count [horizontal, vertical] */
  repeat?: number[];
  /**
   * Model: game action names -> this file's clip names, as data (assets.animate and characters start from it), e.g.
   * { states: { idle: { clip: 'Idle_Sword' }, attack: { clip: 'Sword_Slash', loop: false, timing: 0.6 } } }
   */
  animation?: AnimatorOptions;
};
/**
 * An asset manifest, also the shape of an asset pack (a folder or npm package exporting one): names -> files or generators; content and code use the
 * names only
 */
export interface AssetManifest {
  /** Label shown as the source manifest in engine.loading (default 'manifest#1', '#2'...) */
  name?: string;
  /**
   * Folder that this manifest's relative paths resolve against: '/packs/forest/', a CDN URL, or new URL('./files/', import.meta.url) in an npm pack.
   * '/x' and full URLs stay as written
   */
  base?: string | URL;
  /** Models (.glb / .gltf, Draco/Meshopt compression also works): name -> path or generator function */
  models?: Record<string, AssetEntry>;
  /**
   * Textures: name -> path, or a texture made in code: a function returning a THREE.Texture (run once, on first use) or the Texture itself.
   * Code textures come back as made (their colorSpace / wrap / repeat are yours) and are never disposed by the engine if passed as a Texture.
   * Example: textures: { brick: () => makeBrickTexture(), sign: mySignTexture }
   */
  textures?: Record<string, AssetEntry | Texture | (() => Texture | Promise<Texture>)>;
  /**
   * Sounds: name -> file path, or a sound made in code: a synth function (SynthFn) or { build: synthFn, params } (params: its defaults). Used by name
   * like a file: audio.sfx(name), audio.sounds rules (src / variants), music and ambience. Example: sounds: { step: '/sfx/step.ogg', ding: dingSynth }
   */
  sounds?: Record<string, AssetEntry | SynthFn | { build: SynthFn; params?: Record<string, any> }>;
  /** Fonts: name -> file, or { url, family, weight, style, ... } (family defaults to the name). ui.fonts lists the names the UI uses */
  fonts?: Record<string, string | FontAssetEntry>;
}
/** One font of an asset pack: the file plus the FontFace descriptors (family defaults to the asset name) */
export interface FontAssetEntry {
  url: string;
  /** CSS font-family it registers (default: the asset name); several entries may share one family with different weight / style */
  family?: string;
  weight?: number | string; style?: string; stretch?: string; unicodeRange?: string; display?: string; featureSettings?: string; variationSettings?: string;
  /** start() stops if it fails (otherwise text falls back to the next family of ui.theme.font) */
  critical?: boolean;
  /** Load at start() even if ui.fonts does not name it */
  preload?: boolean;
}

export interface Assets {
  /**
   * Register an asset manifest or asset pack (can be called several times; a later entry with the same name replaces the earlier one). Its name labels
   * it in engine.loading, base resolves its relative paths
   */
  manifest(m: AssetManifest | AssetManifest[]): this;
  /** The generator function registered under a model name, null for a file model or an unknown name (content builds [name, ...params] models with it) @experimental */
  builder(name: string): ((...args: any[]) => any) | null;
  /** The params of a generator registered with a params schema: { schema, values (built with now), tuned (from setParams) }, or null @experimental */
  paramsOf(name: string): { schema: Record<string, any>; values: Record<string, any>; tuned: Record<string, any> } | null;
  /** Dev tuning: build a generator with these params (replacing its defaults) and swap every live copy in place; the dev panel's models folder calls it */
  setParams(name: string, values: Record<string, any>): Promise<{ why: string; names: string[]; copies: Record<string, number>; ms: number; partsChanged?: string[] }>;
  /**
   * Preload (onProgress(0–1, current name)). Code-generated models and fonts are only loaded up front if marked preload. failed includes entries now
   * showing their fallback
   * @experimental
   */
  preload(onProgress?: (p: number, name: string) => void, opts?: { onlyMarked?: boolean }): Promise<{ loaded: number; failed: string[]; ok: boolean }>;
  /**
   * A font from an asset pack by name: downloaded once, added to document.fonts; null when the file failed and it is not critical. ui.fonts calls
   * it at start()
   */
  font(name: string): Promise<FontFace | null>;
  /**
   * Get a model copy (name or path; geometry and materials are shared with other copies). static: true registers it in engine.rays (builds ray
   * acceleration)
   */
  model(nameOrUrl: string, opts?: { castShadow?: boolean; receiveShadow?: boolean; static?: boolean }): Promise<Object3D>;
  /**
   * A model copy as a plain THREE.LOD: the full model near, the levels of `threedog assets optimize --lod` far away. Default distances follow the model's size;
   * distances (rising meters) replace them, hysteresis is the share of a distance that stops flicker at the line (default 0.1). Rays, collision and saves keep
   * using the full model. A LOD object is never batched. Without levels it warns in dev and draws in full.
   * @example const tower = await engine.assets.lod('tower', { distances: [40, 120] }); engine.add(tower); tower.levels[1].object;
   * @experimental
   */
  lod(nameOrUrl: string, opts?: { distances?: number[]; hysteresis?: number; castShadow?: boolean; receiveShadow?: boolean; static?: boolean }): Promise<import('three').LOD>;
  /**
   * A model copy right now if it has already loaded, else null (never starts a load, never waits): lets code that rebuilds often skip the frame an await costs.
   * Code-built models (a build function in the manifest) count too: they are null until one await model(name) or an entry with preload: true ran (dev warns [asset-not-loaded])
   * @example const m = engine.assets.modelNow('villager') ?? await engine.assets.model('villager');
   * @experimental
   */
  modelNow(nameOrUrl: string, opts?: { castShadow?: boolean; receiveShadow?: boolean; static?: boolean }): Object3D | null;
  /**
   * The game's setup for every model the engine hands out (assets.model / modelNow / lod, content props and templates, pickups, character bodies, a code-built vegetation model named in define, a level
   * file): runs once per copy, before it is added or drawn. Synchronous; one per engine (a second throws); leaves the root's transform to its placer (dev throws). Copies share materials: map each original to one of yours
   * @example const mine = new Map(); engine.assets.onModel(m => m.traverse(o => { if (o.isMesh) o.material = mine.get(o.material) ?? mine.set(o.material, myLook(o.material)).get(o.material); }));
   */
  onModel(fn: (model: Object3D, name: string) => void): { remove(): void };
  /** Get the geometry of the first mesh in a model */
  geometry(nameOrUrl: string): Promise<BufferGeometry>;
  /** An image as grid data for sampleGrid: PNG at 8 or 16 bits (jpg / webp 8). channel 'r' (default) 'g' 'b' 'a' or 0-3; range maps pixels to [min, max] (default [0, 1]) */
  gridFromImage(nameOrUrl: string, opts?: { channel?: 'r' | 'g' | 'b' | 'a' | number; range?: [number, number]; bits?: 8 | 16 }): Promise<{ data: Float32Array; width: number; height: number; bits: number }>;
  /** Get a texture (.ktx2 compressed textures also work) */
  texture(nameOrUrl: string, opts?: { color?: boolean; pixelated?: boolean; repeat?: number[] }): Promise<Texture>;
  /** Fetch a texture for something that already shows a stand-in: use(texture) runs when it arrives; a failed load is one asset-load dev warning naming `where` and what shows `instead`, and resolves false (an error inside use() is not swallowed). opts are texture()'s options */
  useTexture(nameOrUrl: string, use: (texture: Texture) => void, o?: { where?: string; instead?: string; opts?: { color?: boolean; pixelated?: boolean; repeat?: number[] } }): Promise<boolean>;
  /**
   * Release a resource and return its memory. Not released while copies of the model are still in the scene; it is released when the last copy is
   * removed with engine.remove. A sound (name or path) plays on where it is playing and loads again on next use. A load still running ends and its result is thrown away; code awaiting it gets a fresh load, never freed data. A name that
   * fell back holds no data of its own: release the name it fell back to
   */
  release(name: string): void;
  /**
   * Release every model that has no copy in use and every long decoded sound (music, long loops; short effects stay; a sound still playing plays on), unless
   * marked preload (called automatically after level changes). Models whose shared geometry was taken by geometry() and code-generated models are not released
   * automatically. Returns the released names
   */
  trim(): string[];
  /**
   * Called by engine.remove when an object is fully removed: decrements the use count of the model copies under it
   * @internal
   */
  forget(obj: Object3D): void;
  /** Generations faster than this many milliseconds are not written to the automatic cache (reading the file would be slower), default 20 */
  cacheMinMs: number;
  /**
   * Named colors for what is made in code: a generator written with `function` reads this.palette. Plain data, read, write or replace it freely: it is part
   * of the cache key, so a model or texture asked for after a write is built from the new colors. Copies already placed keep theirs.
   * @example engine.assets.palette = { leaf: 0xd98a3a, bark: 0x6b4a30 };
   */
  palette: Record<string, any>;
  /** Geometry and materials shared by model copies (engine.remove does not release them, use release) */
  shared: WeakSet<object>;
  /** Current GPU memory usage (number of geometries and textures) */
  readonly memory: { geometries: number; textures: number };
  /**
   * Create an animation state machine for a skinned model (without config it is simple play-by-name).
   * A copy of a manifest model whose entry has `animation` starts from that mapping; config wins per state
   */
  animate(root: Object3D, config?: AnimatorOptions): Animator;
  /** The manifest entry's animation mapping for a model copy, or null (not a manifest copy, or no mapping) */
  mapping(root: Object3D): AnimatorOptions | null;
  /** three.js GLTFLoader (Meshopt installed; Draco and KTX2 are installed the first time they are needed) @experimental */
  gltf: any;
  /**
   * three.js DRACOLoader (created only the first time Draco compression is met, null before; the decoder defaults to the one bundled with three, vite
   * packs it automatically)
   * @experimental
   */
  draco: any;
  /** three.js KTX2Loader (created only the first time a KTX2 texture is met, null before) @experimental */
  ktx2: any;
  /** Import report of a loaded model (by name, or a copy from model()): materials, textures with colorSpace, clips, colliders, templates, and issues for what the file has but the scene lost */
  report(nameOrRoot: string | Object3D): AssetReport;
}
/** engine.assets.report(): see recipes/46-blender-art-route.md */
export interface AssetReport {
  name: string | null; url: string | null; fromFile: boolean;
  counts: Record<string, number>;
  materials: { name: string; type: string; maps: Record<string, any>; flatShading: boolean; vertexColors: boolean; madeByEngine: boolean }[];
  textures: any[]; clips: { name: string; seconds: number }[]; colliders: any[]; templates: any[];
  issues: { severity: 'warn' | 'info'; code: string; msg: string }[];
}

/** Phase of a loading task */
export type LoadingPhase = 'queued' | 'download' | 'decode' | 'upload' | 'build' | 'done' | 'failed';
/** One loading task (engine.loading.get / list) */
export interface LoadingTask {
  name: string;
  kind: 'model' | 'texture' | 'sound' | 'module' | 'stream' | 'step';
  phase: LoadingPhase;
  /** 0-1 within the phase (download reports bytes) */
  progress: number;
  /** A failure stops start() */
  critical: boolean;
  /** url: the file that failed (may be a .bin / texture the model references); status: HTTP status when known */
  error?: { message: string; url: string | null; status?: number };
  /** Files the model references but could not load (it loaded without them) */
  missing?: string[];
  /** What is used instead: 'gray placeholder', 'silence' or the fallback entry's name */
  fallback?: string;
  /** Where it came from: manifest name, path, file version (ETag / Last-Modified), size, animation clip names */
  source: { manifest: string | null; url: string | null; version: string | null; bytes: number | null; animations: string[] | null };
}
/**
 * describe().loading: done = nothing pending; ok = nothing failed (all finished is not all succeeded); blocked = a critical item failed before start()
 * finished
 */
export interface LoadingView {
  done: boolean; ok: boolean; blocked: boolean;
  /** One English line naming the current item, e.g. 'decoding model "hero" (/models/hero.glb, manifest "main")'; null when done */
  waiting: string | null;
  pending: { name: string; kind: string; phase: LoadingPhase; progress: number; critical: boolean }[];
  failed: LoadingTask[];
  warnings: { name: string; missing: string[]; source: LoadingTask['source'] }[];
  counts: { total: number; done: number; failed: number; pending: number };
}
export interface Loading {
  /** Summary (what describe().loading shows) */
  view(): LoadingView;
  /** Player-facing text for the loading screen, null when nothing is pending */
  text(): string | null;
  /** One task with its source, or null */
  get(name: string, kind?: string): LoadingTask | null;
  /** Every task so far */
  list(filter?: { kind?: string; phase?: LoadingPhase }): LoadingTask[];
  /** Run the game's own loading step as a task (critical by default: a failure before start() finishes stops start()) */
  track<T>(name: string, fn: () => Promise<T>, opts?: { critical?: boolean }): Promise<T>;
  /**
   * Resolves when every module installed after start() has finished its init() (also when one failed: engine.explain({ module: name }) says so).
   * @example engine.use(shop()); await engine.loading.settled(); engine.explain({ module: 'shop' }).ok   // true
   */
  settled(): Promise<void>;
  /** How long start() waits for modules whose isReady(e) stays false before it rejects naming them, in ms (default 120000) */
  timeoutMs: number;
}

// ======================================================================
// Audio
// ======================================================================

/** Built-in bus names; a game adds its own with createEngine({ audio: { levels: { voice: 1 } } }) or audio.addBus */
export type AudioBus = 'master' | 'music' | 'sfx' | 'ambience' | 'ui' | (string & {});
/** A playing sound (returned by audio.sfx / audio.play): stop(fade), fade(to, seconds), setPosition(at) */
import type { SoundHandle } from './generated/core/audio/audioVoice';
export type { SoundHandle };
/**
 * One sounds rule in full form: how a sound plays, never what it is made of (that is the asset manifest's: a file or a synth function).
 * src: an asset pack sound name or a path, or variants (random, no immediate repeat); default: the asset of the rule's own name
 */
export interface SoundDef {
  src?: string | string[];
  /** Passed to a synth source (merged over the manifest entry's params) */
  params?: Record<string, any>;
  /** Bus it plays on (default 'sfx', or the built-in synth's own bus) */
  bus?: AudioBus;
  volume?: number;
  /** Playback rate multiplier (1 = as recorded); synths get it as params.pitch */
  pitch?: number;
  /** Random spread per play, as a fraction: { pitch: 0.08 } = +-8% */
  jitter?: { volume?: number; pitch?: number };
  /** Seconds before the same sound can start again (calls inside it return null) */
  cooldown?: number;
  /** Most voices of this sound at once; the oldest stops for a new one (default unlimited) */
  voices?: number;
  loop?: boolean;
  /** 3D falloff for sfx(name, { at }): ref meters at full volume (2), max meters (60), rolloff (1) */
  distance?: { ref?: number; max?: number; rolloff?: number };
}
/** A sounds rule: a sound name / path, variants, or the full form */
export type SoundSource = string | string[] | SoundDef;
/** A measure comparison in a rule's `when`: every given key must hold ({ daylight: { gt: 0.15 } }, { rain: { lt: 0.2 } }) */
export interface AudioCompare { gt?: number; gte?: number; lt?: number; lte?: number }
/**
 * A rule's condition: an object whose keys all hold, or a function. Keys are condition keys (state, time, weather, zone, engine.audio.condition)
 * or measures compared with AudioCompare (daylight, rain, snow, wind, nearWater, altitude, engine.audio.measure). Content packs: object only
 */
export type AudioCondition = Record<string, any | AudioCompare> | ((e: Engine, ...extra: any[]) => boolean);
/** Volume as data: base plus measure * factor for each add entry, clamped to [min, max] ({ base: 0.05, add: { wind: 0.08 }, max: 0.5 }) */
export interface AudioVolumeData { base?: number; add?: Record<string, number>; min?: number; max?: number }
/** A rule volume: a number 0-1, data (AudioVolumeData, the only form in content packs), or a function of the moment */
export type AudioVolume = number | AudioVolumeData | ((e: Engine, ...extra: any[]) => number);
/** One ambience rule: while `when` holds, `sound` plays at `volume`. With `every` it is a one-shot repeated at random gaps, else a loop */
export interface AmbienceRule {
  /** A name from audio.sounds; required unless the rule is a reverb rule */
  sound?: string;
  when?: AudioCondition;
  /** Instead of a sound: the reverb's wet (0-1, or the volume forms) while `when` holds; the highest holding one wins, none gives engine.audio.reverb's own wet back. Not with sound / volume / every / bus @experimental */
  reverb?: number | AudioVolumeData | ((e: Engine, ambience: import('./gameplay').Ambience) => number);
  /** 0-1, data { base, add: { measure: factor }, min, max }, or a function of the moment (e, ambience) => 0-1 (code only) */
  volume?: number | AudioVolumeData | ((e: Engine, ambience: import('./gameplay').Ambience) => number);
  /** Fade seconds when the rule turns on / off (1) */
  fade?: number;
  /** One-shot: [shortest, longest] seconds between plays */
  every?: number[];
  /** Bus (default 'ambience') */
  bus?: AudioBus;
}
/**
 * Synthesized sound, registered as a sound asset (assets.manifest({ sounds: { ding: fn } }) or { build: fn, params }): connect to `out` and return
 * the length in seconds, or { stop(time) } for a loop (params.loop is true then)
 */
export type SynthFn = (audio: Audio, params: Record<string, any>, out: any) => number | void | { stop(time: number): void };

/**
 * The audio table of a content pack (content.load({ audio })): data only. sounds are play rules naming asset pack sounds (files or synths);
 * ambience and music.rules use condition keys and measures, never functions. Merged with createEngine({ audio }); a name in both is an error
 */
export interface ContentAudio {
  sounds?: Record<string, SoundSource>;
  ambience?: AmbienceRule[];
  music?: { tracks?: Record<string, import('./gameplay').MusicTrack>; rules?: import('./gameplay').MusicRule[] };
  footsteps?: Record<string, string>;
}
/** The game's sound config: createEngine({ audio }), read back as engine.audio.config (merged with content packs' ContentAudio). */
export interface AudioConfig {
  /** Sound name -> play rule: an asset sound name / path, variants, or SoundDef */
  sounds?: Record<string, SoundSource>;
  /** ambience() rule table */
  ambience?: AmbienceRule[];
  /** music() defaults: tracks, rules, fade seconds, duckDialogue (how low the music bus ducks during dialogue; default false = no duck) */
  music?: {
    tracks?: Record<string, import('./gameplay').MusicTrack>; rules?: import('./gameplay').MusicRule[];
    fade?: number; duckDialogue?: number | false; duckFade?: number; hold?: number; interval?: number;
  };
  /** Ground type (terrain groundType or level material name) -> sound name; 'water' while swimming; default for unmapped types (else 'footstep') */
  footsteps?: Record<string, string>;
  /** Volume per bus 0-1, default { master: 0.8, music: 0.5, sfx: 0.8, ambience: 0.7, ui: 0.8 }; an extra key adds a bus */
  levels?: Record<string, number>;
}


// ======================================================================
// Post-processing (type generated from render/PostFX.js, see types/generated/), UI parts
// ======================================================================

/**
 * One UI part: the engine calls these, the part only draws. Every method is optional (missing ones do nothing).
 * What each part receives:
 *   loading      show({ title }) · update({ progress 0-1, text, failed? }) · hide()   (failed: the critical tasks that stopped start())
 *   toast        show({ text, kind: 'info'|'quest'|'item'|'save'|'error'|string, ms })
 *   title        show({ title, items: [{ id, label, run() }] }) · hide()          (full screen: engine.ui.open / close)
 *   hud.marker   show() · update({ x, y, onScreen, arrow, angle, label, icon, distance }) · hide() · dispose()   (one per marker)
 *   hud.counter  update({ id, label, icon, value, max }) · dispose()               (one per counter)
 *   hud.bar      update({ id, label, value, max }) · dispose()                    (one per bar)
 *   hud.button   update({ id, label, icon, run, key? }) · dispose()                (one per button; call run() on click; key = shown key text)
 *   hud.hint     update({ id, label, key }) · dispose()                           (one per key hint; show "key · label", like the interaction prompt)
 *   touch        show(view) · update(view)  TouchView: on-screen stick and action buttons (touch devices / joystick: true)
 *   dialogue     show() · update(view) · hide()  DialogueView (dialogue module)
 *   prompt       update(view) every frame · hide()  PromptView (interactions module)
 *   questLog     show(view) · update(view) · hide()  QuestLogView (quests module; full screen: opened by the quest key)
 */
export interface UIPart {
  show?(data?: any): void;
  update?(data?: any): void;
  /** May return a promise that resolves when a fade-out has finished (engine.ui.settled() waits for it) */
  hide?(): void | Promise<void>;
  dispose?(): void;
  /** A modal part's root element: the UI choice cursor (uiFocus nav) moves over the controls inside it, so the part works with a gamepad / keyboard only */
  readonly el?: HTMLElement | null;
  [key: string]: any;
}
/** Your own part: called once per single part (loading, toast, title) or once per item (hud.*); options are what the game passed as an object */
export type UIPartFactory = (engine: Engine, options: Record<string, any>) => UIPart;
/** false off · true the default · an options object for the default · your own factory */
export type UIPartValue = boolean | Record<string, any> | UIPartFactory;
/** Declaring a part (engine and modules): on = shown unless turned off; multi = one part per item; modal = full screen, opened with ui.open */
export interface UIPartDef {
  on?: boolean;
  multi?: boolean;
  modal?: { freeze?: boolean | ((engine: Engine) => boolean); cancel?: (engine: Engine) => void; data?: (engine: Engine, options: Record<string, any>) => object } | null;
}
/**
 * What the 'touch' UI part receives in show(view) and update(view) (buttons added later, language changed). Call move / press / release from your controls:
 * they feed the same input path as keys, so engine.input.axis and pressed('jump') work unchanged.
 * @example
 * engine.ui.set('touch', (engine) => ({
 *   show: (v) => { myPad.onDrag = (x, y) => v.move(x, y); for (const b of v.buttons) myButton(b.label, () => v.press(b.action), () => v.release(b.action)); },
 * }));
 */
export interface TouchView {
  /** Draw a stick (createEngine({ joystick }): 'auto' on touch devices, true always) */
  stick: boolean;
  /** One button per action the modules asked for (touch devices only) */
  buttons: { action: string; label: string }[];
  /** Stick position: x right, y forward, length <= 1; move(0, 0) on release */
  move(x: number, y: number): void;
  /** Button pressed / released */
  press(action: string): void;
  release(action: string): void;
}
/** A title screen button: built-ins 'start' | 'continue', a module's button by id (engine.ui.titleItem: 'settings'), or your own */
export interface UITitleItem {
  id?: string;
  label: string | ((engine: Engine) => string);
  run(engine: Engine): any;
}
/** Replaces a window's inner HTML (createEngine({ ui: { templates } }), engine.ui.templates) */
export type UITemplate = (data: any, tools: { esc: (s: any) => string; t: (key: string, params?: Record<string, any>) => string; icon?: (def: any) => string }) => string;
/** The CSS values of every default UI part: each key becomes the variable --threedog-<key> on engine.uiRoot */
export interface UITheme {
  /** Background color */
  bg?: string;
  /** Text color */
  fg?: string;
  /** Secondary text color */
  muted?: string;
  /** Accent color */
  accent?: string;
  /** Color for good news such as "done" */
  good?: string;
  /** Divider color */
  line?: string;
  /** Font (CSS font-family) */
  font?: string;
  /** Corner radius of windows and the dialogue box (CSS, e.g. '12px') */
  radius?: string;
  /** Corner radius of small things: buttons, prompts, toasts, bubbles, HUD counters (CSS, default '8px') */
  radiusSmall?: string;
  /** Loading screen background */
  loadingBg?: string;
  /** Window shadow (CSS) */
  shadow?: string;
  /** Shadow of small things: speech bubbles, objective marker labels (CSS) */
  shadowSmall?: string;
  /** Fade color for scene transitions (CSS), default '#000' */
  fadeBg?: string;
  /** Background / text / accent of objective markers, counters and progress bars (CSS); default: follow bg, fg and accent */
  hudBg?: string;
  hudFg?: string;
  hudAccent?: string;
  /** Other CSS variables (become --threedog-name) */
  [cssVar: string]: string | number | undefined;
}
/** createEngine({ ui }): the look of the default parts (theme, css, fonts, templates); every other key is a part name */
export interface UIOptions {
  /** CSS values of every default part */
  theme?: UITheme;
  /** Extra CSS, placed after every default (overrides .threedog-* classes) */
  css?: string;
  /** Font asset names the UI uses (engine.assets.manifest({ fonts })); loaded at start(), then written in theme.font: '"pixel", system-ui' */
  fonts?: string[];
  /** Replace the content of a window wholesale: inventory, quests, settings, loading, hudMarker, hudCounter, hudBar… */
  templates?: Record<string, UITemplate>;
  /** Part name → false (off), true (default), options, or your own part */
  [part: string]: UIPartValue | UITheme | string | string[] | Record<string, UITemplate> | undefined;
}
/** engine.ui: every piece of screen UI is a named part a game can replace or turn off (see recipes/26-ui-parts.md) */
export interface UIParts {
  /** Window content by name: a function here replaces that window's default HTML, read each time it draws */
  templates: Record<string, UITemplate>;
  /** Declare a part and its default (engine and modules; games use set) */
  define(name: string, factory: UIPartFactory, def?: UIPartDef): Handle;
  /**
   * Replace a part, give the default options, or turn it off (before engine.start(); the loading part only via createEngine({ ui }))
   * @example engine.ui.set('hud.marker', false)
   * @example engine.ui.set('toast', (engine) => ({ show: ({ text, kind }) => { if (kind !== 'quest') myToast(text); } }))
   */
  set(name: string, value: UIPartValue): void;
  /** The live single part (null when off) */
  get(name: string): UIPart | null;
  /** A new part for one item of a multi part (null when off) @experimental */
  create(name: string): UIPart | null;
  /** Open a full-screen part (title): shows it, takes Esc, locks input, freezes gameplay, emits ui:open; false when off */
  open(name: string, data?: object): boolean;
  /** Close a full-screen part, emits ui:close */
  close(name: string): void;
  /** Is the part open now */
  isOpen(name: string): boolean;
  /** Add a title screen button from a module (settings adds 'settings'): shown after continue / start, and nameable by id in the title's items. ctx.track the handle @experimental */
  titleItem(id: string, item: { label: string | ((engine: Engine) => string); run(engine: Engine): any }): { remove(): void };
  /** name -> 'default' | 'custom' | 'off' */
  describe(): Record<string, string>;
  /**
   * Resolves once every hiding part has finished fading out (hide() returned a promise); screenshots wait for it
   * @example await engine.ui.settled();
   */
  settled(): Promise<void>;
}

// ======================================================================
// Ground interface
// ======================================================================

/** Conventional names for the picture values only one writer may hold (core/scene/pictureSlots.js), taken with provides like any other slot */
export type PictureSlot = 'sky' | 'fog' | 'tone' | 'environment' | 'background' | 'sun';

/** engine.debug: the core diagnostics (override / clear / view / defineView) plus the F3 panel, null without the debug() module */
export interface DebugApi extends DebugOverrides { panel: DebugPanel | null }

/**
 * Ground provider: whoever provides the ground height is the "terrain" (terrain module, level module, or the default flat y=0).
 * What a ground provider supplies (engine.setGround, ctx.ground.provide, the terrain and level modules): height, slope, type and waterLevel, plus the optional hooks.
 * A game does not call the four samplers on engine.ground: it uses engine.surface / slope / groundType / waterAt / waterLevel, which pick the layer and the water bodies
 */
export interface GroundProvider {
  /**
   * Ground height (meters) at (x, z). For multi-layer ground (bridges, caves) pass refY: takes the highest layer not above refY + one step (0.45 m);
   * without it the highest layer is used. Single-layer ground ignores refY.
   * A game reads it with engine.surface(x, z)
   */
  height(x: number, z: number, refY?: number): number;
  /** Slope at (x, z) (height difference / horizontal distance). A game reads it with engine.slope */
  slope(x: number, z: number, refY?: number): number;
  /** Ground type at (x, z) (landform name, e.g. 'meadow'). A game reads it with engine.groundType */
  type(x: number, z: number, refY?: number): string;
  /** Global water level (meters); -Infinity when there is no water. A game reads engine.waterLevel */
  waterLevel: number;
  /** Optional: water surface height at (x, z) when it differs per point (-Infinity = none); replaces waterLevel there. A game reads engine.waterAt */
  water?(x: number, z: number, refY?: number): number;
  /**
   * Is there ground at (x, z). Always true except off the outline of terrain({ shape }), where height is -Infinity and slope 0.
   * @example if (engine.ground.has(x, z)) engine.snapToGround(chest);
   */
  has(x: number, z: number): boolean;
  /** Height below which something has fallen out of the world (terrain:void): engine.terrain.voidY with terrain({ shape }), else -Infinity */
  voidY(): number;
  /** Optional: iterate the circular colliders (tree trunks etc.) within range meters of (x, z) */
  forEachCollider?(x: number, z: number, range: number, fn: (cx: number, cz: number, r: number) => void): void;
  /** Optional: chunk edge length (meters) */
  chunkSize?: number;
  /** Optional: how far (meters) the ground is shown around a stream source now; stream entries build within it by default (else engine.uniforms.uViewDistance) @experimental */
  viewRange?(): number;
  /** Optional: collision data of a chunk (used by the physics module) @experimental */
  chunkCollision?(cx: number, cz: number): any;
  /** Optional: static triangle mesh (the level module provides it for physics) @experimental */
  staticTrimeshes?(): { positions: Float32Array; indices: Uint32Array }[];
  /** Optional: version number of the static mesh; rebuild when it changes @experimental */
  staticVersion?(): number;
}

/** engine.ground: the provider in force. A game samples through engine.surface / slope / groundType / waterLevel; here it uses has() and voidY() */
export interface Ground extends GroundProvider {
  /** @internal */
  height(x: number, z: number, refY?: number): number;
  /** @internal */
  slope(x: number, z: number, refY?: number): number;
  /** @internal */
  type(x: number, z: number, refY?: number): string;
  /** @internal */
  waterLevel: number;
}

// ======================================================================
// Module definition
// ======================================================================

/** What a module's install / init receive: the module's name, track(handle) and mod(point, o), both tied to the module's life */
export interface ModuleCtx {
  readonly name: string;
  /** Keep handle (anything with remove(): events.on, onFixed, onFrame, clock timers, audio.measure...) until the module goes: removed when its use()
   *  batch rolls back, its init fails, it is replaced, or on engine.dispose() before its dispose hook. Returns the handle */
  track<H extends { remove(): void }>(handle: H): H;
  /**
   * Write values on an object the module does not own and give them back when the module goes (or on the handle's remove()). A value goes back only if it is
   * still what this borrow left there, so a later write by the game stands. For a value several parties change at once use a shared value (ctx.mod).
   * @example ctx.borrow(e.renderer, { toneMapping: THREE.AgXToneMapping }); ctx.borrow(e.scene, { fog: new THREE.Fog(0x667788, 10, 200) });
   */
  borrow(obj: object, values: Record<string, any>): { remove(): void };
  /**
   * engine.mod with this module as the owner, tracked: the change goes when the module goes. Passing owner throws (use engine.mod for another name).
   * @example ctx.mod('time.world', { mul: 0.8, layer: 'effect' })
   */
  mod(point: string, opts: Omit<import('./gameplay').ModOptions, 'owner'>): import('./gameplay').ModHandle;
  /**
   * engine.control with this module as the default owner, tracked: every character the module holds is handed back when the module goes.
   * @example const h = ctx.control.take(guard, { layer: 'script', step: (dt, ch) => ({ x: 1, z: 0 }) })
   */
  control: {
    take(who: any, opts?: Omit<Parameters<Control['take']>[1], 'owner'> & { owner?: string }): ReturnType<Control['take']>;
    /** True while owner (default the module) holds the character */
    has(who: any, owner?: string): boolean;
  };
  /**
   * Run fn once while start() waits for the GPU to compile shaders (the page's thread is idle then), for a one-time warm-up that would
   * otherwise land in the first frame: a WASM library's first call compiles its code. After start() it runs at once.
   * @example ctx.whileCompiling(() => { const w = new R.World(g); w.step(); w.free(); })
   */
  whileCompiling(fn: () => void): void;
  /** Background results that change gameplay take effect on a fixed tick: ctx.commits.request({ apply, fallback, valid }), Commits and CONVENTIONS "Worker results that change gameplay" */
  readonly commits: Commits;
  /**
   * This module puts data into whoever holds that capability: fn runs before the use() of a new holder returns, so the next line can read it whole. Leaves with the module.
   * A throw fails that use() and the old holder comes back.
   * @example ctx.feeds('collision', () => addMyWalls());
   */
  feeds(capability: string, fn: () => void): void;
  /** engine.ops.define, owned: the op goes when the module goes */
  ops: { define: Ops['define'] };
  /** engine.saves.define, owned: the part goes when the module goes and its data stays in the save as unattached data, handed back to a later install */
  saves: {
    define(key: string, provider: SaveProvider): Handle;
  };
  /** engine.ui.define, owned: the part is closed and its definition goes when the module goes */
  ui: { define(name: string, factory: UIPartFactory, def?: UIPartDef): Handle };
  /** engine.stream.addReadyCheck, owned */
  stream: { addReadyCheck(name: string, fn: (source: any) => boolean): Handle };
  /** engine.budget.metric, owned */
  budget: { metric(name: string, read: () => number, opts?: { limit?: number }): Handle };
  /** Where engine.thing finds this module's records, and what engine.explain({ thing }) adds; owned */
  things: { addSource(source: any): Handle; explainWith(fn: (e: Engine, thing: any, out: any) => void): Handle };
  /**
   * Give the ground. provides must name 'ground' (terrain and level hold it too, so two providers are refused at use()); when the module goes the flat ground comes back.
   * addColliders: more static colliders in engine.ground.forEachCollider, whoever gives the ground.
   * @example provides: ['ground'], install(e, ctx) { ctx.ground.provide({ height: (x, z) => 0 }); }
   */
  ground: { provide(g: Partial<GroundProvider>): Handle; addColliders(forEach: (x: number, z: number, range: number, fn: (x: number, z: number, r: number) => void) => void): Handle };
}

/** What a module may own (ModuleDef.type; core/engine/moduleTypes.js) */
export type ModuleType = 'world' | 'picture' | 'actor' | 'rules' | 'ui' | 'net' | 'tool';

/** One content section: validate and prepare must not change the game, commit is the only step that does. See core/base/sections.js */
export interface ContentSection {
  /** Entry shapes in the params format, read by content.fields */
  fields?: Record<string, any>;
  /** The ids this data names in other sections */
  references?(data: any): { section: string; id: string; at?: string }[];
  /** Throw to refuse the data */
  validate?(data: any, c: any): void;
  /** Everything that can fail, away from live state; may be async */
  prepare?(data: any, c: any): any;
  /** Put the prepared data in place */
  commit(prepared: any, c: any): any;
  /** This prepare will not commit: let go of what it holds. prepared may be its Promise, still running */
  cancel?(prepared: any, c: any): void;
  /** Effect words this section's owner runs: word -> { ref, desc, describe, run } */
  effects?: Record<string, any>;
}

/**
 * A module (the argument of engine.use). The name is the property name on the engine once installed.
 * Per-frame hook order follows stage, then before / after within a stage, then install order.
 */
export interface ModuleDef<Api = any> {
  /** Module name; after install, access the object returned by install through engine[name] */
  name: string;
  /**
   * What the module owns (default 'rules'; core/engine/moduleTypes.js): 'world' state, records, ops (draws nothing) | 'picture' what is seen and heard (changes no
   * game state: no ops, no world record writes) | 'actor' characters | 'rules' game logic | 'ui' panels and menus (binds no keys, no game save part)
   * | 'net' multiplayer | 'tool' a one-shot job. A game module is usually 'rules'. Going against one warns once in dev with the fix; the call still goes through.
   */
  type?: ModuleType;
  /** Display name (used by the loading screen) */
  label?: string;
  /**
   * Capabilities this depends on: slot names another module provides ('inventory', 'world', 'sky'), never a particular module. Missing throws with both
   * fixes: install the engine's part of that name first, or your own module with provides: ['inventory']
   */
  requires?: string[];
  /**
   * Capabilities this module holds while installed ("only one may hold this": 'sky', 'inventory'); engine.<slot> is its API too, so dependents keep
   * working when a game swaps it: engine.use(mine(), { replaces: 'inventory' }). A second provider throws shared-taken. describe().shared shows the holder.
   * Picture values only one writer may hold have conventional names (PictureSlot, PICTURE_SLOTS; recipes/62-picture-code.md "Picture parts").
   */
  provides?: (PictureSlot | (string & {}))[];
  /**
   * Optional dependencies (modules the code uses as e.xxx?. or guards with if (e.xxx); rule R16 requires listing them all).
   * An array only registers them; written as { moduleName: 'what is lost when missing' }, start() prints a one-time development hint when one is
   * missing; use this form when it changes gameplay results
   */
  optional?: string[] | Record<string, string>;
  /**
   * Hook stages, only the run order (first -> last): 'control' timeline, camera -> 'ground' terrain, level -> 'environment' weather, sky, water
   * -> 'gameplay' interactions, dialogue, triggers -> 'effects' particles, settings, objective markers -> 'late' (default) -> 'audio' music.
   * Within a stage use before / after, then install order. What the module may own and how its errors are handled come from type
   */
  stage?: 'control' | 'ground' | 'environment' | 'gameplay' | 'effects' | 'late' | 'audio';
  /** Hooks run before these modules or capabilities, inside one stage (ignored if not installed; a capability means whichever module provides it now;
   *  use() throws on a cycle, or when the other module's stage already runs earlier; reached through a capability that is a dev warning and the stage order stays) */
  before?: string[];
  /** Hooks run after these modules or capabilities, inside one stage (ignored if not installed; a capability means whichever module provides it now;
   *  use() throws on a cycle, or when the other module's stage already runs later; reached through a capability that is a dev warning and the stage order stays) */
  after?: string[];
  /**
   * The game cannot run without this module (default false): when its init() fails, engine.start() rejects with the module name and reason instead of
   * starting a broken game. Without it a failed init is reported by severity (type picture / ui: disabled and the game carries on; other types: error tiers) and
   * start() goes on. Only start() reads it; a critical module installed after start() is reported like any other
   * @example engine.use({ name: 'saveSlots', type: 'rules', critical: true, async init(e) { await loadSlots(); } })
   */
  critical?: boolean;
  /**
   * Install: create and return the object the game uses (engine.name). Register listeners / timers through ctx.track so they leave with the module
   * (a use() batch that rolls back, a failed init, engine.dispose)
   * @example install(e, ctx) { ctx.track(e.events.on('item:add', onAdd)); return api; }
   */
  install?(e: Engine, ctx: ModuleCtx): Api;
  /** Called at startup (download things, wait for assets); may be async. ctx is the same as install's */
  init?(e: Engine, ctx: ModuleCtx): void | Promise<void>;
  /** Content sections this module owns: their format, checks and how the data becomes live state (validate, prepare, commit). See core/base/sections.js */
  content?: Record<string, ContentSection>;
  /** The loading screen waits until this returns true before disappearing (the hook is called isReady; in the engine ready is always a boolean property) */
  isReady?(e: Engine): boolean;
  /** After a save loaded: rebuild what the loaded state needs nearby; gameplay waits frozen until the returned Promise resolves. turn: as SaveProvider.load */
  afterLoad?(e: Engine, turn: SaveTurn): void | Promise<void>;
  /** Fixed step (60 times per second); dt is in seconds */
  fixed?(dt: number, e: Engine): void;
  /** Once per frame; dt is in seconds */
  frame?(dt: number, e: Engine): void;
  /** After rendering */
  afterRender?(dt: number, e: Engine): void;
  /**
   * engine.skip moved time without stepping: advance your own time by dt fixed seconds (calendar seconds = dt x clock.speed), no per-step work.
   * Called once per skip segment (segments end at timers and calendar clock marks); done is true on the last one: do expensive catch-up only then.
   * Only for modules that keep time themselves (calendar, world); modules that compare against clock.now need nothing
   */
  skip?(dt: number, e: Engine, done: boolean): void;
  /** Why a module with a fixed hook has no skip hook */
  noSkip?: string;
  /** How engine.skip advances it. exact: the same state as stepping, from the clock or a hook. approx: a hook catches up with an estimate. step: a hook replays the steps. none: a jump moves nothing here. A module with a fixed or skip hook declares it (engine.catalog reports one that does not); engine modules always do */
  skipKind?: 'exact' | 'approx' | 'step' | 'none';
  /** The option schema (core/base/params.js): engine.catalog shows it, and dev checks the module's options against it */
  params?: any;
  /** Where its docs live, shown by engine.catalog */
  docs?: string;
  /**
   * Optional: add state to engine.describe(). The (JSON-able) return value goes into the result keyed by the module name; nothing is added if it
   * returns nothing.
   * It may also fill in the standard fields of ctx.out, or use ctx.near() to report "nearby things"
   */
  describe?(e: Engine, ctx: DescribeContext): any;
  /** Optional: leak-hunting counts for engine.counts(), put there under the module name (a number or an object of numbers that should not keep growing) */
  counts?(e: Engine): number | Record<string, number>;
  /** Optional: answer engine.explain({ key: value }) for your own keys, e.g. explain: { quest: (e, id) => ({ ok: false, text: 'waits on step 2: ...' }) } */
  explain?: Record<string, (e: Engine, value: any, query: Record<string, any>) => { ok: boolean; text: string; [k: string]: any }>;
  /** Optional: handle the keys of engine.applyState that this module owns (e.g. calendar handles time and season); for at, return the place's position; return { refused: { key: reason } } for a value it cannot apply */
  applyState?(e: Engine, params: StateParams): void | PositionLike | { refused: Record<string, string> } | Promise<void>;
  /** Optional: the applyState keys this module handles; a key no module handles is reported in applyState's refused list. Leave out to count for every key */
  stateKeys?: string[];
  /**
   * Optional: called on engine.dispose() (in reverse install order). Only clean up what the core cannot: Workers, the physics world, real-time timers,
   * Audio nodes you connected yourself.
   * Events, onFixed / onFrame, clock timers, jobs, stream and ray registrations are reclaimed by the core. GPU memory is its creator's: free what you put in the scene with
   * ctx.track({ remove: () => engine.remove(mesh) }) (design.md 6.2); DOM listeners
   * attached to engine.signal and UI attached to engine.uiRoot are cleaned up automatically too
   */
  dispose?(e: Engine): void;
}
/** What engine.use() accepts: a module, an array of modules (what openWorld() returns); false/null are ignored */
export type ModuleInput = ModuleDef | ModuleInput[] | false | null | undefined;

// ======================================================================
// Engine
// ======================================================================

export interface EngineOptions {
  /** Canvas element (required unless renderer is given), e.g. document.getElementById('view') */
  canvas?: HTMLCanvasElement | HTMLElement;
  /** 'webgl' (default): the engine builds a WebGLRenderer. 'webgpu': it builds three's WebGPURenderer (needs import 'threedog/tsl' first) and start() awaits its init().
   * Or a ready three.js renderer (WebGLRenderer or WebGPURenderer) used as is; canvas then defaults to renderer.domElement. The engine configures
   * (pixel ratio, size, tone mapping, shadows) only a renderer it created itself. A WebGPURenderer passed in goes the same way as 'webgpu' (start() inits it if needed) */
  renderer?: 'webgl' | 'webgpu' | EngineRenderer;
  /** WebGPU route only: what start() does when the browser gives no WebGPU. 'webgl2' (default): the same WebGPURenderer on its WebGL2 backend, TSL keeps
   * working; 'webgl': a WebGLRenderer instead (faster, but NodeMaterials cannot draw: start() fails if the scene has one); 'error': start() rejects.
   * Every fallback prints one '[threedog] WebGPU unavailable (...)' line and shows in describe().renderer */
  fallback?: 'webgl2' | 'webgl' | 'error';
  /** MSAA anti-aliasing (kept with post effects on), default on for desktop and off for low-tier devices; with a renderer of your own, its own antialias. It is fixed with the canvas: a player's settings row changes it at the next launch */
  antialias?: boolean;
  /** Render resolution, default min(device pixel ratio, 1.5); the low tier uses at least 0.75 x device pixel ratio (never below 1). describe().render.scale reports it */
  pixelRatio?: number;
  /**
   * Real screen pixels per art pixel, a whole number from 1 up: art pixels of exactly one size at any display scale, through page zoom and moves to another display.
   * Sets image-rendering: pixelated, antialias defaults to off, adaptive resolution stops, and the last few real pixels (fewer than k) at the right and bottom stay empty.
   * Giving pixelRatio or adaptiveResolution: true as well is an error. Recipe 62 section 4b.
   * @example createEngine({ canvas, pixelSize: 3 })
   */
  pixelSize?: number;
  /** Automatically lower quality when frames cost too much (resolution, and post effects that declare a cheaper or skippable form; engine.adaptive.steps), default true. Never silent: a dev warning once, and engine.budget.notice() */
  adaptiveResolution?: boolean;
  /** Target frame rate for automatic resolution lowering, default 55 */
  targetFps?: number;
  /**
   * All screen UI: replace or turn off any part (loading, toast, title, hud.marker, hud.counter, hud.bar, hud.button; the default title screen is off), and the look of the
   * default parts (theme, css, fonts, templates).
   * @example createEngine({ canvas, ui: { loading: { title: 'My Game' }, title: { title: 'My Game' }, toast: false } })
   * @example createEngine({ canvas, ui: { theme: { bg: '#1c140e', accent: '#e8a13a' }, css: '.threedog-prompt{font-size:16px}' } })
   */
  ui?: UIOptions;
  /** Volume of each channel, 0–1 */
  audio?: AudioConfig;
  /** Camera field of view (degrees), default 55 */
  fov?: number;
  /** Camera near clipping plane (meters), default 0.3 */
  near?: number;
  /** UI language: 'auto' (default) follows the browser (a language starting with zh gives 'zh-CN', anything else 'en'); or force 'zh-CN' | 'en' | your own. Matched by language: 'zh' / 'zh-Hans' give 'zh-CN', 'en-US' gives 'en'; a language with no strings warns once */
  locale?: string;
  /** Override / add UI strings: { 'zh-CN': { key: text } } */
  strings?: StringTables;
  /**
   * The game's keys per action (keyboard, 'Mouse0', gamepad 'PadA' in one list), owner 'game': replaces the basics (move / confirm / cancel / UI
   * cursor) and binds every other action, e.g. { interact: ['KeyE', 'PadX'], ...presets.bindings.dialogNumbers }. Same as engine.input.bind(map)
   */
  bindings?: Readonly<Record<string, string | readonly string[]>>;
  /** Save name prefix; must differ when several games share one site, default 'game' */
  saveKey?: string;
  /** On-screen joystick: 'auto' (only on touch devices) | true | false */
  joystick?: 'auto' | boolean;
  /** While playing (no menu, not paused), keys the game binds do not reach the browser, e.g. Ctrl+S; true by default. In dev builds F5, Ctrl+R, F12 stay the browser's (recipe 58) */
  blockBrowserKeys?: boolean;
  /**
   * Headless mode: no real-time loop and no per-frame rendering, advances only on step() (for tests and screenshots). Adding ?threedog-headless to the
   * URL also turns it on
   */
  headless?: boolean;
  /**
   * Check parameter names at runtime and warn on misspelled names (the console prints "did you mean xxx"), default true; a release build can write false
   * to turn it off
   * @experimental
   */
  validate?: boolean;
  /**
   * Directory of Draco/KTX2 decoders (a URL containing draco/ and basis/), for when they live on a CDN. Normally not needed: the decoders bundled with
   * three are packed by vite automatically
   * @experimental
   */
  decoders?: string;
  /** Performance budget limits, e.g. { drawCalls: 250, fps: 55 }; only the given categories are checked; off by default */
  budget?: BudgetLimits;
  /** Set up a scenario from URL parameters (?time=18:30&weather=rain&pos=40,-20), default on only in development @experimental */
  urlState?: boolean;
  /** Seed for engine.random; default 1 in headless mode (reproducible), the current time for live runs (different every game) */
  seed?: number;
  /**
   * Shared "can walk there" parameters (meters / degrees): collision, the Rapier capsule, navigation and level steps all read them by default. Default {
   * radius: 0.4, height: 1.8, maxSlope: 48, stepHeight: 0.45 }
   */
  movement?: Partial<MovementProfile>;
  /**
   * Worker pool size for engine.threads: 'auto' (default: cores - 1, at most 4), a worker count, or false (all on the main thread, same results, no
   * workers created) @experimental
   */
  threads?: 'auto' | number | false;
  /** Gameplay waits while the window is in the background or the tab is hidden; default true (engine.page) */
  pauseOnBlur?: boolean;
  /** false: no default lights in the scene at all (engine.lights.sun / hemi still exist, detached, so sky and describe never see undefined); the game adds its own. No light of the engine's reaches the picture. Default true */
  lights?: boolean;
  /** Automatic instancing of repeated static models the engine places (engine.batching; your own meshes opt in with userData.batch = true): false turns it off; default { minCount: 8, cell: 4 * engine.stream.cellSize } */
  batching?: false | BatchingOptions;
}

/**
 * engine.movement (read-only): character radius / height / max slope (degrees) / step height; slopeRatio is maxSlope converted to height difference /
 * horizontal distance
 */
export interface MovementProfile { radius: number; height: number; maxSlope: number; stepHeight: number; readonly slopeRatio: number }

// ======================================================================
// Rays engine.raycast / pick / rays
// ======================================================================

/** Parameters of engine.raycast() */
export interface RaycastOptions {
  /** Maximum distance (meters), default unlimited */
  far?: number;
  /**
   * What to hit: 'static' registered static objects (default) | 'all' plus what modules merge in (with rigid installed this includes rigid bodies, hits
   * carry entry and kind: 'rigid') | an array of objects
   */
  targets?: 'static' | 'all' | Object3D[];
  /** Hits for which this returns false are skipped */
  filter?: (hit: RayHit) => boolean;
  /** Hit only meshes that block the camera (level buildings, hidden col_ collision meshes); used by collision's cameraOcclusion */
  occluders?: boolean;
}
/**
 * Ray hit: point is the hit point, distance in meters, normal the surface direction, object the mesh hit; entry/kind come from the module that merged
 * the hit in (e.g. a rigid body)
 */
export interface RayHit {
  point: Vector3;
  distance: number;
  normal: Vector3 | null;
  object: Object3D | null;
  face: any;
  /** Which instance of an InstancedMesh was hit, as in a three.js intersection */
  instanceId?: number;
  /** Which item of a BatchedMesh was hit, as in a three.js intersection */
  batchId?: number;
  entry?: any;
  kind?: string;
  /**
   * Point -> thing, computed when read: the world record the hit belongs to (a batched instance resolves to its original), where it was authored and
   * what to edit.
   * @example const t = engine.pick(0, 0)?.thing;   // { id: 'chest-home', kind: 'chest', template: 'chest', definedAt: 'content/props.js:14', ... }
   */
  readonly thing?: HitThing;
}
/** One reason an object is not (or may not be) drawn: level 'hidden' stops it being seen, 'maybe' may explain an odd look (engine.inspect.scene) */
export interface SceneReason { code: string; level: 'hidden' | 'maybe'; text: string; fix?: string }
/** engine.inspect.scene() result */
export interface SceneInspect {
  camera: { position: { x: number; y: number; z: number }; near: number; far: number } | null;
  counts: { total: number; drawn: number; notDrawn: number; byType: Record<string, number> };
  items: { name: string | null; type: 'Mesh' | 'Points' | 'Line' | 'Sprite'; path: string; id: number; position: { x: number; y: number; z: number }; radius: number | null;
    material: { type: string; purpose: string | null } | null; visible: boolean; drawn: boolean; reasons?: SceneReason[] }[];
  /** objects left out by limit */
  truncated: number;
  text: string;
}
/** engine.thing(id): a HitThing with the registry fields always present */
export interface Thing extends HitThing {
  id: string; owner: string; at: string | null; phase: 'setup' | 'play'; saved: 'record' | 'code' | 'session' | 'engine'; keeps: string[]; loses: string[];
  /** the live object (the record's current model, null when not built) */
  readonly object: Object3D | null;
}
/** The detail of engine.explain({ thing: id }) (`threedog explain thing <id> --full` prints the same JSON); modules add keys to rules / state through their explainers */
export interface ThingExplanation {
  id: string; kind: string; owner: string;
  /** at: 'content/props.js:14' (null in release builds and for code without a file) */
  definition: { at: string | null; template: string | null; templateAt: string | null; level?: string; node?: string; spawned?: boolean; [k: string]: any };
  model: string | null;
  materials: ({ role: string | null; name: string | null; from: 'engine' | 'game'; type: string; color: string | null; mesh: string | null } | { more: number })[];
  state: { position?: number[]; visible?: boolean; scale?: number[]; [k: string]: any };
  rules: { height?: number; blocksMovement?: any; pickable?: boolean; interact?: any; [k: string]: any };
  ops: { op: string; desc: string | null; args: any }[];
  saved: { tier: 'record' | 'code' | 'session' | 'engine'; keeps: string[]; loses: string[]; overridden?: boolean; removed?: boolean };
  change: { runtime: string; permanent: string; diagnostic: string };
  overrides?: any[];
}
/**
 * What a ray hit is (RayHit.thing, engine.inspect(id).thing; engine.thing gives the same plus owner / saved): the world record it belongs to, else the
 * engine.add object. id is null for an object neither knows (engine.scene.add: only mesh and material are known then)
 */
export interface HitThing {
  id: string | null;
  kind: string | null;
  /** template name when the record is a content template instance */
  template: string | null;
  /** 'content/props.js:14' in dev and test builds (null in release, or when not from a content file) */
  definedAt: string | null;
  /** where the template itself is defined ('content/templates.js:3') */
  templateAt?: string | null;
  /** a level-model node record: level file name and node name */
  level?: string;
  node?: string;
  /** a record made during play: the op that made it and the tick */
  spawned?: { op: string | null; tick: number };
  model: any;
  mesh?: string | null;
  material?: string | null;
  position?: { x: number; y: number; z: number };
  /** the record's own fields (state you can change with world.set or an op) */
  fields: Record<string, any>;
  /** one sentence: where to change it for good */
  edit: string | null;
  /** who manages it: 'game' (engine.add), 'world' (a record), 'level' / 'stream' / 'engine:<module>' (engine internals) */
  owner?: string;
  /** dev: 'main.js:50' where engine.add was called (a record: where it was authored); null in release */
  at?: string | null;
  /** 'setup' (before engine.ready or in session:start) or 'play' (with op / tick) */
  phase?: 'setup' | 'play';
  op?: string | null;
  tick?: number;
  /** how much a save keeps (recipe 40): record = world save; code = thing.set / thing.remove overrides; session = nothing; engine = its module's business */
  saved?: 'record' | 'code' | 'session' | 'engine';
  /** what a save keeps / loses, in words */
  keeps?: string[];
  loses?: string[];
  /** removed with thing.remove (held for undo) */
  removed?: boolean;
}
/** A module merging in hits: (origin, direction, max distance) => hit or null */
export type RayProvider = (origin: Vector3, dir: Vector3, far: number) => RayHit | null;

/** createEngine({ batching }) options */
export interface BatchingOptions {
  /** Same geometry + material at least this many times in one cell becomes one InstancedMesh (default 8) */
  minCount?: number;
  /** Cell edge in meters that batches are split by (frustum culling, unloading); default engine.stream.cellSize */
  cell?: number;
}
/** engine.batching.stats */
export interface BatchingStats {
  /** InstancedMesh batches drawn */
  batches: number;
  /** Meshes drawn through them */
  instances: number;
  /** Draw calls saved per pass (instances - batches) */
  saved: number;
  /** Present while anything is batched: what batching did to the engine's content meshes and how to raycast / opt out / turn it off */
  note?: string;
  /** Dev only, while at least minCount identical game-made meshes draw unbatched: the opt-in line (obj.userData.batch = true) */
  hint?: string;
}
/** One entry of engine.batching.batches */
export interface BatchInfo {
  /** The batch (a real THREE.InstancedMesh) */
  mesh: any;
  /** Cell key 'cx,cz' */
  cell: string;
  /** Instances in use */
  count: number;
  /** items[i] is the placed object drawn by instance i */
  items: Object3D[];
}

// ======================================================================
// Frame-spread jobs engine.jobs, stream-in engine.stream, startup timing
// ======================================================================

/** Parameters of engine.stream.add(): position is the location, radius the size (meters), build generates (may be async), dispose unloads */
export interface StreamEntryOptions {
  /** Position (Vector3 / object / [x, y, z] / { x, z }; only the horizontal coordinates count) */
  position: PositionLike;
  /** Object size (meters); larger ones are built earlier */
  radius?: number;
  /** Generate the object (called when entering range, run spread over frames through engine.jobs) */
  build: () => Object3D | Promise<Object3D>;
  /** Unload (called when leaving range), default engine.remove (frees what nothing else in the scene uses); write your own when the object is reused (e.g. obj.removeFromParent()) */
  dispose?: (obj: Object3D) => void;
  /** Do not unload even when out of range */
  keep?: boolean;
  /** Build order: larger first (nearer first within the same priority), default 0 */
  priority?: number;
}
/** Options of engine.stream.source() */
export interface StreamSourceOptions {
  /** Reach in meters: caps every loader's range around this source (default: each loader's own range) */
  radius?: number;
  /** 'full' (default): models, stream entries, terrain, colliders; 'simple': terrain and hlod proxies only (a far view) */
  detail?: 'full' | 'simple';
  /** Build colliders around it (default true for 'full'); false for a camera that only needs a picture */
  physics?: boolean;
  /** Removed automatically when this Promise settles, or when this function returns true (checked every frame) */
  until?: Promise<unknown> | (() => boolean);
  /** Label for describe and errors */
  name?: string;
}
/** A stream source returned by engine.stream.source() (also engine.stream.player / engine.stream.camera) */
export interface StreamSource {
  name: string;
  radius: number | null;
  detail: 'full' | 'simple';
  physics: boolean;
  /** Current horizontal position */
  readonly x: number;
  readonly z: number;
  /** Everything this source asks for is loaded (checked at the end of each frame) */
  readonly ready: boolean;
  /** Resolves when ready becomes true */
  readonly whenReady: Promise<void>;
  /** Move the source (a live Object3D / Vector3, a function returning a position, or a fixed position) */
  at(position: PositionLike | (() => PositionLike)): this;
  /** A loader's range for this source: the loader's own range, capped by the source radius */
  reach(range: number): number;
  /** Stop loading for this source */
  remove(): void;
}
/** Handle returned by stream.add(): object is the generated object (null while not generated) */
export interface StreamHandle { def: StreamEntryOptions; object: Object3D | null; built: boolean; remove(): void }
/**
 * Startup timing (milliseconds): totalMs page open to playable, startMs start() to playable, preloadMs preloading, streamMs the nearby builds required
 * by stream registrations finished, compileMs shader compilation before the first frame,
 * modules is the init / ready time of each module. With a budget on and startupMs (open to playable) / moduleMs (a single module) given, the slowest
 * module is reported in the console when exceeded.
 * firstFrameMs: page open to the end of the first frame drawn after the loading screen (null until that frame, and headless); phases add up to it:
 * script (page open until createEngine), construct (createEngine), setup (game code until start()), init (saves, renderer, module init), preload,
 * world (scenario parameters, nearby builds), compile (shaders + hidden warm-up frame), draw (ready until the first frame's draw calls were submitted)
 */
export interface StartupReport {
  /** @experimental */ totalMs: number;
  /** @experimental */ startMs: number;
  /** @experimental */ preloadMs: number;
  /** @experimental */ streamMs: number | null; compileMs: number; modules: Record<string, { init?: number; ready?: number }>;
  /** @experimental */ firstFrameMs: number | null;
  /** @experimental */ phases: { script: number; construct: number; setup: number; init: number; preload: number; world: number; compile: number; draw: number | null };
}

// ======================================================================
// Setting up a scenario engine.applyState
// ======================================================================

/** Scenario parameters (can also go in the URL: ?time=18:30&weather=rain&pos=40,-20&cutscene=skip&state=name) */
export interface StateParams {
  /** A group of parameters named with defineState */
  state?: string;
  /** Time of day: 'HH:MM' or 0–1 */
  time?: string | number;
  /** Season name from calendar({ seasons }): jumps calendar.day to that season's first day (time of day kept) */
  season?: string;
  /** Weather name */
  weather?: string;
  /** Player position: 'x,z' or a position (sets the focus when there is no player) */
  pos?: string | PositionLike;
  /** Start at a named place (content places, level markers): past the title like play, then the player stands there with the game's camera on it */
  at?: string;
  /** Which save slot to load */
  save?: string;
  /** How many seconds to advance (real seconds: fixed-step seconds, no scale) */
  wait?: number;
  /** Opening cutscene: 'skip' skips it | 'keep' plays it as usual */
  cutscene?: 'skip' | 'keep';
  /** A view declared with engine.views to show after engine:ready (?view=name); ignored when the game declared no views */
  view?: string;
  /** Present (?play, any value): leave the title screen the way its Start does (engine.session.newGame(), the title part closes; flow leaves its start state) before wait; nothing when no title is up */
  play?: string | boolean;
  /** Delete every save of this page first (no Continue on the title); on a running page also end the run and go back to the title. ?fresh in the URL */
  fresh?: string | boolean;
}

/** A claim on something only its owner releases (pause, freeze, takeCamera, views) */
export interface OwnerHandle { owner: string; remove(): void }
/** engine.runState: state in one word, owners = every halt / freeze owner, blockedBy = opaque input contexts plus 'error' / 'loading' */
export interface RunState { state: 'loading' | 'title-frozen' | 'halted' | 'frozen' | 'running'; owners: string[];
  /** @experimental */ blockedBy: string[] }
/** Camera takeover: when non-null no camera module moves the camera (for cutscenes); see engine.takeCamera */
export interface CameraOverride {
  /** Who took over (any name) */
  owner: string;
  /** Optional: where the world loads around */
  focus?: Vector3;
  [key: string]: any;
}
/** One step of adaptive quality: 'resolution', 'post.<name>' (that effect's declared cheaper params, no recompile), 'post.<name>.off' (the effect held off: a chain rebuild),
 *  or the game's own knob: down() lowers one notch and returns false at its floor, up() undoes one notch */
export type AdaptiveStep = 'resolution' | `post.${string}` | { name: string; down(): boolean | void; up(): void };
/** State of automatic quality (resolution first-class, recipe 15 section 4b) */
export interface AdaptiveState { on: boolean; target: number; min: number; max: number; /** The ratio this device or game starts at: the base of the settings presets */ base: number;
  /** true once the render scale was lowered below max (a dev warning was logged) @experimental */ lowered?: boolean;
  /**
   * What may be lowered under load, first lowered first; raised back in reverse. null (default) = every added effect's cheaper params, then 'resolution', then the effects
   * that declare skipOnLowTier held off. [] or ['resolution'] opts the rest out. engine.budget.notice() says what is lowered now.
   * @example engine.adaptive.steps = ['resolution', { name: 'grass', down: () => { if (grass.density <= 0.3) return false; grass.density -= 0.2; }, up: () => { grass.density += 0.2; } }];
   */
  steps: AdaptiveStep[] | null;
  [key: string]: any }

// ======================================================================
// Shadows: engine.shadows (recipes/45-cascaded-shadows.md)
// ======================================================================

/** engine.shadows.cascades options (recipes/45) */
export interface ShadowCascadeOptions {
  /** Shadow maps along the view, 1-4 (default 3; 1 = the plain single map) */
  count?: number;
  /** Meters from the camera they cover (default 120) */
  maxFar?: number;
  /** Where the borders fall (default 'practical') */
  split?: 'practical' | 'uniform' | 'logarithmic' | ((count: number, near: number, far: number, out: number[]) => void);
  /** Cross-fade at the borders (default true) */
  fade?: boolean;
  /** Meters behind each cascade box toward the light still caught as casters (default 100) */
  lightMargin?: number;
  /** On engine.tier 'low': { count } (default 1, one map) */
  low?: { count: number };
}
/** What engine.shadows.cascades returns */
export interface ShadowCascades {
  /** The game's light it was given */
  readonly light: import('three').DirectionalLight;
  /** three's CSM object (the shadow node on WebGPURenderer); null while there is one map @experimental */
  readonly csm: any;
  /** Change options (a rebuild recompiles lit materials: a settings screen, not per frame) */
  set(options: ShadowCascadeOptions): void;
  /** Back to one plain shadow map: the light's position, target and shadow box as the game left them */
  remove(): void;
}
/** engine.shadows.box options */
export interface ShadowBoxOptions {
  /** What the box centers on: 'focus' (engine.focus, default) | 'camera' | an Object3D | () => Vector3 | false (it stays on the light's target) */
  follow?: 'focus' | 'camera' | import('three').Object3D | (() => import('three').Vector3) | false;
  /** Half size of the box in meters; left out: the light's own shadow camera stays as it is */
  extent?: number;
  /** Center snap grid in meters (default 0.5), or 'texel': one shadow pixel */
  snap?: number | 'texel';
  /** Meters the center is shifted in front of the view, default 0 */
  ahead?: number;
}
/** What engine.shadows.box returns */
export interface ShadowBox {
  set(options: ShadowBoxOptions): void;
  /** Stop following: the light's position, target and shadow camera come back */
  remove(): void;
}
/** What engine.shadows.budget returns */
export interface ShadowBudget {
  set(options: { every?: number }): void;
  /** Redraw this light's map on the next frame */
  redraw(): void;
  /** light.shadow.autoUpdate as it was */
  remove(): void;
}
/** A game's own term: a patch, in place of the engine's on every material that carries it */
export interface TermSpec {
  /** Slot code for WebGLRenderer */
  glsl?: string;
  /** (ctx) => node for WebGPURenderer */
  tsl?: any;
  uniforms?: Record<string, any>;
  /** Extra declarations for the glsl */
  pars?: string;
  /** Default 'lighting' for the cloud shadow, 'color' for the season tint */
  slot?: string;
}
/** engine.shaderTerms */
export interface Terms {
  /**
   * Your own cloud shadow in place of the engine's on engine materials and on what you passed to applyEffects, built before the call too; false takes it off them
   * all. uWeatherCloud, uCloudShadow*, uTime and threedogCloudShadow(worldPos) stay in scope. remove() gives the engine's back.
   * @example const mine = engine.shaderTerms.cloudShadow({ glsl: 'reflectedLight.directDiffuse *= 0.5;', tsl: c => ({ directDiffuse: c.directDiffuse.mul(0.5) }) }); mine.remove();
   */
  cloudShadow(spec: TermSpec | false): { remove(): void };
  /**
   * Your own season and snow tint in place of the engine's on engine materials and on what you passed to applyEffects with a season, built before the call too; false
   * takes it off them all. uFoliageTint, uGroundTint, uFoliageMix, uGroundMix, uGroundCover and threedogSeason(color, kind) stay in scope. remove() gives the engine's back.
   * @example const mine = engine.shaderTerms.season(kind => ({ glsl: 'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), uGroundCover.y);', tsl: c => c.color })); mine.remove();
   */
  season(spec: TermSpec | ((kind: 'foliage' | 'ground') => TermSpec) | false): { remove(): void };
}
/** engine.autoView */
export interface View {
  /**
   * Stop the engine changing a camera or drawing-buffer value: it is yours until you hand it back (a direct write takes it too; this says so on purpose, with no
   * warning). 'camera' hands the pose back after a direct write (take it with engine.takeCamera(owner)). Pass false to hand back; remove() does the same.
   * @example const mine = engine.autoView.manual('far'); engine.camera.far = 5000; mine.remove();
   */
  manual(key: 'far' | 'fov' | 'aspect' | 'pixelRatio' | 'sunDir' | 'camera', on?: boolean): { remove(): void };
}
/** engine.shadows.cache options: an Object3D (its whole subtree), a list of them, or a test on each mesh (recipes/45) */
export interface ShadowCacheOptions { static: import('three').Object3D | import('three').Object3D[] | ((mesh: import('three').Object3D) => boolean); }
/** What engine.shadows.cache returns */
export interface ShadowCache {
  /** Say again what is static; the kept map redraws */
  set(options: ShadowCacheOptions): void;
  /** Draw the static casters again on the next shadow frame: after one moved, hid or left */
  redraw(): void;
  /** The light's plain shadow again */
  remove(): void;
}
/** engine.shadows */
export interface Shadows {
  /**
   * Master switch: renderer.shadowMap.enabled, never a light's castShadow; materials recompile once. A cutscene holds it with
   * engine.mod('shadows.enabled', { owner, layer: 'system', set: false }); the settings menu restricts it.
   */
  enabled: boolean;
  /** Cascaded shadows for a DirectionalLight (in engine.scene, castShadow on): sharp near the camera, wide far away; color, intensity and shadow values stay yours */
  cascades(light: import('three').DirectionalLight, options?: ShadowCascadeOptions): ShadowCascades;
  /** Keep a DirectionalLight's one shadow map around something that moves; the light keeps its direction */
  box(light: import('three').DirectionalLight, options?: ShadowBoxOptions): ShadowBox;
  /** Redraw one light's shadow map every N frames; other lights are not touched */
  budget(light: import('three').Light, options?: { every?: number }): ShadowBudget;
  /**
   * Keep the shadows of what does not move: static casters are drawn once, each shadow frame copies them and draws only the rest. One plain map on WebGPURenderer;
   * elsewhere the light draws everything, with a warning. A static object that moves, hides or leaves needs redraw(); a moving light redraws everything. recipes/45
   * @example const kept = engine.shadows.cache(sun, { static: mesh => mesh !== cars.mesh }); kept.redraw(); kept.remove();
   * @experimental
   */
  cache(light: import('three').DirectionalLight, options: ShadowCacheOptions): ShadowCache;
  /** Change a light's shadow resolution at any time, with cascades every cascade's map (light.shadow.mapSize alone does nothing once a map exists) */
  mapSize(light: import('three').Light, width: number, height?: number): void;
  /**
   * Let cascaded shadows patch a lit ShaderMaterial of yours (lights: true, built from THREE.ShaderLib); built-in lit materials need nothing. Returns it.
   * @example engine.shadows.include(myShaderMaterial);
   */
  include<M extends import('three').Material>(material: M): M;
  /** The cascades on now (three's CSM, or the shadow node on WebGPURenderer); null when off @experimental */
  readonly csm: any;
}
/**
 * The engine. Created by createEngine({ canvas }); engine.use(module...) installs modules, engine.start() starts it.
 * Installed modules hang on the engine (engine.terrain, engine.sky...); modules not installed are undefined, check with engine.xxx?.method().
 */
export declare class Engine {
  constructor(opts: EngineOptions);

  // ---------- Core objects ----------
  /** False when createEngine({ validate: false }) turned the development checks off for this engine */
  validate: boolean;
  /** three.js renderer: WebGLRenderer, or WebGPURenderer on the WebGPU route (EngineRenderer) */
  renderer: EngineRenderer;
  /** The one quality value, what everything that scales by quality reads: the device's tier, 'low' (phones, integrated graphics) | 'high', unless the player's preset says otherwise (shared point 'tier'). A headless page takes the device's from ?threedog-tier=low|high (threedog shot / gallery / capture pass high, shot --tier low checks the low tier) */
  tier: 'low' | 'high';
  /** three.js scene */
  scene: import('three').Scene;
  /**
   * Placeholder lights: neutral and still, nothing moves them (the sky only gives signals). createEngine({ lights: false }) leaves them out of the scene
   */
  lights: { sun: import('three').DirectionalLight; hemi: import('three').HemisphereLight };
  /**
   * The camera the engine draws with, a plain THREE.PerspectiveCamera to begin with. Assign a real THREE.PerspectiveCamera or THREE.OrthographicCamera to draw through it; any other class
   * is refused [camera-option]. A camera rig with projection: 'orthographic' does the same for you, and the next perspective view brings the first camera back: read this where you use it.
   * describe().camera.projection says which projection is on.
   */
  camera: import('three').PerspectiveCamera | import('three').OrthographicCamera;
  /**
   * Camera focus, updated every frame by the camera module: terrain, models etc. load around it. The center of gameplay simulation is world.anchor (the
   * player by default), which does not follow the camera
   */
  focus: Vector3;
  /** Current ground */
  ground: Ground;
  /**
   * Shared parameters for whether a character can walk somewhere (set by createEngine({ movement }), read-only); same-named options of individual
   * modules are only overrides
   */
  readonly movement: Readonly<MovementProfile>;
  /**
   * The player (exists only after characters.addPlayer()). Its position belongs to the character's mover: other systems request movement (placeAt /
   * move / vehicle enter), don't modify position directly
   */
  player: Character | null;
  /**
   * World record id of the one the local user controls (default 'player'): interactions, trigger zones, marker distances, the world simulation center
   * and ops (ctx.actor) use it. Set it to hand control to a vehicle or squad member
   */
  actor: string;
  /**
   * Where an actor is now (default engine.actor): the player's position for 'player' (engine.focus without a player), else its model or world record
   * position; null when unknown. @example engine.actor = 'boat_1'; engine.actorPosition()
   */
  actorPosition(id?: string): { x: number; y: number; z: number } | null;
  /**
   * Where the engine is in its life: 'constructed' (start() not called) -> 'starting' (modules init) -> 'loading' (assets and the world; in both frame hooks only, no fixed step, so no game
   * time passes and every machine opens at tick 0) -> 'ready' (world built: fixed steps run, engine:ready fires) -> 'running' (start() resolved)
   * -> 'disposed'. engine.step() during loading runs frame hooks only
   */
  readonly phase: 'constructed' | 'starting' | 'loading' | 'ready' | 'running' | 'disposed';
  /** phase is 'ready' or 'running': the world is built and the loading screen is gone (every "is it ready" in the engine is such a boolean property) */
  readonly ready: boolean;
  /** phase is 'disposed' */
  readonly disposed: boolean;
  /** Execution order of module hooks (module names, first -> last), for debugging "who runs before whom" @experimental */
  readonly moduleOrder: string[];
  /**
   * What this game can do, read from the existing registrations (modules, ops, save parts, describe, params schemas).
   * No argument: the short list, an ARRAY of { id, kind, label, ops, saves, ... } (read .id, not Object.keys); a module id / op name: that entry
   * expanded (null if unknown); { find }: the short list filtered. 'picture': the picture menu, one row per capability (on now, runs here, cost class,
   * one way on, recipe, main limit) and the combination checks; o.offered adds effects not in the chain yet (factories with .about).
   * 'module:<id>' / 'op:<name>' / 'capability:<id>' pick the kind (a bare name tries picture, post, shadows first). recipes/51-capability-catalog.md
   * @example engine.catalog().map(s => s.id);   engine.catalog('shop').ops[0].failures   // ['soldOut', 'noMoney']
   */
  catalog(id?: string | { find?: string }, o?: { offered?: any[] }): any;
  /**
   * Gameplay error in development / testing (module hooks, onFixed / onFrame / clock callbacks, event listeners): { where (location of the error),
   * message }, gameplay is frozen; null when there is no error. A release build does not freeze, it reports once in the console
   */
  readonly error: EngineError | null;
  /**
   * The engine's cancel signal (AbortSignal): for DOM listeners write addEventListener(type, fn, { signal: engine.signal }), removed automatically on
   * dispose()
   */
  readonly signal: AbortSignal;
  /** UI root node: UI elements of the engine and modules hang under it (don't attach to document.body directly), the whole tree is removed on dispose() */
  readonly uiRoot: HTMLDivElement;
  /** Installed modules: name -> module definition */
  modules: Map<string, ModuleDef>;
  /** Standalone water bodies (lakes, ponds) */
  waterBodies: WaterBody[];
  /** Event bus */
  events: Events;
  /** i18n */
  i18n: I18n;
  /** Saves */
  saves: Saves;
  /** New game / continue / back to title, each from a clean slate (engine.session.newGame(), load(slot), quit()) */
  session: Session;
  /** Window focus, tab visibility, mouse lock, WebGL context: the one place that listens to them */
  page: Page;
  /** Input */
  input: Input;
  /** Audio */
  audio: Audio;
  /** Assets */
  assets: Assets;
  /** The API of the module holding the 'picture' slot (recipe 62), undefined when no look is installed: engine.use(next(), { replaces: 'picture' }) changes it, so read it again after a switch */
  picture: any;
  /** Observable loading: every asset load, module init / isReady and track() step as a task (phase, error, source manifest) */
  readonly loading: Loading;
  /** Post-processing: named effects in slots (add / get / enable / list) */
  post: PostFX;
  /** Occlusion culling of the engine's big things (hlod cells, batched groups) on both renderers. Off by default; it pays only when heavy things hide behind others (recipe 34) */
  occlusion: Occlusion;
  /** UI parts: every piece of screen UI is replaceable or off (see recipes/26-ui-parts.md) */
  ui: UIParts;
  /** Automatic resolution state */
  adaptive: AdaptiveState;
  /** How far the drawn frame is from the last fixed step to the next, 0-1 (real loop); 1 after step(). Holds still while frozen. For drawing fixed-step state smoothly */
  stepBlend: number;
  /** The camera holder in charge (latest engine.takeCamera claim), null when nobody holds it. Read-only */
  readonly cameraOverride: CameraOverride | null;
  /** Take the camera over (camera modules leave it alone) until remove(); the latest holder is in charge, releasing hands it back to the previous one */
  takeCamera(owner: string | ({ owner: string } & Partial<CameraOverride>), opts?: Partial<CameraOverride>): OwnerHandle;
  /** Why the page is (not) advancing; the dev bridge and MCP tools copy it as-is */
  readonly runState: RunState;
  /** Calendar clock: calendar seconds now, after / every, the rate (clock-time / season timers are on engine.calendar) */
  clock: Clock;
  /**
   * The one way several systems change a shared quantity: an entry per owner, combined by layer, ended by its handle; nothing remembers an old value.
   * @example engine.time.channel('enemies'); engine.mod('time.enemies', { owner: 'bullet-time', mul: 0.35, for: 2 })   // bullet time on a channel the game made
   * @example engine.mod('time.player', { owner: 'haste', mul: 1.2, for: 5 })          // haste on the player
   * @example engine.mod('freeze', { owner: 'pause-menu' })                             // pause menu (same as engine.freeze('pause-menu'))
   */
  mod(name: string, opts: import('./gameplay').ModOptions): import('./gameplay').ModHandle;
  /** Every shared quantity by name; define your own with engine.stacks.define(name, { base }) @experimental */
  stacks: import('./gameplay').Stacks;
  /**
   * Who decides where each character goes: one holder in charge per character, layers base < script < cutscene < physics < net; a higher one pauses the
   * lower until it ends. engine.control.take(ch, { owner, layer, step }) / .of(ch). Recipe 57
   * @example const h = engine.control.take(npc, { owner: 'escort', layer: 'script', step: () => ({ x: 0, z: 1 }) }); ... h.remove();
   */
  control: Control;
  /**
   * The one way to change what a module's public method does without copying the module: fn(next, ...args) runs instead of it; call next(...args)
   * for the method (do work before, after, or skip it). Several wrappers compose (the last wrapped runs first); remove() takes one out; listed in
   * describe().wraps. Private (_) methods throw. The methods a module promises are its contract.js api.
   * @example engine.wrap(engine.inventory, 'add', (next, id, n = 1, o) => carried() + weightOf(id) * n > 30 ? false : next(id, n, o), { owner: 'weight' })
   * @experimental
   */
  wrap<T extends object>(target: T, method: string, fn: (next: (...args: any[]) => any, ...args: any[]) => any, opts?: { owner?: string }): Handle;
  /** Time channels: read seconds with time.now('real' | 'ambient' | 'calendar' | a channel such as 'world'), speeds with scale(ch, id?) */
  time: import('./gameplay').Time;
  /** Story flags and counters (autosaved) */
  vars: Vars;
  /** Performance budget (off by default) */
  budget: Budget;
  /** The plugins folder: files in the game's plugins/ plugged at start by what they export (core/engine/plugins.js); describe().slots lists them */
  plugins: {
    /** Plug a folder's modules yourself (the vite preset does it): import.meta.glob('./plugins/*.js', { eager: true }) */
    add(files: Record<string, any>, o?: { order?: string[]; off?: string[] }): any;
    /**
     * Unload: take everything a plugin plugged out again (file name without .js).
     * To pause a post effect in its place, engine.post.get(name).enabled = false is lighter. The result names what was switched and what stays.
     */
    off(name: string): { off: string[]; note: string };
    /** Plug a switched-off plugin again (same place in the post chain) */
    on(name: string): { on: string[]; note: string };
    /** In plug order. replacedBy: the plugin that holds it out (export const replaces) */
    list(): { name: string; file: string; on: boolean; slots: string[]; replacedBy: string | null }[];
  };
  /** Ray registry (what engine.raycast hits) */
  rays: Rays;
  /** Frame-spread job scheduler */
  jobs: Jobs;
  /** Background results that affect gameplay take effect on a fixed tick (chunk collision, spread jobs with apply...). Internal: a module reaches it as ctx.commits, a game as engine.nextFixed @internal */
  commits: Commits;
  /**
   * Worker pool (createEngine({ threads })): lane() for your own worker script, pure() for self-contained functions, array() for shared typed arrays.
   * Results that affect gameplay go through commits @experimental
   */
  threads: Threads;
  /** One entry point for actions players and NPCs decide to do: define / run / can / list / recent, see Ops and recipes/23-ops.md */
  ops: Ops;
  /** Named fixed camera views for repeatable screenshots: define / show / release (recipes/46-blender-art-route.md) */
  views: Views;
  /** Seeded random numbers, an object (not a function): engine.random.next() in [0, 1), .range(a, b), .int(a, b), .pick(list), .chance(p). Use it for gameplay randomness: reproducible and saved with the game */
  random: Random;
  /**
   * Spatial stream-in and the stream sources (where the world is loaded: terrain, colliders, models, stream entries; built-in player and camera sources,
   * add one for a teleport destination)
   */
  stream: Stream;
  /** Automatic batching: the same static model the engine placed (world records, stream builds, level files) many times in a cell is drawn as one InstancedMesh; your own meshes only with userData.batch = true (createEngine({ batching })) */
  batching: Batching;
  /** Startup timing report (null until start() completes) */
  startup: StartupReport | null;
  /**
   * This engine's shader uniforms, read by the built-in effects (wind, clouds, season, water, sky, rain). Share these objects in your
   * own ShaderMaterial or patch instead of making your own uTime. Weather and sky write them; uTime is engine.time.now('ambient').
   * @example
   * new THREE.ShaderMaterial({ uniforms: { uTime: engine.uniforms.uTime }, vertexShader, fragmentShader });
   */
  readonly uniforms: EngineUniforms;
  /** Global water level (meters); -Infinity when there is no water */
  readonly waterLevel: number;

  // ---------- Modules (undefined when not installed) ----------
  /** Procedural terrain, data part (terrain() module: chunks, heights, edits, collision) */
  terrain?: Terrain;
  /** Draws the terrain chunks (terrain()'s drawing module, slot 'terrain-draw'; undefined when a game replaced it) @experimental */
  terrainDraw?: TerrainDraw;
  /** Vegetation (vegetation() module; grows on terrain or on any ground provider) */
  vegetation?: Vegetation;
  /** Draws the plants (vegetation()'s drawing module, slot 'vegetation-draw'; undefined when a game replaced it) @experimental */
  vegetationDraw?: VegetationDraw;
  /** Sky dome and the sun / daylight / sky-color signals, from the calendar's time; it writes no light or fog (sky() module) */
  sky?: Sky;
  /** Time of day, day, seasons and clock-time timers (calendar() module); NPC schedules, content clock conditions and audio time rules read it */
  calendar?: Calendar;
  /** Weather state (weather() module): the table, current values, set / auto, save, events */
  weather?: Weather;
  /** Weather drawing (installed by weather(); sky is optional): rain / snow particle systems, lightning flash, the weather's effect on sun, fog and sky @experimental */
  weatherDraw?: WeatherDraw;
  /** Water surface (water() module) */
  water?: Water;
  /** World data (world() module): things that must be saved, survive level changes and keep changing while far away; the model is built only when nearby */
  world?: World;
  /** Co-op multiplayer (net() module): host authority, clients mirror the state and request ops; see recipes/27-net.md @experimental */
  net?: Net;
  /** Placement grids: world <-> cell, occupancy derived from world records, per-cell layers, placement preview (grids() module) @experimental */
  grids?: Grids;
  /** Lightweight collision (collision() module): no clipping while walking, the camera is not blocked */
  collision?: Collision;
  /** Real physics, Rapier (rigid() module, needs collision) */
  rigid?: RigidBodies;
  /** Collision on all three axes (the collider3d slot, held by rigid() unless replaced) @experimental */
  collider3d?: Collider3D;
  /** Current camera (one of followCamera / firstPersonCamera / fixedCamera / rtsCamera) */
  cameraRig?: CameraRig;
  /**
   * Switch the camera at runtime between kinds, once a camera module is installed (openWorld installs followCamera; with none it throws camera-none
   * naming the module to install, e.g. engine.use(fixedCamera({ position, lookAt }))): the target and horizontal heading carry over; the first-person camera
   * hides the character body automatically (the shadow stays) and locks / releases the mouse; the camera switched out is kept, with its parameters, for
   * switching back.
   * Passing opts rebuilds this kind of camera with the new parameters. A wrong kind throws and lists the available options.
   * @example engine.onFrame(() => { if (engine.input.pressedRaw('toggleView')) engine.setCamera(engine.cameraRig.kind === 'follow' ? 'firstPerson' :
   * 'follow'); });
   */
  setCamera(kind: CameraKind, opts?: object): CameraRig;
  /** Cutscenes, tweens (timeline() module) */
  timeline?: Timeline;
  /** Hand-built level (level() module) */
  level?: Level;
  /** Trigger zones (triggers() module) */
  triggers?: Triggers;
  /** Particles (particles() module) */
  particles?: Particles;
  /** Makes a swarm of same-kind gameplay objects (swarm() module): engine.swarm({ name, capacity, geometry, material, fields }) @experimental */
  swarm?: SwarmMaker;
  /** Settings menu (settings() module) */
  settings?: Settings;
  /** Background music (music() module) */
  music?: Music;
  /** Characters: addPlayer() (characters() module) */
  characters?: CharactersApi;
  /** NPC management (characters() module, npcs on by default) */
  npcs?: NPCManager;
  /** Interaction prompts (interactions() module). Press a key near a thing. Install: engine.use(interactions()); undefined until installed. onUse returning { ok: false, code } fails the use and spends nothing */
  interactions?: Interactions;
  /**
   * Dialogue (dialogue() module). Ops: `dialogue.advance` (finish typing the line, else go on to the next one) and `dialogue.choose { index }` (pick
   * visible choice index, 0-based) are the only ways keys, clicks, tests and the dev bridge move a conversation on:
   * `engine.ops.run('dialogue.choose', { index: 0 })`
   */
  dialogue?: Dialogue;
  /** Inventory (inventory() module). Items, counts and containers, saved with the game. Install: engine.use(inventory()); undefined until installed. add() answers { ok }, read .ok */
  inventory?: Inventory;
  /** pickups(). Things on the ground that go in the bag. Install: engine.use(pickups()) with inventory() and interactions(); undefined until installed. A full bag leaves the item on the ground */
  pickups?: Pickups;
  /** Quests (quests() module) */
  quests?: Quests;
  /** Photo mode (photo() module) */
  photo?: Photo;
  /** Ambience (ambience() module) */
  ambience?: Ambience;
  /** Diagnostic overrides and view modes with an owner (override / clear / view: core, always there); panel is the F3 panel, null without the debug() module */
  debug: DebugApi;
  /** Navmesh (nav() module) */
  nav?: Nav;
  /** HLOD, merged distant geometry (hlod() module) @experimental */
  hlod?: Hlod;
  /** Shadow engineering on lights you hand in: enabled, cascades, box, budget, include (recipes/45): core, always there */
  shadows: Shadows;
  /** The camera and drawing-buffer values the engine changes on its own: manual() takes one (recipes/52): core, always there */
  autoView: View;
  /** Your own cloud shadow or season tint in place of the engine's (recipes/52): core, always there */
  shaderTerms: Terms;
  /** Light pool: many light sources, a fixed number of real lights (lightPool() module) */
  lightPool?: LightPool;
  /** Content loading (content() module) */
  content?: Content;
  /** Game flow and scene transitions (flow() module) */
  flow?: Flow;
  /** Objective markers, counters, progress bars (hud() module) */
  hud?: Hud;

  // ---------- Module system ----------
  /**
   * Install one or more modules (in order; dependencies must be installed first). A last argument { replaces: 'slot' } swaps the module that holds
   * that exclusive slot: it is unloaded first (its handles, changes and dispose) and put back if the new install fails.
   * @example engine.use(myInventory(), { replaces: 'inventory' })
   */
  use(...mods: (ModuleInput | { replaces: string | string[] })[]): this;
  /**
   * Unload one installed module: its tracked handles, its slots and ctx.mod entries, its dispose. What it added some other way stays (dev reports a picture module's
   * leftovers). Throws while another module still requires it. To swap a holder use engine.use(mine(), { replaces: 'slot' }).
   * @example engine.unuse('rain');
   */
  unuse(name: string): void;
  /** Whether a module of this name, or a provider of this capability, is installed. Installed only: engine.explain({ module: name }) says whether it is running */
  has(name: string): boolean;


  // ---------- Ground ----------
  /** Set the ground (called by the terrain and level modules); missing parts fall back to flat ground */
  setGround(g: Partial<GroundProvider>): void;
  /**
   * Ground height (meters) at (x, z); a position or object also works: engine.surface(mesh.position).
   * For multi-layer ground (bridges, caves, interiors) pass a reference height refY: returns the highest layer not above refY + one step (0.45 m), so
   * standing under a bridge gives the ground and standing on it gives the deck;
   * without it the highest layer is used (as before). Procedural terrain and flat ground have one layer and ignore refY.
   * Off the outline of terrain({ shape }) it is -Infinity (no ground there; engine.ground.has(x, z) says so as a boolean)
   */
  surface(x: number, z: number, refY?: number): number;
  surface(at: PositionLike, refY?: number): number;
  /** Slope at (x, z); a position or object also works */
  slope(x: number, z: number, refY?: number): number;
  slope(at: PositionLike, refY?: number): number;
  /** Ground type at (x, z) (for footsteps, particles); a position or object also works. 'void' off the outline of terrain({ shape }) */
  groundType(x: number, z: number, refY?: number): string;
  groundType(at: PositionLike, refY?: number): string;
  /**
   * Water surface height at (x, z): standalone water bodies first, otherwise the global water level; -Infinity when there is no water. A position or
   * object also works
   */
  waterAt(x: number, z: number, refY?: number): number;
  waterAt(at: PositionLike, refY?: number): number;
  /**
   * Put an object on the ground under it (y = ground height + offset) and return the object. With multi-layer ground the object's current y is the
   * reference height
   */
  snapToGround<T = Object3D>(obj: T, offset?: number): T;
  /** Add a water body (give radius for a circle, halfWidth / halfDepth for a rectangle) and return a handle { body, remove() }. The water module draws it */
  addWaterBody(opts: WaterBodyOptions): Handle & { body: WaterBody };

  // ---------- Common ----------
  /**
   * Get UI text (i18n): {name} in the text takes params.name, {key:action} the label of the key bound to that action; a key with no text comes back as itself
   * @example engine.t('shop.buy', { name: 'Fish' });
   */
  t(key: string, params?: Record<string, any>): string;
  /**
   * Add objects to the scene and register them (engine.thing), returns the first one. The last argument may be { id?, save? }: id makes thing.set /
   * thing.remove changes saved (unique, no '#', one object per call); without it a unique obj.name is used, else a session id obj#n. save: true asks dev
   * to warn when it cannot be saved. engine.scene.add adds without registering.
   * @example engine.add(windmill, { id: 'windmill' });
   */
  add<T = Object3D>(obj: T, ...more: (Object3D | { id?: string; save?: boolean })[]): T;
  /**
   * What a thing is and what a save keeps: a world record id, an engine.add id or name, or any Object3D (its registered ancestor). object is the live
   * Object3D (not enumerable). Throws with the closest id when nothing matches. Change it with ops.run('thing.set' | 'thing.remove', { id, ... }).
   * @example engine.thing('windmill').saved   // 'code'
   */
  thing(idOrObj: string | Object3D): Thing;
  /**
   * Fully delete an object (use it when you no longer want the object): removes it from its parent, unregisters rays, and releases the geometry and
   * materials of it and its children (textures and geometry / materials shared by assets are not released)
   */
  remove(...objs: Object3D[]): void;
  /**
   * Fixed-step logic (60 times per second, dt in fixed seconds): movement, physics, cooldowns, and gameplay keys (read pressed() here: a per-step
   * snapshot, independent of frame rate). dt is real seconds (always 1/60) unless { channel } names a time channel: then the channel's scaled dt.
   * phase 'early' (default) runs before every module fixed hook (the player has not moved yet this step); 'late' after them, before the clock
   * (hit checks, reading this step's result). Returns a handle { remove() }
   * @example engine.onFixed(() => checkHits(engine.player.position), { phase: 'late' })
   */
  onFixed(fn: (dt: number) => void, opts?: { channel?: string, phase?: 'early' | 'late' }): Handle;
  /**
   * Once per frame (dt in frame seconds, capped at the fixed step's 0.1 s; 0 on the frame back from a hidden tab): animation, camera, UI and UI keys (menus read this frame's latest input). Gameplay keys belong in onFixed.
   * Returns a handle { remove() }
   */
  onFrame(fn: (dt: number) => void): Handle;
  /**
   * Around the main frame render, after the camera update and batching. when 'before' (default): render into your own render target here
   * (mirror, minimap, portal, picking); the render target is reset to the screen afterwards. 'after': right after the frame (read pixels).
   * The main frame render itself stays the engine's (post chain). fn gets { renderer, scene, camera, dt }: dt is this frame's seconds, the same
   * value onFrame gets (no performance.now() bookkeeping needed). Returns a handle { remove() }
   * @example const rt = new THREE.WebGLRenderTarget(256, 256);
   * engine.onRender(({ renderer, scene }) => { renderer.setRenderTarget(rt); renderer.render(scene, mapCam); });
   */
  onRender(fn: (ctx: { renderer: EngineRenderer; scene: import('three').Scene; camera: import('three').Camera; dt: number }) => void, opts?: { when?: 'before' | 'after' }): Handle;

  /**
   * Draw one picture now, outside the loop, on either renderer. `renderOnce()`: the frame the player sees, onto the canvas through engine.post
   * (read the canvas in the same task, as photo mode does). `renderOnce(target)`: that frame through engine.post into a render target (the
   * canvas's pixels: tone mapped, in the output color space, display values). `renderOnce(target, camera)` with another camera: the scene from that camera, without post, as three
   * draws into a target: linear and not tone mapped (right as a texture on a material, which three then tone maps and encodes; read back as image pixels it looks dark). On WebGPURenderer each call is a fresh node frame, so two calls in one task give two pictures (a RenderPipeline draws its scene pass once per frame).
   * @example engine.renderOnce(); const url = engine.renderer.domElement.toDataURL('image/png');
   * engine.renderOnce(rt, mapCamera);   // a minimap / thumbnail into your own render target
   */
  renderOnce(target?: import('three').RenderTarget | null, camera?: import('three').Camera): void;

  // ---------- Light probes (render/probes.js) ----------
  /**
   * Bake a grid of light probes from the scene as it is now: three's probe grid renders a cube at every grid point and keeps spherical harmonics, and
   * every lit pixel inside the grid then takes its own interpolated light, on WebGL and WebGPU alike. The grid adds to whatever ambient light the
   * scene has (hemi, environment), which the bake also saw: lower those where the probes take over (a warning and describe().render.probes say so).
   * Outside the grid there is no probe light. A load-time cost, not per frame: 6 renders per probe, a few probes per task so the page keeps drawing;
   * ship the result with `toJSON()` + `engine.loadProbes(json)` instead of baking at every start. Adding a grid recompiles the lit materials once:
   * bake at start-up, not mid-play.
   * @example const probes = await engine.bakeProbes({ bounds: { min: [-20, 0, -20], max: [20, 6, 20] }, spacing: 4, include: o => !o.userData.moving });
   * saveFile('probes.json', JSON.stringify(probes.toJSON()));
   * @experimental
   */
  bakeProbes(opts: { bounds: import('three').Box3 | { min: PositionLike; max: PositionLike }; spacing: number; resolution?: number;
    include?: (o: Object3D) => boolean; owner?: string }): Promise<ProbeSet>;
  /**
   * A probe set from a file made by `handle.toJSON()` (no baking), on either renderer whichever one baked it. A wrong shape is refused with code `probes-data` and nothing is added.
   * @example const probes = engine.loadProbes(await (await fetch('probes.json')).json());
   * @experimental
   */
  loadProbes(json: ProbeData, opts?: { owner?: string }): ProbeSet;
  /**
   * Put a baked lightmap on the scene: `threedog bake light` wrote the file from the meshes the game marked `userData.static = true`; this rebuilds each with
   * its second UV set and sets plain `material.lightMap`, on WebGL and WebGPU alike. Call it once the level is built, with its lights as they will be
   * played. Nothing runs per frame. Keep the sun real-time; the ambient light the bake saw (hemisphere, environment) has to go, or it counts twice.
   * A wrong file is refused with code `lightmap-data` and nothing is changed. `material.lightMapIntensity` is yours. describe().render.lightmap says what
   * was skipped, moved or doubled.
   * @example const light = await engine.loadLightmap('light/level.lightmap');
   * @experimental
   */
  loadLightmap(file: string | ArrayBuffer, opts?: { owner?: string }): Promise<Lightmap>;

  // ---------- Settings ----------
  /** Render resolution, and the top adaptive resolution climbs back to. Throws while pixelSize is on */
  setPixelRatio(p: number): void;
  /**
   * One art pixel becomes k real screen pixels (createEngine({ pixelSize }) at runtime). While on, adaptive resolution stops, engine.setPixelRatio throws and a photo keeps
   * the art pixels. null turns it off and brings the ratio from before back.
   * @example engine.setPixelSize(3);
   */
  setPixelSize(k: number | null): void;

  // ---------- Rays, scenarios ----------
  /** Ray: shoot from origin along dir, returns the nearest hit or null (by default only registered static objects are hit) */
  raycast(origin: Vec3Like, dir: Vec3Like, opts?: RaycastOptions): RayHit | null;
  /**
   * Shoot a ray through the camera from screen coordinates (-1..1, e.g. input.pointer.ndcX/ndcY). The ray comes from the camera as last drawn: a rig.yaw / rig.pitch
   * write reaches it on the next drawn step, so several shots in one step with recoil between them cast from the rig's angles with engine.raycast (recipe 19)
   */
  pick(ndcX: number, ndcY: number, opts?: RaycastOptions): RayHit | null;
  /** Set up a scenario: time of day, weather, player position, load a save, advance time, skip cutscenes; emits state:applied when done */
  applyState(params: StateParams): Promise<{ ok: boolean, refused: { key: string, value: unknown, reason: string }[] }>;
  /** Name a group of scenario parameters, then use applyState({ state: name }) or URL ?state=name. Returns a handle: remove() forgets the name */
  defineState(name: string, params: StateParams, opts?: { owner?: string }): { owner?: string; remove(): void };
  /**
   * Scenario is ready: start() completed, and the URL parameters / the latest applyState have all been applied. Tests and screenshots wait for it:
   * page.waitForFunction(() => window.engine?.stateApplied)
   */
  readonly stateApplied: boolean;
  /** What the URL parameters or the latest applyState could not do, e.g. ?weather=typo. Read it after stateApplied @experimental */
  readonly stateRefused: { key: string, value: any, reason: string }[];

  // ---------- Start, pause, state ----------
  /** Start: initialize modules, preload assets, wait for the world to be ready */
  start(): Promise<this>;
  /** Whether in headless mode (createEngine({ headless: true })) */
  headless: boolean;
  /** Whether the real-time loop is stopped: only step() advances the game (headless mode starts this way) */
  halted: boolean;
  /** Smoothed frame rate */
  fps: number;
  /**
   * Pause the real-time loop: the picture stops and even rendering stops, only step() advances (for tests and screenshots). Use freeze() for a game menu
   * pause
   */
  haltLoop(owner?: string | { owner?: string }): OwnerHandle;   // end it with the handle's remove()
  /** Run fn at the start of the next fixed step (via commits); a Promise of fn's value */
  nextFixed<T>(fn: () => T): Promise<T>;
  /**
   * Gameplay pause (menu, flow's paused): fixed steps are skipped entirely (onFixed, module fixed, tick and every time view but ambient stop), frame
   * hooks and rendering continue and the UI works.
   * So gameplay logic (movement, timing, quest checks, cutscene waits) belongs in fixed, or check engine.frozen first in frame. owner is the freezer's
   * name, default 'game'. uniforms.uTime (wind, water, clouds), skeletal animation and particles keep moving while frozen; { still: true } stops them too (a still)
   */
  freeze(owner?: string | { owner?: string; kind?: 'title'; still?: boolean }, opts?: { kind?: 'title'; still?: boolean }): OwnerHandle;
  /** Is anyone freezing gameplay? */
  readonly frozen: boolean;
  /** True while a freeze asked for a full still (freeze(owner, { still: true })): frame code that moves things reads this, as animation and particles do */
  readonly still: boolean;
  /**
   * Advance seconds of fixed-step time synchronously; seconds must be a finite number >= 0: 0 advances nothing (no step, no render),
   * negative or non-finite throws (code step-seconds), any positive value runs at least one fixed step (60Hz; time channels and
   * the calendar clock.now / sky time of day run at their own speeds;
   * frame hooks run once every frameEvery fixed steps, default 2; describe: false returns null instead of building describe()).
   * jobs ignore real time and finish every frame; results of stream's synchronous build are attached to the scene before returning. When render is true
   * (default) one frame is rendered at the end. Returns the describe() result after advancing
   */
  step(seconds: number, opts?: { render?: boolean; frameEvery?: number; describe?: boolean }): GameState | null;
  /**
   * Skip game time forward (sleep until morning, wait an hour) without stepping every fixed step.
   * clock.after / every, sky.at / daily / between, day:start and season:change fire in time order as if stepped (each crossing once);
   * world records with far catch up the span in one far(rec, dt). onFixed, module fixed hooks, physics and near simulation do not run;
   * every time view (tick, real, ambient, channels, calendar) moves as if stepped. Input is locked and gameplay frozen during the skip; emits time:skip.
   * fade 0 (default): the time has moved when skip returns. fade > 0: fade out, jump, save, fade in; the Promise resolves after the fade in (it needs frames).
   * session.newGame / load / quit cancel a running skip: it resolves null.
   * @example await engine.skip({ to: '06:00' })
   * @example await engine.skip({ to: '06:00', fade: 0.6, save: 'auto' })
   * @example engine.skip({ seconds: 600 })
   */
  skip(opts: SkipOptions): Promise<{ seconds: number; clock: string | null; day: number | null } | null>;
  /**
   * Consistency check: engine.skip({ seconds }) vs stepping the same span in fixed steps; compares the saved state. Leaves the world at the stepped state (use a scratch playthrough or a test).
   * @param ignore state paths (or prefixes) not to compare
   * @returns a = after skip, b = after stepping
   * @example const r = await engine.checkSkip(600); if (!r.ok) console.log(r.diffs);
   */
  checkSkip(seconds: number, opts?: { ignore?: string[] }): Promise<{ ok: boolean; code?: 'frozen' | 'rate0'; diffs: { path: string; a: any; b: any }[] }>;
  /**
   * Consistency check: save -> load gives the same saved state back (nothing is written to the browser).
   * @example const r = await engine.checkSave(); if (!r.ok) console.log(r.diffs);
   */
  checkSave(opts?: { ignore?: string[] }): Promise<{ ok: boolean; diffs: { path: string; a: any; b: any }[] }>;
  /**
   * Call engine.describe(opts?: { radius?: number }) to get the current game state (a plain object, JSON.stringify-able); radius is how far counts as
   * "nearby" (meters, default 30). describe('picture') or describe({ only: ['picture', 'shared'] }) returns just those top-level sections (the whole object
   * is tens of KB on a big world); an unknown name comes back in unknownSections next to the list of sections.
   * engine.describe.add(name, fn) registers the game's own state in one line: the return value of fn(engine, ctx) goes into describe().<name>, and the
   * returned handle's remove() cancels it.
   * Small games use add; big games write the system as a module and use the module's describe hook. Example: engine.describe.add('range', () => ({
   * score, targets: targets.length }))
   */
  describe: {
    (opts?: { radius?: number; center?: { x: number; z: number }; only?: string[] }): GameState;
    (section: string | string[]): Partial<GameState> & { unknownSections?: string[]; sections?: string[] };
    add(name: string, fn: (e: Engine, ctx: DescribeContext) => any): { remove(): void };
  };
  /**
   * The same information as English text, summary first: at most 30 lines (standard lines, the 5 nearest things, the game's describe.add sections,
   * one line per module with its key counts, the engine tables such as shared / slots / owned as one count line), ending with how to expand.
   * { path: 'world.byKind' } returns one part of describe() as JSON; { full: true } returns everything (all nearby things, every module's full data).
   * @example engine.describeText()   engine.describeText({ path: 'quests' })   engine.describeText({ full: true })
   */
  describeText(opts?: { radius?: number; full?: boolean; path?: string }): string;
  /**
   * What is around an actor or a spot, and what that actor can do now (each op offer checked with can, possible first, at most 8; failed ones carry
   * code and the op's reasons note).
   * at: a world record id (that actor), [x, z] / { x, z } (a spot, ops as the player), or nothing (the player). radius default 10 m.
   * @example engine.inspect();            // { actor: 'player', at: { x, z }, near: [...], ops: [{ op: 'shop.buy', args, ok: false, code: 'noMoney',
   * why: 'Not enough gold' }] }
   * @example engine.inspect('enemy_3');   // why is this enemy not attacking: its ops and their reasons
   * @example engine.inspect('chest-home').thing.definedAt   // 'content/props.js:14': edit that line to change the level for good
   * thing (when at is a record id): the record as a thing to change, with where it was authored (see HitThing).
   */
  inspect: {
    (at?: string | { x: number; z: number } | number[], opts?: { radius?: number }): {
      actor: string; at: { x: number; z: number }; near: any[]; thing?: HitThing;
      ops: { op: string; args: any; ok: boolean; code?: string; why?: string | null; facts?: any; nextActions?: any[] }[];
    };
    /**
     * The mesh exists but is not drawn: use this first. Lists every Mesh / Points / Line / Sprite in the scene (name, type, world position, bounding radius,
     * material type and purpose, visible, drawn) and, for each one that is not drawn, every reason found, most likely first: own or ancestor visible = false,
     * layers not matching the camera, material flags (visible, opacity 0, colorWrite / depthWrite off), scale 0 or NaN, NaN position or vertices, empty geometry
     * or draw range, behind the camera, beyond camera.far, outside the frustum, bounding radius 0 or NaN, swallowed by fog. Computed on call only.
     * hidden: only the objects not drawn. limit: how many to list (default 40; counts cover everything). text is the same thing as lines to read.
     * @example engine.inspect.scene({ hidden: true }).items[0].reasons   // [{ code: 'hidden-ancestor', level: 'hidden', text, fix }]
     * @example engine.inspect.scene().text
     */
    scene(opts?: { hidden?: boolean; limit?: number }): SceneInspect;
    /**
     * Every material in the scene with its textures (slot, size, color space, estimated GPU bytes, how many materials share it), who made it
     * (engine / game), its shader patches and their slots, and how many meshes share it. issues lists wrong color spaces first (a color map that is not
     * sRGB renders washed out; a normal / roughness map marked sRGB bends its data). Computed on call. Plain three.js: scene.traverse + texture.colorSpace.
     * @example engine.inspect.materials().issues   // ['material "rock" (mesh "cliff"): normalMap "rock_n" holds data but is marked sRGB ...']
     */
    materials(opts?: { limit?: number }): { count: number; textures: number; textureBytes: number; issues: string[]; text: string;
      materials: { name: string | null; type: string; uuid: string; madeBy: 'engine' | 'game'; role: string | null; sharedBy: number; firstMesh: string | null;
        patches: { name: string; slots: string[] }[];
        textures: { slot: string; name: string | null; size: string; colorSpace: string; bytes: number; sharedBy: number; issue?: string }[] }[] };
    /**
     * The last frame's cost against budgets, each with the next call when over: draw calls, triangles, shader programs, texture memory (estimate),
     * JS ms per frame (cpuPhases), compile stalls during play (frames where three.js compiled new programs; startup compile ms), the costliest programs.
     * Budgets are the game's engine.budget limits, else a reference (desktop 60 fps; not enforced). Plain three.js: renderer.info.
     * @example engine.inspect.perf().text
     */
    perf(opts?: { top?: number }): { drawCalls: number; triangles: number; programs: number; textureMB: number; cpuMs: number | null; compileMs: number; ok: boolean; text: string;
      budgets: { name: string; value: number; budget: number; from: 'engine.budget' | 'reference'; ok: boolean; next?: string }[];
      compiles: { at: number; programs: number; ms: number }[]; [k: string]: any };
  };
  /**
   * Why something is the way it is. { op, args?, actor? }: text says whether it can run now, and if not the reason and the op's note on fixing it
   * (reason first);
   * detail has the last attempt and the events around it; recent / events are the raw last 5 attempts and event names within a step of the last one.
   * { value }: who last wrote a watched value, with its history. { thing: id }: where the id comes from; detail is the whole ThingExplanation. { module } / { capability }: whether it runs and what blocks it.
   * Other keys are answered by modules (definition field explain: { key(e, value, query) { return { ok, text } } }); the quests module answers { quest: id }.
   * @example engine.explain({ op: 'shop.buy', args: { shop: 'bakery', item: 'bread' } }).text   // 'shop.buy {...} cannot run now: noMoney (Not enough gold)'
   * @example engine.explain({ quest: 'first-light' }).text   // which step it waits on
   * An op whose args.id names a world record also says where that record was authored (text ends with "defined in content/props.js:14: edit it there…";
   * thing has the rest).
   */
  explain(q: { op: string; args?: any; actor?: string } | { value: string } | { thing: string | Object3D } | { module: string } | { capability: string } | { asset: string } | Record<string, any>): {
    ok: boolean; code?: string | null; text: string; detail?: any; recent?: any[]; events?: string[]; thing?: HitThing;
  };
  /**
   * Module hook timing, on by default in dev builds: pass true to turn on afresh, false to turn off (returns the engine); with no argument returns
   * { moduleName: { ms (median), mean, p95 } } per frame over the last 300 frame-hook cycles, or null when off. Only the module's own hooks count;
   * fixed hooks count one fixed step per frame, its dearest (a slow frame's catch-up steps are not the module's cost)
   */
  profile(on: boolean): this;
  profile(): Record<string, { ms: number; mean: number; p95: number }> | null;
  /**
   * Destroy the engine: stop the main loop, call each module's dispose(e) in reverse install order, then reclaim listeners, timers, audio, UI and GPU
   * memory (scene, assets cache, post-processing, renderer).
   * After that no callbacks fire and step() returns null. Safe to call repeatedly. Don't use it for level changes; use level.track(handle).
   * The engine's own renderer gives its WebGL context back (browsers keep about 16 live ones), so that canvas cannot host a new engine; keepContext: true
   * keeps it. A renderer passed to createEngine({ renderer }) is never released.
   */
  dispose(opts?: { keepContext?: boolean }): void;
  /**
   * Counts for leak hunting: they should not keep growing after repeatedly entering / leaving levels or opening / closing windows. geometries / textures
   * come from three.js renderer.info.memory (counted only after rendering)
   */
  counts(): EngineCounts;
}

/** engine.error and the engine:error event: where and why, plus a stable code, the fix and the pages to read (from the error or the hint table) */
export interface EngineError {
  /** Where it happened, e.g. "fixed hook of module quests" or "load() of save part 'inventory'" */
  where: string;
  /** The error message (English) @experimental */
  message: string;
  /** Stable code (e.g. 'save-load-threw', 'world-plain'); null for an unknown error */
  code: string | null;
  /** What to do about it; null when unknown */
  fix: string | null;
  /** The first frame of the stack ("at onFixed (main.js:91:12)"): which line threw; null when the error has no stack */
  at: string | null;
  /** Doc pages to read, relative to the package docs */
  docs: string[];
}

/** Result of engine.counts() */
export interface EngineCounts {
  /** Number of event listeners */
  listeners: number;
  /** Number of onFixed callbacks */
  fixed: number;
  /** Number of onFrame callbacks */
  frame: number;
  /** Number of clock timers (after / every); sky clock-time timers are in sky.timers */
  timers: number;
  /** Number of static meshes registered for rays */
  statics: number;
  /** Number of stream registrations */
  streamEntries: number;
  /** Unfinished tasks in the jobs queue */
  jobs: number;
  /** Requests in commits that have not yet taken effect */
  commits: number;
  /** Geometries in GPU memory (three.js renderer.info.memory) */
  geometries: number;
  /** Textures in GPU memory (three.js renderer.info.memory) */
  textures: number;
  /** Only with world() installed: records is the record count, views the number of records with a built model */
  world?: { records: number; views: number };
  /** Only with rigid() installed: number of rigid bodies */
  rigid?: number;
  /** Only with particles() installed: alive is the number of live particles, emitters the number of attached emitters */
  particles?: { alive: number; emitters: number };
  /** Only with swarm() installed: alive is the live objects of all swarms, swarms how many exist */
  swarm?: { alive: number; swarms: number };
  /** Only with sky() installed: timers is the number of at / between / daily / onSeason timers */
  calendar?: { timers: number };
  /** Any other module's counts(e) hook result, under the module name */
  [module: string]: any;
}

// ======================================================================
// Game state description engine.describe()
// ======================================================================

/** A nearby thing: dist is the distance (meters), dir the compass heading (north = -Z), rel relative to the camera heading */
export interface NearbyThing {
  name?: string;
  /** 'npc' | 'pickup' | 'interactable' | 'trigger' | 'entity' ... */
  kind?: string;
  dist: number;
  dir: 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';
  rel: 'front' | 'front-right' | 'right' | 'back-right' | 'back' | 'back-left' | 'left' | 'front-left';
  x: number; z: number;
  /** Prompt text when interactable */
  use?: string;
  [key: string]: any;
}
/** Result of engine.describe(). The standard fields are below; the return values of each module's describe hook are added separately, keyed by module name */
export interface GameState {
  ready: boolean;
  /** Gameplay error in development / testing (gameplay is frozen), null when there is none */
  error: EngineError | null;
  /** picture / ui modules disabled after an error */
  disabledModules: string[];
  /** Modules that are initializing, failed or blocked ({ name: state, or 'blocked by provider (state)' }); absent when every module with an init is running (engine.moduleStates has all) */
  moduleStates?: Record<string, string>;
  /** What loading is waiting for, what failed, whether it blocks the start (engine.loading.view()) */
  loading: LoadingView;
  /** tick / real / ambient / calendar are the time views (engine.time); with the calendar module there are also clock, day, season, isDay, timeOfDay */
  time: {
    tick: number; real: number; ambient: number; calendar: number; halted: boolean; frozen: boolean; headless: boolean; clock?: string; day?: number; season?: string; isDay?: boolean;
    [key: string]: any;
  };
  /**
   * Everyone who holds the engine still (empty parts left out): halt / freeze / camera / debugView [{ owner, at? }], input [{ context, owner, pass }]
   * (input.push), gates { action: owners } (input.gate). Every other shared value is in `shared`
   */
  holds: { halt?: any[]; freeze?: any[]; camera?: any[]; debugView?: any[]; input?: { context: string; owner: string; pass: boolean }[];
    gates?: Record<string, string[]>;
    /** Actions of a context on the stack that a pass-through context above shadows (binds the same key), so they do not read: every cause, as input.blockedBy gives it ('shadowed-by:vehicle', ...) */
    shadowed?: Record<string, string[]>; };
  /**
   * Every shared value and exclusive slot with entries, one row each ('move.speed[player]' for one record): the value, who decides it, how it
   * combined, and everyone else who wants it (hidden: a set above hides theirs).
   * @example engine.describe().shared['fog.far']   // { value: 72, writer: 'cave', layer: 'game', how: 'cave 180 × storm 0.4', also: [{ owner: 'storm', layer: 'effect', op: 'mul', value: 0.4 }] }
   */
  shared: Record<string, import('./gameplay').SharedRow>;
  /**
   * Player (null when there is no player), position in meters; ground is the ground type, groundName its display name
   * (i18n key ground.<type>, null if none)
   */
  player: {
    x: number; y: number; z: number; ground: string; groundName: string | null; inWater: boolean;
    /** The character module's state name as it gives it ('idle', 'walk', 'run', 'jump'...): compare it yourself (state === 'run') */
    state: string | null; [key: string]: any;
  } | null;
  /** Camera: type 'follow' | 'first' | 'fixed' | 'rts', override is the takeover owner's name */
  camera: { type: string | null; /** what the camera in engine.camera is, whether a game or a rig's projection put it there */ projection: 'perspective' | 'orthographic'; orthoSize?: number; x: number; y: number; z: number; focus: { x: number; z: number }; override: string | null; [key: string]: any };
  /** How far counts as nearby (meters) */
  nearbyRadius: number;
  /** Nearby things, sorted by distance (at most 15) */
  nearby: NearbyThing[];
  /**
   * UI: open windows, whether input is locked, the dialogue in progress. windows: open windows and full-screen UI parts (e.g. 'title');
   * parts: each UI part 'default' | 'custom' | 'off'
   */
  ui: {
    windows: string[]; inputLocked: boolean; parts: Record<string, string>; [key: string]: any;
    dialogue: { speaker: string; text: string; choices: string[]; [key: string]: any } | null;
  };
  /** Cutscenes: count is how many are playing, skippable whether they can be skipped */
  cutscene: { count: number; skippable: boolean; [key: string]: any } | null;
  /** Installed modules in install order: name, type, and the capabilities it provides / requires when it has any */
  modules: { name: string; type: ModuleType; provides?: string[]; requires?: string[] }[];
  /** What is plugged in where: plugins/ files, scene.add roots, addPass passes, modules, plain lights (core/engine/plugins.js) */
  slots: { slot: 'scene' | 'post' | 'module' | 'light'; plugged: string; file: string; on: boolean; affects: string[] }[];
  /**
   * engine.add / world things by save tier (counts only) and what will not survive a load: unsaved ('obj#3 (main.js:88, made during play by op x)'),
   * conflicts (two systems managing one object), orphans (saved ids no object has); atCapped when dev stopped taking stacks
   */
  scene: { game: number; code: number; session: number; world: number; engine: number; unsaved: string[]; conflicts: string[]; orphans: string[]; atCapped?: boolean; overrides?: { owner: string; target: string; [field: string]: any }[] };
  /** Which renderer was asked for, which backend draws and why not WebGPU; then what that backend can run: the GPU's name, whether TSL node materials and GLSL
   * (ShaderMaterial, onBeforeCompile) draw, and how renderer.compute() runs ('transform-feedback': no storage textures, atomics or workgroup memory). Null before start() */
  renderer: { requested: 'webgl' | 'webgpu'; backend: 'webgl' | 'webgpu' | 'webgl2' | null; reason: string | null; gpu: string | null; tsl: boolean | null; glsl: boolean | null; compute: 'compute-shaders' | 'transform-feedback' | null };
  /** Performance (fps/cpuMs are null while paused) */
  perf: {
    fps: number | null; cpuMs: number | null; drawCalls: number; triangles: number; pixelRatio: number;
    chunks?: { loaded: number; visible: number; queued: number }; budget?: BudgetReport | null; startup?: StartupReport | null;
    /** cpuMs is the median of the last cpuFrames real-time frames (null while paused, 0 before the first); cpu splits the last frame by phase (null while paused) */
    cpuFrames?: number; cpu?: { fixed: number; frame: number; render: number; afterRender: number } | null;
    /** One line when over the game's own budget, slower than its baseline, spiky or at a lowered resolution; null when all is fine (engine.budget.notice()) */
    notice?: string | null;
    /** Cost of applying background results by stage: transit, build, collider, upload, stream (see engine.budget.cost; upload and transit are approximations) */
    apply?: Record<string, { n: number; totalMs: number; maxMs: number; frameMs: number; bytes: number }>;
    /** Stream registry: registered, built, queued */
    stream?: { entries: number; built: number; queued: number };
    /** Automatic batching: batches, instances, draw calls saved per pass */
    batching?: BatchingStats;
    /** Number of unfinished frame-spread jobs */
    jobs?: number; [key: string]: any };
  /**
   * Weather state: name (label is the display name), rain, snow, fog intensity 0–1, progress is the transition progress 0–1
   */
  weather?: any;
  /** Weather drawing: rainVisible / snowVisible whether raindrops / snowflakes are drawn right now (object names weather-rain / weather-snow), flash 0–1 */
  weatherDraw?: { rainVisible: boolean; snowVisible: boolean; flash: number };
  /**
   * Every value the engine writes on its own (shadow box center, background, camera.far, pixel ratio, camera ...) and who writes it now (writer): 'engine',
   * 'manual:<who>' (engine.autoView.manual(key), or the entry that hands the value to the game) or 'three (engine yielded)' (the game wrote it directly). manual = the takeover call
   */
  owned?: Record<string, { part: string; key: string; writer: string; manual?: string }>;
  /** Content added by other modules */
  [module: string]: any;
}
/** ctx received by a module's describe(e, ctx) hook */
export interface DescribeContext {
  /** The result being generated; you can fill in the standard fields (e.g. ctx.out.time.clock = '18:30') */
  out: GameState;
  /** How far counts as nearby (meters) */
  radius: number;
  /** Center of the search (the player or the focus) */
  center: Vector3;
  /** Report a nearby thing: at is an object or {x, z}; reporting the same at several times merges them, weak = true only fills empty fields */
  near(at: Object3D | { x: number; z: number }, info: { name?: string; kind?: string; [key: string]: any }, weak?: boolean): void;
}

/** engine.skip options: pass to or seconds */
export interface SkipOptions {
  /** Until the calendar clock next reads this time ('HH:MM' or 0-1; needs calendar). The current time itself means a full day */
  to?: string | number;
  /** Calendar seconds to skip (> 0) */
  seconds?: number;
  /** Fade out / in seconds (default 0: no fade, the jump happens before skip returns) */
  fade?: number;
  /** Save slot written after the jump, before the fade in (true = 'auto') */
  save?: string | boolean;
}

/** A loaded lightmap (engine.loadLightmap); describe().render.lightmap is its report */
export interface Lightmap extends Handle {
  /** the map: a plain half-float DataTexture on uv1, set as material.lightMap */
  texture: import('three').DataTexture;
  /** file side length in pixels */
  size: number;
  /** meshes the bake left out, with why (instanced, skinned) */
  skipped: { name: string; why: string }[];
  /** baked meshes not found in the scene, or changed since the bake */
  missing: string[];
  /** takes the map off the meshes and frees it; the unwrapped geometry stays */
  remove(): void;
}
/** A probe file: what ProbeSet.toJSON() returns and engine.loadProbes reads (half: count x 27 half floats, base64; x fastest, then y, then z) */
export interface ProbeData { format: 'threedog-probes'; version: 2; origin: [number, number, number]; step: [number, number, number]; counts: [number, number, number]; half: string }
/** A baked or loaded grid of SH light probes (engine.bakeProbes / loadProbes); describe().render.probes lists the live ones */
export interface ProbeSet extends Handle {
  /** number of probes */
  count: number;
  /** probes per axis [x, y, z] (at least 2 each) */
  counts: [number, number, number];
  /** the actual distance between neighbours per axis (<= spacing, so the probes end on the bounds) */
  step: [number, number, number];
  /** three's probe grid, a plain light in the scene: priority, visible and (WebGPU only: three's WebGL shader ignores it) intensity are yours */
  grid: import('three').Light & { isLightProbeGrid: true; priority: number; texture: import('three').Data3DTexture | null };
  /** the world box the grid lights: the probes plus half a step on every side */
  box: import('three').Box3;
  /** the probes' SH, 27 numbers each (half precision values) */
  sh: Float32Array;
  /** bake time in ms (null for a loaded set) */
  bakeMs: number | null;
  /** 'bake' | 'file' */
  source: string;
  /** the interpolated SH at a position (trilinear; outside the grid the nearest edge), written into target (a SphericalHarmonics3 or a LightProbe's sh) */
  sample(pos: PositionLike, target?: import('three').SphericalHarmonics3 | import('three').LightProbe): import('three').SphericalHarmonics3;
  /** world position of probe i */
  point(i: number, out?: Vector3): Vector3;
  /** plain data for a file: engine.loadProbes(json) makes the same set */
  toJSON(): ProbeData;
  /** takes the grid out of the scene and frees its texture; sample / toJSON still work */
  remove(): void;
}
