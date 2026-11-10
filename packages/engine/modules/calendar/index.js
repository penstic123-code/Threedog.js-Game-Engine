// calendar() hooks, saves, scenario time.
// The calendar() module definition: install, the clock channel's moves, engine.skip, saves, scenario time / season, describe. engine.calendar API: Calendar.js.
// Stage 'environment' before sky: the sky reads the calendar each frame to draw, so the time it draws is this step's.
import { Calendar } from './Calendar.js';
import { timeCondition } from './seasons.js';
import { readParams, keysSchema } from '../../core/base/params.js';
import { parseClock } from '../../core/time/dayTime.js';
import { codedError, coded } from '../../core/base/errorHints.js';
import { warnOnce } from '../../core/base/validate.js';
import { saveValues, SAVE_MAX_SECONDS } from '../../core/base/saveValues.js';
/** @import { ModuleDef } from '../../types/core' */
/** @import { CalendarOptions } from '../../types/world' */

const CALENDAR_OPTIONS = ['time', 'dayLength', 'day', 'daysPerSeason', 'seasons', 'hoursPerDay'];
const STRINGS = {
  skyTime: 'calendar owns the time of day while it is installed, so sky({ time }) is unused. Move the starting time to calendar({ time }) and remove sky({ time })',
};
const CALENDAR_PARAMS = keysSchema(CALENDAR_OPTIONS);   // keys only: time takes 'HH:MM' or 0-1, seasons names or { name, days }; Calendar checks them

/**
 * Game calendar: time of day, day, seasons, clock-time timers -> engine.calendar (sky() reads it to draw)
 * @param {CalendarOptions} [opts]
 * @returns {ModuleDef<Calendar>}
 */
export function calendar(opts = {}) {
  readParams('calendar', CALENDAR_PARAMS, opts);
  let c = null;
  return {
    name: 'calendar', skipKind: 'exact', type: 'world', provides: ['calendar'], label: 'Calendar', params: CALENDAR_PARAMS, options: opts, stage: 'environment', before: ['sky'],
    install(e, ctx) { e.i18n.add({ 'zh-CN': { 'module.calendar': '日历' }, en: { 'module.calendar': 'calendar' } });
      // sky({ time }) is the fixed time drawn without a calendar: installed before this one it would now sit unused, so say so (sky checks the other order)
      if (e.modules.get('sky')?.options?.time != null) warnOnce(coded('time-owner-conflict', STRINGS.skyTime), 'sky-time-calendar');
      c = new Calendar(e, opts);
      // audio rule condition { time: 'day' | 'night' | ['18:00', '06:00'] } and measure { daylight: { gt: 0.15 } } for music / ambience rule lists:
      // from the clock, so an indoor game without a sky still switches its night music
      ctx.track(e.audio.condition('time', timeCondition(c)));
      ctx.track(e.audio.measure('daylight', () => c.daylight));
      ctx.track(e.audio.measure('timeOfDay', () => c.timeOfDay));   // render/daylight.js writes uTimeOfDay from it
      // between() ranges re-check whether they are inside after anything that moves the clock without stepping
      c._sched.rebase();   // a calendar installed after start: its first step already counts the marks it crosses
      // before the first step every write to the clock (setup, engine:ready, the first state door, applyState below) is a set, not elapsed time: re-base so only time that elapses fires alarms.
      // After a load a cleared baseline is the restored time (a plain applyState later keeps it, so a forward jump still replays)
      ctx.track(e.events.on('state:replaced', () => { c._sched.syncRanges(); if (!c._sched.ticks || c._sched.last == null) c._sched.rebase(); }));
      // the day and time of day are views of the 'calendar' channel: its events and clock timers run right after the channel moves (a step or a skip segment)
      ctx.track(e.time.onMove(() => c.moved()));
      // at: the calendar channel second the time and day belong to, so the origin is right whichever part (calendar or time) loads first
      ctx.saves.define('calendar', { notAtomic: 'the clock moves it every step, and an op that sets the time means it to stay', save: () => ({ time: c.timeOfDay, day: c.day, at: e.clock.now }),
        // saved numbers pass saveValues as clock / random / time do: a time 'abc' showed clock 'NaN:NaN' and a day -5 broke seasons (one warning per part)
        load: d => {
          if (d) {
            const v = saveValues('calendar');
            const tod = v.num(d.time, 'time', { min: 0, max: 1, fallback: c.timeOfDay }) % 1;   // 1 is the next midnight, as calendar({ time })
            const day = v.num(d.day, 'day', { min: 1, max: SAVE_MAX_SECONDS, int: true, fallback: c.day });
            const at = v.num(d.at, 'at', { fallback: e.clock.now });
            v.done();
            c._day0 = day; c._tod0 = tod; c._t0 = at; c._lastDay = c.day;
            c._season = c.season;
          }
          c._sched.last = null;   // the baseline is set by state:replaced, once every part is restored
        } });
      return c;
    },
    counts() { return { timers: c.scheduled }; },   // engine.counts().calendar
    // engine.skip: segments end at clock marks (core/time/skip.js reads untilMark), so each move crosses at most one mark and one midnight; a skip right after
    // loading counts from now (a step would only reset the baseline). The move itself is the time source's (onMove above)
    skip() { c._sched.last ??= c.totalDays; },
    dispose() { c._sched.dispose(); },
    // scenario param time: 'HH:MM' or 0-1 (text in the URL)
    // scenario param season: the first day of that season (outside the last-20% blend into the next one), time of day kept
    stateKeys: ['time', 'season'],
    applyState(e, { time, season }) {
      if (time != null) c.timeOfDay = parseClock(time, c.hoursPerDay) % 1;
      if (season != null) {
        const i = c.seasons.indexOf(season);
        if (i < 0) throw codedError('calendar-option', `applyState({ season: '${season}' }): the calendar has ${c.seasons.length ? 'seasons ' + c.seasons.join(', ') : 'no seasons'}; ` +
          "seasons are off by default: calendar({ seasons: ['spring', 'summer', 'autumn', 'winter'] })");
        c.day = (i ? c._ends[i - 1] : 0) + 1; c._season = c.season;   // writing day fires no day:start
      }
      if (!c._sched.ticks) c._sched.rebase();   // ?time=07:59&wait=5 before any step: the jump is a set, but the wait that follows is elapsed time and fires its alarms
    },
    describe(e, ctx) {
      Object.assign(ctx.out.time ??= {}, { clock: c.clock, day: c.day, season: c.season, isDay: c.isDay, timeOfDay: Math.round(c.timeOfDay * 1000) / 1000,
        dayLength: c.dayLength, rate: e.clock.rate });
    },
  };
}

export const handRolled = 'none: a day counter of its own is a plain number that looks like any other';
