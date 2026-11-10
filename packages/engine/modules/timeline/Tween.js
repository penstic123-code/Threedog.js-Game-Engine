// Tween: smoothly change a value from its current value to a target over time.
// Targets use a dot path: 'position.x', 'material.opacity', 'scale' (whole vector), 'material.color' (color).
//   Supported values: numbers; THREE.Vector2/3/4, Euler (give an array [x,y,z], {x,y,z} or Vector3); THREE.Color (give 0xff8800, '#f80' or Color); Quaternion (slerp)
//   Note: material.opacity only shows when the material has transparent: true
//
//   const tw = new Tweener();  call tw.update(dt) every frame
//   await tw.tween(mesh, { 'position.y': 3, 'material.color': 0xffffff }, 1.5, 'outBack');
//   const p = tw.tween(...); p.finish() jumps to the end; p.remove() stops where it is (the cancel convention)
// A task that throws (its start, a step, its end) ends there: what it holds goes back, it leaves the list, its promise rejects. The one who awaits it decides what that means (a
// Timeline run ends 'failed'); a tween nobody awaits is the page's unhandled rejection, which the engine reports (core/base/errors.js watchRejections). The other tasks go on.
import * as THREE from 'three';
import { ease as easing } from '../../core/base/easing.js';
import { allowOwned } from '../../core/ops/owned.js';
import { getPath } from '../../core/base/util.js';
import { warnOnce } from '../../core/base/validate.js';
import { coded } from '../../core/base/errorHints.js';

const COMPS = ['x', 'y', 'z', 'w'];

/** 'material.color' → { obj: target.material, key: 'color' } */
function resolve(target, path) {
  const i = path.lastIndexOf('.'), obj = i < 0 ? target : getPath(target, path.slice(0, i));
  return obj == null ? null : { obj, key: path.slice(i + 1) };
}

/** Build an interpolator for a property: returns k => apply progress k (0..1) */
function makeProp(target, path, toValue) {
  const r = resolve(target, path);
  if (!r) { warnOnce(coded('tween-property', `[tween] property not found: ${path}`)); return null; }
  const { obj, key } = r, cur = obj[key];
  if (typeof cur === 'number') {
    const from = cur, to = +toValue;
    return k => { obj[key] = from + (to - from) * k; };
  }
  if (cur?.isColor) {
    const from = cur.clone(), to = toValue?.isColor ? toValue.clone() : new THREE.Color(toValue);
    return k => { cur.copy(from).lerp(to, k); };
  }
  if (cur?.isQuaternion) {
    const from = cur.clone(), to = toValue?.isQuaternion ? toValue.clone()
      : toValue?.isEuler ? new THREE.Quaternion().setFromEuler(toValue) : new THREE.Quaternion(...(Array.isArray(toValue) ? toValue : [toValue.x, toValue.y, toValue.z, toValue.w ?? 1]));
    return k => { cur.slerpQuaternions(from, to, k); };
  }
  if (cur && typeof cur === 'object') {
    // vector / Euler: interpolate per component
    const comps = COMPS.filter(c => typeof cur[c] === 'number');
    if (!comps.length) { warnOnce(coded('tween-property', `[tween] unsupported property type: ${path}`)); return null; }
    const from = comps.map(c => cur[c]);
    const to = comps.map((c, i) => Array.isArray(toValue) ? (toValue[i] ?? from[i]) : typeof toValue === 'number' ? toValue : (toValue?.[c] ?? from[i]));
    const at = (i, k) => from[i] + (to[i] - from[i]) * k;
    // Euler: one set() so the object's quaternion follows once per step (its public setters keep it in sync)
    if (cur.isEuler) return k => { cur.set(at(0, k), at(1, k), at(2, k), cur.order); };
    return k => { for (let i = 0; i < comps.length; i++) cur[comps[i]] = at(i, k); };
  }
  warnOnce(coded('tween-property', `[tween] unsupported property type: ${path}`));
  return null;
}

let tweenId = 0;   // page-wide on purpose: the owner names go into validate.js allowOwned, whose exemption set is shared by every engine on the page

export class Tweener {
  constructor() { this.list = []; }

  /**
   * General task: calls step(k) every frame, k is the eased progress. duration in seconds; returns a Promise with finish() / remove(), rejected if start, step or end throws.
   * The start value is read on the first update (so a later queued tween starts from where the previous one ended).
   */
  run({ duration = 0, ease = 'linear', start, step, end, group = null }) {
    let res, rej;
    const p = new Promise((yes, no) => { res = yes; rej = no; });
    const task = { t: 0, dur: Math.max(0, duration), ease: easing(ease), start, step, end, group, res, rej, started: false, done: false };
    task.finish = () => this._complete(task, 1);
    task.cancel = () => this._complete(task, null);
    p.finish = task.finish; p.remove = task.cancel; p.task = task;
    this.list.push(task);
    if (task.dur === 0) this._complete(task, 1);
    return p;
  }

  /** Property tween: to = { 'position.x': 3, 'material.color': 0xffffff }. A value may also be a function () => value (evaluated at start) */
  // a tween is a legitimate temporary takeover of what it animates (a light, the fog): those objects only skip the engine's outside-write
  // detection (core/ops/owned.js) while it runs, so the engine neither warns nor yields them for good; everything else stays checked
  tween(target, to, duration = 1, ease = 'inOutCubic', group = null) {
    let props = [];
    const owner = 'tween:' + (++tweenId);
    return this.run({
      duration, ease, group,
      start: () => {
        const objs = new Set([target]);
        for (const path of Object.keys(to)) { const r = resolve(target, path); if (r) { objs.add(r.obj); if (r.obj[r.key] && typeof r.obj[r.key] === 'object') objs.add(r.obj[r.key]); } }
        allowOwned(owner, objs);
        props = Object.entries(to).map(([path, v]) => makeProp(target, path, typeof v === 'function' ? v() : v)).filter(Boolean);
      },
      step: k => { for (const f of props) f(k); },
      end: () => allowOwned(owner, false),   // the tween's last value is marked by the next engine frame, so ending is not an outside write
    });
  }

  update(dt) {
    if (!this.list.length) return;
    for (const task of [...this.list]) {
      if (task.done) continue;
      try {
        if (!task.started) { task.started = true; task.start?.(); }
        task.t += dt;
        if (task.t >= task.dur) this._complete(task, 1);
        else task.step?.(task.ease(task.t / task.dur));
      } catch (error) { this._complete(task, null, { error }); }
    }
  }

  /** Jump a group of tasks (or all) to their end */
  finishAll(group) { for (const t of [...this.list]) if (group === undefined || t.group === group) t.finish(); }

  /** Stop a group of tasks (or all) where they are: nothing is written, what they hold goes back (a dropped cutscene must not paint its end values over a loaded state) */
  cancelAll(group) { for (const t of [...this.list]) if (group === undefined || t.group === group) t.cancel(); }

  /** The one way a task ends: k 1 jumps to the end, null stops where it is. failed { error }: a throw on the way, and the first one is the promise's answer. So finish() never throws and finishAll reaches every task */
  _complete(task, k, failed = null) {
    if (task.done) return;
    task.done = true;
    const guard = fn => { try { fn(); } catch (error) { failed ??= { error }; } };
    if (k !== null) guard(() => {
      if (!task.started) { task.started = true; task.start?.(); }
      task.step?.(task.ease(1));
    });
    guard(() => task.end?.(k !== null && !failed));   // whatever happened above: end gives back what the task holds
    const i = this.list.indexOf(task); if (i >= 0) this.list.splice(i, 1);
    if (failed) task.rej(failed.error); else task.res(k !== null);
  }
}
