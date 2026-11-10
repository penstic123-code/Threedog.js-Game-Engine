// Quests module: made of steps, each with a completion condition (function), checked every half second (game time, in the fixed step; not checked while
// frozen/paused). The game's key (presets.bindings.quests or its own; none built in) opens the quest log. What a replacement must provide: quests.contract.js.
//
// quests.define('first-photo', {
//   title: '第一张照片', desc: '…',
//   steps: [
//     { text: '和老渔夫聊聊', done: e => e.vars.flag('metFisher'), target: npc.root },   // target: auto-marked when the hud module is present
//     { id: 'sunset', text: '在傍晚拍一张照片', done: e => e.vars.counter('sunsetPhotos') >= 1 },   // id: the save's name for this step
//   ],
//   reward: e => e.inventory.add('film', 3),
// });
// quests.start('first-photo');
// A step can be parallel goals { text?, all: [{ text, done, target, optional }] } (done when every non-optional part is done, in any order);
// a quest can fail: fail: e => bool is checked while it is active, then onFail runs, quest:fail fires, and start(id) may begin it again.
// Reward: the quest finishes either way. A reward that answers with a failure (content.run's answer, or { ok: false, code } from a function) is decided in _pay, the one place
// for it: the game's onUnpaid if it has one; else the items that did not fit are owed (saved, in list()) and go into the bag when there is room. Either way quest:unpaid fires.
// Saves name steps and parts by id (step / part id: 'mayor'), else by position; give them ids once the game ships, so inserting a step later
// does not move players to another step. Save shape (version 3): { state: { questId: { step?: stepId, done?, failed?, owed?: { itemId: n }, parts?: [partId met], got?: { stepId:
// [partId] }, visited?: [stepId left] } } }.
// A step goes to the next in the list unless it has `next`: a step id, or e => id chosen when the step is done (branches; visited says which ran); false finishes the quest there.
// The log window is the UI part 'questLog' (questLog.js): replace it or turn it off with engine.ui.set('questLog', ...) (recipes/26-ui-parts.md).
import { keepTable } from '../../core/base/sections.js';
import { toast, toggleOnKey } from '../../ui/UI.js';
import { questLogWindow } from './questLog.js';
import { warnMissing, warnOnce, DEV } from '../../core/base/validate.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { codedError } from '../../core/base/errorHints.js';
import { reportError } from '../../core/base/errors.js';
import { isPlainObject } from '../../core/base/util.js';
import { failure, isRunFailure } from '../../core/ops/opsFail.js';
import { refuseSave } from '../../core/base/saveValues.js';
import { toSaved, fromSaved, migrateV1, stepId } from './questSave.js';

const STRINGS = {
  'zh-CN': { 'module.quests': '任务', 'quests.title': '任务日志', 'quests.action': '任务', 'quests.empty': '还没有任务。', 'quests.new': '新任务：{title}', 'quests.done': '任务完成：{title}', 'quests.unpaid': '奖励未能发放：{title}', 'quests.doneTag': '（已完成）', 'quests.failed': '任务失败：{title}' },
  en: { 'module.quests': 'quests', 'quests.title': 'Journal', 'quests.action': 'Journal', 'quests.empty': 'No quests yet.', 'quests.new': 'New quest: {title}', 'quests.done': 'Quest complete: {title}', 'quests.unpaid': 'Reward not given: {title}', 'quests.doneTag': ' (done)', 'quests.failed': 'Quest failed: {title}' },
};

/** A step's text; a parallel step without its own text lists its required parts */
const stepText = st => st.text ?? st.all.filter(p => !p.optional).map(p => p.text).join(' / ');
export class Quests {
  constructor(engine, { action, checkInterval, notify } = {}, ctx) {
    const { track } = ctx;
    this.engine = engine;
    this.defs = new Map();
    /** @internal id -> { step, done, failed?, parts? (parts done in the current parallel step), got? (parts met in finished parallel steps) }; read it with state(id) */
    this._progress = {};
    /** @internal saved progress of quests not defined yet (content loaded after the save): applied by define(), written back unchanged meanwhile */ this._saved = {};
    /** @internal fixed steps until the next condition check (whole steps: the same after a load, a skip or stepping) */ this._t = 0;
    /** @internal a check fell inside an engine.skip: run it on the skip's last segment */ this._due = false;
    this.action = action; this.checkInterval = checkInterval;
    this.notify = notify;   // true toast (kind 'quest') · false silent · function ({ type, id, text }) => void
    engine.i18n.add(STRINGS);
    // declared only: the game binds the key (presets.bindings.quests or its own; [] = no key), so every key in a game comes from one bindings table
    track(engine.input.define(action, { label: 'quests.action', owner: 'quests' }));
    this.win = questLogWindow(engine, this, ctx);   // { open, toggle, refresh } over engine.ui
    // saved by stable step ids (questSave.js); version 1 saved positions
    ctx.saves.define('quests', { atomic: true, version: 3, migrate: { 1: d => migrateV1(this.defs, d), 2: d => d }, save: () => this._save(), load: d => this._load(d) });
  }

