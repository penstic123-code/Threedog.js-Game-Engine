// The hub page: two views by hash (#/ project cards, #/p/<id> screenshot wall). No framework; the server tells it what changed over /events.
const $ = s => document.querySelector(s), app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = (path, method = 'GET', body) => fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  .then(async r => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }));
const when = t => t ? new Date(t).toLocaleString() : 'never';
let toastTimer;
const toast = (msg, url) => {   // url: shown as a link (a blocked popup must not lose the address)
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  if (url) { const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.textContent = url; t.append(' ', a); } clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, url ? 30000 : 5000);
};
const log = [];   // progress lines of a new project, shown under the form

const badges = p => [
  !p.exists && '<span class="badge bad">not found</span>',
  p.busy && '<span class="badge warn">shooting…</span>',
  !p.busy && p.queued && '<span class="badge">queued</span>',
  p.pointsMissing && '<span class="badge" title="add shots.json to choose points">no shots.json</span>',
].filter(Boolean).join('');

// ---- list view ----
let lastParent = '';
const cardsHtml = projects => projects.map(p => `<div class="card">
      ${p.cover && p.exists ? `<a class="thumb" href="#/p/${p.id}"><img src="${p.cover}" alt=""></a>` : `<a class="thumb empty" href="#/p/${p.id}">${p.exists ? 'no picture yet' : 'folder not found'}</a>`}
      <div class="body"><a class="name" href="#/p/${p.id}">${esc(p.name)}</a>
        <div>${badges(p)}</div>
        <div class="small">${esc(p.dir)}</div>
        <div class="small">updated ${when(p.updatedAt)}</div>
        ${p.error ? `<div class="err">${esc(p.error)}</div>` : ''}
        ${p.exists ? '' : `<div><button data-remove="${p.id}">Remove</button></div>`}
      </div></div>`).join('') || '<p class="small">No projects yet. Create one or add a folder below.</p>';
function bindCards() {
  app.querySelectorAll('[data-remove]').forEach(b => { b.onclick = async () => { await api('/api/projects/' + b.dataset.remove, 'DELETE'); listView(); }; });
  app.querySelectorAll('.thumb img').forEach(i => { i.onclick = e => { e.preventDefault(); location.hash = i.closest('a').getAttribute('href'); }; });
}
// Why only the grid is redrawn when the page is already showing: a live update must not wipe what is being typed in the forms below
async function listView() {
  const r = await api('/api/projects'), projects = r.data, grid = $('#cards');
  if (grid) { grid.innerHTML = cardsHtml(projects); return bindCards(); }
  lastParent = lastParent || (await api('/api/defaults')).data.parent;
  app.innerHTML = `<h1>Projects</h1>
    <div class="grid" id="cards">${cardsHtml(projects)}</div>
    <h2>Add a folder</h2>
    <div class="row"><input type="text" id="add-dir" placeholder="C:\\path\\to\\your\\game (a folder with threedog in package.json)"><button id="add-btn">Add folder</button></div>
    <h2>New project</h2>
    <div class="panel">
      <label>Name<input type="text" id="new-name" placeholder="my-game"></label>
      <label>Parent folder<input type="text" id="new-parent" value="${esc(lastParent)}"></label>
      <label>Template<select id="new-template"><option value="blank">Blank</option><option value="open-world">Open world</option><option value="pixel">Pixel</option><option value="scene-only">Scene only</option></select></label>
      <div class="row"><button class="primary" id="new-btn">Create</button><span class="small">Runs threedog init and npm install; this takes a minute.</span></div>
      <div class="log" id="new-log" ${log.length ? '' : 'hidden'}>${esc(log.join('\n'))}</div>
    </div>`;
  $('#add-btn').onclick = async () => {
    const x = await api('/api/projects', 'POST', { dir: $('#add-dir').value });
    if (!x.ok) return toast(x.data.reason || 'could not add');
    listView();
  };
  $('#new-btn').onclick = async () => {
    log.length = 0;
    const x = await api('/api/new', 'POST', { parent: $('#new-parent').value, name: $('#new-name').value, template: $('#new-template').value });
    if (!x.ok) return toast(x.data.reason || 'could not create');
    $('#new-log').hidden = false; $('#new-btn').disabled = true;
  };
  bindCards();
}

