# Notes for this game

**Before writing a system, in any file:** name the engine system for it, or the `threedog how` result that found none.
`threedog check` hints at hand-rolled systems: use them or `// hint-off(kind)`.

Helpers skip this file: tell them `threedog how` first, recipes 60 + 62, a clean `check`.

__GAMEPLAY_NOTE__

## Already here
The engineering is the engine's: start screen, autosave, Esc pause and quality settings are wired in `main.js`;
keep, replace (`engine.ui.set`) or delete each (a hand-written one needs its own save and test hooks). Docs: `node_modules/threedog/docs/` (nearest parent with `node_modules`).
**Not in this table: `threedog how "<task words>"` (no words: browse) first.**
__DEFAULT_LAYER__

## First session
- A clear request: build it, no confirmation round. Ask only about a choice that changes the result. Picture not given: ask for reference images, the style and what would be wrong (DESIGN.md "Loved / Not for this game").
- Everything else you decide: write it into DESIGN.md as "(picked, not asked)" with a one-line why, and list the picks in your report. Changing what DESIGN.md settled: ask first.

## What done means
Gray placeholders (capsule player, box props) mean the art is not made: making it is your job. A feature is done
when it plays AND looks as DESIGN.md describes; a placeholder goes into STATUS.md as unfinished. Build a thin slice first (one place, one action, one goal, one shot
with its real picture), then widen it. Stop at DESIGN.md "Done for this version"; later ideas go to STATUS.md Next.

## How to work
1. Before writing, list every place the change must reach (callers, content, saves, tests, records) and what it could break for the player.
2. Take the first option that fully works: does it need to exist -> already in this game or the engine (GAMEMAP.md, `threedog how`;
   note the system in DESIGN.md Systems) -> plain three.js or the browser (`THREE.md`) ->
   an installed package -> the least code that works. "Least" is about code, never the result.
3. Write the game's own look; `threedog lib list` holds what the user liked before.
4. No abstraction, option or "for later" code nobody asked for. A new way replaces the old one: delete the old in the same change.
5. Debugging: root cause first (grep the callers, `engine.describe()`, recipe 16 §11), fix it once where it lives.
6. Check the license, and tell the user, before using someone else's code or assets.
7. End of a piece: logic with weight leaves a small test or assert; a picture round ends with one shot. Every end state (lose, respawn, retry, reload) gets a scenario; read `verify`'s "ops never run".
8. A known-limit shortcut gets `// shortcut: <limit>, <when to upgrade>`. Other comments: only the why.
9. Never cut: save-data safety, input checks at data entry, what the user asked for.
10. Report what is true: verified, not verified, still a placeholder. Never call a picture "close to the reference".

The picture is plain three.js in `picture/`, one file per job; by default gameplay code uses material names, signals and `picture/` exports (`picture.lamp(id).off()`); direct writes work too.
__PICTURE_ROUTE__ Optional looks: recipes 34, 52, 56. Costly things read `engine.tier`. Signals, sky, post: recipe 62. Picture rounds: recipe 35; judging: recipe 60.
`threedog shot --play` and `snap` run the picture check; other shots skip it.

## Content vs code
By default shape is code, placement is content (saves read it); plain three.js too. A model built in code is registered by name in `assets.js`, and where it stands goes in
`content/props.js` (`{ model: 'marker', place, x, z }`), plus a template (`content/templates.js`) when it has state. What a save
stores whole (`world.add`, `engine.content.spawn`, pickups, NPCs) must not be made again at startup; `npm run check` warns; `// runtime: <reason>` ends that. Code holds rules: ops, `onFixed` for game time (damage, cooldowns, AI, timers),
`onFrame` for what shows (animation, camera, HUD). By default gameplay lives in `game/`, one file per system, each a createX(engine, ...); `main.js` wires them. Several systems: one `engine.onFixed(dt => { weapons.step(dt); enemies.step(dt); })` in `main.js` fixes their order (separate registrations run as written); `{ phase: 'late' }` reads this step's results; modules with before / after: recipe 14. Made in play: `engine.content.spawn` in an op. Items, NPCs, dialogues and quests go in `content/`; files in `public/`; one-file three.js pieces in `plugins/`. Hundreds of same-kind moving things (shots, crowds, flocks, debris) are `engine.swarm` (recipe 65), not one mesh each.

## Commands and docs
`threedog play` runs the game for you (`--stop` ends it), `npm run dev` for a person. After a change: `npm run map` (if code, JSDoc or content changed), `npm run check`, related tests (`threedog test name`). MCP (`.mcp.json`): the dev bridge as tools while the game runs (recipe 16 §10).
Taking over: STATUS.md, then DESIGN.md. A new feature: the table above or `threedog how`, then its recipe and API page.

Records: a change updates only the records it makes wrong (rules, systems, Done: DESIGN.md and `docs/design/`; progress: STATUS.md). Reply in the user's language.

<!-- "How to work" items 1-2, 4 and 7-9 adapt principles from the ponytail skill (github.com/DietrichGebert/ponytail, MIT). -->
