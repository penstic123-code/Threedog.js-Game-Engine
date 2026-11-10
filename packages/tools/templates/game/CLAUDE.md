# Notes for this game

__GAMEPLAY_NOTE__

**Three rules.** 1. Each thing has a name: `engine.describe()` lists it, `explain module <name>` says why.
2. Each thing has an owner: `add` returns a handle, `h.remove()` undoes it (not `engine.add`, `world.add`, `addPlayer`); `define` names a kind; `input.bind` sets keys.
3. What several sides change has one owner the rest go through (values `engine.mod`, services `provides`).

## Already here
Commands: `npx threedog <command>` (installed here, not on PATH).
**Before writing a system, in any file:** name the engine system for it below, or the `npx threedog how` result that found none.
`npx threedog check` hints at hand-rolled systems (names as in this table): use them or `// hint-off(kind)`.
Wired in `main.js`: start screen, autosave, Esc pause and quality settings; keep, replace or delete each.
**Anything else: `npx threedog how "<task words>"` first; it prints the section.** One option by name: `npx threedog how --read interactions.add.once`.
Full table: `node_modules/threedog/docs/AI.md`.
__DEFAULT_LAYER__

## The loop
1. Run: `npx threedog play` runs the game for you (`--stop` ends); `npx threedog dev` for a person.
2. Look: `npx threedog shot` (`--play` past the start screen), `engine.describe()` for state; judge a picture: recipe 60.
3. Fix: an error names its `code`, `fix` and docs section (`.threedog/errors.log`); root cause first, fixed once where it lives (recipe 16 §11).
4. After a change: `npx threedog map`, `npx threedog check`, related tests (`npx threedog test name`).
Helpers skip this file: tell them `npx threedog how` first, recipes 60 + 62, a clean `check`. Taking over: STATUS.md, then DESIGN.md.

## Working rules
- A clear request: build it, no confirmation round. Ask only about a choice that changes the result; picture not given: ask for reference images, the style and what would be wrong (DESIGN.md "Loved / Not for this game"). Other picks go into DESIGN.md as "(picked, not asked)" with a one-line why; changing what DESIGN.md settled: ask first.
- Done = it plays AND looks as DESIGN.md describes; gray placeholders mean the art is still to make (STATUS.md lists them). Thin slice first (one place, one action, one goal, one shot), then widen; stop at DESIGN.md "Done for this version".
- Before writing, list every place the change reaches. The least code that fully works; no "for later" code; a new way deletes the old one in the same change.
- End of a piece: a test or assert for logic with weight, one shot for a picture round, a scenario per end state.
- Never cut save-data safety, input checks or what was asked. A known-limit shortcut gets `// shortcut: <limit>, <when to upgrade>`; other comments say why.
- Report what is true: verified, not verified, placeholder; never call a picture "close to the reference". Check licenses before using others' code or assets.
- Records: a change updates only the records it makes wrong (DESIGN.md, `docs/design/`, STATUS.md). Reply in the user's language.

## Picture and content
The picture is plain three.js in `picture/`, one file per job (recipe 62 §0); `npx threedog lib list` holds what the user liked before. __PICTURE_ROUTE__
Shape is code, placement is content (`content/`, saves read it): what a save stores whole is never made again at startup (`check` warns). Gameplay: `game/`, one createX(engine) per system, wired in `main.js`.

<!-- "Working rules" adapt principles from the ponytail skill (github.com/DietrichGebert/ponytail, MIT). -->
