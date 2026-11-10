# engine.photo — photo(opts?: PhotoOptions)

Photo mode (photo() module)

- Options `PhotoOptions` (also includes the fields of PhotoTakeOptions):
  - `maxAlbum?: number` (experimental) How many photos the album keeps at most, default 50
  - `pathTracer?: (() => Promise<any>) | null` (experimental) The game's import of its optional path tracer, called on the first photo.trace(): () => import('three-gpu-pathtracer/webgpu')

## Methods and properties
- `photo.take(opts?: PhotoTakeOptions) → PhotoShot` — Capture a photo now without checks. Gameplay takes photos through the op: engine.ops.run('photo.take') (checks canTake, logged)
- `photo.trace(opts?: PhotoTakeOptions & { samples?, seconds? }) → Promise<PhotoShot>` — (experimental) A path-traced photo (WebGPU backend or a WebGLRenderer; the game's photo({ pathTracer })): samples (whole, >= 1, default 128) accumulate on a snapshot while the game runs, until seconds (>= 1, default 60); resolves to the shot, rejects naming why. scale defaults to 1 here. The op photo.trace starts it (r.value is this Promise)
- `photo.subject() → { name, kind, distance } | null` — (experimental) What is in the middle of the frame (NPC, entity, named object, vegetation), null if nothing; this is the subject of take()
- Properties:
  - `album: PhotoShot[]` Album (newest first)
  - `canTake: () => boolean | string` The op photo.take's can: return true, or false / a reason string to refuse (e.g. () => engine.inventory.has('film') // 'noFilm')
  - `format: string` (experimental) 
  - `maxAlbum: number` (experimental) 
  - `tracing: { samples: number; of: number } | null` (experimental) While a path-traced photo accumulates: samples per pixel so far and the target; null otherwise
