# Deploy: put the built game on a web server, at the site root or under a sub-path

> **Covers:** putting the built game on a web server, at the root or under a sub-path.
> **Use when:** publishing the game.
> **Shortest:** `npm run build`, then copy `dist/`.
> **Sections:** At the site root · Under a sub-path https · The server

`npm run build` writes the game to its `dist/`: plain files (HTML, JS, assets) that any static web server serves. Copy the whole folder.

## At the site root (`https://example.com/`)
```sh
npm run build -w games/my-game       # or `npm run build` inside the game folder
threedog preview my-game             # open the built version locally before uploading
```
Upload the contents of `dist/` to the site's root folder.

## Under a sub-path (`https://example.com/my-game/`)
Asset URLs in the build start at `/` by default, so a game served from `/my-game/` asks for `/assets/...` and finds nothing. Build with the path:
```sh
threedog build my-game --base /my-game/          # leading and trailing slash
```
- Vite writes the path into every bundled URL, and the engine's runtime loads (assets.js names, models, textures, the dev cache) start from it
  too (`import.meta.env.BASE_URL`). Your own `fetch('/data.json')` does not: write `fetch(import.meta.env.BASE_URL + 'data.json')`, or import it.
- Git Bash on Windows rewrites an argument that starts with `/` into a Windows path (`C:/Program Files/Git/my-game/`); `threedog build` undoes
  that for `--base`. Calling vite directly does not: use `MSYS_NO_PATHCONV=1` or PowerShell there.
- Do not put `base` in `vite.config.js` for this: it moves the dev server to the sub-path too. `--base` changes only this build.
- Check it locally: `threedog preview my-game --base /my-game/`, then open `http://localhost:4173/my-game/`.

## The server
Any static server works (nginx, Caddy, GitHub Pages, Netlify); nothing needs a special MIME type (the physics wasm is inlined in its script).
A game with `threads` shares memory with its workers only on a cross-origin isolated page (`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp`); without those headers the workers still run but copy their data (`engine.threads.shared` is false).
