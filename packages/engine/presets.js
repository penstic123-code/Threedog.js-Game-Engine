// Opt-in gameplay presets: named, plain option objects a game picks on purpose, like a style for feel.
// The engine never applies one by itself (weather() alone has only 'clear', sky() has no seasons and no day cycle, music() does not duck for dialogue, no module binds a gameplay key, addPlayer() and interactions() refuse to guess a feel
// or a key); a preset only bundles options the game could write itself, so spreading it and overriding a field is always the same as writing it out:
//   engine.use(weather({ ...presets.weather.temperate, autoPool: ['clear', 'rain'] }));
//   engine.characters.addPlayer({ ...presets.player.lockOn, faceTarget: boss });
//   engine.use(interactions({ ...presets.interactions.nearest, radius: 3 }));
// No imports and no engine state: plain data plus small control functions that call public API only.

/** A side-scroller moves only along world X (left / right keys); W / S do nothing. Reads input by action like the 'camera' control */
function sideScroll(p, input) { return { x: (input.autopilot || input.axis).x, z: 0, run: input.actions.has('run') && input.down('run') }; }

// Presets carry no keys: keys live in presets.bindings only, so no module option binds a key and one table answers "what is pressed"
const walk = (control, faceMode) => Object.freeze({ control, faceMode, cameraFollow: true });
const use = pick => Object.freeze({ pick });
const keys = (...k) => Object.freeze(k);

/**
 * Opt-in presets, grouped by the option they fill. Each value is an options object for the function named in its group.
 * @example engine.use(openWorld({ weather: presets.weather.temperate, calendar: presets.calendar.fourSeasons }))
 * @example engine.use(followCamera(presets.camera.overShoulder)); engine.characters.addPlayer({ ...presets.player.aim, spawn })
 * @example engine.use(interactions({ ...presets.interactions.nearest }))
 */