// ---- wall view ----
async function wallView(id) {
  const r = await api('/api/projects/' + id);
  if (!r.ok) { app.innerHTML = '<p>Project not found. <a href="#/">Back</a></p>'; return; }
  const p = r.data;
  app.innerHTML = `<p><a href="#/">&larr; Projects</a></p><h1>${esc(p.name)} ${badges(p)}</h1>
    <div class="small">${esc(p.dir)} · updated ${when(p.updatedAt)}</div>
    ${p.error ? `<div class="err">${esc(p.error)}</div>` : ''}
    <div class="row">
      <button class="primary" id="reshoot" ${p.exists ? '' : 'disabled'}>Re-shoot now</button>
      <button data-open="game" ${p.exists ? '' : 'disabled'}>Open game</button>
      <button data-open="editor" ${p.exists ? '' : 'disabled'}>Editor</button>
      <button data-open="gallery" ${p.exists ? '' : 'disabled'}>Assets</button>
      <button id="remove">Remove from list</button>
    </div>
    <div class="grid">${p.points.map((pt, i) => `<div class="card">
      ${pt.shots[0] ? `<div class="thumb"><img data-point="${i}" src="${pt.shots[0].url}" alt="${esc(pt.name)}"></div>` : '<div class="thumb empty">no picture</div>'}
      <div class="body"><div class="name">${esc(pt.name)}</div>
        <div class="small">${pt.shots[0] ? when(pt.shots[0].at) : ''}</div>
        ${pt.error ? `<div class="err">${esc(pt.error)}</div>` : ''}</div></div>`).join('') || '<p class="small">No pictures yet.</p>'}</div>`;
  $('#reshoot').onclick = async () => { await api(`/api/projects/${id}/reshoot`, 'POST'); toast('queued'); };
  $('#remove').onclick = async () => { await api('/api/projects/' + id, 'DELETE'); location.hash = '#/'; };
  app.querySelectorAll('[data-open]').forEach(b => { b.onclick = async () => {
    b.disabled = true; toast('starting the dev server…');
    const x = await api(`/api/projects/${id}/open`, 'POST', { what: b.dataset.open });
    b.disabled = false;
    if (!x.ok) return toast(x.data.reason || 'could not open');
    if (x.data.hint) toast(x.data.hint);
    if (!window.open(x.data.url, '_blank')) toast('the browser blocked the new tab:', x.data.url);   // popups after an await are often blocked
  }; });
  app.querySelectorAll('img[data-point]').forEach(img => { img.onclick = () => lightbox(p.points[img.dataset.point]); });
}

function lightbox(pt, i = 0) {
  const box = $('#lightbox'), s = pt.shots[i];
  box.hidden = false;
  box.innerHTML = `<img class="big" src="${s.url}" alt=""><div class="cap">${esc(pt.name)} · ${when(s.at)}${i ? '' : ' (newest)'}</div>
    <div class="strip">${pt.shots.map((x, j) => `<img src="${x.url}" data-j="${j}" class="${j === i ? 'on' : ''}" alt="">`).join('')}</div>`;
  box.querySelectorAll('.strip img').forEach(im => { im.onclick = e => { e.stopPropagation(); lightbox(pt, Number(im.dataset.j)); }; });
}
const closeViewer = () => { $('#lightbox').hidden = true; settle(); };
$('#lightbox').onclick = e => { if (e.target.id === 'lightbox' || e.target.classList.contains('big')) closeViewer(); };
addEventListener('keydown', e => { if (e.key === 'Escape') closeViewer(); });

// ---- routing and live updates ----
function route() {
  $('#lightbox').hidden = true;
  const m = location.hash.match(/^#\/p\/([0-9a-f]+)/);
  return m ? wallView(m[1]) : listView();
}
addEventListener('hashchange', route);

let refresh, dirty = false;
const viewerOpen = () => !$('#lightbox').hidden, typing = () => document.activeElement?.tagName === 'INPUT' && app.contains(document.activeElement);
const refreshSoon = () => { dirty = false; clearTimeout(refresh); refresh = setTimeout(route, 300); };
const settle = () => { if (dirty && !viewerOpen() && !typing()) refreshSoon(); };   // what was skipped while the viewer was open or an input had focus
const es = new EventSource('/events');
let opened = false;
es.onopen = () => { if (opened) route(); opened = true; };   // reconnect: events during the gap were lost, so draw again
es.onmessage = e => {
  const ev = JSON.parse(e.data);
  if (ev.type === 'log') {
    log.push(ev.line); if (log.length > 200) log.shift();
    const el = $('#new-log'); if (el) { el.hidden = false; el.textContent = log.join('\n'); el.scrollTop = el.scrollHeight; }
    if (ev.line === 'done' || /failed/.test(ev.line)) { const b = $('#new-btn'); if (b) b.disabled = false; }
    return;
  }
  // a project changed: redraw the current view shortly (not while a picture is open or a form is being typed in)
  if (viewerOpen() || typing()) dirty = true; else refreshSoon();
};
addEventListener('focusout', () => setTimeout(settle, 0));

$('#icon-btn').onclick = async () => { const x = await api('/api/shortcut', 'POST'); toast(x.data.message || 'done'); };
$('#quit-btn').onclick = async () => { await api('/api/quit', 'POST'); document.body.innerHTML = '<main><h1>Hub closed</h1><p class="small">Run threedog hub to start it again.</p></main>'; };
route();
