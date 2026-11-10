# Making a new picture from a reference picture

> **Covers:** matching a reference picture: the loop, the picture check after every shot, a fixed scene to judge by.
> **Use when:** the look should come close to a given image.
> **Shortest:** `threedog picture palette ref.png`, then `threedog shot`.
> **Sections:** The loop every round · What picture code can · Steps · Picture check after every · Picture questions · Guard rails · A fixed scene to

```sh
threedog picture palette art/reference/ref.png --n 8 --average     # the colors: they go in picture/palette.js
threedog shot --size 480x270 --out now.png                         # your picture, with its picture numbers
threedog picture compare art/reference/ref.png .threedog/shots/now.png --out side.png   # what differs, as numbers and one image
```

No reference picture? Skip the measuring (step 2, `picture palette`, `picture compare` against a reference); judge each shot against DESIGN.md and
its "Loved / Not for this game" list, and use the rest: the loop, the picture check after every shot and the picture questions.

For turning one given picture ("make it look like this") into the game's picture. `threedog picture palette` and `picture compare` measure; the game's `picture/` folder
holds the result in plain three.js (recipe 62). They never say which colors are right: the taste is yours. This page is the order of work.

## The loop (every round, in this order)
Looping "edit, screenshot, read the image" costs the most tokens and fixes the least. Numbers come first, pictures last.
1. **Measure the reference once** (step 2 below). Break the picture into
   techniques (shading, one texture language, palette, edges) before choosing values.
2. **Change one family of values** (colors, then materials, then post). After writing or changing a model, look at it alone
   first: `threedog gallery --shots` (every model under three lights, `.threedog/gallery/index.html`) shows wrong scale, wrong facing, holes and missing
   faces before the level hides them.
3. **Shoot small and compare to the previous shot**: `threedog shot --size 480x270 --keep --compare <previous.png>`. It prints the
   pixel diff and the picture differences. Through MCP the `snap` tool is 480 px wide by default; `picture_compare` gives the numbers.
4. **Read the numbers first, then at most one image per round.** Name the biggest remaining difference and fix only that. With no reference, read the shot's hints (below). Then look at the image as a player would and judge it
   against the picture DESIGN.md wants and its "Loved / Not for this game" list (never against a technique example): what would a player read as a
   mistake (objects floating or cutting into each other, odd flat discs, glare, areas too dark or busy to read, placeholder shapes)? Fix what you find, or note it in
   STATUS.md with why it stays. Before calling a picture done, go through the "Picture questions" below that matter for this game.
5. **Wrong in a way the numbers do not explain?** Diagnose before guessing: `engine.debug.view('albedo' | 'lighting' | 'shadow' | 'normals')` shows which
   layer is off, and every value has one writer, a line in your `picture/` code. Nothing drawn: `threedog scene --hidden` (reasons per mesh).
   Washed-out or too-dark textures, odd normals: `threedog inspect materials` (wrong color spaces first, sizes, who made each material).
6. **If the biggest difference stops shrinking over a few rounds, change approach** (in this order) and tell the user which and why:
   painted textures (`map`, `normalMap`) -> node inputs (`colorNode` ...) on your own node material (WebGPU, recipe 56; on WebGL `onBeforeCompile`) -> a whole shader of your own (TSL, or `ShaderMaterial` on WebGL).
   Never call it "close" to stop tuning.
7. **Every few rounds show the user the shot and the numbers.**

The loop is the same for every art direction; only what you measure and which value you move differ: flat (palette share, hard edges, no shading), painterly
(soft edges, texture, low contrast), low-poly (few flat colors, faceted light), realistic (exposure, tone mapping, lighting, material roughness). None is the default.

## What picture code can change, and what it cannot
Can change (all in `picture/`, plain three.js): colors (`picture/palette.js`, `scene.background`), every material (matte `MeshLambertMaterial`, banded `MeshToonMaterial`,
PBR `MeshStandardMaterial`, your own shader), the engine's big parts through their own `.material` and `.uniforms` (ground, plants, water, sky dome), lights, fog,
`renderer.toneMapping` and `toneMappingExposure`, post passes (the effects in `@threedog/post-effects`), UI colors and fonts, and the colors
of the procedural models.

Cannot change by picture code: the **silhouette of models**. A tree stays the shape its model has; a new shape means a new asset (code-built models
or `.glb` files, recipes `05-props-bake.md` and `10-blender-level.md`). And the **world rules**: water level, terrain shape, what
exists where, timing and gameplay belong to the modules' options and the game's content. If the reference shows a different
world (a canyon instead of hills), say so instead of faking it with colors.

