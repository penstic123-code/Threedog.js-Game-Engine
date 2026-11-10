// A model's `needs`: the parts (nodes) and animation clips a game relies on, declared in the manifest entry and checked against the file.
//   models: { hero: { url: '/models/hero.glb', needs: { nodes: ['Hand_R'], clips: ['Idle', 'Run'] } } }
// One reader for both checkers: `threedog assets check` (static, the glb on disk) and the load (the parsed scene) both hand their names to needsProblems.
// Why: a re-export that drops a node or a clip passes every build and breaks at runtime, far from the file.
import { readParams, keysSchema } from '../base/params.js';
import { codedError } from '../base/errorHints.js';
import { sanitize, closest } from '../base/spelling.js';

const KEYS = ['nodes', 'clips'];

/** Registration-time read of a `needs` declaration: unknown keys throw like any option, the lists must be arrays of names. Returns { nodes, clips } */
export function readNeeds(where, needs) {
  const o = readParams(`assets.manifest() ${where}.needs`, keysSchema(KEYS), needs);
  for (const k of KEYS) if (o[k] != null && (!Array.isArray(o[k]) || o[k].some(n => typeof n !== 'string'))) {
    throw codedError('module-params', `assets.manifest() ${where}.needs.${k} is a list of names, e.g. needs: { ${k}: ['${k === 'nodes' ? 'Hand_R' : 'Idle'}'] }`);
  }
  return { nodes: o.nodes ?? [], clips: o.clips ?? [] };
}

/**
 * What a file lacks of its declaration: [{ kind: 'node' | 'clip', name, near }] (near = the closest name the file has, or null).
 * Node names compare the way the loader spells them (a dot, colon or bracket dropped, a space becomes _: the same rule as the { url, node } entry); clip names compare as written.
 * @param {{ nodes?: string[], clips?: string[] }} needs  @param {{ nodes: string[], clips: string[] }} have  names present in the file
 * @returns {{ kind: 'node' | 'clip', name: string, near: string | null }[]}
 */
export function needsProblems(needs, have) {
  const out = [], nodes = new Set(have.nodes.map(sanitize)), clips = new Set(have.clips);
  for (const n of needs.nodes ?? []) if (!nodes.has(sanitize(n))) out.push({ kind: 'node', name: n, near: closest(sanitize(n), [...nodes]) ?? null });
  for (const c of needs.clips ?? []) if (!clips.has(c)) out.push({ kind: 'clip', name: c, near: closest(c, [...clips]) ?? null });
  return out;
}

/** One line for a game or the CLI: model name, what is missing, the closest name that exists */
export function needsText(model, url, problems) {
  const list = problems.map(p => `${p.kind} "${p.name}"${p.near ? ` (closest in the file: "${p.near}")` : ''}`).join(', ');
  return `model "${model}" (${url}) is missing what its manifest entry needs: ${list}. The file was re-exported without it, or the name changed; restore it in the model, or update needs in the manifest`;
}
