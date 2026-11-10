// R23 nothing private in the publishable files: packages/** and the root config (package.json, tsconfig.json, .gitignore, READMEs, CLAUDE.md, ASSETS.md).
// Detection (error), line by line on text files:
//   · absolute local paths (a drive letter + \Users\, /Users/…, /home/…) and the current OS user name
//   · e-mail addresses
//   · secrets: api_key / secret / password = "…", sk-…, ghp_…, AKIA…, PRIVATE KEY blocks; any .env* file
//   · generated engine docs (packages/engine/docs, example GAMEMAPs, llms.txt) naming a folder of games/ (games are private)
// Allowed: LICENSE files, and the repository / author / homepage / bugs fields of package.json. Known limits: binary files are not read;
//   a secret split over two lines is not seen.
import { existsSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { userInfo } from 'node:os';
import { walk, read, abs, P } from './_lib.mjs';

const TEXT = ['.js', '.mjs', '.ts', '.json', '.md', '.html', '.txt', '.css', '.svg', '.yml', '.yaml'];
const ROOT_FILES = ['package.json', 'tsconfig.json', '.gitignore', 'README.md', 'README.zh-CN.md', 'CLAUDE.md', 'ASSETS.md'];
const PKG_FIELDS = /^\s*"(repository|author|homepage|bugs|url)"\s*:/;
// On CI the user is the machine's own account (GitHub's is 'runner', a word the docs use), so the name protects nothing there
let user = ''; try { if (!process.env.CI) user = userInfo().username; } catch { /* no user info */ }
const PATTERNS = [
  [/\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s'"`]+/, 'absolute local path'],
  [/(?<![\w.])\/(Users|home)\/[A-Za-z][\w.-]+/, 'absolute local path'],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}\b/i, 'e-mail address'],
  [/\b(api[_-]?key|secret|passw(or)?d)\s*[:=]\s*['"][^'"\s]{8,}/i, 'secret value'],
  [/\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/, 'access key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  ...(user.length >= 3 ? [[new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the local user name']] : []),
];

export default {
  id: 'R23', title: 'Publishable files carry no paths, e-mails, secrets or game names',
  run() {
    const out = [];
    const files = [...ROOT_FILES.filter(f => existsSync(abs(f))), ...walk('packages', TEXT)];
    // the file NAME is checked at any depth (packages/tools/.env too), whatever its extension: the TEXT filter above only decides which files are read
    for (const f of [...readdirSync(abs('.')), ...walk('packages', [''])].filter(n => /^\.env/.test(basename(n))))
      out.push({ level: 'error', file: f, line: 0, msg: 'an .env file in a publishable folder', fix: 'delete it or move it out of the repository (.gitignore lists .env*)' });
    for (const f of files) {
      if (basename(f) === 'LICENSE' || /package-lock\.json$/.test(f)) continue;
      read(f).split('\n').forEach((line, i) => {
        if (basename(f) === 'package.json' && PKG_FIELDS.test(line)) return;
        for (const [re, what] of PATTERNS) if (re.test(line)) {
          out.push({ level: 'error', file: f, line: i + 1, msg: `${what}: ${line.trim().slice(0, 80)}`, fix: 'remove it from published files (use a placeholder such as <user> or example.com)' });
          break;
        }
      });
    }
    // generated engine docs must not name a private game
    const games = existsSync(abs(P.GAMES_REL)) ? readdirSync(abs(P.GAMES_REL), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : [];
    if (games.length) {
      const gen = [...walk(P.DOCS_REL, ['.md']).filter(f => P.GENERATED.some(r => r.test(f))), ...walk(P.EXAMPLES_REL, ['.md']).filter(f => f.endsWith('GAMEMAP.md')), `${P.ENGINE_REL}/llms.txt`].filter(f => existsSync(abs(f)));
      const re = new RegExp(`games/(${games.map(g => g.replace(/[-]/g, '\\-')).join('|')})\\b`);
      for (const f of gen) read(f).split('\n').forEach((line, i) => {
        if (re.test(line)) out.push({ level: 'error', file: f, line: i + 1, msg: `generated engine doc names a private game: ${line.match(re)[0]}`, fix: 'the generator must scan the engine only (see codemap.mjs); then npm run map' });
      });
    }
    // Shipped engine code (examples included, tests excluded) must not import a private workspace package ("private": true, never published):
    // the import resolves inside this repository and breaks for every user who installs the engine. Checked here because the outside-the-repo
    // install test (pack-external) is slow and rarely run.
    if (P.MODE === 'monorepo') {
      const priv = files.filter(f => basename(f) === 'package.json').map(f => { try { return JSON.parse(read(f)); } catch { return {}; } })
        .filter(p => p.private && p.name).map(p => p.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
      const re = priv.length && new RegExp(`(?:from|import)\\s*\\(?\\s*['"](${priv.join('|')})(?:['"/])`);
      if (re) for (const f of walk(P.ENGINE_REL, ['.js', '.mjs', '.ts']).filter(f => !P.under(f, P.ENGINE_TESTS_REL))) read(f).split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line) || !re.test(line)) return;
        out.push({ level: 'error', file: f, line: i + 1, msg: `published engine file imports the private package ${line.match(re)[1]}`,
          fix: "give the file its own copy (an example keeps its picture in its own picture/ folder) or move it under tests/" });
      });
    }
    out.note = `${files.length} publishable files scanned`;
    return out;
  },
};
