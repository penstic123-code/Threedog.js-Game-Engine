// One reading of the page, in the shape expectations look values up in: describe() as it is, plus `shot.` (the picture numbers) when a picture was taken.
// Why no budget here: limits have one home, engine.budget; expectations do not take budget.* values.

/** Page side, self-contained (it is sent as source text): the engine's describe() and whether the loop is stopped (time values like perf.fps are null then, and "null" must not pass as "fine") */
export const PAGE_FACTS = () => {
  const e = window.engine;
  return { describe: e.describe(), halted: !!e.halted };
};

/**
 * Put one reading together
 * @param {{ describe: any, picture?: Record<string, number> | null, backend?: string | null, halted?: boolean }} r
 *   picture: the numbers of this run's picture (none when no picture was taken); backend: the word of "drawn by" for it
 * @returns {{ values: any, hasShot: boolean, halted: boolean, backend: string | null }}
 */
export function assemble({ describe, picture = null, backend = null, halted = false }) {
  if (picture && 'shot' in describe) throw new Error('describe() has its own "shot" entry, which the picture numbers need as their prefix: rename it with engine.describe.add');
  return { values: picture ? { ...describe, shot: picture } : describe, hasShot: !!picture, halted, backend };
}