  /**
   * Define a quest. A step is { id?, text, done, target } or parallel goals { id?, text?, all: [{ id?, text, done, target, optional }] }.
   * id: a stable name for the step (saves store progress by it, so steps can be inserted or reordered later); default its position.
   * fail: checked while active; true fails the quest (onFail runs, quest:fail fires; start(id) can begin it again).
   * @example quests.define('defend', { title: '守住营地', steps: [
   *   { text: '到营地', done: e => e.vars.flag('atCamp') },
   *   { all: [{ text: '守住 A 点', done: e => e.vars.flag('heldA') }, { text: '守住 B 点', done: e => e.vars.flag('heldB') },
   *           { text: '没人受伤', done: e => e.vars.flag('noHurt'), optional: true }] },
   * ], fail: e => e.vars.flag('campLost'), onFail: e => e.vars.setFlag('mayRetry') });
   * @param {string} id
   * @param {any} def
   */
  /** @internal A failed content load puts the definitions back, and the progress define took from the save (core/base/sections.js undo): the function that does it @returns {() => void} */
  undoPoint() {
    const defs = keepTable(this.defs), saved = { ...this._saved }, progress = { ...this._progress };
    return () => { defs(); this._saved = saved; this._progress = progress; };
  }
  define(id, def) {
    const at = `quests.define('${id}')`;
    readParams(at, keysSchema(['title', 'desc', 'steps', 'reward', 'onUnpaid', 'fail', 'onFail']), def);
    if (!Array.isArray(def?.steps)) throw codedError('quest-step', `${at}: steps is a list of steps, e.g. steps: [{ text: 'Find the key', done: e => e.vars.flag('key') }]; got ${JSON.stringify(def?.steps)}`);   // every later read needs it, and this one names the quest
    for (const s of def.steps) {
      if (!s.all && (typeof s.done !== 'function' || s.optional !== undefined)) throw codedError('quest-step', `${at}: a step needs done (a function), or all: [parts] for parallel goals; optional goes on a part inside all`);
      readParams(`${at} steps`, keysSchema(s.all ? ['id', 'text', 'all', 'next'] : ['id', 'text', 'done', 'target', 'next']), s);
      for (const p of s.all || []) readParams(`${at} parallel part`, keysSchema(['id', 'text', 'done', 'target', 'optional']), p);
      if (s.all && !s.all.some(p => !p.optional)) throw codedError('quest-step', `${at}: a parallel step needs at least one part without optional: true, or it would finish at once`);
    }
    const ids = def.steps.map((_, i) => stepId(def, i)), dup = ids.find((x, i) => ids.indexOf(x) !== i);
    if (dup != null) throw codedError('quest-step', `${at}: two steps have the id '${dup}'; step ids must be unique (saves find a step by it)`);
    for (const s of def.steps) if (s.next != null && s.next !== false && typeof s.next !== 'function' && !ids.includes(s.next)) throw codedError('quest-step', `${at}: next is a step id or e => id; '${s.next}' is not a step of this quest (${ids.join(', ')})`);
    this.defs.set(id, def);
    if (id in this._saved) { this._progress[id] = fromSaved(id, def, this._saved[id]); delete this._saved[id]; this.win.refresh(); }
    return this;
  }
  /** @internal save part data: progress by step ids, plus saved quests not defined yet */
  _save() {
    const state = { ...this._saved };
    for (const [id, s] of Object.entries(this._progress)) { const d = this.defs.get(id); if (d) state[id] = toSaved(d, s); }
    return { state, checkIn: this._t };   // the check timer is playthrough state too: a load checks on the same step as play went on
  }
  /** @internal fixed steps between condition checks */
  get _period() { return Math.max(1, Math.round(this.checkInterval * 60)); }   // 60 = the engine's fixed steps per second
  /** @internal */
  _load(d) {
    const quest = q => isPlainObject(q) && (q.visited == null || Array.isArray(q.visited)) && (q.parts == null || Array.isArray(q.parts)) && (q.got == null || (isPlainObject(q.got) && Object.values(q.got).every(Array.isArray)));
    if (d != null && !(isPlainObject(d) && (d.state == null || (isPlainObject(d.state) && Object.values(d.state).every(quest))))) refuseSave('quests', 'the part', 'must be { state: { quest id: { step, done, parts, got } } }', d);
    this._progress = {}; this._saved = {}; this._t = Number.isInteger(d?.checkIn) ? d.checkIn : 0;
    for (const [id, q] of Object.entries(d?.state || {})) { const def = this.defs.get(id); if (def) this._progress[id] = fromSaved(id, def, q); else this._saved[id] = q; }
    this.win.refresh();
  }
  /**
   * Quest list (for custom UI): unfinished first. A step is done once the quest has left it, so a step `next` jumped over stays not done, and the step a loop came back to is current. A parallel step has parts [{ text, target, done, optional }]; its text defaults to the required parts joined.
   */
  list() {
    return Object.entries(this._progress).filter(([id]) => this.defs.has(id)).sort((a, b) => a[1].done - b[1].done).map(([id, s]) => {
      const d = this.defs.get(id), live = !s.done && !s.failed, ran = new Set(s.visited);
      return { id, title: d.title, desc: d.desc, done: s.done, failed: !!s.failed, ...(s.owed && { owed: { ...s.owed } }), steps: d.steps.map((st, i) => {
        const now = live && i === s.step, row = { text: st.text, target: st.target, done: !now && ran.has(stepId(d, i)), current: now };
        if (st.all) {
          const met = now ? s.parts : s.got?.[i];
          row.parts = st.all.map((p, k) => ({ text: p.text, target: p.target, optional: !!p.optional, done: !!met?.[k] || (row.done && !p.optional) }));
          row.text = stepText(st);
        }
        return row;
      }) };
    });
  }
  start(id) {
    if (!this.defs.has(id)) { warnMissing('quest', id, [...this.defs.keys()]); return; }
    if (this._progress[id] && !this._progress[id].failed) {   // a failed quest may be taken again (a daily order, a retry); an active one is a harmless repeat
      if (this._progress[id].done) warnOnce(`quests.start('${id}'): the quest is already done, so nothing happens (a done quest does not restart). Use a new quest id for a repeatable order, or let it fail first`);
      return;
    }
    DEV && this.engine.ops.guard('quests.start');
    this._progress[id] = { step: 0, done: false };
    this._say('start', id, this.engine.t('quests.new', { title: this.defs.get(id).title }));
    this.engine.events.emit('quest:start', { id });
    this.win.refresh();
  }
  /** @internal A quest message: a toast, nothing, or the game's own function (souls-likes keep quests silent) */
  _say(type, id, text) {
    if (this.notify === true) toast(this.engine, text, { kind: 'quest' });
    else if (typeof this.notify === 'function') this.notify({ type, id, text });
  }
  /**
   * One quest's progress as plain values: { step (index of the current step), steps (how many), done, failed, active, visited (ids of the steps left) } or null when it has not started.
   * A copy: change progress with start / advance, never by writing it.
   * @param {string} id
   */
  state(id) {
    const s = this._progress[id], d = this.defs.get(id);
    return s && d ? { step: s.step, steps: d.steps.length, done: !!s.done, failed: !!s.failed, active: !s.done && !s.failed, visited: [...s.visited ?? []] } : null;
  }
  /**
   * Finish the current step by hand (a step the game completes from its own code: a cutscene ended, a boss fell) and go on; the last step completes the
   * quest (reward, quest:done). The step's done() is not asked. Returns false when the quest is not active.
   * @param {string} id
   */
  advance(id) {
    const s = this._progress[id], d = this.defs.get(id), e = this.engine;
    if (!s || !d || s.done || s.failed || s.step >= d.steps.length) return false;   // past the last step: a quest:step listener, the quest is finishing
    DEV && e.ops.guard('quests.advance');
    this._leave(id, s, d); e.events.emit('quest:step', { id, step: s.step });
    this._finishOrSay(id, s, d, true);
    return true;
  }
  /** @internal go from the finished step to the next: its `next` (an id, or e => id asked now) else the following one; the step left goes into visited */
  _leave(id, s, d) {
    const here = stepId(d, s.step), st = d.steps[s.step];
    let want = st.next;
    if (typeof want === 'function') { try { want = want(this.engine); } catch (err) { reportError(this.engine, err, `quest '${id}' next`, { soft: true }); want = undefined; } }
    (s.visited ??= []).includes(here) || s.visited.push(here);
    delete s.parts;
    const to = want == null ? s.step + 1 : want === false ? d.steps.length : d.steps.findIndex((_, i) => stepId(d, i) === want);
    if (to < 0) { reportError(this.engine, codedError('quest-step', `quest '${id}': step '${here}' chose next '${want}', which is not a step; going to the following step`), 'quest next', { soft: true }); s.step++; } else s.step = to;
  }
  /** @internal after steps moved: complete the quest at the end, else announce the new step */
  _finishOrSay(id, s, d, advanced) {
    if (s.done || s.failed) return;   // a quest:step listener already took it to its end: the reward is paid once
    if (s.step >= d.steps.length) {
      s.done = true;
      const paid = this._ask(id, 'reward', d.reward);
      this._say('done', id, this.engine.t('quests.done', { title: d.title })); this.engine.events.emit('quest:done', { id });
      this._pay(id, s, d, paid);
    } else if (advanced) this._say('step', id, stepText(d.steps[s.step]));
    if (advanced) this.win.refresh();
  }
  /**
   * @internal Run a reward or onFail and read its answer. The quest has already moved on, so one that throws must not stop here: quest:done and the toast would be lost and the
   * reward half given. It is reported (soft, no freeze) and answers as a failure, with what the words beside it said (words.js)
   */
  _ask(id, what, fn, ...args) {
    try { return fn?.(this.engine, ...args); } catch (err) {
      reportError(this.engine, err, `quest '${id}' ${what}`, { soft: true });
      return err.answer?.ok === false ? err.answer : failure('error');
    }
  }
  /**
   * @internal The one place that says what a reward not given means. What happens to it is the game's: onUnpaid decides, and then nothing is kept. Without one the safe default
   * keeps what can be given later as a debt and tells the player. Function rewards and other words cannot be asked twice (they may have half run), so they are only reported
   */
  _pay(id, s, d, answer) {
    if (!isRunFailure(answer)) return;
    const failed = answer.facts?.failed ?? [{ word: 'reward', code: answer.code, facts: answer.facts }]   // a reward function may answer a plain { ok: false, code } with no facts;
    if (d.onUnpaid) this._ask(id, 'onUnpaid', d.onUnpaid, answer);
    else {
      for (const f of failed) for (const [item, n] of Object.entries(f.word === 'give' ? f.facts.left : {})) (s.owed ??= {})[item] = (s.owed?.[item] ?? 0) + n;
      this._say('unpaid', id, this.engine.t('quests.unpaid', { title: d.title }));
    }
    this.engine.events.emit('quest:unpaid', { id, code: answer.code, failed, owed: s.owed ? { ...s.owed } : null });
  }
  /** @internal Pay a debt as far as it fits. Only when something does: add in a full bag tells the player so, and this asks twice a second. A debt that throws (the item is gone from the game) cannot be paid, ever */
  _collect(id, s) {
    const e = this.engine, bag = e.inventory?.of(e.ops.actor);
    const answer = bag && this._ask(id, 'owed reward', () => {
      for (const [item, n] of Object.entries(s.owed)) {
        if ((bag.room?.(item) ?? 1) < 1) continue;   // room is the engine bag's; a replacement without it is just asked
        const r = bag.add(item, n), got = r.ok ? r.added : 0;
        if (got < n) s.owed[item] = n - got; else delete s.owed[item];
      }
    });
    if (isRunFailure(answer) || !Object.keys(s.owed).length) delete s.owed;
  }
  isDone(id) { return !!this._progress[id]?.done; }
  isActive(id) { const s = this._progress[id]; return !!s && !s.done && !s.failed; }
  isFailed(id) { return !!this._progress[id]?.failed; }

