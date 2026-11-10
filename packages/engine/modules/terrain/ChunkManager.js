// Terrain data part: chunk streaming. Chunks around the engine.stream sources (player, camera focus, teleport destination...) are generated on
// engine.threads workers, kept while near a source, released when far from all.
// LOD is split by ring from the nearest source: the chunk a source stands in plus the one ring around it is ring 1, and so on.
// Visuals and gameplay take effect separately: a generated chunk is handed to the looks at once; collision (forEachCollider, chunkCollision) only takes
// effect at the tick set by engine.commits (c.solid), and is generated on the main thread on the spot if not done by then -- machine speed never
// changes whether the player bumps into a tree (see core/threads/Commits.js).
// Data only: this file makes no mesh and touches no material. Each generated chunk keeps its arrays in c.data (pos, nor, col, uv, tex, top...),
// collision and queries read them, and draw parts subscribe with view({ add, change, remove, show }) (terrain/draw.js is the engine's own).
// Vegetation plugs in as the chunk planter (its data part sets terrain.plants): this file never reads engine.vegetation.
import * as THREE from 'three';
import { createTerrain } from './terrainGen.js';
import { chunkHandler } from './chunkJob.js';
import { TerrainEdits } from './terrainEdit.js';
import { ChunkStream, bookCollision, colliderLag } from '../../core/stream/chunkStream.js';
import { chunkQueries } from './chunkQueries.js';
import { reportError } from '../../core/base/errors.js';
import { codedError } from '../../core/base/errorHints.js';

/** Planter stand-in while no vegetation is installed (the vegetation data part replaces it) */
const NO_VEG = { baseNames: () => [], nearNames: () => [], list: () => [], get: () => null, mount() {}, unmount() {}, release() {}, drop() {} };
// A failed ground job is sent again up to this many times in all (a worker that crashed or ran out of memory usually passes next time); then the
// chunk is marked failed and reported. Before, it sat in 'pending' for ever and the loading screen waited without a word.
const MAX_TRIES = 3;

export class ChunkManager {
  constructor(engine, terrainCfg, ctx) {
    this.engine = engine;
    this.generator = createTerrain(terrainCfg);          // main-thread copy: height queries for the character and camera
    this.chunks = new Map();
    /** @internal view distance in chunks and vegetation density: the module sets both at install (terrain/index.js holds the defaults) */ this._viewChunks = 0; this._density = 0;
    this.applyBudgetMs = 3;                       // max ms per frame spent taking worker results
    this.maxInFlight = 4;
    this.inFlight = 0;
    this.ready = [];
    this._want = [];                              // chunks not yet dispatched (nearest first)
    this.gen = 0;
    this._bookDue = false;                        // book the near-only collider tickets in the next update (_bookNear)
    this._cid = 0;                                // chunk identity counter: a chunk released and made again at the same coordinate is another chunk
    this.vgen = 0;                                // +1 on a density or species change: plants placed before it are asked again
    this.stats = { builtThisFrame: 0, applyMs: 0, queued: 0, failed: 0 };
    /** @internal the draw parts drawing these chunks (view()) */ this.views = new Set();
    /** @internal the vegetation data part, or NO_VEG */ this.plants = NO_VEG;
    /** @internal the engine's terrain drawing (draw.js), null when a game's picture holds the slot */ this.drawPart = null;
    this.lowest = 0;                              // lowest island point loaded (default voidY)
    // which chunks the sources need, ring, culling: shared with vegetation's own-ground chunks (core/stream/chunkStream.js)
    this._stream = new ChunkStream(this, { show: (c, v) => this._emit('show', c, v), level: (c, ring) => this._setLevel(c, ring),
      count: c => { let n = 0; for (const k in c.plants) n += c.plants[k].n; return n; } });

    // one lane of chunk workers (engine.threads); with threads: false or no Worker the same handler runs on the main thread, and a crashed worker
    // falls back to it
    this.lane = engine.threads.lane({ create: () => new Worker(new URL('./chunkWorker.js', import.meta.url), { type: 'module' }), local: chunkHandler });
    this.lane.broadcast({ type: 'init', terrain: terrainCfg, species: {} }, 'init');
    /** @internal edit records (saved with the save) */ this.edits = new TerrainEdits(engine, this, ctx);
  }

