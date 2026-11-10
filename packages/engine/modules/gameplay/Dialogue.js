// Dialogue module: data-driven dialogue (nodes + choices + conditions + callbacks), typewriter effect, confirm advances, choices by
// the cursor, clicks, or number keys when the game binds them (presets.bindings.dialogNumbers; the module binds no key).
// Typing runs on game time (frame dt accumulation), so engine.step advances it deterministically. Two channels:
//   main (default)  the conversation the player reads: locks game input and joins the UI focus stack (Esc won't open the settings menu; the key press that
//                   opened it does not advance). Its choices take the UI choice cursor (menu keys / d-pad / stick + confirm, ui/Focus.js), number keys and clicks.
//   bubble          lines over their speakers while the player keeps playing, several speakers at once, queued per speaker (dialogueBubbles.js):
//                   say(text, { channel: 'bubble', at: npc.root }) or start(script, 'start', onEnd, { channel: 'bubble', at })
// Drawing is the UI parts 'dialogue' (default: dialogueBox.js) and 'dialogue.bubble'; a game replaces them or turns them off with engine.ui.set (recipes/26-ui-parts.md).
// What a replacement dialogue module must provide: dialogue.contract.js.
//
// dialogue.define('老渔夫', {
//   start: { text: '今天的鱼不太咬钩。', next: 'ask', data: { portrait: 'fisher', mood: 'tired' } },   // data: the game's own fields, handed to the UI part and 'dialogue:line'
//   ask:   { text: '你是来拍照的吧？', choices: [
//            { text: '对，想拍日落', next: 'sunset', if: (state, engine) => true },
//            { text: '随便走走', next: 'end' } ] },
//   sunset:{ text: '去东边的山脊。', do: (state, engine) => engine.vars.setFlag('knowsSunset') },
// });
// dialogue.start('老渔夫');
// The speaker defaults to the script name; set speaker: '另一个人' on a node to switch speakers.
// Advancing and picking a choice are the ops dialogue.advance and dialogue.choose { index } (recipes/23-ops.md): keys, the cursor, clicks, the dev bridge and
// tests all run them, so a choice's do (which may change gameplay state) always runs inside a logged op.
import { keepTable } from '../../core/base/sections.js';
import { uiFocus } from '../../ui/UI.js';
import { warnMissing, warnOnce, fmt } from '../../core/base/validate.js';
import { reportError } from '../../core/base/errors.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { dialogueBox } from './dialogueBox.js';
import { codedError, coded } from '../../core/base/errorHints.js';
import { Bubbles, bubblePart } from './dialogueBubbles.js';
// 'data' is the one slot for game-specific fields: other unknown keys stay typos (a misspelled next would silently end the dialogue)
const NODE_KEYS = ['text', 'next', 'choices', 'do', 'speaker', 'data'], CHOICE_KEYS = ['text', 'next', 'if', 'do', 'data'];
const NONE = Object.freeze([]);
const OWN_FIELDS = ' (put your own fields in data: { ... })';
const CHANNELS = ['main', 'bubble'];
/** What _try answers when the game callback threw */
const FAIL = Symbol('dialogue callback threw');
const STR = {
  channel: "dialogue: channel '{got}' is not one of 'main' (the conversation the player reads, locks input) | 'bubble' (a line over its speaker while play goes on)",
  bubbleChoices: "[dialogue] '{name}' node '{id}' has choices: choices need the main channel (the player picks them), so on the bubble channel the script ends there",
};
const checkChannel = c => { if (!CHANNELS.includes(c)) throw codedError('module-params', fmt(STR.channel, { got: String(c) })); };
const SAY_KEYS = ['speaker', 'node', 'channel', 'at', 'seconds', 'queue', 'onCancel'], START_KEYS = ['channel', 'at', 'onCancel'];
const readLine = (fn, keys, o) => readParams(`dialogue.${fn}`, keysSchema(keys), o ?? {});

