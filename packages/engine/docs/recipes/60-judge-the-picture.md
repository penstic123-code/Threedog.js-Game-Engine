# 60 Make the picture look good: what each knob does and how to judge it

> **Covers:** visual polish, how to tune the picture: the knobs, what each does on screen, how to judge it.
> **Use when:** the picture looks flat or off and you want to know what to try.
> **Shortest:** judge in the loop of §1.
> **Sections:** How to judge, in · The knobs · When the picture check · Same knob, different styles

A map for visual polish: when you want to tune the picture, make a scene look prettier or closer to what the game wants, this page lists the
knobs, what each one changes on screen and how to tell it is right. **It is not a list of steps and nothing here is required**: pick the knobs
your style needs and leave the rest alone. There are no values to copy on purpose; the right value depends on the style, the camera and the
time of day, so every row says what to look for instead.

Where the rest lives (one home each): calls, parameters and who writes what: [recipe 52](52-around-the-picture.md); the plain three.js way: [THREE.md](../THREE.md); whole-picture questions and the numbers each shot prints: [recipe 35](35-picture-from-reference.md) "Picture questions" and "Picture check after every shot"; a whole picture: `picture/` code ([62](62-picture-code.md), materials and lights [09](09-materials-lights-models.md)).

## How to judge, in one loop
Change one knob, take a shot (`threedog shot`, or `threedog snap` on a running page), compare with the one before, keep or undo. Shoot the
times and weathers the game really shows (`threedog shot --time`), not only noon. A knob is right when the difference you wanted is visible
and nothing else got worse; when you cannot say what difference a knob should make, leave it at the style's value.

Whether a picture reads as lit is mostly key against fill. The key (the sun or one main light) casts the shadow; the fill is everything else (sky and ground light, the environment). Shadowed
surfaces see only the fill while lit ones see both, so the balance sets how deep the shadows look: less fill is harder, more fill softer and more readable, and there is no right ratio, only the one the
game wants. A warm key over a cool fill (or the reverse) separates lit from shaded sides without more contrast. The shot's `light:` fact measures the ratio; judge it on a shot with a known-colored object in
shadow. `threedog examples pull sun-and-key-light` shows three routes side by side.

## The knobs

