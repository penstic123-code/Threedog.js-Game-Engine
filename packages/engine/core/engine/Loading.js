// engine.loading: one observable view of everything startup (and later on-demand loading) is waiting for.
// Asset loads, module init / isReady, the stream's required builds and the game's own steps (track) all appear here, so
// describe().loading, the dev bridge (threedog loading) and the loading-screen part read the same answer to
// "what are we waiting for, what failed, does it block the start".
//
// Each task: name, kind (model / texture / sound / module / stream / step), phase (queued -> download -> decode -> upload / build -> done | failed),
// progress 0-1, critical, error { message, url, status }, missing (referenced files that failed), fallback, source { manifest, url, version, bytes, animations }.
// Finished is not the same as succeeded: view().done says nothing is pending, view().ok says nothing failed.

const END = new Set(['done', 'failed']);
const VERB = { queued: 'queued', download: 'downloading', decode: 'decoding', upload: 'uploading to the GPU', build: 'building', module: 'waiting for module' };
const LIST_MAX = 8;   // describe stays short: the full list is engine.loading.list()

class Task {
  constructor(name, kind, { critical = false, url = null, manifest = null } = {}) {
    this.name = name; this.kind = kind; this.critical = critical;
    this.phase('queued');
    this.error = null; this.missing = []; this.fallback = null;
    this.source = { manifest, url, version: null, bytes: null, animations: null };
  }
  /** @param {string} p queued | download | decode | upload | build | done | failed @param {number} [progress] */
  phase(p, progress = 0) { this.state = p; this.progress = progress; this.at = performance.now(); }   // measure: at, the last sign of life the load limit reads
  toJSON() {
    const o = { name: this.name, kind: this.kind, phase: this.state, progress: Math.round(this.progress * 100) / 100, critical: this.critical };
    if (this.error) o.error = this.error;
    if (this.missing.length) o.missing = this.missing;
    if (this.fallback) o.fallback = this.fallback;
    o.source = this.source;
    return o;
  }
}

export class Loading {
  /** @param {any} engine */
  constructor(engine) {
    this.engine = engine; this.tasks = new Map();
    this._inits = new Set();   // init() of modules installed after start(), in flight
    this._parts = new Set();   // their save parts taking back data a save kept for them (saveApply.js adoptPart), in flight
    /** The one limit on every wait for a load (ms): a file that gives no sign of life, a module's init or a settle that does not end fail by name after it @type {number} */
    this.timeoutMs = 120000;
  }

  /** @internal keep a late module init in flight until it ends (settled() waits for these) */
  _track(p, into = this._inits) { into.add(p); p.finally(() => into.delete(p)); }
  /**
   * Resolves when every module installed after start() has finished its init() (also when one failed: its state is then 'failed' in engine.moduleStates and the error went through the error tiers),
   * and its save parts took back what the last save kept for them, afterLoad round included: until then the load holds gameplay, as any load does (core/saves/stateReplace.js).
   * engine.use() returns the engine, so await this to know a late module is running.
   * @returns {Promise<void>}
   * @example engine.use(shop()); await engine.loading.settled(); engine.explain({ module: 'shop' }).ok   // true
   */
  async settled() { while (this._inits.size || this._parts.size) await Promise.allSettled([...this._inits, ...this._parts]); }

  /**
   * @internal The one limit: p, or fail()'s error once lastSign() (the time of the last sign of life, null: stop watching) is older than timeoutMs. It only answers the waiter; p goes on unless fail ends it.
   * @template T
   * @param {Promise<T>} p
   * @param {() => number | null} lastSign
   * @param {() => any} fail
   * @returns {Promise<T>}
   */
  _limit(p, lastSign, fail) {
    let timer;
    const over = new Promise((_, rej) => {
      const look = () => {
        const last = lastSign();
        if (last == null || this.engine.disposed) return;
        const left = this.timeoutMs - (performance.now() - last);   // measure
        if (left > 0) timer = setTimeout(look, Math.min(left, 2 ** 31 - 1));   // main-loop: a wall clock, because what it guards may be why no frame runs
        else rej(fail());
      };
      look();
    });
    const end = () => clearTimeout(timer);
    p.then(end, end);
    return Promise.race([p, over]);
  }

  /** Start (or restart) a task; engine-internal callers keep the returned task and move its phase */
  _begin(name, kind, opts) { const t = new Task(name, kind, opts); this.tasks.set(kind + ':' + name, t); return t; }   // keyed by kind too: a module and a model may share a name
  _done(t) { t.phase('done', 1); }
  /** A load ended on purpose (assets.release, dispose): it neither finished nor failed, so the record goes; the next load of that name starts its own */
  _drop(t) { if (this.tasks.get(t.kind + ':' + t.name) === t) this.tasks.delete(t.kind + ':' + t.name); }
  /** Record a failure: err may carry url / status (LoadError) */
  _fail(t, err, fallback = null) {
    t.phase('failed');
    t.error = { message: String(err?.message ?? err), url: err?.url ?? t.source.url, ...(err?.status ? { status: err.status } : {}) };
    t.fallback = fallback;
  }

  /**
   * Run one of the game's own loading steps as a task, so it shows in describe().loading and on the loading screen.
   * critical (default true): when it fails before start() finishes, start() stops with the reason instead of starting a broken game.
   * @template T
   * @param {string} name e.g. 'level-data'
   * @param {() => Promise<T>} fn
   * @param {{ critical?: boolean }} [opts]
   * @returns {Promise<T>}
   * @example const data = await engine.loading.track('level-data', () => fetch('/levels/1.json').then(r => r.json()));
  */
  async track(name, fn, { critical = true } = {}) {
    const t = this._begin(name, 'step', { critical });
    t.phase('build');
    try { const v = await fn(); this._done(t); return v; } catch (err) { this._fail(t, err); throw err; }
  }

