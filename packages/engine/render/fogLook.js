// What fog a scene is drawn with, for the parts that match something to it (the sky dome's fog band, the water's grazing colour, the horizon check).
// WebGL fog is scene.fog (a three Fog / FogExp2) and WebGLRenderer never draws a fogNode. WebGPU fog as the engine documents it (recipes 56) is
// scene.fogNode = fog(color, factor), a TSL node, and WebGPURenderer draws it in place of scene.fog when both are set (three NodeManager.getFogNode).
// One reading that follows the renderer, so a part never answers "no fog" for a scene that has one, nor "fog" for a fogNode WebGL ignores.
import { warnOnce } from '../core/base/validate.js';
import { coded } from '../core/base/errorHints.js';
import { isWebGPU } from './backend.js';

/**
 * The fog the renderer draws: on WebGPURenderer scene.fogNode when set, else scene.fog; on WebGLRenderer scene.fog only. A fogNode comes back as
 * { color, isNode: true } read from fog(color, factor) when color is a THREE.Color or a color() / uniform(Color) node (the first argument of the
 * call, kept in rawInputs). A computed color cannot be read before the shader runs: the parts then get color null and the game is told once, instead of
 * the dome / water silently ignoring its fog. A node's range is not read (fog() takes any factor node), so it has no near / far / density.
 * @param {any} scene @param {any} renderer
 * @returns {{ color: any, near?: number, far?: number, density?: number, isFog?: boolean, isFogExp2?: boolean, isNode?: boolean } | null}
 */
export function fogLook(scene, renderer) {
  const n = isWebGPU(renderer) && scene.fogNode;
  if (!n) return scene.fog || null;
  const c = n.rawInputs?.[0], v = c?.isColor ? c : c?.value;
  if (v?.isColor) return { color: v, isNode: true };
  warnOnce(coded('fog-fallback', 'scene.fogNode: its color is not a THREE.Color, color(..) or uniform(Color) (as in fog(color(0xaabbcc), factor)), so the sky dome\'s fog band, the water\'s grazing colour and the horizon check cannot match your fog and leave it out'), 'fog-node-unread');
  return { color: null, isNode: true };
}