export class Dialogue {
  constructor(engine, { charsPerSecond = 40, advanceActions = ['confirm'], holdSeconds = 2, bubbleChoice = 'end' } = {}) {
    this.engine = engine;
    // a bubble script reaching a node with choices: 'end' (warn, the script ends there) or 'ask' (the line stays with its choices until dialogue.choose { index, run })
    if (bubbleChoice !== 'end' && bubbleChoice !== 'ask') throw codedError('module-params', `dialogue({ bubbleChoice }): 'end' (default) or 'ask'; got ${JSON.stringify(bubbleChoice)}`);
    this.bubbleChoice = bubbleChoice; /** @internal run id -> { opts, pick(i) } for bubble lines waiting for a choice */ this._asks = new Map(); this._askSeq = 0;
    this.scripts = new Map();
    this.state = { get flags() { return engine.vars.flags; } };   // story flags = engine.vars.flags (autosaved)
    this.charsPerSecond = charsPerSecond;
    // default: confirm only (a basic key). Other actions advance only when the game names them: advanceActions: ['confirm', 'interact']
    this.advanceActions = advanceActions;
    this.holdSeconds = holdSeconds;
    this.active = null;
    /** @internal the bubble channel */ this._bubbles = new Bubbles(this);
  }

  define(speaker, nodes) {
    for (const [id, n] of Object.entries(nodes || {})) {
      readParams(`dialogue '${speaker}' ${id}${OWN_FIELDS}`, keysSchema(NODE_KEYS), n);
      for (const c of n?.choices || []) readParams(`dialogue '${speaker}' ${id} choices${OWN_FIELDS}`, keysSchema(CHOICE_KEYS), c);
    }
    this.scripts.set(speaker, nodes);
  }
  /** Name of the script the main dialogue is playing (null when none). */
  get speaking() { return this.active?.speaker ?? null; }
  /**
   * Say a one-off line (no define needed); the returned Promise resolves when it ends; .remove() ends it now (it resolves too, the cancel convention); .id names a main-channel line.
   * say('天快黑了。', { speaker: '老渔夫' }), or pass a node table: say({ start: {...}, ... }).
   * channel: 'bubble' = over at (an Object3D, a position, an actor id; none = a screen line) while the player keeps playing; seconds / queue: dialogueBubbles.js.
   * Ending the playthrough (engine.session) drops the line and leaves the Promise pending: code awaiting it belonged to the old playthrough and never runs.
   */
  say(text, opts) {
    const { speaker = '', node = 'start', channel = 'main', at = null, seconds, queue, onCancel = null } = readLine('say', SAY_KEYS, opts);
    checkChannel(channel);
    if (channel === 'bubble' && typeof text !== 'object') { const p = this._bubbles.say(at, text, { speaker, seconds, queue }); p.id = null; return p; }
    const id = '__say_' + (this._sayId = (this._sayId || 0) + 1);
    this.define(id, typeof text === 'object' ? text : { start: { speaker, text } });
    let stop = () => {};
    const p = /** @type {any} */ (new Promise(res => {
      const done = () => { this.scripts.delete(id); res(); };
      if (channel === 'bubble') { const run = this._playBubbles(id, node, done, { at, seconds, queue }); stop = () => run.remove(); return; }
      this.start(id, node, done, { onCancel });
      stop = () => { if (this.active?.speaker === id) this.end(); };
    }));
    p.id = id; p.remove = () => stop();
    return p;
  }

  /** Lines on the bubble channel now: [{ speaker, text, queued }] */
  bubbles() { return this._bubbles.list(); }

