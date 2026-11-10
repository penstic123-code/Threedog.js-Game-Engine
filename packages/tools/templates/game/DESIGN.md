# __NAME__: design

<!-- The short entry to this game's design (keep it under about 12 KB). Detail lives in docs/design/<system>.md, one file per system.
     npm run map copies this file into GAMEMAP.md. Update it in the same commit as the gameplay change. -->

**Pitch**: one sentence on what the player does and why it is fun.

**For whom**: who plays it and what they get from it.

**Not doing**: what this game leaves out on purpose, one line each (a feature nobody asked for starts here, not in code).

**Done for this version**: the playable, shot-checked state where this version stops.

**Core loop**: (not written yet)

**Why this version**: (not chosen) the option picked in the first session (scope, core loop, risk, how it is checked) and the reason.

**Pillars**
- One line per thing the game must never lose.

## Loved / Not for this game
<!-- What moves the user in this game, and what is reasonable elsewhere but wrong for this work. The shot check's taste judgement reads this list and
     the rest of DESIGN.md, never a technique example. One line each; add to it whenever the user reacts to a shot. -->
- Loved: (not written yet)
- Not for this game: (not written yet)

## Picture and controls
<!-- Settled in the first session (see CLAUDE.md "First session"); nothing here is a default to keep silently. -->
<!-- Optional: the one line the shot's picture check reads a wish from (the table below is for people, it is not read). Words:
     bright, dark, high-contrast, low-contrast, saturated, muted, strong-light, dark-nights, bright-nights, no-glare, no-pitch-black. -->
Picture intent (optional): (none)

| Item | Choice | Options (engine name) |
|---|---|---|
| Reference images | (not chosen) | 1-3 images or games whose picture to aim for (art/reference/) |
| Style | (not chosen) | the game's own picture/ folder (gray now): palette, materials, sky, lights, post |
| Ground shading | (not chosen) | smooth · texture (color map, clean color borders) · flat (one color per triangle, faceted) — `engine.terrain.material` · own three.js material / shader on the terrain mesh |
| Character body | (not chosen) | gray capsule (prototype only, not a finished picture) · procedural asset · own GLB from Blender — `{ model }` |
| Asset sources | (not chosen) | per kind (ground and terrain textures, vegetation, characters, props and buildings, effects, sounds): you make or specify · you provide (anything you choose, from anywhere) · generated (procedural code or tools, you confirm) · mix. The AI recommends with reasons; it does not pick an asset library or someone else's style on its own |
| Materials and palette | (not chosen) | colors per material, lambert (matte) · toon (banded) · standard (PBR) · unlit · own three.js material / shader (__OWN_SHADER__) — `picture/materials.js` |
| Sky and time of day | (not chosen) | fixed time or day/night cycle, sky colors, fog — `picture/` reading the signals (recipe 62), `scene.fog`, sky presets · own three.js sky (`engine.sky.replace(mySky)`) |
| Lighting and shadows | (not chosen) | sun strength and color, shadow type and softness — `picture/lights.js` (recipe 62), `engine.shadows`, `engine.sky.environment` · plain three.js lights |
| Post effects | (not chosen) | none · bloom · outline · ao · color grading — `engine.post.add` · __OWN_POST__ |
| Camera and controls | (not chosen) | follow (pointer lock or drag) · first person · top-down / rts · fixed · own camera and controls (recipe 21, sections 6-7) |

## Systems
| System | One line | Detail |
|---|---|---|