  check() {
    const e = this.engine;
    for (const [id, s] of Object.entries(this._progress)) {
      if (s.owed) this._collect(id, s);
      if (s.done || s.failed) continue;
      const d = this.defs.get(id); if (!d) continue;
      if (d.fail?.(e)) { this._fail(id, s, d); continue; }
      let advanced = false;
      // at most one pass over the steps per check: a `next` that loops back to a step already done must wait for the next check, not hang
      for (let n = 0; n < d.steps.length && s.step < d.steps.length && this._stepDone(id, s, d.steps[s.step]); n++) { DEV && e.ops.guard('quests.advance'); this._leave(id, s, d); advanced = true; e.events.emit('quest:step', { id, step: s.step }); }
      this._finishOrSay(id, s, d, advanced);
    }
  }
  /** @internal Plain step: its condition. Parallel step: tick off parts as they are met (each stays done); done when no required part is left */
  _stepDone(id, s, st) {
    if (!st.all) return st.done(this.engine);
    const parts = s.parts ??= st.all.map(() => false);
    let left = false;
    for (let k = 0; k < st.all.length; k++) {
      const p = st.all[k];
      if (!parts[k] && p.done(this.engine)) {
        DEV && this.engine.ops.guard('quests.advance');
        parts[k] = true; this.engine.events.emit('quest:part', { id, step: s.step, part: k }); this.win.refresh();
        if (s.parts !== parts) return false;   // a quest:part listener advanced / failed the quest: this step's parts are gone, and the check must not read them or judge the new step by them
      }
      if (!parts[k] && !p.optional) left = true;
    }
    if (!left && s.parts.some((x, k) => x && st.all[k].optional)) (s.got ??= {})[s.step] = s.parts;   // optional goals met stay visible in list()
    return !left;
  }
  /** @internal */
  _fail(id, s, d) {
    DEV && this.engine.ops.guard('quests.fail');
    s.failed = true;
    this._ask(id, 'onFail', d.onFail);
    this._say('fail', id, this.engine.t('quests.failed', { title: d.title }));
    this.engine.events.emit('quest:fail', { id });
    this.win.refresh();
  }
}

