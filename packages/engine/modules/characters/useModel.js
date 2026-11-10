// Swap a loaded glTF model into a Character: attach it and build its animation state machine from the default / mapped / game-given clips.
// Split out of Character.js; Character._useModel calls it.
import { warnOnce } from '../../core/base/validate.js';
import { findClip } from '../../core/assets/Animator.js';
import { standAt } from './movers/support.js';

const DEFAULT_CLIPS = { idle: 'Idle', walk: 'Walk', run: 'Run', swim: 'Swim', jump: 'Jump', fall: 'Fall', drive: 'Drive' };

export function useModel(ch, model, clips, animation) {
  const engine = ch.engine; ch.root.add(model);
  // a bone named like a Character field (e.g. "head", "root", "state") makes `ch[name]` mean the field, not the bone: easy to miss when a game
  // reads bones by name; say it once per name and point at the safe lookup
  model.traverse(o => { if (o.isBone && o.name && o.name in ch) warnOnce(`character model "${model.name || 'model'}": bone "${o.name}" has the same name as the Character field ch.${o.name}; read the bone with ch.root.getObjectByName('${o.name}'), not ch.${o.name}, or rename the bone`); });
  const states = {};
  // default names only where the model has the clip (a model without Swim is fine) and the manifest mapped nothing (Assets.animate merges that under
  // these states, so a default Idle must not shadow a mapped Idle_Sword); names the game wrote are always kept so a typo is reported
  const have = model.animations, map = engine.assets.mapping(model), mapped = map?.states || {};
  for (const [st, clip] of Object.entries(DEFAULT_CLIPS)) if (!mapped[st] && findClip(have, clip)) states[st] = { clip };
  for (const [st, clip] of Object.entries(clips || {})) states[st] = { clip };
  // the model's own mapping (fade, transitions) beats characters({ animation }), the default for every character; the game's per-character config beats both
  ch.anim = engine.assets.animate(model, { ...engine.characters?._animation, ...map, states, ...(animation || {}) });
  ch.anim._rate = () => engine.time.scale(ch.channel, ch.id);   // the character's time channel (bullet time, time.local) slows clips, fades and IK too, as it does the walk cycle
  ch.anim.afterPose = dt => ch._firePose(dt);   // a mixer pose is applied inside the Animator's update, so the Animator tells us when it is done
  // feet (anim.addFeet) stand where the character walks: the ground with its platforms; off while it jumps or swims (asked before any ground query)
  const at = { y: 0, on: null };
  ch.anim._ground = (x, z, y) => standAt(engine, x, z, y, ch.stepHeight, at, true).y;
  ch.anim._standing = () => ch.grounded && !ch.swimming;
}
