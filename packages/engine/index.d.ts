// Type declarations for the engine API (hand-written).
//
// Why: when game code does import ... from 'threedog', TypeScript reads this file instead of index.js,
// so `npm run types` reports a wrong parameter name, a misspelled module name or a call to a missing method on the spot.
// No runtime effect (browsers and Vite use only .js).
//
// File layout:
//   packages/engine/types/common.d.ts    shared small types (position, color, easing names)
//   packages/engine/types/core.d.ts      Engine class, event map EventMap, input, i18n, saves, assets, audio, module definition
//   packages/engine/types/world.d.ts     terrain, vegetation, calendar, sky, weather, water
//   packages/engine/types/physics.d.ts   collision, Rapier physics, the four cameras
//   packages/engine/types/gameplay.d.ts  timeline, level, trigger zones, particles, settings, music, character/NPC, interactions, dialogue, inventory, quests, photo mode,
//                               clock, story variables, content, flow, objective markers...
//   packages/engine/types/nav.d.ts       navmesh
//   packages/engine/types/generated/    generated from the JSDoc in the JS sources (npm run map, do not edit by hand): ui/UI.js Focus.js Parts.js, render/materials.js PostFX.js, modules/ water calendar sky weather particles ambience music timeline debug hlod hud flow; re-exported below with export { ... } from
// three.js types come from @types/three (a dependency of this package, version-locked to three), so THREE.* is fully checked.
//
// When the engine's public API changes (new export, changed parameter), update this file too; `npm run types` checks that every export of index.js is declared.

import type { Engine, EngineOptions, ModuleDef, ModuleInput, PictureSlot, Ground, GroundProvider } from './types/core';
import type { Ease, EaseName, BufferGeometry, ColorLike, Material, Vector3, PositionLike } from './types/common';
import type {
  TerrainOptions, TerrainConfig, TerrainGen, Terrain, Vegetation, VegetationModuleOptions, Sky, SkyOptions, Calendar, CalendarOptions, Weather, WeatherOptions, WeatherPreset,
  WeatherName, Water, WaterOptions, FlattenZone, Hlod, HlodOptions,
} from './types/world';
import type { Nav, NavOptions } from './types/nav';
import type {
  CollisionOptions, Collision, RigidOptions, RigidBodies, Collider3D, SweepHit, RagdollPart, CameraRig, FollowCameraOptions, FirstPersonCameraOptions,
  FixedCameraOptions, RtsCameraOptions,
} from './types/physics';
import type {
  CharactersApi, CharactersOptions, Interactions, InteractionsOptions, Dialogue, DialogueOptions, Inventory, InventoryOptions, Pickups, PickupsOptions,
  Quests, QuestsOptions, Photo, PhotoOptions, Ambience, AmbienceOptions, DebugPanel, Level, LevelOptions, Triggers, TriggersOptions,
  Particles, Settings, SettingsOptions, SettingsTools, Music, MusicOptions,
  Timeline, TimelineOptions, Character, NPC, UIWindow, WindowOptions,
  Content, Flow, FlowOptions, Hud, HudOptions, ScreenPoint, UIFocus, FocusHandle,
} from './types/gameplay';
import type { TerrainDraw, VegetationDraw } from './types/world';
import type { PostEffect } from './types/generated/render/PostFX';
// Local bindings for the generated module factories (export { x } from re-exports below do not create them), used by OpenWorldOptions
import type { sky } from './types/generated/modules/sky/skyModule';
import type { calendar } from './types/generated/modules/calendar/index';
import type { weather } from './types/generated/modules/weather/Weather';
import type { water } from './types/generated/modules/water/Water';
import type { world } from './types/generated/modules/world/index';
import type { ambience } from './types/generated/modules/ambience/Ambience';
import type { debug } from './types/generated/modules/debug/DebugPanel';

// Types are exported too, so game code can write JSDoc: /** @type {import('threedog').DialogueScript} */
export type { ColorLike, Vec3Like, PositionLike, XZ, DirXZ, Range, EaseName, Ease, Loose, Handle } from './types/common';   // a list, not *: three.js's own types come from 'three'
export * from './types/core';
export * from './types/world';
export * from './types/physics';
export * from './types/gameplay';
export * from './types/nav';

// ======================================================================
// Core
// ======================================================================