const QUEST_PARAMS = {
  action: { type: 'string', default: 'quests', desc: 'input action that opens the quest log' },
  checkInterval: { type: 'number', default: 0.5, min: 0, desc: 'real seconds between quest condition checks' },
  notify: { type: 'any', default: true, desc: 'true = toast, false = silent, or a function ({ type, id, text }) => void' },
};

/**
 * The quests section of content data, and its startQuest effect word. A step target can be a place, { place, x, z }, { x, z }, { npc: 'id' } (follows the NPC: the
 * position is read each frame) or { nearest: itemId } (the nearest pickup). A step may be parallel goals { text?, all: [{ text, done, target, optional }] };
 * fail / onFail are a condition and an effect like done / reward
 */
function questContent() {
  const startOn = new Map();
  const targets = q => q.steps.flatMap(s => s.all ?? [s]).map(s => s.target).filter(Boolean);
  const listen = (e, track, id, event) => startOn.set(id, { event, on: track(e.events.on(event, () => e.quests?.start(id))) });
  return {
    desc: 'quests (id -> title, steps, reward; a step can have a target position)',
    references: d => Object.entries(d).flatMap(([id, q]) => targets(q).flatMap(t => [
      ...(t.npc ? [{ section: 'npcs', id: t.npc, at: `quests.${id}` }] : []), ...(t.nearest ? [{ section: 'items', id: t.nearest, at: `quests.${id}` }] : [])])),
    effects: { startQuest: { ref: 'quest', desc: 'start a quest', describe: v => `start quest ${v}`, run: (e, v) => e.quests.start(v) } },
    undo(d, { engine: e, track }) {
      const back = e.quests.undoPoint(), was = new Map(startOn);
      return () => {
        back();
        for (const id of Object.keys(d)) {
          startOn.get(id)?.on.remove(); startOn.delete(id);
          if (was.has(id)) listen(e, track, id, was.get(id).event);
        }
      };
    },
    commit(d, { engine: e, content, where, track }) {
      const target = t => t == null ? undefined : t.npc ? () => e.npcs?.get(t.npc)?.position : t.nearest ? t : where(typeof t === 'string' ? { place: t } : t);
      const goal = s => ({ ...(s.id != null && { id: s.id }), text: s.text, done: () => content.test(s.done), target: target(s.target), ...(s.optional && { optional: true }), ...(s.next != null && { next: s.next }) });   // id: stable for saves
      for (const [id, q] of Object.entries(d)) {
        e.quests.define(id, {
          title: q.title, desc: q.desc,
          steps: q.steps.map(s => s.all ? { ...(s.id != null && { id: s.id }), text: s.text, all: s.all.map(goal), ...(s.next != null && { next: s.next }) } : goal(s)),
          reward: q.reward && (() => content.run(q.reward)),
          ...(q.onUnpaid && { onUnpaid: () => content.run(q.onUnpaid) }),
          ...(q.fail && { fail: () => content.test(q.fail) }), ...(q.onFail && { onFail: () => content.run(q.onFail) }),
        });
        startOn.get(id)?.on.remove();   // loading the same quest again: replace the old listener instead of attaching twice
        if (q.startOn) listen(e, track, id, q.startOn);
      }
    },
  };
}