  /** @internal a script on the bubble channel: each node one bubble on at, do runs, next follows; choices belong to the main channel (warned, ended) */
  _playBubbles(name, nodeId, onEnd, { at = null, seconds, queue } = {}) {
    const nodes = this.scripts.get(name);
    let stopped = false, cur = null;
    let asking = 0;
    const actor = this.engine.ops.actor;   // who it opened for, as on the main channel (_by)
    const finish = () => { if (!stopped) { stopped = true; onEnd?.(); } };
    const step = id => {
      const node = id && id !== 'end' && nodes[id];
      if (!node || stopped) { finish(); return; }
      const opts = node.choices?.length && this.bubbleChoice === 'ask' ? this._choicesOf(node) : null;
      if (opts === FAIL) { finish(); return; }
      if (node.choices?.length && !opts) { warnOnce(fmt(STR.bubbleChoices, { name, id })); finish(); return; }
      const text = this._try('dialogue text', () => this._line(node));
      if (text === FAIL || !this._do(node)) { finish(); return; }   // a throwing line ends this script on its own channel (its onEnter / promise settle), the main dialogue is left alone
      const speaker = node.speaker || (name.startsWith('__say_') ? '' : name);
      if (opts?.length) {   // 'ask': the line stays up with its choices until one is picked (dialogue.choose { index, run })
        const labels = this._try('dialogue choice', () => opts.map(c => this._line(c)));
        if (labels === FAIL) { finish(); return; }
        const run = asking = ++this._askSeq;
        cur = this._bubbles.say(at, text, { speaker, seconds: Infinity, queue, run, choices: labels });
        this._asks.set(run, { opts, actor, pick: i => { const c = opts[i]; this._asks.delete(run); asking = 0; cur.remove(); step(this._do(c) ? c.next || 'end' : 'end'); } });
        return;
      }
      cur = this._bubbles.say(at, text, { speaker, seconds, queue });
      cur.then(() => step(node.next || 'end'));
    };
    step(nodeId);
    return { remove: () => { this._asks.delete(asking); stopped || cur?.remove(); finish(); } };
  }

  /**
   * Start a script. Main channel (default): onCancel is what the back key (Esc) does while it is on top of the UI focus stack (default: nothing, Esc is
   * swallowed). channel: 'bubble' plays it as bubble lines over at instead (no lock, no choices; a conversation the player reads keeps running).
   */
  start(speaker, nodeId = 'start', onEnd = null, opts) {
    const { channel = 'main', at = null, onCancel = null } = readLine('start', START_KEYS, opts);
    checkChannel(channel);
    const nodes = this.scripts.get(speaker);
    // wrong name: warn with the fix and still call onEnd (so an NPC waiting on it and the say() Promise don't hang)
    if (!nodes) { warnMissing('dialogue', speaker, [...this.scripts.keys()].filter(k => !k.startsWith('__say_'))); onEnd?.(); return; }
    if (channel === 'bubble') { this._playBubbles(speaker, nodeId, onEnd, { at }); return; }
    while (this.active) this.end();   // end a running dialogue normally first (runs its onEnd so NPCs don't hang); an onEnd may open the next one, which ends too
    // join the UI focus stack (Esc swallowed unless onCancel; the choice cursor lives on this entry) and lock game input with an opaque context
    this.active = { speaker, nodes, onEnd, actor: this.engine.ops.actor, focus: uiFocus(this.engine).push('dialogue', { cancel: onCancel }), ctx: this.engine.input.push('dialog', { owner: 'dialogue' }), duringLoad: this.engine.saves.replacing };
    this.part = this.engine.ui.get('dialogue');
    this.part?.show();
    this.engine.events.emit('dialogue:start', speaker);
    this._show(nodeId);
  }

  end() {
    const a = this.active;
    this.active = null;
    this.part?.hide();
    a?.focus.remove();
    a?.ctx.remove();
    a?.onEnd?.();
    if (a) this.engine.events.emit('dialogue:end', a.speaker);
  }
  /** @internal session:end or a load: close the dialogue without its onEnd (that callback belongs to the old playthrough: an NPC's busy flag, a say() Promise); drop bubbles */
  _cancel() {
    this._bubbles.clear(); this._asks.clear();
    const a = this.active;
    if (!a) return;
    a.onEnd = null;
    if (a.speaker.startsWith('__say_')) this.scripts.delete(a.speaker);
    this.end();
  }

  /** @internal A node's or choice's do. One that throws ends the conversation, as a throwing step ends a cutscene: a line nobody can finish would keep the keys and a say() waiting */
  _do(x) { return this._try('dialogue do', () => { x.do?.(this.state, this.engine); }) !== FAIL; }
  /** @internal A node's or choice's text: a string, or a function of (state, engine) */
  _line(x) { return typeof x.text === 'function' ? x.text(this.state, this.engine) : x.text; }
  /** @internal Run a game callback; one that throws is reported (soft, no freeze) and answers FAIL, so the caller ends what it was showing instead of leaving it half open */
  _try(what, fn) { try { return fn(); } catch (err) { reportError(this.engine, err, what, { soft: true }); return FAIL; } }

