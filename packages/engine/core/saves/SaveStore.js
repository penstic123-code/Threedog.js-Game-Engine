import { codedError } from '../base/errorHints.js';
// Save storage layer: uses the browser's native IndexedDB (no third-party library) and falls back to localStorage when it is unavailable. Saves uses it; modules never touch it directly.
//
// Two stores in the database:
//   slots  key slot, value { slot, savedAt, json, rev }   world saves (json is JSON text, with no localStorage 5MB cap); rev names the write
//          (`<tab id>:<n>`), so a tab can tell "the save I last saw" from "a newer one another tab wrote" (cross-tab safety, Saves._put)
//   blobs  key [group, id], value { group, id, at, blob, meta, rev }   binary attachments (group tells the purpose, e.g. photos are 'photo'), stored separately and kept out of the world save;
//          rev as for slots. A row without one (an older build, a file import, the store used directly) claims nothing, so anyone may change it
// On the localStorage fallback: only world saves are stored (key prefix + slot); attachments are not persisted (blobs reads return empty, writes are ignored).
// Every method returns a Promise; a failed write (quota, IndexedDB error) rejects and Saves reports it in one place.

const STORES = { slots: { keyPath: 'slot' }, blobs: { keyPath: ['group', 'id'] } };

/** Turn an IDBRequest / IDBTransaction into a Promise */
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const tx = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onabort = () => rej(t.error); });   // abort, not error: a failed request fires error first, with t.error still null, and aborts after
/** rev of a stored record: null = no record; '' = a record written before revs existed */
const revOf = r => r == null ? null : r.rev ?? '';
/** The stored record is not the one the caller expected: nothing was written. stale holds that record */
const staleError = (key, cur) => Object.assign(new Error(`'${key}' was written by another tab`), { stale: cur });
/** Does a stored attachment belong to someone this tab has not seen? */
const claimed = (cur, expect) => cur?.rev != null && cur.rev !== expect;
const checkBlob = b => { if (!(b.blob instanceof Blob)) throw codedError('save-write', `attachment '${b.group}/${b.id}' must be a Blob, got ${String(b.blob)}`); };

export class SaveStore {
  /** @param {string} name Database name (each game's saveKey differs, so they do not interfere)  @param {string} prefix Key prefix for the localStorage fallback */
  constructor(name, prefix) {
    this.name = name; this.prefix = prefix;
    /** 'idb' | 'localStorage': meaningful only after open() completes */
    this.mode = 'idb';
    this.db = null;
    /** @internal why open() fell back to localStorage */ this.openError = null;
  }

