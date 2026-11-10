// Weather, the state half (type 'world', engine.weather): the game's table of weather types (weather({ types })); without one only a calm 'clear' (the engine assumes no climate).
// Seven temperate ones are an opt-in preset: weather(presets.weather.temperate), extend with types: { ...presets.weather.temperate.types, dust: {...} }.
// All fields blend smoothly on change.
// Affects: cloud shadows, sky color, wind (plants sway), rain/snow particles, lightning, ambience; light and fog are the game's, which reads uWeatherLight / uWeatherFog.
// Particle and lightning pictures: weather({ rain, snow, lightning }), engine.weather.defineField(field, spec), engine.weather.particles (particles.js, recipes/44).
// weather() installs two modules: this state (current / target / progress, auto weather, lightning timing, events, save) and the drawing half
// (weatherDraw.js: particles, sky effects, thunder). Why split: the state is game data that saves and skips; the picture only reads it,
// so a game can swap the picture without touching the weather a save restores.
//
// engine.weather.set('rain', { seconds: 20 })   // turn to rain over 20 seconds
// engine.weather.auto = true     // change weather at random (uses engine.random, so step/tests are reproducible and saved)
// Weather display names live in the string table as weather.<name> (describe and the debug panel use them); a game that adds a new weather adds its name with
// i18n.add.
import * as THREE from 'three';
import { warnMissing, fmt } from '../../core/base/validate.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { STRINGS, ERR } from './strings.js';
import { codedError } from '../../core/base/errorHints.js';
import { STEP } from '../../core/time/time.js';
import { resetSignals } from '../../render/effects.js';
import { weatherDrawModule } from './weatherDraw.js';
import { isPlainObject } from '../../core/base/util.js';
import { saveNumberOk, saveValues, SAVE_MAX_SECONDS } from '../../core/base/saveValues.js';
/** @import { ModuleDef } from '../../types/core' */
/** @import { WeatherName, WeatherPreset, WeatherOptions, WeatherParticles, WeatherParticleSystem } from '../../types/world' */