  get chunkSize() { return this.generator.CHUNK; }
  // the draw part's entries, here because engine.terrain is where a game looks for them; this file stays data only
  /** @internal */
  _drawPart() { return this.drawPart ?? (() => { throw codedError('terrain-option', "the engine's terrain drawing is not installed: a draw part that replaces 'terrain-draw' draws the ground its own way"); })(); }
  /** Ground material (see TerrainDraw): get the one in use (null under a replaced draw part), set one to swap it on every chunk, drawn as given */
  get material() { return this.drawPart?.material ?? null; }
  set material(m) { this._drawPart().material = m; }
  /** The engine's ground patches (world, clouds, season, detail): applyEffects(myMaterial, { patches: engine.terrain.patches }) */
  get patches() { return this.drawPart?.patches ?? []; }
  /** The detail layer's { value } uniforms, live ({} without a detail layer) */
  get uniforms() { return this.drawPart?.uniforms ?? {}; }
  /**
   * Change at run time what terrain({...}) baked in; colors, biomeColors, steep, variation, shading, normals rebuild every chunk, detail only the material
   * @example engine.terrain.recolor({ colors: { grass: 0x6a8a3a }, biomeColors: { meadow: ['grass'] } });
   * @param {any} o
   * @returns {void}
   */
  recolor(o) { this._drawPart().recolor(o); }
  /**
   * Below it the player or a moving body fell out of the world (terrain:void): shape.voidY, else 50 m under the lowest island
   * chunk loaded (at most -50); -Infinity without a shape
   * @example engine.events.on('terrain:void', ({ who }) => { if (who === engine.player) engine.player.placeAt(home); });
   */
  get voidY() { return this.generator.shape ? this.generator.shape.voidY ?? Math.min(0, this.lowest) - 50 : -Infinity; }
  /** Grid spacing (meters): edits snap to it, and paint colors whole cells of this size. Set by chunkSize / resolution */
  get cellSize() { return this.generator.CELL; }
  /**
   * Change the ground: dig, raise, flatten, or paint the ground type. Call it from an op or a fixed step (it is saved gameplay state).
   * Heights snap to grid points and paint to cells (cellSize); the nearest one is taken when the shape is smaller than a cell.
   * engine.surface / slope / groundType, collision, paths and vegetation (what grew there is removed) follow at once; it is saved,
   * and a chunk unloaded and generated again comes back edited. Paint colors come from biomeColors[type] (gray when the game gave none).
   * @param {import('three').Vector3 | {x:number,z:number} | number[]} position
   * @param {{ radius?: number, shape?: 'circle' | 'square', raise?: number, lower?: number, flatten?: number, paint?: string | null }} opts
   *   radius meters (default half a cell); one of raise / lower (meters) / flatten (target height); paint a type name, null gives back the generated type
   * @returns {{ heights: number, cells: number }} how many grid points and cells changed (0 and 0 off a shape outline)
   * @example
   * engine.ops.define('farm.till', { args: { at: 'position' },
   *   run(e, a) { e.terrain.edit(a.at, { shape: 'square', radius: e.terrain.cellSize / 2, paint: 'tilled' }); } });
   * engine.terrain.edit(pos, { radius: 3, lower: 1.5 });              // dig a pit
   * engine.terrain.edit(pos, { shape: 'square', radius: 6, flatten: engine.surface(pos) });   // level a foundation
   */
  edit(position, opts) { return this.edits.edit(position, opts); }

  /**
   * Hand the terrain its planter (the vegetation data part calls this): it is told when chunks mount, unmount and drop. Returns a handle;
   * remove() puts the empty planter back if this one is still set.
   * @param {object} planter
   * @returns {{ remove(): void }}
   * @internal
   */
  setPlanter(planter) {
    this.plants = planter;
    return { remove: () => {
      if (this.plants !== planter) return;
      this.plants = NO_VEG;
      // everything it put into the terrain goes with it: the rules in the workers, the jobs in flight (a newer vgen sends their results back), the colliders' tickets
      this.vgen++;
      for (const sp of planter.list()) this.lane.broadcast({ type: 'species', name: sp.name, rule: null }, 'species:' + sp.name);
      for (const c of this.chunks.values()) for (const n in c.near) this._cancelNear(c, n);
    } };
  }

