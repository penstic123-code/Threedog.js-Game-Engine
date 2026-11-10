// threedog/pixel: art pixel math on an orthographic camera, and a sprite built on it. See recipes/62-picture-code.md section 4b.
import type { Camera, Material, Mesh, Vector3 } from 'three';

type Point = { x: number; y: number; z: number };

/** Level rectangle for a camera's pixelSnap, world units. minY / maxY default to 0 (flat ground) */
export interface PixelBounds { minX: number; maxX: number; minZ: number; maxZ: number; minY?: number; maxY?: number }

export interface PixelGrid {
  readonly camera: Camera;
  readonly pixelsPerMeter: number;
  /** World size of one art pixel: 1 / pixelsPerMeter */
  readonly cell: number;
  /** The camera's unit axes now (reused between calls). Throws on a perspective camera */
  axes(): { right: Vector3; up: Vector3; forward: Vector3 };
  /** World point to meters along the screen axes: x right, y up, z forward */
  toScreen(world: Point, out?: Vector3): Vector3;
  /** Meters along the screen axes to a world point */
  toWorld(screen: Point, out?: Vector3): Vector3;
  /** World point rounded to the art grid on the two screen axes; depth stays */
  snap(world: Point, out?: Vector3): Vector3;
  /** How far snap moves this point, in art pixels (-0.5 to 0.5) */
  error(world: Point): { x: number; y: number };
  /** snap for the one object the camera follows: takes the camera's own rounding, so the two step together */
  snapFollowed(world: Point, out?: Vector3): Vector3;
  /** World units of view height a picture of `rows` art pixels needs */
  viewHeight(rows: number): number;
  /** Does the camera show exactly rows / pixelsPerMeter of the world? camera.zoom counts */
  agrees(rows: number): boolean;
  /** Where a camera wanting position goes: clamp on the screen axes, then round. Result reused between calls */
  place(position: Point, view: { columns: number; rows: number; bounds?: PixelBounds | null }): { position: Vector3; error: { x: number; y: number } };
}

/**
 * The art pixel grid of an orthographic camera. Pure math.
 * @example
 * const grid = pixelGrid({ camera: engine.camera, pixelsPerMeter: 32 });
 * const drawn = grid.snap(thing.position);
 */
export function pixelGrid(options: { camera: Camera; pixelsPerMeter: number }): PixelGrid;

export interface PixelSpriteOptions {
  /** From pixelGrid(), or engine.cameraRig.pixelSnap.grid */
  grid: PixelGrid;
  /** Your own three.js material; the engine brings no look */
  material: Material;
  /** One frame's width in texels */
  width: number;
  /** One frame's height in texels */
  height: number;
  /** Frames across the sheet (default 1) */
  columns?: number;
  /** Frames down the sheet (default 1) */
  rows?: number;
  /** Starting frame, left to right, top to bottom */
  frame?: number;
  /** Start mirrored */
  flip?: boolean;
  /** The point of the frame at the mesh's origin, 0 to 1 from the bottom left; default [0.5, 0], the feet. Rounds to a whole texel */
  anchor?: [number, number];
  /** 'world' (default) rounds the drawn position to the grid; 'followed' is for the one object the camera follows; false leaves it exact */
  snap?: 'world' | 'followed' | false;
}

/**
 * A plain THREE.Mesh: a vertical plane that turns around Y with the camera's forward direction, stretched so one texel is one art pixel.
 * Works as a character's `model`. mesh.position stays exact; only what is drawn is rounded.
 * @example
 * const hero = pixelSprite({ grid: engine.cameraRig.pixelSnap.grid, material, width: 16, height: 24, columns: 4, rows: 3, snap: 'followed' });
 * engine.characters.addPlayer({ ...presets.player.thirdPerson, model: hero });
 */
export function pixelSprite(options: PixelSpriteOptions): Mesh;

/** Show a sheet frame (left to right, top to bottom); flip mirrors it, left out it stays as it was */
export function spriteFrame(mesh: Mesh, frame: number, flip?: boolean): Mesh;
