// The procedural body of a Character (split out of Character.js): the gray capsule used when no model gives a body, attaching a rig, reading a rig
// out of a model asset (a pack's humanoid), per-character part colors, and the limb swing / body bob used without skeletal animation.
// A rig is { root, body?, head?, joints?: { name: Group }, limbs: [{ joint, offset: 0 | Math.PI, amp, kind: 'arm' | 'leg', side? }] }.
// A model asset carries the same thing as plain data by object NAME in root.userData.rig: names, not references, because userData survives
// clone and GLB export and object references do not; so a procedural builder and a baked / hand-made GLB with those names animate the same way.
import * as THREE from 'three';
import { neutralMaterial } from '../../render/neutral.js';
import { cloneMaterial, isEngineMade, markEngineMade } from '../../render/patches.js';
import { warnOnce } from '../../core/base/validate.js';

/** Warned once when no model gives the character a body */
export const NO_CHARACTER = 'characters: no model given, so characters are gray capsules (a placeholder). Character bodies are assets: '
  + "register a pack's models (engine.assets.manifest(yourAssets)) and pass addPlayer({ model: 'yourBody' }), "
  + "a GLB asset name ({ model: 'hero' }), or a ready body ({ rig })";

/**
 * The rig a model asset describes in root.userData.rig ({ body, head, joints: [names], limbs: [{ joint: name, offset, amp, kind, side }] }), names
 * resolved to this copy's objects; null without rig data (a skinned GLB animates by clips instead).
 * @param {THREE.Object3D} root
 */
export function rigFromObject(root) {
  const d = root?.userData?.rig;
  if (!d) return null;
  const get = n => {
    const o = n ? root.getObjectByName(n) : null;
    if (n && !o) warnOnce(`character model "${root.name || 'model'}": userData.rig names "${n}", but the model has no object with that name. Change the name in root.userData.rig to an existing descendant's name, or rename that object in the model; check with root.getObjectByName(name)`);
    return o || null;
  };
  const joints = {};
  for (const n of d.joints || []) { const o = get(n); if (o) joints[n] = o; }
  const limbs = (d.limbs || []).map(L => ({ ...L, joint: get(L.joint) })).filter(L => L.joint);
  return { root, body: get(d.body), head: get(d.head), joints, limbs };
}

/**
 * Per-character part colors ({ colors: { body: 0x4f6d8f } }): meshes marked userData.part get their own copy of the material in that color.
 * A copy, because asset copies share materials: recoloring in place would recolor every character using the model.
 */
export function tintParts(root, colors) {
  if (!colors || !Object.keys(colors).length) return;
  root.traverse(o => {
    const c = o.isMesh ? colors[o.userData.part] : null;
    if (c == null || !o.material?.color) return;
    o.material = cloneMaterial(o.material); o.material.color.set(c);   // the tinted copy keeps wind / cloud / pack shader patches
  });
}

/** The gray every capsule is until the game sets engine.characters.material (colors.body gives one capsule a copy in its own color) @internal */
export const capsuleDefault = () => neutralMaterial('character', { color: 0x8a8a8a });

/** A capsule's material: the shared one, or a copy of it in the character's own color (a material without .color has nothing to tint) @internal */
export function capsuleMaterial(base, color) {
  if (color == null) return base;
  const m = cloneMaterial(base);
  m.color?.set(color);
  if (isEngineMade(base)) markEngineMade(m);
  return m;
}

/** Neutral placeholder when no model gives a body: one gray capsule, no limbs (body shapes belong to asset packs) */
export function capsule(color, engine) {
  const body = new THREE.Group(); body.position.y = 0.85;
  // new Character() also works without the characters module: then this capsule has no shared material to take
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.0, 4, 12).translate(0, -0.05, 0), capsuleMaterial(engine.characters?.material ?? capsuleDefault(), color));
  engine.characters?._capsules.set(m, color);   // not the scene: a character is drawn only once its root is in the scene, and a swap must reach it before that too
  m.castShadow = true; body.add(m);
  const root = new THREE.Group(); root.add(body);
  return { root, body, capsule: m };
}

/** Put a rig under the character root and remember its parts */
export function useRig(ch, rig) {
  if (rig.root.parent !== ch.root) ch.root.add(rig.root);
  ch._rig = rig;
  ch.hips = rig.body || rig.root; ch.head = rig.head || null;
  ch.bodyBase = ch.hips.position.y;
  ch.limbs = rig.limbs || [];
  // named joints (a humanoid rig: armL armR legL legR) become properties so game poses can grab them; never shadow a Character field
  for (const k in rig.joints || {}) {
    if (!(k in ch)) ch[k] = rig.joints[k];
    else if (ch[k] !== rig.joints[k]) warnOnce(`character rig: joint "${k}" has the same name as the Character field ch.${k}, so ch.${k} stays the field; use rig.joints.${k} (or rename the joint)`);
  }
}

/** Swing the limbs and bob the body for the current state (sp = move amount, t = elapsed seconds, st = character state) */
export function animateRig(ch, sp, t, st) {
  const amp = Math.min(1, sp / ch.runSpeed + 0.35);
  let bob = 0, lean = 0;
  for (const L of ch.limbs) {
    let rx = 0, rz = 0;
    const arm = L.kind === 'arm';
    if (st === 'swim') {
      rx = Math.sin(ch.phase * (arm ? 0.9 : 1.4) + L.offset) * (arm ? 1.6 : 0.5);
      rz = arm ? 0.4 * (L.side || 0) : 0;
    } else if (st === 'jump' || st === 'fall') {
      rx = L.kind === 'leg' ? (L.offset ? -0.5 : 0.7) : -0.6;
      rz = arm ? 0.5 * (L.side || 0) : 0;
    } else if (sp > 0.4) rx = Math.sin(ch.phase + L.offset) * L.amp * amp;
    else rx = arm ? Math.sin(t * 1.5) * 0.04 : 0;
    L.joint.rotation.x = rx; if (arm) L.joint.rotation.z = rz || 0.05 * (L.side || 0);
  }
  if (st === 'swim') lean = 1.0;
  else if (sp > 0.4 && ch.grounded) { bob = Math.abs(Math.cos(ch.phase)) * 0.08 * amp; lean = sp / ch.runSpeed * 0.25; }
  else if (ch.grounded) bob = Math.sin(t * 2) * 0.01;
  ch.hips.position.y = ch.bodyBase + bob;
  ch.hips.rotation.x = lean;
  if (ch.head) ch.head.rotation.x = -lean * 0.6;
}
