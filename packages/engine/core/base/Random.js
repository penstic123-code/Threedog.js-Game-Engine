// Seeded random numbers, engine.random: gameplay randomness (auto weather, lightning intervals, drops, spawning) all uses it, so step / test results are reproducible and the state is saved with the save.
//   engine.random.next()            // 0-1
//   engine.random.range(2, 5)       // a decimal in 2-5
//   engine.random.int(1, 6)         // an integer in 1-6 (inclusive)
//   engine.random.pick(['a', 'b'])  // pick one at random
//   engine.random.chance(0.3)       // true with 30% probability
//   engine.random.setSeed(42)       // reseed (the sequence after is fixed)
// Seed: createEngine({ seed }); if omitted, headless mode uses 1 (reproducible) and real-time runs use the current time (different each run).
// Purely presentational randomness (particle jitter, bird-call pitch) does not use it: call Math.random() and tag the line // presentation (see packages/tools/rules/R04).

import { mulberry32 } from './mulberry32.js';   // 32-bit state, plenty for gameplay
import { saveValues } from './saveValues.js';

/** engine.random is the seeded random generator. Gameplay randomness (auto weather, lightning, drops, spawning) uses it so step / tests are reproducible and the state is saved with the save. */
export class Random {
  /** @param {number} [seed] Seed, default 1 */
  constructor(seed = 1) { this.setSeed(seed); }
  /**
   * Reseed: the sequence afterwards is determined by seed.
   * @param {number} seed
   * @returns {this}
   * @example engine.random.setSeed(42);
   * @experimental
   */
  setSeed(seed) { this.seed = seed >>> 0; this.state = this.seed; return this; }
  /** A number from 0 (inclusive) to 1 (exclusive) @returns {number} */
  next() { const v = mulberry32(this); this.state >>>= 0; return v; }   // state kept unsigned (as saved)
  /** A decimal between a and b @param {number} a @param {number} b @returns {number} */
  range(a, b) { return a + this.next() * (b - a); }
  /** An integer between a and b (inclusive) @param {number} a @param {number} b @returns {number} @example const dice = engine.random.int(1, 6); */
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
  /**
   * Pick one element of the array at random (undefined for an empty array).
   * @template T
   * @param {readonly T[]} list
   * @returns {T | undefined}
   */
  pick(list) { return list.length ? list[Math.floor(this.next() * list.length)] : undefined; }
  /** True with probability p (0-1) @param {number} p @returns {boolean} */
  chance(p) { return this.next() < p; }
  /**
   * Create an independent deterministic generator: the same seed always gives the same sequence, without touching engine.random's state or the save.
   * For placing world initial data (the same things must be laid out on every start, and loading a save must not overwrite them with the saved engine.random).
   * Gameplay randomness (drops, lightning) still uses engine.random (saved with the save).
   * @param {number} seed
   * @returns {Random}
   * @example const rnd = engine.random.seeded(7); const x = rnd.range(-20, 20);
   */
  seeded(seed) { return new Random(seed); }
  /** For saving: { seed, state } @returns {{ seed: number, state: number }} */
  toJSON() { return { seed: this.seed, state: this.state }; }
  /** For loading @param {{ seed: number, state: number } | null | undefined} d @experimental */
  fromJSON(d) {
    if (!d) return;
    // 'abc' >>> 0 is 0: a damaged state silently restarted the sequence; a bad value now keeps the current one, with one warning (saveValues)
    const v = saveValues('random'), U32 = { min: 0, max: 0xffffffff, int: true };
    this.seed = v.num(d.seed, 'seed', { ...U32, fallback: this.seed }) >>> 0; this.state = v.num(d.state, 'state', { ...U32, fallback: this.state }) >>> 0;
    v.done();
  }
}

export const handRolled = [{ kind: 'random', seen: 'Math.random() in game code', use: 'engine.random (seeded: next / range / int / pick / chance; replays, tests and saves get the same numbers)', code: /\bMath\.random\s*\(/, notRaw: /particle|spark|dust|confetti|debris|twinkle|flicker|jitter|smoke|puff|droplet|bubble|petal|glitter|wobble/i, gameplayOnly: true }];
