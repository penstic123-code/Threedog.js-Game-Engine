// Page side of the picture check (probe.mjs says how these files run): the budget, a black frame, fog, key against fill, a camera inside a mesh.

/** Budget: real lights and shadow maps against engine.budget, the same values and limits budget.report() reads, so a game's own lights count too */
export function probeBudget({ e, scene, out }) {
  if (e.budget?.values) {
    const B = e.budget, v = B.values(), over = [];
    for (const category of ['lights', 'shadowLights', 'shadowMaps', 'shadowMapSize']) {
      const limit = B.limitOf(category);
      if (limit != null && v[category] > limit) over.push({ category, value: v[category], limit, own: B.limits[category] != null });
    }
    if (over.length) {
      const cast = [];
      scene.traverse(o => { if (o.isLight && o.castShadow && o.visible && o.shadow) cast.push({ name: o.name || o.uuid.slice(0, 8), type: o.type, size: o.shadow.mapSize.x }); });
      out.budget = { tier: e.tier, pool: !!e.lightPool, over, casters: cast.sort((a, b) => b.size - a.size).slice(0, 3) };
    }
  }
}

export function darkShare({ raw }) { let n = 0; for (let i = 0; i < raw.length; i += 4) if (Math.max(raw[i], raw[i + 1], raw[i + 2]) <= 20) n++; return n / (raw.length / 4); }

/**
 * A black frame: which material, hidden alone, brings the picture back. Why: a game's ShaderMaterial that outputs NaN / Inf turned the whole frame black
 * through the post chain (bloom spreads it) with no error anywhere. Newest materials first (material.id grows), visibility only.
 */
export function probeBlack(c) {
  const { R, e, scene, base, mean, grab, out } = c;
  if (mean(base) < 0.02 && darkShare(c) >= 0.95) {
    const byMat = new Map();
    scene.traverse(o => { if (o.isMesh && o.visible) for (const m of [].concat(o.material)) if (m) (byMat.get(m) ?? byMat.set(m, []).get(m)).push(o); });
    // the shader compile state: a program that failed to link draws nothing and logs once, long before anyone looks at a black picture
    const broken = (R.info?.programs ?? []).filter(p => p.diagnostics && p.diagnostics.runnable === false).map(p => p.name || p.cacheKey?.slice(0, 40));
    const black = { post: !!e.post?.active, tried: 0, culprit: null, broken };
    // shortcut: the 12 newest materials only (one render each); a scene with more names none and says how many it tried
    for (const [m, meshes] of [...byMat].sort((a, b) => b[0].id - a[0].id).slice(0, 12)) {
      black.tried++;
      meshes.forEach(o => { o.visible = false; });
      let L; try { L = grab(); } finally { meshes.forEach(o => { o.visible = true; }); }
      if (mean(L) >= 0.05 && darkShare(c) < 0.9) { black.culprit = { name: m.name || `${m.type} ${m.uuid.slice(0, 8)}`, type: m.type, meshes: meshes.length, luminance: mean(L) }; break; }
    }
    black.materials = byMat.size;
    out.black = black;
    grab();   // raw back to the shot's own frame for the probes below
  }
}

/**
 * Fog: how much of the picture the fog color makes up. Two renders with the fog color black and white (a uniform, no recompile): where they differ by
 * more than half of the most-fogged pixel's difference, the fog is most of that pixel. Why: a dark fog from 14 m swallowed most of a night street and
 * three rounds of color changes went nowhere; the other facts never named it.
 */
export function probeFog({ scene, grab, out }) {
  if (scene.fog?.color) {
    const fc = scene.fog.color.clone();
    let Lb, Lw;
    try { scene.fog.color.setRGB(0, 0, 0); Lb = grab(); scene.fog.color.setRGB(1, 1, 1); Lw = grab(); } finally { scene.fog.color.copy(fc); }
    let top = 0; for (let i = 0; i < Lb.length; i++) top = Math.max(top, Lw[i] - Lb[i]);
    let n = 0; if (top > 0.05) for (let i = 0; i < Lb.length; i++) if (Lw[i] - Lb[i] >= 0.5 * top) n++;
    const f = scene.fog;
    out.fog = { share: n / Lb.length, color: '#' + fc.getHexString(), setting: f.isFogExp2 ? `density ${f.density}` : `near ${f.near} far ${f.far}` };
    grab();
  }
}

