// Shared by the bake page and its test: one model name must come from one bake list (two lists writing the same GLB would silently keep only the last).
/** @param {{ name: string, from: string }[]} items every entry of every bake list */
export function assertUniqueBakeNames(items) {
  const seen = new Map();
  for (const it of items) {
    if (seen.has(it.name)) throw new Error(`bake: the model "${it.name}" is exported by two bake lists: ${seen.get(it.name)} and ${it.from}. Rename one of them.`);
    seen.set(it.name, it.from);
  }
}
