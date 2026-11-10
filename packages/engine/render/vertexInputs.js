// Vertex inputs of a WebGPURenderer program, counted before three writes its code.
// A program takes 16 vertex inputs on most devices (WebGPU maxVertexAttributes, WebGL2 MAX_VERTEX_ATTRIBS) and, on WebGPU, 8 vertex buffers. Inputs stack
// up from parts that know nothing of each other: the geometry attributes the material reads, three's instancing (matrix 4, color 1), last frame's matrix
// for the velocity buffer (4, temporalAA / motion blur), engine patches, the game's own attribute nodes. Over the limit, three's error comes late and
// names no feature (WebGL2 'Attribute location out of range', WebGPU 'pipeline creation failed'). Counted where every node has asked for its inputs and
// no code exists yet (the builder's buildCode): the throw lands in three's build-error path, which logs it and draws its plain stand-in instead.
import { codedError } from '../core/base/errorHints.js';

const LIMITS = new WeakMap();
/** @param {any} r @returns {{ inputs: number, buffers: number }} buffers: Infinity where the backend has no such limit (WebGL2) */
function vertexLimits(r) {
  let l = LIMITS.get(r);
  if (!l) {
    const b = r.backend, gl = b?.gl;
    l = b?.device ? { inputs: b.device.limits.maxVertexAttributes, buffers: b.device.limits.maxVertexBuffers }
      : { inputs: gl?.getParameter(gl.MAX_VERTEX_ATTRIBS) ?? 16, buffers: Infinity };
    LIMITS.set(r, l);
  }
  return l;
}
const PREVIOUS = "last frame's instance matrix (the velocity buffer: temporalAA, motion blur)";
/** What one vertex input of a program is for, and the buffer it reads @param {any} a a NodeAttribute of the builder @param {any} o the drawn object */
function inputOf(a, o) {
  const n = a.node;
  if (!n) { const g = o?.geometry?.getAttribute?.(a.name); return { label: 'geometry attributes the material reads', name: a.name, buffer: g?.data ?? g ?? a.name }; }
  const ref = n.referenceNode, at = n.getObjectAttribute?.(o) ?? n.attribute, buffer = at?.isInterleavedBufferAttribute ? at.data : at;
  // engine nodes say what they are (threedogLabel: render/fx/objectOrigin.tsl.js); then three's instancing, by the buffer it reads
  const label = ref?.threedogLabel ?? n.threedogLabel ?? (ref?.property === 'previousInstanceMatrix' ? PREVIOUS
    : buffer && buffer === o?.instanceMatrix ? 'the instance matrix (InstancedMesh)' : buffer && buffer === o?.instanceColor ? 'the instance color'
      : buffer?.isInstancedBufferAttribute && buffer.itemSize === 16 ? PREVIOUS : "the material's own attribute nodes (attribute(), instancedBufferAttribute() ...)");
  return { label, buffer: buffer ?? n };
}
const SLOTS = { mat2: 2, mat3: 3, mat4: 4 };
/**
 * @internal render/backend.js watchNodePrograms, for every node program before its code is written.
 * Throws, naming what stacked up, when the program being built needs more vertex inputs (or buffers) than the device has @param {any} builder @param {any} r
 */
export function checkVertexInputs(builder, r) {
  const all = [...builder.attributes, ...builder.bufferAttributes], max = vertexLimits(r);
  const n = all.reduce((s, a) => s + (SLOTS[a.type] ?? 1), 0);
  const parts = all.map(a => ({ ...inputOf(a, builder.object), slots: SLOTS[a.type] ?? 1 })), buffers = new Set(parts.map(p => p.buffer)).size;
  if (n <= max.inputs && buffers <= max.buffers) return;
  const groups = new Map();
  for (const p of parts) { const g = groups.get(p.label) ?? { slots: 0, names: [] }; g.slots += p.slots; if (p.name) g.names.push(p.name); groups.set(p.label, g); }
  const list = [...groups].map(([label, g]) => `${label}${g.names.length ? ` ${g.names.join(', ')}` : ''}: ${g.slots}`).join('; ');
  const m = builder.material, o = builder.object;
  throw codedError('vertex-inputs', `[threedog] ${m?.type}${m?.name ? ` '${m.name}'` : ''} on ${o?.type ?? 'object'} '${o?.name || '(unnamed)'}' needs ${n} vertex inputs`
    + (max.buffers < Infinity ? ` in ${buffers} vertex buffers` : '') + `, this device takes ${max.inputs}` + (max.buffers < Infinity ? ` in ${max.buffers}` : '')
    + ` (${list}). To fit: drop what the shader does not need (an attribute the material never reads is free; geometry.deleteAttribute, instanceColor = null), `
    + 'pack several per-instance values into one vec4, or keep per-instance data in a storage buffer (instancedArray / storage from three/tsl, read with instanceIndex: '
    + "no vertex input); last frame's instance matrix is only there for the velocity buffer (temporalAA off: antialias draws with MSAA)");
}