/** three.js itself (the same instance the engine uses; typed by @types/three) */
export * as THREE from 'three';

/** Create an engine (core only). canvas is required */
export function createEngine(opts: EngineOptions): Engine;
/** The picture slots: what each one is and which describe('picture').picture.writers names it covers (a name ending in '.' covers everything under it) */
export const PICTURE_SLOTS: Readonly<Record<PictureSlot, { readonly what: string; readonly values: readonly string[] }>>;

/** One openWorld part: false leaves the module out, true / omitted uses defaults, an object is that module's own options */
type Part<F extends (...a: any) => any> = boolean | NonNullable<Parameters<F>[0]>;
/**
 * openWorld() options: shorthands (seed... go to terrain, time / dayLength to calendar, weather / autoWeather to weather) and one entry per part.
 * Gameplay modules (dialogue, inventory, quests, photo mode...) are not in the preset; engine.use them yourself
 */
export interface OpenWorldOptions {
  /** Terrain random seed */
  seed?: number;
  /** View distance (in chunks) */
  viewChunks?: number;
  /** Vegetation density multiplier */
  density?: number;
  /** Flatten a plot (for a house) */
  flatten?: FlattenZone[];
  /** Start time 0-1 */
  time?: number;
  /** Calendar seconds per day (default 360) */
  dayLength?: number;
  /** Starting weather name, false (no weather module) or weather() options */
  weather?: WeatherName | (string & {}) | Part<typeof weather>;
  /** Automatic weather changes */
  autoWeather?: boolean;
  /** Required, no default: 'follow' / 'firstPerson' / 'rts' / 'fixed', a camera module with options (e.g. followCamera(presets.camera.overShoulder)), or false */
  camera: 'follow' | 'firstPerson' | 'rts' | 'fixed' | ModuleDef | false;
  world?: Part<typeof world>;
  terrain?: Part<typeof terrain>;
  vegetation?: Part<typeof vegetation>;
  calendar?: Part<typeof calendar>;
  sky?: Part<typeof sky>;
  water?: Part<typeof water>;
  collision?: Part<typeof collision>;
  rigid?: Part<typeof rigid>;
  characters?: Part<typeof characters>;
  ambience?: Part<typeof ambience>;
  settings?: Part<typeof settings>;
  /** Default: installed in dev builds only; true also in release builds */
  debug?: Part<typeof debug>;
}
/**
 * Open-world preset: world, terrain, vegetation, calendar, sky, weather, water, collision, physics, camera, characters, ambience, settings, debug (dev only).
 * camera is required (the bundle picks no camera feel). Every part takes false or its own options: openWorld({ seed: 7, camera: 'follow', rigid: false }). Add gameplay modules yourself
 */
export function openWorld(opts: OpenWorldOptions): ModuleDef[];

// ======================================================================
// Modules (each function returns a module for engine.use())
// ======================================================================

/** Procedural terrain -> engine.terrain, and engine.terrainDraw for its drawing */
export function terrain(opts?: TerrainOptions): [ModuleDef<Terrain>, ModuleDef<TerrainDraw>];
/** One ground slot over several providers: terrain({ part: true }) / level({ part: true }) answer inside their region, higher priority wins where regions overlap. region: (x, z) => boolean | { volume } (asked at y 0); omitted = everywhere */
export function compositeGround(opts: { parts: Array<{ of?: 'terrain' | 'level'; ground?: Partial<GroundProvider>; region?: ((x: number, z: number) => boolean) | { volume: { contains(p: { x: number; y: number; z: number }): boolean } }; priority?: number }> }): ModuleDef<void>;
/** Vegetation -> engine.vegetation: on terrain chunks when terrain() is installed first (no options), else on its own chunks over any ground (a level, setGround) */
export function vegetation(opts?: VegetationModuleOptions): [ModuleDef<Vegetation>, ModuleDef<VegetationDraw>];
// Migrated: sky() is generated from the JSDoc in modules/sky/skyModule.js
export { sky } from './types/generated/modules/sky/skyModule';
// calendar() is generated from the JSDoc in modules/calendar/index.js
export { calendar } from './types/generated/modules/calendar/index';
// Migrated: weather() is generated from the JSDoc in modules/weather/Weather.js
export { weather } from './types/generated/modules/weather/Weather';
/**
 * Opt-in gameplay presets: named option objects a game picks on purpose (the engine never applies one itself). Each only bundles options
 * the game could write; spread and override: weather({ ...presets.weather.temperate, autoPool: ['clear', 'rain'] })
 */
