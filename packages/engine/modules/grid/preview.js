// Placement preview (engine.grids.preview): picks the target cell every frame (under the pointer, in front of the player, or from
// your function), keeps a rotation turned by an input action, asks can(), and shows a see-through footprint
// (grids({ ok, bad }) colors). It never changes gameplay state: place() runs the grid.place op with what it shows.
// The picture is a replaceable part: draw: false (no visual, the handle still answers), or (engine) => ({ update(view), hide(), dispose() }); pv.material is the default box's.
import * as THREE from 'three';
import { neutralMaterial } from '../../render/neutral.js';
import { screenToGround } from '../../core/scene/screenToGround.js';
import { warnOnce, needMaterial, fmt } from '../../core/base/validate.js';
import { failure } from '../../core/ops/opsFail.js';
import { codedError } from '../../core/base/errorHints.js';

const NO_KEY = 'grids.preview(): the action "{a}" has no keys, so the preview cannot be turned by input. Bind it (engine.input.bind("{a}", ["KeyR"]) or presets.bindings.gridRotate), or pass rotate: false and call pv.rotate() from your own control';

/** Default picture: a flat translucent box over the footprint @internal */
function boxPart(e, st) {
  const own = neutralMaterial('decal', { transparent: true, opacity: st.previewOpacity, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), own);
  mesh.name = 'grid:preview'; mesh.visible = false; mesh.renderOrder = 2;
  e.add(mesh, { owner: 'engine:grid' });
  const ok = new THREE.Color(st.ok), bad = new THREE.Color(st.bad), h = st.previewHeight;
  return {
    get material() { return mesh.material; },
    set material(m) {
      needMaterial('grids-misuse', 'pv.material', m);
      mesh.material = m;
    },
    update(v) {
      mesh.visible = true;
      mesh.scale.set(v.size[0] - 0.04, h, v.size[1] - 0.04);
      mesh.position.set(v.center.x, v.center.y + h / 2, v.center.z);
      /** @type {any} */ (mesh.material).color?.copy(v.ok ? ok : bad);   // telling can from cannot is the preview's job, on any material that has a color
    },
    hide() { mesh.visible = false; },
    dispose() { mesh.material = own; e.remove(mesh); },   // the one free is e.remove (design 6.2): the part's own box and material go with it; a material the game set is taken off first, so it stays the game's
  };
}

/** Where the target is this frame (world position) or null @internal */
function target(e, from, g) {
  if (typeof from === 'function') return from(e);
  if (from === 'front') {
    const p = e.actorPosition(); if (!p) return null;   // whoever the user controls (engine.actor)
    const body = e.actor === 'player' ? e.player : null, f = body?.facing ?? e.world?.get(e.actor)?.facing ?? 0, d = g.cell;
    return { x: p.x + Math.sin(f) * d, z: p.z + Math.cos(f) * d };
  }
  const ptr = e.input.pointer;
  return screenToGround(e, ptr.ndcX, ptr.ndcY);
}

/** Create a preview handle @internal */
export function makePreview(e, grids, opts) {
  const { grid, item, from = 'pointer', rotate = 'rotate', draw } = opts;
  const g = grids._must(grid), rule = grids._rule(item);
  // declared by the preview, owned by the grid module and taken away with the preview (or the module), so nothing outlives it; the game binds
  // the key (presets.bindings.gridRotate) like every module action
  const decl = rotate ? e.input.define(rotate, { label: 'grid.rotate', owner: 'grids', optional: true }) : null;
  if (rotate && !e.input.keysOf(rotate).length) warnOnce(fmt(NO_KEY, { a: rotate }));
  const part = draw === false ? null : typeof draw === 'function' ? draw(e) : boxPart(e, grids);
  const h = {
    /** target cell or null (nothing under the pointer) */ cell: null,
    rotation: opts.rotation ?? 0,
    /** why it cannot be placed: 'noTarget' or the grid.can() code; null when ok */ ok: false, code: 'noTarget',
    /** The default box's three.js material (null with draw: false or your own part). Set it to swap the picture, used as given; its color still shows ok / bad */
    get material() { return part?.material ?? null; },
    set material(m) {
      if (!part || !('material' in part)) throw codedError('grids-misuse', "pv.material: this preview has draw: false or your own part, so it draws no default box");
      part.material = m;
    },
    /** Turn by quarter turns (the rotate action does this too) */
    rotate(n = 1) { h.rotation = (((h.rotation + n) % 4) + 4) % 4; },
    /** Run grid.place with the shown cell and rotation; returns the op result */
    place(fields) {
      if (!h.cell) return failure('noTarget');
      return e.ops.run('grid.place', { grid, item, cell: h.cell, rotation: h.rotation, ...(fields ? { fields } : {}) });
    },
    /** Remove the preview (cancel convention: safe to call again) */
    remove() { if (!grids._previews.delete(h)) return; decl?.remove(); part?.dispose?.(); },
    /** @internal */
    frame() {
      if (rotate && e.input.pressed(rotate)) h.rotate(1);
      const p = target(e, from, g);
      h.cell = p ? g.toCell(p) : null;
      if (!h.cell) { h.ok = false; h.code = 'noTarget'; part?.hide?.(); return; }
      const r = g.can(item, h.cell, { rotation: h.rotation });
      h.ok = r === true; h.code = r === true ? null : r;
      const [w, d] = h.rotation & 1 ? [rule.size[1], rule.size[0]] : rule.size;
      part?.update?.({ grid, item, cell: h.cell, rotation: h.rotation, cells: g.footprint(h.cell, rule.size, h.rotation),
        center: g.toWorld(h.cell, rule.size, h.rotation), size: [w * g.cell, d * g.cell], ok: h.ok, code: h.code });
    },
  };
  grids._previews.add(h);
  return h;
}