  _show(id) {
    const a = this.active;
    if (!a) return;   // a dialogue:start listener ended it
    const node = id && a.nodes[id];
    if (!node && id && id !== 'end') warnMissing('node', id, Object.keys(a.nodes));   // next points at a node that doesn't exist
    if (!node || id === 'end') { this.end(); return; }
    a.node = node; a.id = id;
    a.focus.setNav(null);   // no choices while the new line types
    const text = this._try('dialogue text', () => this._line(node));
    if (text === FAIL || !this._do(node)) { this.end(); return; }   // a throwing line ends like a throwing do: a half-open line would keep the focus and the old line   // read the line before running effects, so it doesn't see flags just changed
    if (this.active !== a) return;        // do ended the dialogue or started another
    a.who = node.speaker || a.speaker;
    this.full = String(text ?? ''); this.shown = 0; this.typing = true; this._opts = null;
    this.engine.events.emit('dialogue:line', { script: a.speaker, node: id, speaker: a.who, text: this.full, data: node.data ?? {} });
    if (this.active !== a) return;        // a dialogue:line listener ended it (a skip key)
    if (!this.full || !(this.charsPerSecond > 0)) this._finishTyping();   // charsPerSecond 0 = whole line at once
    else this._draw();
  }

  _finishTyping() {
    this.typing = false;
    this.shown = this.full.length;
    const a = this.active, e = this.engine;
    const opts = this._choicesOf(a.node);
    // key: the first bound key only ('1', not '1/Numpad1'), so a rebound choice key shows its new name
    const choices = opts === FAIL ? FAIL : this._try('dialogue choice', () => opts.map((c, i) => ({ text: this._line(c), key: i < 9 ? e.input.label('choice' + (i + 1)).split('/')[0] || null : null, data: c.data ?? {} })));
    if (choices === FAIL) { this.end(); return; }   // a choice that throws ends the dialogue like a line that throws
    this._opts = opts.length ? opts : null; this._choices = choices;
    // the choice cursor: the menu keys / d-pad / stick move it, confirm picks (the same op as a click or a number key); the part draws view.selected
    if (this._opts) a.focus.setNav({ count: () => this._choices.length, moved: () => this._draw(), confirm: i => e.ops.run('dialogue.choose', { index: i }, this._by) });
    this._draw();
  }

  /** @internal who presses on in this conversation: the actor it was opened for (a seat, an NPC's op), so what its choices give does not land on the local player */
  get _by() { return { source: 'player', actor: this.active?.actor }; }
  /** @internal hand the current line to the UI part: plain data plus advance() / choose(i), which run the ops */
  _draw() {
    const a = this.active, e = this.engine, P = this._by;
    const hint = !this.typing && !this._opts ? e.t('dialogue.continue', { key: e.input.label(this.advanceActions[0]) }) : '';
    this.part?.update({
      script: a.speaker, node: a.id, speaker: a.who, text: this.full.slice(0, Math.floor(this.shown)), full: this.full, typing: this.typing,
      choices: this.typing ? NONE : this._choices, selected: this.typing || !this._opts ? -1 : a.focus.index ?? 0, hint, data: a.node.data ?? {},
      advance: () => e.ops.run('dialogue.advance', {}, P), choose: index => e.ops.run('dialogue.choose', { index }, P),
    });
  }

  /** @internal run through the op dialogue.advance */
  _advance() {
    if (!this.active) return;
    if (this.typing) { this._finishTyping(); return; }
    if (this._opts) return;
    this._show(this.active.node.next || 'end');
  }

