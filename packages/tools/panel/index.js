// The dev panel: sliders and color pickers over any running engine, plus "write back" of what changed. Dev only:
//   if (location.search.includes('panel=1')) import('@threedog/tools/panel').then(m => m.openPanel(engine));
// A production build never contains it: the vite preset (gameConfig, vite/vite-threedog-panel.js) swaps this module for a stub that only warns
// (dev and test builds get the real one; without the preset, guard the import with import.meta.env.DEV). Tweakpane comes from the game
// (`npm i -D tweakpane`, optional) as 'virtual:threedog/tweakpane', or Pane = null when it is not installed: the page then says so and runs on.
//
// Every value is read from the three.js object that draws it and written straight back to that object: renderer exposure, scene.fog, the lights in
// the scene, scene.environmentIntensity, the module materials and { value } uniforms (engine.water / terrain / vegetation, each only when installed),
// engine.uniforms, materials by name. The engine does not write these per frame, so a value set here stays, unless the game's own picture code writes
// it each frame: then the game's line wins, which is the panel showing the truth. A folder lists what existed when the panel opened.
// "write back" saves the changes to .threedog/tune.json (dev server); `threedog tune write <file>` then shows the code change as a diff, --apply writes it.
// The models folder lists every generator registered with a params schema; an edit rebuilds its live copies at once (engine.assets.setParams)
// and "write back" + `threedog tune write` puts the values into that schema's defaults where the model is registered.
import { addArtFolder } from './art.js';

const UI_KEYS = ['bg', 'fg', 'muted', 'accent', 'good', 'line'];
const MATERIAL_COLORS = ['color', 'emissive'], MATERIAL_NUMBERS = ['roughness', 'metalness', 'emissiveIntensity', 'opacity', 'envMapIntensity'];
const HOW = 'Install the optional dev package with `npm install -D tweakpane`, then reload. 开发面板需要 tweakpane：先运行 npm install -D tweakpane。';