| Knob | What it changes on screen | It is right when | How (details) |
|---|---|---|---|
| Sky gradient, horizon | the color from the top of the sky down to where it meets the ground | the horizon band and the fog agree where they meet; the top-to-horizon change matches the hour and mood; no visible seam | `engine.sky.top`, `engine.sky.horizon` ([08 §3](08-weather-sky.md#3-changing-sky-colors-sun-stars-the-day-and-night-sky)); own shader: share `engine.uniforms.uSkyHorizon` / `uSkyTop` ([08](08-weather-sky.md#sky-color-for-my-shader-horizon-color-zenith-color)); own sky: `engine.sky.replace(mySky)` |
| Fog near / far | how fast distant things fade | the play space stays clear, the far edge of the world dissolves instead of ending in a line, landmarks you want seen still read | `engine.scene.fog = new THREE.Fog(color, near, far)` ([34 Fog](34-environment-lighting.md#fog-plain-threejs-signals-your-own-math)) |
| Fog color vs sky | whether the distance melts into the sky or into its own haze | distant hills fade toward the sky behind them; a fog color of its own is a choice you can name (smoke, mist, a dream) | `scene.fog.color`, your `picture/` code reads `uSkyHorizon` ([34 Fog](34-environment-lighting.md#fog-plain-threejs-signals-your-own-math)) |
| Exposure | overall brightness after lighting | the brightest things you care about keep detail and the darkest still read; a night is dark because the lights are, not because exposure hides it | `engine.renderer.toneMappingExposure` ([34 Exposure](34-environment-lighting.md#exposure-and-the-tone-curve)) |
| Tone mapping curve | how highlights roll off and how saturated bright colors stay | bright colors keep their hue where the style wants color, highlights soften where it wants film; flat-color styles may want almost no curve | `engine.renderer.toneMapping = THREE.AgXToneMapping` (or ACESFilmic, Neutral, No) ([52 Who writes it](52-around-the-picture.md#who-writes-it-the-ownership-table)) |
| Sun direction | where shadows fall and which faces are lit | shapes read from the camera (lit side and shaded side both visible), shadows point somewhere useful, the hour looks like the hour | time of day (`engine.calendar`, [06](06-clock-events.md)); sun path: `engine.sky.orbit.tilt`; the lights do not move on their own: aim yours from `engine.uniforms.uSunDir` ([62](62-picture-code.md)) |
| Sun color, intensity | the key light: color and strength of lit faces | lit and shaded sides separate; whites under the sun are the white the style wants (warm, neutral, cool) | your `picture/` code writes the light ([62](62-picture-code.md)) |
| Ambient / hemisphere, environment | the fill: how bright and what color the shaded side is | shadows are as deep as the style wants and still show shape; up-facing and down-facing faces differ; metals have something to reflect | your `picture/` code writes the hemisphere light and `scene.environment`, `scene.environmentIntensity` ([34](34-environment-lighting.md), [08 brightness](08-weather-sky.md#3-changing-sky-colors-sun-stars-the-day-and-night-sky)) |
| Shadow softness | hard or blurred shadow edges | edges match the light (crisp under a clear sun, soft under cloud or for a gentle style); no stair-steps or speckle | `renderer.shadowMap.type`, `light.shadow.radius` ([45](45-cascaded-shadows.md)) |
| Shadow distance, detail | how far shadows reach and how sharp small ones are | the area the player looks at has shadows; small props keep theirs; objects touch the ground (no gap under a foot) | `engine.shadows.box(sun, { extent })`, `engine.shadows.cascades(sun, { count, maxFar })`, `light.shadow.bias`, `mapSize` ([45](45-cascaded-shadows.md)) |
| Bloom | light bleeding around bright pixels | the bright things you meant (sun, lamps, magic) glow and nothing else does; the picture does not turn milky | `engine.post.add(bloom())` from `@threedog/post-effects`, or three's `UnrealBloomPass` through `engine.post.add(pass)` ([52 Post chain](52-around-the-picture.md#post-effect-chain)) |
| Light glow / halo | lamps, windows, signs that read as lit | a glowing object keeps its hue at the center (it is not a white block), has a halo where bloom is on, and lights its surroundings if it should | `material.emissive`, `engine.uniforms.uNight` ([09 §1b](09-materials-lights-models.md#night-glow-emissive-that-follows-daylight)); many lamps: `lightPool` ([09 §1b](09-materials-lights-models.md#1b-lights-and-stalls)) |
| Water, sea | color with depth, waves, foam, what it reflects | shallow and deep read differently, the far sea meets the sky without a seam, foam sits where waves break | `engine.water.shader({ depthColor, foam })`, `engine.water.uniforms.uWave` ([44](44-water-weather-hooks.md)); own: three/addons `Water`, a `ShaderMaterial` ([44 own material](44-water-weather-hooks.md#water-your-own-material-reflections-refraction)) |
| Wet ground | streets and stone after rain | wet is darker and glossier together, gloss shows reflections of something bright, puddles have soft edges | no engine picture: read `engine.uniforms.uRain`, then write `material.color`, `material.roughness` ([08 §7](08-weather-sky.md#7-wet-roads-and-puddles-after-rain)) |
| Color grading | contrast, saturation and warm / cool shift of the whole frame | the frame has the mood you named; skin, foliage and the player's colors still read | `engine.post.add(lut())` from `@threedog/post-effects`, or `new LUTPass({ lut })` ([52 Post chain](52-around-the-picture.md#post-effect-chain)) |
| Cloud shadow | moving dark patches on the ground | the patches drift slowly enough to read as clouds, are as dark as the sky is cloudy, and do not hide gameplay | `engine.uniforms.uCloudShadow`, `uCloudShadowScale`, `uCloudShadowSpeed`; clouds in the sky: `uCloudCover`, `uSkyCloudScale`, `uSkyCloudSpeed` on the dome ([08](08-weather-sky.md)); your own: `engine.shaderTerms.cloudShadow(spec)` ([52](52-around-the-picture.md)) |
| Grain, vignette | film noise; darker frame corners | you notice the mood, not the effect; text and the HUD stay clean | `engine.post.add(grain())`, `engine.post.add(vignette())`; a pixel snippet: `engine.post.add({ name, fuse: { glsl }, slot: 'ldr' })` ([52 Post chain](52-around-the-picture.md#post-effect-chain)) |
| Ambient occlusion | darker creases and contact corners | objects sit on the ground and corners have weight; no dark halo around thin things | `engine.post.add(ao())` ([52 Post chain](52-around-the-picture.md#post-effect-chain)) |
| Outline | lines around shapes | lines help read shapes at play distance and match the style's line weight | `engine.post.add(outline())` ([52 Post chain](52-around-the-picture.md#post-effect-chain)), or three/addons `OutlinePass` |
| Surface shading | how light falls across a surface (smooth, banded, flat) | materials that should differ (wood, stone, metal, cloth) differ in response, not only in color | `new THREE.MeshToonMaterial({ gradientMap })` or any material of yours; `applyEffects(mat, { lighting })`, `rampTexture` ([43](43-shader-patches-surfaces.md), [09](09-materials-lights-models.md)) |
| God rays, volumetric fog | light shafts, fog thick in the air | shafts come from where the light is and fade when it leaves the screen | `lightShaft`, `sunShafts`, `lightVolumes` ([34](34-environment-lighting.md)); haze by depth ([59](59-depth-post-effects.md)) |

## When the picture check names a feature
The check printed after every shot states a fact and, where the engine has a feature for it, one line of usage. Each is a way out, not a request: a
hard-edged or pitch-dark look may want exactly what was measured. All of them read the lights in the scene, the game's own included.

| The check says | What it measured | Where it points |
|---|---|---|
| one shadow texel covers X m | the size on the ground of one shadow map pixel, when shadows do not show | cascades: `engine.shadows.cascades(engine.lights.sun, { count })` for the engine sun, `engine.shadows.cascades(light, { count: 3 })` on your own light ([recipe 45](45-cascaded-shadows.md)) |
| over budget | lit point and spot lights, shadow maps, the largest map size, against `engine.budget` | many lights: `engine.lightPool` ([recipe 09](09-materials-lights-models.md)); shadows: `castShadow`, `light.shadow.mapSize` picked from `engine.tier` |
| shadows nearly black | how much the fill adds on the shadowed pixels themselves | `engine.bakeProbes` ([recipe 34](34-environment-lighting.md)) or a fill light |
| shadow stripes, stepped edges | the shadow alone, at canvas pixels: several thin bands side by side, or edges that move when only the shadow map's pixel grid moves | the bias, map size and shadow range it lists; stairs also the cascades above |
| fog covers X% | how much of the picture is fog color; printed before a line about the night, since the fog comes first | `scene.fog` |

Limits a game sets per device go through the same check: `engine.budget.enable(engine.tier === 'low' ? { lights: 4 } : { lights: 12 })`. A limit you wrote is
reported as your own intent; the engine's default line (lights 8, shadow maps 7) is only a fact.

## Same knob, different styles
A knob is a direction, not a setting. Three styles, the same three knobs, moved different ways:

| Knob | Realistic dusk | Flat cartoon | Gloomy rainy night |
|---|---|---|---|
| Key against fill (sun, hemisphere) | a low, warm key against a cool fill: long shadows, faces lit on one side | a soft key and a strong fill, so shadows are a shape of color, not darkness; little warm / cool split | almost no key; the fill is dim and cool, and the light comes from lamps and windows instead |
| Fog | follows the horizon color; starts far, so the distance turns golden-grey | often light or off, so the bright flat colors stay clean; if on, a pale tint of the sky | close and dark, a color of its own (blue-grey), so lamps are islands in it |
| Bloom and glow | a gentle bloom on the sun and the first lit windows | little or none; glowing things are a brighter flat color | lamps and signs carry it: saturated glow, a halo through the rain, reflections on the wet ground below |

Read the other knobs the same way: ask what the style wants the viewer to notice first, then move the knob toward that and stop when the shot
shows it.
