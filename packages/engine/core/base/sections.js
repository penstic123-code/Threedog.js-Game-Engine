// Content sections: the one protocol for "this data becomes live state". A module owns a section through its `content` field:
//   content: { quests: { desc, references, validate, prepare, commit, cancel } }
// validate(data, c) refuses bad data by throwing. prepare(data, c) does everything that can fail without touching the live game, and may be async.
// commit(prepared, c) swaps the prepared result in: it is the only step that changes state, so a failure before it leaves the old state whole. It returns
// DROPPED when this section gave way to a newer load of the same thing (the other sections go on), or a Promise for slow work nothing else stands on (a pack does not wait for it).
// waitFor(prepared, c): a Promise while the commits must wait for something newer that decides what they stand on; asked again when it ends. Every prepare is done by then.
// cancel(prepared, c): this prepare will not commit, let go of what it holds (prepared may be its Promise, still running: say so with a field on the Promise).
// undo(prepared, c): called just before commit; returns the function that puts back what this commit changes, whole or half done. A later step of the transaction
// failed, or this commit threw: every commit made so far is taken back, newest first, so state and registrations equal the state before it. That function may return a
// Promise (a level that has to load again): its first lines run in that order, what it waits for runs side by side, and the transaction fails only when all of it ended.
// What could not be put back rides on the error as err.notRestored, a list: the caller knows the old state is not whole.
// A commit that cannot leave a trace needs none; what a section without undo committed stays (a game kind's load is game code, so it runs after the modules' sections).
// Why one protocol: a level switch and a content pack are the same transaction at different sizes. Two forms would give them two failure rules.
// desc: one sentence for the docs and the "unknown content" error; the section's name and meaning are written here and nowhere else (metadata.mjs reads them).
// references(data): [{ section, id, at }], the ids this data names in other sections.
// effects: { word: { ref, desc, describe, run } }, effect words the section's owner runs, so replacing the module replaces its words too.
// live: true says one entry can be loaded again on its own in a running game, so the editor need not reload the page.
// once: true says commit gives state rather than a definition (starting goods): a module put back after a failed replaces has that state from its save part, so it is not committed again. A getter answers for this install: a level is state only once the save part brought it back.
// c from a content load: { engine, content, where, bind, zone, ids, origin, pickupId, track, after } (modules/content/loader.js).
import { codedError, coded } from './errorHints.js';
import { warnOnce } from './validate.js';

const KEYS = ['desc', 'references', 'validate', 'prepare', 'waitFor', 'commit', 'cancel', 'undo', 'effects', 'live', 'once'];

/** What a commit returns when it gave way to a newer load: this section is skipped, the newest stands, and the rest of the transaction goes on */
export const DROPPED = Symbol('section dropped');

/** An undo for a Map or Set a commit writes to: the function that puts its entries back. @param {Map<any, any> | Set<any>} t @returns {() => void} */
export function keepTable(t) {
  const was = [...t];
  return () => { t.clear(); for (const x of was) if (t instanceof Map) t.set(x[0], x[1]); else t.add(x); };
}

/** Every section of the installed modules: name -> { owner, ...section }. Two owners of one name are an error, not a last-writer-wins */
export function sectionsOf(e) {
  const out = new Map();
  for (const m of e.modules.values()) for (const [name, s] of Object.entries(m.content ?? {})) {
    if (out.has(name)) throw codedError('content-misuse', `content section "${name}" has two owners, ${out.get(name).owner} and ${m.name}: keep one`);
    const bad = Object.keys(s).find(k => !KEYS.includes(k));
    if (bad) throw codedError('content-misuse', `content section "${name}" of module ${m.name}: unknown key "${bad}". Keys: ${KEYS.join(', ')}`);
    if (typeof s.commit !== 'function') throw codedError('content-misuse', `content section "${name}" of module ${m.name} needs commit(prepared, c)`);
    out.set(name, { owner: m.name, name, ...s });
  }
  return out;
}

/**
 * Sections as one transaction, one or every pack of a load: all checked, then all prepared, then all committed in list order. Anything refused cancels what was prepared
 * and nothing commits; a commit that throws takes back the commits before it (undo, above). With nothing to wait for the commits run on this tick, so a
 * section is live on the next line; otherwise they run together once every prepare and `after` (an earlier transaction these stand on) are done, and a Promise of that
 * comes back. Either way they run in one tick, so nothing reads a half-committed load. around runs the commits (content's window for writes). A failure whose undo has to wait
 * rejects that Promise when the undo ended, even on the path that otherwise answers on this tick; around gets the Promise as fn's result.
 * @param {{ s: any, data: any, done?: (committed: any) => void, gaveWay?: () => void }[]} list  done: called after the section's commit with what it returned; gaveWay: when it returned DROPPED
 * @param {any} c
 * @param {{ after?: Promise<any> | null, around?: (fn: () => (void | Promise<void>)) => any }} [opts]
 * @returns {Promise<void> | undefined}
 */
export function runSections(list, c, { after = null, around = fn => fn() } = {}) {
  for (const { s, data } of list) s.validate?.(data, c);
  const prepared = [];
  const cancel = from => {
    for (let i = prepared.length - 1; i >= from; i--) {
      prepared[i]?.then?.(null, () => {});   // nobody waits for it now, so its failure is nobody's error
      list[i].s.cancel?.(prepared[i], c);
    }
  };
  try { for (const { s, data } of list) prepared.push(s.prepare ? s.prepare(data, c) : data); }
  catch (err) { cancel(0); throw err; }
  const commit = values => {
    const undos = [];
    const takeBack = cause => {
      const lost = [], waits = [];
      const told = (err, s) => { lost.push(err); warnOnce(coded('rollback-incomplete', `content: undo for section '${s.name ?? '?'}' owned by module '${s.owner ?? '?'}' failed: ${err.message}. Fix the undo its commit step returns, then reload the page before retrying; the state was only partly restored.`)); };
      for (const { fn, s } of undos.reverse()) {
        try { const r = fn(); if (typeof r?.then === 'function') waits.push(r.catch(err => told(err, s))); } catch (err) { told(err, s); }   // the rest still goes back
      }
      const fail = () => { if (lost.length) cause.notRestored = lost; throw cause; };
      if (waits.length) return Promise.all(waits).then(fail);
      fail();
    };
    let i = 0;
    try {
      for (; i < list.length; i++) {
        const undo = list[i].s.undo?.(values[i], c);
        if (undo) undos.push({ fn: undo, s: list[i].s });
        const r = list[i].s.commit(values[i], c);
        if (r === DROPPED) { if (undo) undos.pop(); list[i].gaveWay?.(); } else list[i].done?.(r);
      }
    } catch (err) { cancel(i + 1); return takeBack(err); }
  };
  if (!after && !prepared.some(p => typeof p?.then === 'function')) return around(() => commit(prepared));
  const settled = values => {
    const waits = list.flatMap((l, i) => l.s.waitFor?.(values[i], c) ?? []);
    return waits.length ? Promise.all(waits).then(() => settled(values)) : around(() => commit(values));
  };
  return Promise.all([after, ...prepared]).then(([, ...values]) => settled(values), err => { cancel(0); throw err; });
}
