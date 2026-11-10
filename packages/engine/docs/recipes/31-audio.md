# Sound: buses, sounds by name, ambience rules, music, footsteps, ducking

> **Covers:** sound: buses, sounds by name, ambience rules, music, footsteps, ducking, settings.
> **Use when:** anything the player hears.
> **Shortest:** `createEngine({ audio: { levels: { music: 0.4 } } })`, then sounds by name.
> **Sections:** 1 Config in one · 2 Buses and sounds · 3 Ambience a rule · 4 Music rules, cross-fade · 5 Footsteps by surface · 6 Ducking · 7 Settings · 8 Sounds as content

Everything you hear is the game's. The engine ships no sound files and plays nothing the game did not name; built-in synths (`footstep`, `shutter`,
`thunder`, `wind`, `rain`, `water`, `birds`, `crickets`) stay silent until `audio.sounds` asks for them. Signatures: `api/audio.md`,
`api/ambience.md`, `api/music.md`.

## 1. Config in one place
Two places, one job each: **the asset manifest says what a sound is** (a file, or a synth function made in code, registered by name like a
model), **`audio.sounds` says how it plays** (which sound or variants, volume, bus, cooldown...).
```js
const engine = createEngine({ canvas, audio: {
  levels: { music: 0.4, voice: 1 },  // volume per bus; an extra key (voice) adds a bus
  sounds: {
    door: {},  // the asset of the same name, default rules
    hit: ['hit1', 'hit2'],  // variants: random, never the same one twice in a row
    shot: { src: 'shot', jitter: { pitch: 0.08, volume: 0.1 }, cooldown: 0.05, voices: 4, distance: { ref: 3, max: 80 } },
    footstep: {},  // a built-in synth asset, named so it plays
    'step.sand': { src: 'footstep', params: { surface: 'sand' } },  // a synth source with parameters
    wind: {}, birds: {}, ding: { volume: 0.6 },
  },
  ambience: [ /* rule table, section 3 */ ],
  music: { tracks: { /* section 4 */ }, rules: [] },
  footsteps: { beach: 'step.sand', default: 'footstep' },  // section 5
} });
engine.assets.manifest({ name: 'sfx', sounds: {
  door: '/sfx/door.ogg', hit1: '/sfx/hit1.ogg', hit2: '/sfx/hit2.ogg', shot: '/sfx/shot.ogg',
  ding: (a, p, out) => { a.tone({ freq: 880 * p.pitch, dur: 0.2, out }); return 0.2; },  // a synth: connect to out, return seconds (or { stop(t) })
} });
```
Code may hold functions (a `volume: e => ...`); the same config as data goes in a content pack (section 8). A full working one:
`examples/world/content/audio.js`.

## 2. Buses and sounds by name
Buses are real Web Audio `GainNode`s: `master`, `music`, `sfx`, `ambience`, `ui`, plus the game's own (`levels: { voice: 1 }` or
`engine.audio.addBus('voice')`). `engine.audio.setVolume('music', 0.3)` sets one; `engine.audio.buses.sfx` is the node to connect your own nodes to, and `buses.master` (also `audio.master`) is the total. `buses` is empty until audio
unlocks on the player's first click or key: build your own nodes on the `audio:ready` event. A name that is no bus warns once and gives `master`, so the sound still plays.

```js fragment
engine.audio.sfx('door');  // plays on its bus (default sfx)
const h = engine.audio.sfx('shot', { at: enemy.root });  // 3D: a PannerNode that follows the Object3D every frame
const hum = engine.audio.sfx('engine-hum', { loop: true, at: [4, 0, 2] });
hum?.fade({ to: 0.2, seconds: 1.5 }); hum?.stop({ fade: 1 });  // the handle (null while silent, see below): fade({ to, seconds }), stop({ fade }), remove(), setPosition(at)
engine.audio.sfx('click', { bus: 'ui' });
```
`sfx` returns `null` when the sound is silent: neither a rule nor an asset of that name, a built-in synth no rule names, audio still locked (before
the first click), or inside its `cooldown`. A manifest sound with no rule plays by its name with default rules. Over its
`voices` limit the oldest voice stops. Files by path without an entry: `await engine.audio.play(url, { bus, loop, fadeIn })`.

Built-in synth parameters (`params`): `wind` / `water` take `freq` (filter Hz), `birds` `range: [low, high]` Hz, `crickets` `freq` (chirp Hz, default
4300); every synth also gets `pitch`, the sfx pitch multiplier (~1). A sound whose file fails to load keeps its ambience rule silent (one warning)
until the rules load again, instead of refetching.

A synth with default params is `{ build: synthFn, params }` in the manifest.