  /** Open the database; on failure (private mode, disabled) switch to localStorage. Returns whether IndexedDB is in use. */
  async open() {
    try {
      if (typeof indexedDB === 'undefined') throw codedError('indexeddb', 'indexedDB is unavailable');
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => { for (const [n, o] of Object.entries(STORES)) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n, o); };
      this.db = await req(r);
      this.db.onversionchange = () => this.db.close();   // yield when another tab wants to upgrade the database
      return true;
    } catch (e) { this.mode = 'localStorage'; this.openError = e; return false; }   // kept: the warning names the real cause, not always private mode
  }

  /** Attachments live only in IndexedDB: in localStorage mode a write says so (save-write) instead of resolving as stored */
  _needIdb(b) { if (this.mode === 'localStorage') throw codedError('save-write', `attachment '${b.group}/${b.id}' was not stored: IndexedDB is unavailable, so attachments (such as photos) are not kept`); }

  _tx(store, mode = 'readonly') { return this.db.transaction(store, mode); }

  /** All world saves: [{ slot, savedAt, json }] */
  async slots() {
    if (this.mode === 'localStorage') {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith(this.prefix)) out.push(this._lsGet(k.slice(this.prefix.length)));   // a damaged save is listed too: check says corrupt, and a save may replace it
      }
      return out;
    }
    return req(this._tx('slots').objectStore('slots').getAll());
  }
  /** localStorage fallback: the rev lives under its own key, outside the prefix (slots() must not list it as a save) */
  _revKey(slot) { return 'rev:' + this.prefix + slot; }
  /** @internal localStorage read, synchronous (putSlot checks and writes in one turn) */
  _lsGet(slot) {
    const json = localStorage.getItem(this.prefix + slot);
    if (json == null) return null;
    let savedAt = 0; try { savedAt = JSON.parse(json).savedAt ?? 0; } catch { /* corrupt: readSave refuses it later */ }
    return { slot, savedAt, json, rev: localStorage.getItem(this._revKey(slot)) ?? '' };
  }
  /** One world save, { slot, savedAt, json, rev } or null */
  async getSlot(slot) {
    if (this.mode === 'localStorage') return this._lsGet(slot);
    return (await req(this._tx('slots').objectStore('slots').get(slot))) ?? null;
  }
  /**
   * Write a save, but only while the stored record is still the one this tab expects (rev `expect`; null = no record): compare and write in ONE
   * readwrite transaction, which IndexedDB runs one at a time across tabs, so two tabs can never both pass the check. A mismatch rejects with
   * { stale: stored record } and writes nothing. localStorage: get and set run in one synchronous turn, which is as atomic as it gets there.
   */
  async putSlot(slot, savedAt, json, rev, expect) {
    if (this.mode === 'localStorage') {
      if (expect !== undefined) { const cur = this._lsGet(slot); if (revOf(cur) !== expect) throw staleError(slot, cur); }
      // the rev first: the small write cannot then fail after the save was already replaced
      const revKey = this._revKey(slot), old = localStorage.getItem(revKey);
      localStorage.setItem(revKey, rev ?? '');
      try { localStorage.setItem(this.prefix + slot, json); }
      catch (e) { if (old == null) localStorage.removeItem(revKey); else localStorage.setItem(revKey, old); throw e; }
      return;
    }
    return this._change('slots', slot, cur => expect !== undefined && revOf(cur) !== expect, st => st.put({ slot, savedAt, json, rev }));
  }
  /** @internal Read the record, ask clash(record), and change it in ONE readwrite transaction: the compare every guarded write goes through */
  async _change(store, key, clash, write) {
    const t = this._tx(store, 'readwrite'), st = t.objectStore(store), g = st.get(key);
    let lost = false, cur = null;
    g.onsuccess = () => { cur = g.result ?? null; if ((lost = clash(cur))) t.abort(); else write(st); };
    try { await tx(t); } catch (e) { if (lost) throw staleError(key, cur); throw e; }
  }
  /** Delete a save, with expect: only while the stored record is that one, as putSlot. A record already gone is no conflict: there is no newer progress to keep */
  async deleteSlot(slot, expect) {
    const clash = cur => expect !== undefined && cur != null && revOf(cur) !== expect;
    if (this.mode === 'localStorage') {
      const cur = this._lsGet(slot);
      if (clash(cur)) throw staleError(slot, cur);
      localStorage.removeItem(this.prefix + slot); localStorage.removeItem(this._revKey(slot));
      return;
    }
    return this._change('slots', slot, clash, st => st.delete(slot));
  }

  /** One group of attachments, newest first: [{ group, id, at, blob, meta }]; omit group for all */
  async blobs(group) {
    if (this.mode === 'localStorage') return [];
    const all = await req(this._tx('blobs').objectStore('blobs').getAll());
    return all.filter(b => group == null || b.group === group).sort((a, b) => b.at - a.at);
  }
  async putBlob(group, id, blob, meta = null, at = Date.now()) { return this.putBlobs([{ group, id, blob, meta, at }]); }   // wall-clock: when the attachment was stored, used for ordering
  /** Several attachments in one transaction: all stored or none (a restore must not leave half of them) */
  async putBlobs(list) {
    list.forEach(checkBlob);
    if (!list.length) return;
    this._needIdb(list[0]);
    const t = this._tx('blobs', 'readwrite'), st = t.objectStore('blobs');
    try { for (const b of list) st.put(b); } catch (e) { t.abort(); throw e; }
    await tx(t);
  }
  async deleteBlob(group, id) {
    if (this.mode === 'localStorage') return;
    const t = this._tx('blobs', 'readwrite');
    t.objectStore('blobs').delete([group, id]);
    await tx(t);
  }

  /** @internal One attachment, only if no other tab claimed the row since the rev this tab saw (putSlot's compare). row: as stored, with its own rev */
  async putBlobIf(row, expect) {
    checkBlob(row);
    this._needIdb(row);
    return this._change('blobs', [row.group, row.id], cur => claimed(cur, expect), st => st.put(row));
  }
  /** @internal deleteBlob with the same compare */
  async deleteBlobIf(group, id, expect) {
    if (this.mode !== 'localStorage') return this._change('blobs', [group, id], cur => claimed(cur, expect), st => st.delete([group, id]));
  }

  close() { this.db?.close(); this.db = null; }
}
