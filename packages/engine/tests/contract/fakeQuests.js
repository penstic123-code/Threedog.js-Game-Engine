// A whole replacement quests module in ~40 lines against the public core only (events, saves): the proof that modules/gameplay/quests.contract.js
// is small enough to meet. The shared contract check runs it like the engine's own; the browser test (specs/ui-nav.mjs) has the content loader
// define and start a quest through it and the hud draw its step target. Deliberately plain: steps finish only through advance(id), no log window.
export function fakeQuests() {
  let e = null;
  const defs = new Map(), prog = {};
  const api = {
    define(id, def) { defs.set(id, def); return api; },
    start(id) { if (!defs.has(id) || prog[id]) return; prog[id] = { step: 0, done: false }; e.events.emit('quest:start', { id }); },
    advance(id) {
      const s = prog[id], d = defs.get(id);
      if (!s || s.done) return false;
      s.step++; e.events.emit('quest:step', { id, step: s.step });
      if (s.step >= d.steps.length) { s.done = true; d.reward?.(e); e.events.emit('quest:done', { id }); }
      return true;
    },
    state(id) { const s = prog[id]; return s ? { step: s.step, steps: defs.get(id).steps.length, done: s.done, failed: false, active: !s.done } : null; },
    list() {
      return Object.entries(prog).map(([id, s]) => {
        const d = defs.get(id);
        return { id, title: d.title, desc: d.desc, done: s.done, failed: false, steps: d.steps.map((st, i) => ({ text: st.text, target: st.target, done: s.done || i < s.step, current: !s.done && i === s.step })) };
      });
    },
  };
  return {
    name: 'quests', type: 'rules',
    content: { quests: { commit(d) { for (const [id, q] of Object.entries(d)) api.define(id, q); } } },
    install(engine) {
      e = engine;
      e.saves.define('quests', { version: 3, save: () => ({ state: structuredClone(prog) }), load: d => { for (const k of Object.keys(prog)) delete prog[k]; Object.assign(prog, d?.state ?? {}); } });
      return api;
    },
    describe() { return { active: api.list().filter(q => !q.done).map(q => q.id) }; },
  };
}