  /**
   * Draw these chunks. Hooks: add(c) (generated: c.data holds the arrays pos / nor / col / uv / tex, c.cx / c.cz the chunk), change(c) (an edit
   * rewrote c.data; the vertex count can differ on the rim of a shape with diagonal 'adaptive'), remove(c) (released), show(c, visible) (in the camera view or not). Chunks already loaded are added at
   * once. This is how a draw part that replaces 'terrain-draw' draws the ground. Returns { remove() } (ctx.track it).
   * @example ctx.track(engine.terrain.view({ add(c) { draw(c) }, remove(c) { undraw(c) } }))
   * @param {{ add?: (c: any) => void, change?: (c: any) => void, remove?: (c: any) => void, show?: (c: any, visible: boolean) => void }} v
   * @returns {{ remove(): void }}
   */
  view(v) {
    this.views.add(v);
    for (const c of this.chunks.values()) if (c.state === 'ready') v.add?.(c);
    return { remove: () => { if (!this.views.delete(v)) return; for (const c of this.chunks.values()) if (c.state === 'ready') v.remove?.(c); } };
  }
  /** @internal tell every view */
  _emit(k, c, a) { for (const v of this.views) v[k]?.(c, a); }

  /**
   * @internal vegetation plumbing: a species was added or defined again. Only its plants are placed again on the loaded chunks; the ground,
   * its collision and the other species stay (before, the whole terrain was dropped: about 1 s with no ground collision and no trees)
   */
  registerSpecies(name, rule) {
    this.lane.broadcast({ type: 'species', name, rule }, 'species:' + name);
    this._bookDue = true;
    this.vgen++;   // a chunk already on its way carries the old species list: update() asks again when it arrives
    if (!this.plants.get(name)?.nearOnly) this._regrow([name]);
    else this._regrowNear([name]);
  }
  /** Replace the terrain config in every worker (height map loaded, recolor); species is the full rule table */
  reinit(terrainCfg, species) {
    this.generator = createTerrain(terrainCfg);
    this.edits.attach();
    this.lane.broadcast({ type: 'init', terrain: terrainCfg, species }, 'init');
    this.rebuild();
  }

  // dispatch the next task as soon as a result returns: a worker need not wait for the next frame to get work (a frame can be very long while loading)
  _send(job) {
    this.inFlight++;
    const t0 = performance.now();   // measure
    this.lane.run(job).then(r => { this.inFlight--; this.engine.budget.cost.transit(t0, r); this.ready.push(r); this._pump(); },
      err => { this.inFlight--; this._failed(job, err); this._pump(); });
  }
  // A job that threw or whose worker died. Its slot is freed here (otherwise maxInFlight failures stop streaming for good). A ground job is
  // queued again until MAX_TRIES; after that the chunk is 'failed', counted in describe().perf.chunks.failed, emitted as terrain:chunkFailed and
  // reported with the chunk and the cause. A plants-only job marks its species done so the LOD pass does not ask again every ring change.
  _failed(job, err) {
    const key = job.cx + ',' + job.cz, c = this.chunks.get(key);
    if (!c || job.gen !== this.gen || job.cid !== c.id) return;   // gen: the table; cid: this chunk, not an older one at the same coordinate
    if (!job.terrain) {
      if (job.regrow) this._regrown(c);
      c.pendingDetail = false; for (const name of job.species || []) { c.detailDone.add(name); this._cancelNear(c, name); }
      reportError(this.engine, err, 'terrain chunk worker job');   // one key: a broken rule fails every chunk, report it once
      return;
    }
    if (c.state !== 'pending') return;
    c.tries = (c.tries ?? 0) + 1;
    if (c.tries < MAX_TRIES) { c.state = 'queued'; this._want.unshift(c); return; }
    c.state = 'failed'; this.stats.failed++;
    this.engine.events.emit('terrain:chunkFailed', { cx: c.cx, cz: c.cz, error: err });
    reportError(this.engine, codedError('terrain-chunk-failed', `terrain chunk ${key} failed ${c.tries} times and stays empty (no ground, no collision there): `
      + `${err?.message ?? err}. Usually the game's height / groundType / placement rule throws at that spot; engine.terrain.retry() sends failed chunks again`),
    'terrain chunk ' + key);
  }
  /** Send failed chunks (terrain:chunkFailed) again, e.g. after fixing what their rule reads. Returns how many were queued */
  retry() {
    let n = 0;
    for (const c of this.chunks.values()) if (c.state === 'failed') { c.state = 'queued'; c.tries = 0; this._want.unshift(c); n++; }
    this.stats.failed -= n;
    return n;
  }

