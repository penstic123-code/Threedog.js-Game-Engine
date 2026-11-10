// The drawing half of weather() (type 'picture', engine.weatherDraw): what the current weather looks and sounds like. It only reads engine.weather
// (the state half, Weather.js) and never changes it, so a game can replace this half (engine.use(myRain(), { replaces: 'weatherDraw' })) and keep the
// weather table, its save and its events.
//   shared points: sky tint, lightning flash, snow cover
//   rain / snow particles that follow the camera (particles.js), thunder, audio rule conditions
import { builtInSounds } from '../../core/assets/assetManifest.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { isOptions } from '../../core/base/util.js';
import { codedError } from '../../core/base/errorHints.js';
import { onRendererSwap } from '../../render/backend.js';
import { onTierChange } from '../../core/scene/tier.js';
import { makeSystem, updateSystem, dropSystem, RAIN, SNOW } from './particles.js';

const DRAW_PARAMS = keysSchema(['particles', 'area', 'rain', 'snow']);   // the picture options of weather(): the rest are the state's
const BASE = { rain: RAIN, snow: SNOW };

/** engine.weatherDraw: particles and picture effects of the current weather @experimental */
export class WeatherDraw {
  /**
   * @internal
   * @param {any} engine
   * @param {{ particles?: number, area?: number, rain?: any, snow?: any }} [opts]
   */
  constructor(engine, { particles, area = 40, rain = {}, snow = {} } = {}) {
    /** @internal */ this.engine = engine;
    /** Sky flash now, 1 at a strike (the weather:lightning event) fading to 0 @type {number} */
    this.flash = 0;
    // the weather's entries on the shared sky points: taken once through ctx.mod (owned by this module, gone with it) and rewritten every frame with
    // handle.change (core/ops/sharedPoint.js), so a frame adds no entry and no cleanup handle. ctx is set by the module's install
    /** @internal */ this._ctx = null; /** @internal */ this._h = {};
    /** @internal */ this._tint = { color: null, amount: 0, horizon: 0 };
    /** Default particle count per system: weather({ particles }), else 6000 (3000 on low-tier devices) @type {number} */
    this.particles = particles ?? this._tierCount();
    /** @internal the game gave no count: the default follows the tier (follow(), below) */ this._countFollows = particles == null;
    /** @internal */ this.area = area;
    /** Particle systems drawn now: field -> { field, object, material, uniforms, spec } (rain / snow when the table has them, plus fields engine.weather.defineField adds) @type {Map<string, any>} */
    this.systems = new Map();
    // zero cost when unused: a table where nothing ever rains or snows builds no particle meshes
    const { cover, ...snowGiven } = snow;
    /** @internal what weather({ rain, snow }) gave: defineField(field, null) goes back to it */ this._given = { rain, snow: snowGiven };
    for (const k of Object.keys(BASE)) if (this._used(k)) this._build(k, this._given[k], BASE[k]);
    // snow cover: foliage / ground season tint moves toward the snow colors as current.snow rises (ground.cover)
    if (cover !== undefined) {
      if (isOptions(cover)) readParams('weather({ snow: { cover } })', keysSchema(['foliage', 'ground', 'strength']), cover);
      if (cover.foliage == null && cover.ground == null) throw codedError('weather-option', "weather({ snow: { cover } }) needs a color for foliage and / or ground, e.g. cover: { foliage: 0xf2f4f6, ground: 0xeef0f2, strength: 0.8 }");
      /** @internal */ this._cover = { strength: cover.strength ?? 0.8 };
      /** @internal */ this._coverMod = { foliage: cover.foliage ?? null, ground: cover.ground ?? null, amount: 0 };
    }
  }

  /** @internal the default count for the tier */
  _tierCount() { return this.engine.tier === 'low' ? 3000 : 6000; }
  /** @internal the tier changed (a stored preset arrives after install): a default count follows it, by building the systems again like a renderer swap does; a count the game gave stays */
  _tierChanged() {
    const n = this._tierCount();
    if (!this._countFollows || n === this.particles) return;
    this.particles = n;
    this._rebuild();
  }

  /** @internal the weather table (state half) */
  get types() { return this.state.types; }
  /** @internal the state half, read only and read live: a replaced weather module must not leave the picture on the old one */
  get state() { return this.engine.weather; }
  /** @internal does any type have this field above 0 */
  _used(field) { return Object.values(this.types).some(v => v[field] > 0); }

  /** @internal engine.weather.defineField */
  defineField(field, spec) {
    const fields = [...new Set(Object.values(this.types).flatMap(t => Object.keys(t)))];
    if (!fields.includes(field)) throw codedError('weather-option', `weather.defineField('${field}'): no weather type has this field; add it to a type in weather({ types }) (e.g. ashfall: { ${field}: 1 }), or use one of ${fields.join(', ')}`);
    if (spec !== null && (typeof spec !== 'object' || Array.isArray(spec))) throw codedError('weather-option', `weather.defineField('${field}', spec): spec is an object, e.g. { shape: 'soft', color: 0x555555 } or { create }, or null to give the field back; see recipes/44-water-weather-hooks.md §"Particles of the game's own weather"`);
    if (spec) return this._build(field, spec, BASE[field]);
    if (BASE[field] && this._used(field)) return this._build(field, this._given[field], BASE[field]);
    const s = this.systems.get(field);
    if (s) { dropSystem(this.engine, s); this.systems.delete(field); }
    return null;
  }

