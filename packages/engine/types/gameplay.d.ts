// Gameplay modules: timeline, level, triggers, world changes, particles, settings, music, characters/NPCs, interactions, dialogue, inventory,
// quests, photo mode, ambience, debug.
import type { Object3D, Vector3, Vector2, Quaternion, Texture, ColorLike, Vec3Like, Ease, Handle, Range, XZ, Loose, PositionLike, Material } from './common';
import type { Engine, SaveTurn } from './core';
import type { LinkCrossing, NavPathPoint } from './nav';
import type { Input } from './generated/core/input/Input';
import type { Seat } from './generated/core/input/inputSeat';
import type { Animator, AnimatorOptions, Rideable } from './physics';
import type { WorldRecord } from './generated/modules/world/World';

// ======================================================================
// Timeline timeline()
// ======================================================================

/** Promise of a tween: await it to wait for the end, it rejects if a write throws; finish() jumps to the end now, remove() stops at the current position */
export interface TweenPromise extends Promise<boolean> {
  finish(): void;
  remove(): void;
  task: any;
}
/** Tween target: 'dotted.path' -> target value. E.g. { 'position.y': 3, 'material.color': 0xffffff, scale: [2, 2, 2] }; a value can also be () => value */
export type TweenTo = Record<string, number | string | number[] | object | (() => any)>;

/** One end point of a camera move */
export interface CameraPose {
  /** Camera position */
  position?: Vec3Like;
  /** The point to look at, or a moving object */
  lookAt?: Vec3Like | Object3D;
  /** Field of view (degrees) */
  fov?: number;
}
/** Timeline steps (run in order) */
export type TimelineStep =
  | TimelineStep[]
  | ((engine: Engine, run: any) => any)
  | { parallel: TimelineStep[] }
  | { sequence: TimelineStep[] }
  /** Wait some seconds */
  | { wait: number }
  /** Wait for an event; timeout is the maximum seconds to wait */
  | { waitFor: string; timeout?: number }
  /** Run a piece of code (may be async) */
  | { do: (engine: Engine, run: any) => any }
  /** Tween: target is the object, to the target values, duration in seconds */
  | { tween: { target: any; to: TweenTo; duration?: number; ease?: Ease } }
  /** Camera: from/to end points, duration in seconds, fov target field of view; or { release: true } to hand the camera back */
  | { camera: { from?: CameraPose; to?: CameraPose; duration?: number; ease?: Ease; fov?: number; release?: false } | { release: true } }
  /**
   * Move an object (or character, or camera) along a path: points are the path points, duration in seconds, lookAhead how far ahead to look (0–1),
   * ground snaps to the ground (a number = height above ground)
   */
  | { path: { object: any; points: Vec3Like[]; duration?: number; ease?: Ease; lookAhead?: number; ground?: boolean | number; closed?: boolean; curve?: 'catmullrom' | 'centripetal' | 'chordal'; tension?: number; upright?: boolean } }
  /** Full-screen fade: fade is the seconds, to is the target cover (0 transparent ... 1 full black, default 1) */
  | { fade: number; to?: number }
  /** Say a line of dialogue (needs the dialogue module) and wait for the dialogue to end */
  | { say: { speaker?: string; text?: string; nodes?: DialogueScript; node?: string } }
  | null | undefined | false;

export interface TimelinePlayOptions {
  /** Can be skipped, default true */
  skippable?: boolean;
  /** Letterbox bars, default false */
  letterbox?: boolean;
  /**
   * The characters the cutscene drives (their control slot on layer 'cutscene'; keys / walks / NPC behaviours pause and come back after).
   * Default: [engine.player] when there is a player; [] drives nobody (a bubble scene the player walks through). A path step adds its character
   */
  actors?: any[];
}

// Timeline (engine.timeline) is generated from the JSDoc in modules/timeline/Timeline.js (npm run map); only the type is re-exported here
import type { Timeline } from './generated/modules/timeline/Timeline';
export type { Timeline };
/** timeline() takes no options: the basic cancel key skips (the UI focus stack hands it to the topmost cutscene); bind the action 'skip'
 *  (context 'cutscene') for another key, e.g. createEngine({ bindings: { ...presets.bindings.cutsceneSkip } }) */
export interface TimelineOptions {}

// ======================================================================
// Level level()
// ======================================================================

export interface LevelOptions {
  /** glTF path (or asset name); pick one of this and scene */
  url?: string | null;
  /** THREE.Object3D built in code; pick one of this and url */
  scene?: Object3D | null;
  /** Decide yourself which meshes are walkable */
  walkable?: ((mesh: Object3D) => boolean) | null;
  /** 'named' only col_ meshes block the player | 'auto' every tall mesh that is not walkable blocks | false */
  colliders?: 'named' | 'auto' | false;
  /** Heightfield cell size (meters), default 0.5 */
  cellSize?: number;
  /** Ground height outside the level (meters), default 0 */
  outside?: number;
  /** Water surface height (meters), default no water */
  waterLevel?: number;
  /** Expand the collision box outward by this much (meters) @experimental */
  colliderPad?: number;
  /** Minimum height of the collision box (meters) @experimental */
  colliderHeight?: number;
  /** Treat it as a step edge when the height difference between adjacent grid points exceeds this (meters), default 0.6 @experimental */
  sharpEdge?: number;
  /** Hide the marker placeholder meshes, default true @experimental */
  hideMarkers?: boolean;
  /** true: do not take the ground slot; compositeGround({ parts: [{ of: 'level' }] }) does and reads level.ground */
  part?: boolean;
  /** Add the scene to engine.scene, default true @experimental */
  addToScene?: boolean;
}
/** Markers in the level (spawn, npc_*, trigger_*, marker_*), in world coordinates */
export interface LevelMarker { name: string; position: Vector3; quaternion: Quaternion; scale: Vector3; userData: Record<string, any>; object: Object3D }
export interface LevelLoadedEvent { root: Object3D; markers: Record<string, LevelMarker>; spawn: Vector3 }
/** source: the file or asset name; null for a code-built scene */
export interface LevelLoadingEvent { source: string | null }
export interface LevelFailedEvent { source: string | null; error: unknown }
export interface LevelPlayableEvent { root: Object3D }
/** A level left: unload(), or a switch just before the new one commits. source: its file or asset name, null for a code-built one */
export interface LevelUnloadedEvent { source: string | null }

/** engine.level */
export interface Level {
  /** Scene root node */
  root: Object3D | null;
  /** All markers: name -> marker */
  markers: Record<string, LevelMarker>;
  /** Spawn point position */
  spawn: Vector3;
  /** Heightfield (for debugging) @experimental */
  heightfield: any;
  /** The level's state is committed and nothing is loading; level:loaded fires at this moment, level:playable once every module and required nearby build settled too. After unload() it is true with no level, since nothing is loading: root says whether a level stands */
  readonly ready: boolean;
  /** Get a marker, null if none */
  marker(name: string): LevelMarker | null;
  /** Get all markers whose names start with prefix, e.g. markersWith('npc_') */
  markersWith(prefix: string): LevelMarker[];
  /** Unload the level (the scene is fully deleted with engine.remove; collision, ray registrations and things registered with track are removed together) @experimental */
  unload(): void;
  /**
   * Change level (glTF path/asset name, or a THREE object). The new level is built first and replaces the old one only when that worked: level:loaded fires
   * then. On failure the old level stays, level:failed fires and the Promise rejects. When a load changes level, the save system waits for it, and a
   * level that fails rolls the save back. A load overtaken by a newer one or an unload resolves without a level.
   * During a save load it waits for that load to end; a part's load() or an afterLoad passes the turn it got, and it goes at once
   */
  load(urlOrScene: string | Object3D, opts?: { turn?: SaveTurn }): Promise<void>;
  /**
   * Register things that belong to the current level and need not be kept (the { remove() } handles of triggers...); they are deleted automatically on
   * level change / unload; returns the same handle. world data that keeps state (NPCs, pickups, props) needs no registration: with a zone, a level
   * change only tears down the model
   */
  track<T extends { remove(): void }>(handle: T): T;
}

// ======================================================================
// Trigger zones triggers()
// ======================================================================

/** Trigger zone parameters */
export interface TriggerOptions {
  /** Shape: 'cylinder' upright cylinder (default) | 'sphere' | 'box' cuboid */
  shape?: 'cylinder' | 'sphere' | 'box';
  /** Center { x, y, z } / [x, y, z] / Vector3 / object (meters); for box and cylinder y is the bottom height; without y the ground height is used */
  position?: PositionLike;
  /** Sphere/cylinder radius (meters), default 1.5 */
  radius?: number;
  /** Box size [width, height, depth] (meters), default [2, 2, 2] */
  size?: number[];
  /** Cylinder height (meters), default 3 */
  height?: number;
  /** Box rotation around the Y axis (radians) */
  rotation?: number;
  /**
   * Called on entering; who is the position that entered, id the world record id of who it is (engine.actor for the default who, an id given in who,
   * object.userData.id, null for a bare position)
   */
  onEnter?: ((t: Trigger, who: Vector3, id: string | null) => void) | null;
  /** Called on leaving; id = who was inside */
  onExit?: ((t: Trigger, who: Vector3 | null, id: string | null) => void) | null;
  /** Called every fixed step while inside (dt in seconds) */
  onStay?: ((dt: number, t: Trigger, who: Vector3, id: string | null) => void) | null;
  /** Fire on the first enter only (exit follows at once); the zone stays with used = true, and a new playthrough (engine.session) re-arms it */
  once?: boolean;
  /** false pauses detection */
  enabled?: boolean;
  /** Name (carried in events) */
  tag?: string;
  /**
   * Who can trigger it: engine.actor by default; or an actor id, a position, an object (its position is used), or a function returning an array of those
   * (several actors: () => [e.actor, ...e.net.peers.map(p => p.actor)])
   */
  who?: string | Vector3 | Object3D | { x: number; y: number; z: number } | (() => Array<string | Object3D | { x: number; y: number; z: number }>) | null;
  /** Seconds after leaving during which entering does not fire again, default 0 */
  cooldown?: number;
  /** Custom data */
  userData?: Record<string, any>;
  /** 'zone' (default): one enter when the first actor arrives, one exit when the last leaves. 'each': an enter, stay and exit per actor (a door counting entrants); inside is true while anyone is in */
  occupancy?: 'zone' | 'each';
  /** Your own region instead of a shape: the plain volume addWaterBody takes. bounds ({ min, max }) lets the zone be indexed and drawn in the debug view; without it the zone is checked every step */
  volume?: { contains(p: { x: number; y: number; z: number }): boolean; bounds?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } };
}
/** A trigger zone (the return value of add()) */
export interface Trigger {
  shape: 'cylinder' | 'sphere' | 'box';
  /** Position (meters) */
  x: number; y: number; z: number;
  radius: number; height: number; rotation: number;
  tag: string;
  /** Whether the player is inside now */
  inside: boolean;
  /** Can be changed at any time: false pauses detection */
  enabled: boolean;
  once: boolean;
  /** A once zone that already fired this playthrough */
  used: boolean;
  cooldown: number;
  userData: Record<string, any>;
  onEnter: TriggerOptions['onEnter'];
  onExit: TriggerOptions['onExit'];
  onStay: TriggerOptions['onStay'];
  /** Delete this trigger zone */
  remove(): void;
  /** Whether a point is inside */
  contains(p: { x: number; y: number; z: number }): boolean;
}
/** id = world record id of who entered / left (null for a bare position) */
export interface TriggerEvent { tag: string; trigger: Trigger; who: Vector3 | null; id: string | null }
export interface TriggersOptions {
  /** Action name that toggles the debug view 'triggers' (engine.debug.view), default 'triggersDebug' */
  action?: string;
  /** Line color of the debug view 'triggers', default neutral gray */
  debugColor?: ColorLike;
  /** Line opacity of the debug view 'triggers', default 0.8 */
  debugOpacity?: number;
}

/** engine.triggers */
export interface Triggers {
  /** All trigger zones (a new array) */
  list(): Trigger[];
  /** Add a trigger zone */
  add(opts?: TriggerOptions): Trigger;
  /** Delete all (delete a single one with trigger.remove()) */
  clear(): void;
  /** Find by tag */
  byTag(tag: string): Trigger[];
  /** Every trigger_xxx marker in the level becomes a trigger zone with tag xxx; opts is shared by all of them */
  fromMarkers(opts?: TriggerOptions): Trigger[];
}

// ======================================================================
// Particles particles()
// ======================================================================

/** Particle effect parameters (define(), and each entry of particles({ effects, default })). All optional */
export interface ParticleOptions {
  /** Maximum alive at once, default 120 (60 on low-tier devices; a number the game gives stands) */
  max?: number;
  /** Seconds each particle lives [min, max] */
  lifetime?: Range;
  /** Default particles per second for attach */
  rate?: number;
  /** Initial speed (m/s) [min, max] */
  speed?: Range;
  /** Emission direction [x, y, z] */
  direction?: number[];
  /** Maximum angle away from the direction (radians, π = all directions) */
  spread?: number;
  /** Radius of random spread around the spawn point (meters), or a box [x, y, z] */
  area?: number | number[];
  /** Vertical acceleration (m/s², negative falls) */
  gravity?: number;
  /** Air drag (fraction of speed lost per second) */
  drag?: number;
  /** How much wind affects it */
  wind?: number;
  /** Wind direction [x, y, z] */
  windDir?: number[];
  /** Size at birth / at death (meters), or stops over life: evenly spaced [a, b, c] or timed [[0, a], [0.2, b], [1, c]] (0 birth, 1 death) */
  size?: Range | number[][];
  /** Color at birth / at death (one color, or [birth, death]; an array, not a tuple, so a plain JS literal [0xffffff, 0xdddddd] type-checks), or stops over life as for size */
  color?: ColorLike | ColorLike[] | ColorLike[][];
  /** Opacity at birth / at death, 0–1, or stops over life as for size: [[0, 0], [0.1, 0.8], [1, 0]] fades in, then out */
  opacity?: Range | number[][];
  /** Texture (asset name, path or THREE.Texture); a soft round dot if omitted */
  texture?: string | Texture | null;
  /** 'normal' | 'additive' (glowing blend, for sparks) */
  blending?: Loose<'normal' | 'additive'>;
  /** Texture rotation speed (radians/second) */
  spin?: number;
  /** With attach, whether particles stay in the world (true) or the emission direction rotates with the object (false) */
  worldSpace?: boolean;
  /** Affected by fog, default true */
  fog?: boolean;
  /** Largest on-screen size of one particle in pixels (smoke drifting past the camera stays bounded), default 512 */
  maxPixels?: number;
  /** Default particles per meter the emitter moves for attach, on top of rate, spread along the path it moved; default 0 @experimental */
  ratePerMeter?: number;
  /** Meters over which a particle fades where it meets what writes depth; default 0, off. Set at define, not in overrides. On WebGLRenderer it costs one depth-only draw of the scene per render while such an effect is on screen @experimental */
  soft?: number;
}
/** Continuous emitter returned by attach() (a handle) */
export interface ParticleEmitter extends Handle {
  /** Particles per second (can be changed at any time) */
  rate: number;
  /** Particles per meter the object moves, on top of rate (can be changed at any time) @experimental */
  ratePerMeter: number;
  /** false pauses */
  active: boolean;
  /** Stop and remove (also removed automatically when the object leaves the scene) */
  remove(): void;
  [key: string]: any;
}
/** A particle effect */
export interface ParticleEffect {
  name: string; o: ParticleOptions; max: number; alive: number; points: Object3D;
  /** The plain three.js material drawn; set yours and it is drawn as given, null gives the engine's back */
  material: Material | null;
  /** The engine material's { value } objects (uMap, uHasMap, uScale, uMaxPx), written whichever material is drawn; a ShaderMaterial of yours can share them */
  readonly uniforms: Record<string, { value: any }>;
  [key: string]: any;
}
/** particles() options */
export interface ParticlesOptions {
  /** Effect params by name: under what define() gives, and defined on the first emit / attach when define() never ran */
  effects?: Record<string, ParticleOptions>;
  /** Params every effect starts from */
  default?: ParticleOptions;
}