  /** Choices shown for the current line (typing or not). @internal */
  _visible() {
    if (this._opts) return this._opts;
    const opts = this._choicesOf(this.active?.node);
    if (opts === FAIL) { this.end(); return []; }   // a condition that throws while a line is typing (a number key, an availability check) ends the dialogue like it does when the line is done
    return opts;
  }
  /** @internal The choices of a node whose condition holds; FAIL when a condition threw (the one place choice conditions run) */
  _choicesOf(node) { return this._try('dialogue choice', () => (node?.choices || []).filter(c => !c.if || c.if(this.state, this.engine))); }
  /** @internal run through the op dialogue.choose */
  _choose(i) {
    if (!this.active) return;
    if (this.typing) this._finishTyping();   // mid-typing: finish the sentence (choices appear) before picking
    if (!this._opts?.[i]) return;
    const c = this._opts[i], a = this.active;
    if (!this._do(c)) { this.end(); return; }
    if (this.active === a) this._show(c.next || 'end');   // do ended the dialogue or started another: its next belongs to the old one
  }

  /** Per frame: bubbles count down, the main line types, keys are read (the main dialogue locks game input, hence pressedRaw). */
  frame(dt) {
    this._bubbles.frame(dt);
    const a = this.active;
    if (!a) return;
    const ops = this.engine.ops;
    if (this.typing) {
      const was = Math.floor(this.shown);
      this.shown = Math.min(this.full.length, this.shown + dt * this.charsPerSecond);
      if (this.shown >= this.full.length) this._finishTyping();
      else if (Math.floor(this.shown) !== was) this._draw();   // redraw only when another character shows
    }
    // just opened this frame (the press that opened it does not advance), the cursor already used confirm this frame (on the dialogue's choices, or on a window over it), or a window over it owns the keys
    if (a.focus.fresh || a.focus.consumed || !a.focus.onTop) return;
    const input = this.engine.input, P = this._by;
    if (this.advanceActions.some(x => input.pressedRaw(x))) ops.run('dialogue.advance', {}, P);
    for (let i = 1; i <= 9; i++) if (input.pressedRaw('choice' + i) && this.active && this._visible()[i - 1]) ops.run('dialogue.choose', { index: i - 1 }, P);
  }
}

const STRINGS = {
  'zh-CN': { 'module.dialogue': '对话', 'dialogue.continue': '{key} 继续 ▸', 'dialogue.choice': '选择选项' },
  en: { 'module.dialogue': 'dialogue', 'dialogue.continue': '{key} to continue ▸', 'dialogue.choice': 'Choose option' },
};

const DIALOGUE_PARAMS = keysSchema(['charsPerSecond', 'advanceActions', 'holdSeconds', 'bubbleChoice']);

/**
 * The dialogues section of content data. A line can be several variants [{ if: condition, text }, ..., { text }]; the first whose condition holds is used.
 * When none holds the line is empty and a warning names it: throwing inside the dialogue's op would leave the conversation stuck on that node.
 */
const variants = (content, at, list) => () => {
  const hit = list.find(v => content.test(v.if));
  if (!hit) warnOnce(coded('content-misuse', `content ${at}: no variant's "if" holds and there is no variant without "if", so the line is empty. ` +
    'End the list with a plain { text } as the fallback'), at);
  return hit?.text ?? '';
};
const DIALOGUE_CONTENT = {
  desc: 'dialogues (id -> speaker, nodes)',
  undo: (d, { engine: e }) => keepTable(e.dialogue.scripts),
  commit(d, { engine: e, content }) {
    for (const [id, def] of Object.entries(d)) {
      const nodes = {};
      for (const [nid, n] of Object.entries(def.nodes ?? {})) {
        nodes[nid] = {
          ...n, speaker: n.speaker ?? def.speaker,
          text: Array.isArray(n.text) ? variants(content, `dialogues.${id}.nodes.${nid}.text`, n.text) : n.text,
          do: n.do && (() => content.run(n.do)),
          choices: n.choices?.map(ch => ({ ...ch, if: ch.if && (() => content.test(ch.if)), do: ch.do && (() => content.run(ch.do)) })),
        };
      }
      e.dialogue.define(id, nodes);
    }
  },
};

