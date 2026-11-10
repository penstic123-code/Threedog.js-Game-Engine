// Resource lifetime (design.md 6.2, docs/plans/2026-11-09-resource-lifetime.md): whoever made a GPU resource frees it, an asset load owns what it loaded,
// scene teardown and engine.dispose give back references and leases and free only what the engine made. Model prototypes are engine.assets', held by
// consumers and given back when the last one lets go, on a palette write and on a hot swap. Headless engines on the loading test page.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import ts from 'typescript';

const root = new URL('../../', import.meta.url);
const read = f => readFileSync(new URL(f, root), 'utf8');
/** every .js under a folder of packages/engine */
const jsUnder = dir => readdirSync(new URL(dir, root)).flatMap(n => {
  const f = `${dir}/${n}`;
  return statSync(new URL(f, root)).isDirectory() ? jsUnder(f) : n.endsWith('.js') ? [f] : [];
});

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const page = '/tests/loading/index.html';

/**
 * Every .dispose() call inside a walk of an object tree, parsed (not matched by line): a callback of traverse / traverseVisible / traverseAncestors or of
 * children.forEach, a function that calls itself and reads .children, or a loop over .children. Returns 'file:line (kind)' per hit.
 */
function disposalWalks(src, file) {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true), out = [];
  const nameOf = fn => fn.name?.getText() ?? (fn.parent && ts.isVariableDeclaration(fn.parent) ? fn.parent.name.getText() : null);
  const callsSelf = fn => {
    const n = nameOf(fn); let hit = false;
    // a call or a hand-off (children.map(walk)) of the function itself; c.watch.remove() inside a method named remove is another object's
    const go = x => { if (ts.isIdentifier(x) && x.text === n && !(ts.isPropertyAccessExpression(x.parent) && x.parent.name === x)) hit = true; ts.forEachChild(x, go); };
    if (n && fn.body) go(fn.body);
    return hit;
  };
  const kind = node => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isFunctionLike(p)) {
        const c = p.parent, callee = c && ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression) ? c.expression : null;
        if (callee && (/^traverse(Visible|Ancestors)?$/.test(callee.name.text) || (callee.name.text === 'forEach' && /\.children\b/.test(callee.expression.getText())))) return `${callee.name.text} callback`;
        if (callsSelf(p) && /\.children\b/.test(p.body.getText())) return 'recursive walk';
      }
      if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && /\.children\b/.test(p.expression.getText())) return 'loop over children';
      if ((ts.isForStatement(p) || ts.isWhileStatement(p)) && /\.children\b/.test((p.condition ?? p.expression)?.getText() ?? '')) return 'loop over children';
    }
    return null;
  };
  const go = n => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'dispose') {
      const k = kind(n); if (k) out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} (${k})`);
    }
    ts.forEachChild(n, go);
  };
  go(sf);
  return out;
}

export const specs = [
  // 不许绕开: the scene, engine.dispose, the asset cache and modules free GPU parts of a tree through one helper with an owner test (core/base/freeParts.js);
  // a walk with its own rule is how the game's material got freed at engine.dispose and an asset's shared material twice
  {
    name: '[guard] resource lifetime: only freeParts disposes scene parts in a walk, and prototype consumers hold through ctx',
    url: page,
    async run({ check }) {
      const walks = ['core', 'render', 'modules'].flatMap(jsUnder).filter(f => f !== 'core/base/freeParts.js').flatMap(f => disposalWalks(read(f), f));
      check('no file in core/, render/ or modules/ disposes inside a walk of an object tree besides core/base/freeParts.js', !walks.length, walks.join(', '));
      // the ways around a line match: each must be caught
      const bypass = {
        multiLine: 'root.traverse(o => {\n  if (o.isMesh) {\n    o.material.dispose();\n  }\n});',
        recursion: 'function walk(o) { o.geometry?.dispose(); for (const c of o.children) walk(c); }',
        arrowRecursion: 'const walk = o => { o.geometry.dispose(); o.children.map(walk); };',
        forOf: 'for (const c of root.children) c.geometry.dispose();',
        forEach: 'group.children.forEach(c => c.material.dispose());',
        indexLoop: 'for (let i = 0; i < g.children.length; i++) g.children[i].geometry.dispose();',
        visible: 'root.traverseVisible(function (o) { o.geometry.dispose(); });',
      };
      const missed = Object.entries(bypass).filter(([, src]) => !disposalWalks(src, 'x.js').length).map(([k]) => k);
      check('the guard catches multi-line callbacks, recursion and loops over children', !missed.length, missed.join(', '));
      check('a plain dispose outside a walk is not a hit', !disposalWalks('this._mat.dispose(); for (const m of this._copies.values()) m.dispose();', 'x.js').length);
      const users = ['core/scene/sceneMethods.js', 'core/engine/lifecycle.js', 'core/assets/assetEntry.js'].filter(f => !/\bfreeParts\(/.test(read(f)));
      check('engine.remove, engine.dispose and the asset cache all call freeParts', !users.length, users.join(', '));
      const holders = ['modules/content/index.js', 'modules/gameplay/pickups.js'].filter(f => !/ctx\.track\(holdProtos\(/.test(read(f)));
      check('every protoOf consumer module lets go through ctx.track(holdProtos(...))', !holders.length, holders.join(', '));
      // assets.shared means "an asset load owns it and frees it": a module's own material put there is freed by nobody (keepPart is for that)
      const sharers = ['core', 'render', 'modules'].flatMap(jsUnder).filter(f => f !== 'core/assets/assetEntry.js' && /\bshared\.add\(/.test(read(f)));
      check('only assetEntry.js adds to assets.shared', !sharers.length, sharers.join(', '));
    },
  },
  {
    name: 'resource lifetime: engine.dispose frees what the engine made, never the game\'s, and an asset\'s shared parts once',
    url: page,
    async run({ check, ev }) {
      const r = await ev(async png => {
        const T = __threedogThree, { make, gltfUrl, engineOwned, neutralMaterial, markEngineMade, keepPart } = threedogLoad;
        const E = make('rl-dispose', { ui: { loading: false } }); await E.start();
        const n = new Map(), watch = (k, x) => { n.set(k, 0); x.addEventListener('dispose', () => n.set(k, n.get(k) + 1)); return x; };
        // the game's own: one mesh by engine.add, one by plain scene.add, sharing a material with a texture
        const gTex = watch('gameTexture', new T.Texture()), gMat = watch('gameMaterial', new T.MeshStandardMaterial({ map: gTex }));
        E.add(new T.Mesh(watch('gameGeometry', new T.BoxGeometry()), gMat));
        E.scene.add(new T.Mesh(new T.BoxGeometry(), gMat));
        // the engine's own: an object a module put in the scene, with an engine-made material. The game's texture also sits on it (and on gMat): the
        // material being the engine's says nothing about the texture. An engine-made texture on it goes with it
        const eTex = watch('engineTexture', markEngineMade(new T.Texture()));
        E.scene.add(engineOwned('rl', new T.Mesh(watch('engineGeometry', new T.BoxGeometry()), watch('engineMaterial', neutralMaterial('rl', { map: gTex, emissiveMap: eTex })))));
        // a kept part (a module's material many of its objects share, freed by that module): neither engine.remove nor engine.dispose frees it
        const keptMat = watch('keptMaterial', keepPart(neutralMaterial('rl-kept')).part);
        const k1 = new T.Mesh(new T.BoxGeometry(), keptMat); E.add(k1); E.remove(k1);
        E.scene.add(engineOwned('rl', new T.Mesh(new T.BoxGeometry(), keptMat)));
        // engine.remove(a, b) of two roots sharing a material and a geometry: each freed once
        const sMat = watch('pairMaterial', new T.MeshBasicMaterial()), sGeo = watch('pairGeometry', new T.BoxGeometry()), pa = new T.Mesh(sGeo, sMat), pb = new T.Mesh(sGeo, sMat);
        E.add(pa); E.add(pb); E.remove(pa, pb);
        // an asset's: two copies of one file whose material has a texture
        E.assets.manifest({ models: { tri: gltfUrl(png) } });
        const a = await E.assets.model('tri'), b = await E.assets.model('tri');
        E.add(a); E.add(b);
        let m = null; a.traverse(o => { if (o.isMesh) m = o.material; });
        watch('assetMaterial', m); if (m.map) watch('assetTexture', m.map);
        const leases = E.assets._users('tri');
        E.dispose();
        return { n: Object.fromEntries(n), leases, hadMap: !!m.map, gameUsable: gMat.map === gTex };
      }, PNG);
      check('the game\'s material, texture and geometry are not disposed by engine.dispose()', r.n.gameMaterial === 0 && r.n.gameTexture === 0 && r.n.gameGeometry === 0 && r.gameUsable, JSON.stringify(r));
      check('what the engine made in the scene is disposed, once, an engine-made texture on it too', r.n.engineMaterial === 1 && r.n.engineGeometry === 1 && r.n.engineTexture === 1, JSON.stringify(r.n));
      check('a kept part is left by engine.remove and engine.dispose (its maker frees it)', r.n.keptMaterial === 0, JSON.stringify(r.n));
      check('engine.remove(a, b) frees a material and a geometry both roots share once', r.n.pairMaterial === 1 && r.n.pairGeometry === 1, JSON.stringify(r.n));
      check('a material two asset copies share is disposed exactly once (by the asset cache), its texture too', r.leases === 2 && r.n.assetMaterial === 1 && (!r.hadMap || r.n.assetTexture === 1), JSON.stringify(r));
    },
  },
  {
    name: 'resource lifetime: a material two meshes of one model share is freed once on release; engine.remove frees what the game handed over',
    url: page,
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = __threedogThree, E = threedogLoad.make('rl-release', { ui: { loading: false } }); await E.start();
        const out = { shared: 0, handed: 0 };
        const build = () => {
          const mat = new T.MeshBasicMaterial(); mat.addEventListener('dispose', () => out.shared++);
          const g = new T.Group(); g.add(new T.Mesh(new T.BoxGeometry(), mat), new T.Mesh(new T.BoxGeometry(), mat)); return g;
        };
        E.assets.manifest({ models: { pair: { build, cache: false } } });
        const c = await E.assets.model('pair'); E.add(c);
        E.remove(c); E.assets.release('pair');
        const mine = new T.MeshBasicMaterial(); mine.addEventListener('dispose', () => out.handed++);
        const mesh = new T.Mesh(new T.BoxGeometry(), mine); E.add(mesh); E.remove(mesh);
        E.dispose();
        return out;
      });
      check('release frees a material shared by two meshes of the model exactly once', r.shared === 1, JSON.stringify(r));
      check('engine.remove(mesh) is the game handing it over: its unused material is disposed once', r.handed === 1, JSON.stringify(r));
    },
  },
  {
    name: 'resource lifetime: a prototype\'s lease goes back when its consumer lets go, on a palette write and on a hot swap',
    url: page,
    async run({ check, ev }) {
      const r = await ev(async png => {
        const T = __threedogThree, { make, gltfUrl, protoOf, holdProtos, protoSlots } = threedogLoad;
        const tick = () => new Promise(res => setTimeout(res, 0));
        const E = make('rl-proto', { ui: { loading: false } }); await E.start();
        const A = E.assets, out = {};
        // a file prototype, held by two consumers: one copy (one lease) for both
        A.manifest({ name: 'rl', models: { rock: gltfUrl(), box: function () { return new T.Mesh(new T.BoxGeometry(), new T.MeshBasicMaterial({ color: this.palette.hue ?? 0x123456 })); } } });
        const c1 = {}, c2 = {}, h1 = holdProtos(E, c1), h2 = holdProtos(E, c2);
        const p1 = await protoOf(E, c1, 'rock'), p2 = await protoOf(E, c2, 'rock');
        out.shared = p1 === p2; out.held = A._users('rock');
        // hot swap twice: the old prototype's lease goes back each time, so the old file's load is freed and nothing waits in retired
        let freedOld = 0; p1.obj.traverse(o => { if (o.isMesh) o.geometry.addEventListener('dispose', () => freedOld++); });
        await E.debug.reloadAssets({ name: 'rl', models: { rock: gltfUrl(png) } });
        await E.debug.reloadAssets({ name: 'rl', models: { rock: gltfUrl() } });
        await tick();
        out.afterSwap = { users: A._users('rock'), retired: A._retired.size, freedOld, slots: protoSlots(E).length };
        // a palette write rebuilds a generator's prototype for the same holders; the table does not grow
        await protoOf(E, c1, 'box');
        A.palette.hue = 0xff0000;
        await protoOf(E, c1, 'box');
        out.afterPalette = { slots: protoSlots(E).length, boxHolders: protoSlots(E).find(([k]) => k === '"box"')?.[1].holders.size };
        // a bare-geometry generator: the prototype wraps it in a neutral material it made itself, freed when the prototype retires (no copy draws it)
        A.manifest({ name: 'rl2', models: { bare: () => new T.BoxGeometry() } });
        const pBare = await protoOf(E, c1, 'bare');
        let bareFreed = 0; pBare.obj.material.addEventListener('dispose', () => bareFreed++);
        h1.remove(); await tick();
        out.bare = { fromGeometry: pBare.fromGeometry, freed: bareFreed };
        // both consumers unload: the lease is gone and trim frees the file
        out.oneLeft = A._users('rock');   // h1 let go above; c2 still holds rock
        h2.remove(); await tick();
        // a build that resumes after its module unloaded asks again: refused (never settles), and it takes no lease
        let late = 'pending'; protoOf(E, c2, 'rock').then(() => { late = 'settled'; }); await tick();
        out.end = { users: A._users('rock'), slots: protoSlots(E).length, late, trimmed: A.trim().includes('rock') };
        E.dispose();
        return out;
      }, PNG).catch(err => ({ err: String(err) }));
      check('two consumers share one prototype, one lease', r.shared === true && r.held === 1, JSON.stringify(r));
      check('hot swap twice: still one lease, the old file freed, nothing left waiting', r.afterSwap?.users === 1 && r.afterSwap.retired === 0 && r.afterSwap.freedOld >= 1 && r.afterSwap.slots === 1, JSON.stringify(r.afterSwap ?? r));
      check('a palette write keeps one prototype per model and carries its holders', r.afterPalette?.slots === 2 && r.afterPalette.boxHolders === 1, JSON.stringify(r.afterPalette ?? r));
      check('a bare-geometry prototype frees the neutral material it made when it retires', r.bare?.fromGeometry === true && r.bare.freed === 1, JSON.stringify(r.bare ?? r));
      check('after both consumers let go: no lease, no prototype, and trim() frees the model', r.oneLeft === 1 && r.end?.users === 0 && r.end.slots === 0 && r.end.trimmed, JSON.stringify(r));
      check('a protoOf from a holder that let go is refused and takes no lease', r.end?.late === 'pending' && r.end.users === 0 && r.end.slots === 0, JSON.stringify(r.end ?? r));
    },
  },
  {
    name: 'resource lifetime: a retired prototype\'s material goes with its last copy; a sky panorama copy is detached before it is freed; a released keep is ordinary again',
    url: page, expectErrors: /404|Not Found|Failed to load resource/,   // the skybox file never exists: only the wait for it matters
    async run({ check, ev }) {
      const r = await ev(async () => {
        const T = __threedogThree, { make, protoOf, holdProtos, copyLeft, sky, characters } = threedogLoad, tick = () => new Promise(res => setTimeout(res, 0)), out = {};
        const E = make('rl-defer', { ui: { loading: false } }); E.use(sky(), characters()); await E.start();
        // 1. a palette write retires a bare-geometry prototype while a placed copy still draws its neutral material
        E.assets.manifest({ name: 'rl3', models: { flat: () => new T.BoxGeometry() } });
        const c = {}; holdProtos(E, c);
        const p = await protoOf(E, c, 'flat'), mat = p.obj.material;
        let freed = 0; mat.addEventListener('dispose', () => freed++);
        const copy = new T.Mesh(p.obj.geometry, mat); E.scene.add(copy);
        E.assets.palette.tone = 1; await protoOf(E, c, 'flat'); await tick();
        out.whileDrawn = freed;
        E.remove(copy); await tick();   // engine.remove leaves it (the prototype table holds it); copyLeft is what content / pickups call
        out.afterRemove = freed;
        copyLeft(E); await tick();
        out.afterLast = freed;
        // 2. a game's plain texture as the sky, then a skybox asset that is still loading: the panorama copy leaves the background before it is freed
        const gameTex = new T.Texture();
        E.sky.replace(gameTex);
        const panorama = E.scene.background;
        let panFreed = 0; panorama.addEventListener('dispose', () => panFreed++);
        E.assets.manifest({ name: 'rl4', textures: { rlSky: '/textures/rl-never-there.png' } });
        E.sky.replace('rlSky');
        out.sky = { copy: panorama !== gameTex, freed: panFreed, stillShown: E.scene.background === panorama || E.sky.skybox === panorama };
        // 3. a game material given to characters, then replaced: characters no longer holds it, so engine.remove frees it like any game material
        const m1 = new T.MeshStandardMaterial(), m2 = new T.MeshStandardMaterial();
        let m1Freed = 0; m1.addEventListener('dispose', () => m1Freed++);
        E.characters.material = m1; E.characters.material = m2;
        const mesh = new T.Mesh(new T.BoxGeometry(), m1); E.add(mesh); E.remove(mesh);
        out.released = m1Freed;
        E.dispose();
        return out;
      }).catch(err => ({ err: String(err) }));
      check('a retired prototype\'s material stays while a copy draws it and is freed once its last copy leaves', r.whileDrawn === 0 && r.afterRemove === 0 && r.afterLast === 1, JSON.stringify(r));
      check('a panorama copy is detached before it is freed (a frame during the next load never shows it)', r.sky?.copy === true && r.sky.freed === 1 && r.sky.stillShown === false, JSON.stringify(r.sky ?? r));
      check('a game material characters let go of is ordinary again: engine.remove frees it', r.released === 1, JSON.stringify(r));
    },
  },
];