// The table when the game gives none: one calm type, so engine.weather works without assuming rain, snow or storms exist
const ONLY_CLEAR = { clear: {} };
const OPTIONS = ['start', 'auto', 'particles', 'types', 'autoPool', 'autoInterval', 'transition', 'area', 'lightningFirst', 'lightningInterval', 'lightning', 'lightningBrightness', 'overcastColor', 'rain', 'snow'];
const SET_PARAMS = keysSchema(['seconds']);
const WEATHER_PARAMS = keysSchema(OPTIONS);
// Fields a type leaves out: calm (no cloud, rain, snow, grey or lightning; normal sun, fog and wind)
const CALM = { cloud: 0, sun: 1, fog: 1, wind: 1, rain: 0, snow: 0, grey: 0, lightning: 0 };
/** engine.weather */
export class Weather {
  /**
   * start: initial weather (default 'clear', or the table's first type); types: the game's weather table (default only a
   * calm 'clear'; seven temperate ones in presets.weather.temperate)
   * autoPool autoPool: candidates for automatic weather (repeat a name to make it likelier); autoInterval [min, max] seconds
   * lightningFirst: seconds to the first bolt once a stormy type holds (default 5); lightningInterval [min, max] seconds between later bolts (default [6, 20]).
   * Options, not constants: a game's storm rhythm (a bolt every few seconds in a horror level, rare far thunder in a calm one) is its own decision
   * @internal
   */
  constructor(engine, { start, types, autoPool, autoInterval = [90, 240], transition = 25, lightningFirst = 5, lightningInterval = [6, 20],
    lightning = f => f * (Math.random() > 0.3 ? 1 : 0.4), lightningBrightness = 1, overcastColor = 0x8c8c8c } = {}) {   // presentation: flash flickers
    /** @internal */ this.engine = engine;
    if (typeof lightning !== 'function') throw codedError('weather-option', 'weather({ lightning }) must be a function (flash 0..1, engine) => sky flash amount, e.g. lightning: f => f * 0.6; return 0 and draw your own bolt on the weather:lightning event');
    // The game's table is the whole list (a desert game has no snow, a space station no rain); without one only a calm 'clear'.
    if (types !== undefined && (!types || typeof types !== 'object' || !Object.keys(types).length)) throw codedError('weather-option', fmt(ERR.types, { got: String(JSON.stringify(types)) }));
    const table = types ?? ONLY_CLEAR;
    /**
     * The weather types this game has: name -> numbers (the standard fields plus any of the game's own, all blended on change) @type {Record<string,
     * WeatherPreset>}
     */
    this.types = {};
    for (const k of Object.keys(table)) {
      const v = { ...CALM, ...table[k] };
      for (const f in v) if (!Number.isFinite(v[f])) throw codedError('weather-option', fmt(ERR.field, { k, f, got: String(JSON.stringify(v[f])) }));
      this.types[k] = v;
    }
    // a game field one type has ('heat' on 'heatwave') is 0 on the others, so a change always blends between two numbers
    for (const v of Object.values(this.types)) for (const o of Object.values(this.types)) for (const f in o) v[f] ??= 0;
    start ??= this.types.clear ? 'clear' : Object.keys(this.types)[0];
    if (!this.types[start]) throw codedError('weather-option', fmt(ERR.start, { got: String(start), list: Object.keys(this.types).join(', ') }));
    /** Current (mid-transition) weather parameters @type {WeatherPreset} */
    this.current = { ...this.types[start] };
    /** @internal */ this.from = { ...this.current };
    /** @internal */ this.to = { ...this.current };
    /** @internal */ this.t = 1;
    /** @internal */ this.dur = 1;
    /** Current weather name @type {string} */
    this.name = start;
    /** @internal */ this._auto = false;
    /** @internal */ this.autoTimer = 0;
    /** Candidates for automatic weather (repeat a name to make it likelier) @type {string[]} @experimental */
    this.autoPool = [...(autoPool || Object.keys(this.types))];
    for (const k of this.autoPool) if (!this.types[k]) throw codedError('weather-option', fmt(ERR.pool, { got: String(k), list: Object.keys(this.types).join(', ') }));
    /** Automatic weather interval [min, max] seconds @type {number[]} @experimental */
    this.autoInterval = autoInterval;
    /** Transition seconds for automatic weather @type {number} @experimental */
    this.autoTransition = transition;
    /** Seconds to the first bolt (also after a load without a saved timer) @type {number} @experimental */
    this.lightningFirst = lightningFirst;
    /** [min, max] seconds between bolts while a type with lightning > 0.5 holds @type {number[]} @experimental */
    this.lightningInterval = lightningInterval;
    /** @internal seconds to the next lightning strike while a type with lightning > 0.5 holds */ this.nextBolt = lightningFirst;
    /** Strike picture: flash (1 at the strike, fading in a third of a second) -> sky flash amount. Write it at any time @type {(flash: number, engine: any) => number} @experimental */
    this.lightning = lightning;
    /** Multiplies the sky flash of every strike; write it at any time @type {number} */
    this.lightningBrightness = lightningBrightness;
    /** Color the sky turns as a weather type raises grey: a THREE.Color, overcastColor.set(0x667788) changes it live @type {THREE.Color} */
    this.overcastColor = new THREE.Color(overcastColor);
  }

  /**
   * The particle systems drawn now, by field: rain and snow when the table has them, plus what defineField() added. Each has material (the plain three.js
   * material: read it, or set your own, drawn as given; null gives the engine's back), uniforms ({ value } objects the engine writes each frame, a
   * ShaderMaterial of yours shares them; uColor, uLen, uPx, uMaxPx, uSwayAmp are yours to write), spec (opacity, speed, slant, density are read each
   * frame, plain writes), object (the three.js object). Empty when a game replaced the weather drawing
   * @example engine.weather.particles.rain.spec.speed = 30;
   * @example engine.weather.particles.rain.uniforms.uColor.value.set(0xa8b8d0);
   * @type {Record<string, WeatherParticleSystem>}
   */
  get particles() { return Object.fromEntries(this.engine.weatherDraw?.systems ?? []); }

  /**
   * Draw a field of the weather table with particles: your own (ash, petals, sparks) or rain / snow in place of the built-in ones. The amount each
   * frame is weather.current[field], so they fade with the weather. spec takes the keys of weather({ rain }), or
   * { create(engine, { area, count }) => { object, update?(amount, { camera, time, wind }) } } for a system of your own; null gives rain / snow back
   * to weather({ rain, snow }) and removes any other field. Defining a field again replaces it. A field no type has throws with the table's fields
   * @example engine.weather.defineField('ash', { shape: 'soft', color: 0x555555, size: 14, speed: 0.8, sway: 3 });
   * @param {string} field
   * @param {WeatherParticles | null} spec
   * @returns {WeatherParticleSystem | null}
   */
  defineField(field, spec) {
    const drawPart = this.engine.weatherDraw;
    if (!drawPart) throw codedError('weather-option', "weather.defineField(): the weather is drawn by a game module (replaces: 'weatherDraw'); draw this field there, reading engine.weather.current");
    return drawPart.defineField(field, spec);
  }