export const presets = Object.freeze({
  /** weather({ ... }) options */
  weather: Object.freeze({
    /** Seven temperate weathers (clear cloudy overcast rain storm snow fog) and an automatic-weather pool weighted toward clear */
    temperate: Object.freeze({
      types: Object.freeze({
        clear:  { cloud: 0.15, sun: 1.0, fog: 1.0, wind: 0.8, rain: 0, snow: 0, grey: 0.0, lightning: 0 },
        cloudy: { cloud: 0.45, sun: 0.85, fog: 0.9, wind: 1.1, rain: 0, snow: 0, grey: 0.15, lightning: 0 },
        overcast: { cloud: 0.85, sun: 0.45, fog: 0.75, wind: 1.3, rain: 0, snow: 0, grey: 0.45, lightning: 0 },
        rain:   { cloud: 0.9, sun: 0.35, fog: 0.6, wind: 1.6, rain: 0.6, snow: 0, grey: 0.55, lightning: 0 },
        storm:  { cloud: 1.0, sun: 0.2, fog: 0.45, wind: 2.6, rain: 1.0, snow: 0, grey: 0.7, lightning: 1 },
        snow:   { cloud: 0.85, sun: 0.5, fog: 0.55, wind: 0.9, rain: 0, snow: 1.0, grey: 0.5, lightning: 0 },
        fog:    { cloud: 0.6, sun: 0.55, fog: 0.25, wind: 0.4, rain: 0, snow: 0, grey: 0.5, lightning: 0 },
      }),
      autoPool: Object.freeze(['clear', 'clear', 'clear', 'cloudy', 'cloudy', 'overcast', 'rain', 'storm', 'fog']),
    }),
  }),
  /** calendar({ ... }) options */
  calendar: Object.freeze({
    /** Spring, summer, autumn, winter, 7 days each, with the 360 s day cycle of `cycle` (a cozy life sim; set daysPerSeason: 28 for longer seasons) */
    fourSeasons: Object.freeze({ seasons: Object.freeze(['spring', 'summer', 'autumn', 'winter']), daysPerSeason: 7, dayLength: 360 }),
    /** A day-night cycle, one day = 360 calendar seconds (6 minutes at clock.rate 1); calendar() alone keeps a fixed time of day */
    cycle: Object.freeze({ dayLength: 360 }),
    /** One time of day that never moves (dungeon, arena, space station), what calendar() does without a dayLength; pick the hour with time */
    fixedTime: Object.freeze({ dayLength: Infinity }),
  }),
  /** characters.addPlayer({ ... }) movement, facing and camera follow (addPlayer has no default: pick one of these or write the options; keys: presets.bindings.walk) */
  player: Object.freeze({
    /** Keys relative to the camera, turn toward the move direction, camera follows (adventure, life sim) */
    thirdPerson: walk('camera', 'move'),
    /** Keys relative to the camera while facing faceTarget: strafe around a locked-on enemy (soulslike); set faceTarget */
    lockOn: walk('camera', 'target'),
    /** Keys relative to the camera while facing where the camera looks (over-the-shoulder shooter) */
    aim: walk('camera', 'camera'),
    /** Left / right only along world X, turn toward the move direction (2.5D side-scroller; pair with a side-on camera) */
    sideScroller: walk(sideScroll, 'move'),
  }),
  /** interactions({ ... }) selection (interactions has no default pick: pick one of these or write { pick }; keys: presets.bindings.interact) */
  interactions: Object.freeze({
    /** Uses the nearest one in reach (top-down, third person, life sim) */
    nearest: use('nearest'),
    /** Uses only what the actor faces, within 60° (soulslike: the door behind you stays dark) */
    facing: use('facing'),
    /** Uses the one closest to the screen-center ray (first person, shooters) */
    aim: use('aim'),
  }),
  /**
   * Key maps for the actions modules declare (modules never bind a key; the basics WASD / confirm / cancel / UI cursor are the only default).
   * Bind with createEngine({ bindings: { ...presets.bindings.walk, ...presets.bindings.interact } }) or engine.input.bind(presets.bindings.rtsRotate);
   * an action bound to [] has deliberately no key.
   */
  bindings: Object.freeze({
    /** characters.addPlayer(): Shift / gamepad LB runs, Space / gamepad A jumps */
    walk: Object.freeze({ run: keys('ShiftLeft', 'ShiftRight', 'PadLB'), jump: keys('Space', 'PadA') }),
    /** interactions(): E / gamepad X uses the picked one */
    interact: Object.freeze({ interact: keys('KeyE', 'PadX') }),
    /** inventory(): I / gamepad Y opens the bag */
    inventory: Object.freeze({ inventory: keys('KeyI', 'PadY') }),
    /** quests(): J / gamepad Select opens the quest log */
    quests: Object.freeze({ quests: keys('KeyJ', 'PadSelect') }),
    /** photo(): P / gamepad RB takes a photo */
    photo: Object.freeze({ photo: keys('KeyP', 'PadRB') }),
    /** grids.preview(): R turns the placement preview (action 'rotate') */
    gridRotate: Object.freeze({ rotate: keys('KeyR') }),
    /** characters(): B / gamepad LT brakes while driving */
    brake: Object.freeze({ brake: keys('KeyB', 'PadLT') }),
    /** dialogue(): 1-9 (and the numpad) pick choices 1-9 while a conversation is open (context 'dialog', so 1-9 stay free for hotbars) */
    dialogNumbers: Object.freeze(Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['choice' + (i + 1), Object.freeze(['Digit' + (i + 1), 'Numpad' + (i + 1)])]))),
    /** rtsCamera(): Q / R turn the view */
    rtsRotate: Object.freeze({ rotateLeft: Object.freeze(['KeyQ']), rotateRight: Object.freeze(['KeyR']) }),
    /** timeline(): Backspace skips a cutscene too (cancel / Esc always does) */
    cutsceneSkip: Object.freeze({ skip: Object.freeze(['Backspace']) }),
    /** debugPanel() / triggers(): F3 shows / hides the debug panel, F4 the trigger-zone wireframes */
    debug: Object.freeze({ debugPanel: Object.freeze(['F3']), triggersDebug: Object.freeze(['F4']) }),
  }),
  /** followCamera({ ... }) options */
  camera: Object.freeze({
    /** Far, slow orbit for open landscapes (the follow camera's own defaults) */
    follow: Object.freeze({}),
    /** Close over-the-shoulder view with a locked mouse (third-person shooter, soulslike): look up to about +60° and down, the ground shortens the arm */
    overShoulder: Object.freeze({ distance: 3, shoulder: 0.7, pitch: 0.15, minPitch: -1.05, maxPitch: 1.2, groundClearance: 0.3, hideTargetNear: 0.9, pointerLock: true }),
    /** Third-person action: locked mouse, look up to about +60° and down, the ground shortens the arm (look direction kept), walls pull it in, the player hides when the camera is inside it */
    thirdPersonAction: Object.freeze({ distance: 4.5, minDistance: 1.5, maxDistance: 9, height: 1.6, shoulder: 0.5, pitch: 0.25, minPitch: -1.05, maxPitch: 1.2,
      ground: 'shorten', groundClearance: 0.3, hideTargetNear: 0.9, pointerLock: true }),
  }),
});
