// The in-browser editor's screen: select, drag, turn, the property rows, add, delete, undo. Dev server only, loaded by vite/vite-threedog-editor.js (plan
// docs/plans/done/2026-11-05-editor.md). Picking, camera and handles are the engine's and three.js's own; this file only wires them. It knows nothing of content
// files: it holds a neutral entry from design.js and asks design.js for every change (rule R54).
//
// The handles and the selection box live in a little scene of their own, drawn after the game's frame: nothing is added to engine.scene, so the game's scene
// count, its pick results and its save see no editor, and the box needs no exception anywhere. While a handle is dragged design.js moves the real model
// (previewEntry); the box wraps that model every frame, so what is on screen is the model itself and not a stand-in. Letting go saves.
import { uiFocus, screenToGround, THREE as T } from 'threedog';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { entryAt, thingAt, pickAt, modelOf, previewEntry, moveEntry, fieldsOf, setField, catalog, addEntry, removeEntry, undo, redo } from './design.js';

const CLICK_PX = 5;   // a press that travels further is a camera move, not a click
const VIEW = 'threedog-editor-view';   // camera and selection across the reloads of a save that needs one
const PANEL = 'position:fixed;top:8px;right:8px;width:240px;box-sizing:border-box;max-height:calc(100vh - 16px);overflow:auto;z-index:2147483000;padding:8px 10px;background:#000c;color:#fff;font:12px/1.5 sans-serif;overflow-wrap:anywhere';
const ROW = 'display:flex;gap:6px;align-items:center;margin-top:2px';
const INPUT = 'flex:1;min-width:0;font:inherit;background:#222;color:#fff;border:1px solid #555';
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };

/** The floating panel, folded by a click on its first line; data-state is what tests read: idle | selected | saving | saved | refused */
function makePanel() {
  const root = el('details', { id: 'threedog-editor', open: true }), mark = el('span'), status = el('div'), tools = el('div'), add = el('div');
  const common = el('div'), rare = el('div'), more = el('details', { hidden: true }, el('summary', { textContent: 'More' }), rare), rows = el('div', {}, common, more);
  status.style.whiteSpace = 'pre-wrap';
  root.style.cssText = PANEL;
  root.append(el('summary', {}, 'Editor (F2 to leave)', mark), tools, add, status, rows);   // the buttons first: the text below them changes length, and a button that moves is missed on the next click
  document.body.appendChild(root);
  // the state stays in the first line: folded, that line is the only sign a save took. A refusal unfolds, its reason is the thing to read
  return { root, tools, rows, common, rare, more, add, say(state, text) { root.dataset.state = state; mark.textContent = ` · ${state}`; status.textContent = text; status.style.color = state === 'refused' ? '#ff9a8a' : ''; if (state === 'refused') root.open = true; } };
}

/**
 * Open the editor over a running engine.
 * @param {any} engine
 */