// Particles (engine.particles) is generated from the JSDoc in modules/particles/Particles.js (npm run map); only the type is re-exported here
import type { Particles } from './generated/modules/particles/Particles';

// Swarm swarm()

/** Options of engine.swarm(). See recipes/65-swarm.md */
export interface SwarmOptions {
  /** Unique name: shown in describe(), the key in a save */
  name: string;
  /** Most objects alive at once; all memory is taken up front */
  capacity: number;
  /** Plain three.js geometry, stays the game's to dispose. Leave out with material for a swarm that draws nothing */
  geometry?: import('three').BufferGeometry;
  /** Plain three.js material, stays the game's to dispose */
  material?: import('three').Material;
  /** Number columns beside x, y, z. yaw, pitch, roll (radians, order YXZ) and scale are also drawn by the engine */
  fields?: string[];
  /** Per-object colour: columns r, g, b (linear) and spawn({ color: 0xff8800 }) */
  color?: boolean;
  /** Time channel of the onStep dt (default 'world') */
  channel?: string;
  /** Grid cell for near, in meters: about the usual query radius (default 2) */
  cell?: number;
  /** Keep this swarm in saves; otherwise it is empty after a load or new game */
  save?: boolean;
}
/** The columns of a swarm: d.x[row], d.vx[row]... and d.id[row], the handle of that row */
export type SwarmData = { x: Float32Array; y: Float32Array; z: Float32Array; id: Float64Array } & Record<string, Float32Array | Float64Array>;
/** Runs for each live row every fixed step; returning false removes the object, anything else keeps it */
export type SwarmRowFn = (d: SwarmData, i: number, dt: number) => unknown;
import type { Swarm } from './generated/modules/swarm/Swarm';
export type { Swarm };
/** engine.swarm: call it to make a swarm */
export interface SwarmMaker {
  /** Make a swarm. Returns a Swarm: spawn, free, row, onStep, near, clear, dispose, count, capacity, data, mesh */
  (opts: SwarmOptions): Swarm;
}
export type { Particles };

// ======================================================================
// Settings menu settings()
// ======================================================================

/** Contents of a graphics quality preset. pixelRatio is a share from 0 to 1 of the ratio the engine picked for this device, so one preset fits every screen */
export interface QualityPreset { pixelRatio?: number; shadows?: boolean; antialias?: boolean; bloom?: boolean; ao?: boolean; viewChunks?: number; density?: number; [key: string]: any }
/**
 * The tools a settings tab's render(tools, e, s) receives: escaping, translation and the control helpers (each returns HTML)
 * @example render: (tools, e, s) => tools.row(tools.t('my.subtitles'), tools.toggle('subtitles', s.get('subtitles')))
 */
export interface SettingsTools {
  /** Escape text for HTML */
  esc: (s: any) => string;
  /** Translate a string key */
  t: (key: string, params?: Record<string, any>) => string;
  /** One row: text on the left, control on the right */
  row(label: string, ctl: string): string;
  /** Toggle button for a setting */
  toggle(key: string, on: boolean): string;
  /** Slider for a setting */
  range(key: string, v: number, min: number, max: number, step: number): string;
  /** A group of mutually exclusive buttons: options = [[value, text], ...]; a disabled value is display-only */
  segmented(key: string, cur: any, options: [any, string][], disabled?: any[]): string;
}
/** One settings tab */
export interface SettingsSection {
  /** Title: text or engine => text */
  title: string | ((e: Engine) => string);
  /** Generate the content HTML */
  render: (tools: SettingsTools, e: Engine, s: Settings) => string;
  /** Called after every redraw, to bind events to custom controls */
  bind?: (el: HTMLElement, e: Engine, s: Settings) => void;
  /** When this returns false the tab is not shown */
  when?: (e: Engine) => boolean;
  /** Sort order, smaller first, default 100 */
  order?: number;
}
export interface SettingsOptions {
  /** Action that opens the menu, default the basic 'cancel' (Esc / pad B on an empty UI focus stack); another name is declared and the game binds it */
  action?: string;
  /** Browser storage key */
  storageKey?: string;
  /** Override the graphics presets: { low: {...}, medium: {...}, high: {...} } */
  presets?: Record<string, QualityPreset>;
  /**
   * Tabs: true (default) graphics, audio, controls, language, saves; false none; or a list by name, which may include the optional
   * 'game' (resume, load a save, back to title) and 'camera' (mouse sensitivity, invert Y, field of view; saved as camera.sensitivity / camera.invertY
   * / camera.fov). The entry { id: 'graphics', omit } leaves graphics rows out (quality, pixelRatio, shadows, antialias, bloom, ao, adaptive, viewChunks,
   * density): an omitted row stays the game's value, and no preset or stored value moves it
   * @example settings({ sections: ['game', 'graphics', 'audio', 'controls', 'camera'] })
   * @example settings({ sections: [{ id: 'graphics', omit: ['pixelRatio', 'antialias', 'adaptive'] }, 'audio', 'controls', 'language', 'saves'] })   // a fixed pixel look
   */
  sections?: boolean | (string | { id: 'graphics'; omit: string[] })[];
  /**
   * Pause gameplay while the menu is open (with flow installed it switches to flow's 'paused' and returns to the previous state on close; without flow
   * it uses engine.freeze); the picture keeps running, default false
   */
  freezeWorld?: boolean;
}

/** engine.settings */
export interface Settings {
  /** All current setting values, read only (set() changes one). pixelRatio is the renderer's real ratio */
  readonly values: Record<string, any>;
  /** Graphics presets */
  presets: Record<string, QualityPreset>;
  /** Tabs @experimental */
  sections: Map<string, any>;
  /** Whether the menu is open */
  readonly isOpen: boolean;
  /** Read a setting, e.g. get('vol.music') */
  get(key: string): any;
  /** Change a setting (takes effect immediately + saved) */
  set(key: string, value: any, opts?: { save?: boolean }): void;
  /** Graphics preset: 'low' | 'medium' | 'high' @experimental */
  preset(name: 'low' | 'medium' | 'high' | (string & {})): void;
  /** Game-defined setting: default value + apply function (saved automatically), or { apply, limits }. limits names the shared value(s) the row
   * restricts on the settings layer, like the built-in shadows row: off holds it off (the scene, weather or a cutscene cannot turn it back on),
   * on allows what the scene chose; a number row from 0 to 1 is a factor on a number value. Define it after the effect exists */
  define<T = any>(key: string, def: T, apply?: ((value: T, e: Engine) => void) | { apply?: (value: T, e: Engine) => void; limits?: string | string[] }): this;
  /** Add a tab of your own, or a built-in / optional one by name: addSection('camera') */
  addSection(id: string, section?: SettingsSection): this;
  open(): void;
  close(): void;
  toggle(on?: boolean): void;
  /** Put one setting (or all, with no key) back to its default: the engine's start value, or the default the game gave define(). Keys: resetBindings */
  reset(key?: string): void;
  /** Restore all keys to defaults @experimental */
  resetBindings(): void;
  /** Change the first key of an action to code */
  rebind(action: string, code: string): void;
  /** Key list (for the UI) @experimental */
  actionList(): any[];
  /** Save to the browser */
  save(): void;
}

// ======================================================================
// Music music()
// ======================================================================

/** Track: a path, or { url, volume 0-1, loop, stems }. Stems are extra layers started in sync; each fades in as music.intensity rises through its `at` range */
export type MusicTrack = string | { url?: string; volume?: number; loop?: boolean; stems?: MusicStem[] };
/** A layer of a track: silent below at[0], full at at[1] and above (intensity 0-1) */
export interface MusicStem { url: string; at?: number[]; volume?: number }
/** Auto-selection condition: an object of condition keys ({ state: 'combat', time: 'night', zone: 'cave' }) or (e, music) => boolean */
export type MusicCondition = import('./core').AudioCondition;
/** Auto-selection rule: when the condition holds play track (null = silence), higher priority wins; no `when` = always (a fallback) */
export interface MusicRule { track: string | null; when?: MusicCondition; priority?: number }
export interface MusicChangeEvent { from: string | null; to: string | null }
export interface MusicOptions {
  /** Tracks: name -> path or { url, volume, loop, stems } */
  tracks?: Record<string, MusicTrack>;
  /** Auto track rules (same as engine.music.rules(list)) */
  rules?: MusicRule[];
  /** Default crossfade seconds, default 2 */
  fade?: number;
  /** Duck the music bus during dialogue to this (0-1, e.g. 0.35); default false = no duck (the game opts in) */
  duckDialogue?: number | false;
  /** Fade seconds for the ducking @experimental */
  duckFade?: number;
  /** Rule debounce seconds, default 2 */
  hold?: number;
  /** Rule check interval (seconds), default 1 */
  interval?: number;
}

// Music (engine.music) is generated from the JSDoc in modules/music/Music.js (npm run map); only the type is re-exported here
import type { Music } from './generated/modules/music/Music';
export type { Music };

// ======================================================================
// Characters characters() -> engine.characters, engine.npcs
// ======================================================================

/**
 * A ready procedural body ({ rig }): root is the root node, body/head optional, limbs are the swinging limbs. A model asset carries the same shape
 * by object name in root.userData.rig ({ body: 'hips', head: 'head', joints: ['armL'], limbs: [{ joint: 'legL', ... }] }), as an asset pack's humanoid does
 */
export interface CharacterRig {
  root: Object3D;
  body?: Object3D;
  head?: Object3D;
  /** Named joints, exposed on the character as properties (a humanoid rig: armL armR legL legR) */
  joints?: Record<string, Object3D>;
  limbs?: { joint: Object3D; offset: number; amp: number; kind: 'arm' | 'leg'; side?: number }[];
}
export type CharacterWater = 'swim' | 'block' | 'wade' | ((character: Character, at: { depth: number; x: number; z: number }) => 'swim' | 'block' | 'wade');
/** What the states hook sees: base is the state the mover chose (idle / walk / run / jump / fall / swim); water the water mode it is in (null on land) */
export interface CharacterFacts { base: string; speed: number; grounded: boolean; swimming: boolean; vy: number; water: 'swim' | 'block' | 'wade' | null }
export type CharacterStates = (character: Character, facts: CharacterFacts) => string | null | undefined;
/** Character parameters (shared by the player and NPCs) */
export interface CharacterOptions {
  /** Per-character part colors: recolor the body's meshes marked userData.part (a humanoid rig: body, skin, legs, hair) */
  colors?: { body?: ColorLike; skin?: ColorLike; legs?: ColorLike; hair?: ColorLike };
  /** Walking speed (m/s), default 4.5 */
  speed?: number;
  /** Running speed (m/s), default 7 */
  runSpeed?: number;
  /** Collision radius (meters), default 0.4 */
  radius?: number;
  /**
   * What water deeper than swimDepth does: 'swim' (default: floats, state 'swim') | 'block' (never enters it) | 'wade' (walks the bottom) | a function
   * deciding per spot (a swim skill, a boat, depth). character:water fires on each change
   */
  water?: CharacterWater;
  /**
   * The game's own states on top of the built-in ones (crouch, climb, glide, dash, roll): run after the mover's state each step, return a state name
   * or null to keep facts.base. The state picks the clip like any other (clips: { crouch: 'Crouch' }); speed changes stay engine.mod('move.speed')
   * @example addPlayer({ ..., clips: { crouch: 'Crouch' }, states: (c, f) => f.grounded && engine.input.down('crouch') ? 'crouch' : null })
   */
  states?: CharacterStates | null;
  /** Water depth (meters) at which water counts as deep, default 1 */
  swimDepth?: number;
  /** Swimming speed multiplier, default 0.45 */
  swimSpeed?: number;
  /** How fast it turns, default 10 */
  turnSpeed?: number;
  /** How fast it starts / stops, default 12 */
  acceleration?: number;
  /** Gravity (m/s², negative), default -24 */
  gravity?: number;
  /** Jump speed (m/s), default 8 */
  jumpSpeed?: number;
  /** Step height it can climb directly (meters), default 0.45 */
  stepHeight?: number;
  /** Air control, 0–1 */
  airControl?: number;
  /** How long after walking off an edge a jump is still allowed (seconds) */
  coyoteTime?: number;
  /** Whether it can jump, default true (stuns and cutscenes use engine.mod('move.canJump', { owner, id, set: 0 }) instead of writing it) */
  canJump?: boolean;
  /** Jumps before landing again, default 1; 2 = double jump (jump() again in the air) */
  maxJumps?: number;
  /** Takeoff speed of an air jump (m/s), default jumpSpeed */
  airJumpSpeed?: number;
  /** How long a jump() pressed early waits for the ground (seconds), default 0.12 */
  jumpBuffer?: number;
  /** Falling out of the level: below belowY (or when belowY(character) is true) character:fall fires and the rule 'fall' decides: back to safeGround by default, engine.mod('fall', { owner, id, set: false }) leaves it to the game. false (default) = off */
  fall?: false | { belowY: number | ((character: Character) => boolean) };
  /** Time channel its movement and animation follow when the engine drives it (player default 'player', others 'world') */
  channel?: string;
  /** Collider layers it walks through, e.g. ['gate'] (collision.addBox { layer: 'gate' }): its walking, walkTo and NPC paths, navmesh included, follow it. Default: stopped by every collider */
  passes?: string[];
  /**
   * The body, one path for every kind: the name of a registered model asset, or what engine.assets.model() returned. A procedural builder name
   * (from an asset pack) is built at once; a file model name shows a gray capsule and swaps in a copy when it loads (Character.ready / whenReady,
   * event 'character:model'). Without model and rig: a gray capsule placeholder (warned once)
   * @example engine.assets.manifest(yourAssets); engine.characters.addPlayer({ model: 'yourBody' })   // a generator or GLB name from an asset pack
   * @example engine.characters.addPlayer({ model: 'hero' })   // after engine.assets.manifest({ models: { hero: '/models/hero.glb' } })
   */
  model?: Object3D | string | null;
  /** A ready procedural body (CharacterRig), used instead of model (a hand-built guard / pet) */
  rig?: CharacterRig | null;
  /** Id for engine.mod / time.local entries of a character without a world record (read it back as character.id); the player is 'player', an NPC its record id */
  id?: string;
  /** Action name mapping { idle, walk, run, swim, jump, fall } (shorthand for animation) */
  clips?: { idle?: string; walk?: string; run?: string; swim?: string; jump?: string; fall?: string; drive?: string } | null;
  /** Skeletal animation state machine config (states, blend trees, one-shot actions), see AnimatorOptions */
  animation?: AnimatorOptions | null;
  /** Movement method: 'simple' built into the engine (default) | 'rapier' Rapier character controller (needs the rigid module) | 'manual' the game writes the position, move() only updates grounded / support / safeGround / fall */
  mover?: 'simple' | 'rapier' | 'manual' | ((character: any, engine: any) => { name: string; move(x: number, z: number, run: boolean, dt: number, y: number): void; dispose?(): void; leave?(): void });
  /**
   * Which way it turns each move: 'move' (default, toward its velocity) | 'camera' (along cameraRig.forward()) | 'target' (toward faceTarget) | 'manual'
   * (only face() turns it)
   */
  faceMode?: FaceMode;
  /** What faceMode 'target' faces (lock-on) */
  faceTarget?: PositionLike | null;
}
/** Character facing mode, see CharacterOptions.faceMode */
export type FaceMode = 'move' | 'camera' | 'target' | 'manual';
/** What a player control function returns: world direction (length 0–1 scales the speed), run; null = stand still. Speed changes: engine.mod('move.speed', { owner, id: 'player', ... }) */
export type MoveRequest = { x: number; y?: number; z: number; run?: boolean } | null | undefined;
/**
 * How the player's input steers it (the base holder of its control slot, owner 'player-input'): 'camera' movement keys relative to the camera |
 * a function returning the move request. The game moving the player itself takes control: engine.control.take(player, { owner, layer: 'script', step })
 */