/**
 * Quests module. Installs engine.quests. The 'quests' action opens the quest log; the game binds it (presets.bindings.quests has J / gamepad Select) @example
 * engine.use(quests()); engine.input.bind(presets.bindings.quests)
 */
export function quests(opts = {}) {
  const o = readParams('quests', QUEST_PARAMS, opts);
  let q = null;
  return {
    content: { quests: questContent() },
    name: 'quests', skipKind: 'approx', type: 'rules', provides: ['quests'], label: 'Quests', params: QUEST_PARAMS, options: o,
    // o: the schema defaults are filled in, the class repeats none
    install(e, ctx) { q = new Quests(e, o, ctx); return q; },
    // Check quests in the fixed step (game time; not while frozen or flow is paused, so no rewards are granted while paused)
    fixed() { if (--q._t <= 0) { q._t = q._period; q.check(); } },
    // engine.skip: the countdown lands where stepping would have left it; conditions are checked once, on the last segment, if a check fell inside
    skip(dt, e, done) {
      const n = Math.round(dt * 60), P = q._period, t = Math.max(1, q._t);   // 0 (a fresh start) checks on the next step, like 1
      if (n < t) q._t = t - n;
      else { q._t = P - ((n - t) % P); q._due = true; }
      if (done && q._due) { q._due = false; q.check(); }
    },
    frame(dt, e) { toggleOnKey(e, q.win, q.action); },
    // engine.explain({ quest: id }): where a quest is stuck, so the AI need not read every done() function
    explain: { quest(e, id) {
      const d = q.defs.get(id), s = q._progress[id];
      if (!d) return { ok: false, text: `quest '${id}' is not defined (defined: ${[...q.defs.keys()].join(', ') || 'none'})` };
      if (!s) return { ok: false, text: `quest '${id}' has not started (quests.start('${id}') or a content start effect)` };
      if (s.done) return { ok: true, text: `quest '${id}' is done` };
      if (s.failed) return { ok: false, text: `quest '${id}' failed (its fail() returned true; start('${id}') begins it again)` };
      const st = d.steps[s.step], at = `quest '${id}' waits on step ${s.step + 1}/${d.steps.length} "${stepText(st)}"`, every = `(checked every ${q.checkInterval} s in fixed steps)`;
      if (!st.all) return { ok: false, step: s.step, text: `${at}: its done() returns ${!!st.done(e)} ${every}` };
      const left = st.all.filter((p, k) => !p.optional && !s.parts?.[k]).map(p => `"${p.text}"`);
      return { ok: false, step: s.step, text: `${at}: required parts not done yet: ${left.join(', ')} ${every}` };
    } },
    describe() {
      const list = q.list();
      return { active: list.filter(x => !x.done && !x.failed).map(x => ({ id: x.id, title: x.title, step: x.steps.find(s => s.current)?.text ?? null })),
        done: list.filter(x => x.done).length, failed: list.filter(x => x.failed).length };
    },
  };
}

export const handRolled = [{ kind: 'quests', seen: 'a quest list of its own', use: 'engine.quests (quests()): steps, rewards, markers and the log, saved with the game (recipe 04)', quiet: /\b(engine|e|eng|ctx)\.quests\b|\bquests\(\s*[{)]/, code: /(?:\b(?:const|let|var)\s+|\bthis\.)(?:quests?|questLog|missions?|objectives?)(?:List|Log|Data|s)?\s*=\s*(?:\[\s*\]|\{\s*\}|new Map\b)/i }];