export const presets: {
  readonly weather: { readonly temperate: WeatherOptions & Required<Pick<WeatherOptions, 'types' | 'autoPool'>> };
  readonly calendar: { readonly fourSeasons: CalendarOptions; readonly cycle: CalendarOptions; readonly fixedTime: CalendarOptions };
  readonly player: { readonly [K in 'thirdPerson' | 'lockOn' | 'aim' | 'sideScroller']: Pick<import('./types/gameplay').PlayerOptions, 'control' | 'faceMode' | 'cameraFollow'> };
  readonly interactions: { readonly [K in 'nearest' | 'facing' | 'aim']: import('./types/gameplay').InteractionsOptions };
  /** Key maps for the actions modules declare (no module option takes keys): engine.input.bind(map) or createEngine({ bindings: { ...map } }) */
  readonly bindings: { readonly [K in 'walk' | 'interact' | 'inventory' | 'quests' | 'photo' | 'gridRotate' | 'brake' | 'dialogNumbers' | 'rtsRotate' | 'cutsceneSkip' | 'debug']: Readonly<Record<string, readonly string[]>> };
  readonly camera: { readonly follow: import('./types/physics').FollowCameraOptions; readonly overShoulder: import('./types/physics').FollowCameraOptions; readonly thirdPersonAction: import('./types/physics').FollowCameraOptions };
};
// Migrated: water() is generated from the JSDoc in modules/water/Water.js
export { water } from './types/generated/modules/water/Water';
// Migrated: world() is generated from the JSDoc in modules/world/index.js
export { world } from './types/generated/modules/world/index';
export type { World, WorldRecord } from './types/generated/modules/world/World';
// Migrated: net() and its transports are generated from the JSDoc in modules/net/
export { net, fakeNetwork, webSocket } from './types/generated/modules/net/index';
export type { Net } from './types/generated/modules/net/Net';
// grids() is generated from the JSDoc in modules/grid/index.js
export { grids } from './types/generated/modules/grid/index';
export type { Grids } from './types/generated/modules/grid/index';
export type { Grid, GridRule } from './types/generated/modules/grid/Grid';
export type { Layer } from './types/generated/modules/grid/Layer';
/** Lightweight collision -> engine.collision */
export function collision(opts?: CollisionOptions): ModuleDef<Collision>;
/** Real physics (Rapier) -> engine.rigid (install collision first) */
export function rigid(opts?: RigidOptions): ModuleDef<RigidBodies>;
/** Third-person follow camera -> engine.cameraRig */
export function followCamera(opts?: FollowCameraOptions): ModuleDef<CameraRig>;
/** First-person camera -> engine.cameraRig */
export function firstPersonCamera(opts?: FirstPersonCameraOptions): ModuleDef<CameraRig>;
/** Fixed-shot camera -> engine.cameraRig */
export function fixedCamera(opts?: FixedCameraOptions): ModuleDef<CameraRig>;
/** Strategy top-down camera -> engine.cameraRig */
export function rtsCamera(opts?: RtsCameraOptions): ModuleDef<CameraRig>;
/** Characters: player engine.characters, NPCs engine.npcs */
export function characters(opts?: CharactersOptions): ModuleDef<CharactersApi>;
/** Interaction prompts -> engine.interactions */
export function interactions(opts: InteractionsOptions): ModuleDef<Interactions>;
/** Dialogue -> engine.dialogue */
export function dialogue(opts?: DialogueOptions): ModuleDef<Dialogue>;
/** Inventory -> engine.inventory */
export function inventory(opts?: InventoryOptions): ModuleDef<Inventory>;
/** Things on the ground that give whoever takes them an item (into that actor's bag) or an instant effect; needs world() */
export function pickups(opts?: PickupsOptions): ModuleDef<Pickups>;
/** Quests -> engine.quests */
export function quests(opts?: QuestsOptions): ModuleDef<Quests>;
/** Photo mode -> engine.photo */
export function photo(opts?: PhotoOptions): ModuleDef<Photo>;
// Migrated: ambience() is generated from the JSDoc in modules/ambience/Ambience.js
export { ambience } from './types/generated/modules/ambience/Ambience';
// Migrated: debug() is generated from the JSDoc in modules/debug/DebugPanel.js
export { debug } from './types/generated/modules/debug/DebugPanel';
/** Hand-built level -> engine.level */
export function level(opts?: LevelOptions): ModuleDef<Level>;
/** Trigger zones -> engine.triggers */
export function triggers(opts?: TriggersOptions): ModuleDef<Triggers>;
// Migrated: particles() is generated from the JSDoc in modules/particles/Particles.js
export { particles } from './types/generated/modules/particles/Particles';
// swarm() and the Swarm class are generated from the JSDoc in modules/swarm/Swarm.js
export { swarm } from './types/generated/modules/swarm/Swarm';
/** Settings menu -> engine.settings */
export function settings(opts?: SettingsOptions): ModuleDef<Settings>;
// Migrated: music() is generated from the JSDoc in modules/music/Music.js
export { music } from './types/generated/modules/music/Music';
// Migrated: timeline() is generated from the JSDoc in modules/timeline/Timeline.js
export { timeline } from './types/generated/modules/timeline/Timeline';
/** Navmesh (Recast, for levels) -> engine.nav; once installed, characters.findPath uses it automatically */
export function nav(opts?: NavOptions): ModuleDef<Nav>;
/** Content loading (the game's pure-data content/*.js) -> engine.content */
export function content(): ModuleDef<Content>;
// Migrated: hlod(), flow() and hud() are generated from the JSDoc in modules/hlod/index.js, flow/index.js, hud/index.js
export { hlod } from './types/generated/modules/hlod/index';
// Migrated: lightPool() is generated from the JSDoc in modules/lights/index.js
export { lightPool } from './types/generated/modules/lights/index';
export { flow } from './types/generated/modules/flow/index';
export { hud } from './types/generated/modules/hud/index';

