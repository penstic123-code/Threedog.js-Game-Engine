// engine._tools: the one door packages/tools has into the engine's internals, for what no game needs: draw a frame while halted, run the frame hooks, hand a halt back, read
// the light watch. Why a door and not the private names: about twenty sites in tools called them directly, so renaming one in core broke a tool with no error until it ran. Now core can
// rename freely behind these words, and rule R68 fails any other reach from packages/tools. Internal: on no public page, not in the types.
/** @param {any} e @returns {any} */
export const toolDoor = e => ({
  /** Draw one frame; hooks false leaves the frame hooks out @param {number} dt @param {boolean} [hooks] */
  render: (dt, hooks) => e._render(dt, hooks),
  /** Run the frame hooks with no draw, the way a halted frame does @param {number} dt @param {boolean} [halted] */
  frameHooks: (dt, halted) => e._frameHooks(dt, halted),
  /** Hand back the halt this owner took @param {string} owner */
  resume: owner => e._unhalt(owner),
  /** What the light watch saw (lightWatch.js) */
  get lightWatch() { return e._lightWatch; },
  /** The picture check is rendering: what it changes and puts back is not the game's */
  get probing() { return e._probing; },
  set probing(on) { e._probing = on; },
  /** Whether a material is a debug view's stand-in, not one of the game's @param {any} m */
  standIn: m => !!m?.userData?._dbgOf,
});