## Steps
1. **Keep the picture.** Put it in the game's `art/reference/` (one file per style, with a few lines of notes beside it on what to copy:
   palette, mood, line work, light direction). Use the highest-resolution picture you have: a small or compressed one gives wrong detail and brightness numbers.
2. **Measure it.** `threedog picture palette art/reference/ref.png --n 8 --average` (MCP: `picture_palette`) prints the colors (`--json`: JSON only) with share, hue, saturation,
   brightness, and role hints: largest block = ground / environment candidate, brightest = highlight / sky candidate, most saturated = accent candidate,
   darkest = shadow or outline candidate, and one summary line such as `warm colors, mostly sand, low saturation, medium brightness, weak light/dark contrast`.
   It reads pixels in a headless browser (png, jpg, webp, gif, svg). The overall mean (`--average`) sets exposure and tint; the clusters pick the named
   palette entries. A phone screenshot with a dark UI frame needs `--ignore-ui` or `--region x,y,w,h`; `--crop cut.png` saves exactly what was measured.
3. **Write them down.** The colors you measured go in `picture/palette.js`, snapped to a few named ones (a reference usually has 5 to 8 that matter). Procedural
   models the picture needs go in the game's `art/` folder, registered with `engine.assets.manifest({ name: 'mygame', models })`.
4. **Fill it in, in this order** (each step changes the picture most for the least work): sky colors and `scene.background` (light and mood), `renderer.toneMapping` and
   exposure, the lights in `picture/lights.js`, the ground's colors, the materials in `picture/materials.js` (matte, banded, shiny, PBR, unlit), post, then UI.
   The first frame should already be close: if it is far from the reference, fix sky, exposure, palette and material type before adding anything.
5. **Check.** `npm run check` type-checks `picture/`, and a misspelled option or a bad call fails on the page with a line in `.threedog/errors.log`.
6. **Picture: the loop above.** Take pictures with the same arguments every round so only the picture differs, from named places (`shot --at <place>`), not free `--pos` shots.
   `picture compare` prints the differences as numbers and one sentence such as "the screenshot is darker and more broken up".
   Dirty = lower saturation or an off hue, fragmented = fine detail ratio well above 1, dark or flat = brightness and contrast. Keep a change if its number moved toward
   the reference and the picture looks better. A phone UI frame in the screenshot skews the numbers: compare a `--region`.
   `--out side.png` (MCP `picture_compare` always writes `<shot>.compare.png`) is one image, reference left, screenshot right.
7. **Stop** when the biggest remaining difference is a silhouette or a world rule: that is the assets or the game, not the picture code.

