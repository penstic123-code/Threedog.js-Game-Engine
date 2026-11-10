// Saves: each module registers "how to save and load", and saving collects them all. Supports multiple slots, autosave, and export / import (text, file).
//
// engine.saves.define('garden', { version: 2, migrate: { 1: d => ({ ...d, beds: [] }) }, save, load });   // shape changed: raise version, add the step
// if (await engine.saves.save('slot1')) toast(engine, 'Saved');   await engine.saves.load('slot1');   // both return Promise<boolean>
// Text export / import and .json files (with attachments): saveFiles.js. Applying a save (checks, rollback): saveApply.js. Format: recipe 20 "Save format".
// Failure paths never lose data: a part whose save() throws, or a failed write, keeps the previous save (false + toast); a corrupt / newer / unmigratable
// save is refused before anything changes; a part whose load() throws rolls the game back to before the load.
// Storage: IndexedDB (SaveStore.js; localStorage fallback with a one-time warning). Every save is read into memory before start(), so list / check /
// export are synchronous; save / remove change memory first, then queue the disk write.
// Several tabs of one game share the storage. Each write carries a rev; a tab overwrites a slot only while the stored rev is the one it last read,
// wrote or loaded (compare-and-write in one IndexedDB transaction), so a forgotten tab's autosave can never replace newer progress made in another
// tab: that save is refused (false, toast, save-stale). A BroadcastChannel tells the other tabs a slot changed, so their list / load see it at once.
// remove deletes the save this tab lists and no newer one. Attachments carry a rev too: a tab changes one only if it wrote it or saw it (at boot, or by reading attachments).
/** @import { SaveProvider } from '../../types/core' */
import { SaveStore } from './SaveStore.js';
import { checkTypeRule } from '../engine/moduleTypes.js';
import { toast } from '../../ui/UI.js';
import { DEV, warnOnce, fmt } from '../base/validate.js';
import { readParams } from '../base/params.js';
import { reportError } from '../base/errors.js';
import { codedError, coded } from '../base/errorHints.js';
import { checkPartVersion, readSave } from './saveVersions.js';
import { exportSaveFile, importSaveFile, importText, SAVE_STRINGS } from './saveFiles.js';
import { applyAnnounced, loadSlot, adoptPart, collectParts, partData } from './saveApply.js';
import { autosaveHook } from './session.js';
import { StateReplace } from './stateReplace.js';


// Developer messages (console text for developers, never shown in the game UI)
const DEV_STRINGS = {
  keyTaken: "saves.define('{key}'): the key already has an owner, whose part would stop being saved",
  saveThrew: "save() of save part '{k}' threw ({msg}); slot '{slot}' was not written and keeps its previous save",
  stale: "[saves] slot '{slot}' was not written: another tab or window of this game saved it after this one last loaded or saved it, and overwriting would lose that newer progress. This tab now lists the newer save; load it to continue from it, or save into another slot",
  noIdb: '[saves] IndexedDB is unavailable (possibly private mode); saves fall back to localStorage (about 5MB cap) and attachments (such as photos) will not be saved.',
  staleRemove: "[saves] slot '{slot}' was not deleted: another tab or window of this game saved it after this one last saw it. This tab lists that save again",
  badFirst: "saves.define('{key}'): first must be true, false or a finite number (lower loads earlier, true counts as 0), got {got}",
  staleBlob: "[saves] attachment '{group}/{id}' was not changed: another tab or window of this game wrote it after this one last saw it. Read saves.attachments('{group}') first, or use another id",
  busy: 'saves.collect() was called during a load, so it would hold half of each state. Wait for the load, or use saves.save, which waits by itself',
  owner: "saves.define('{key}'): that key already has a part, and this one takes it over: the first owner's data is no longer saved. Remove the first part, or use another key",
  autosave: 'saves.autosave(minutes): minutes must be a positive number of minutes of play, got {got}',
  asyncAtomic: "saves.define('{key}'): an atomic part's load must be synchronous, but it is an async function. An atomic op's rollback puts the part back before the op returns; a load still running after its first await would write the old data over what the outer op committed, its events past the mute. Make load plain (do the async work before), or drop atomic: true",
  protoName: "saves.define('__proto__'): a save cannot hold a part with this name (assigning it swaps the parts object's prototype, and save text drops it on reading), so its data would be lost without a word. Pick another name",
};

