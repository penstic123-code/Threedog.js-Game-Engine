// What state the running game is in, as data (runtime) and as one plain sentence (trailer). Every bridge command result carries it, so an AI that
// just pressed a key knows at once whether the game now runs, is halted (and how to resume) or is frozen by a menu, without a second command.
//   runtime = { ready, mode: 'running' | 'halted' | 'frozen' | null, tick, headless, blockedBy: string[], run: { state, owners, blockedBy } }
//   mode null = no engine could be read (server down, page still loading). run and blockedBy are copied as-is from engine.runState (core/ops/holds.js), the
//   one source for "why is it not advancing" (before, this file rebuilt its own list with other names): blockedBy entries are the opaque input contexts
//   ('win-settings', 'ui-title', 'dialogue', 'cutscene'...), 'error' and 'loading'.

/** Runs in the page (self-contained, sent as source). Reads only public engine fields, never waits, never throws. */
const RUNTIME_FN = () => {
  const e = window.engine;
  if (!e) return { attached: false };
  let run = null;
  try { run = e.runState ?? null; } catch { /* runState can throw before start() finishes */ }
  const lv = e.loading?.view?.();
  return { attached: true, ready: !!e.stateApplied, halted: !!e.halted, frozen: !!e.frozen, headless: !!e.headless, tick: e.time?.tick ?? null, blockedModules: Object.entries(e.moduleStates ?? {}).filter(([, s]) => s === 'blocked').map(([n]) => n), blockedBy: run?.blockedBy ?? [], run,
    loading: lv ? { done: lv.done, waiting: lv.waiting, failed: lv.failed.length, blocked: !!lv.blocked } : null, page: location.pathname + location.search };
};

/** The runtime when no engine answered (the one copy: dispatch.mjs and the MCP server use it too) */
export const NONE = Object.freeze({ ready: false, mode: null, tick: null, headless: false, blockedBy: Object.freeze([]) });

/** Raw page reading → runtime. Without an engine: ready false, mode null */
function toRuntime(raw) {
  if (!raw?.attached) return NONE;
  return { ready: raw.ready, mode: raw.frozen ? 'frozen' : raw.halted ? 'halted' : 'running', tick: raw.tick, headless: raw.headless, blockedBy: raw.blockedBy, run: raw.run ?? null };
}

/** Read it through a driver; a driver that cannot answer (page reloading, bridge down) gives the empty runtime, never an exception */
export async function readRuntime(driver, ms = 5000) {
  try {
    const raw = await Promise.race([driver.evaluate(RUNTIME_FN.toString()), new Promise((_, no) => setTimeout(no, ms).unref())]);
    return { runtime: toRuntime(raw), raw };
  } catch { return { runtime: NONE, raw: null }; }
}

/** What each blocker means for the player and how to clear it */
const BLOCK = (b) => {
  if (b.startsWith('win-')) return `the ${b.slice(4)} window is open (press menu or its close action closes it)`;
  if (b.startsWith('ui-')) return `the ${b.slice(3)} screen is up (its own action closes it, e.g. start on a title)`;
  return { dialogue: 'a dialogue is open (finish it: press interact, or op dialogue.choose)', cutscene: 'a cutscene is playing (threedog state cutscene=skip)',
    error: 'the engine froze gameplay on an error (threedog errors)', loading: 'startup is blocked by a failed asset (threedog loading)' }[b] ?? b;
};

/** One sentence: the state and the way back to normal, in plain words */
export function trailer(rt) {
  if (rt.mode === null) return 'No engine answered: the page is still loading or no game page is connected (threedog status says which).';
  const at = rt.tick === null ? '' : `, tick ${rt.tick}`, why = rt.blockedBy.map(BLOCK);
  if (!rt.ready) return `Engine still starting${at}: assets are loading or state is being applied (threedog loading shows what it waits for).`;
  if (rt.mode === 'frozen') return `Gameplay frozen${at}: game time and movement stop while the picture keeps rendering${why.length ? '; ' + why.join('; ') : ''}.`;
  const open = why.length ? ` Open: ${why.join('; ')}.` : '';
  if (rt.mode === 'halted') return (rt.headless ? `Headless page${at}: time moves only on step / press / hold, no resume needed.`
    : `Game loop halted${at}: threedog resume restores real-time running.`) + open;
  return `Game running in real time${at}: step / press / hold halt it first.` + open;
}

/**
 * Which commands move game time: THE table. The MCP tool labels and the server instructions (mcp-extra.mjs) are generated from it, and COMMANDS.md
 * says the same in words (tests/mcp.mjs checks both).
 * advances: step, press, hold, skip (and scenario / verify, which use them); op / state / eval run between steps and move no game time (state only with wait: wait advances N real seconds).
 */
export const TIME = {
  advances: ['step', 'press', 'hold', 'skip', 'scenario', 'verify'],
  frozenTimeSafe: ['op', 'state', 'js', 'resume', 'reload'],
  observes: ['describe', 'catalog', 'ops', 'inspect', 'scene', 'pick', 'thing', 'explain', 'loading', 'errors', 'snap', 'snap-describe', 'status', 'picture-palette', 'picture-compare'],
};
