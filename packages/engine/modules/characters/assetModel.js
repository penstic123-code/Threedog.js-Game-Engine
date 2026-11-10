// Character body named by asset (Character({ model: 'humanoid' | 'hero' | ['villager', 0xcc8844] })): construction is synchronous, loading is not.
// The name takes the same two forms as a prop's model: a villager with a colour argument used to reach Object3D.add as an array and crash far from the content that wrote it.
// A procedural builder (manifest models: { humanoid: fn }, an asset pack's models) is built right here (buildNow), so its joints exist as soon as the
// character does and no placeholder frame shows. A file model already loaded is swapped in at once (engine.assets.modelNow); otherwise the
// character keeps its gray capsule until engine.assets.model(name) resolves, then the copy (SkeletonUtils clone, so many characters share one
// asset) replaces the body under the same root: position, facing, state and every reference to the character or its root (collision,
// interactions, world view) stay valid.
import * as THREE from 'three';
import { warnOnce, fmt } from '../../core/base/validate.js';
import { neutralMaterial } from '../../render/neutral.js';
import { codedError } from '../../core/base/errorHints.js';
import { builderArgs } from '../../core/assets/namedModel.js';
import { list as nameAndArgs } from '../../core/base/util.js';

/**
 * Build a procedural model asset now (synchronously) when `name` is a registered builder; null when it is a file model or unknown. A builder that answers with a
 * promise (async) is not run again by loadAssetModel: its promise is handed back (of the made model), and loadAssetModel waits on that one job.
 * The builder gets this = { palette: engine.assets.palette, engine } like any generator in the manifest.
 */
export function buildNow(engine, model) {
  const [name] = nameAndArgs(model), build = engine.assets.builder(name);
  if (!build) return null;
  const v = build.call({ palette: engine.assets.palette, engine }, ...builderArgs(engine, model));
  const made = r => {
    if (r.isBufferGeometry) return engine.assets.handOut(new THREE.Mesh(r, neutralMaterial('character', { vertexColors: !!r.attributes.color })), name);
    if (!r.name) r.name = name;
    return engine.assets.handOut(r, name);
  };
  if (typeof v?.then === 'function') return v.then(made);
  return v ? made(v) : null;
}

const STRINGS = {
  unknown: 'Character model "{name}" is not a registered model asset (registered: {list}). Fix: use one of those names, or register it first: engine.assets.manifest({ models: { {name}: \'/models/{name}.glb\' } }). A procedural body is a generator in an asset pack (engine.assets.manifest(yourAssets)); without a model the player is a gray capsule',
  failed: 'Character model "{name}" did not load ({why}); the character keeps its placeholder body. Registered models: {list}; engine.loading has the error',
};

/**
 * Start loading the asset model for ch; returns the promise stored as ch.whenReady (never rejects).
 * Throws at once when no model asset has the name (paths with / or . load as files).
 * @param {import('./Character.js').Character} ch
 * @param {string | any[]} model a name, or [name, ...args]
 * @param {(model: any) => void} use builds the model and Animator on ch
 * @param {Promise<any>} [job] the promise buildNow got from an async builder: the one run of it, so the generator is not called a second time
 */
export function loadAssetModel(ch, model, use, job) {
  const e = ch.engine, A = e.assets, [name, ...args] = nameAndArgs(model);
  const names = [...A.entries].filter(([, x]) => x.type === 'model' && x.named).map(([n]) => n);
  const list = names.join(', ') || 'none; register them with engine.assets.manifest({ models })';
  if (!names.includes(name) && !/[/.]/.test(name)) throw codedError('character-option', fmt(STRINGS.unknown, { name, list }));
  // shortcut: arguments reach generators built on the spot; a file or an async generator cannot take them here, so it stops rather than drop them. Upgrade when a game needs an async one
  if (args.length) throw codedError('character-option', `Character model ${JSON.stringify(model)}: arguments work on a generator that builds synchronously, and "${name}" does not`);
  const fail = why => warnOnce(fmt(STRINGS.failed, { name, why, list }));
  const swap = m => {
    if (ch.disposed || e.disposed) { e.remove(m); return; }   // removed before loading finished: never reaches the scene, the copy is released
    // a registered file that failed resolves to the assets gray box: the character's own placeholder body is the better stand-in
    if (m.name === 'placeholder' && e.loading.get(name, 'model')?.phase === 'failed') { e.remove(m); fail('load failed'); return; }
    const rig = ch._rig;   // drop the placeholder body and the joint properties it put on the character
    for (const k in rig.joints || {}) if (ch[k] === rig.joints[k]) delete ch[k];
    e.characters?._capsules.delete(rig.capsule);
    e.remove(rig.root);
    ch._rig = ch.hips = ch.head = null; ch.limbs = [];
    use(m);
    e.events.emit('character:model', { character: ch, model: m });
  };
  // already loaded (another NPC uses it, or this one was built before): swap now, so a character rebuilt far -> near never shows the placeholder
  const now = !job && A.entries.get(name)?.value ? A.modelNow(name) : null;   // only when loaded: modelNow hints in dev when nothing loads it
  if (now) { swap(now); return Promise.resolve(); }
  ch.ready = false;
  return (job ?? A.model(name)).then(swap).catch(err => { if (!ch.disposed) fail(err.message); }).finally(() => { ch.ready = true; });
}
