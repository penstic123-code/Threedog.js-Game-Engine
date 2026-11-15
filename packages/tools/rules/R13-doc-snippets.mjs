// R13 type-check of code blocks in docs: the ```js blocks in packages/engine/docs/recipes/*.md and packages/engine/docs/api/*.md are copied by the AI;
// if an API is renamed or its parameters change and the docs lag behind, the copy is wrong. Each block is extracted into its own temporary .js file and checked by TypeScript against the engine d.ts.
// Handling incomplete snippets:
//   - ```js fragment blocks are read too: the mark means "not run as it stands" (the doc-run spec skips them), and undefined names are no error here, so its calls stay checked
//   - a prelude declaration file provides the usual top-level variables: engine / e (Engine), THREE (any), dt (number), opts / game (any)
//   - import 'threedog' and 'xxx/engine/index.js' (any relative path) are redirected to the real packages/engine/index.js: a block importing from 'threedog' was typed any, so
//     createEngine({ style }) and interactions({ keys }) passed. Other unresolved imports and undefined names (TS2304/2552/2307) are not reported
//   - an option a function does not take (TS2353, TS2561 with a "did you mean") is an error, the rest warnings: it throws when copied, so it is a block that can never run
//   - a canary block with a wrong option runs with the docs and must be reported, else this rule is the error: it once went blind on Windows, where the engine's path in
//     the import strings held backslashes, every block was typed any, and nobody could tell from its output
//   - a relative import into a folder the game template does not have (./style/index.js) is an error: the copy fails on load
//   - blocks with syntax errors (with … ellipses, or just a piece of an object) are skipped whole and only counted in the summary
//   - web (DOM) type errors are not reported (same as npm run types)
//   - three.js addons ('three/addons/*') are untyped here (an ambient declaration), so a class that extends one is not reported for the members it inherits
//   - two plain-JS limits are not reported, because TypeScript cannot tell a doc mistake from them: a property of a subclass read off a base-class type
//     ('Property color does not exist on type Material': engine.water.material is typed as Material), and an object literal whose string literal was
//     widened to string before it met a named literal union (`type: 'rules'` against ModuleType; a wrong name is still caught by the engine at install)
// Output: doc file + block number + line within the block + the reason (TypeScript's original text).
// Limitation: variables without a type (such as const npc = … inside the snippet) are only checked as far as the d.ts lets TypeScript infer.
import { mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ts, walk, read, abs, dtsFiles, P } from './_lib.mjs';

// Allowlist: [doc file, block number (from 1), fragment of the original error text (null = skip the whole block), reason]
const ALLOW = [
  [`${P.RECIPES_REL}/11-physics.md`, 1, "'number | boolean'", 'in JS, [[x, z, true, false]].map(([x, z, steer, drive]) => …) destructuring is inferred as (number|boolean), a TypeScript inference limit, not a doc mistake'],
];
// the folders of templates/game
const TEMPLATE_DIRS = new Set(readdirSync(abs(`${P.TOOLS_REL}/templates/game`), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name));
// forward slashes: it goes inside an import string, where a Windows backslash is an escape and the import silently stops resolving
const INDEX = abs(P.INDEX_JS_REL).replaceAll('\\', '/');
const CANARY = '<canary>';
const IGNORE_CODES = new Set([18004, 2304, 2552, 2307, 2792, 2583, 2580, 1375, 1378, 2451, 2300, 2393]);
// The two plain-JS limits of the header are not matched by shape alone, so a typo (`mesh.postion`) or a wrong type ('string' to 'Vector3') is still reported:
// the property name must really exist on a three.js subclass of the base type, and the alias must really be a string-literal union (both asked of the checker in run()).
const PROP_LIMIT = /Property '(\w+)' does not exist on type '(?:Material|Object3D|Light)<[^']*>'/;
const STR_LIMIT = /Type 'string' is not assignable to type '(\w+)'/;
const BASES = new Set(['Material', 'Object3D', 'Light']);
// slot names a doc may write: patch slots (render/slots.js) and post-effect slots (render/PostFX.js)
const slotNames = () => new Set([...read(`${P.ENGINE_REL}/render/slots.js`).matchAll(/^  (\w+): +\{ stage/gm)].map(m => m[1])
  .concat(read(`${P.ENGINE_REL}/render/PostFX.js`).match(/const SLOTS = \[([^\]]*)\]/)?.[1].match(/\w+/g) ?? []));
