---
paths:
  - "packages/engine/docs/**"
  - "packages/engine/tests/**"
  - "**/*.md"
---

# Docs, tests and verification

- Verify order and reporting: `CLAUDE.md` "Working rules".
- To learn game state read `describeText()` / `npm run shot -- ... --describe-only` (English text) for logic checks (describe snapshots included) instead of screenshots; each module's fields are in `describe().<module>`. Register custom state with `engine.describe.add(name, () => ({...}))`.
- Operate a running game with the dev bridge (`npx threedog describe | step | press | state | js | errors | snap-describe`), not throwaway playwright scripts. `main.js` sets `window.engine = engine` before `await engine.start()`.
- Screenshots are for what only the eye can judge (wind and shadows, animation feel, UI occlusion and other visuals); logic checks use describe first; when a page errors read `.threedog/errors.log` first. Guard gameplay state with describe snapshots (`expectDescribe` / `threedog snap-describe`) instead of screenshots.
- Generated docs (GAMEMAP, API.md, api/, CODEMAP, `types/generated/`) are never edited by hand: `npm run map`.
- Code blocks in `packages/engine/docs/recipes/*.md` are checked by R13; keep them runnable. Recipe file names and numbers are referenced elsewhere (there is no 17): don't rename or renumber.
- Docs shipped with the package (`AI.md`, recipes) use paths relative to the package (`recipes/...`, `node_modules/threedog/docs/...`), never `packages/engine/...`.
- Tests that match text: a test and the source string it matches change in the same commit; the user-facing example content (NPC names, item names, dialogue lines, i18n zh-CN values) stays as is; developer text (warnings, `describeText`) is matched in English.
- Names in hand-written docs (paths, test names after `npm test --` or `threedog test`, commands, events, `engine.x.y`) are checked by R18; a doc that names a test keeps the test name in the same commit. Tests wait on conditions (`frames`, `__t.until`), never fixed sleeps or wall-clock pass/fail.
