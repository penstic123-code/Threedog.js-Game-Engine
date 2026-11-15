// Hub desktop icon: the pure create / retarget / none decision (no real desktop writes). Run: npm test -- hub-shortcut
import { shortcutPlan } from '../hub/shortcut.mjs';

export const name = 'hub-shortcut: desktop icon decision';

export async function run({ check }) {
  const node = String.raw`C:\Program Files\nodejs\node.exe`;
  const script = String.raw`C:\games\a\node_modules\@threedog\tools\hub.mjs`;
  const base = { node, script };
  const right = { target: node, args: `"${script}"` };

  check('no icon -> create', shortcutPlan('win32', { ...base, current: null }).action === 'create');
  check('icon pointing at a deleted copy -> retarget',
    shortcutPlan('win32', { ...base, current: { target: node, args: '"C:/gone/hub.mjs"' } }).action === 'retarget');
  check('icon with another node -> retarget', shortcutPlan('win32', { ...base, current: { ...right, target: 'D:/other/node.exe' } }).action === 'retarget');
  check('icon already right -> none', shortcutPlan('win32', { ...base, current: right }).action === 'none');
  check('slash and case differences count as the same', shortcutPlan('win32', { ...base, current: { target: node.toLowerCase(), args: right.args.replaceAll(String.fromCharCode(92), '/') } }).action === 'none');
  check('mac -> unsupported', shortcutPlan('darwin', { ...base, current: null }).action === 'unsupported');
  const p = shortcutPlan('win32', { ...base, current: null });
  check('plan carries node, quoted script and the ico', p.target === node && p.args === `"${script}"` && p.icon.endsWith('threedog.ico'));
}
