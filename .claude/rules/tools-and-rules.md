---
paths:
  - "packages/tools/**"
---

# Tools package and rule checks

- `packages/tools/paths.mjs` is the single source of truth for paths. When adding a new directory, change it and the root `tsconfig.json` first.
- The tools run in the monorepo and in a game installed from npm (`project()` in paths.mjs: MODE `monorepo` / `game`, the engine found with createRequire). Never import the engine or the tools across packages by a relative path (R24); `npm test -- pack-external` runs the CLI in a temp project outside the repo.
- Shared helpers, not copies: `lib/text.mjs` (walk with one skip set, summary, splitTop, closest), `lib/proc.mjs` (npm without a shell), `lib/cli-args.mjs` (page path and option parsing: an unknown option fails with the list), `browser.mjs` (Chromium args, game page, build + preview on a free port).
- Each rule file `packages/tools/rules/R*.mjs` starts with a "Detection:" comment that says what it flags and its known limits. Register a new rule in `rules/index.mjs`.
- Rules that read documentation text (R07 reads `.claude/rules/api-design.md`, section `## Interface conventions`, the line starting `Cancel convention:`) must fail loudly when the text is missing, not skip silently.
- Output text of generators and CLI commands is English.