export type PlayerControl = 'camera' | ((player: Character, input: Input, dt: number) => MoveRequest);
/** Parameters of addPlayer() */
export interface PlayerOptions extends CharacterOptions {
  /** A further local player's id and world record; left out, the one player (engine.player) */
  id?: string;
  /** The seat that drives this player (engine.input.seat); default engine.input */
  input?: Seat;
  /** Spawn point (meters, { x, z } / Vector3 / object); flat ground is found automatically if omitted */
  spawn?: PositionLike;
  /**
   * Required, no default: 'camera' (keys relative to the camera) | (player, input, dt) => ({ x, z, run? }) (null stands still). presets.player.*
   * fill it. Given once: a game that steers the player for a while takes control (engine.control.take(player, { owner, layer: 'script', step }))
   */
  control: PlayerControl;
  /** true: the camera module follows the player (and back after a vehicle, and on a new session). Omitted with a camera installed warns in dev */
  cameraFollow?: boolean;
}
/** Character state: the engine's own, or any name the game's `states` hook returns (crouch, climb, sit...) */
export type CharacterState = 'idle' | 'walk' | 'run' | 'swim' | 'jump' | 'fall' | 'drive' | (string & {});

/** Character (player and NPCs) */
export declare class Character {
  constructor(engine: Engine, opts?: CharacterOptions);
  /** Root node, the character's model (there is no character.model; the loaded glTF is a child of root): add it to the scene with engine.add(character.root) when you built the Character yourself; add children, change visible and scale on it */
  root: Object3D;
  /** Position (= root.position) */
  readonly position: Vector3;
  /** Horizontal velocity (x, y map to world x, z). Writable: a write is an impulse the mover steers back toward the input (lasting knockback: push(); full control: mover 'manual') */
  velocity: Vector2;
  /**
   * Heading (radians): 0 faces +Z, forward = (sin facing, cos facing); increasing turns toward +X (rotation about the Y axis, consistent with
   * root.rotation.y)
   */
  facing: number;
  /** Vertical velocity (m/s), kept apart from velocity, which is horizontal only (velocity.y is world z, not this). Writable: setting it is an impulse (launch() does the same and also leaves the ground cleanly) */
  vy: number;
  /** Whether standing on the ground */
  grounded: boolean;
  /** Whether swimming @experimental */
  swimming: boolean;
  /** Current action state */
  state: CharacterState;
  /** Current movement speed (m/s) */
  moveAmount: number;
  /** Facing mode, change at any time; see CharacterOptions.faceMode */
  faceMode: FaceMode;
  /** What faceMode 'target' faces */
  faceTarget: PositionLike | null;
  /** Player only: whether the camera module follows it (see PlayerOptions.cameraFollow) @experimental */
  cameraFollow?: boolean;
  /** Move at a fixed velocity (m/s) for seconds, ignoring move()'s direction and without turning (knockback, dodge roll); gravity and collision still apply */
  push(vx: number, vz: number, seconds: number): void;
  speed: number; runSpeed: number; radius: number; water: CharacterWater; states: CharacterStates | null;
  /** @experimental */ swimDepth: number;
  /** @experimental */ swimSpeedFactor: number;
  /** @experimental */ turnSpeed: number;
  /** @experimental */ acceleration: number; gravity: number; jumpSpeed: number;
  /** @experimental */ stepHeight: number;
  /** @experimental */ airControl: number;
  /** @experimental */ coyoteTime: number; canJump: boolean;
  /** Base jump values (the game's; modifiers go through engine.mod('move.jumpSpeed')) @experimental */
  maxJumps: number;
  /** @experimental */ airJumpSpeed: number | null;
  /** @experimental */ jumpBuffer: number;
  /** Fall check (see CharacterOptions.fall); a plain property @experimental */
  fall: false | { belowY: number | ((character: Character) => boolean) };
  /** Time channel the engine drives it on (see CharacterOptions.channel) */
  channel: string;
  /** Collider layers it goes through (the passes option, sorted); undefined = stopped by every collider. Plain: a write counts from its next step and path */
  passes: readonly string[] | undefined;
  /** The character's id, the one form engine.mod / time.local take: its world record id ('player', an NPC's record id), else the id option, else a generated one */
  readonly id: string;
  /**
   * A movement stat as the mover uses it now: the base field with every engine.mod('move.<name>') entry applied (canJump reads 1 / 0)
   * @example engine.mod('move.speed', { owner: 'haste', id: 'player', mul: 1.2, for: 5 }); player.stat('speed')   // 1.2 x player.speed
   */
  stat(name: 'speed' | 'runSpeed' | 'gravity' | 'jumpSpeed' | 'canJump'): number;
  /** Give back n jumps for this airtime (pickup, wall touch) @experimental */
  addJumps(n?: number): this;
  /** All jumps back, as if it had landed @experimental */
  resetJumps(): this;
  /**
   * Throw it upward at speed m/s (jump pad, spring): leaves the ground, ends coyote time, the ground jump counts as used (air jumps stay); emits character:launch
   * @example player.launch(19, { owner: 'pad' })
   */
  launch(speed: number, opts?: { owner?: string }): this;
  /** Jump state now, read-only @experimental */
  jumpState(): { grounded: boolean; coyoteLeft: number; bufferLeft: number; jumpsUsed: number; jumpsLeft: number; vy: number };
  /** What it stands on, read-only (reused object); 'platform' = a registered support (characters.support), which carries it */
  readonly support: { kind: 'ground' | 'platform' | 'collider' | 'water' | null; object: any; id: string | null; safe: boolean; velocity: { x: number; y: number; z: number } };
  /** Last spot it stood still on safe ground (where a fall returns it); null until it first stands. Saved with the motion */
  safeGround: Vector3 | null;
  /** How it walks now; name is 'simple' | 'rapier' | 'manual', controller is the native Rapier character controller (when rapier). Assign a name to switch: c.mover = 'manual' */
  get mover(): { name: string; controller?: any; body?: any; collider?: any; move(dirX: number, dirZ: number, run: boolean, dt: number, y?: number): void; dispose?(): void; leave?(): void };
  set mover(v: CharacterOptions['mover']);
  /** Skeletal animation state machine (when there is a glTF model; null while a model named by asset is still loading) */
  anim: Animator | null;
  /** false while a model named by asset is loading (the placeholder body shows); true otherwise, also after a failed load (placeholder kept) */
  ready: boolean;
  /**
   * Settles (never rejects) when a model named by asset is swapped in or has failed; already settled otherwise
   * @example const npc = new Character(engine, { model: 'villager' }); engine.add(npc.root);   // import { Character } from 'threedog' await npc.whenReady;
   * npc.playAction('Wave');
   */
  readonly whenReady: Promise<void>;
  /** The vehicle it sits in (null on foot) */
  vehicle: Rideable | null;
  /** Its seat in the vehicle: 0 drives, others ride; null on foot */
  seat: number | null;
  /** Board a vehicle (rigid.addWheeled's, or any object with the vehicle contract): the driver seat when free, else a free passenger seat; no-op when full */
  enter(vehicle: Rideable): void;
  /** Exit the vehicle */
  exit(): void;
  /** Play a one-shot action (e.g. 'wave'); skipped if the model has no such clip */
  playAction(name: string): void;
  /**
   * Run fn(character, dt) every frame right after the animation pose is applied (model clips or procedural rig): attach things to bones or adjust bones. h.remove() stops it. Presentation only.
   * @example const h = player.onPose(() => sword.position.copy(hand.getWorldPosition(v)));
   */
  onPose(fn: (character: Character, dt: number) => void): { remove(): void };
  /**
   * Fully delete this character: exits the vehicle first, releases animation and movement, removes it from the scene and releases geometry and materials
   * (used by npcs.remove / removePlayer)
   */
  dispose(): void;
  /**
   * Request a jump (buffered for jumpBuffer s): the ground jump on the ground or in coyote time, else an air jump while maxJumps allows; air: false = ground only
   * @example addPlayer({ ...presets.player.thirdPerson, maxJumps: 2 })   // double jump
   */
  jump(opts?: { air?: boolean }): this;
  /** Put it on the ground at position (Vector3 / object / [x, y, z] / { x, z }) */
  placeAt(position: PositionLike): this;
  /**
   * After moving root yourself (a cutscene path, a scripted pose): write position and motion back to its world record (the player's), so a save right
   * after has it
   */
  syncRecord(): this;
  /**
   * Walk to a point along characters.findPath on fixed steps; never rejects. One walk per character: a new walkTo, dispose() or a save load ends the old
   * one with 'cancelled'. Transient: not saved, not fast-forwarded by engine.skip. Holds the character's control on layer 'script' (owner 'walkTo'):
   * the player's keys / an NPC's schedule pause meanwhile, a cutscene pauses the walk, and another script owner on it is control-conflict
   */
  walkTo(target: Vector3 | { x: number; z: number } | [number, number, number], opts?: { speed?: number; arrive?: number; turnRate?: number; stuckSeconds?: number; maxRepaths?: number; run?: boolean }): Promise<{ status: 'arrived' | 'noPath' | 'stuck' | 'cancelled' }> & { remove(): void };
  /**
   * Move in a direction (called once per fixed step): dirX/dirZ is the world direction (length 0–1 scales the speed), run to run, dt in seconds (used as
   * given). Speed comes from the stats: engine.mod('move.speed', { owner, id: character.id, ... }) (the player: id 'player'), the one way to change speed.
   * A character someone controls (engine.control.of(ch)) moves only through its holder: called from anywhere else it is control-bypass in dev;
   * take control and use handle.move() / step instead
   */
  move(dirX: number, dirZ: number, run: boolean, dt: number, dirY?: number): void;
  /** Ground type underfoot ('water' while swimming) */
  groundType(): string;
  /** Turn at once to a position, or to an angle in radians (0 = +Z) */
  face(target: PositionLike | number): void;
  /**
   * Copy the motion state into a plain object (velocity, vertical velocity, heading, movement amount, grounded, swimming) to store in world data; after
   * the model is rebuilt or a save is loaded, loadMotion continues from it with identical results
   * @experimental
   */
  saveMotion(out?: CharacterMotion): CharacterMotion;
  /** Restore the motion state from the plain object of saveMotion @experimental */
  loadMotion(m: CharacterMotion | null | undefined): this;
}
/** Result of Character.saveMotion (plain values, can be saved); facing is the same as Character.facing: 0 = +Z, forward (sin f, cos f) */
export interface CharacterMotion { vx?: number; vz?: number; vy?: number; facing?: number; amount?: number; grounded?: boolean; swimming?: boolean;
  /** Jump state (world part version 4; older saves are migrated from the flat coyote field) */
  jump?: { coyote: number; used: number };
  /** safeGround as [x, y, z] */
  safe?: [number, number, number] | null;
  /** id of the support it rides (characters.support), found again on load */
  support?: string | null }

