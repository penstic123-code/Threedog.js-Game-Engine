// threedog assets check, the model contract: manifest models with `needs: { nodes, clips }` (core/assets/modelNeeds.js, the same function the load uses)
// against the glb on disk. The game's assets.js comes through content check's loader; the file checked is the one the engine loads (public/<resolved url>, lib/asset-url.mjs).
import { assetFiles, isFileOf } from '../lib/asset-url.mjs';
import { needsProblems, needsText } from 'threedog/model-needs';
import { sanitize, closest } from 'threedog/spelling';
import { loaderNames, partNode } from './names.mjs';

/** Keys of a model entry that the generated 'optimized' pack swaps (assetManifest.js FILE_KEYS); the game's other options, needs among them, stay */
const FILE_KEYS = ['url', 'lods', 'node', 'build', 'texture'];

/**
 * What the engine will load: the winning model entry of each name after all packs, the 'optimized' pack included (it takes the url and keeps the needs, as in
 * assetManifest.js). Returns [{ name, url, node, needs, files }] for the local entries that have needs or a node; files = their served file (asset-url.mjs)
 */
export function declaredNeeds(packs, dir) {
  const win = new Map();
  for (const pack of packs) for (const [name, m] of Object.entries(pack?.models ?? {})) {
    const o = { ...(typeof m === 'string' ? { url: m } : m), base: pack?.base }, old = win.get(name);
    win.set(name, pack?.name === 'optimized' && old ? { ...Object.fromEntries(Object.entries(old).filter(([k]) => !FILE_KEYS.includes(k))), ...o } : o);
  }
  return [...win].flatMap(([name, m]) => { const files = (m.needs || typeof m.node === 'string') && assetFiles(dir, m.url, m.base); return files ? [{ name, url: m.url, node: m.node, needs: m.needs, files }] : []; });
}

/** Names the entry gets from a file: the whole file, or for a { url, node } entry the node's subtree and the clips that move something in it (assetPart.js). All in the loader's spelling (names.mjs) */
function namesOf(doc, part) {
  const root = doc.getRoot(), all = part?.names ?? loaderNames(doc);
  let nodes = root.listNodes();
  if (part) { nodes = []; part.node.traverse(n => nodes.push(n)); }
  const inside = new Set(nodes);
  const clips = root.listAnimations().filter(a => !part || a.listChannels().some(c => inside.has(c.getTargetNode()))).map(a => a.getName());
  return { nodes: nodes.map(n => all.get(n)).filter(Boolean), clips };
}

/** Messages for one entry against the file it points at: a part node the file lacks (one message, the needs are not listed one by one), else what the needs lack */
export function entryIssues(doc, d) {
  const part = d.node != null ? partNode(doc, d.node) : null;
  if (d.node != null && !part) {
    const near = closest(sanitize(d.node), [...loaderNames(doc).values()]);
    return [`model "${d.name}" (${d.url}): part node "${d.node}" is not in the file${near ? ` (closest in the file: "${near}")` : ''}`];
  }
  const miss = d.needs ? needsProblems(d.needs, namesOf(doc, part)) : [];
  return miss.length ? [needsText(d.name, d.url, miss)] : [];
}

/** Error issues [{ severity, code, msg }] for the checked file: every declared entry that points at it and lacks something */
export function needsIssues(file, doc, declared) {
  return declared.filter(d => isFileOf(d.files, file)).flatMap(d => entryIssues(doc, d)).map(msg => ({ severity: 'error', code: 'model-needs', msg }));
}
