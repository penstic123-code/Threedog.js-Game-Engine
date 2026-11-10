# engine.hud — hud(opts?: HudOptions)

Objective markers, counters, progress bars (hud() module)

- Options `HudOptions`:
  - `questMarkers?: boolean` Show a marker automatically when the current quest step has a target, default true

## Methods and properties
- `hud.marker(target: HudTarget, opts?: HudMarkerOptions) → HudMarker` — Add an objective marker: target is an object, position or place name
- `hud.addCounter(id: string, opts: { label?, icon?, value?, max?, anchor? }) → { id, set, remove }` — Counter or text status, returns { set(value), remove() } (calling again with the same id = update; calling every frame is fine): addCounter('fish', { label: '鱼', value: 2, max: 5 }), addCounter('clock', { value: '08:30' }); no value = the label alone, no label = the value alone (the id is not shown)
- `hud.bump(id: string, n?: number) → number` — Add n (default 1) to a number counter, return the new value; one not declared yet starts at 0 with its id as the label
- `hud.value(id: string) → number | string | undefined` — Current value of a counter or bar (number or text), undefined when there is none; reads what interactions.add({ counter }) has added up
- `hud.bar(id: string, opts: { value, max?, label?, anchor? })` — Progress bar (calling again with the same id = update; calling every frame is fine, the DOM is untouched when the value is unchanged), value/max 0–max
- `hud.button(id: string, opts: { label, run, icon?, anchor?, action? })` — Clickable button (calling again with the same id = update): label is text or an i18n key, run() is called on a click / tap. The press never reaches the game and focus goes back to it; a locked mouse has no cursor, so free it first (Esc)
- `hud.hint(id: string, opts: { action, label?, anchor? })` — (experimental) Key hint "E · Talk" (same id = update): the key text is engine.input.label(action) (the input.noKey text when the action needs a key and has none, as in the prompt), so it follows rebinding and keyboard / pad switching; label is text or an i18n key. A button with `action` shows its key too
- `hud.remove(id: string)` — Delete a counter, progress bar, button or key hint
- Properties:
  - `markers: HudMarker[]` All markers

## Data structures
- **HudMarkerOptions** Objective marker parameters
  - `label?: string | (() => string)` Text
  - `icon?: string` Icon (text or image URL)
  - `offscreen?: 'arrow' | 'hide'` When the target is off screen: 'arrow' an arrow at the screen edge (default) / 'hide' not shown
  - `distance?: boolean` Show the distance, default true
  - `height?: number` How high the marker floats above the target (meters)
- **HudMarker** Marker returned by hud.marker()
  - `target: HudTarget`
  - `dist: number | null` Distance in meters from the player (from the focus when there is no player)
  - `visible: boolean` Shown this frame (false when the target is missing, off screen with offscreen 'hide', or before the first frame)
  - `part: import('./core').UIPart | null` The UI part drawing it (null when hud.marker is turned off); the default part has .el
  - `onScreen: boolean` On screen (otherwise an edge arrow is shown or it is hidden)
  - `set(opts: HudMarkerOptions)` — Change parameters
  - `setTarget(target: HudTarget)` — Change the target (the marker itself is not rebuilt)
  - `remove()` — Delete
- **HudAnchor** = `'top-left' | 'top' | 'top-right' | 'left' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right'` — Screen corner / edge a counter or bar column sits at (default 'top-left'); each anchor stacks its own column