/** What saves.define takes: without a working save and load the failure would wait for the player's first save or load */
const PROVIDER = { save: 'function', load: 'function', first: 'any?', version: 'any?', migrate: 'any?', atomic: 'any?', notAtomic: 'string?', checkNewGame: 'any?' };

/** Save data as a save file would hold it: no reference into the part's live state stays behind */
const copyData = d => JSON.parse(JSON.stringify(d));
const blobKey = (group, id) => `${group}\0${id}`;

/** engine.saves handles saving. Each module registers "how to save and load"; supports multiple slots, autosave and export / import. */
export class Saves {
  /** @internal */
  constructor(engine, { prefix = 'game-' } = {}) {
    /** @internal */ this.engine = engine;
    /** @internal Start of the key names in the localStorage fallback and of the IndexedDB database name; a module asks storageKey(name) instead */
    this._prefix = prefix + 'save-';
    /** @internal */ this.providers = new Map();
    /** @internal the one rule every state replacement goes through */ this._replace = new StateReplace(engine);
    /** @internal */ this._auto = null;
    /** @internal Slot -> JSON text (all saves stay in memory: list / check / export are synchronous) */ this._json = new Map();
    /** @internal Slot -> savedAt */ this._meta = new Map();
    /** @internal Disk-write queue: earlier saves are written first */ this._queue = Promise.resolve();
    /** @internal Slot -> rev of the copy in memory (a slot without a record is absent) */ this._rev = new Map();
    /** @internal Slot -> rev this tab may overwrite: the one it read at boot, last wrote or last loaded (absent = expects no record) */ this._mine = new Map();
    /** @internal Attachment (blobKey) -> rev this tab last wrote or saw: what it may change */ this._blobRevs = new Map();
    /** @internal This tab's writer id (revs are `<tab>:<n>`); not gameplay and never in the save text, so saves stay reproducible */
    this._tab = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${performance.now()}`;   // wall-clock: only a fallback id, unique per tab
    /** @internal */ this._n = 0;
    /** @internal other tabs of this game: 'slot changed' notes */
    this._bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel(this._prefix + 'db') : null;
    if (this._bc) this._bc.onmessage = ev => this._remote(ev.data?.slot);
    /** @internal Parts of the last loaded save that no registered module owns (a module not installed in this build): written back unchanged on every save */
    this._foreign = { parts: {}, versions: {} };
    engine.i18n.add(SAVE_STRINGS);
    /**
     * Storage layer: saves in the IndexedDB slots store, attachments (by group, e.g. 'photo') in the blobs store; mode 'localStorage' without IndexedDB.
     * @type {{ mode: 'idb' | 'localStorage', blobs(group?: string): Promise<{ group: string, id: string, at: number, blob: Blob, meta: any }[]>,
     *   putBlob(group: string, id: string, blob: Blob, meta?: any, at?: number): Promise<void>, deleteBlob(group: string, id: string): Promise<void> }}
     * @experimental
     */
    this.store = /** @type {any} */ (new SaveStore(this._prefix + 'db', this._prefix));
    /** Has the save index been read into memory? (start() waits for it; game code rarely needs to care) */
    this.ready = false;
    /** Resolves once the save index is in memory; await it only to list / load before start() @type {Promise<void>} */
    this.whenReady = this._init().then(() => { this.ready = true; });
  }
  /**
   * Define "how to save and load"; key is this part's name in the save. Parts with first: true load first (the level); first may be a number, lower loads earlier, true counts as 0 (zones that need the level: 1); a load returning a Promise makes later
   * parts wait.
   * version (default 1): raise it by 1 whenever what save() returns changes shape, and add migrate[oldVersion] = data => newData; load sees only the current
   * shape.
   * A save whose part is newer than this build's version is refused as a whole (load returns false, the save is kept).
   * load(data, turn): turn is this replacement's identity. Pass it on, level.load(x, { turn }) or content.load(x, { turn }): those wait for a running load to end, except with its turn.
   * A part registered after a save was loaded (a module installed later) is handed its data from that save: at once when idle, else right after the replacement under way.
   * atomic: true joins this part to atomic ops: it is copied before an atomic op runs and put back if the op fails (plain data only; afterLoad does not run on rollback; load synchronous: an async function is refused here).
   * checkNewGame(data): dev only, called once start() finished with this part's data in the new-game state, to warn about what should not be there yet
   * (world: records placed by code instead of content). The part knows its own format; core only hands the data over.
   * Returns a handle: remove() takes the part out and keeps its data as unattached data (it rides in later saves and goes back to a part registered under
   * the key later), without holding on to the part's closures. remove({ keep: false }) gives back only what the part took over at register: for a part that never ran.
   * @param {string} key
   * @param {SaveProvider} provider
   * @returns {{ remove(o?: { keep?: boolean }): void }}
   * @example
   * engine.saves.define('garden', { save: () => garden.toJSON(), load: d => garden.fromJSON(d) });
   * // later the format gains beds: version 2, and a step that upgrades version-1 data
   * engine.saves.define('garden', { version: 2, migrate: { 1: d => ({ ...d, beds: [] }) }, save: () => garden.toJSON(), load: d => garden.fromJSON(d) });
   */
  define(key, provider) {
    checkTypeRule(this.engine, 'saves.define', `defined save part '${key}'`);
    // told, not taken: the first owner would stop being saved with nothing said. A module that goes gives the key back first (ctx.saves.define), so a swap never lands here
    if (this.providers.has(key)) throw codedError('save-key-taken', fmt(DEV_STRINGS.keyTaken, { key }));
    readParams(`saves.define('${key}')`, PROVIDER, provider);
    if (provider.first !== undefined && typeof provider.first !== 'boolean' && !Number.isFinite(provider.first)) throw codedError('module-params', fmt(DEV_STRINGS.badFirst, { key, got: JSON.stringify(provider.first) }));
    if (key === '__proto__') throw codedError('module-params', DEV_STRINGS.protoName);
    const { save, load, first = false, version = 1, migrate = {}, atomic = false, checkNewGame = null } = provider;
    // shortcut: only a load declared async is known here; a plain function that returns a Promise is refused when the rollback meets it (restoreParts, saveApply.js)
    if (atomic === true && load.constructor?.name === 'AsyncFunction') throw codedError('module-params', fmt(DEV_STRINGS.asyncAtomic, { key }));
    checkPartVersion(key, version, migrate);
    const f = this._foreign, held = Object.hasOwn(f.parts, key) ? { data: copyData(f.parts[key]), version: f.versions[key] ?? 1 } : null;
    const part = { save, load, first, version, migrate, atomic: atomic === true, checkNewGame };
    if (DEV && this.providers.has(key)) warnOnce(fmt(DEV_STRINGS.owner, { key }), `save-owner-${key}`);   // the newer owner takes it, as a replaced module does; the older one stops being saved
    this.providers.set(key, part);
    try { this.engine.session._late(key); }   // a part registered after start() (a module installed later) joins the new-game state as it is now
    catch (err) { this.providers.delete(key); this.engine.session._lateParts.delete(key); throw err; }   // define() hands back no handle on a throw, so the key must not stay taken
    if (held) adoptPart(this, key, part);
    return { remove: ({ keep = true } = {}) => {
      if (this.providers.get(key) !== part) return;   // a stale handle: the key belongs to someone newer
      this.providers.delete(key);
      let left = held;   // removed while its late data loads (adoptPart): that data goes back unattached, not the half-loaded state
      if (keep && !part.adopting && !Object.hasOwn(this._foreign.parts, key)) try { const d = partData(key, part); left = d == null ? null : { data: copyData(d), version }; }
      catch (err) { reportError(this.engine, err, `save() of part '${key}' while it was removed`, { soft: true }); }
      if (left) { this._foreign.parts[key] = left.data; this._foreign.versions[key] = left.version; }
    } };
  }
  /**
   * The save versions this build reads, per part: { world: 1, clock: 1, ... }. A save whose part is newer is refused; an older one is migrated.
   * @returns {Record<string, number>}
   */
  get versions() { return Object.fromEntries([...this.providers].map(([k, p]) => [k, p.version])); }

  // ---------- storage ----------
  /** @internal */
  async _init() {
    const idb = await this.store.open();
    if (!idb) warnOnce(coded('indexeddb', DEV_STRINGS.noIdb + (this.store.openError ? ` (IndexedDB said: ${this.store.openError.message})` : '')));
    try {
      for (const r of await this.store.slots()) {
        this._rev.set(r.slot, r.rev ?? ''); this._mine.set(r.slot, r.rev ?? '');   // also for a save made before this ran: its write comes after and expects this record
        if (!this._json.has(r.slot)) { this._json.set(r.slot, r.json); this._meta.set(r.slot, r.savedAt); }
      }
      this._sawBlobs(await this.store.blobs());
    } catch (e) { this._fail(e); }
  }
  /** @internal Disk writes run in call order once storage is ready, and flush waits for them: the one place that order is kept */
  _enqueue(fn) {
    const p = this._queue.then(() => this.whenReady).then(fn);
    this._queue = p.catch(() => {});
    return p;
  }
  /** @internal A save failed: console (or the error tiers, for a part that threw) plus an on-screen toast, never silent */
  _fail(err, slot, report = false) {
    const why = this.engine.t('saves.failed', { why: err?.name === 'QuotaExceededError' ? 'storage full' : err?.message || String(err) });
    if (report) reportError(this.engine, err, `saves.save('${slot}')`);
    else warnOnce(coded('save-write', `[saves] failed to write ${slot ? `slot "${slot}"` : 'save'}: ${err?.message ?? err}`));
    toast(this.engine, why, { kind: 'error', ms: 5000 });
  }
  /**
   * Store a binary attachment outside the world save (a photo, a replay). It rides in the queue of save writes, so flush() waits for it, and exportFile() carries it.
   * Pass a function to make the bytes when the write runs: flush() then waits for that too. Without IndexedDB it is not kept: it rejects with save-write.
   * Rejects with save-stale, changing nothing, when another tab wrote this id since this tab last saw it; attachments(group) is how a tab looks.
   * @example await engine.saves.putAttachment('replay', 'run-1', blob, { score: 12 });
   * @param {string} group what the attachment is for
   * @param {string} id unique inside the group; the same id replaces
   * @param {Blob | (() => Promise<Blob>)} blob
   * @param {any} [meta] plain data kept with it
   * @returns {Promise<void>}
   * @experimental
   */
  putAttachment(group, id, blob, meta) {
    return this._enqueue(async () => {
      const key = blobKey(group, id), rev = this._newRev();
      await this.store.putBlobIf({ group, id, blob: typeof blob === 'function' ? await blob() : blob, meta: meta ?? null, at: Date.now(), rev }, this._blobRevs.get(key) ?? null).catch(e => this._blobStale(e, group, id));   // wall-clock: when the attachment was stored, used for ordering
      this._blobRevs.set(key, rev);
    });
  }
  /** Delete an attachment; no such id is fine. Rejects with save-stale as putAttachment does @param {string} group @param {string} id @returns {Promise<void>} @experimental */
  removeAttachment(group, id) {
    return this._enqueue(async () => {
      const key = blobKey(group, id);
      await this.store.deleteBlobIf(group, id, this._blobRevs.get(key) ?? null).catch(e => this._blobStale(e, group, id));
      this._blobRevs.delete(key);
    });
  }
  /** @internal */
  _blobStale(e, group, id) { throw e?.stale !== undefined ? codedError('save-stale', fmt(DEV_STRINGS.staleBlob, { group, id })) : e; }
  /** @internal This tab has looked at these rows: it may change them */
  _sawBlobs(rows) { for (const b of rows) if (b.rev != null) this._blobRevs.set(blobKey(b.group, b.id), b.rev); return rows; }
  /**
   * The attachments of a group, once storage is ready. Empty without IndexedDB.
   * @param {string} group
   * @returns {Promise<{ group: string, id: string, at: number, blob: Blob, meta: any }[]>}
   * @experimental
   */
  async attachments(group) { await this.whenReady; return this._sawBlobs(await this.store.blobs(group)); }
  /**
   * A localStorage key for what belongs to this game but is not a save (settings, a last-used tab): it shares the game's name, so two games on one site stay apart, and stays out of list().
   * @example localStorage.setItem(engine.saves.storageKey('lastTab'), 'map');
   * @param {string} name
   * @returns {string}
   */
  storageKey(name) { return this._prefix.replace(/save-$/, '') + name; }
  /** Wait for all queued disk writes to finish (for tests and before the page closes) @returns {Promise<void>} */
  flush() { return this._queue; }

  /** @internal Collect every part: { data, failed: [[key, error]] }. Parts of the loaded save that no module owns are carried along. */
  _collect() { return collectParts(this); }
  /**
   * Collect the data of every part (does not write to the browser): { format, savedAt, versions, parts }.
   * A part whose save() throws is left out and reported (engine.error in dev); save() instead refuses to write such a save.
   * Throws while a load is under way: what it would return is half of each state. saves.save waits instead.
   * @returns {{ format: number, savedAt: number, versions: Record<string, number>, parts: Record<string, any> }}
   */
  collect() {
    if (this.replacing) throw codedError('save-busy', DEV_STRINGS.busy);
    const { data, failed } = this._collect();
    for (const [k, e] of failed) reportError(this.engine, e, `save() of save part '${k}'`);
    return data;
  }
  /**
   * Can this slot be loaded? null when it can, else why not (checked without touching the game):
   * 'missing' | 'corrupt' (unreadable) | 'tooNew' (a newer save format or part) | 'migrate' (an upgrade step is missing or throws).
   * @param {string} [slot]
   * @returns {null | 'missing' | 'corrupt' | 'tooNew' | 'migrate'}
   * @example if (engine.saves.check('slot1') === 'tooNew') showUpdateHint();
   */
  check(slot = 'auto') { const r = readSave(this._json.get(slot), this.providers, slot); return 'reason' in r ? r.reason : null; }
  /**
   * Apply a save's data (an object from collect(), or save text) onto the running game. Resolves true when every part loaded.
   * Refused before anything changes (false, toast) when the data is corrupt, from a newer build or cannot be migrated.
   * After every part loaded it runs the modules' afterLoad hooks (gameplay frozen until they resolve), for saves.load, session.newGame / quit and direct calls
   * alike.
   * If a part's load throws, a listener of an event it emits while loading (world:load) throws, or a module's afterLoad throws, the game is rolled back to
   * how it was before (every part reloads its pre-load state) and it resolves false; the error goes through the error tiers. "While loading" lasts
   * until the result settles, past every await of an async load(); a listener that throws in that window for any reason fails this load.
   * The pre-load state is a copy (structuredClone) of every part's save(), so save() may return the live object load() writes into; a part whose
   * data cannot be copied makes apply refuse (false) before anything changes.
   * The state changes synchronously unless a part's load is async; only the result is a Promise.
   * One replacement runs at a time: asked for while a load, newGame or quit is under way, this waits its turn, then reads the data and takes its
   * rollback point. On the line after a synchronous apply it is not waiting on anything yet, so it applies at once and takes over the afterLoad.
   * Inside a part's load() or an afterLoad it starts after they return, so do not await it there.
   * On success 'save:loaded' fires with slot, as for saves.load: what the game does not save (a walk) ends on it, and derived state rebuilds.
   * @param {any} data
   * What goes around it is the same for every door (core/saves/session.js): 'save:loaded' fires with `slot`, the title closes; a rollback fires 'session:failed' { kind: 'quick', slot }.
   * @param {string} [slot]  for messages and the event
   * @returns {Promise<boolean>}
   */
  apply(data, slot = '(data)') { return this._replace.run(null, () => applyAnnounced(this, data, slot)); }

  /**
   * @internal True while the game state is being replaced: from reading a save through its parts, the modules' afterLoad and any rollback. Ops refuse with
   * code 'loading' for that whole span; any other freeze (a menu) does not stop them.
   * @type {boolean}
   */
  get replacing() { return this._replace.replacing; }
  /**
   * @internal Which saved state the game holds (StateReplace.generation). Code that waits and then writes takes it when asked and writes only if it is unchanged;
   * read it with replacing off when a load that fails must not count.
   * @type {number}
   */
  get generation() { return this._replace.generation; }
  /** @internal Resolves once every replacement already in line ended, so generation says how it went: a load under way may still fail and give this state back */
  settled() { return this._replace.read(async () => {}); }
  /** @internal Put a save in memory and queue the disk write; returns Promise<boolean> (write succeeded) */
  _put(slot, json, savedAt) {
    const rev = this._newRev();
    this._json.set(slot, json); this._meta.set(slot, savedAt);
    // expect is read when the write runs, not now: an earlier queued save of this tab moves _mine first
    return this._enqueue(() => this.store.putSlot(slot, savedAt, json, rev, this._mine.get(slot) ?? null)).then(() => {
      this._rev.set(slot, rev); this._mine.set(slot, rev);
      this._tell(slot);
      return true;
    }, async e => {
      if (e?.stale !== undefined) {   // another tab wrote it: memory shows that newer save (list / load offer it); this playthrough is not written
        if (this._json.get(slot) === json) this._show(slot, e.stale);
        warnOnce(coded('save-stale', fmt(DEV_STRINGS.stale, { slot })));
        toast(this.engine, this.engine.t('saves.otherTab', { slot }), { kind: 'error', ms: 6000 });
        return false;
      }
      await this._showStored(slot, () => this._json.get(slot) === json);
      this._fail(e, slot); return false;
    });
  }
  /**
   * @internal A write the store refused: memory goes back to what the disk holds (unless a later save already replaced what failed, which still() tells), so list / load / continue
   * never disagree with it. Read, not remembered: the text before may be a queued save that failed too
   */
  async _showStored(slot, still) {
    if (!still()) return;
    let stored;
    try { stored = await this.store.getSlot(slot); }
    catch (e) { reportError(this.engine, e, `saves slot '${slot}' could not be read back after a failed write; the list keeps the last known record, which the disk may not hold`, { soft: true }); return; }   // "cannot read" is not "no save": dropping the slot would hide a save that may exist
    if (still()) this._show(slot, stored);
  }
  /** @internal */
  _newRev() { return `${this._tab}:${++this._n}`; }
  /** @internal Memory shows a stored record (null = none); a stored record leaves the rev this tab may overwrite as it was */
  _show(slot, r) {
    if (!r) { this._json.delete(slot); this._meta.delete(slot); this._rev.delete(slot); this._mine.delete(slot); return; }   // deleted: no newer progress to protect, so the next save may write
    this._json.set(slot, r.json); this._meta.set(slot, r.savedAt); this._rev.set(slot, r.rev ?? '');
  }
  /** @internal Another tab changed a slot: read it again (after this tab's queued writes, so a late note cannot undo a newer own write) */
  _remote(slot) {
    if (typeof slot !== 'string' || !this._bc) return;
    this._enqueue(() => this.store.getSlot(slot)).then(r => this._show(slot, r), () => {});
  }
  /** @internal Tell the other tabs a slot changed (they read it again from storage: the note carries no save text, which can be MBs) */
  _tell(slot) { this._bc?.postMessage({ slot }); }   // BroadcastChannel, not a worker
  /** @internal A slot was loaded: this playthrough now continues from it, so this tab may overwrite it */
  _adopt(slot) { if (this._rev.has(slot)) this._mine.set(slot, this._rev.get(slot)); }
  /**
   * Save into a slot (default 'auto'). Returns Promise<boolean>
   * (resolves after the write to IndexedDB: true on success, false with a toast and console error on failure).
   * The in-memory save updates immediately, so a following load / list / export sees it at once; the 'save:written' event fires only after the write succeeds.
   * Asked for while a load, newGame or quit is under way, it waits for that to end and saves the result: a save never holds half of each state.
   * If any part's save() throws, or its data holds NaN or Infinity at any depth (the message names the part and the path), nothing is written and the slot keeps its previous save (false). A failed write keeps the previous save too.
   * Show "saved" only after the result is true.
   * @param {string} [slot]
   * @returns {Promise<boolean>}
   * @example if (await engine.saves.save('slot1')) toast(engine, 'Saved');   // on false the engine already showed why
   */
  save(slot = 'auto') { return this._replace.read(() => this._save(slot)); }
  /** @internal save, in a moment no replacement is under way */
  _save(slot) {
    let data, json;
    try {
      const r = this._collect();
      if (r.failed.length) {
        const [k, err] = r.failed[0];
        this._fail(Object.assign(codedError('save-part-threw', fmt(DEV_STRINGS.saveThrew, { k, slot, msg: err?.message ?? String(err) })), { cause: err }), slot, true);
        return Promise.resolve(false);
      }
      data = r.data; json = JSON.stringify(data);
    } catch (e) { this._fail(e, slot); return Promise.resolve(false); }
    return this._put(slot, json, data.savedAt).then(ok => { if (ok) this.engine.events.emit('save:written', slot); return ok; });
  }
  /**
   * Load a slot onto the running playthrough (a quick load: what the game added during play stays) and resolve true on success; the 'save:loaded' event fires
   * on success.
   * A missing slot resolves false; a corrupt / too new / unmigratable save resolves false with a toast and changes nothing; a part whose load throws rolls the
   * game back.
   * To continue or retry with nothing of the current playthrough left over, use engine.session.load(slot).
   * @param {string} [slot]
   * @param {{ turn?: object }} [o]  turn: the running request's own (what a save part's load(), an afterLoad or a module's applyState was given): the call then runs inside that request instead of waiting behind it for itself, as level.load({ turn }) does
   * @returns {Promise<boolean>}
   * @example if (!(await engine.saves.load('quick'))) toast(engine, 'No quick save');
   */
  load(slot = 'auto', { turn } = {}) { return this._replace.run(null, () => this._load(slot), { turn }); }
  /** @internal Load a slot inside a turn already taken; with base (a collect() result) the save goes on top of it, so a part missing from the save gets base's state (session.load) */
  _load(slot, base) { return loadSlot(this, slot, base); }
  /** All slots, newest first (synchronous, reads the in-memory index) @returns {{ slot: string, savedAt: number }[]} */
  list() {
    return [...this._meta].map(([slot, savedAt]) => ({ slot, savedAt })).sort((a, b) => b.savedAt - a.savedAt);
  }
  /**
   * Delete a slot. Returns a Promise (disk write done); awaiting is optional. A newer save another tab wrote meanwhile is kept: the slot lists again, with a toast (save-stale).
   * A delete the store refused lists the slot again too, with a toast.
   * @param {string} slot @returns {Promise<void>}
   */
  remove(slot) {
    this._json.delete(slot); this._meta.delete(slot);
    // the revs are cleared when the delete runs, not now: a save queued before this remove sets _mine when its write lands,
    // and a _mine left over for a deleted record would refuse every later save of this slot as "another tab saved"
    // what it expects is what this tab lists (_rev): a save the note from another tab brought in is the player's to delete
    return this._enqueue(async () => { await this.store.deleteSlot(slot, this._rev.get(slot) ?? null); this._rev.delete(slot); this._mine.delete(slot); })
      .then(() => this._tell(slot), async e => {
        if (e?.stale === undefined) { await this._showStored(slot, () => !this._json.has(slot)); return this._fail(e, slot); }
        if (!this._json.has(slot)) this._show(slot, e.stale);
        warnOnce(coded('save-stale', fmt(DEV_STRINGS.staleRemove, { slot })));
        toast(this.engine, this.engine.t('saves.otherTabKept', { slot }), { kind: 'error', ms: 6000 });
      });
  }
  /** Export as a piece of text (can be copied as a backup; synchronous, without binary attachments) @param {string} [slot] @returns {string} @experimental */
  export(slot = 'auto') { try { return btoa(unescape(encodeURIComponent(this._json.get(slot) || ''))); } catch { return ''; } }
  /**
   * Import text from export() into a slot (default 'imported'); checked like importFile and written before it resolves.
   * Resolves true once stored (save:imported fires), false when the text is not a save or the write failed. It does not load the slot.
   * @param {string} text
   * @param {string} [slot]
   * @returns {Promise<boolean>}
   */
  import(text, slot = 'imported') { return importText(this, text, slot); }

  // ---------- files ----------
  /**
   * Download a save file (.json): the save plus every binary attachment (as data: text, so the file is larger; { files: false } exports the save only).
   * Restores everything when browser data is wiped on a phone. Returns Promise<boolean>.
   * @param {string} [slot]
   * @param {{ files?: boolean }} [opts]
   * @returns {Promise<boolean>}
   * @example engine.saves.exportFile('slot1');
   * @experimental
   */
  exportFile(slot = 'auto', opts = {}) { return exportSaveFile(this, slot, opts); }
  /**
   * Restore from a save file into slot (default 'imported', so a shared file never overwrites 'auto'). file is a File / Blob; omit it to open a file picker.
   * Everything is checked first (file marker and format, the save inside, attachments must be data: URLs: nothing is fetched).
   * Returns the slot name on success, and null if cancelled, the file is invalid or the write failed (a toast was already shown). It restores the slot only and
   * does not load it.
   * @param {Blob} [file]
   * @param {string} [slot]
   * @returns {Promise<string | null>}
   */
  importFile(file, slot) { return importSaveFile(this, file, slot); }

  /**
   * Autosave into 'auto' every `minutes` minutes of play: counted in fixed seconds, so it waits while paused, frozen or in a menu that freezes the game,
   * and it never saves while no playthrough runs (the title screen, during newGame / load / quit) or after a gameplay error. Returns a handle; remove() stops
   * it.
   * Calling it again replaces the previous autosave.
   * @param {number} [minutes]
   * @returns {{ remove(): void }}
   * @example engine.saves.autosave(3);   // once at boot: it waits by itself while no playthrough runs
   */
  autosave(minutes = 3) {
    if (!(minutes > 0) || !Number.isFinite(minutes)) throw codedError('save-autosave', fmt(DEV_STRINGS.autosave, { got: JSON.stringify(minutes) }));
    this._auto?.remove();
    const h = autosaveHook(this, minutes * 60, () => { if (this._auto === h) this._auto = null; });
    return (this._auto = h);
  }
  /** @internal Stop autosave (called by engine.dispose) */
  dispose() { this._auto?.remove(); this._bc?.close(); this._bc = null; this._queue.then(() => this.whenReady).catch(() => {}).finally(() => this.store.close()); }   // close the database only after queued writes finish and the open (which sets store.db later) is done
}

export const handRolled = [{ kind: 'save', seen: 'a save of its own in localStorage', use: "engine.saves: autosave(minutes), define('game', { version: 1, save, load }), and Continue on the start screen (recipe 63); versions, slots and a corrupt save are handled", quiet: /\bengine\.saves\b/, code: /\blocalStorage\.setItem\s*\(/, notRaw: /setItem\s*\(\s*(?![^,)]*(?:save|progress))[^,)]*(?:volume|mute|lang|locale|theme|music|sfx|quality|sensitiv|brightness|fullscreen|tutorial|dismiss|setting|pref|option|keybind)/i }];
