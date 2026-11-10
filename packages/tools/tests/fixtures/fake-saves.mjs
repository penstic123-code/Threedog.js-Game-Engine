// A stand-in for engine.saves / ctx.saves in node tests. Why one helper: real code calls saves.define, and a double that knows
// only one name breaks the moment a module moves; it gives back the same removable handle as engine.saves does.
// Lives in fixtures/: the runner reads every tests/*.mjs as a test.
/** @param {(key: string, part: any) => void} [onPart] sees each part as it is defined */
export function fakeSaves(onPart = () => {}) {
  const parts = new Map();
  const define = (key, part) => { parts.set(key, part); onPart(key, part); return { remove() { if (parts.get(key) === part) parts.delete(key); } }; };
  return { define, parts };
}