/** One schedule stop (the npcs.add form): at is when to set off, position the destination */
export interface ScheduleStop {
  /** When to set off: clock time 'HH:MM' (e.g. '18:30'), or a time of day 0–1 (0.25 = 6 am) */
  at: number | string;
  /** Destination (Vector3 / object / [x, y, z] / { x, z }) */
  position: PositionLike;
}
/** One schedule stop (as stored in npc.schedule after install): at has been converted to 0–1, x/z is the destination (meters) */
export interface ScheduleEntry { at: number; x: number; z: number }
/** An NPC's interact option: the op the interact key runs near it ({ npc: id, ...args }), its prompt label and reach */
export interface NpcInteract { op: string; args?: Record<string, any>; label?: string | (() => string); radius?: number }
/** Parameters of engine.npcs.add({...}) */
export interface NPCOptions extends CharacterOptions {
  /**
   * Stable id (used by saves, quest targets { npc } and npcs.get); falls back to name if omitted (two NPCs with the same name and no id throw an error).
   * Calling add again with the same id updates the definition and keeps position and state
   */
  id?: string;
  /**
   * NPC authored in content (everything added by content): the initial record of world; saves only record changes such as position and state, the
   * schedule follows the content; deleted ones do not reappear after loading
   */
  initial?: boolean;
  /** Name */
  name?: string;
  /**
   * Which zone it belongs to (a level name, see world.zone): when not in this zone only the model is torn down and the data stays; null (default) means
   * it is present everywhere
   */
  zone?: string | null;
  /** Schedule (needs the sky module; without it the first entry is always used) */
  schedule?: ScheduleStop[];
  /** Behavior name: 'schedule' (default, follows the schedule), 'wander' (roams around home) or a name registered with npcs.behavior() */
  behavior?: string;
  /**
   * Behavior parameters and memory (plain values, saved). wander: { radius in meters (8), pause [min, max] seconds ([2, 6]), home { x, z } (defaults to
   * the position when wandering started) }
   */
  mind?: Record<string, any>;
  /**
   * What the interact key does near it (needs interactions()): runs the op with { npc: id, ...args }. Dialogue is one such op: { op: 'npc.talk' }
   * (script defaults to the NPC id; args: { script } names another, { channel: 'bubble' } plays it as lines over the NPC while play goes on). label: prompt text (a string is saved, a function stays in memory only);
   * radius meters, default 3.2
   * @example interact: { op: 'npc.talk' }
   * @example interact: { label: 'Trade', op: 'shop.open', args: { shelf: 'tools' } }
   */
  interact?: NpcInteract | null;
  /** Pathfinding grid size (meters), default 2 */
  pathStep?: number;
  /** Seconds before re-pathfinding after getting stuck, default 2 */
  repath?: number;
  /**
   * Arrival distance (meters), default 1.2: within 1.2 m of the schedule stop / target counts as arrived and stops, it does not step exactly on the
   * point (call placeAt yourself for an exact spot)
   */
  arriveDistance?: number;
  /** Initial position (Vector3 / object / [x, y, z] / { x, z }); the current schedule stop is used if omitted */
  position?: PositionLike;
}
/**
 * NPC handle (returned by npcs.add): the truth of an NPC is one record of kind 'npc' in engine.world; the model (Character) exists only when nearby.
 * The handle finds the record and the current model by id, so it keeps working after the model is torn down or a load replaces the data.
 */
export declare class NPC {
  /** Stable id */
  readonly id: string;
  /** The record in world (a plain object; undefined after deletion). Change fields with engine.world.set(npc.id, {...}) */
  readonly data: WorldRecord | undefined;
  readonly name: string | undefined;
  /** Schedule (at converted to 0–1, sorted by time) */
  readonly schedule: ScheduleEntry[];
  /** Current behavior name */
  readonly behavior: string;
  /** What the interact key does near it ({ label, op, args, radius } as saved), null when nothing */
  readonly interact: { label: string | null; op: string; args: Record<string, any>; radius: number } | null;
  /** Animation state ('idle' / 'walk'...) */
  readonly state: string;
  /** In dialogue (stopped, not walking) */
  readonly busy: boolean;
  /** The current character model: exists only when nearby; null when far away, in another level, or not yet built */
  readonly character: Character | null;
  /** Root object of the current model (= character.root), null when there is no model */
  readonly root: Object3D | null;
  /** Same as root */
  readonly object: Object3D | null;
  /** Position: the model's position when there is a model (use it read-only, move with placeAt), a copy of the record's position when there is none */
  readonly position: Vector3;
  /**
   * Change behavior (stored in the data, restored by saves). mind is the new behavior's parameters / memory (plain values), cleared if omitted. E.g.
   * npc.setBehavior('wander', { radius: 12 })
   */
  setBehavior(name: string, mind?: Record<string, any>): this;
  /** The stop it should be heading to now */
  currentStop(): ScheduleEntry | null;
  /** Teleport to the ground at a position (handed to the mover when there is a model, otherwise the data is changed) and re-pathfind */
  placeAt(position: PositionLike): this;
  /** Face a position (when there is a model) */
  face(position: PositionLike): this;
  /** Delete this NPC (data and model together) */
  remove(): boolean;
}
/** engine.npcs (NPC data lives in engine.world, kind 'npc'; needs the world module) */
export interface NPCManager {
  /** All NPCs (including far ones and ones in other levels) */
  list(): NPC[];
  /** Add an NPC, returns a handle */
  add(opts: NPCOptions): NPC;
  /**
   * Delete an NPC (pass a handle, id or name): the data is deleted, and the model and dialogue interaction are torn down together. Returns false if not
   * found
   */
  remove(npc: NPC | string): boolean;
  /**
   * Register an NPC behavior: near(rec, dt, npc) once per fixed step when nearby, far(rec, dt) simulated from the data when far (dt is accumulated
   * seconds); selected through behavior in the data
   */
  behavior(name: string, impl: { near?: (rec: WorldRecord, dt: number, npc: NPC) => void; far?: (rec: WorldRecord, dt: number) => void }): this;
  /**
   * Near tiers for large crowds, off by default (every near NPC walks every fixed step). With tiers, NPCs within fullRadius m of the focus walk every
   * step; the rest of the near zone takes a turn once every nearEvery seconds with the accumulated dt (deterministic, save-safe). On screen such NPCs
   * move in visible jumps, so only turn this on for crowds of hundreds. tiers(null) turns it off.
   * @example engine.npcs.tiers({ fullRadius: 30, nearEvery: 4 / 60 })
   */
  tiers(opts: { fullRadius: number; nearEvery: number } | null): this;
  /**
   * Nearby NPCs avoid each other (on by default): pushed apart to no less than the sum of their radii, the player counts as an obstacle (NPCs yield to
   * the player), then constrained back to walkable places by engine.collision; deterministic and cheap, with identical results after loading.
   * With nav({ crowd: true }) crowd takes over. Far NPCs (no model) do not avoid one by one. on / radius / strength are the current values.
   * @example engine.npcs.avoid.set({ radius: 0.6, strength: 2 });   // set(false) turns it off
   */
  readonly avoid: {
    on: boolean;
    /** Avoidance radius of each NPC (meters), null = engine.movement.radius */
    radius: number | null;
    /** Maximum push-apart speed (m/s), default 3 */
    strength: number;
    set(opts: boolean | { on?: boolean; radius?: number | null; strength?: number }): NPCManager['avoid'];
    /**
     * For custom behaviors: call once after character.move and before writing back to the data, to push this NPC away from neighbors and the player
     * (built-in behaviors already call it)
     */
    push(rec: WorldRecord, character: Character, dt: number): void;
  };
  /** Find by id or name (id first) */
  get(idOrName: string): NPC | undefined;
  /** The current character model of an NPC, null if none */
  character(id: string): Character | null;
}
/** engine.characters */
export interface CharactersApi {
  /**
   * The three.js material of every placeholder capsule. Set it to swap the look of all of them at once; used as given, with no patches added. A character
   * with colors.body draws with a copy of it in that color. A model's own materials are the model's.
   * @example engine.characters.material = new THREE.MeshToonMaterial({ color: 0xd9a066 });
   */
  material: Material;
  /**
   * Find a spawn point: searches outward from position (default origin) for walkable (not steep, no obstacle), non-water ground, without assuming
   * terrain height; e.g. findSpawn(v, { minH: 3, maxH: 20 }). Returns a Vector3 (y is the ground height)
   */
  findSpawn(position?: PositionLike, opts?: FindSpawnOptions): Vector3;
  /**
   * Create the player and set engine.player; control is required (no default feel), e.g. addPlayer({ ...presets.player.thirdPerson, spawn }). An
   * existing player is deleted first
   */
  addPlayer(opts: PlayerOptions): Character;
  /**
   * The 'camera' player control as a value: keys / stick relative to the camera, the 'run' action if bound, input.autopilot. Reused object; call it
   * inside your own control function to wrap it
   */
  moveInput(seat?: Seat): { x: number; z: number; run: boolean };
  /** Join the vehicles a saved rider can be seated in again, before or after the load */
  addVehicle(vehicle: any): { remove(): void };
  /**
   * Something characters stand on and ride (moving platform, lift, raft). Move the object any way (onFixed before or after the player, a timeline,
   * physics): riders follow how its matrix changed, so the order does not matter. safe: false = never a respawn spot; carry 'position+yaw' turns riders
   * with it; inherit: false = jumping off keeps none of its speed. With mover 'rapier' give it a collider too.
   * @example const lift = engine.characters.support(liftMesh); engine.onFixed(() => { liftMesh.position.y = 2 + Math.sin(engine.time.now('real')); });
   */
  support(object: any, opts?: { id?: string; safe?: boolean; carry?: 'position' | 'position+yaw'; inherit?: boolean }): { id: string; remove(): void };
  /**
   * Delete the current player (exits the vehicle first, stops responding to keys, fully deletes the model). The player save (key player) carries the
   * position and the vehicle; loading an on-foot save exits the vehicle first
   * @experimental
   */
  removePlayer(id?: string): void;
  /**
   * Pathfinding (the single entry point): uses the navmesh when nav is installed and ready, otherwise the A* fallback. Returns a path [{ x, y, z }...], or
   * null if unreachable
   */
  findPath(from: PositionLike, to: PositionLike, opts?: FindPathOptions & { detailed?: false }): NavPathPoint[] | null;
  /**
   * Pass detailed: true: returns { status, path }, distinguishing 'ok' found | 'noPath' unreachable | 'notReady' nav is installed but the mesh is not
   * built yet (path is the A* fallback result and may be inaccurate)
   */
  findPath(from: PositionLike, to: PositionLike, opts: FindPathOptions & { detailed: true }): PathResult;
  /** What a game's mover calls to take part in contact, each optional (recipe 57): a mover calling none owns contact itself */
  kit: { beginMove(c: any): boolean; groundAt(c: any, x: number, z: number, y?: number): number; endMove(c: any, dt: number, hit: any, ground?: string): void; ownState(c: any, base: string, speed: number): void };
  /**
   * findPath for many callers (NPC crowds, AI squads): solved in engine.threads workers; done(path, status) runs on a fixed step a few steps later (same
   * paths with threads on or off). Recipe 12 section 4
   */
  findPathAsync(
    from: PositionLike, to: PositionLike, done: (path: NavPathPoint[] | null, status: 'ok' | 'noPath' | 'notReady') => void,
    opts?: { radius?: number; passes?: string[]; step?: number; maxNodes?: number }
  ): { remove(): void };
  /** How many findPathAsync requests leave per fixed step (default 32); the rest wait for the next steps */
  pathsPerStep: number;
  /**
   * Bends a link crossing away from its straight line: t 0-1, called each step after position is set on the line, write to position. Depends only on its arguments, so a
   * crossing saved halfway resumes on the same curve. null = the straight line @experimental
   */
  linkPose: ((t: number, position: Vector3, crossing: LinkCrossing, character: Character) => void) | null;
}
/** Return value of findPath(..., { detailed: true }) */
export interface PathResult { status: 'ok' | 'noPath' | 'notReady'; path: NavPathPoint[] | null }
/**
 * Parameters of findSpawn(): minH/maxH height range (meters, default unlimited), maxSlope maximum slope (default 0.3), waterMargin minimum meters above
 * the water (default 0.5)
 */
export interface FindSpawnOptions { minH?: number; maxH?: number; maxSlope?: number; waterMargin?: number }
export interface CharactersOptions {
  /** Whether to enable NPCs (engine.npcs), default true */
  npcs?: boolean;
  /** Near tiers for large NPC crowds, off by default (every near NPC walks every fixed step); same as engine.npcs.tiers(opts) @experimental */
  npcTiers?: { fullRadius: number; nearEvery: number };
  /** The rule 'fall' for everyone: 'rescue' brings what falls out of the world back; left out, the engine rescues nothing. engine.mod('fall', ...) from the game sits above it */
  fall?: 'rescue' | false | ((facts: any, engine: any) => 'rescue' | false);
  /** What every character's Animator starts from, e.g. { fade: 0.15 }; a model's manifest mapping and the character's own animation win over it */
  animation?: AnimatorOptions;
}
/**
 * Pathfinding options: step is the grid size (meters, A*), maxNodes the maximum cells searched (A*), radius the character radius (meters,
 * default engine.movement.radius), passes the collider layers the path goes through (collision.addBox { layer }); for detailed see findPath
 */
export interface FindPathOptions { step?: number; maxNodes?: number; radius?: number; passes?: string[]; detailed?: boolean; id?: string }

// ======================================================================
// Interactions interactions()
// ======================================================================

/** One live interaction, as interactions.get(id) and interactions.items give it */
export interface Interaction {
  id: string;
  /** What it follows; a fixed position is an empty Object3D placed there */
  object: Object3D;
  label: string | ((object: Object3D, ctx: { actor: string }) => string);
  radius: number;
  action: string;
  onUse?: (object: Object3D, ctx: { actor: string }) => any;
  enabled: (object: Object3D, ctx: { actor: string }) => boolean;
  height?: number;
  hold: number;
  approach: boolean;
  once: boolean;
  counter?: string;
}
/** inventory.add: what went in, or why nothing did */
export interface ItemAddResult {
  ok: boolean;
  /** The entry they went into ('arrow', 'sword#3'); set when ok */
  key?: string;
  /** How many fit (a partial fit places what fits); set when ok */
  added?: number;
  /** 'full' when none fit */
  code?: 'full';
  facts?: { id: string; n: number };
  nextActions?: any[];
}
export interface InteractionOptions {
  /** Stable id for the op interaction.use { id } (default: the world record id it was built for, else a running number) */
  id?: string;
  /** Prompt text, or a function (object, { actor }) returning text; actor = world record id of who looks at it */
  label?: string | ((object: Object3D, ctx: { actor: string }) => string);
  /** How close the actor must be (meters), measured from the object's origin in 3D, not its edge, so a large object (a boat, a house) needs a larger radius or a small marker object at the spot to use. Default interactions({ radius }) = 2.5 */
  radius?: number;
  /** Key action name, default 'interact' (E key). Give one object a second verb by adding another interaction with another action */
  action?: string;
  /**
   * Called when used, with who uses it (ctx.actor of interaction.use: the local user, a net peer, an NPC). Its return value is the op's value; { ok: false,
   * code } fails the op with that code
   */
  onUse?: (object: Object3D, ctx: { actor: string }) => any;
  /**
   * When this returns false the whole prompt disappears (to show a state such as "growing", don't use enabled: have the label function return different
   * text by state and decide in onUse whether it can be used)
   */
  enabled?: (object: Object3D, ctx: { actor: string }) => boolean;
  /** How high the prompt floats above the object (meters) */
  height?: number;
  /**
   * Seconds the key must stay down before onUse runs (0 = a press). The engine counts it and interrupts it on release, leaving reach, enabled() false or
   * locked input (interaction:hold / interaction:interrupt); the prompt gets progress 0-1. The op interaction.use itself is the completed use
   */
  hold?: number;
  /** Walk the player there first (walkTo, stops 1.2 m away), then use it; with radius: Infinity it can be used from anywhere (point-and-click) */
  approach?: boolean;
  /** Hide the object after a use and allow no second one (onUse returning { ok: false } leaves it). Saved under id, else the object's name; development throws when it has neither */
  once?: boolean;
  /** Name of a HUD counter each use adds 1 to (hud.bump; nothing without hud()). Saved; read the total with hud.value(name) */
  counter?: string;
}
/** engine.interactions */
export interface Interactions {
  /** How high the prompt floats (meters) @experimental */
  promptHeight: number;
  /** All interactions in the order added (a fresh array each read; get(id) finds one without it) */
  readonly items: Interaction[];
  /** Default reach of add() in meters (2.5) */
  radius: number;
  /** How the one in front of the actor is chosen; can be changed at runtime */
  pickMode: InteractionPick;
  /** The interaction the prompt shows right now (null if none) */
  current: any;
  /** One best interaction per key action this frame, for a prompt that lists several keys */
  options: { action: string; id: string; label: string }[];
  /** The hold in progress (progress 0-1), null when none */
  holding: { id: string; action: string; seconds: number; progress: number } | null;
  /**
   * Add an interaction: passing an object makes it follow the object, passing a position (Vector3 / [x, y, z] / { x, y, z }) makes a fixed point.
   * Returns a handle { remove() }
   */
  add(target: Object3D | PositionLike, opts?: InteractionOptions): Handle;
  /** The interaction with this id, or undefined. Using one is the op: engine.ops.run('interaction.use', { id }) (no id = the one the actor would pick) */
  get(id: string): Interaction | undefined;
}
/**
 * What the 'prompt' UI part receives in update(view) every frame while an interaction is in reach (hide() when none). Call use() on click: it runs the
 * op interaction.use.
 * @example engine.ui.set('prompt', (engine) => ({ update: (v) => myLabel.set(v.x, v.y, v.label, v.key), hide: () => myLabel.hide() }))
 */
