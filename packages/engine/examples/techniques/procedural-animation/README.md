Animate code-built characters and props without a skeleton: walk cycles from speed, tail and ears on springs, breathing, landing squash.

# Procedural animation (technique example)

A neutral box quadruped that walks, trots, jumps, lands and sits. Run `npm run dev` and open `/procanim.html` (WASD, Shift runs, Space jumps,
stand still 4 s to sit; `?walk=2` walks by itself). The picture is plain three.js in `picture/`. The engine never imports this folder.

## The principle
Motion reads as alive when it is tied to cause: feet keep up with the ground, soft parts lag behind the body, weight shows on landing, and
nothing ever stands perfectly still. All of it is plain math on rotations, positions and scales of pivots placed at the joints.
- **Cycle from distance, not time**: the phase advances by `speed * dt / stride`, so feet roughly keep up with the ground at any speed. If
  feet seem to slide forward, the stride is too long for the leg; if they shuffle, too short.
- **Gait from speed**: each leg's phase offset is a share of the cycle, blended from a four-beat walk to a diagonal trot as speed rises. A
  biped is two legs half a cycle apart; a spider or a centipede is more offsets along the body; a hopping creature uses one offset for all legs.
- **Ease, do not snap**: the swing amount follows "moving or not" smoothly, so stopping finishes the step instead of freezing mid-air.
- **Breathing and idle**: fade in as movement fades out, so the creature never stands perfectly still.
- **Secondary motion on springs**: a part that lags and overshoots a little reads as soft and attached. Damping near `2 * sqrt(stiffness)`
  settles without overshoot; lower bounces more.
- **Squash and stretch**: the falling speed before touchdown kicks a spring; the torso shortens and widens, keeping its volume roughly the
  same, then springs back. Use the same kick for hits or a jump take-off.
- **Counter-motion**: the head counters the body's rock so the gaze stays level; the tail tip trails the tail base. Small offsets like these
  carry more life than larger amplitudes.

How to judge it: watch the motion at the game's camera against the character's size: do feet slide or shuffle, does stopping finish the step,
do ears and tail settle without jitter? Values are a starting point to tune by eye, not targets.

## Plain three.js
- Pivots: a [Group](https://threejs.org/docs/#api/en/objects/Group) at every joint (hip, shoulder, ear base, tail base) with the mesh hung
  from it; animate `rotation`, `position`, `scale` ([Object3D](https://threejs.org/docs/#api/en/core/Object3D)). A part rotates about its
  pivot, so put the pivot where the joint is.
- Springs and phases: a few lines per part in your frame loop, with `THREE.MathUtils.damp` / `lerp` ([MathUtils](https://threejs.org/docs/#api/en/math/MathUtils)).
- Authored clips instead: [AnimationMixer](https://threejs.org/docs/#api/en/animation/AnimationMixer) with clips from a glTF, blended by
  weight ([webgl_animation_skinning_blending](https://threejs.org/examples/#webgl_animation_skinning_blending)); procedural layers (head
  look, tail springs) can still be added on bones after the mixer updates.
- Skinned meshes: [SkinnedMesh](https://threejs.org/docs/#api/en/objects/SkinnedMesh) and `Bone`, with `CCDIKSolver` (addon) for feet on
  uneven ground.

## Style routes
- **Fully procedural (this example)**: code-built pivots, every motion from speed and state. No asset cost; best for boxy, toy-like or
  stylized creatures and many variants.
- **Authored clips**: keyframed or mocap clips through `AnimationMixer`. Most expressive and realistic; costs rigging and animation work.
- **Hybrid**: clips for the body, procedural springs for ears, tails, antennae, cloth tips, and a look-at for the head. A little code on top of clips.
- **Snappy / cartoon**: fewer in-between poses, bigger squash, stepped timing (hold each pose a few frames). Same code, other knobs.
- **Pixel / low-frame-rate look**: quantize the phase to a few steps per cycle so poses snap like sprite frames.

## The engine helper (optional convenience)
`threedog examples pull procedural-animation` copies the folder. `proceduralAnim.js` is the technique and imports nothing:
`createProceduralAnimator(parts, knobs)` returns an animator with `update(dt, { speed, state, grounded, vy })`; `spring(stiffness, damping)`
is the sub-stepped spring (a long frame stays stable). `creature.js` (`buildCreature`, imports `three`) is a neutral box quadruped that exists
only so there is something to move; `main.js` wires it to a player.
1. Build the body with a pivot (a `Group`) at every joint. Names do not matter to the animator, only the `parts` object you pass.
2. Give it to a character as a ready rig: `addPlayer({ ..., rig: { root, body: parts.body, limbs: [] } })` (`npcs.add` takes the same
   `rig`). `limbs: []` means the engine swings nothing itself (recipe 13 section 3b describes its own limb swing, for comparison).
3. Drive the animator from `character.onPose((ch, dt) => animator.update(dt, { speed: ch.moveAmount, state: ch.state, grounded: ch.grounded, vy: ch.vy }))`.
   For a prop or a creature that is not a character, call `update` from `engine.onFrame` with your own speed and state.
4. Your own states (`sit`, `sniff`, `climb`) come from the character's `states` hook and arrive in `ch.state`; pose them after `update`,
   as `main.js` does for `sit`.

All knobs are in `KNOBS` at the top of `proceduralAnim.js`; pass overrides to `createProceduralAnimator(parts, { ... })`. The defaults are a
starting point for a mid-sized box creature: cycle `stride`, `strideGrow`; gait `walkGait`, `trotGait`, `runSpeed`; easing `settle`;
idle `breathe`, `breatheRate`; springs `earStiffness`, `earDamping`, `tailStiffness`, ...; landing `squash`, `squashMax`.

Rules (correctness):
- **Visuals run per frame, gameplay per fixed step.** `update` belongs in `onPose` / `onFrame` with that frame's `dt`. It reads facts the fixed
  steps wrote (`moveAmount`, `state`, `grounded`, `vy`) and writes only the body's own parts. Never read a pose for gameplay (hit timing,
  footstep damage): frames drop and fast-forward runs frame hooks at a lower rate (`engine.step`).
- **Write absolute values from a remembered rest pose**, never `+=` per frame. `rest.bodyY` is read once; every frame sets
  `position.y = rest + offset`. Accumulating writes drift with frame rate; absolute ones return exactly to rest (the spec checks this).
- **Leave the character root alone.** The engine owns `ch.root` position and facing; the animator moves only parts under it.
- The engine's own rig code still bobs `rig.body` before `onPose` runs; writing `body.position.y` and `rotation.x` in `onPose` replaces that.

Verify: `threedog test "procedural animation"` (tests/specs/procedural-animation.mjs): legs swing while moving and cycle faster at a higher
speed, they return to rest at idle, the body returns to its rest height, the character does not creep, and the `states` hook's `sit` reaches the pose.

Sources: written for this example; no code copied. Background: distance-driven gait cycles, springs for secondary motion and squash and
stretch are common practice (David Rosen, "An Indie Approach to Procedural Animation", GDC 2014; the squash-and-stretch principle from
Thomas and Johnston, *The Illusion of Life*, 1981).

This example is written in GLSL: it is the WebGL route (`threedog new-game --webgl`). A game on the default WebGPU route writes the same ideas in TSL (recipe 56).