  /**
   * Automatic weather on/off.
   * @type {boolean}
   */
  get auto() { return this._auto; }
  set auto(on) { this._auto = on; if (on) this.autoTimer = 0; }

  /**
   * Switch weather. seconds: transition seconds, default 15; 0 switches at once (current is the new weather before the next step, so a
   * screenshot or test right after shows all of it). Options in an object like every other engine call: set('rain', 20) throws
   * [module-params] in dev (the old positional form)
   * @param {WeatherName} name
   * @param {{ seconds?: number }} [opts]
   * @returns {void}
   * @example engine.weather.set('rain', { seconds: 20 })
   * @example engine.weather.set('storm', { seconds: 0 })   // at once
   */
  set(name, opts) {
    const { seconds = 15 } = readParams('weather.set()', SET_PARAMS, opts);
    const p = this.types[name];
    if (!p) { warnMissing('weather', name, Object.keys(this.types)); return; }
    const from = this.name;
    if (!(seconds >= 0 && Number.isFinite(seconds))) throw codedError('weather-option', `weather.set('${name}', { seconds }) takes seconds >= 0 (0 = at once); got ${seconds}`);
    this.name = name; this.from = { ...this.current }; this.to = { ...p }; this.t = 0; this.dur = Math.max(seconds, 0.01);   // the least a load accepts: a blend divides by it, and the save must read the same after a load
    // seconds 0: land now, not on the next fixed step (a shot or test right after the call saw the old weather, or 1/3 of a short blend)
    if (seconds === 0) { this.t = 1; for (const key in this.to) this.current[key] = this.to[key]; }
    // once per change of name (the blend then runs over `seconds`); setting the same weather again is not a change
    if (from !== name) this.engine.events.emit('weather:change', { from, to: name });
  }
  /**
   * Display name of a weather (string table weather.<name>, falls back to the name itself); defaults to the current weather
   * @param {string} [name]
   * @returns {string}
   */
  label(name = this.name) { const k = 'weather.' + name; return this.engine.i18n.has(k) ? this.engine.t(k) : name; }

  // fixed step: transitions, automatic weather, lightning timing (gameplay-relevant randomness all uses engine.random); the flash is the drawing half's
  /**
   * Advance weather transition, automatic weather and lightning (the module calls this itself every fixed step)
   * @param {number} dt
   * @param {boolean} [quiet] true during engine.skip: same state changes, no lightning event (nobody saw it)
   * @returns {void}
   * @internal
   */
  tick(dt, quiet = false) {
    const rnd = this.engine.random;
    if (this.t < 1) {
      this.t = Math.min(1, this.t + dt / this.dur);
      const k = this.t * this.t * (3 - 2 * this.t);
      // a finished blend lands on `to` exactly: from + (to - from) * 1 is off by a rounding error that depends on where the blend started, so a load
      // or session.newGame (set(name, { seconds: 0.01 }) from whatever the last playthrough left) would not give the same weather twice
      for (const key in this.to) this.current[key] = this.t >= 1 ? this.to[key] : this.from[key] + (this.to[key] - this.from[key]) * k;
    }
    if (this.auto) {
      this.autoTimer -= dt;
      if (this.autoTimer <= 0) {
        this.autoTimer = rnd.range(this.autoInterval[0], this.autoInterval[1]);
        this.set(rnd.pick(this.autoPool), { seconds: this.autoTransition });
      }
    }
    if (this.current.lightning > 0.5) {
      this.nextBolt -= dt;
      if (this.nextBolt <= 0) { this.nextBolt = rnd.range(this.lightningInterval[0], this.lightningInterval[1]); if (!quiet) this.engine.events.emit('weather:lightning'); }
    }
  }

}

const WEATHER_SIGNALS = ['uWeatherCloud', 'uWind', 'uRain', 'uSnow', 'uWeatherLight', 'uWeatherFog'];   // the shared signals the state writes each frame (handed back on dispose)

/**
 * Weather: two modules for one engine.use: the state (engine.weather, type 'world') and its picture (engine.weatherDraw, type 'picture'; sky optional)
 * @param {WeatherOptions} [opts]
 * @returns {[ModuleDef<Weather>, ModuleDef<import('./weatherDraw.js').WeatherDraw>]}
 * @example engine.use(sky(), weather({ types: presets.weather.temperate.types, start: 'clear' }))
 */