export interface PromptView {
  /** Interaction id */
  id: string;
  /** Action that uses it ('interact') and its key label ('E'; 'No key' when the action needs one and has none, '' when it has none on purpose) */
  action: string;
  key: string;
  /** The interaction's label, and the default text 'E · label' ('label' alone with an empty key) */
  label: string;
  text: string;
  /** Screen pixels above the target */
  x: number;
  y: number;
  onScreen: boolean;
  /** Use it (the op interaction.use) */
  use(): void;
  /** One best interaction per action this frame, for a prompt that lists several keys ("E · Open  F · Lock") */
  options: { action: string; id: string; label: string }[];
  /** A hold interaction: how far the hold is (0-1, 0 before it starts); null for a plain press */
  progress: number | null;
}
/** A candidate handed to a pick function: an enabled interaction within its radius of the actor */
export interface InteractionCandidate { id: string; object: Object3D; action: string; label: string | (() => string); distance: number }
/**
 * 'nearest' | 'facing' (within 60° of where the actor faces) | 'aim' (closest to the screen-center ray) | a function choosing one candidate (nearest
 * first) or null
 */
export type InteractionPick = 'nearest' | 'facing' | 'aim'
  | ((candidates: InteractionCandidate[], ctx: { engine: Engine; actor: string; position: Vector3; action?: string }) => InteractionCandidate | null | undefined);
export interface InteractionsOptions {
  /** Default action name, default 'interact' */
  action?: string;
  /** How high the prompt floats (meters) */
  promptHeight?: number;
  /** Default reach of add() in meters, default 2.5 */
  radius?: number;
  /**
   * Required, no default: how the interaction in front of the actor is chosen. presets.interactions.* fill it. @example interactions({ pick: 'aim',
   * keys: ['KeyE'], radius: 2 }) // first person
   */
  pick: InteractionPick;
}

// ======================================================================
// Dialogue dialogue()
// ======================================================================

/** Story state: flags are story flags (this is engine.vars.flags, autosaved) */
export interface DialogueState { flags: Record<string, any>; [key: string]: any }
/** Dialogue choice */
export interface DialogueChoice {
  /** Choice text */
  text: string | ((state: DialogueState, engine: Engine) => string);
  /** Which node to go to after choosing (omit = end) */
  next?: string;
  /** Condition: when it returns false this choice is not shown */
  if?: (state: DialogueState, engine: Engine) => boolean;
  /** Run after choosing */
  do?: (state: DialogueState, engine: Engine) => void;
  /** The game's own fields (icon, tone...): handed to the UI part as choices[i].data. Other unknown keys are reported as typos */
  data?: Record<string, any>;
}
/** Dialogue node */
export interface DialogueNode {
  /** Line of dialogue, or a function returning one */
  text: string | ((state: DialogueState, engine: Engine) => string);
  /** Change the speaker (the script name by default) */
  speaker?: string;
  /** Next node (omit = end; 'end' also means end) */
  next?: string;
  /** Choices (next has no effect when there are choices) */
  choices?: DialogueChoice[];
  /** Run when this line is shown (change story flags, give items...) */
  do?: (state: DialogueState, engine: Engine) => void;
  /**
   * The game's own fields (portrait, mood, voice clip, camera shot...): handed to the 'dialogue' UI part and the 'dialogue:line' event.
   * Other unknown keys are reported as typos, so a misspelled next does not silently end the dialogue.
   * @example { text: 'Hm.', data: { portrait: 'fisher', mood: 'tired', voice: 'fisher_03.mp3' } }
   */
  data?: Record<string, any>;
}
/** Dialogue script: node name -> node, starting from 'start' */
export type DialogueScript = Record<string, DialogueNode>;
/** Promise returned by say(): id is the temporary script name of a main-channel line (null for a plain bubble line); remove() ends the line now (it resolves) */
export interface SayPromise extends Promise<void> { id: string | null; remove(): void }
/** Which dialogue channel: 'main' the conversation the player reads (locks input, choices) · 'bubble' lines over their speakers while play goes on */
export type DialogueChannel = 'main' | 'bubble';
/**
 * Where a bubble line sits: an Object3D (it follows it), a position, an actor / world record id (engine.actorPosition), or null = a screen line (radio, intercom)
 */
export type BubbleAt = Object3D | PositionLike | string | null;
/** Bubble-channel options: seconds on screen (default holdSeconds + about 15 characters a second); queue false = replace this speaker's current line */
export interface BubbleOptions { at?: BubbleAt; seconds?: number; queue?: boolean }
/** What the 'dialogue.bubble' UI part (one per speaker) receives in update(view) every frame while its line shows */
export interface BubbleView { speaker: string; text: string; x: number; y: number; onScreen: boolean; screen: boolean }

/** engine.dialogue */
export interface Dialogue {
  /** Story state: state.flags is engine.vars.flags (autosaved) */
  readonly state: DialogueState;
  /** All scripts @experimental */
  scripts: Map<string, DialogueScript>;
  /**
   * The dialogue in progress (null when none). speaker: the script name; node: the current node OBJECT (its fields: text, choices, data...);
   * id: that node's id string ('start', 'ask'); both are set once the first line shows. Read-only: drive it with start / end / the dialogue ops.
   * @example const atAsk = engine.dialogue.active?.id === 'ask';   // the node id; active.node.data holds the node's own fields
   */
  readonly active: { speaker: string; nodes: DialogueScript; node?: DialogueNode; id?: string; onEnd: (() => void) | null } | null;
  /** The script the main dialogue is playing @experimental */
  readonly speaking: string | null;
  /** Typing speed (characters/second) @experimental */
  charsPerSecond: number;
  /** Define a dialogue (the name is usually the speaker) */
  define(speaker: string, nodes: DialogueScript): void;
  /**
   * Start a dialogue: from node nodeId (default 'start'), onEnd is called when it ends.
   * Main channel (default): locks game input and takes Esc; its choices take the UI choice cursor. onCancel: what the back key (Esc) does while it is on
   * top of the UI focus stack (default: nothing). channel: 'bubble' plays the script as bubble lines over at (no lock, no choices; a running
   * conversation is untouched). Ending the playthrough (engine.session newGame / load / quit) closes it without calling onEnd.
   * @example engine.dialogue.start('guard', 'start', null, { channel: 'bubble', at: guard.root })
   */
  start(speaker: string, nodeId?: string, onEnd?: (() => void) | null, opts?: { channel?: DialogueChannel; at?: BubbleAt; onCancel?: (() => void) | null }): void;
  /**
   * Say a one-off line (no need to define first); the Promise resolves when it is done. channel: 'bubble' = over at while the player keeps playing
   * (barks, shop chatter, radio); several speakers at once, queued per speaker.
   * When the playthrough ends (engine.session) the line is dropped and the Promise never resolves, so code awaiting it does not run in the next playthrough.
   * @example await engine.dialogue.say('Reloading!', { speaker: 'Mira', channel: 'bubble', at: mira.root })
   */
  say(text: string | DialogueScript, opts?: { speaker?: string; node?: string; channel?: DialogueChannel; onCancel?: (() => void) | null } & BubbleOptions): SayPromise;
  /** Lines on the bubble channel now */
  bubbles(): { speaker: string; text: string; queued: number; run?: number; choices?: string[] }[];
  /** End the main dialogue */
  end(): void;
  // Advancing and choosing are ops: engine.ops.run('dialogue.advance') / engine.ops.run('dialogue.choose', { index })
  // (0-based; while typing it completes the line first)
}
export interface DialogueOptions {
  /** Typing speed (characters/second, game time: advanced by engine.step), default 40 */
  charsPerSecond?: number;
  /** Actions that advance the dialogue, default ['confirm'] (a basic key); e.g. ['confirm', 'interact'] to also advance on the game's interact key.
   *  Choices: the cursor, clicks, and the actions choice1..choice9 (context 'dialog', no keys of their own: presets.bindings.dialogNumbers binds 1-9) */
  advanceActions?: string[];
  /** A bubble line stays this many seconds plus its reading time (about 15 characters a second) unless say() gives seconds, default 2 */
  holdSeconds?: number;
  /** A bubble script reaching a node with choices: 'end' (default: warn, the script ends there) or 'ask' (the line stays with its choices until engine.ops.run('dialogue.choose', { index, run }); run is in dialogue.bubbles()) */
  bubbleChoice?: 'end' | 'ask';
}
/**
 * What the 'dialogue' UI part receives in update(view) (show() comes first, hide() when the dialogue ends). Call advance() / choose(i) from your UI:
 * they run the ops dialogue.advance / dialogue.choose, so keys, clicks and tests stay one path.
 * @example
 * engine.ui.set('dialogue', (engine) => {
 *   const el = document.createElement('div'); engine.uiRoot.appendChild(el); el.hidden = true;
 *   el.onclick = () => view?.advance();
 *   let view = null;
 *   return {
 *     show: () => { el.hidden = false; },
 *     update: (v) => { view = v; el.textContent = `${v.speaker}: ${v.text}`; },   // v.data.portrait, v.choices[i].text ...
 *     hide: () => { el.hidden = true; },
 *     dispose: () => el.remove(),
 *   };
 * });
 */
export interface DialogueView {
  /** Script name (dialogue.define name) */
  script: string;
  /** Node id */
  node: string;
  /** Who speaks this line */
  speaker: string;
  /** The part typed so far (the whole line once typing ends) */
  text: string;
  /** The whole line */
  full: string;
  /** Still typing (charsPerSecond) */
  typing: boolean;
  /** Visible choices once typing ends (empty while typing or without choices); key is the key label ('1') or null */
  choices: { text: string; key: string | null; data: Record<string, any> }[];
  /** "E to continue" text when the line waits for the player, else '' */
  hint: string;
  /** The node's data (the game's own fields), {} when none */
  data: Record<string, any>;
  /** The choice under the UI choice cursor (menu keys / d-pad / stick; confirm picks it), -1 when no choices show */
  selected: number;
  /** Run the op dialogue.advance (finish typing / next line) */
  advance(): any;
  /** Run the op dialogue.choose { index } (0-based among choices) */
  choose(index: number): any;
}

// ======================================================================
// Inventory inventory()
// ======================================================================

/** Item definition */
export interface ItemDef {
  /** Display name */
  name?: string;
  /** Icon (text or emoji) */
  icon?: string;
  /** Icon image path */
  iconUrl?: string;
  /** Description */
  desc?: string;
  /** Pieces per slot, default 99 (an entry of 150 uses 2 slots); 1 = every piece with data is its own entry */
  stack?: number;
  /** Weight of one piece, counted against a container's maxWeight (default 0) */
  weight?: number;
  /** Makes the item usable with the inventory.use op */
  use?: (e: any, info: ItemUseEvent) => void;
  /** Whether it can be used now: true or a reason string (checked by the op's can) */
  canUse?: (e: any, info: ItemUseEvent) => true | string;
  /** inventory.use removes one piece before calling use */
  consume?: boolean;
  /** Color of the pickup on the ground */
  color?: ColorLike;
  /** Shape on the ground: a model name from an asset pack (file or generator; default: a model named 'pickup:<item id>', else 'pickup', else a gray box) */
  model?: string;
  [key: string]: any;
}
/**
 * Every container emits item:add / item:remove. container = which container changed (an actor's bag has the actor's id; the local one is engine.actor),
 * actor = who did it (the running op's actor, else engine.actor), id = item id, key = entry key ('arrow', or 'sword#3' for a piece with data),
 * count = change, total = how many of the item that container holds now
 */
export interface ItemEvent { container: string; actor: string; id: string; key: string; count: number; total: number }
/** inventory.use: who used which entry (data = that piece's data) */
export interface ItemUseEvent { actor: string; item: string; key: string; data?: Record<string, any> }
/** One entry of a container: plain items share one entry per kind (key = item id); items with data have their own key ('sword#3') */
export interface ItemEntry { key: string; id: string; count: number; data?: Readonly<Record<string, any>>; def: ItemDef }
export interface PickupEvent { pickup: string; item: string | null; count: number; actor: string; x: number; z: number }
/** What a give function gets: who takes it (world record id) and the pickup record */
export interface PickupGiveContext { actor: string; pickup: WorldRecord }
/**
 * Handle returned by pickups.spawn(): id is the world record id, object is the current model (null when far away);
 * remove() deletes the pickup (data and model; a model passed in through opts.mesh is only taken off)
 */
export interface PickupHandle extends Handle {
  /** The pickup's world record id (engine.world.get(id)), not the item id (0.2 meaning; the item is `give` when it is a string) */
  id: string; give: string | ((e: Engine, ctx: PickupGiveContext) => any); readonly object: Object3D | null }
