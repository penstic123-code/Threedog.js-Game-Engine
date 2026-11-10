# Bring your own renderer: `createEngine({ renderer })`

> **Covers:** passing in your own three.js renderer (a `WebGLRenderer` or `WebGPURenderer` you made) instead of the one the engine makes.
> **Use when:** the game must own the renderer (shared canvas, editor).
> **Shortest:** `createEngine({ renderer })`.

Pass a ready three.js renderer when the game must own it (shared canvas, an editor, a custom context):

```js
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const engine = createEngine({ renderer });  // canvas defaults to renderer.domElement
```

- The engine configures only a renderer it created itself. With yours it sets nothing: pixel ratio (unless `pixelRatio` is given), size, tone mapping, exposure and shadow map stay as you left them, so set them yourself on the renderer. MSAA follows your renderer's `antialias` too (unless `createEngine({ antialias })` says otherwise; a value that differs from the renderer's runs the post chain's MSAA targets every frame).
- **WebGLRenderer or three's WebGPURenderer.** On WebGPURenderer, materials, patches and post effects take their node / TSL forms (recipe 56). Everything else (scene, modules, input, saves, ops) does not depend on the renderer.
- Changing the renderer, lights or post effects is yours to do at any time; the engine never warns. `engine.describe().render` (CLI: `describe render`) lists the current values; `describe().picture.writers` says which line wrote each on the dev server.
- **A transparent canvas** (the page shows through where nothing is drawn) is this same route; createEngine has no option for it. WebGL: `new THREE.WebGLRenderer({ canvas, alpha: true })` (three's default is opaque). WebGPURenderer: alpha is on by default; pass `alpha: true` to be explicit. Then `renderer.setClearColor(0x000000, 0)` and keep `engine.scene.background` null (a colour or texture background is opaque by definition). Post effects keep the alpha (tested on both backends with vignette). With `fallback: 'webgl'` a WebGPURenderer you built with alpha is replaced by a WebGLRenderer that keeps the alpha (a renderer the engine built itself stays opaque).
