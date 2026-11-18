# Notes for this game

__GAMEPLAY_NOTE__

**Three rules.** 1. Each thing has a name: `engine.describe()` lists it, `explain module <name>` says why.
2. Each thing has an owner: `add` returns a handle, `h.remove()` undoes it (not `engine.add`, `world.add`); `define` names a kind; `input.bind` sets keys.
3. What several sides change has one owner the rest go through (values `engine.mod`, services `provides`).

## Already here
Commands: `npx threedog <command>` (installed here, not on PATH).
**Before writing a system, in any file:** name the engine system for it below, or the `npx threedog how` result that found none; before working around a missing feature, ask `how` once.
`npx threedog check` may print reminders (`!` lines) when code looks like an engine system: use it or carry on (`// hint-off(kind)` hides one). Only `✗` lines must be fixed.
Wired in `main.js`: start screen, autosave, Esc pause and quality settings: keep, replace or delete each.
**Anything else: `npx threedog how "<task words>"` first; it prints the section (`--read <name>`: one option).**
Full table: `node_modules/threedog/docs/AI.md`.
__DEFAULT_LAYER__

## The loop
1. Run: `npx threedog play` runs the game for you (`--stop` ends); `npx threedog dev` for a person.
2. Look: `npx threedog shot` (`--play` past the start screen), `engine.describe()` for state. New place or visible change: add a `shots.json` point; `npx threedog hub` shows all.
3. Fix: an error names its `code`, `fix` and docs section (`.threedog/errors.log`); root cause first, fixed once where it lives. Typing your handle on `engine`: `declare module` (recipe 14).
4. After a change: `npx threedog map`, `npx threedog check`, related tests (`npx threedog test name`).
Helpers skip this file: tell them `npx threedog how` first, recipes 60 + 62, `check` with no errors. Taking over: STATUS.md, then DESIGN.md.

## Before you call it done
Done = it plays and looks as DESIGN.md says.
1. `npx threedog shot --play` beside the target; name what differs (recipe 60).
2. `picture/` is a neutral placeholder: restyle by recipe 62; bloom, AO, grading: `@threedog/post-effects`, not hand-rolled.
3. Logic with weight has a test or assert; each end state a scenario. A number that must stay: `npx threedog expect` with the reason.

## Working rules
- A clear request: build it, no confirmation round. Ask only about a choice that changes the result; picture not given: ask for reference images, the style, what would be wrong (DESIGN.md "Loved / Not for this game"). Other picks: DESIGN.md "(picked, not asked)" + why; changing what DESIGN.md settled: ask first.
- Thin slice first, then widen; stop at DESIGN.md "Done for this version".
- Before writing, list every place the change reaches. The least code that fully works; no "for later" code; a new way deletes the old.
- Never cut save-data safety, input checks or what was asked. A known-limit shortcut gets `// shortcut: <limit>, <when to upgrade>`; other comments say why.
- Report what is true: verified, not verified, placeholder; never call a picture "close to the reference". Check licenses of others' code and assets.
- Records: a change updates only what it makes wrong. Reply in the user's language.

## Picture and content
The picture is plain three.js in `picture/`, one file per job (recipe 62 §0); `npx threedog lib list` holds what the user liked before. __PICTURE_ROUTE__
Shape is code, placement is content (`content/`, saves read it): what a save stores whole is never made again at startup (`check` warns). Gameplay: `game/`, one createX(engine) per system, wired in `main.js`.

<!-- "Working rules" adapt principles from the ponytail skill (github.com/DietrichGebert/ponytail, MIT). -->
