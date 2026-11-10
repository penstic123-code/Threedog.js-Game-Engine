// Named fixed camera views declared by the game, so a screenshot of "the same place" can be taken again after any change:
//   engine.views.define('gate', { position: [10, 4, 12], target: [0, 1, 0], fov: 50 });
//   engine.views.show('gate');   // or the URL ?view=gate, or `npm run shot -- -w my-game --view gate`
// A view takes over the camera with engine.takeCamera('views') (the same claim cutscenes use) until release() or the handle's remove(): a cutscene that
// held the camera before gets it back, instead of the camera going to nobody. It is a diagnostic aid, not a camera mode.
import { warnMissing } from '../base/validate.js';
import { readParams, keysSchema } from '../base/params.js';
import { codedError } from '../base/errorHints.js';
import { holdFov, baseFov } from './view.js';

const vec3 = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);

export class Views {
  /** @param {any} engine */
  constructor(engine) {
    /** @internal */ this.engine = engine;
    this.map = new Map(); this._cam = null;
    /** Name of the view in use, null while none is @type {string | null} */ this.current = null;
  }
  /**
   * Declare a view. position and target are [x, y, z]; fov (degrees) is optional (the camera's own when left out). Returns { remove() } (undeclares it).
   * @param {string} name @param {{ position: number[], target?: number[], fov?: number }} v
   * @returns {{ remove(): void }}
   */
  define(name, v) {
    readParams(`views.define('${name}')`, keysSchema(['position', 'target', 'fov']), v);
    if (!vec3(v.position)) throw codedError('views-define', `views.define('${name}'): position must be [x, y, z], got ${JSON.stringify(v.position)}`);
    if (v.target !== undefined && !vec3(v.target)) throw codedError('views-define', `views.define('${name}'): target must be [x, y, z], got ${JSON.stringify(v.target)}`);
    const rec = { position: v.position, target: v.target ?? [0, 0, 0], fov: v.fov };
    this.map.set(name, rec);
    return { remove: () => { if (this.map.get(name) === rec) { if (this.current === name) this.release(); this.map.delete(name); } } };
  }
  /** @param {string} name */
  has(name) { return this.map.has(name); }
  /** @returns {string[]} the declared view names */
  list() { return [...this.map.keys()]; }
  /**
   * Put the camera on a view and keep it there (the camera rigs leave it alone) until release() or the returned handle's remove(); null for an unknown name
   * @param {string} name @returns {{ remove(): void } | null}
   */
  show(name) {
    const v = this.map.get(name);
    if (!v) { warnMissing('view', name, this.list()); return null; }
    const e = this.engine;
    // focus: the world loads around what the view looks at, not around a player far away (the view was an empty sheet of ground without it)
    const focus = e.camera.position.clone().fromArray(v.target);
    // onTop: a newer claim (a timeline shot) that moved the camera has released, and this one is in charge again: the view is put back, not just the claim (stack hook in core/ops/holds.js)
    this._cam = e.takeCamera('views', { focus, onTop: () => this._put(name, v, focus) });
    this._put(name, v, focus);
    const cam = this._cam;   // this showing, not the name: a handle kept from an earlier one must not end a later one
    return { remove: () => { if (this._cam === cam) this.release(); } };
  }
  /** The view's pose and lens, on show and again each time the claim comes back on top */
  _put(name, v, focus) {
    const e = this.engine, c = e.camera;
    e.focus.copy(focus);
    c.position.fromArray(v.position); c.lookAt(...v.target);
    holdFov(e, v.fov ?? baseFov(e));   // a view without a fov shows the base lens: a shot that stood in front of it may have left its own
    c.updateMatrixWorld(true);
    this.current = name;
    e.events.emit('camera:shot', { name });   // a cut: what follows the camera (the light pool) settles at once instead of easing over
  }
  /** Give the camera back (to the previous holder, e.g. a running cutscene, or to the rig) */
  release() {
    this._cam?.remove(); this._cam = null; this.current = null;
  }
}