## 3. Ambience: a rule table
Each rule names a sound and says when and how loud. A rule with `every` is a one-shot at random gaps; without, a loop that fades in and out (and stops
when silent, so idle rules cost nothing).
```js
ambience: [
  { sound: 'wind', volume: e => 0.05 + (e.weather?.current.wind ?? 0) * 0.08 },  // volume can follow the moment
  { sound: 'river', volume: (e, a) => a.nearWater(12) * 0.12 },  // a = engine.ambience (position, nearWater)
  { sound: 'cave-drip', when: { zone: 'cave' }, volume: 0.6, fade: 2 },
  { sound: 'birds', when: { time: 'day', weather: ['clear', 'cloudy'] }, every: [2, 7] },
  { sound: 'war-drums', when: { state: 'combat' }, volume: 0.5 },
]
```
Condition keys (all must hold): `state` (`engine.audio.state = 'combat'`, set by the game), `time` (`'day'`, `'night'` or `['18:00', '06:00']`, needs
`sky()`), `weather` (a name or a list, needs `weather()`), `zone` (a trigger-zone tag the player is in, needs `triggers()`). Measures compare a
number: `{ daylight: { gt: 0.15 }, rain: { lt: 0.2 } }` (keys `gt gte lt lte`; section 8 lists them). Anything else: a function `when: e => ...`, or
add a key: `engine.audio.condition('inside', v => engine.vars.flag('indoors') === v)`. Add or swap rules at run time with `engine.ambience.add(rule)`
(returns a handle) and `engine.ambience.rules(list)`.

## 4. Music: rules, cross-fade, stems
```js
engine.use(music({ tracks: {
  explore: '/music/explore.ogg',
  combat: { url: '/music/combat.ogg', stems: [{ url: '/music/combat-drums.ogg', at: [0.3, 0.7] }] },
}, rules: [
  { track: 'combat', when: { state: 'combat' }, priority: 10 },
  { track: 'explore' },  // no when: the fallback
] }));
engine.music.intensity = 0.8;  // stems fade in as it rises through their at range
```
The same `when` keys as ambience. Tracks cross-fade (`fade`, default 2 s); a new rule result must hold `hold` seconds before switching.
`engine.music.override('boss')` picks by hand; `override(null)` hands back to the rules. `engine.music.stinger('win')` plays a short piece over the music.
Decoded music is large (about 21 MB a stereo minute), so it lives like any asset: `assets.release(name)` and `assets.trim()` (a level change calls it) free it, the longest-unused long sounds go by themselves over a memory budget, sounds still playing play on, and a freed sound loads again when played; effects under 10 s stay cached, and `preload: true` keeps a track.

## 5. Footsteps by surface
The player's footstep rhythm follows its speed (one step per foot landing). Each step plays the sound named by `footsteps[groundType]`, else
`footsteps.default`, else `footstep`. The ground type is the terrain's `groundType` or, in a Blender level, the material name (or `groundType` custom
property); `water` while swimming.

## 6. Ducking
```js
const d = engine.audio.duck({ music: 0.3, ambience: 0.5 }, { fade: 0.3 });  // lower these buses
engine.events.once('dialogue:end', () => d.remove());  // restore
```
Ducks stack (levels multiply) and never touch the player's volume setting. `music({ duckDialogue: 0.35 })` ducks the music bus during dialogue for
you; it is off by default (whether talking lowers the music is the game's choice).

## 7. Settings
The default settings menu has a volume slider per bus, the game's own buses included, saved with the other settings. A game bus's label is the text
key `settings.vol.<bus>` (`engine.i18n.add({ en: { 'settings.vol.voice': 'Voices' } })`).

## 8. Sounds as content data
A content pack carries the game's audio the way it carries items: data only, sounds by name.
```js
// content/audio.js (export it from content/index.js like any content file)
export default {
  sounds: { wind: {}, door: 'door', hit: ['hit1', 'hit2'], shot: { src: 'shot', cooldown: 0.05 } },  // asset pack sound names (files or synths)
  ambience: [
    { sound: 'wind', volume: { base: 0.05, add: { wind: 0.08, altitude: 0.00375 }, max: 0.5 } },  // base + measure x factor, clamped
    { sound: 'rain', volume: { add: { rain: 0.22 } } },
    { sound: 'birds', when: { daylight: { gt: 0.15 }, rain: { lt: 0.2 } }, every: [1.5, 6.5] },
  ],
  music: { tracks: { day: 'music-day' }, rules: [{ track: 'day', when: { time: 'day' } }] },
  footsteps: { beach: 'step.sand', default: 'footstep' },
};
```
```js fragment
engine.assets.manifest({ name: 'sfx', base: '/sounds/', sounds: { door: 'door.ogg', hit1: 'hit1.ogg', hit2: 'hit2.ogg', shot: 'shot.ogg', 'music-day': 'day.ogg' } });
engine.content.load([base, forest]);  // each pack's audio merges in
```
- **Names, never paths or code.** A sounds string is a sound name from an asset pack, a file or a synth (`engine.audio.load` and music resolve it
  through `engine.assets`, so a missing file falls back to silence as an `engine.loading` task). A file path warns in dev; a function anywhere in the
  table drops that rule with a dev warning. `npm run check` reports both as errors.
- **Measures** are the numbers data compares and adds up. Built in: `daylight` (sky, 0 at night), `rain` / `snow` / `wind` (weather), `nearWater`
  (share of water within 12 m, 0-1) and `altitude` (ground height under the listener, 0 below sea level) from ambience. Add your own:
  `engine.audio.measure('danger', e => e.vars.counter('alarm') / 10)`; read one with `engine.audio.value('danger')`. A name is a condition key or a
  measure, not both.
- **Merging.** `sounds`, `footsteps` and `music.tracks` are ids: two packs in one load with the same name is an error naming both; a name also in
  `createEngine({ audio })` or `music({ tracks })` is an error (`[audio-name-clash]`). `ambience` and `music.rules` concatenate after the game's own.
  Loading a named pack again replaces its rules (hot reload).
- `levels` (bus volumes) stay in `createEngine({ audio })`: they are settings, not content.