/**
 * Key against fill: the sun / key light off once, then the fill (hemisphere, ambient, environment) off once. Why: a flat daytime picture with "no sense
 * of light" had no hint at all; how much of the brightness comes from the direct light and how much from the fill is the fact behind it (the hint
 * 'light-balance'). Two renders, intensities only.
 */
export function probeKey({ scene, sun, hemi, base, mean, grab, out }) {
  if (sun && sun.visible && sun.intensity > 0) {
    const B = mean(base), kw = sun.intensity;
    sun.intensity = 0;
    let noKey; try { noKey = mean(grab()); } finally { sun.intensity = kw; }
    const fill = []; scene.traverse(o => { if (o.isLight && o !== sun && (o === hemi || o.isAmbientLight || o.isHemisphereLight)) fill.push([o, o.intensity]); });
    const envWas = scene.environmentIntensity;
    fill.forEach(([o]) => { o.intensity = 0; }); scene.environmentIntensity = 0;
    let noFill; try { noFill = mean(grab()); } finally { fill.forEach(([o, v]) => { o.intensity = v; }); scene.environmentIntensity = envWas; }
    out.key = { base: B, noKey, noFill };
  }
}

/**
 * Beyond the far plane: a visible mesh whose whole bounding sphere is farther than camera.far from the camera is never drawn from here. Why: a flat world with
 * no terrain keeps the engine's default far plane, and distant buildings were cut off with no message anywhere. No render. BackSide meshes (a sky dome is meant to
 * be seen from inside) are skipped. The fog's far is reported beside it when it lies past the cut.
 */
export function probeFar({ T, scene, cam, out }) {
  const cp = cam.getWorldPosition(new T.Vector3()), s = new T.Sphere(), far = cam.far;
  let total = 0, beyond = 0, nearest = Infinity;
  scene.traverseVisible(o => {
    if (!o.isMesh || !o.geometry || [].concat(o.material).some(m => m?.side === T.BackSide)) return;
    total++;
    if (o.isInstancedMesh) { if (!o.boundingSphere) o.computeBoundingSphere(); s.copy(o.boundingSphere); }
    else { if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere(); s.copy(o.geometry.boundingSphere); }
    const d = cp.distanceTo(s.applyMatrix4(o.matrixWorld).center) - s.radius;
    if (d > far) { beyond++; nearest = Math.min(nearest, d); }
  });
  if (beyond) out.far = { far, beyond, total, nearest: Math.round(nearest), fogFar: scene.fog?.far > far ? scene.fog.far : null };
}

/**
 * Camera inside a mesh: the first shot of a demo stood inside a building and the output only gave the camera position. A mesh counts when the camera is
 * inside its world box AND rays along the six axes all leave it through a back face (closed around the camera). BackSide materials are skipped: a sky
 * dome is meant to be seen from inside. No render; material.side is put back right after the ray.
 */
export function probeCameraInside({ T, scene, cam, out }) {
  const cp = cam.getWorldPosition(new T.Vector3()), box = new T.Box3(), rc = new T.Raycaster(), n = new T.Vector3();
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(d => new T.Vector3(...d));
  const cands = [];
  scene.traverse(o => {
    if (!o.isMesh || !o.visible || !o.geometry || o.isInstancedMesh || o.isSkinnedMesh) return;
    const mats = [].concat(o.material);
    if (mats.some(m => m?.side === T.BackSide)) return;
    if (box.setFromObject(o).containsPoint(cp)) cands.push(o);
  });
  for (const o of cands.slice(0, 20)) {
    const mats = [].concat(o.material), sides = mats.map(m => m.side);
    let back = 0;
    mats.forEach(m => { m.side = T.DoubleSide; });
    try {
      for (const d of dirs) {
        rc.set(cp, d);
        const h = rc.intersectObject(o, false)[0];
        if (h?.face && n.copy(h.face.normal).transformDirection(o.matrixWorld).dot(d) > 0) back++;
      }
    } finally { mats.forEach((m, i) => { m.side = sides[i]; }); }
    if (back === 6) { out.cameraInside = { name: o.name || `${o.type} ${o.uuid.slice(0, 8)}`, camera: [cp.x, cp.y, cp.z] }; break; }
  }
}