/** Parameters of pickups.spawn() */
export interface PickupOptions {
  /**
   * What taking it does: an item id goes into the picker's container (inventory.of(actor); needs inventory()); a function (e, { actor, pickup }) => result is an
   * instant effect (no inventory needed; not saved data, so spawn it again on load). Returning { ok: false, code } leaves it on the ground
   */
  give: string | ((e: Engine, ctx: PickupGiveContext) => any);
  /**
   * Stable id of this record in world (saves recognize it by this); numbered automatically pickup#1... if omitted, and an existing record with the same
   * id is reused
   */
  id?: string;
  /** How many you get when picking up, default 1 */
  count?: number;
  /** The piece's own data (a dropped sword keeps its durability) */
  data?: Record<string, any>;
  /** Name in the prompt ("Pick up {name}"), default the item's name */
  name?: string;
  /** Shape on the ground: a model name from an asset pack (default the item's model, else 'pickup:<item>', else 'pickup', else a gray box) */
  model?: string;
  /** Color of the gray placeholder / a geometry-only model (default the item's color, else pickups({ color })) */
  color?: ColorLike;
  /** Reach in meters, default pickups({ radius }) (2) */
  radius?: number;
  /** Taken by walking into it (no key press, no prompt), by every actor in pickups.takers */
  auto?: boolean;
  /** The game's own three.js object for this one pickup (only detached when it goes; otherwise the model name decides the shape) */
  mesh?: Object3D | null;
  /** Calendar seconds until it reappears, 0 = never reappears */
  respawnSeconds?: number;
  /** Bob up and down and rotate, default true */
  bob?: boolean;
  /**
   * Pickup authored in content (needs an id): the initial record of world; saves record only being picked up / waiting to respawn, with identical
   * results whether the load comes before or after this spawn
   */
  initial?: boolean;
  /** Which zone it belongs to (a level name, see world.zone): the data stays across level changes (a picked-up one stays picked up) */
  zone?: string | null;
}
/** engine.pickups: things on the ground that give whoever takes them an item or an instant effect (op pickup.take, net: 'peer') */
export interface Pickups {
  /** Reach of pickups that do not set their own (meters) */
  radius: number;
  /** Who walks into auto pickups: default engine.actor plus net peers on a host, none on a client */
  takers: (e: Engine) => string[];
  /**
   * The three.js material of every placeholder box and geometry-only model. Set it to swap all of them at once; used as given. A pickup with its own color or a
   * vertex-colored geometry draws with a copy of it carrying that color
   * @example engine.pickups.material = new THREE.MeshStandardMaterial({ color: 0xffd24a, metalness: 0.8 })
   */
  material: Material;
  /** Edge of the placeholder box (meters), read when one is built */
  size: number;
  /** Height above the ground new pickups float at (meters) @experimental */
  lift: number;
  /**
   * Place a pickup on the ground at position; its y, if any, is the reference height on multi-layer ground (needs the interactions module unless auto):
   * spawn(v, { give: 'berry', count: 2 }). Returns a handle, remove() deletes it
   */
  spawn(position: PositionLike, opts: PickupOptions): PickupHandle;
  /** The data of the nearest pickup still on the ground to from (default engine.actorPosition()), of one item id or any; null if none */
  nearest(item?: string | null, from?: PositionLike): WorldRecord | null;
}
export interface PickupsOptions {
  /** Reach of pickups that do not set their own radius (meters), default 2 */
  radius?: number;
  /** Pickups have a model, float and spin only within this distance (meters) of the stream sources, default 60 @experimental */
  showDistance?: number;
  /** Who walks into auto pickups (actor ids); default engine.actor, plus net peers on a host */
  takers?: (e: Engine) => string[];
  /** Color of the placeholder box and geometry-only models when the pickup and its item set none, default 0xcccccc */
  color?: ColorLike;
  /** Edge of the placeholder box (meters), default 0.25 */
  size?: number;
  /** Height above the ground a pickup floats at (meters), default 0.4 */
  lift?: number;
}

/**
 * Container (inventory, chest, corpse, shelf, an actor's bag): inventory.container(id, opts) gets or creates one; an actor's bag has the actor's id
 * (inventory.of(actor)), the player inventory is the bag of engine.actor.
 * Every x is an item id or an entry key
 */
export interface Container {
  readonly id: string;
  /** Slot limit, default Infinity */
  capacity: number;
  /** Weight limit (item weight × count), default Infinity */
  maxWeight: number;
  /** How many of an item, or of one entry key */
  count(x: string): number;
  /** Whether there are at least n (default 1) */
  has(x: string, n?: number): boolean;
  /** One entry by key, or null */
  get(key: string): ItemEntry | undefined;
  /** Slots used */
  readonly slotsUsed: number;
  /** Total weight */
  readonly weight: number;
  /** Every entry (for custom UI) */
  list(): ItemEntry[];
  /** How many more fit (Infinity = no limit), for an item without data, with this data, or like an existing entry key */
  room(x: string, data?: Record<string, any>): number;
  /** Add n (default 1), optionally with data; returns { ok: true, key, added } (added: how many fit), or { ok: false, code: 'full' } when none fit; the answer is an object, so read .ok: if (add(...)) is true even when the bag is full; silent suppresses the toast (only the bag of engine.actor shows one) */
  add(id: string, n?: number, opts?: { data?: Record<string, any>; silent?: boolean }): ItemAddResult;
  /** Remove n (default 1) of an item or entry key, returns false if there are not enough */
  remove(x: string, n?: number): boolean;
  /**
   * Atomic trade: take A (id or entry key) and give B in one all-or-nothing step; failure code 'notEnough' | 'full'. Ops: inventory.trade, engine.ops.undo
   * reverses it
   */
  trade(
    take: string, give: string, opts?: { takeN?: number; giveN?: number; data?: Record<string, any>; silent?: boolean }
  ): { ok: boolean; code?: string; facts?: any; nextActions?: any[]; took?: { id: string; count: number; data?: any }[]; gave?: string; giveId?: string; giveN?: number };
  /** Replace an entry's data (null = none) for n pieces (default all); returns the key now holding them */
  setData(key: string, data: Record<string, any> | null, n?: number): string;
  /** Listen for changes of this container, returns a handle */
  on(type: 'add' | 'remove', fn: (e: ItemEvent) => void): Handle;
}

/** engine.inventory */
export interface Inventory {
  /** true: gameplay freezes while the inventory window is open (set from inventory({ pauseGame }) or at runtime) */
  pauseGame: boolean;
  /** Slot limit of the player inventory @experimental */
  capacity: number;
  /** Player inventory: the bag of engine.actor (= of()) @experimental */
  readonly bag: Container;
  /** The bag of an actor (default engine.actor): the container with the actor's id, created empty on first use; inside an op pass ctx.actor */
  of(actor?: string): Container;
  /** @experimental */ defaultStack: number;
  action: string;
  /** Define an item (chainable) */
  define(id: string, def: ItemDef): this;
  /** Get an item definition */
  item(id: string): ItemDef;
  /** How many of an item, or of one entry key */
  count(x: string): number;
  /** Whether there are at least n (default 1) */
  has(x: string, n?: number): boolean;
  /** Player inventory entries (for custom UI) */
  list(): ItemEntry[];
  /** One player inventory entry by key, or undefined */
  get(key: string): ItemEntry | undefined;
  /** Add n to the player inventory (default 1), opts { data, silent }; returns { ok: true, key, added }, or { ok: false, code: 'full' } when none fit */
  add(id: string, n?: number, opts?: { data?: Record<string, any>; silent?: boolean }): ItemAddResult;
  /** Remove n (default 1) of an item or entry key, returns false if there are not enough */
  remove(x: string, n?: number): boolean;
  /**
   * Atomic trade: take A (id or entry key) and give B in one all-or-nothing step; failure code 'notEnough' | 'full'. Ops: inventory.trade, engine.ops.undo
   * reverses it
   */
  trade(
    take: string, give: string, opts?: { takeN?: number; giveN?: number; data?: Record<string, any>; silent?: boolean }
  ): { ok: boolean; code?: string; facts?: any; nextActions?: any[]; took?: { id: string; count: number; data?: any }[]; gave?: string; giveId?: string; giveN?: number };
  /** Replace a player inventory entry's data for n pieces (default all); returns the key now holding them */
  setData(key: string, data: Record<string, any> | null, n?: number): string;
  /**
   * Get or create a container (chest, corpse, shelf...); the id can be the id of a world record, and the contents are saved. A second call returns the
   * same one; deleting the world record does not delete the container automatically
   */
  container(id: string, opts?: { capacity?: number; maxWeight?: number; items?: Record<string, number> }): Container;
  /**
   * Move n (default 1) of an item or one entry key between containers (pieces keep data and key); moves fewer if the target cannot hold them all,
   * returns how many were actually moved
   */
  transfer(from: Container | string, to: Container | string, item: string, n?: number): number;
  /** Delete a container together with its contents ('player' cannot be deleted), returns whether one was deleted */
  removeContainer(id: string): boolean;
  /** Every container's items as plain data, the player bag included: { [containerId]: entries } (what setContents takes; net syncs through these two) @experimental */
  contents(): Record<string, any[]>;
  /** Replace containers' items from contents() data, silently like a save load; a null entry empties that container, only: true empties the rest too @experimental */
  setContents(data: Record<string, any[] | null>, opts?: { only?: boolean }): void;
}
export interface InventoryOptions {
  /** Action name that opens the inventory, default 'inventory' */
  action?: string;
  /** true: gameplay freezes (engine.freeze) while the inventory window is open, default false. Also settable at runtime: engine.inventory.pauseGame */
  pauseGame?: boolean;
  /** Slot limit of the player inventory, default Infinity (no limit) */
  capacity?: number;
  /** Weight limit of the player inventory, default Infinity */
  maxWeight?: number;
  /** Default stack limit, default 99 @experimental */
  defaultStack?: number;
}

// ======================================================================
// Quests quests()
// ======================================================================

/**
 * One quest step: text is the displayed text, done the completion condition (checked every half second), target the objective (a marker is shown when
 * hud is installed)
 */
export interface QuestStep {
  /** Stable id: saves store progress by it, so steps can be inserted or reordered later (default: the step's position) */
  id?: string;
  text: string;
  done: (e: Engine) => boolean;
  /** The step after this one: a step id, or e => id asked when this step is done (a branch); false finishes the quest here. Default: the next step in the list. steps already passed are in quests.state(id).visited */
  next?: string | false | ((e: Engine) => string | false | undefined);
  /**
   * Objective: a place name (content.place), object, character, { x, z }, { nearest: itemId } or a function returning an objective; with the hud module
   * the current step shows a marker automatically
   */
  target?: HudTarget;
}
/** One goal of a parallel step; optional goals do not hold the step back */
export interface QuestPart { /** Stable id within the step (default: its position) */ id?: string; text: string; done: (e: Engine) => boolean; target?: HudTarget; optional?: boolean }
/** Parallel goals: done when every non-optional part is done, in any order; text defaults to the required parts joined */
export interface QuestParallelStep { /** Stable id (default: the step's position) */ id?: string; text?: string; all: QuestPart[]; /** As QuestStep.next */ next?: string | false | ((e: Engine) => string | false | undefined) }
/** Quest definition */
export interface QuestDef {
  /** Title */
  title: string;
  /** Description */
  desc?: string;
  /** Steps (completed in order); a step may be parallel goals { all: [...] } */
  steps: (QuestStep | QuestParallelStep)[];
  /** Called on completion (give rewards). Returning a failure ({ ok: false, code }, e.g. what e.content.run or e.inventory.add answer) means it was not paid: see onUnpaid */
  reward?: (e: Engine) => any;
  /** The game's decision for a reward not given, with the failure as answer. Without it the items that did not fit stay owed (list().owed, saved) and go into the bag when there is room */
  onUnpaid?: (e: Engine, answer: { ok: false; code: string; facts: any }) => void;
  /** Checked while active; true fails the quest (quest:fail; start(id) can begin it again). @example fail: e => e.vars.flag('caravanLost') */
  fail?: (e: Engine) => boolean;
  /** Called when the quest fails */
  onFail?: (e: Engine) => void;
}
/** engine.quests */
export interface Quests {
  /** The quest log (UI part 'questLog'): open, toggle(on?), refresh() */
  win: { readonly open: boolean; toggle(on?: boolean): void; refresh(): void };
  /** Define a quest (chainable) */
  define(id: string, def: QuestDef): this;
  /** Start a quest */
  start(id: string): void;
  /** One quest's progress (a copy): step index, step count, done, failed, active; null before it starts */
  state(id: string): { step: number; steps: number; done: boolean; failed: boolean; active: boolean; visited: string[] } | null;
  /** Finish the current step from code (its done() is not asked) and go on; the last step completes the quest. false when not active */
  advance(id: string): boolean;
  /** Finished (done, not failed) */
  isDone(id: string): boolean;
  /** Started, not done and not failed */
  isActive(id: string): boolean;
  /** Its fail condition held (start(id) begins it again) */
  isFailed(id: string): boolean;
  /** Check completion conditions once immediately */
  check(): void;
  /** Quest list (for custom UI) */
  list(): { id: string; title: string; desc?: string; done: boolean; failed: boolean;
    steps: { text: string; target?: HudTarget; done: boolean; current: boolean; parts?: { text: string; target?: HudTarget; optional: boolean; done: boolean }[] }[] }[];
}
/**
 * What the 'questLog' UI part receives in show(view) / update(view) (hide() when it closes). The engine opens it on the quest key, pushes the UI focus stack
 * (Esc calls close), locks gameplay input and calls update again when quests change while it is open.
 * @example
 * engine.ui.set('questLog', (engine) => {
 *   const el = document.createElement('div'); engine.uiRoot.appendChild(el); el.hidden = true;
 * const draw = (v) => { el.hidden = false; el.innerHTML = v.quests.map(q => `<p>${q.title}: ${q.steps.find(s => s.current)?.text ??
 * 'done'}</p>`).join(''); el.onclick = v.close; };
 *   return { show: draw, update: draw, hide: () => { el.hidden = true; }, dispose: () => el.remove() };
 * });
 */
export interface QuestLogView {
  /** Window title (localized) */
  title: string;
  /** Label of the key that toggles the log, e.g. 'J' */
  key: string;
  /** Same as engine.quests.list(): unfinished first */
  quests: ReturnType<Quests['list']>;
  /** Close the log (same as Esc or the quest key) */
  close(): void;
}
export interface QuestsOptions {
  /** Action name that opens the quest log, default 'quests' */
  action?: string;
  /** Check interval (real seconds, checked in the fixed step; not checked while frozen / paused), default 0.5 @experimental */
  checkInterval?: number;
  /**
   * Messages on quest start / step / done: true a toast with kind 'quest' (default) · false none · a function to show them your way.
   * @example quests({ notify: false })   quests({ notify: ({ type, text }) => type === 'done' && myBanner(text) })
   */
  notify?: boolean | ((msg: { type: 'start' | 'step' | 'done' | 'unpaid'; id: string; text: string }) => void);
}

// ======================================================================
// Photo mode photo()
// ======================================================================