export function weather(opts = {}) {
  readParams('weather', WEATHER_PARAMS, opts);
  let w = null;
  const state = {
    name: 'weather', skipKind: 'step', type: 'world', provides: ['weather'], label: 'Weather', params: WEATHER_PARAMS, options: opts, stage: 'environment', before: ['sky'],
    install(e, ctx) {
      e.i18n.add(STRINGS);
      w = new Weather(e, opts);
      if (opts.auto) w.auto = true;
      // the transition is saved too (current / from / to / t / dur): a save made 30% into sun -> rain loads 30% in, not as full rain, and fires no
      // weather:change (nothing changed for the player). A damaged part, or a weather the game no longer has, loads as a finished switch to that name
      ctx.saves.define('weather', { notAtomic: 'moves on its own timers like the calendar: an op that sets it means it to stay',
        save: () => ({ name: w.name, auto: w.auto, autoTimer: w.autoTimer, nextBolt: w.nextBolt, current: { ...w.current }, from: { ...w.from }, to: { ...w.to }, t: w.t, dur: w.dur }),
        load: d => {
          if (!d) return;
          const s = saveValues('weather'), most = { min: 0, max: SAVE_MAX_SECONDS };
          const fields = v => isPlainObject(v) && Object.values(v).every(saveNumberOk);   // every blended field is a finite number: one NaN would spread to the sky, fog and sound
          if (Number.isFinite(d.t) && fields(d.current) && fields(d.from) && fields(d.to) && w.types[d.name]) {
            // over the type's own fields: a save older than a field the table has now would blend it from undefined (NaN)
            const full = v => ({ ...w.types[d.name], ...v });
            w.name = d.name; w.current = full(d.current); w.from = full(d.from); w.to = full(d.to); w.t = s.num(d.t, 't', { min: 0, max: 1, fallback: 1 }); w.dur = s.num(d.dur ?? 1, 'dur', { ...most, min: 0.01, fallback: 1 });
          } else w.set(d.name, { seconds: 0 });
          w.auto = d.auto === true; w.autoTimer = s.num(d.autoTimer ?? 0, 'autoTimer', { ...most, fallback: 0 }); w.nextBolt = s.num(d.nextBolt ?? w.lightningFirst, 'nextBolt', { ...most, fallback: w.lightningFirst });
          s.done();
        } });
      return w;
    },
    fixed(dt) { w.tick(dt); },
    // removed: the signals written below go back to clear weather, not the last storm's values
    dispose(e) { resetSignals(e, WEATHER_SIGNALS); },
    // the weather as signals (engine.uniforms) every frame, from the state and not its picture: a game that draws its own rain still reads them
    frame(_dt, e) { const U = e.uniforms, c = w.current; U.uWeatherCloud.value = c.cloud; U.uWind.value = c.wind; U.uRain.value = c.rain; U.uSnow.value = c.snow; U.uWeatherLight.value = c.sun; U.uWeatherFog.value = c.fog; },
    // engine.skip: fixed hooks do not run, so the skipped fixed steps are replayed here without events (a bolt nobody saw)
    skip(dt) {   // replay the fixed steps (same random draws, same order as stepping, so checkSkip matches); nothing pending = nothing to replay
      if (w.t >= 1 && !w.auto && !(w.current.lightning > 0.5)) return;
      for (let n = Math.round(dt / STEP); n > 0; n--) w.tick(STEP, true);
    },
    // scenario param weather: switch to this weather at once (no transition) and turn off automatic weather, so the scene is reproducible
    stateKeys: ['weather'],
    applyState(e, { weather: name }) {
      if (!name) return;
      w.set(name, { seconds: 0 });   // an unknown name warns and changes nothing, so the name is read back
      if (w.name !== name) return { refused: { weather: `no weather named "${name}"; this game has ${Object.keys(w.types).join(', ')} (types in weather({ types }), e.g. presets.weather.temperate)` } };
      w.auto = false;
    },
    describe() {
      const c = w.current, r = v => Math.round(v * 100) / 100;
      return { name: w.name, label: w.label(), progress: r(w.t), auto: w.auto, rain: r(c.rain), snow: r(c.snow), fog: r(c.fog), wind: r(c.wind),
        cloud: r(c.cloud), lightning: r(c.lightning) };
    },
  };
  return [state, weatherDrawModule(Object.fromEntries(['particles', 'area', 'rain', 'snow'].filter(k => opts[k] !== undefined).map(k => [k, opts[k]])))];
}

export const handRolled = 'none: weather by hand is plain values with no one shape';