// ======================================================================
// Utilities
// ======================================================================

/** Screen coordinates (-1..1) -> point on the ground; null if the ray misses the ground */
export function screenToGround(engine: Engine, ndcX: number, ndcY: number, opts?: { maxDistance?: number }): Vector3 | null;
/**
 * A grid of numbers (height, moisture, density, walkable...) as a function (x, z) -> value. data[j * width + i] sits at origin + (i, j) * cell.
 * interp 'nearest' = flat steps, 'linear' (default) = bilinear, 'cubic' = smooth (clamp: true avoids overshoot). Outside: edge value, or `outside`.
 */
export function sampleGrid(data: ArrayLike<number>, opts: { width: number; height: number; cellSize?: number | [number, number]; size?: [number, number];
  origin?: [number, number]; interp?: 'nearest' | 'linear' | 'cubic'; clamp?: boolean; outside?: number }): (x: number, z: number) => number;
/** Name or function -> easing function */
export function ease(e: Ease): (t: number) => number;
/**
 * Warn once about unknown keys in extensible data (your item / record definitions where players or mods add their own fields), with a
 * "did you mean" hint. Options bags go through readParams instead (an unknown key throws in dev). loose only warns on near-misses.
 * @example checkOptions('crops.define()', def, ['grow', 'yield', 'season'], { loose: true });
 * @experimental
 */
export function checkOptions(where: string, opts: object | null | undefined, known: string[], flags?: { loose?: boolean }): void;
/**
 * One content kind split over several files (content/props/forest.js, town.js…): joined in file-name order (arrays concatenated, objects merged,
 * a key in two files an error), the same order content check and write-back use, with each entry's dev source line kept.
 * @example const props = contentParts(import.meta.glob('./props/*.js', { eager: true }));
 */
export function contentParts(modules: Record<string, { default: any } | any>): any;
/** One field of a params / op args schema: 'int?' or the full form (default implies optional) */
export type ParamSpec = string | { type: string, default?: any, min?: number, max?: number, values?: any[], desc?: string, optional?: boolean };
/**
 * Module options read through a params schema: unknown keys and wrong types throw in dev with the fix, defaults are filled in.
 * Also put params / options on the module definition so engine.catalog(name) shows them (recipes/51-capability-catalog.md).
 * @example const o = readParams('magnet', { radius: { type: 'number', default: 2, min: 0 } }, opts);
 */
