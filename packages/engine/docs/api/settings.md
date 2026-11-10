# engine.settings — settings(opts?: SettingsOptions)

Settings menu (settings() module)

- Options `SettingsOptions`:
  - `action?: string` Action that opens the menu, default the basic 'cancel' (Esc / pad B on an empty UI focus stack); another name is declared and the game binds it
  - `storageKey?: string` Browser storage key
  - `presets?: Record<string, QualityPreset>` Override the graphics presets: { low: {...}, medium: {...}, high: {...} }
  - `sections?: boolean | (string | { id: 'graphics'; omit: string[] })[]` Tabs: true (default) graphics, audio, controls, language, saves; false none; or a list by name, which may include the optional 'game' (resume, load a save, back to title) and 'camera' (mouse sensitivity, invert Y, field of view; saved as camera.sensitivity / camera.invertY / camera.fov). Example: `settings({ sections: ['game', 'graphics', 'audio', 'controls', 'camera'] })`
  - `freezeWorld?: boolean` Pause gameplay while the menu is open (with flow installed it switches to flow's 'paused' and returns to the previous state on close; without flow it uses engine.freeze); the picture keeps running, default false

## Methods and properties
- `settings.get(key: string) → any` — Read a setting, e.g. get('vol.music')
- `settings.set(key: string, value: any, opts?: { save?: boolean })` — Change a setting (takes effect immediately + saved)
- `settings.preset(name: 'low' | 'medium' | 'high' | (string & {}))` — (experimental) Graphics preset: 'low' / 'medium' / 'high'
- `settings.define(key: string, def: T, apply?: ((value, e) => void) | { apply?, limits? })` — Game-defined setting: default value + apply function (saved automatically), or { apply, limits }. limits names the shared value(s) the row restricts on the settings layer, like the built-in shadows row: off holds it off (the scene, weather or a cutscene cannot turn it back on), on allows what the scene chose; a number row from 0 to 1 is a factor on a number value. Define it after the effect exists
- `settings.addSection(id: string, section?: SettingsSection)` — Add a tab of your own, or a built-in / optional one by name: addSection('camera')
- `settings.reset(key?: string)` — Put one setting (or all, with no key) back to its default: the engine's start value, or the default the game gave define(). Keys: resetBindings
- `settings.resetBindings()` — (experimental) Restore all keys to defaults
- `settings.rebind(action: string, code: string)` — Change the first key of an action to code
- `settings.actionList() → any[]` — (experimental) Key list (for the UI)
- `settings.save()` — Save to the browser
- Also: `settings.open()`, `settings.close()`, `settings.toggle(on?: boolean)`
- Properties:
  - `values: Record<string, any>` All current setting values, read only (set() changes one). pixelRatio is the renderer's real ratio
  - `presets: Record<string, QualityPreset>` Graphics presets
  - `sections: Map<string, any>` (experimental) Tabs
  - `isOpen: boolean` Whether the menu is open

## Data structures
- **SettingsSection** One settings tab
  - `title: string | ((e: Engine) => string)` Title: text or engine => text
  - `render: (tools: SettingsTools, e: Engine, s: Settings) => string` Generate the content HTML
  - `bind?: (el: HTMLElement, e: Engine, s: Settings) => void` Called after every redraw, to bind events to custom controls
  - `when?: (e: Engine) => boolean` When this returns false the tab is not shown
  - `order?: number` Sort order, smaller first, default 100