## Picture check after every shot
Every `threedog shot` prints picture numbers and hints (`--no-picture` skips them). The numbers are mean luminance, contrast (std and p5-p95 range of
luminance), saturation, clipped-white and near-black shares, the shadow area and how much shadows darken. Hints come in three kinds:
- **Contradictions**, whatever the art direction: the settings say one thing and the pixels another. Shadows on but none measurable (with the cause it found:
  the light's `shadow.bias` as meters of shadow depth, the view outside the shadow box, texel size, or fill light washing them out), a light the game added that changes
  no pixel.
- **Facts**: measured, maybe wanted, with what sets them. Each becomes a contradiction only where DESIGN.md declares the opposite (the `Picture intent:` word in brackets):
  glare, naming each light or glowing material that blows pixels out with its current values and the detail lost under it, and large clipped areas (`no-glare`);
  large near-black areas (`no-pitch-black`); time of day that barely changes the picture or a night not dark from lighting, and whether the brightness at 00:00 is lighting at all
  (renders 12:00 and 00:00 when the game runs calendar + sky or the shot sets `--time`; `dark-nights`); `light:` the share of the lit brightness from the sun / key and from the fill
  (each turned off once) and how much darker shadowed areas are (`strong-light`); the camera standing inside a closed mesh; a black frame, naming the material whose hiding alone
  brings the picture back (newest materials first; a ShaderMaterial is told the usual NaN / Inf causes, and shader programs that failed to compile are listed); fog that is most of
  the color in a large share of the picture, with its near / far and color.
- **Intent**, only against what the game declared: DESIGN.md's optional `Picture intent:` line (listed words such as `no-glare`, `dark-nights`,
  `strong-light`, `muted`; the template lists them all; the table's free text is not read), or the reference given with `--ref`. A muted,
  low-contrast game is told when its shot measures saturated and contrasty, never the other way round unless it said so. No declaration and
  no reference: numbers only, no judgement.

A hint is a fact plus the parameter and its current value, not a target. It never says what value is right for an art direction; decide that from
the reference, DESIGN.md or the user. A deliberate choice (a night meant to be pitch black) makes a hint something to note, not to fix.

## Picture questions
Pick the ones that matter for this game, before calling a picture done and when a round stalls. They name what to look at, not which answer is
right for a given art direction.
- **Light roles**: is there one clear key light (direction, color), a fill that keeps shadows readable, and does the sky / ambient color agree with it?
  `debug.view('lighting')`.
- **Shadows and contact**: do objects sit on the ground (contact shadow, AO, or a dark base), are shadow edges as hard or soft as the reference, no
  acne or peter-panning? `debug.view('shadow')`. A shadow that starts a hand's width away from a foot or a crate is peter-panning: check
  the light's `shadow.bias` (it is in 0-1 shadow depth, so a large value over a long light range is decimeters). Faint shadows: key against fill ([recipe 60](60-judge-the-picture.md)); small casters blur when the
  shadow box is much bigger than the scene ([recipe 45](45-cascaded-shadows.md)).
- **Day / night**: shoot noon and night (`shot --time 12:00`, `--time 22:00`); is night as dark as the design wants on every material, PBR ones
  too? A PBR material that stays bright at night is usually lit by an environment map that does not follow the time: `scene.environmentIntensity` is yours to drive from `uDaylight`.
- **Material response**: do surfaces that should differ (wood, stone, metal, cloth, skin, water) differ in roughness, specular and color, not only hue?
  A plastic-looking surface is a shading problem, not a color problem.
  Metals have something to reflect (environment). A glossy flat decal (puddle, spill, polished floor) reflects only the environment map, never the
  street around it: a hard-edged dark or bright ellipse then reads as a hole or a blob. Give it soft alpha edges and a color close to the surface
  under it, or darken / smooth the ground's own material (roughness map) instead of laying a disc on it; check it at noon and at night.
- **Texture scale and detail**: is texel density similar across neighbors, no obvious tiling at the usual camera distance, detail matching how close the
  camera gets? Color spaces right (`inspect materials`).
- **Color and grading**: value range (darkest / brightest), saturation and the overall hue shift match the reference (`picture compare`); exposure and
  tone mapping chosen, not left at whatever was there.
- **Atmosphere and depth**: fog, haze or color shift with distance as the reference shows; the background separates from the play space.
- **Readability of gameplay elements**: the player, interactables, hazards and pickups stand out by value or color from the ground at play distance and
  under every time of day / weather the game uses (shoot them at dusk and in rain too).
- **Consistency**: does any asset step out of the overall art direction (outline weight, shading model, texture language) where DESIGN.md did not
  intend it? A deliberate mix is a choice, not a mistake.

## Guard rails
- Restraint: for each post effect, say which difference in the shot it fixes. Start with none, add one for a visible difference you named, and
  measure again after each one.
- Never put gameplay or world values in `picture/` to match a picture.
- Fonts and textures are assets: register the file in an asset pack and name it, the picture code does not carry files.
- Keep `npm run check` at 0 errors; a new picture adds no warnings.

## A fixed scene to judge by
Same arguments, same picture, so only the picture differs. A game with many pictures to judge gives itself a small page with one of everything; `/styletest.html`
(`examples/styletest`) is the engine's own, a pattern to copy: a character, trees, rock, grass, flowers, water, terrain, glass, a shadow receiver,
wood / stone / metal surfaces, a lit room (outside and inside) and the UI parts, under named cameras.
- `threedog shot styletest --view <name> [--time day|dusk|night] [--weather clear|rain|snow]`; the same words work as URL parameters
  (`?view=room&time=dusk&weather=rain`).
- Views: `overview`, `character`, `water`, `room`, `path` (the camera moves along a fixed line: with `--wait 4` the shot is the same frame every time; in a browser look for grass blades
  and shadow edges that flicker or crawl), `ui`.
- The dev panel, in any game: `if (location.search.includes('panel=1')) import('@threedog/tools/panel').then(m => m.openPanel(engine));`
  It needs the optional dev package `tweakpane` (`npm install -D tweakpane`; the repository's `npm install` has it); without it the page says so.
  A production build of the vite preset gets a stub instead (no panel, no tweakpane in the bundle); dev and test builds get the real one.
  It reads the three.js objects and writes them directly: exposure, `scene.fog`, each light, `engine.water` / `terrain` / `vegetation` materials and uniforms
  (when installed), a material picked by name, `engine.uniforms`, post effects, UI colors. "write back" saves the changes to
  `.threedog/tune.json` on the dev server; then `threedog tune write <file>` prints the code change as a diff (one block
  of plain three.js writes) and `--apply` writes it. Review it, then keep the block or move each value where it belongs (`picture/palette.js`, the material's definition).
