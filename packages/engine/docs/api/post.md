# engine.post (PostFX)

- `post.object() → any` — (experimental) What the chain runs in, for reading, or null while no post work has run yet (built the first time an effect is on; it is not built here, so asking never costs a render target). WebGLRenderer: the three.js EffectComposer (pass list, sizes, its targets). WebGPURenderer: { pipeline, scenePass }, three's RenderPipeline and the scene's pass() node. Read-only by rule, not by lock: the engine owns it, rebuilds the chain whenever the list changes and disposes it with the engine. To add a pass use post.add, to own the whole chain post.own() (recipe 52). Why public: a game reading the chain had to dig into an internal field (review 2026-11-03)
- `post.targets() → { renderTarget1, renderTarget2, readBuffer, writeBuffer } | null | …` — (experimental) The composer's render targets, for reading (sample the last frame's color or depth in a game pass, check formats / samples), or null while there is no composer, and always on WebGPURenderer (its pass nodes own their targets: post.object().scenePass). renderTarget1 / renderTarget2 are the ping-pong pair. During the chain readBuffer is a pass's input and writeBuffer its output; EffectComposer swaps them after every pass with needsSwap (most passes; the scene RenderPass does not). The last pass draws to the canvas and still swaps, so after the frame (engine.onRender(fn, { when: 'after' })) neither target holds the final picture: writeBuffer holds the input of that last pass (readBuffer when the last pass does not swap) and readBuffer is stale. For the final image, render into a target of your own.
- `post.add(x: any, o?: { name?, slot?, order? }) → PostHandle` — The one way to add a post effect. x is a three.js Pass (WebGL), a TSL node function (input, ctx) => node (WebGPU), or an effect { name, create / node / fuse, slot, order, params, needsDepth, needsBuffers, backend, skipOnLowTier, cheaper, facts } (both renderers when it gives create and node, or a fuse). A wrong shape throws with nothing added. needsDepth, needsBuffers ('normal' / 'diffuse' / 'velocity' / 'metalRough', WebGPU), backend ('webgpu': not on the WebGL2 backend), skipOnLowTier (held when engine.tier is 'low') and facts (shown by describe().render.post) are explained on PostEffect. A Pass that draws engine.scene takes the 'scene' slot, FXAA / SMAA / TAA 'final', any other 'hdr' after the effects already there, or 'ldr' once an OutputPass was added. Example: `const glow = engine.post.add(new UnrealBloomPass(size, 0.6, 0.4, 0.85), { name: 'glow' }); glow.enabled = false;`
- `post.get(name: string) → PostHandle | undefined` — An added effect's handle (as add() returns it), or undefined. Example: `engine.post.get('bloom').set({ strength: 0.6 });`
- `post.byRole(role: string, name?: string) → PostHandle[]` — (experimental) The added effects that declare this role in about.acts ('glow', 'ao', 'exposure'): found by what they do, never by name; the settings rows and photo follow every one of them. Only when NO effect declares the role does the effect named `name` stand in (a game's own 'bloom' written before roles existed); with no `name` that case gives [].
- `post.own(on?: boolean)` — (experimental) Hand the built chain to the game: the engine stops rebuilding it, so the composer's passes (post.object().passes) or the WebGPU pipeline's outputNode are the game's to edit. own(false) gives it back and rebuilds from the list. describe().owned shows who has it. Example: `engine.post.own(); engine.post.object().passes.reverse();`
- `post.list() → { name, slot, order, enabled }[]` — Effects in render order: [{ name, slot, order, enabled }]
- `post.render(dt: number, target?: any)` — Draw the frame through the chain. target: a render target to draw the finished picture into instead of the canvas (engine.renderOnce(target)); it gets the canvas's pixels (tone mapped, output color space). Why a target argument and not "set the render target first": the WebGL chain's last pass always writes to the canvas (EffectComposer renderToScreen); the WebGPU pipeline draws into whatever target is set.
- Properties:
  - `antialias: boolean` (experimental) MSAA on or off in the post chain's render targets, for what runs through the chain. It is a render setting, not a drawing part. With no effect on nothing runs through the chain: the canvas's own MSAA shows, fixed when the context was made (createEngine({ antialias })). Example: `engine.post.antialias = false;`
  - `active: boolean` Whether the post chain runs: an effect is on

## Data structures
- **PostEffect** An effect as data, the form post.add() takes. node (WebGPURenderer): returns the effect's output color node built on input (the color node so far); called again only when a param that is not a number, boolean, color or vector changes (those are live in ctx.p). An effect with only create cannot run on WebGPURenderer (it throws by name). create: builds the implementation the first time the effect is on (WebGL: a three.js postprocessing Pass); optional when fuse is given. fuse: see PostFuse; effects with a fuse in the same slot next to each other are merged (never in slot 'scene'), their params update in place (no update() needed). slot: a PostSlot; typed as any string too because a slot in a plain JS object (an effect returned from a function) is a string to TypeScript, and the chain throws on an unknown slot naming the valid ones.
  - `name: string`
  - `create?: (ctx: PostContext) => object`
  - `node?: (input: any, ctx: PostNodeContext) => any`
  - `fuse?: PostFuse`
  - `slot?: PostSlot | (string & {})`
  - `order?: number`
  - `enabled?: boolean`
  - `needsDepth?: boolean`
  - `needsBuffers?: ("normal" | "diffuse" | "velocity" | "metalRough")[]`
  - `backend?: "webgpu"`
  - `skipOnLowTier?: boolean`
  - `cheaper?: Record<string, any>`
  - `facts?: () => Record<string, any> | null`
  - `about?: Record<string, any>`
  - `params?: Record<string, any>`
  - `update?: (impl: any, params: Record<string, any>) => void`