export function readParams<T extends object = any>(where: string, schema: Record<string, ParamSpec>, opts?: object): T;
/**
 * Every change the engine makes to three.js classes, the game's three.js objects or its renderer (also in describe().threePatches).
 * scope: what it reaches; lost: what stops when it is off (or why it cannot be). off(id) undoes an offable one for the whole page; others throw.
 * @example threePatches.off('shadow-accessors');   // still shadows for wind materials, three's own customDepthMaterial
 */
export const threePatches: {
  list(): { id: string, what: string, scope: string, on: boolean, offable: boolean, lost: string }[];
  off(id: string): void;
};
// The Character, NPC and Engine classes are exported by the export * above (tweens use engine.timeline.tween, pathfinding uses engine.characters.findPath)

/** Pure terrain computation (no engine needed), for previewing heights before start: createTerrain({ seed, ...terrainPreset() }).surface(x, z) */
export function createTerrain(cfg?: Partial<TerrainConfig>): TerrainGen;

// ---------- Materials ----------
// Migrated: declarations are generated from the JSDoc in packages/engine/render/materials.js (npm run map), not written by hand here
export { terrainMaterial, mergeColored, applyEffects } from './types/generated/render/materials';
export { rampTexture } from './types/generated/render/lighting';
export { bakeVertexAO } from './types/generated/render/modeling';
export { materialPatches } from './types/generated/render/patches';

// ---------- UI ----------
// Migrated: declarations are generated from the JSDoc in packages/engine/ui/UI.js and Focus.js (npm run map), not written by hand here
export { toast, makeWindow, worldToScreen, fadeScreen, uiFocus, toggleOnKey } from './types/generated/ui/UI';
// Type PostFX (class in render/PostFX.js): used by engine.post in Engine, and exported publicly
export type { PostFX, PostEffect } from './types/generated/render/PostFX';
export type { UIPart, UIPartFactory, UIPartValue, UIPartDef, UIParts, UITitleItem, UIOptions, UITheme, UITemplate } from './types/core';

// ---------- Clock ----------
/** Clock time -> fraction of the day: parseClock('18:30') = 0.77; a number or numeric string ('0.25') is converted as is. hoursPerDay is hours per day, default 24 */
export function parseClock(clock: string | number, hoursPerDay?: number): number;
/** Fraction of the day -> 'HH:MM': formatClock(0.75) = '18:00' */
export function formatClock(t: number, hoursPerDay?: number): string;
/** Is time t (0-1, e.g. calendar.timeOfDay) inside the range [from, to)? from and to are 'HH:MM' or 0-1; from > to wraps past midnight. Used by calendar.between and the audio rule condition { time: [from, to] } @experimental */
export function inRange(t: number, from: string | number, to: string | number, hoursPerDay?: number): boolean;

// ---------- Target selection (core/scene/targeting.js, pure functions) ----------
/**
 * Options of pickTarget / switchTarget: radius meters (15); cone half-angle in radians (1.4); close meters inside which angle is ignored (2.5);
 * angleWeight meters per radian off the view (6); blocked(c) true skips c (occlusion); at(c) reads a candidate's position (default c.position ?? c)
 */
export interface TargetOptions<T> { radius?: number; cone?: number; close?: number; angleWeight?: number; blocked?: (c: T) => boolean; at?: (c: T) => PositionLike }
/**
 * Best target in front: lowest "distance + angle off view × angleWeight" inside radius and cone.
 * view is a direction { x, z } (cameraRig.forward()) or a facing angle. Returns the candidate or null
 */
export function pickTarget<T>(from: PositionLike, view: { x: number; z: number } | number, candidates: Iterable<T>, opts?: TargetOptions<T>): T | null;
/** Next target to the right (side 1) or left (-1) of current as seen along view, wrapping; current missing → the leftmost. Returns a candidate or null */
export function switchTarget<T>(from: PositionLike, view: { x: number; z: number } | number, current: T | null, candidates: Iterable<T>, side: 1 | -1,
  opts?: Pick<TargetOptions<T>, 'radius' | 'blocked' | 'at'>): T | null;

// ======================================================================
// Globals
// ======================================================================
declare global {
  interface Window {
    /** Convention in the examples: window.engine = engine, for debugging in the browser console */
    engine?: any;
  }
}

