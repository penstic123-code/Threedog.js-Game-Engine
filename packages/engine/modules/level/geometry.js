// Geometry the level module derives from its meshes: world-space triangles of the walkable meshes (for the physics module's static colliders) and the
// best-fit rotated boxes of the collision meshes. Pure functions: no engine, no state.
import * as THREE from 'three';
import { warnOnce } from '../../core/base/validate.js';
import { coded } from '../../core/base/errorHints.js';

/** World-space triangles of meshes: [{ positions: Float32Array, indices: Uint32Array }] */
export function worldTrimeshes(meshes) {
  return meshes.map(m => {
    const g = m.geometry, pos = g.attributes.position, v = new THREE.Vector3();
    const positions = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); positions[i * 3] = v.x; positions[i * 3 + 1] = v.y; positions[i * 3 + 2] = v.z; }
    let indices;
    if (g.index) indices = Uint32Array.from(g.index.array);
    else { indices = new Uint32Array(pos.count); for (let i = 0; i < pos.count; i++) indices[i] = i; }
    // mirrored scale (negative determinant) flips triangles; swap order to keep them facing up
    if (m.matrixWorld.determinant() < 0) for (let i = 0; i + 2 < indices.length; i += 3) { const t = indices[i + 1]; indices[i + 1] = indices[i + 2]; indices[i + 2] = t; }
    return { positions, indices };
  });
}

/**
 * Best-fit box of each collision mesh by the mesh's world orientation, as collision.addBox arguments: [{ at: { x, z }, opts }]
 * @param {any[]} meshes
 * @param {{ colliderHeight: number, colliderPad: number, layerOf?: (m: any) => any }} cfg layerOf: the custom property `layer` of a mesh (load.js reads it up the parent chain)
 */
export function colliderBoxes(meshes, { colliderHeight, colliderPad, layerOf = m => m.userData?.layer }) {
  const corner = new THREE.Vector3(), xAxis = new THREE.Vector3(), out = [];
  for (const m of meshes) {
    const g = m.geometry; if (!g) continue;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox, mw = m.matrixWorld;
    xAxis.setFromMatrixColumn(mw, 0);
    const yaw = Math.atan2(-xAxis.z, xAxis.x), c = Math.cos(yaw), s = Math.sin(yaw);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(mw);
      const lx = corner.x * c - corner.z * s, lz = corner.x * s + corner.z * c;   // rotate into the box's own orientation
      x0 = Math.min(x0, lx); x1 = Math.max(x1, lx); z0 = Math.min(z0, lz); z1 = Math.max(z1, lz);
      y0 = Math.min(y0, corner.y); y1 = Math.max(y1, corner.y);
    }
    const lcx = (x0 + x1) / 2, lcz = (z0 + z1) / 2;
    const wx = lcx * c + lcz * s, wz = -lcx * s + lcz * c;                        // rotate the center back to world space
    const h = Math.max(colliderHeight, y1 - y0);
    // custom property `layer` (userData.layer): characters with passes: ['name'] walk through this wall (collision/grid.js passesThrough)
    const ly = layerOf(m), layer = typeof ly === 'string' && ly ? ly : undefined;
    if (ly !== undefined && layer === undefined) warnOnce(coded('level-layer-ignored', `level: collider "${m.name}" has layer ${JSON.stringify(ly)}; a layer is one non-empty text, so this wall stops every mover`), m.name);
    out.push({ at: { x: wx, z: wz }, opts: { halfWidth: (x1 - x0) / 2 + colliderPad, halfDepth: (z1 - z0) / 2 + colliderPad, rotation: yaw, height: h, y: y0, layer } });
  }
  return out;
}
