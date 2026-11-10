// The sky() module definition (split out of Sky.js): install, per-frame update, the fixed scenario time, describe. Time, day, seasons, their
// timers and saves are the calendar's (modules/calendar); the sky reads engine.calendar each frame to draw.
// Usage and the engine.sky API are documented in Sky.js.
import { Sky } from './Sky.js';
import { resetSignals } from '../../render/effects.js';
import { dropOwned } from '../../core/ops/owned.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { parseClock } from '../../core/time/dayTime.js';
import { coded } from '../../core/base/errorHints.js';
import { warnOnce } from '../../core/base/validate.js';
/** @import { ModuleDef } from '../../types/core' */
/** @import { SkyOptions } from '../../types/world' */

// Options sky() accepts: the time drawn without a calendar, and the dome's
// start values. After install the numbers are engine.uniforms values (shader.js), the rest plain fields or calls on engine.sky
const SKY_OPTIONS = ['time', 'clouds', 'backdrop', 'keyframes', 'sunSize', 'sunGlow', 'sunBrightness', 'moonColor', 'moonBrightness',
  'starDensity', 'dim'];
const SKY_PARAMS = keysSchema(SKY_OPTIONS);   // keys only: the values take several shapes (time: 'HH:MM' | 0-1), Sky checks them
// Signals the sky rewrites every frame: handed back to neutral on removal. The rest go back only if this sky last wrote them and nobody took them since:
// the season / cover tint when it was painted (_seasoned / _covered: a game may write the tint itself), the sun direction when the engine still owns it (_oSun)
const SKY_SIGNALS = ['uSunColor', 'uSkyTop', 'uSkyHorizon', 'uGroundCover'];
const TINT_SIGNALS = ['uFoliageTint', 'uGroundTint', 'uFoliageMix', 'uGroundMix'];
const STRINGS = {
  timeTwice: 'calendar owns the time of day while it is installed, so sky({ time }) is unused. Move the starting time to calendar({ time }) and remove sky({ time })',
  noSeason: "applyState({ season }): seasons are the calendar's; install calendar({ seasons: [...] }) (sky alone draws one fixed time)",
};

/**
 * Sky dome and the sun / daylight / sky-color signals, from the time of day (engine.calendar; without one a fixed time) -> engine.sky
 * @param {SkyOptions} [opts]
 * @returns {ModuleDef<Sky>}
 */
export function sky(opts = {}) {
  readParams('sky', SKY_PARAMS, opts);
  let s = null, own = () => {};
  return {
    name: 'sky', skipKind: 'none', type: 'picture', label: 'Sky', params: SKY_PARAMS, options: opts, stage: 'environment',
    // the one sky: a game's own sky module takes over with engine.use(mySky(), { replaces: 'sky' }) (this one unloads with its picture changes)
    provides: ['sky'],
    // weather: only its name for the picture context; calendar: the time drawn (without it one fixed time, sky({ time }))
    optional: ['weather', 'calendar'],
    install(e, ctx) { e.i18n.add({ 'zh-CN': { 'module.sky': '天空' }, en: { 'module.sky': 'sky' } });
      // a time given while a calendar draws sits unused: say so, the game still runs and the calendar's time is drawn
      if (opts.time != null && e.calendar) warnOnce(coded('time-owner-conflict', STRINGS.timeTwice), 'sky-time-calendar');
      s = new Sky(e, opts);
      // without a calendar the drawn sun tells day from night (night glow reads the measure); a calendar installed later registers its own over it
      const measures = [['daylight', () => s.daylight], ['timeOfDay', () => s.drawnTime]];
      own = () => { for (const [n, f] of measures) if (!e.audio.measures.has(n)) ctx.track(e.audio.measure(n, f)); };
      own();
      return s;
    },
    // a calendar removed mid-game takes its measures with it: the sky takes the signals back at once, or uDaylight / uTimeOfDay would freeze
    frame(dt) { own(); s.update(); s._envFrame(dt); },
    // the dome goes too: a sky swapped with replaces must not leave the old dome drawn behind the new one
    dispose(e) { resetSignals(e, SKY_SIGNALS); if (s._seasoned || s._covered) resetSignals(e, TINT_SIGNALS); if (s._oSun.on) resetSignals(e, ['uSunDir']); s._shadowOff(); s._swap.remove(); s._envOff(); s._entries.dispose(); dropOwned(s.engine, s._owned); s.dome.removeFromParent(); s.dome.geometry.dispose(); s.dome.material.dispose(); },
    // scenario params time / season go to the calendar when there is one (its own applyState); without it time sets the fixed time drawn
    stateKeys: ['time', 'season'],
    applyState(e, { time, season }) {
      if (e.calendar) return;
      if (time != null) s.fixedTime = parseClock(time) % 1;
      if (season != null) return { refused: { season: STRINGS.noSeason } };   // the rest of applyState has already run: a throw here would leave it half done
    },
    // describe().time is the calendar's; without one the sky reports the fixed time it draws
    describe(e, ctx) { if (!e.calendar) Object.assign(ctx.out.time, { timeOfDay: Math.round(s.fixedTime * 1000) / 1000, fixed: true }); },
  };
}

export const handRolled = 'none: a sky of its own is plain three.js, used on purpose';