  /** @internal */
  _build(field, spec, base) {
    const sys = makeSystem(this.engine, field, spec, { area: this.area, count: this.particles, base });   // first: a bad spec throws with the old system still drawn
    const old = this.systems.get(field);
    if (old) dropSystem(this.engine, old);
    sys.base = base;   // the renderer swap builds it again over the same defaults
    this.systems.set(field, sys);
    return sys;
  }

  /**
   * @internal build the systems again (fallback 'webgl', or a tier change that moves the default count): systems built before start() carry WebGPURenderer node materials; rebuild them for the renderer in use, keeping what
   * the game wrote since (spec numbers, uniforms, its material). A defineField() create(engine) object is the game's own and stays (the scene check names it
   * if WebGL cannot draw it).
   */
  _rebuild() {
    for (const [f, sys] of [...this.systems]) {
      if (sys.own) continue;
      const given = sys.given;
      const next = this._build(f, sys.spec, sys.base);
      // only what the game gave: a value the old slot owns (particles.tsl.js mapSlot's white stand-in, `.own`) is freed with the old material
      for (const k in sys.uniforms) if (next.uniforms[k] && !sys.uniforms[k].own) next.uniforms[k].value = sys.uniforms[k].value;
      if (given) next.material = given;
    }
  }

  /**
   * Write the current weather into its signals and shared sky points and move rain / snow with the camera (the module calls this every frame)
   * @param {any} camera
   * @param {number} [dt] real seconds since the last frame (the flash fades with it)
   * @returns {void}
   * @internal
   */
  apply(camera, dt = 0) {
    const c = this.state.current, e = this.engine, T = this._tint;
    T.color = this.state.overcastColor;
    const t = e.time.now('real');
    this.flash = Math.max(0, this.flash - dt * 3);
    T.amount = c.grey; T.horizon = c.grey * 0.8; this._put('sky.tint', 'value', T);
    this._put('sky.flash', 'add', this.flash > 0 ? this.state.lightning(this.flash, e) * this.state.lightningBrightness : 0);
    if (this._cover) { this._coverMod.amount = (c.snow ?? 0) * this._cover.strength; this._put('ground.cover', 'value', this._coverMod); }
    for (const sys of this.systems.values()) updateSystem(sys, c[sys.field] ?? 0, camera, t, c.wind);
  }
  /** @internal one contribution to a shared point: taken on first use, then changed in place */
  _put(point, op, v) {
    // change() is false when the entry is gone (a point cleared on a new session): take it again, as the old per-frame take did anyway
    if (this._h[point]?.change(v)) return;
    // no sky module: the point does not exist and nothing reads it; a game's own sky reads weather.current.grey and weatherDraw.flash, or defines the point itself
    if (!this.engine.stacks.has(point)) return;
    const o = op === 'value' ? { value: v } : { [op]: v, layer: 'effect' };   // tint / cover are data points (value), the flash an effect-layer number
    this._h[point] = this._ctx ? this._ctx.mod(point, o) : this.engine.mod(point, { ...o, owner: 'weatherDraw' });
  }
}

/**
 * @internal the drawing half of weather(opts) (weather() returns both; install them together)
 * @param {{ particles?: number, area?: number, rain?: any, snow?: any }} opts
 */
export function weatherDrawModule(opts) {
  readParams('weather (drawing half)', DRAW_PARAMS, opts);
  let L = null;
  return {
    name: 'weatherDraw', skipKind: 'none', type: 'picture', provides: ['weatherDraw'], label: 'Weather drawing', params: DRAW_PARAMS, options: opts, requires: ['weather'], optional: ['sky'], stage: 'environment', before: ['sky'], after: ['weather'],
    install(e, ctx) { e.i18n.add({ 'zh-CN': { 'module.weatherDraw': '天气外观' }, en: { 'module.weatherDraw': 'weather drawing' } });
      L = new WeatherDraw(e, opts);
      L._ctx = ctx;   // the weather's entries on the shared points go with this module (ctx.mod)
      ctx.track(onRendererSwap(e, () => L._rebuild()));
      ctx.track(onTierChange(e, () => L._tierChanged()));   // the default particle count follows the tier
      ctx.track(e.audio.condition('weather', v => [].concat(v).includes(e.weather.name)));   // audio rule condition { weather: 'rain' | ['rain', 'storm'] }
      for (const k of ['rain', 'snow', 'wind']) ctx.track(e.audio.measure(k, () => e.weather.current[k]));   // data rules: { rain: { lt: 0.2 } }, volume add: { rain: 0.22 }
      builtInSounds(e.assets, { thunder: (audio, p, out) => { const dur = p.duration ?? 3.5, delay = 0.4 + Math.random() * 1.5;   // presentation: thunder delay
        audio.noiseBurst({ type: 'lowpass', freq: p.freq ?? 140, vol: p.volume ?? 0.9, dur, rate: 0.4 * p.pitch, delay, out }); return delay + dur; } },
      { bus: 'ambience' });   // sound asset 'thunder', silent until audio.sounds names it
      ctx.track(e.events.on('weather:lightning', () => { L.flash = 1; e.audio.sfx('thunder'); }));
      return L;
    },
    frame(dt, e) { L.apply(e.camera, dt); },
    dispose(e) { for (const s of L.systems.values()) dropSystem(e, s); L.systems.clear(); },
    describe: () => ({ rainVisible: !!L.systems.get('rain')?.object.visible, snowVisible: !!L.systems.get('snow')?.object.visible, flash: Math.round(L.flash * 100) / 100 }),
  };
}