export function openEditor(engine) {
  const canvas = engine.renderer.domElement, panel = makePanel(), { say } = panel;
  engine.ui.close('title');   // a full-screen title covers the canvas, and F2 always arrives at one: nothing could be clicked until it was gone
  // a game's own title, written by hand, covers it the same way and has no part to close. F2 reloads the page on the way out, so hiding it is enough
  const r = canvas.getBoundingClientRect();
  for (const n of document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)) { if (n === canvas) break; if (!panel.root.contains(n)) n.style.display = 'none'; }
  uiFocus(engine).push('editor');   // no cancel: Esc is swallowed, or it opens the game's menu over the scene being edited
  engine.freeze('editor');
  engine.takeCamera('editor');

  const orbit = new OrbitControls(engine.camera, canvas);
  engine.camera.getWorldDirection(orbit.target).multiplyScalar(10).add(engine.camera.position);

  const overlay = new T.Scene(), anchor = new T.Object3D();
  const box = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(1, 1, 1)), new T.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
  box.visible = false;
  const handles = new TransformControls(engine.camera, canvas);
  overlay.add(anchor, box, handles.getHelper());

  let entry = null, pressed = null, turn = 0, mode = 'translate', lost = null;   // lost: a refusal the selection may have moved past
  const place = e => { anchor.position.set(e.position.x, e.position.y, e.position.z); anchor.rotation.set(0, e.yaw, 0); };
  // Y first: in the default order Euler y folds back at a quarter turn
  const turnOf = new T.Euler(0, 0, 0, 'YXZ');
  const pose = () => ({ x: anchor.position.x, y: anchor.position.y, z: anchor.position.z, yaw: turnOf.setFromQuaternion(anchor.quaternion, 'YXZ').y });

  function setMode(m) {
    mode = m;
    handles.setMode(m);
    handles.showX = handles.showZ = m === 'translate';   // turning shows the yaw ring alone: three.js hides its outer rings with X and Z, so no tilt can start
    handles.showY = m === 'rotate' || !!entry?.height;
    drawTools();
  }

  /** Hold this entry from now on (null: nothing selected) and show it */
  function hold(next, state = 'selected', text = null) {
    if (state === 'saved' && text !== 'no change') text = `Saved: ${text}`;   // said in words: there is no save button, so this line is the only sign the file took it
    // a save landed under a running drag: the drag owns the anchor, and letting go saves from this entry. Moving the anchor now would pull the model from under the hand
    if (handles.dragging && next?.id === entry?.id) { entry = next; return say(state, `${next.id}\n${text ?? ''}`); }
    entry = next;
    handles.detach();
    box.visible = !!entry;
    if (!entry) { drawRows(); drawTools(); return say(state === 'selected' ? 'idle' : state, text ?? 'Click something to select it.'); }
    place(entry);
    if (mode === 'rotate' && !entry.turn) mode = 'translate';
    setMode(mode);
    if (entry.movable) handles.attach(anchor);
    // the user has moved on to another row while the last one saved: a redraw would take the input and what is typed in it. A refusal does redraw, the file wins
    if (state !== 'saved' || !panel.rows.contains(document.activeElement)) drawRows();
    say(state, `${entry.id}\n${entry.at ?? 'added by code'}\n${text ?? (entry.movable ? 'Drag a handle: letting go saves.' : entry.why)}`);
  }

  async function select(thing) {
    const mine = ++turn, next = await entryAt(engine, thing);
    if (mine !== turn) return;   // a later click won while this one waited for the server
    hold(next);
    if (lost && lost.id !== next?.id) say('refused', lost.text);   // the click that moved on also ended the typing whose save came back refused: the user must still read why
    lost = null;
  }

  /** Show how a change went; the entry it gives back replaces the one held. By id: an earlier step of the same queue may have replaced the object, and this reply still counts */
  function landed(was, r, gone = false) {
    if (r.reloading) return say('saving', 'reloading to show the change…');
    if (!r.ok) lost = { id: was.id, text: `${was.id} not saved: ${r.error}` };
    if (was.id !== entry?.id) { if (!r.ok) say('refused', lost.text); return; }
    if (r.ok) hold(gone ? null : r.entry ?? entry, 'saved', r.change ?? 'no change');
    else if (r.change) say('refused', r.error);   // the file took it, the page did not: the message says to reload
    else { hold(entry, 'refused', r.error); }
  }
  async function change(job, gone = false) {
    if (!entry) return;
    const was = entry;
    lost = null;
    say('saving', `${was.id}\nsaving…`);
    landed(was, await job(was), gone);
  }
  async function walk(way) {
    say('saving', 'saving…');
    turn++;
    const r = await way(engine);
    if (r.reloading) return;
    if (r.ok) hold(r.entry, 'saved', r.change);
    else say('refused', r.error);
  }

  function drawTools() {
    const button = (label, on, disabled = false) => { const b = el('button', { textContent: label, onclick: on, disabled, id: `threedog-editor-${label.toLowerCase()}` }); b.style.cssText = 'font:inherit;padding:0 3px'; return b; };
    const line = el('div', {}, button('Move', () => setMode('translate'), mode === 'translate'), button('Turn', () => setMode('rotate'), mode === 'rotate' || !entry?.turn),
      button('Delete', () => change(e => removeEntry(engine, e), true), !entry?.removable), button('Undo', () => walk(undo)), button('Redo', () => walk(redo)));
    line.style.cssText = ROW;
    panel.tools.replaceChildren(line);
  }

  function drawRows() {
    const rows = entry ? fieldsOf(engine, entry) : [];
    const draw = r => {
      const save = raw => change(e => setField(engine, e, r.key, raw));
      const input = r.input === 'select'
        // blur: a list keeps the focus after a choice, and Ctrl+Z or Delete would then do nothing with no word why
        ? el('select', { disabled: r.locked, onchange: e => { save(e.target.value); e.target.blur(); } }, el('option', { value: '', textContent: '' }), ...r.values.map(v => el('option', { value: String(v), textContent: String(v), selected: v === r.value })))
        : el('input', { type: r.input === 'number' ? 'number' : 'text', disabled: r.locked, step: 'any', placeholder: r.placeholder ?? '',
          onchange: e => e.target.validity.badInput ? hold(entry, 'refused', `${r.key}: not a number`) : save(e.target.value) });   // a number box hands over '' for 1e, and '' means take the field out
      if (r.input !== 'select') input.value = r.value == null ? '' : typeof r.value === 'object' ? JSON.stringify(r.value) : r.value;
      input.dataset.field = r.key;
      input.style.cssText = INPUT;
      const line = el('label', { title: `${r.key}${r.desc ? `: ${r.desc}` : ''}` }, el('span', { textContent: r.label }), input);
      line.style.cssText = ROW;
      line.firstChild.style.cssText = 'width:80px';
      return line;
    };
    panel.common.replaceChildren(...rows.filter(r => !r.rare).map(draw));
    panel.rare.replaceChildren(...rows.filter(r => r.rare).map(draw));
    panel.more.hidden = !rows.some(r => r.rare);
  }

  function drawAdd() {
    const list = catalog(engine);
    if (!list.length) return;
    const pick = el('select', { id: 'threedog-editor-pick' }, ...list.map((c, i) => el('option', { value: String(i), textContent: `${c.name}${c.pickup ? ' (pickup)' : c.model ? '' : ' (template)'}` })));
    pick.style.cssText = INPUT;
    const add = async () => {
      // on the ground under the middle of the view: where the user is looking, and always a place the handles can then be grabbed from
      const at = engine.pick(0, 0)?.point ?? screenToGround(engine, 0, 0) ?? orbit.target;   // terrain is not pickable; the target is left for a view of the open sky
      say('saving', 'saving…');
      turn++;
      const r = await addEntry(engine, list[+pick.value], at);
      if (r.reloading) return;
      if (r.ok) hold(r.entry, 'saved', r.change); else say('refused', r.error);
    };
    const line = el('div', {}, pick, el('button', { textContent: 'Add', onclick: add, id: 'threedog-editor-add' }));
    line.style.cssText = ROW;
    panel.add.replaceChildren(line);
  }

  handles.addEventListener('objectChange', () => {
    if (!entry?.movable) return;
    previewEntry(engine, entry, pose());
  });
  handles.addEventListener('dragging-changed', e => {
    orbit.enabled = !e.value;
    if (!e.value && entry?.movable) change(was => moveEntry(engine, was, pose()));
  });
  canvas.addEventListener('pointerdown', e => { pressed = { x: e.clientX, y: e.clientY, onHandle: !!handles.axis }; });
  canvas.addEventListener('pointerup', e => {
    const p = pressed; pressed = null;
    if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_PX) return;
    const r = canvas.getBoundingClientRect(), thing = pickAt(engine, (e.clientX - r.left) / r.width * 2 - 1, 1 - (e.clientY - r.top) / r.height * 2);
    // the handles reach far past their entry: a plain click on one means what lies under it, and only a click on nothing there keeps the selection
    if (thing || !p.onHandle) select(thing);
  });
  addEventListener('keydown', e => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;   // typing keeps the browser's own undo
    const key = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && key === 'z') { e.preventDefault(); walk(e.shiftKey ? redo : undo); }
    else if (mod && key === 'y') { e.preventDefault(); walk(redo); }
    else if (key === 'delete' && entry?.removable) change(was => removeEntry(engine, was), true);
    else if (key === 'r' && !mod && entry?.turn) setMode(mode === 'rotate' ? 'translate' : 'rotate');
  });
  addEventListener('pagehide', () => {
    const c = engine.camera.position, t = orbit.target;
    try { sessionStorage.setItem(VIEW, JSON.stringify({ id: entry?.id ?? null, folded: !panel.root.open, camera: [c.x, c.y, c.z], target: [t.x, t.y, t.z] })); } catch { /* blocked storage: the view starts fresh */ }
  });

  const measure = new T.Box3(), size = new T.Vector3();
  engine.onRender(({ renderer, camera }) => {
    orbit.object = handles.camera = camera;   // a game may assign engine.camera
    orbit.update();
    const model = entry && modelOf(engine, entry);
    if (model) {
      measure.setFromObject(model);
      if (!measure.isEmpty()) { measure.getCenter(box.position); box.scale.copy(measure.getSize(size)); }
    }
    const clear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(overlay, camera);
    renderer.autoClear = clear;
  }, { when: 'after' });

  drawTools();
  drawAdd();
  say('idle', 'Click something to select it.');
  let view = null;
  try { view = JSON.parse(sessionStorage.getItem(VIEW)); } catch { /* same */ }
  if (view) {
    engine.camera.position.fromArray(view.camera);
    orbit.target.fromArray(view.target);
    panel.root.open = !view.folded;
    if (view.id) select(thingAt(engine, view.id));
  }
}
