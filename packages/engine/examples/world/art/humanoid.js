// The 'humanoid' body: the procedural character body, exported in the world example's asset pack (art/index.js `assets`), so a character picks it like any model:
// addPlayer({ model: 'humanoid' }), npcs content { model: 'humanoid' }. It is an asset and not part of the picture because a body is content the
// game chooses per character (a GLB hero next to procedural villagers), while the picture only decides how things look.
// Each part uses a material by name from picture/materials.js (skin / cloth / trousers / hair), so one change there retints every humanoid.
// Per-character colors ({ colors: { body, skin, legs, hair } }) recolor the parts marked userData.part.
// The rig (which object is the hips, which joints swing) is plain data by NAME in root.userData.rig, because names survive asset copies and
// GLB export: Character reads it back (rigFromObject) and swings the limbs for walk / run / swim / jump.
import * as THREE from 'three';
import { mat } from '../picture/materials.js';

// part (the key of a character's `colors`) -> material name
const MATERIAL = { body: mat.cloth, skin: mat.skin, legs: mat.trousers, hair: mat.hair };

/**
 * Low-poly humanoid (cylinder body, icosahedron head, box limbs). Each joint is a named empty Group with the limb under it; rotating it swings
 * the limb. Joints armL / armR / legL / legR are exposed on the character (c.armL ...).
 */
export function humanoid() {
  const mesh = (geo, part, name) => { const m = new THREE.Mesh(geo, MATERIAL[part]); m.castShadow = true; m.userData.part = part; m.name = name; return m; };
  const group = (name, parent, x, y) => { const g = new THREE.Group(); g.name = name; g.position.set(x, y, 0); parent.add(g); return g; };
  const root = new THREE.Group(); root.name = 'humanoid';
  const hips = group('hips', root, 0, 0.85);
  hips.add(mesh(new THREE.CylinderGeometry(0.28, 0.33, 0.7, 6).translate(0, 0.35, 0), 'body', 'torso'));
  const head = group('head', hips, 0, 0.78);
  head.add(mesh(new THREE.IcosahedronGeometry(0.27, 0).translate(0, 0.2, 0), 'skin', 'face'));
  head.add(mesh(new THREE.IcosahedronGeometry(0.28, 0).scale(1, 0.55, 1).translate(0, 0.36, -0.03), 'hair', 'hairCap'));
  const limb = (name, len, w, part, x, y) => { const j = group(name, hips, x, y); j.add(mesh(new THREE.BoxGeometry(w, len, w).translate(0, -len / 2, 0), part, name + 'Mesh')); };
  limb('armL', 0.6, 0.13, 'body', -0.37, 0.65); limb('armR', 0.6, 0.13, 'body', 0.37, 0.65);
  limb('legL', 0.85, 0.17, 'legs', -0.14, 0.02); limb('legR', 0.85, 0.17, 'legs', 0.14, 0.02);
  root.userData.rig = {
    body: 'hips', head: 'head', joints: ['armL', 'armR', 'legL', 'legR'],
    limbs: [
      { joint: 'legL', offset: 0, amp: 0.9, kind: 'leg' }, { joint: 'legR', offset: Math.PI, amp: 0.9, kind: 'leg' },
      { joint: 'armL', offset: Math.PI, amp: 0.8, kind: 'arm', side: -1 }, { joint: 'armR', offset: 0, amp: 0.8, kind: 'arm', side: 1 },
    ],
  };
  return root;
}
