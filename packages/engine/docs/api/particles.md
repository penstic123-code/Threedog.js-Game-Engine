# engine.particles — particles(opts?: ParticlesOptions)

Particles (particles() module)

- Options `ParticlesOptions`:
  - `effects?: Record<string, ParticleOptions>` Effect params by name: under what define() gives, and defined on the first emit / attach when define() never ran
  - `default?: ParticleOptions` Params every effect starts from

## Methods and properties
- `particles.define(name: string, opts?: ParticleOptions) → ParticleEffect` — Define an effect (same name replaces it, and emitters attached to it move to the new definition); params sit on top of particles({ effects, default }). Returns the effect object: .points is its THREE.Points (a Sprite on WebGPURenderer); .material is its plain three.js material (set your own and it is drawn as given, null gives the engine's back); .uniforms are the engine material's { value } objects (uMap, uHasMap, uScale, uMaxPx), which a ShaderMaterial of yours can share. A material of yours lasts until the effect is defined again. Example: `engine.particles.define('sparks', { blending: 'additive' }).material = myMaterial;`
- `particles.has(name: string) → boolean` — Whether this effect has been defined
- `particles.emit(name: string, position: PositionLike, opts?: { count?, overrides? })` — Burst: emit count particles at once (default 10) at position (Vector3 / Object3D / [x, y, z] / {x, y, z}). overrides affect this batch only (color, speed, direction...; max/texture/blending/soft/lit cannot be changed temporarily)
- `particles.attach(name: string, object3d: THREE.Object3D, opts?: { rate?, ratePerMeter?, offset?, overrides? }) → ParticleEmitter` — Keep emitting while following an object: rate per second, ratePerMeter per meter it moves (spread along the path, on top of rate), offset in the object's local coordinates [x, y, z] (meters). Returns a handle { remove(), rate, ratePerMeter, active } (active = false pauses)
- `particles.count(name?: string) → number` — Live particle count (no name = all)
- `particles.clear(name?: string)` — Clear one effect's (or all) particles
- Properties:
  - `effects: Map<string, ParticleEffect>` (experimental) Defined effects

## Data structures
- **ParticleOptions** Particle effect parameters (define(), and each entry of particles({ effects, default })). All optional
  - `max?: number` Maximum alive at once, default 120 (60 on low-tier devices; a number the game gives stands)
  - `lifetime?: Range` Seconds each particle lives [min, max]
  - `rate?: number` Default particles per second for attach
  - `speed?: Range` Initial speed (m/s) [min, max]
  - `direction?: number[]` Emission direction [x, y, z]
  - `spread?: number` Maximum angle away from the direction (radians, π = all directions)
  - `area?: number | number[]` Radius of random spread around the spawn point (meters), or a box [x, y, z]
  - `gravity?: number` Vertical acceleration (m/s², negative falls)
  - `drag?: number` Air drag (fraction of speed lost per second)
  - `wind?: number` How much wind affects it
  - `windDir?: number[]` Wind direction [x, y, z]
  - `size?: Range | number[][]` Size at birth / at death (meters), or stops over life: evenly spaced [a, b, c] or timed [[0, a], [0.2, b], [1, c]] (0 birth, 1 death)
  - `color?: ColorLike | ColorLike[] | ColorLike[][]` Color at birth / at death (one color, or [birth, death]; an array, not a tuple, so a plain JS literal [0xffffff, 0xdddddd] type-checks), or stops over life as for size
  - `opacity?: Range | number[][]` Opacity at birth / at death, 0–1, or stops over life as for size: [[0, 0], [0.1, 0.8], [1, 0]] fades in, then out
  - `texture?: string | Texture | null` Texture (asset name, path or THREE.Texture); a soft round dot if omitted
  - `blending?: Loose<'normal' | 'additive'>` 'normal' / 'additive' (glowing blend, for sparks)
  - `spin?: number` Texture rotation speed (radians/second)
  - `worldSpace?: boolean` With attach, whether particles stay in the world (true) or the emission direction rotates with the object (false)
  - `fog?: boolean` Affected by fog, default true
  - `maxPixels?: number` Largest on-screen size of one particle in pixels (smoke drifting past the camera stays bounded), default 512
  - `ratePerMeter?: number` (experimental) Default particles per meter the emitter moves for attach, on top of rate, spread along the path it moved; default 0
  - `soft?: number` (experimental) Meters over which a particle fades where it meets what writes depth; default 0, off. Set at define, not in overrides. On WebGLRenderer it costs one depth-only draw of the scene per render while such an effect is on screen
  - `lit?: boolean` (experimental) The scene's lights tint each particle's color (dust a lamp lights): point, spot, directional, ambient, hemisphere, as a matte card facing each light. No shadows, environment map or probes. Default false (the color is drawn as given). Set at define, not in overrides; costs live particles x lights per frame on the CPU, the same on both renderers
- **ParticleEmitter** (extends Handle) Continuous emitter returned by attach() (a handle)
  - `rate: number` Particles per second (can be changed at any time)
  - `ratePerMeter: number` (experimental) Particles per meter the object moves, on top of rate (can be changed at any time)
  - `active: boolean` false pauses
  - `remove()` — Stop and remove (also removed automatically when the object leaves the scene)
