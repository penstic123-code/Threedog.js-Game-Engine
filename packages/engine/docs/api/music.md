# engine.music — music(opts?: MusicOptions)

Background music (music() module)

- Options `MusicOptions`:
  - `tracks?: Record<string, MusicTrack>` Tracks: name -> path or { url, volume, loop, stems }
  - `rules?: MusicRule[]` Auto track rules (same as engine.music.rules(list))
  - `fade?: number` Default crossfade seconds, default 2
  - `duckDialogue?: number | false` Duck the music bus during dialogue to this (0-1, e.g. 0.35); default false = no duck (the game opts in)
  - `duckFade?: number` (experimental) Fade seconds for the ducking
  - `hold?: number` Rule debounce seconds, default 2
  - `interval?: number` Rule check interval (seconds), default 1

## Methods and properties
- `music.define(name: string, track: MusicTrack)` — Define a track: a url, { url, volume, loop, stems }, or { generate } (your own Web Audio nodes). The same name again replaces it. Example: `engine.music.define('town', '/music/town.ogg')`
- `music.play(name: string | null, opts?: { fade?: number; force?: boolean })` — Play a track (cross-fade over fade seconds). Does nothing if it is already playing; force replays it
- `music.stop(opts?: { fade?: number })` — Fade out and stop (fade over fade seconds; default the music({ fade }) option). An options object like play's: stop(3) throws in dev
- `music.stinger(name: string, opts?: { duck?: number; volume?: number })` — Layer a one-shot piece (victory, discovered place...); the background dips to `duck` while it plays
- `music.rules(list: MusicRule[] | null, opts?: { hold?, fade?, interval? })` — Set the auto track rules (null turns them off). opts: hold how many seconds a new result must be stable before switching, fade switch fade seconds, interval check interval
- `music.override(name: string | null, opts?: { fade?: number; force?: boolean })` — Pick a track by hand, pausing the rules; override(null) hands control back
- `music.pick() → string | null | undefined` — Which track the current rules would pick (without switching)
- Properties:
  - `tracks: Map<string, Exclude<MusicTrack, string>>` Registered tracks
  - `current: string | null` Name of the track playing (or wanted)
  - `intensity: number` 0-1: how loud each stem of the playing track is (see the stems `at` range); fades in about half a second
  - `ready: boolean` Whether audio is usable
  - `ruled: boolean` (experimental) Auto track rules are in use
  - `state: { current, playing, pending, override, intensity, gain, … }` State (for debugging and tests): gain is the playing track's fade level, stems each stem's level

## Data structures
- **MusicRule** Auto-selection rule: when the condition holds play track (null = silence), higher priority wins; no `when` = always (a fallback)
  - `track: string | null`
  - `when?: MusicCondition`
  - `priority?: number`