/** A photo: url is the image data, time the clock time it was taken (e.g. "18:00"), position where it was taken */
export interface PhotoShot {
  /**
   * Id of the photo in storage (available right after taking it; photos are stored separately as Blobs in IndexedDB and the album is read back on the
   * next start, url is a blob: address)
   */
  id?: string;
  url: string; time: string; position: XZ | null;
  /** What was in the middle of the frame: name is the name, kind the kind (npc, entity, vegetation...), distance in meters */
  subject?: { name: string; kind: string; distance: number } | null;
  /** Only on a path-traced shot: samples per pixel reached, milliseconds, picture size, and the one line naming what the tracer did not draw as the game does (plus 'no post effects') @experimental */
  pathTraced?: { samples: number; ms: number; size: [number, number]; untraced: string };
}
export interface PhotoTakeOptions {
  /** Resolution multiplier, default 1.6 */
  scale?: number;
  /** Shadow resolution (pixels), default 4096 */
  shadowMapSize?: number;
  /** Bloom for the shot: null (default) keeps what the game's post has; true / false forces it for that shot only */
  bloom?: boolean | null;
  /** Image quality 0–1 */
  quality?: number;
  /** Image format, e.g. 'image/jpeg' */
  format?: string;
}
export interface PhotoOptions extends PhotoTakeOptions {
  /** How many photos the album keeps at most, default 50 @experimental */
  maxAlbum?: number;
  /** The game's import of its optional path tracer, called on the first photo.trace(): () => import('three-gpu-pathtracer/webgpu') @experimental */
  pathTracer?: (() => Promise<any>) | null;
}
/** engine.photo */
export interface Photo {
  /** Album (newest first) */
  album: PhotoShot[];
  /** The op photo.take's can: return true, or false / a reason string to refuse (e.g. () => engine.inventory.has('film') || 'noFilm') */
  canTake: () => boolean | string;
  scale: number; shadowMapSize: number; bloom: boolean; quality: number;
  /** @experimental */ format: string;
  /** @experimental */ maxAlbum: number;
  /** Capture a photo now without checks. Gameplay takes photos through the op: engine.ops.run('photo.take') (checks canTake, logged) */
  take(opts?: PhotoTakeOptions): PhotoShot;
  /** A path-traced photo (WebGPU backend or a WebGLRenderer; the game's photo({ pathTracer })): samples (whole, >= 1, default 128) accumulate on a snapshot while the game
   *  runs, until seconds (>= 1, default 60); resolves to the shot, rejects naming why. scale defaults to 1 here. The op photo.trace starts it (r.value is this Promise) @experimental */
  trace(opts?: PhotoTakeOptions & { samples?: number; seconds?: number }): Promise<PhotoShot>;
  /** While a path-traced photo accumulates: samples per pixel so far and the target; null otherwise @experimental */
  tracing: { samples: number; of: number } | null;
  /** What is in the middle of the frame (NPC, entity, named object, vegetation), null if nothing; this is the subject of take() @experimental */
  subject(): { name: string; kind: string; distance: number } | null;
}

// ======================================================================
// Ambience ambience(), debug debug()
// ======================================================================

// Ambience (engine.ambience) is generated from the JSDoc in modules/ambience/Ambience.js (npm run map); only the type is re-exported here
import type { Ambience } from './generated/modules/ambience/Ambience';
export type { Ambience };
/** ambience() options: rules (the rule table; added after createEngine({ audio: { ambience } })), interval seconds between rule checks (0.25) */
export interface AmbienceOptions { rules?: import('./core').AmbienceRule[]; interval?: number }
// DebugPanel (engine.debug) is generated from the JSDoc in modules/debug/DebugPanel.js (npm run map); only the type is re-exported here
import type { DebugPanel } from './generated/modules/debug/DebugPanel';
export type { DebugPanel };

// ======================================================================
// UI
// ======================================================================

/** Window returned by makeWindow() */
export interface UIWindow {
  el: HTMLElement;
  /** Whether it is open */
  readonly open: boolean;
  /** Redraw the content */
  refresh(): void;
  /** Open / close (toggle if no argument is passed) */
  toggle(on?: boolean): void;
  /** Remove the window: closed, its listeners and its element gone (a module passes the window to ctx.track instead) */
  remove(): void;
}
/** Parameters of makeWindow() */
export interface WindowOptions {
  /** Window name (also the style's template name) */
  id: string;
  /** Title */
  title: () => string;
  /** Action name that toggles it (shows the key hint) */
  hintAction?: string;
  /** Default content: (data, tools) => HTML */
  render: (data: any, tools: { esc: (s: any) => string; t: (key: string, params?: Record<string, any>) => string; icon: (def: any) => string }) => string;
  /** Template data */
  data?: () => any;
  /** What to do on the back key (Esc), default closes the window (an open window is on the UI focus stack, and Esc goes only to the topmost) */
  onCancel?: () => void;
  /** false: no close button and Esc does nothing, so only the game's own buttons end it (a win or lose window must not drop the player back into the game). Default true */
  closable?: boolean;
}
/** An entry of the UI focus stack (returned by uiFocus(engine).push) */
export interface FocusHandle extends Handle {
  id: string;
  /** Called on the back key; null = swallow the back key */
  cancel: (() => void) | null;
  /** Just pushed this frame (the key press that opened it must not count as its own action) */
  readonly fresh: boolean;
  /** The selected control / choice (null until the cursor first runs) */
  index: number | null;
  /** The choice cursor used confirm on this entry this frame (the owner's own confirm handling skips this frame) */
  readonly consumed: boolean;
  /** This entry is the top of the focus stack (a window over it makes it false: its owner must not read confirm / choice keys then) */
  readonly onTop: boolean;
  /** Change the cursor's controls while pushed (the index starts over); null = no cursor */
  setNav(nav: FocusNav | null): void;
}
/**
 * The UI choice cursor's controls for a focus entry: moved by the menu keys (uiUp / uiDown / uiLeft / uiRight, d-pad, left stick), pressed by confirm.
 * A function returning an element = the controls inside it (button, input, select, [data-nav]) in screen layout, the selected one gets .is-cursor;
 * an object = a list the owner draws itself (any direction steps by one).
 */
export type FocusNav = (() => Element | null) | { count(): number; confirm(index: number): void; moved?(index: number): void };
/**
 * UI focus stack: windows, dialogue, cutscenes and the settings menu are pushed in the order they open, and the back key (action cancel) goes only to
 * the top; when the stack is empty it goes to the one registered by setRoot (the settings menu)
 */
export interface UIFocus {
  /** Name of the top, null for an empty stack */
  readonly top: string | null;
  /** Names from bottom to top */
  list(): string[];
  /** The top entry's choice cursor ({ id, index }) when it has a nav, else null */
  readonly cursor: { id: string; index: number } | null;
  /** Push; without cancel = swallow the back key; nav = the choice cursor's controls (see FocusNav) */
  push(id: string, opts?: { cancel?: (() => void) | null; nav?: FocusNav | null }): FocusHandle;
  /** What to do on the back key when the stack is empty (only one, a later registration replaces it) */
  setRoot(fn: () => void): Handle;
}


// ======================================================================
// Game clock engine.clock, story variables engine.vars (core)
// ======================================================================

/**
 * engine.clock: calendar seconds and "after how long / every how long". Clock-time / season timers are on engine.sky (at / between / daily / onSeason). All
 * timers return a handle { remove() }
 */
export interface Clock {
  /**
   * Calendar seconds = world-channel seconds x clock.rate, does not advance while paused / frozen, saved with the game;
   * one calendar day = calendar.dayLength calendar seconds
   */
  readonly now: number;
  /**
   * Calendar seconds per world-channel second (default 1; 0 stops the calendar, sky included). Read-only: change it with
   * `engine.mod('clock.rate', { owner: 'game', set: 60 })` (a minute per second); the handle's remove() undoes it
   */
  readonly rate: number;
  /** Calendar seconds per real second right now (rate x the world channel's speed) */
  readonly speed: number;
  /**
   * Call fn after seconds calendar seconds; if an event name is passed, the event is emitted when due (with data, can be saved).
   * { channel } counts that time channel's seconds instead (a poison tick that slows down in bullet time)
   */
  after(seconds: number, fnOrEvent: (() => void) | string, opts?: { data?: any; channel?: string }): Handle;
  /** Call once every seconds calendar seconds ({ channel }: 'real' or a time channel's seconds instead) */
  every(seconds: number, fn: () => void, opts?: { channel?: string }): Handle;
}

/** The handle engine.mod / input.gate return: remove() ends only this owner's entry (a stale handle ends nothing) */
export interface ModHandle {
  owner: string; remove(): void;
  /** Rewrite this entry's value in place (same op / layer): a per-frame contribution takes once and changes every frame. false when the handle is stale */
  change(value: any): boolean;
}
/** Shared-point layers, lowest first. Most code never passes one: game code and game modules are 'game'; effects (weather, bullet time) pass 'effect' */
export type SharedLayer = 'engine' | 'game' | 'effect' | 'system' | 'settings' | 'debug';
/**
 * engine.mod options: exactly one of set / add / mul / clamp on a number point (set on a value point); none on a hold ('freeze') or a slot;
 * value on a 'top' point. Inside a layer: set, then add, then mul, then clamp; a higher layer's set hides what is below. Two owners setting one
 * point on one layer throw shared-conflict in development. The settings layer only restricts (clamp / mul; set false on a value point).
 */
export interface ModOptions {
  owner: string;
  set?: any; add?: number; mul?: number; clamp?: { min?: number; max?: number };
  /** 'top' points (the camera): the holder's value; 'any' ones: optional data kept beside the hold */
  value?: any;
  /** Seconds until it ends by itself, on clock ('real' by default: fixed seconds, stop while frozen; or a time channel name) */
  for?: number; clock?: string;
  /** The record, for per-record points ('time.local', your own per: true ones) */
  id?: string;
  /** Default 'game'. settings / system / debug entries are not saved */
  layer?: SharedLayer;
}
/** One entry as describe and holders() show it; at = the code line that took it (development builds) */
export interface ModHolder { owner: string; at?: string; op?: 'set' | 'add' | 'mul' | 'clamp'; value?: any; layer?: SharedLayer; left?: number; clock?: string; hidden?: boolean; }
/** One describe().shared row: writer = the owner whose value the rest acts on ('default' when nobody set it; 'three (engine yielded)' after a direct three.js write) */
export interface SharedRow { value: any; writer: string; layer?: SharedLayer; at?: string; how?: string; also: ModHolder[]; }
/** One shared point (engine.stacks.get(name)): read it here; change it with engine.mod(name, { owner, ... }), the one way in. A settings row
 *  restricts one with engine.settings.define(key, def, { limits: name }) */
export interface Stack {
  readonly name: string; readonly kind: 'number' | 'value' | 'any' | 'top' | 'one';
  /** The describe().shared row */
  row(id?: string): SharedRow;
  /** The current value, always recomputed from base + the entries now present (a slot: the holder's name or null) */
  value(id?: string): any;
  holders(id?: string): ModHolder[];
  names(id?: string): string[];
  has(owner: string, id?: string): boolean;
  size(id?: string): number;
  /** End owner's entry; false when it held none */
  release(owner: string, opts?: { id?: string }): boolean;
}
/** engine.stacks: every shared point by name ('time.<channel>', 'time.local', 'clock.rate', 'freeze', 'halt', 'camera', 'debug.view', slots, your own) */
export interface Stacks {
  /**
   * Define your own point: kind 'number' (default, base 1), 'value' (any data, set only), 'any' (true while held), 'top' (latest holder wins),
   * 'one' (exclusive slot); per: true = one value per record id; manual = the takeover call the conflict error offers;
   * important: true = always on the "Values being changed now" line (changed()), even at its base
   */
  define(name: string, opts?: { kind?: 'number' | 'value' | 'any' | 'top' | 'one'; base?: any; min?: number; max?: number; per?: boolean | 'optional'; save?: boolean; manual?: string; important?: boolean }): Stack;
  get(name: string): Stack;
  has(name: string): boolean;
  list(): string[];
  /** describe().shared: one row per point with entries */
  describe(): Record<string, SharedRow>;
  /** Everything one owner changes now, e.g. ['time.world (mul 0.8, effect)', 'inventory (holds)'] */
  of(owner: string): string[];
  /**
   * The values being changed now, furthest from base first, at most max (default 5): points off their base, capped by a setting, or defined with
   * { important: true }. describeText's "Values being changed now" line and the dev panel read this.
   */
  changed(max?: number): { name: string; base: any; now: any; how: string; text: string }[];
}
/** engine.time: time channels (world, player, your own). Speeds change only through engine.mod('time.<channel>', ...) */
export interface Time {
  /** Define a channel; parent (default 'world') multiplies its speed @experimental */
  channel(name: string, opts?: { parent?: string | null; stack?: string }): Time;
  /** @experimental */ channels(): string[];
  /** Effective speed: parent x the channel's stack (x the record's 'time.local' stack when id is given) */
  scale(name: string, id?: string): number;
  /** Fixed steps run this playthrough: the one time counter; every other time is a read-only view of it */
  readonly tick: number;
  /**
   * Seconds on a view: 'real' (tick / 60, no scale, stops while frozen), 'ambient' (= uniforms.uTime, keeps moving while frozen),
   * 'calendar' (= engine.clock.now) or a channel ('world', 'player', your own)
   */
  now(name: 'real' | 'ambient' | 'calendar' | 'world' | 'player' | (string & {})): number;
  /** This fixed step's dt on a channel (1/60 x scale). Change a speed with engine.mod('time.<channel>', { owner, set | mul }); timers: engine.clock.after(s, fn, data, { channel }) @experimental */
  dt(name: string, id?: string): number;
}
/** engine.vars: story flags and counters (autosaved) */
export interface Vars {
  /** All flags */
  flags: Record<string, any>;
  /** All counters */
  counters: Record<string, number>;
  /** Read a flag */
  flag(key: string): any;
  /** Set a flag (default true) */
  setFlag(key: string, value?: any): void;
  /** Read a counter (0 if none) */
  counter(key: string): number;
  /** Counter +n (default 1), returns the new value */
  bump(key: string, n?: number): number;
}

// ======================================================================
// Content content()
// ======================================================================

/** How a vocabulary value is written (the validator checks by it, the loader converts by it): clock receives a 0–1 ratio, position receives { x, z } */
export type ContentRef = 'flag' | 'counter' | 'itemCounts' | 'counterCounts' | 'quest' | 'text' | 'particles' | 'clock' | 'position' | 'any' | (string & {});
/** Custom condition: test(e, value) says whether it holds; ref/desc/describe are for the validator and the game map */
export interface ContentConditionDef {
  /** How the value is written, e.g. 'clock' */
  ref?: ContentRef;
  /** One-line description */
  desc?: string;
  /** Whether it holds: value is the value converted by ref, raw is the form written in the content, ctx.actor = who is asking (content.test's actor) */
  test(e: Engine, value: any, raw?: any, ctx?: { actor: string }): boolean;
  /** Write the value as human-readable text (for the game map) */
  describe?(value: any): string;
}
/** Parameters of content.load(): places is place name -> position. Models are asset names (engine.assets.manifest / an asset pack), not an option */
export interface ContentLoadOptions {
  places?: Record<string, PositionLike>;
  /** Inside a save part's load() or a module's afterLoad: the turn it got. Without it this load waits for that replacement to end */
  turn?: SaveTurn;
}
/** A content pack: the object of content/index.js, or a folder / npm package exporting the same tables. Data only: it names assets, never paths or code */
export type ContentPack = Record<string, any> & { name?: string; audio?: import('./core').ContentAudio };
/**
 * Prop (each item of content/props.js): model name (an asset name from engine.assets.manifest / an asset pack, never a path; write an array to pass
 * parameters), position, heading (radians), collision
 */