/** 0xrrggbb <-> '#rrggbb', the form a tweakpane color binding takes; other strings (rgba(...)) pass through */
const hexOf = n => '#' + n.toString(16).padStart(6, '0');
const numOf = s => (/^#[0-9a-f]{6}$/i.test(s) ? parseInt(s.slice(1), 16) : s);
/** The slider range of a material number */
const materialRange = k => ({ min: 0, max: k === 'emissiveIntensity' || k === 'envMapIntensity' ? 5 : 1, step: 0.01 });

/** Show why there is no panel, in the page (not only the console): the page's #panel-note if it has one, else a small corner note */
function note(text) {
  let el = document.getElementById('panel-note');
  if (!el) {
    el = Object.assign(document.createElement('div'), { id: 'panel-note' });
    el.style.cssText = 'position:fixed;top:8px;right:8px;max-width:320px;z-index:1000;padding:8px;background:#222;color:#fff;font:12px sans-serif';
    document.body.appendChild(el);
  }
  el.textContent = text; el.hidden = false;
  console.warn('threedog panel: ' + text);
}

/**
 * Open the dev panel over a running engine (dev only; see the top of this file).
 * @param {any} engine
 * @returns {Promise<boolean>} whether the panel is open
 * @example if (location.search.includes('panel=1')) import('@threedog/tools/panel').then(m => m.openPanel(engine));
 */
export async function openPanel(engine) {
  /** @type {any} */ let Pane;
  // @ts-ignore a virtual module of the vite preset (vite/vite-threedog-panel.js): tweakpane, or Pane = null when the game has not installed it
  try { ({ Pane } = await import('virtual:threedog/tweakpane')); } catch (e) { note(`The dev panel could not load tweakpane (${String(e).slice(0, 100)}). ` + HOW); return false; }
  if (!Pane) { note('The dev panel needs the dev package "tweakpane", which is not installed. ' + HOW); return false; }
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:8px;right:8px;width:310px;max-height:calc(100vh - 16px);overflow:auto;z-index:1000';
  document.body.appendChild(host);
  const pane = new Pane({ title: 'Dev panel', container: host });
  addArtFolder(pane, engine);   // first: it reads only scene and assets, so it stands in a game with any set of modules
  // what "write back" saves. values: code path -> number or '#rrggbb' (tune.mjs prints `path = n;` or `path.set(0xrrggbb);`)
  const tune = { values: {}, css: {}, materials: {}, models: {} };
  const scene = engine.scene;

  /**
   * One number or THREE.Color property of a three.js object. read gives the object at write time, not at open, so a material or uniform the game
   * swapped later is the one written. A property of another type gets no row.
   * @param {any} folder @param {() => any} read @param {string} key @param {string} path the object as code, for write back @param {{ label?: string, min?: number, max?: number, step?: number }} [o] binding options
   */
  const bind = (folder, read, key, path, o = {}) => {
    const v = read()?.[key], color = v?.isColor;
    if (!color && typeof v !== 'number') return;
    const vals = { [key]: color ? '#' + v.getHexString() : v };
    folder.addBinding(vals, key, color ? { label: o.label ?? key } : { step: 0.01, ...o }).on('change', e => {
      const target = read();
      if (color) target[key].set(e.value); else target[key] = e.value;
      tune.values[`${path}.${key}`] = e.value;
    });
  };
  /** A folder of a material's colors and numbers; nothing when the module is not there or the material has none of them */
  const materialFolder = (parent, title, read, path, keys = [...MATERIAL_COLORS, ...MATERIAL_NUMBERS]) => {
    const m = read();
    if (!m || !keys.some(k => m[k]?.isColor || typeof m[k] === 'number')) return;
    const f = parent.addFolder({ title, expanded: false });
    for (const k of keys) bind(f, read, k, path, MATERIAL_NUMBERS.includes(k) ? materialRange(k) : {});
  };
  /** A folder of { value } uniforms */
  const uniformFolder = (parent, title, read, path) => {
    const names = Object.keys(read() ?? {}).filter(k => { const v = read()[k]?.value; return typeof v === 'number' || v?.isColor; });
    if (!names.length) return;
    const f = parent.addFolder({ title, expanded: false });
    for (const k of names) bind(f, () => read()?.[k], 'value', `${path}.${k}`, { label: k });
  };

  // ---- renderer and time of day ----
  const view = pane.addFolder({ title: 'renderer' });
  bind(view, () => engine.renderer, 'toneMappingExposure', 'engine.renderer', { min: 0.2, max: 3, label: '曝光 exposure' });
  if (engine.calendar) {
    view.addBinding({ hour: engine.calendar.timeOfDay * 24 }, 'hour', { min: 0, max: 24, step: 0.1, label: '天空时间 hour (preview)' })
      .on('change', e => { engine.calendar.timeOfDay = e.value / 24 % 1; });
  }

  // ---- scene.fog: three's Fog has near / far, FogExp2 has density ----
  if (scene.fog) {
    const f = pane.addFolder({ title: '雾 scene.fog' }), fog = () => scene.fog, path = 'engine.scene.fog';
    bind(f, fog, 'color', path);
    for (const k of ['near', 'far']) bind(f, fog, k, path, { min: 0, max: Math.max(scene.fog.far * 3, 100), step: 0.5 });
    bind(f, fog, 'density', path, { min: 0, max: Math.max(scene.fog.density * 3, 0.1), step: 0.0005 });
  }

  // ---- lights in the scene: the game's own and the engine's placeholders alike ----
  const lights = [], seen = {};
  scene.traverse(o => { if (o.isLight) lights.push(o); });
  if (lights.length) {
    const lf = pane.addFolder({ title: `灯 lights (${lights.length})`, expanded: false });
    for (const l of lights) {
      // as code: by name when it has one, else its place among the lights of its type (getObjectsByProperty walks in the same order as traverse)
      const i = seen[l.type] = (seen[l.type] ?? -1) + 1;
      const path = l.name ? `engine.scene.getObjectByName(${JSON.stringify(l.name)})` : `engine.scene.getObjectsByProperty('type', '${l.type}')[${i}]`;
      const f = lf.addFolder({ title: l.name || `${l.type} ${i}`, expanded: false });
      bind(f, () => l, 'intensity', path, { min: 0, max: Math.max(l.intensity * 3, 5) });
      bind(f, () => l, 'color', path);
      bind(f, () => l, 'groundColor', path);
    }
  }

  // ---- environment lighting: only with a map in the scene; the switch keeps the map so it can come back ----
  if (scene.environment) {
    const f = pane.addFolder({ title: '环境照明 environment', expanded: false }), map = scene.environment;
    f.addBinding({ on: true }, 'on', { label: '开 on' }).on('change', e => { scene.environment = e.value ? map : null; });
    bind(f, () => scene, 'environmentIntensity', 'engine.scene', { min: 0, max: 2, label: '强度 intensity' });
  }

  // ---- module pictures: plain materials and uniforms, each only when the module is installed ----
  if (engine.water) {
    const f = pane.addFolder({ title: '水 water' });
    materialFolder(f, 'material', () => engine.water?.material, 'engine.water.material');
    uniformFolder(f, 'uniforms', () => engine.water?.uniforms, 'engine.water.uniforms');
  }
  if (engine.terrain) {
    const f = pane.addFolder({ title: '地形 terrain', expanded: false });
    materialFolder(f, 'material', () => engine.terrain?.material, 'engine.terrain.material');
    uniformFolder(f, 'uniforms', () => engine.terrain?.uniforms, 'engine.terrain.uniforms');
  }
  // color only: until a game sets one shared material each species draws its own copy, and .color is what reaches them all (a number here would
  // move nothing). Under a game's 'vegetation-draw' the module owns no material: reading it throws by design, so ask first
  materialFolder(pane, '植被 vegetation', () => (engine.vegetationDraw ? engine.vegetation?.material : null), 'engine.vegetation.material', ['color']);

  // ---- post effects: every effect's on / off and its number and boolean params ----
  const post = pane.addFolder({ title: '后期 post', expanded: false });
  for (const { name, enabled } of engine.post.list()) {
    const h = engine.post.get(name), f = post.addFolder({ title: name, expanded: false });
    f.addBinding({ enabled }, 'enabled', { label: '开 on' }).on('change', e => { h.enabled = e.value; });
    for (const [k, v] of Object.entries(h.params)) {
      if (typeof v !== 'number' && typeof v !== 'boolean') continue;   // lut textures, functions...: not editable here
      const range = typeof v === 'number' ? { step: Math.abs(v) >= 10 ? 1 : 0.01, min: Math.min(0, v * 2), max: Math.max(1, v * 3) } : {};
      f.addBinding({ [k]: v }, k, range).on('change', e => h.set({ [k]: e.value }));
    }
  }

  // ---- UI colors, CSS variables on engine.uiRoot ----
  const css = getComputedStyle(engine.uiRoot), uiVals = {};
  for (const k of UI_KEYS) { const v = css.getPropertyValue('--threedog-' + k).trim(); if (v) uiVals[k] = v; }
  const ui = pane.addFolder({ title: '界面颜色 ui', expanded: false });
  for (const k of Object.keys(uiVals)) ui.addBinding(uiVals, k).on('change', e => { engine.uiRoot.style.setProperty('--threedog-' + k, e.value); tune.css[k] = e.value; });

  // ---- a material picked by name: any material in the scene ----
  const names = [...new Set(engine.inspect.materials({ limit: 0 }).materials.map(m => m.name).filter(Boolean))].sort();
  if (names.length) {
    const matF = pane.addFolder({ title: 'material (by name)', expanded: false }), pick = { name: names[0] };
    let sub = null;
    const byName = n => { const out = new Set(); scene.traverse(o => { for (const m of [].concat(o.material || [])) if (m?.name === n && !engine._tools.standIn(m)) out.add(m); }); return [...out]; };
    const showMat = () => {
      sub?.dispose();
      const ms = byName(pick.name), m0 = ms[0];
      if (!m0) return;
      sub = matF.addFolder({ title: `${pick.name} (${ms.length})` });
      const vals = {};
      for (const k of MATERIAL_COLORS) if (m0[k]?.isColor) vals[k] = '#' + m0[k].getHexString();
      for (const k of MATERIAL_NUMBERS) if (typeof m0[k] === 'number') vals[k] = m0[k];
      for (const k of Object.keys(vals)) {
        sub.addBinding(vals, k, typeof vals[k] === 'number' ? materialRange(k) : {})
          .on('change', e => { for (const m of byName(pick.name)) m.setValues({ [k]: e.value }); (tune.materials[pick.name] ??= {})[k] = e.value; });
      }
    };
    matF.addBinding(pick, 'name', { options: Object.fromEntries(names.map(n => [n, n])) }).on('change', showMat);
    showMat();
  }

  uniformFolder(pane, 'engine.uniforms', () => engine.uniforms, 'engine.uniforms');

  // ---- models: generator params (a model registered as { build, params: schema }); an edit rebuilds every live copy (assets.setParams, hot swap) ----
  const withParams = [...engine.assets.entries].filter(([, x]) => x.named && x.schema).map(([n]) => n).sort();
  if (withParams.length) {
    const mf = pane.addFolder({ title: 'models (params)', expanded: false });
    let busy = null; const queued = new Map();
    // drags fire many changes: one rebuild at a time, the latest values win
    const run = async () => {
      while (queued.size) {
        const [name, v] = queued.entries().next().value; queued.delete(name);
        try { await engine.assets.setParams(name, v); } catch (err) { console.warn('[panel] ' + err.message); }
      }
      busy = null;
    };
    for (const name of withParams) {
      const { schema, values } = engine.assets.paramsOf(name), f = mf.addFolder({ title: name, expanded: false }), vals = {};
      for (const [k, s] of Object.entries(schema)) {
        const v = values[k];
        if (s.type === 'color') vals[k] = typeof v === 'number' ? hexOf(v) : v;
        else if (['number', 'int', 'bool', 'string'].includes(s.type) && v !== undefined) vals[k] = v;
        else continue;
        const o = s.type === 'number' || s.type === 'int' ? { min: s.min, max: s.max, step: s.type === 'int' ? 1 : (s.max != null && s.min != null ? (s.max - s.min) / 100 : 0.01) }
          : s.values ? { options: Object.fromEntries(s.values.map(x => [x, x])) } : {};
        f.addBinding(vals, k, o).on('change', e => {
          const val = s.type === 'color' && typeof v === 'number' ? numOf(e.value) : e.value;
          (tune.models[name] ??= {})[k] = s.type === 'color' ? e.value : val;
          queued.set(name, { ...queued.get(name), [k]: val });
          busy ??= run();
        });
      }
    }
  }

  // ---- shared values off their base now: the same rows as describe's "Values being changed now" line (engine.stacks.changed), read only ----
  const chg = { text: '' }, show = () => { chg.text = engine.stacks.changed().map(c => c.text).join('\n') || '-'; };
  show();
  const chgF = pane.addFolder({ title: '正在被改的值 values changed now', expanded: false });
  const chgMon = chgF.addBinding(chg, 'text', { readonly: true, multiline: true, rows: 5, label: '' });
  chgF.addButton({ title: '刷新 refresh' }).on('click', () => { show(); chgMon.refresh(); });

  // ---- write back: the dev server saves .threedog/tune.json (tools/vite/vite-threedog-live.js); the code change is `threedog tune write <file>` (dry run first) ----
  const out = { text: '' };
  const wb = pane.addFolder({ title: '写回 write back' });
  const mon = wb.addBinding(out, 'text', { readonly: true, multiline: true, rows: 3, label: '' });
  wb.addButton({ title: '写回代码 write back (then: threedog tune write <file>)' }).on('click', async () => {
    try {
      const r = await fetch('/__threedog/tune', { method: 'POST', body: JSON.stringify(tune) }).then(x => x.json());
      out.text = r.ok ? `saved ${r.file}
next: ${r.next}` : 'not saved: ' + r.error;
    } catch (err) { out.text = 'write back needs the dev server (npm run dev): ' + String(err).slice(0, 80); }
    mon.refresh();
  });

  engine.describe.add('devPanel', () => ({ open: true, tune: JSON.parse(JSON.stringify(tune)) }));
  /** @type {any} */ (engine).devPanel = { pane, tune };   // for tests and the dev bridge
  return true;
}