  /** @internal the view distance in meters */
  _viewMeters() { return (this._viewChunks - 0.3) * this.generator.CHUNK; }
  /** The view distance the signal uViewDistance gets with terrain({ viewFog: true }) (meters), else null; never scene.fog itself */
  get viewFogFar() { return this.viewFog ? this._viewMeters() : null; }
  // Why setters: a plain write used to change the number and nothing else (no far plane, no new plants), with no error
  /** View distance (in chunks). Writing it moves the camera far plane out too; with terrain({ viewFog: true }) the signal uViewDistance follows (see viewFogFar; the game's fog is its own) */
  get viewChunks() { return this._viewChunks; }
  set viewChunks(n) {
    this._viewChunks = n;
    this.engine.viewFar(this._viewMeters() + 150);   // chunks in view must not be clipped (unless the game owns camera.far)
  }
  /** Vegetation density multiplier. Writing it places plants again on the loaded chunks: it thins plants without a collider, blocking plants stand at every density, so collision does not change */
  get density() { return this._density; }
  set density(d) { this._density = d; this.vgen++; this._regrow(this.plants.baseNames()); this._regrowNear(this.plants.nearNames()); }
  // plants-only jobs for every loaded chunk (the ground and its collision stay; near-only species: _regrowNear). c.regrow counts the ones not yet
  // mounted: readyAt is false until they are, so a headless page (core/engine/headlessLoad.js) keeps running loading frames and stateApplied
  // waits for the new plants, as it did when a species dropped the whole terrain
  _regrow(names) {
    if (!names.length) return;
    for (const c of this.chunks.values()) if (c.state === 'ready') { c.regrow++; this._send({ ...this._job(c, false, names), regrow: true }); }
  }
  // one regrow job came back. A chunk released and loaded again meanwhile is a new record with nothing counted
  _regrown(c) { if (c.regrow > 0) c.regrow--; }
  // near-only species: dropped here, and the LOD pass places them again on the chunks within their ring (never on the far ones _regrow would reach)
  _regrowNear(names) {
    for (const c of this.chunks.values()) { for (const n of names) this._unplantNear(c, n); c.level = -1; }
    this._bookDue = true;
  }

  rebuild() {
    this._stream.drop();
    this.ready = [];
    this.gen++;
  }

  /** Ring of a chunk from the nearest stream source; a 'simple' source counts as the outer ring (far picture, no near detail) */
  _ring(c) { return this._stream.ring(c); }

  /**
   * Build a queued chunk entry and register the tick when its collision takes effect. Registered when the chunk is first needed (decided by stream
   * source positions), not when actually sent to the worker (which depends on how busy the worker is) -- so the effect time depends on gameplay only.
   * Ring 1, which the loading screen waits for, takes effect the moment play starts (lag 0); farther rings get more worker time
   */
  _queue(cx, cz, key) {
    const c = { cx, cz, key, id: ++this._cid, near: {}, state: 'queued', data: null, plants: {}, colliders: {}, inView: true, pendingDetail: false, detailDone: new Set(), level: -1, sphere: null, solid: false, gen: this.gen, regrow: 0 };
    this.chunks.set(key, c);
    bookCollision(this, c, this._ring(c), {
      // collision counts from this step on (a new token makes the physics module build this chunk's collision)
      apply: () => { c.solid = true; c.colToken = {}; },
      fallback: () => this._forceReady(c),
    });
    return c;
  }
  /**
   * Dispatch tasks from the queue until maxInFlight are running; while the loading screen is up send all of them (a main-thread frame is long,
   * waiting for replies would idle the worker)
   */
  _pump() {
    if (!this._want.length) return;
    const species = this.plants.baseNames(), max = this.engine.ready ? Math.max(this.maxInFlight, 2 * this.lane.size) : Infinity;
    while (this.inFlight < max && this._want.length) {
      const c = this._want.shift();
      if (c.state !== 'queued' || this.chunks.get(c.key) !== c) continue;   // already generated on the spot, or released
      c.state = 'pending';
      this._send(this._job(c, true, species));
    }
  }