/** Dialogue module. Installs engine.dialogue; story flags engine.dialogue.state.flags are engine.vars.flags. Declares the UI parts 'dialogue' and 'dialogue.bubble'. */
export function dialogue(opts = {}) {
  readParams('dialogue', DIALOGUE_PARAMS, opts);
  let d = null;
  return {
    content: { dialogues: DIALOGUE_CONTENT },
    name: 'dialogue', skipKind: 'none', type: 'rules', provides: ['dialogue'], params: DIALOGUE_PARAMS, options: opts, label: 'Dialogue', stage: 'gameplay', after: ['interactions'],
    install(e, ctx) {
      e.i18n.add(STRINGS);
      d = new Dialogue(e, opts);
      // choice1..9 pick a choice by number: declared, never bound here (presets.bindings.dialogNumbers binds 1-9). Optional: the choice cursor
      // (basic menu keys + confirm) and clicks pick choices without them. Context 'dialog', so 1-9 stay free for hotbars outside a conversation
      for (let i = 1; i <= 9; i++) ctx.input.define('choice' + i, { context: 'dialog', label: 'dialogue.choice', optional: true });
      ctx.track(e.events.on('session:end', () => d._cancel()));   // an open dialogue belongs to the playthrough that opened it
      ctx.ui.define('dialogue', dialogueBox);
      ctx.ui.define('dialogue.bubble', bubblePart, { multi: true });
      ctx.ops.define('dialogue.advance', {
        desc: 'Finish typing the line, or go on to the next one',
        net: 'local',   // in co-op each player reads their own dialogue box; ops it runs (give, start a quest) still go to the host
        can: () => d.active ? true : 'noDialogue',
        run: () => { d._advance(); },
        offers: () => d.active && !d._opts ? [{}] : [],
      });
      ctx.ops.define('dialogue.choose', {
        desc: 'Pick a visible dialogue choice (0-based); run: the bubble line asking (dialogue.bubbles() run), none = the main conversation', args: { index: 'int', run: 'int?' },
        net: 'local',
        can: (e, { index, run }) => run != null ? (d._asks.get(run)?.opts[index] ? true : 'noChoice') : !d.active ? 'noDialogue' : d._visible()[index] ? true : 'noChoice',
        run: (e, { index, run }) => { if (run != null) d._asks.get(run)?.pick(index); else d._choose(index); },
        offers: () => [...(d.active ? d._visible().map((c, index) => ({ index })) : []), ...[...d._asks].flatMap(([run, a]) => a.opts.map((c, index) => ({ index, run })))],
      });
      return d;
    },
    frame(dt) { d.frame(dt); },
    // unloaded mid-conversation: the input context and focus entry are the conversation's, not tracked, and a say() Promise gets its end. Not on engine.dispose: waits stay pending there
    dispose(e) { if (!e.disposed) { d._bubbles.clear(); d._asks.clear(); d.end(); } },
    afterLoad() { if (!d.active?.duringLoad) d._cancel(); },   // a line open at a load belongs to the state thrown away; one a load opened stays
    describe(e, ctx) {
      const a = d.active, bubbles = d.bubbles();
      if (!a && !bubbles.length) return;
      if (ctx.out.ui) {
        // choices: the labels already read when the line finished, so inspecting never runs game code
        if (a) ctx.out.ui.dialogue = { speaker: a.who, text: d.full, typing: d.typing, choices: d._opts ? d._choices.map(c => c.text) : [], selected: d._opts ? a.focus.index ?? 0 : -1, advance: d.advanceActions.map(x => e.input.label(x)).join(' / ') };
        if (bubbles.length) ctx.out.ui.bubbles = bubbles;
      }
    },
  };
}

export const handRolled = [{ kind: 'dialogue', seen: 'a dialogue box of its own', use: 'engine.dialogue.define(speaker, nodes) and the dialogue part: typing on game time, choices, input lock (recipe 02, recipe 26)', quiet: /\b(engine|e|eng|ctx)\.dialogue\b|\bdialogue\(\s*[{)]/, code: /\b(createElement|innerHTML|className|classList|getElementById|querySelector|\.id)\b/, raw: /(?:createElement|innerHTML|className|classList|getElementById|querySelector|\.id\b)[^,;{}]*(?:dialog(?:ue)?|speech|subtitle|textbox|conversation)|(?:dialog(?:ue)?|speech|subtitle|textbox|conversation)[^,;{}]*(?:createElement|innerHTML|className|classList|getElementById|querySelector|\.id\b)/i }];