const DOM = /HTML\w*Element|CSSStyleDeclaration|EventTarget|'Element'|Window|globalThis|'Document'/;

export default {
  id: 'R13', title: 'Type-check of doc code blocks',
  run() {
    // also the pages a newcomer reads first (root and package READMEs, the conventions, the three.js and command pages): they hold js blocks too and were unchecked
    const front = ['README.md', 'README.zh-CN.md', `${P.ENGINE_REL}/README.md`, `${P.DOCS_REL}/CONVENTIONS.md`, `${P.DOCS_REL}/THREE.md`, `${P.DOCS_REL}/COMMANDS.md`,
      'packages/post-effects/README.md', 'packages/terrain-noise/README.md', 'packages/tools/README.md'].filter(f => existsSync(abs(f)));
    const docs = [...front, ...walk(P.RECIPES_REL, ['.md']), ...walk(P.API_DIR_REL, ['.md'])];
    const slots = slotNames();
    const dir = mkdtempSync(join(tmpdir(), 'threedog-r13-'));
    const blocks = [], bad = [];   // { doc, n, startLine, file }; findings made while reading the blocks
    try {
      for (const doc of docs) {
        const L = read(doc).split('\n');
        let inBlock = false, start = 0, buf = [], n = 0;
        L.forEach((line, i) => {
          if (!inBlock && /^\s*```js(\s+fragment)?\s*$/.test(line)) { inBlock = true; start = i + 2; buf = []; n++; return; }
          if (inBlock && /^\s*```\s*$/.test(line)) {
            inBlock = false;
            if (ALLOW.some(([d, k, frag]) => d === doc && k === n && frag == null)) return;
            const code = buf.join('\n').replace(/(from\s+|import\s*\(\s*)(['"])(?:[^'"]*engine\/index\.js|@threedog\/engine|threedog)\2/g, (m, a, q) => `${a}${q}${INDEX}${q}`);
            for (const m of code.matchAll(/\bfrom\s+['"]\.\/([\w-]+)\/[^'"]+['"]/g)) if (!TEMPLATE_DIRS.has(m[1])) bad.push({ level: 'error', file: doc, line: start + code.slice(0, m.index).split('\n').length - 1, msg: `js code block #${n}: imports ./${m[1]}/, a folder new games do not have`, fix: `use a folder of the game template (${[...TEMPLATE_DIRS].join(', ')})` });
            for (const m of code.matchAll(/\bslot:\s*'([^']+)'/g)) if (!slots.has(m[1])) bad.push({ level: 'error', file: doc, line: start + code.slice(0, m.index).split('\n').length - 1, msg: `js code block #${n}: '${m[1]}' is not a slot name`, fix: `use one of: ${[...slots].join(', ')}` });
            const file = join(dir, `${doc.replace(/[/.]/g, '_')}__${n}.js`);
            writeFileSync(file, code + '\nexport {};\n');
            blocks.push({ doc, n, startLine: start, file });
            return;
          }
          if (inBlock) buf.push(line);
        });
      }
      const canary = join(dir, 'canary.js');
      writeFileSync(canary, `import { createEngine } from '${INDEX}';\ncreateEngine({ canvas: null, notAnOption: 1 });\nexport {};\n`);
      blocks.push({ doc: CANARY, n: 1, startLine: 1, file: canary });
      const prelude = join(dir, 'prelude.d.ts');
      writeFileSync(prelude, `import type { Engine } from '${INDEX}';\ndeclare global {\n  const engine: Engine;\n  const e: Engine;\n  const THREE: any;\n  const dt: number;\n  const opts: any;\n  const game: any;\n}\nexport {};\n`);
      const ambient = join(dir, 'ambient.d.ts');
      writeFileSync(ambient, "declare module 'three/addons/*';" + String.fromCharCode(10));
      const program = ts.createProgram([prelude, ambient, ...dtsFiles().map(abs), ...blocks.map(b => b.file)], {
        allowJs: true, checkJs: true, noEmit: true, strict: false, noImplicitAny: false, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], types: [],
      });
      const out = bad, checker = program.getTypeChecker();
      // asked of the checker, once and only when needed: member names of classes extending Material / Object3D / Light, and aliases that are string-literal unions
      let subProps = null, literalAliases = null;
      const scan = () => {
        subProps = new Set(); literalAliases = new Set();
        const extendsBase = t => !!t.symbol && (t.objectFlags & ts.ObjectFlags.ClassOrInterface) && checker.getBaseTypes(t).some(b => BASES.has(b.symbol?.name) || extendsBase(b));
        for (const f of program.getSourceFiles()) {
          if (!f.isDeclarationFile) continue;
          const isThree = /[\\/](?:three|@types[\\/]three)[\\/]/.test(f.fileName);
          const go = n => {
            if (isThree && ts.isClassDeclaration(n) && n.name) {
              const t = checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(n.name));
              if (t && extendsBase(t)) for (const p of checker.getPropertiesOfType(t)) subProps.add(p.name);
            } else if (ts.isTypeAliasDeclaration(n)) {
              const t = checker.getTypeAtLocation(n.name);
              if (t.isUnion() && t.types.every(x => x.flags & ts.TypeFlags.StringLiteral)) literalAliases.add(n.name.text);
            } else if (ts.isModuleDeclaration(n) && n.body) ts.forEachChild(n.body, go);
          };
          ts.forEachChild(f, go);
        }
      };
      const jsLimit = msg => {
        const pm = msg.match(PROP_LIMIT), sm = msg.match(STR_LIMIT);
        if (!pm && !sm) return false;
        if (!subProps) scan();
        return pm ? subProps.has(pm[1]) : literalAliases.has(sm[1]);
      };
      let skipped = 0, sang = false;
      for (const b of blocks) {
        const sf = program.getSourceFile(b.file);
        if (program.getSyntacticDiagnostics(sf).length) { skipped++; continue; }
        for (const d of program.getSemanticDiagnostics(sf)) {
          if (IGNORE_CODES.has(d.code)) continue;
          if (b.doc === CANARY) { sang = true; continue; }
          const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ');
          if (DOM.test(msg) || jsLimit(msg) || ALLOW.some(([doc, k, frag]) => doc === b.doc && k === b.n && frag && msg.includes(frag))) continue;
          const line = d.start != null ? sf.getLineAndCharacterOfPosition(d.start).line : 0;
          const src = sf.text.split('\n')[line]?.trim().slice(0, 60);
          out.push({ level: 'error', file: b.doc, line: b.startLine + line, msg: `js code block #${b.n}: ${msg.slice(0, 160)} (TS${d.code})  ${src}`,
            fix: 'follow the d.ts (the matching page in packages/engine/docs/api/) and fix the doc; if the d.ts is missing it, fix the d.ts and run npm run map' });
        }
      }
      if (!sang) out.push({ level: 'error', file: P.RECIPES_REL, line: 0, msg: 'R13 no longer sees the engine types: a canary block with a wrong option passed, so doc blocks are unchecked', fix: 'see how the block imports resolve in R13-doc-snippets.mjs' });
      out.note = `checked ${blocks.length} code blocks (${docs.length} docs), skipped ${skipped} with syntax errors (snippets/ellipses)`;
      return out;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