  /** sources: engine.stream.sources() (every stream source; a source radius caps the view distance) */
  update(sources, camera) {
    if (this._stream.follow(sources, this.generator.CHUNK, this.viewChunks)) this._bookDue = true;   // queue what a source needs, release what is far from all
    this._pump();
    this.stats.queued = this._want.length;
    if (this._bookDue) { this._bookDue = false; this._bookNear(); }

    // 2. take worker results within the time budget; while the loading screen is up, first-screen chunks (the ring around the player) ignore the
    // budget and all come in one frame
    const t0 = performance.now(), loading = !this.engine.ready, later = [];   // measure: upload budget
    let built = 0;
    for (const r of this.ready) {
      const c = this.chunks.get(r.cx + ',' + r.cz);
      if (!c || r.gen !== this.gen || r.cid !== c.id) continue;
      if (this._stale(c, r)) { if (r.regrow) this._regrown(c); continue; }
      if (built > 0 && performance.now() - t0 >= this.applyBudgetMs   // measure
        && !(loading && this._ring(c) <= 1)) { later.push(r); continue; }
      if (r.terrain) { if (c.state === 'ready') continue; this._applyTerrain(c, r.terrain); c.ticket?.resolve(true); }
      else if (c.state !== 'ready') continue;
      if (r.vgen !== this.vgen) {   // placed with an old density or species list: keep the ground, ask for the plants again
        if (r.terrain) c.regrow++; else c.pendingDetail = false;
        // a regrow stays counted until its plants are in; a new chunk asks for today's species, not the list it left with
        const names = r.terrain ? this.plants.baseNames() : Object.keys(r.veg).filter(n => this.plants.get(n));   // only species the planter still knows
        if (r.terrain || names.length) this._send({ ...this._job(c, false, names), regrow: !!(r.regrow || r.terrain) });
        else if (r.regrow) this._regrown(c);
      } else {
        for (const name in r.veg) this._mountPlants(c, name, r.veg[name]);
        if (r.regrow) this._regrown(c);
        if (!r.terrain) { c.pendingDetail = false; for (const name in r.veg) c.detailDone.add(name); }
      }
      c.level = -1; built++;
    }
    this.ready = later;
    this.stats.builtThisFrame = built;
    this.stats.applyMs += ((performance.now() - t0) - this.stats.applyMs) * 0.1;   // measure

    // 3. LOD + frustum (the draw parts get show(c, visible) when it changes)
    const { visible, instances } = this._stream.cull(camera);
    this.stats.visible = visible; this.stats.loaded = this.chunks.size; this.stats.instances = instances;
    return built;
  }

  _job(c, terrain, species) {
    const ev = this.edits.version(c.key), edits = this.edits.forChunk(c.cx, c.cz);
    return { type: 'job', cx: c.cx, cz: c.cz, terrain, species, density: this.density, gen: this.gen, cid: c.id, vgen: this.vgen, ev, edits };
  }
  // result built before a later edit near this chunk: drop it and ask again (a loaded chunk was already rebuilt by the edit)
  _stale(c, r) {
    if (r.ev === this.edits.version(c.key)) return false;
    if (r.terrain && c.state === 'pending') { c.state = 'queued'; this._want.unshift(c); }
    else if (!r.terrain) { c.pendingDetail = false; c.level = -1; }
    return true;
  }

  // a generated chunk: keep its arrays and bounds, tell the draw parts
  _applyTerrain(c, t) {
    c.sphere = new THREE.Sphere();
    this._adopt(c, t);
    c.state = 'ready';
    this._emit('add', c);
  }
  /** @internal the arrays a chunk now holds, freshly generated or rebuilt by an edit */
  _adopt(c, t) {
    c.data = t;
    if (t.top != null) { c.solidCount = t.solid; this.lowest = Math.min(this.lowest, t.minH); }   // island: collision takes top and sides, not the bottom
    c.sphere.center.set(t.sphere[0], t.sphere[1], t.sphere[2]); c.sphere.radius = t.sphere[3];
  }

