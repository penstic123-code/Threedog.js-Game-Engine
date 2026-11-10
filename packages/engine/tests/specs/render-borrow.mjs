// Renderer borrowing (design.md 4.5, docs/plans/2026-11-09-render-borrow.md): one borrow in render/backend.js puts back the same fields on both
// renderers, also when three's render throws inside it; and engine.rays' BVH is a listed patch that unregistering undoes.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';   // the tools' parser (packages/tools depends on it), for the syntax scan below

const PAGE = '/tests/render-borrow/index.html';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));   // packages/
const FIELDS = ['target', 'face', 'mip', 'viewport', 'scissor', 'scissorTest', 'clear', 'alpha', 'autoClear', 'tone', 'exposure', 'shadowAuto', 'override', 'background', 'fog', 'fogNode', 'layers', 'mrt', 'drawing'];

// The fields the borrow manages, by the name they are saved under (a getter, or a property read) and the name they are written back with
const GETTERS = { getRenderTarget: 'setRenderTarget', getActiveCubeFace: 'setRenderTarget', getActiveMipmapLevel: 'setRenderTarget', getViewport: 'setViewport',
  getCurrentViewport: 'setViewport', getScissor: 'setScissor', getScissorTest: 'setScissorTest', getClearColor: 'setClearColor', getClearAlpha: 'setClearColor',
  getMRT: 'setMRT', getRenderObjectFunction: 'setRenderObjectFunction' };
const PROPS = ['autoClear', 'autoClearColor', 'autoClearDepth', 'autoClearStencil', 'toneMapping', 'toneMappingExposure', 'overrideMaterial'];
/**
 * Save-and-restore of a managed field inside one function: the field is read into a holder (a variable, a destructured name, an assignment
 * target, a property of an object literal, or the out-argument of getViewport / getClearColor) and the same function writes that holder back
 * (as the setter's argument or the assigned value). A read only compared, a copy onto another renderer, or a mode that hands its undo to a
 * later closure (core/inspect/debugView.js) is not a borrow.
 * @returns {string[]} 'line: field' per finding
 */
function ownBorrows(sf) {
  const saves = [], writes = [], text = n => n.getText(sf);
  const fnOf = n => { for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p; return sf; };
  const isSet = p => ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  // where a read value lands: its holder's text, or null when it is only used (compared, passed on)
  const holderOf = n => {
    let c = n, p = n.parent;
    while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p))) { c = p; p = p.parent; }
    if (!p) return null;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return text(p.name);
    if (isSet(p) && p.right === c) return text(p.left);
    if (ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.parent)) {
      const d = p.parent.parent;
      return `${d && ts.isVariableDeclaration(d) ? text(d.name) : '?'}.${text(p.name)}`;
    }
    return null;
  };
  const visit = n => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const name = n.expression.name.text, args = n.arguments.map(text);
      if (GETTERS[name]) { const h = [holderOf(n), args[0]].filter(Boolean); if (h.length) saves.push({ fn: fnOf(n), f: GETTERS[name], h, n }); }
      if (Object.values(GETTERS).includes(name)) writes.push({ fn: fnOf(n), f: name, v: args });
    }
    if (ts.isPropertyAccessExpression(n) && PROPS.includes(n.name.text)) {
      const p = n.parent;
      if (isSet(p) && p.left === n) writes.push({ fn: fnOf(n), f: n.name.text, v: [text(p.right)] });
      else { const h = holderOf(n); if (h) saves.push({ fn: fnOf(n), f: n.name.text, h: [h], n }); }
    }
    // const { autoClear } = r: a destructured save, held under its local name
    if (ts.isBindingElement(n) && PROPS.includes(text(n.propertyName ?? n.name))) saves.push({ fn: fnOf(n), f: text(n.propertyName ?? n.name), h: [text(n.name)], n });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return saves.filter(s => writes.some(w => w.fn === s.fn && w.f === s.f && w.v.some(v => s.h.includes(v))))
    .map(s => `${sf.getLineAndCharacterOfPosition(s.n.getStart(sf)).line + 1}: ${s.f}`);
}
const parseText = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);

// engine and effect sources, without tests, docs and examples (those draw on renderers they own)
function sources(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (n.startsWith('.') || ['node_modules', 'tests', 'docs', 'examples', 'types', 'dist'].includes(n)) continue;   // .threedog and dist hold built bundles
    if (statSync(p).isDirectory()) sources(p, out); else if (/\.m?js$/.test(n)) out.push(p);
  }
  return out;
}

