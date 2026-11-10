# engine.quests — quests(opts?: QuestsOptions)

Quests (quests() module)

- Options `QuestsOptions`:
  - `action?: string` Action name that opens the quest log, default 'quests'
  - `checkInterval?: number` (experimental) Check interval (real seconds, checked in the fixed step; not checked while frozen / paused), default 0.5
  - `notify?: boolean | ((msg) => void)` Messages on quest start / step / done: true a toast with kind 'quest' (default) · false none · a function to show them your way. Example: `quests({ notify: false })   quests({ notify: ({ type, text }) => type === 'done' && myBanner(text) })`

## Methods and properties
- `quests.define(id: string, def: QuestDef)` — Define a quest (chainable)
- `quests.start(id: string)` — Start a quest
- `quests.state(id: string) → { step, steps, done, failed, active, visited } | null` — One quest's progress (a copy): step index, step count, done, failed, active; null before it starts
- `quests.advance(id: string) → boolean` — Finish the current step from code (its done() is not asked) and go on; the last step completes the quest. false when not active
- `quests.isDone(id: string) → boolean` — Finished (done, not failed)
- `quests.isActive(id: string) → boolean` — Started, not done and not failed
- `quests.isFailed(id: string) → boolean` — Its fail condition held (start(id) begins it again)
- `quests.check()` — Check completion conditions once immediately
- `quests.list() → { id, title, desc?, done, failed, steps }[]` — Quest list (for custom UI)
- Properties:
  - `win: { open, toggle, refresh }` The quest log (UI part 'questLog'): open, toggle(on?), refresh()

## Data structures
- **QuestDef** Quest definition
  - `title: string` Title
  - `desc?: string` Description
  - `steps: (QuestStep | QuestParallelStep)[]` Steps (completed in order); a step may be parallel goals { all: [...] }
  - `reward?: (e: Engine) => any` Called on completion (give rewards). Returning a failure ({ ok: false, code }, e.g. what e.content.run or e.inventory.add answer) means it was not paid: see onUnpaid
  - `onUnpaid?: (e, answer) => void` The game's decision for a reward not given, with the failure as answer. Without it the items that did not fit stay owed (list().owed, saved) and go into the bag when there is room
  - `fail?: (e: Engine) => boolean` Checked while active; true fails the quest (quest:fail; start(id) can begin it again). Example: `fail: e => e.vars.flag('caravanLost')`
  - `onFail?: (e: Engine) => void` Called when the quest fails
- **QuestStep** One quest step: text is the displayed text, done the completion condition (checked every half second), target the objective (a marker is shown when hud is installed)
  - `id?: string` Stable id: saves store progress by it, so steps can be inserted or reordered later (default: the step's position)
  - `text: string`
  - `done: (e: Engine) => boolean`
  - `next?: string | false | ((e: Engine) => string | false | undefined)` The step after this one: a step id, or e => id asked when this step is done (a branch); false finishes the quest here. Default: the next step in the list. steps already passed are in quests.state(id).visited
  - `target?: HudTarget` Objective: a place name (content.place), object, character, { x, z }, { nearest: itemId } or a function returning an objective; with the hud module the current step shows a marker automatically