  /**
   * One task with its source (which manifest, which path, file version / size, animation names), or null.
   * @param {string} name asset name (or path for unregistered loads), module name, or track() name
   * @param {string} [kind] model / texture / sound / module / step, when one name is used by several kinds
   * @example engine.loading.get('hero')   // { phase: 'done', source: { manifest: 'main', url: '/models/hero.glb', animations: ['idle', 'walk'] } ... }
  */
  get(name, kind) {
    const t = kind ? this.tasks.get(kind + ':' + name) : [...this.tasks.values()].find(x => x.name === name);
    return t?.toJSON() ?? null;
  }
  /**
   * Every task so far (JSON-able), optionally only one kind or phase.
   * @param {{ kind?: string, phase?: string }} [filter]
   * @example engine.loading.list({ phase: 'failed' })
  */
  list({ kind, phase } = {}) {
    return [...this.tasks.values()].filter(t => (!kind || t.kind === kind) && (!phase || t.state === phase)).map(t => t.toJSON());
  }

  /** Pending items: unfinished tasks + modules whose isReady is false + the stream's required builds (live, not stored) */
  _pending() {
    const e = this.engine, out = [...this.tasks.values()].filter(t => !END.has(t.state));
    for (const m of e.modules.values()) if (m.isReady && !m.isReady(e)) out.push(Object.assign(new Task(m.name, 'module', { critical: true }), { state: 'build', label: e.moduleName(m) }));
    if (!e.stream.ready) out.push(Object.assign(new Task('stream', 'stream', { critical: true }), { state: 'build' }));
    return out;
  }
  /** The item to name when asked "what are we waiting for": a critical one first, else the oldest */
  _current(pending) { return pending.find(t => t.critical) ?? pending[0] ?? null; }

  /**
   * The summary describe().loading shows. done: nothing pending; ok: nothing failed and no missing references;
   * blocked: a critical item failed before start() finished; waiting: one English line naming the current item.
   * @returns {import('../../types/core').LoadingView}
  */
  view() {
    const pending = this._pending(), all = [...this.tasks.values()];
    const failed = all.filter(t => t.state === 'failed'), warned = all.filter(t => t.state === 'done' && t.missing.length);
    const cur = this._current(pending);
    return {
      done: !pending.length, ok: !failed.length && !warned.length,
      blocked: !this.engine.ready && failed.some(t => t.critical),
      waiting: cur ? waitingText(cur) : null,
      pending: pending.slice(0, LIST_MAX).map(t => ({ name: t.name, kind: t.kind, phase: t.state, progress: Math.round(t.progress * 100) / 100, critical: t.critical })),
      failed: failed.slice(0, LIST_MAX).map(t => t.toJSON()),
      warnings: warned.slice(0, LIST_MAX).map(t => ({ name: t.name, missing: t.missing, source: t.source })),
      counts: { total: all.length, done: all.length - failed.length - all.filter(t => !END.has(t.state)).length, failed: failed.length, pending: pending.length },
    };
  }

  /** Player-facing text for the loading screen (i18n keys loading.<phase>); null when nothing is pending */
  text() {
    const cur = this._current(this._pending());
    if (!cur) return null;
    const e = this.engine, name = cur.label ?? (cur.kind === 'stream' ? e.t('common.world') : cur.name);
    return e.t(cur.kind === 'module' || cur.kind === 'stream' ? 'common.generating' : 'loading.' + cur.state, { name });
  }
}

/** English line for describe / the bridge: 'decoding model "hero" (/models/hero.glb, manifest "main") 40%' */
function waitingText(t) {
  const verb = t.kind === 'module' ? VERB.module : VERB[t.state];
  // module: its id only; t.label is the player-facing translated name (the loading screen's), which put "(地形)" into this English line
  const what = t.kind === 'module' ? t.name : t.kind === 'stream' ? 'the stream\'s required nearby builds' : `${t.kind} "${t.name}"`;
  const src = t.source?.url && t.source.url !== t.name ? ` (${t.source.url}${t.source.manifest ? `, manifest "${t.source.manifest}"` : ''})` : '';
  return `${verb} ${what}${src}${t.state === 'download' && t.progress > 0 ? ' ' + Math.round(t.progress * 100) + '%' : ''}`;
}

/** One English line per failure, for the start() error, the bridge and errors.log */
export function failureText(t) {
  const j = t.toJSON?.() ?? t, s = j.source || {}, err = j.error || {};
  const where = [err.url && err.url !== s.url ? `missing ${err.url}` : null, s.manifest ? `manifest "${s.manifest}"` : null].filter(Boolean);
  return `${j.kind} "${j.name}" <- ${s.url ?? j.name}: ${err.message}${where.length ? ` [${where.join(', ')}]` : ''}`;
}

export const handRolled = [{ kind: 'loading', seen: 'a loading screen of its own', use: 'engine.loading: tracks what is loading, shows progress and has a view you can replace (recipe 07)', quiet: /\bengine\.loading\b/, code: /\b(createElement|innerHTML|className|classList|getElementById|querySelector|\.id)\b/, raw: /(?:createElement|innerHTML|className|classList|getElementById|querySelector|\.id\b)[^,;{}]*(?:loading|loader|load-?bar|progress-?bar)|(?:loading|loader|load-?bar|progress-?bar)[^,;{}]*(?:createElement|innerHTML|className|classList|getElementById|querySelector|\.id\b)/i }];