export interface PropDef {
  /**
   * Stable id (saves recognize it by this); if omitted it is `prop:<model name>:<index in the props array>`. Inserting in the middle of the array shifts
   * the later indices, so write an id for content that will change
   */
  id?: string;
  model: string | any[];
  place?: string; x?: number; z?: number;
  /** Height above the ground (meters) */
  y?: number;
  /** Rotation about the Y axis (radians), or [x, y, z] radians to tilt it (a tilted collide needs a collider3d provider) */
  rot?: number | [number, number, number];
  /** Uniform scale, or [x, y, z] per axis */
  scale?: number | [number, number, number];
  /** false = do not snap to the ground: y is then the height in the world */
  ground?: boolean;
  /** Collision: 'box' cuboid of the bounds, 'circle' cylinder on the model's base, { circle, occluder } the same with its radius in model meters (scales with the prop) and occluder: false so the follow camera passes it; false none (default) */
  collide?: 'box' | 'circle' | false | { circle: number; occluder?: boolean };
  /** Register for ray acceleration (engine.raycast can hit it), default true */
  static?: boolean;
  /** false: never drawn through engine.batching (default: repeated props batch automatically) */
  batch?: boolean;
  /** true: lower-detail levels far away (`threedog assets optimize --lod`), or rising distances in meters. Collision, rays and saves keep the full model; such a copy is never batched @experimental */
  lod?: boolean | number[];
}
/** engine.content: loads the plain data of the game's content/*.js into the engine */
export interface Content {
  /** All vegetation models are fetched and the models of world data such as nearby props are built (world.ready) */
  readonly ready: boolean;
  /** Markers added by the marker effect: id -> marker */
  markers: Map<string, HudMarker | undefined>;
  /**
   * Load content (items, pickups, vegetation, NPCs, dialogue, quests, keys, trigger zones, props, the game vocabulary rules): one pack, or a list of packs
   * loaded together in order; an id defined by two packs of one call is an error naming both (a later separate load overrides by name instead).
   * Bad data throws on the line. The Promise answers for this load: it resolves when the pack committed, and rejects when it failed, after the old level and registrations are
   * back (err.notRestored lists what could not be). A load nobody awaits is reported all the same
   * @example await engine.content.load([baseContent, forestDlc], { places: { home } })
   */
  load(data: ContentPack | ContentPack[], opts?: ContentLoadOptions): Promise<void>;
  /** Register a custom condition, e.g. condition('timeAfter', { ref: 'clock', test: (e, t) => e.calendar.timeOfDay >= t }) */
  condition(name: string, def: ContentConditionDef): this;
  /** Whether a condition holds (object, array or function (e, { actor })); actor = whose bag has / lacks look in (default the running op's actor, else engine.actor) */
  test(cond: any, opts?: { actor?: string }): boolean;
  /** Run an effect (object, array or function (e, { actor })); actor = whose bag give / take change (default the running op's actor, else engine.actor) */
  run(effect: any, opts?: { actor?: string }): { ok: true } | { ok: false; code: string; facts: { failed: { word: string; code: string; facts: any }[] }; nextActions: any[] };
  /** Place name -> position (load's places first, then level markers), null if none */
  place(name: string): XZ | null;
  /** Position form in content { place?, x?, z? } -> world coordinates */
  where(p: { place?: string; x?: number; z?: number }): XZ;
  /**
   * The shared, frozen definition of a content template (content/templates.js); instance state lives on the world record. e.g.
   * template('chest').container.capacity
   */
  template(name: string): Readonly<ContentTemplate>;
  /**
   * The fields one content entry may have (core/base/params.js spec format): what an editor panel lists and what content-check validates against.
   * name: a template name (placement fields plus its state fields, default = the value in state), an engine entry shape ('props', 'props.template',
   * 'props.grid', 'pickups', 'views'), a game kind that declares fields (content/rules.js kinds), or a world record id. Unknown names throw.
   * @example engine.content.fields('crop').stage   // { type: 'int', optional: true, default: 0, min: 0, max: 4 }
   */
  fields(name: string): Record<string, ContentField>;
  /**
   * Place a new runtime instance of a content template (inside an op or a fixed step), saved whole; returns the world record (kind = template name,
   * id `<template>#<n>` unless fields.id is given). fields: id, rot, scale, y (height above ground), items (container start goods), state fields
   * (stage too, for a template with stages).
   * @example engine.ops.define('chest.build', { run: (e, { x, z }) => e.content.spawn('chest', { x, z }, { items: { stick: 3 } }).id })
   */
  spawn(name: string, at: any, fields?: { id?: string; rot?: number; scale?: number; y?: number; items?: Record<string, number>; [stateField: string]: any }): WorldRecord;
}
/** One stage of a template with stages: a named step it stays in for duration calendar seconds (clock.now), e.g. seed -> sprout -> ripe, cold -> armed */
export interface ContentTemplateStage {
  name: string;
  /** Calendar seconds spent in this stage; only the last stage may leave it out (it stays there) */
  duration?: number;
  /** Multiplies the instance's scale while in this stage */
  scale?: number;
  /** Model name shown from this stage on (until a later stage names another); default the template's model */
  model?: string | any[];
}
/** template:stage event: a template instance entered a new stage by growing (several stages crossed at once give one event) */
export interface TemplateStageEvent { id: string; template: string; stage: number; name: string }
/** One field of a content entry (engine.content.fields): the core/base/params.js spec as plain data */
export interface ContentField {
  type: 'string' | 'number' | 'int' | 'bool' | 'position' | 'id' | 'any' | 'object' | 'array' | 'function';
  optional?: boolean;
  /** Only for template state fields: the value written in state (never written inside fields) */
  default?: any;
  min?: number;
  max?: number;
  values?: any[];
  desc?: string;
}
/** A content template: shared definition of a reusable object (recipes/30-templates.md) */
export interface ContentTemplate {
  /** Model name (style generator or assets name); every instance clones one shared prototype */
  model: string | any[];
  /** Collision: 'box' cuboid of the bounds, 'circle' cylinder on the model's base, { circle, occluder } the same with its radius in model meters (scales with the instance) and occluder: false so the follow camera passes it; omitted or false = does not block */
  collide?: 'box' | 'circle' | false | { circle: number; occluder?: boolean };
  /** false = not registered for rays */
  static?: boolean;
  /** true: lower-detail levels far away (`threedog assets optimize --lod`), or rising distances in meters; such copies are never batched @experimental */
  lod?: boolean | number[];
  /** Interaction: using an instance runs op with { id } */
  interact?: { op: string; label?: string | ((rec: WorldRecord, e: Engine) => string); radius?: number; height?: number; action?: string; enabled?: (rec: WorldRecord, e: Engine) => boolean };
  /** Each instance gets a container with its record id; items = starting goods (placed once) */
  container?: { capacity?: number; maxWeight?: number; items?: Record<string, number> };
  /** sfx played after a successful use */
  sound?: { use?: string };
  /** Per-frame look from the record (lid angle, glow); runs only while the model exists */
  animate?: (rec: WorldRecord, obj: Object3D, dt: number) => void;
  /** Instance state fields and their defaults, copied onto each record (saved) */
  state?: Record<string, any>;
  /**
   * Range / allowed values / description of state fields, checked on every placement and engine.content.spawn (dev) and by content-check. No default here:
   * the default is the value in state. The type is inferred from that value when left out. e.g. { stage: { type: 'int', min: 0, max: 4 } }
   */
  fields?: Record<string, string | Omit<ContentField, 'default'>>;
  /**
   * Named stages over game time (a crop growing, a turret warming up, a building under construction). Each instance gets the state field stage
   * (default 0, int 0..n-1, placeable and saved) and stageAt (clock.now when it entered); it advances near and far, catching up after a load or a skip.
   */
  stages?: ContentTemplateStage[];
  /** Asked every step, near and far; false holds the current stage and the time blocked does not count (e.g. rec => rec.watered) */
  canGrow?: (rec: WorldRecord, e: Engine) => boolean;
  /** Gameplay per fixed step while near (world.simulate near); write record fields directly or with world.set, both are saved */
  update?: (rec: WorldRecord, dt: number, e: Engine) => void;
}

// ======================================================================
// Game flow flow()
// ======================================================================

/** Parameters of flow() */
export interface FlowOptions {
  /** Starting state, default 'playing'; other states are entered on engine:ready (so you can define after use()) */
  start?: string;
}
/** A flow state (title, playing, paused, game over...) */
export interface FlowStateDef {
  /** Called on entering */
  enter?: (e: Engine, from: string) => void;
  /** Called on leaving */
  exit?: (e: Engine, to: string) => void;
  /** Freeze gameplay (engine.freeze, the picture keeps running), default false */
  freeze?: boolean;
  /** Lock game input, default false */
  lockInput?: boolean;
  /** Music played on entering (track name, null for silence) */
  music?: string | null;
}
/** Parameters of flow.transition() */
export interface FlowTransitionOptions {
  /** Fade-to-black / fade-in seconds, default 0.5 */
  fade?: number;
  /** Lock input during the switch, default true */
  lockInput?: boolean;
  /** Music: 'fade' fades out (default) | 'keep' leaves it alone */
  music?: 'fade' | 'keep';
  /** Save to slot 'auto' before the switch: 'auto' | false (default: a game with its own save points keeps its slots) */
  autosave?: 'auto' | false;
}
/** engine.flow: game state and scene transitions */
export interface Flow {
  /** Current state name */
  state: string;
  /** A scene transition is in progress @experimental */
  readonly transitioning: boolean;
  /** Define a state (built-in 'playing', 'paused') */
  define(name: string, def: FlowStateDef): this;
  /** Switch state */
  go(name: string): void;
  /**
   * Scene transition: lock input -> fade to black -> fade out music -> autosave -> fn() -> wait for modules to be ready -> fade in -> unlock; multiple
   * calls queue up
   */
  transition(fn: () => any, opts?: FlowTransitionOptions): Promise<void>;
}

// ======================================================================
// Objective markers hud()
// ======================================================================

/** Parameters of hud() */
export interface HudOptions {
  /** Show a marker automatically when the current quest step has a target, default true */
  questMarkers?: boolean;
}
/** Objective marker parameters */
export interface HudMarkerOptions {
  /** Text */
  label?: string | (() => string);
  /** Icon (text or image URL) */
  icon?: string;
  /** When the target is off screen: 'arrow' an arrow at the screen edge (default) | 'hide' not shown */
  offscreen?: 'arrow' | 'hide';
  /** Show the distance, default true */
  distance?: boolean;
  /** How high the marker floats above the target (meters) */
  height?: number;
}
/**
 * Marker target: an object, a character (with root), { x, z } (snapped to the ground), { x, y, z }, a place name;
 * { nearest: itemId } the nearest not-yet-picked-up pickup of that kind to the player (hidden when all are picked up); a function: called every frame
 * to get the target, hidden when it returns null
 */
export type HudTarget = Object3D | { root: Object3D } | PositionLike | string | { nearest: string } | (() => Object3D | { root: Object3D } | PositionLike | string | null);
/** Marker returned by hud.marker() */
export interface HudMarker {
  target: HudTarget;
  /** Distance in meters from the player (from the focus when there is no player) */
  dist: number | null;
  /** Shown this frame (false when the target is missing, off screen with offscreen 'hide', or before the first frame) */
  visible: boolean;
  /** The UI part drawing it (null when hud.marker is turned off); the default part has .el */
  part: import('./core').UIPart | null;
  /** On screen (otherwise an edge arrow is shown or it is hidden) */
  onScreen: boolean;
  /** Change parameters */
  set(opts: HudMarkerOptions): void;
  /** Change the target (the marker itself is not rebuilt) */
  setTarget(target: HudTarget): void;
  /** Delete */
  remove(): void;
}
/** Screen corner / edge a counter or bar column sits at (default 'top-left'); each anchor stacks its own column */
export type HudAnchor = 'top-left' | 'top' | 'top-right' | 'left' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right';
/** engine.hud: objective markers, counters, progress bars */
export interface Hud {
  /** All markers */
  markers: HudMarker[];
  /** Add an objective marker: target is an object, position or place name */
  marker(target: HudTarget, opts?: HudMarkerOptions): HudMarker;
  /** Counter or text status, returns { set(value), remove() } (calling again with the same id = update; calling every frame is fine): addCounter('fish', { label: '鱼', value: 2, max: 5 }), addCounter('clock', { value: '08:30' }); no value = the label alone, no label = the value alone (the id is not shown) */
  addCounter(id: string, opts: { label?: string; icon?: string; value?: number | string; max?: number; anchor?: HudAnchor }): { id: string; set(value: number | string | { label?: string; icon?: string; value?: number | string; max?: number }): void; remove(): void };
  /** Add n (default 1) to a number counter, return the new value; one not declared yet starts at 0 with its id as the label */
  bump(id: string, n?: number): number;
  /** Current value of a counter or bar (number or text), undefined when there is none; reads what interactions.add({ counter }) has added up */
  value(id: string): number | string | undefined;
  /** Progress bar (calling again with the same id = update; calling every frame is fine, the DOM is untouched when the value is unchanged),
   *  value/max 0–max */
  bar(id: string, opts: { value: number; max?: number; label?: string; anchor?: HudAnchor }): void;
  /** Clickable button (calling again with the same id = update): label is text or an i18n key, run() is called on a click / tap. The press never reaches the game and focus goes back to it; a locked mouse has no cursor, so free it first (Esc) */
  button(id: string, opts: { label: string; run: () => void; icon?: string; anchor?: HudAnchor; action?: string }): void;
  /** Key hint "E · Talk" (same id = update): the key text is engine.input.label(action) (the input.noKey text when the action needs a key and has none, as in the prompt), so it follows rebinding and keyboard / pad switching; label is text or an i18n key. A button with `action` shows its key too @experimental */
  hint(id: string, opts: { action: string; label?: string; anchor?: HudAnchor }): void;
  /** Delete a counter, progress bar, button or key hint */
  remove(id: string): void;
}
/**
 * Result of worldToScreen(): x/y are pixels from the canvas's top-left corner (the UI root covers the canvas), onScreen is inside the view, behind is
 * behind the camera
 */
export interface ScreenPoint { x: number; y: number; onScreen: boolean; behind: boolean }
