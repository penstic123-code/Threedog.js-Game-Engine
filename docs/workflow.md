# Maintainer workflow

How the coordinator and helper agents work on the engine. The owner pushes and publishes; agents never do. Intent: `design.md`. Structure: `architecture.md`.

## Helpers and worktrees

- The coordinator gives each helper a brief with a bounded job (a time box and a size cap, "commit first, then polish"), the files it owns, and what it must not touch. Split work by file ownership so two helpers never edit the same file; shared registries (`CHANGELOG`, `AI.md` rows, `runs.md`) are where merges conflict.
- A helper that builds or changes a game does not read the game's `CLAUDE.md` unless told to, so its brief opens with three lines (the template's `CLAUDE.md` carries them in one): run `threedog how "<2-4 words>"` before writing any system and report its answer; for picture work read recipes 60 and 62 and judge by the numbers `threedog shot` prints; fix or justify every `threedog check` warning. Without them a helper writes from memory (a game built by eight parallel helpers did, and `check` later flagged hand-rolled systems).
- Each helper works in its own git worktree on its own branch, created from the main checkout while the shell is in the main repository (a worktree is made inside the current directory's repository; after touching any other repository, `cd` back first).
- A worktree has no `node_modules`. Run `node packages/tools/worktree-link.mjs link` inside it: every item becomes a junction to the main repo's same-named item, except `threedog` and `@threedog/*`, which link to this worktree's `packages/*` (one junction for the whole folder would run the main repo's code). It then prints where each package resolves (`check` prints it again) and fails if one leaves the worktree.
- Before finishing, run `node packages/tools/worktree-link.mjs unlink` (it removes the junctions, never their targets), and stop any dev server or headless browser started (software rendering eats CPU; check for leftovers after merging).
- A helper's report is short: status, commit id, test result (summary and failures only), decisions the coordinator must make. Work that is not finished is listed in the report, not left half-committed.

## Merging

1. Merge the branch into master.
2. Generated files conflict (CODEMAP, API.md): take either side and run `npm run map`. Never merge them by hand.
3. `npm run map`, then `npm run check` (its last line must read `✓ check passed`; type errors count).
4. Check the merge brought no new Chinese comments into code (comments are English; the player-facing zh-CN strings stay).
5. Size caps: `CODEMAP.md` at most 28 KB, `AI.md` within its byte budget (R22 reports it). A new public API adds its AI.md row and recipe section in the same change; if AI.md goes over, shorten other rows instead of raising the cap.
6. Run the tests related to both sides and log the run (below).

## Testing

- Run only related tests: `threedog test "<name>"`. The filter matches test NAMES (any case), not file names. Every word must match some test: a word that matches nothing prints "NOTHING MATCHED" and exits 1, so a typo never looks like a pass.
- Output is short by default: each failed item with its failed checks, a progress line, then the list of failed items and the `Total:` line. `threedog test --verbose` (or `-v`) prints every passing check too. Never paste whole logs into context. On a page error read `.threedog/errors.log` first.
- A new test file is just a new `packages/engine/tests/specs/<name>.mjs` exporting `specs`; the runner finds it (there is no list to register it in). A file that exports no items, or a test name used twice, stops the run before any browser opens.
- Rendering: specs that read pixels run on software rendering; tests wait on conditions (`frames`, `until`), never fixed sleeps. A failure that appears only under load must be reproduced alone before it is called flaky, and the evidence goes into the log.
- Real WebGPU: the suite's Chromium lands on WebGPURenderer's WebGL2 backend. `node packages/tools/real-webgpu.mjs` runs specs or pages in system Chrome and fails any page that is not on a real device; a spec whose page holds no device of its own says why in `notRealWebGPU: '<why>'` and is listed as SKIP. Run it by hand after changes to shaders, cascades or the first frame; it needs a GPU and Chrome, so it cannot be in `npm test`.
- Log every run (full suite, post-merge check, field test) as one row at the top of the table in `docs/testing/runs.md` (newest first): date, commit, what was run, pass / fail counts, and for each failure what was done (fixed, known issue, flaky with evidence). Review reports go in `docs/testing/review/`, usability runs in `docs/testing/usability/` (layout: `docs/testing/README.md`).
- A test that matches text and the source string it matches change in the same commit.

## Commits

- `git add` explicit paths (never `-A`). LF line endings. Comments in code are English and say why. Save patches with Bash (PowerShell `>` corrupts `git diff`).
- End every commit message with the `Co-Authored-By` line the session names.
- Never push, tag or publish. The owner does.
- Commit finished parts early; stop near the context limit with the work committed.

## Deleting and breaking

- A replaced way, option, test or doc is deleted in the same change. No compat layer in 0.x.
- A breaking change gets a note in the current `packages/engine/docs/MIGRATING-<version>.md` (what was removed, what to write now) and a line in `CHANGELOG.md`.
- A fix is made once, in the layer that owns the cause: grep all callers, group reports by root cause.

## Upgrading three.js

`package.json` allows 0.187.x only. Before moving to a newer minor, read what the engine reaches that three does not promise to keep; each breaks in its own way when renamed:
- `renderer._animation.start()` and `renderer._nodes?.nodeFrame` (`render/backend.js`, the WebGPU first-frame fix): no public entry exists. The first has no optional chain and throws every frame, the second goes quiet.
- CSMShadowNode's `_init` and `_shadowNodes` (`render/cascades.tsl.js`).
- `_objects` and `_renderObjects` (`render/recordSweep.js`, what a mesh that left the scene frees): renamed, the sweep frees nothing and memory grows.
- `_pixelRatio`, `_width`, `_height` (`render/postWebGL.js`): renamed, the post chain sizes itself wrong.
- `_nodeBuilderState` (`render/shaderErrors.js`): a compile error loses the patch and slot it names.
- `_renderTarget` (`render/probes.js`, `packages/tools/light-bake-page.js`), `_edgesRT` (`render/PostFX.js`), `_renderObjectDirect` (`packages/tools/lib/capture-lib.mjs`), `_pipelines` (`packages/tools/perf.mjs`).
- Everything in `describe().threePatches` (`packages/engine/docs/THREE.md`).

## Plans

- Open plans stay in `docs/plans/`. A finished plan (checked against the code, not only its own status line) moves to `docs/plans/done/` with one line in `done/README.md`; links to it are fixed in the same change (R18 checks paths written in docs).

## Reporting to the owner

Plain words: what changed for the game or the AI that uses the engine, what was run and the result, what needs a decision. No internal code names, no log dumps. Reply in the owner's language.
