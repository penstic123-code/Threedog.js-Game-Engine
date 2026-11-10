// TSL objectOrigin(): world origin of the drawn object / instance (the `ip` of GLSL threedog_wind_vertex).
// GLSL version: modelMatrix * instanceMatrix * vec4(0,0,0,1). three has no public instance-matrix node; the first experiment wrapped mesh.instanceMatrix
// in a second instanced attribute, which tied the material to one mesh. Like three's own instancing (referenceAttribute('instanceMatrix')), the columns here
// are read from the object being drawn at build time, each object binding its own, so several InstancedMeshes can share one material.
// Why columns, and one node per column for the whole page: every vertex input counts against the device's 16 (WebGPU maxVertexAttributes, WebGL2
// MAX_VERTEX_ATTRIBS), and three's instancing already spends 4 on the matrix, temporalAA's velocity 4 more on last frame's. A fresh mat4 attribute per call
// cost 4 inputs each time, so wind and the near fade on grass with temporalAA needed 21. Now the origin is column 3 alone (instanceMatrix * (0,0,0,1) is
// exactly that column), and every call in a program shares it: one input for the origin, 4 at most with instanceOffset(). The column views the same GPU
// buffer as three's matrix, so no vertex buffer is added.
// three takes this path only while vertex buffers suffice (Instance.js canReferenceInstanceData, 8-buffer limit); otherwise it compiles per mesh,
// which would mean copying three's private logic, so that case throws by name. BatchedMesh's batch matrices are also private to three: same error.
import { Fn, vec4, mat3, modelWorldMatrix, referenceAttribute } from 'three/tsl';
import { ReferenceAttributeNode, InterleavedBufferAttribute } from 'three/webgpu';   // three/webgpu, not three: threedog/tsl stays WebGL-free (both share three.core.js)
import { codedError } from '../../core/base/errorHints.js';

const MAX_VERTEX_BUFFERS = 8;   // three/src/nodes/accessors/Instance.js (same constant, same test)
/** what render/vertexInputs.js names these inputs in a vertex-input error */
const LABEL = 'the instance origin of threedog/tsl objectOrigin() / instanceOffset() (engine wind, near fade)';

const VIEWS = new WeakMap();   // instanceMatrix -> its column views, made as three makes its own (ReferenceAttributeNode.js getAttributeColumn)
/** One column (vec4) of the drawn InstancedMesh's instanceMatrix, bound per object like three's referenceAttribute */
class InstanceColumn extends ReferenceAttributeNode {
  /** @param {number} column 0..3 */
  constructor(column) { super('instanceMatrix', 'vec4'); this.column = column; this.threedogLabel = LABEL; }
  /** @param {any} object */
  getValueFromReference(object) {
    const m = object?.instanceMatrix;
    if (!m) return m;
    let v = VIEWS.get(m);
    if (!v) VIEWS.set(m, v = []);
    return v[this.column] ??= new InterleavedBufferAttribute(m, 4, this.column * 4);
  }
}
// one node per column for every program: three keeps a node's build data per builder, so all calls in one program read one input each
const COLUMNS = [0, 1, 2, 3].map(i => /** @type {any} */ (new InstanceColumn(i)));

/**
 * The columns of the object being built's instance matrix, null when it is not instanced (throws for what three binds privately).
 * A storage matrix is read whole: storage reads cost no vertex input.
 * @param {any} builder @returns {{ column: (i: number) => import('three/webgpu').Node<'vec4'> } | null}
 */
function instanceMatrixOf(builder) {
  const o = builder.object;
  if (o?.isBatchedMesh) throw codedError('tsl-misuse', 'threedog/tsl objectOrigin(): BatchedMesh is not supported in TSL yet');
  if (!o?.isInstancedMesh) return null;
  const buffers = 1 + (o.instanceColor !== null ? 1 : 0) + (builder.needsPreviousData() ? 1 : 0);
  if (builder.renderer?.isRenderer !== true || Object.keys(o.geometry.attributes).length + buffers > MAX_VERTEX_BUFFERS)
    throw codedError('tsl-misuse', `threedog/tsl objectOrigin(): InstancedMesh '${o.name || o.uuid}' has too many vertex attributes for a shared instance matrix`);
  if (o.instanceMatrix.isStorageInstancedBufferAttribute) {
    // @types/three types referenceAttribute() as a bare ReferenceAttributeNode (no node type, no operators); with 'mat4' it is a mat4 node
    const m = /** @type {any} */ (referenceAttribute('instanceMatrix', 'mat4'));
    return { column: i => m.element(i) };
  }
  return { column: i => COLUMNS[i] };
}

/** World position of the object's (or instance's) origin, vec3 */
export const objectOrigin = Fn((_, builder) => {
  const m = instanceMatrixOf(builder);
  return modelWorldMatrix.mul(m ? m.column(3) : vec4(0, 0, 0, 1)).xyz;
});

/**
 * An object-space offset carried through the instance's rotation / scale: GLSL patches add offsets before instanceMatrix,
 * a TSL positionNode runs after it, so wind()'s offset goes through this to land the same
 */
export const instanceOffset = Fn(/** @param {[import('three/webgpu').Node<'vec3'>]} a @param {any} builder */ ([v], builder) => {
  const m = instanceMatrixOf(builder);
  return m ? mat3(m.column(0).xyz, m.column(1).xyz, m.column(2).xyz).mul(v) : v;
});