  // due but not ready: if the worker result already arrived take it now, else generate on the main thread (same code, same result).
  // A failed chunk is not tried here (it was reported; the main thread would throw the same error at every commit)
  _forceReady(c) {
    if (c.state === 'ready' || c.state === 'failed') return true;
    const i = this.ready.findIndex(r => r.terrain && r.cx === c.cx && r.cz === c.cz && r.gen === c.gen && r.cid === c.id && r.ev === this.edits.version(c.key));
    let r = i >= 0 ? this.ready.splice(i, 1)[0] : null;
    if (!r || r.vgen !== this.vgen) {
      r = { terrain: r?.terrain ?? this.generator.buildChunk(c.cx, c.cz), veg: {} };
      for (const name of this.plants.baseNames()) r.veg[name] = this.generator.place(c.cx, c.cz, this.plants.get(name).rule, this.density);
    }
    this._applyTerrain(c, r.terrain);
    for (const name in r.veg) this.plants.mount(c, name, r.veg[name]);
    c.level = -1;
    return true;
  }

  // near-only species are placed when a chunk comes within their ring and dropped past it; the vegetation drawing picks its own LOD (plants.ring)
  _setLevel(c, ring) {
    if (c.level === ring) return;
    c.level = ring;
    const P = this.plants;
    for (const sp of P.list()) {
      if (!sp.nearOnly) continue;
      const has = !!c.plants[sp.name];
      // detailDone: this species was already placed here and came back empty; without it the empty result would reset the level and re-ask forever
      if (ring <= sp.maxRing && !has && !c.pendingDetail && !c.detailDone.has(sp.name)) {
        c.pendingDetail = true;
        const names = P.nearNames();
        this._send(this._job(c, false, names));
      } else if (ring > sp.maxRing + 1 && has) this._unplantNear(c, sp.name);
    }
    P.ring?.(c, ring);
  }
  // A near-only species with a collider is gameplay (it blocks), so its colliders take effect on a tick booked from where the sources stand, not when the
  // worker answers: a fast and a slow machine block the same spot at the same step. The fallback places it on the main thread when due (the same
  // code as the worker), as the chunk's own collision does (_forceReady). Booked for every chunk, ready or not, in the frame a source changes chunk
  // (the stream planned: _bookDue), a species changes or a record is withdrawn; the chunk's own ticket (same lag, booked earlier) is due first
  _bookNear() {
    for (const sp of this.plants.list()) if (sp.nearOnly && sp.rule.collider) for (const c of this.chunks.values()) this._book(c, sp);
  }
  /** @internal book one chunk's near-only collider ticket if its ring wants the species and none is booked */
  _book(c, sp) {
    const name = sp.name, ring = this._ring(c);
    if (c.state === 'failed' || ring > sp.maxRing || c.near[name] || c.detailDone.has(name)) return;
    const e = c.near[name] = { mounted: false, done: false, ticket: null };
    e.ticket = this.engine.commits.request({
      lag: colliderLag(this, ring),
      apply: r => {
        if (this._forceReady(c), c.state !== 'ready') return;   // a source came closer after the chunk was booked: its ground first
        e.done = true;
        if (e.mounted) this.plants.release(c, name); else this.plants.mount(c, name, r);
      },
      fallback: () => this.generator.place(c.cx, c.cz, sp.rule, this.density),
      valid: () => this.chunks.get(c.key) === c && c.near[name] === e,
    });
  }
  /** @internal the one way plants of a chunk are mounted (job result, terrain edit): a near-only collider species waits for its ticket, then it is plain */
  _mountPlants(c, name, r) {
    const e = c.near[name], held = !!e && !e.done;
    if (held) { e.mounted = true; e.ticket.resolve(r); }
    this.plants.mount(c, name, r, held);
  }
  _cancelNear(c, name) { const e = c.near[name]; if (e) { e.ticket.remove(); delete c.near[name]; this._bookDue = true; } }
  _unplantNear(c, name) { this.plants.unmount(c, name); this._cancelNear(c, name); c.detailDone.delete(name); }

  /** Stop the chunk workers and release the chunks with their commit tickets (called by terrain dispose; in-flight results are discarded) */
  dispose() { this.lane.dispose(); this.rebuild(); }
  /** @internal vegetation / settings plumbing */
  refreshLevels() { for (const c of this.chunks.values()) c.level = -1; }

  _dispose(c) {
    if (c.state === 'failed') this.stats.failed--;   // the count is of failed chunks loaded now: retry() can only send those
    if (c.state !== 'ready') return;
    this.plants.drop(c);
    this._emit('remove', c);
  }
}
Object.assign(ChunkManager.prototype, chunkQueries);