export const specs = [
  {
    name: '[guard] render borrow: a draw that throws inside three\'s render leaves target, cube face, mip, viewport, scissor, clear and the rest as before (WebGL and WebGPU)',
    url: PAGE,
    software: true,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      for (let [name, order] of [['gl', 'after'], ['gl', 'own'], ['gpu', 'after'], ['gpu', 'own']]) {
        const r = await ev(([n, o]) => window.borrowCase(n, o), [name, order]);
        name = `${name} (viewport set ${order === 'after' ? 'after' : 'before'} the bind)`;
        check(`${name}: the render really threw inside the borrow`, r.thrown === 'boom inside render', String(r.thrown));
        check(`${name}: the draw really changed the state (target, viewport, clear, scene)`, r.during.target === 'other' && r.during.viewport !== r.before.viewport && r.during.clear !== r.before.clear && r.during.override === null, JSON.stringify(r.during));
        const lost = FIELDS.filter(f => r.after[f] !== r.before[f]);
        check(`${name}: every field is back after the throw`, lost.length === 0, lost.map(f => `${f}: ${r.before[f]} -> ${r.after[f]}`).join('; '));
        check(`${name}: the cube face and mip level came back, not only the target`, r.after.target === 'cube' && r.after.face === 3 && r.after.mip === 1, JSON.stringify(r.after));
        // a nested borrow gives back the outer borrow's state (its clear red, its viewport), not the frame's
        check(`${name}: a nested borrow gives back what the outer borrow had`, r.nested.clear === 'ff0000' && r.nested.target === 'cube' && r.nested.viewport === '0,0,8,8', JSON.stringify(r.nested));
      }
    },
  },
  {
    // 不许绕开: a second save-and-restore of the target anywhere in engine or effect code is the scattered borrowing this replaced
    name: '[guard] render borrow: no engine or post-effects file saves and restores renderer state on its own (only render/backend.js)',
    url: PAGE,
    async run({ check }) {
      // the scan must reject each of these: one per kind of managed field, each the shape a hand-written borrow takes
      const rejected = {
        target: 'function f(r) { const prev = r.getRenderTarget(); r.setRenderTarget(rt); r.render(s, c); r.setRenderTarget(prev); }',
        clear: 'function f(r) { const c = r.getClearColor(new Color()), a = r.getClearAlpha(); r.setClearColor(0, 1); draw(); r.setClearColor(c, a); }',
        clearInto: 'function f(r, was) { const a = r.getClearAlpha(); r.getClearColor(was); r.setClearColor(0, 1); try { draw(); } finally { r.setClearColor(was, a); } }',
        targetInObject: 'function f(r) { const prev = { rt: r.getRenderTarget(), auto: r.autoClear }; r.autoClear = true; draw(); r.setRenderTarget(prev.rt); r.autoClear = prev.auto; }',
        viewport: 'function f(r) { const v = r.getViewport(tmp); r.setViewport(0, 0, 8, 8); draw(); r.setViewport(v); }',
        scissor: 'function f(r) { const t = r.getScissorTest(); r.setScissorTest(true); try { draw(); } finally { r.setScissorTest(t); } }',
        autoClear: 'function f(r) { const { autoClear } = r; r.autoClear = false; draw(); r.autoClear = autoClear; }',
        tone: 'function f(r) { const keep = r.toneMapping; r.toneMapping = 0; draw(); r.toneMapping = keep; }',
        override: 'function f(scene) { const o = scene.overrideMaterial; scene.overrideMaterial = m; draw(); scene.overrideMaterial = o; }',
        threeUtils: 'function f(r) { state = RendererUtils.resetRendererState(r, state); draw(); RendererUtils.restoreRendererState(r, state); }',
      };
      const scan = sf => [...ownBorrows(sf), ...(/RendererUtils\.(save|reset|restore)Renderer/.test(sf.text) ? ['RendererUtils'] : [])];
      const missed = Object.entries(rejected).filter(([k, code]) => scan(parseText(k + '.js', code)).length === 0).map(([k]) => k);
      check('the scan rejects a hand-written save / restore of every managed field (target, clear, viewport, scissor, autoClear, tone, override, RendererUtils), in a variable, an object or an out-argument', missed.length === 0, missed.join(', '));
      const passes = ['function f(r) { if (r.toneMapping !== 0) r.autoClear = false; r.setRenderTarget(null); }',   // compared, and a write with nothing saved
        'function f(old, r) { r.toneMapping = old.toneMapping; r.setClearColor(old.getClearColor(c), old.getClearAlpha()); }',   // a copy onto a new renderer
        'function f(scene) { const was = scene.overrideMaterial; scene.overrideMaterial = m; return () => { scene.overrideMaterial = was; }; }'];   // a mode with its undo
      const flagged = passes.filter((code, i) => scan(parseText(`ok${i}.js`, code)).length);
      check('and passes a compared read, a copy onto another renderer and a mode that returns its undo', flagged.length === 0, flagged.join(' / '));
      const files = [...sources(join(ROOT, 'engine')), ...sources(join(ROOT, 'post-effects'))];
      const own = files.filter(f => !f.endsWith(join('render', 'backend.js'))).flatMap(f => scan(parseText(f, readFileSync(f, 'utf8'))).map(x => `${relative(ROOT, f)}:${x}`));
      check(`${files.length} files read; save / restore of renderer state only through render/backend.js borrowRenderer`, files.length > 100 && own.length === 0, own.join(', '));
    },
  },
  {
    name: '[guard] render borrow, ray BVH: addStatic\'s boundsTree and raycast show in threePatches, and the last registration going gives the raycast back',
    url: PAGE,
    software: true,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const r = await ev(() => window.rayCase());
      check('describe().threePatches lists ray-bvh, undoable, with what is lost', r.listed?.offable && r.listed.scope === 'objects in the scene' && /slower/.test(r.listed.lost), JSON.stringify(r.listed));
      check('a registered big mesh gets a BVH and its own raycast; a game\'s raycast override is left alone', r.on.big && r.on.tree && r.on.mine, JSON.stringify(r.on));
      check('one of two meshes on a geometry leaving: its raycast is back, the tree stays for the other', !r.half.big && r.half.tree && r.half.shared, JSON.stringify(r.half));
      check('the last leaving: raycast back on both, the tree Rays built dropped, the game\'s override untouched', !r.off.big && !r.off.shared && !r.off.tree && r.off.mine && !r.off.mineTree, JSON.stringify(r.off));
      check('a tree the game built stays after a geometry dispose unregisters the mesh; its raycast comes back', r.disposed.fast && !r.disposed.raycast && r.disposed.tree && r.disposed.statics === 0, JSON.stringify(r.disposed));
    },
  },
];
