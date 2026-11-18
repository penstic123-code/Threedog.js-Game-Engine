// The editor's history and queue (editor/design.js) without a browser: a stub page and a file held in memory, whose replies the test holds back, so the overlaps a
// real page only reaches with a slow server and a repeating Ctrl+Z happen on purpose. editor-loop.mjs covers the real page; what it cannot time is here.
// Also the dev server's reload decision (vite-threedog-editor.js), through its real hook and a real file.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import threedogEditor from '../vite/vite-threedog-editor.js';

export const name = 'editor history: overlapping steps run one at a time, the history only holds what the file took, a save never reloads over a later edit';

const DESIGN = new URL('../editor/design.js', import.meta.url).href;
let loads = 0;

/** A page with one content file: fields by id, one queue of held replies; a fresh design.js, because the history lives in the module */
async function page(files) {
  const store = new Map(), held = [], sent = [], fields = structuredClone(files);
  let holding = false, reloads = 0, down = false;
  const answer = body => {
    const f = fields[body.id];
    if (body.op === 'read') return f ? { ok: true, fields: { ...f }, kind: body.kind ?? 'props', computed: [], file: 'content/props.js', line: 1 } : { ok: false, error: 'no such id' };
    if (body.op === 'add') { fields[body.entry.id] = body.entry; return { ok: true, change: 'added' }; }
    for (const [k, v] of Object.entries(body.expect ?? {})) if (JSON.stringify(f?.[k] ?? null) !== JSON.stringify(v)) return { ok: false, conflict: true, error: `${k} changed` };
    Object.assign(f, body.fields);
    for (const k of body.unset ?? []) delete f[k];
    return { ok: true, change: JSON.stringify(body.fields), kind: body.kind };
  };
  Object.assign(globalThis, {
    sessionStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    location: { reload: () => { reloads++; } },
    requestAnimationFrame: f => setTimeout(f, 0),
    fetch: async (_, { body }) => {
      const req = JSON.parse(body);
      sent.push(req);
      if (down) throw new Error('connection refused');
      if (holding && req.op !== 'read') await new Promise(go => held.push(go));
      const r = answer(req);
      return { json: async () => r };
    },
  });
  const records = new Map(Object.keys(fields).map(id => [id, { id, kind: 'prop', position: { x: fields[id].x ?? 0, y: 0, z: fields[id].z ?? 0 } }]));
  const engine = {
    ops: { run: (op, a) => { if (op === 'thing.remove') records.delete(a.id); return { ok: true }; } },
    world: { get: id => records.get(id), view: id => records.has(id) ? { position: {}, rotation: { y: 0 }, userData: {} } : null, forget() {}, setOrigin() {}, query: () => [...records.values()] },
    content: { load: d => { for (const e of Object.values(d).flat()) records.set(e.id, { id: e.id, kind: 'prop', position: { x: e.x ?? 0, y: 0, z: e.z ?? 0 } }); }, place: () => null, offset: (_, x, z) => ({ x, z }), fields: () => ({ scale: { type: 'number' }, tag: { type: 'string' }, list: { type: 'json' } }) },
    assets: { entries: new Map() },
    describe: () => ({}),
    surface: () => 0,
    thing: id => { const r = records.get(id); if (!r) throw new Error('gone'); return { id, definedAt: 'content/props.js:1', position: r.position }; },
  };
  const d = await import(`${DESIGN}?page=${++loads}`);
  return {
    d, engine, fields, sent,
    hold() { holding = true; },
    async release() { holding = false; while (held.length) { held.shift()(); await new Promise(r => setTimeout(r, 0)); } },
    down(v) { down = v; },
    get reloads() { return reloads; },
    entry: id => d.entryAt(engine, engine.thing(id)),
    history() { const h = JSON.parse(store.get('threedog-editor-history') ?? '{"done":[],"undone":[]}'); return { done: h.done.map(s => s.fwd.fields), undone: h.undone.map(s => s.fwd.fields) }; },
  };
}
const tick = () => new Promise(r => setTimeout(r, 5));

export async function run({ check }) {
  // [guard] engine.pick hands back a thing with id null for a mesh nobody named: the editor read a position off it and the click threw
  const { pickAt } = await import(`${DESIGN}?pick`);
  check('[guard] a click on a mesh with no id selects nothing', pickAt({ pick: () => ({ thing: { id: null, mesh: 'x' } }) }, 0, 0) === null);
  const realFetch = globalThis.fetch;
  // [guard] the review's case: a good save, a save and a Ctrl+Z in flight, a hand edit, both refused
  {
    const p = await page({ a: { scale: 1 } });
    const first = await p.d.setField(p.engine, await p.entry('a'), 'scale', 2);
    p.hold();
    const save = p.d.setField(p.engine, first.entry, 'scale', 3), back = p.d.undo(p.engine);
    await tick();
    p.fields.a.scale = 9;   // by hand
    await p.release();
    const [s, b] = await Promise.all([save, back]);
    check('[guard] a save refused under an overlapping undo: the good save is still the last step', !s.ok && !b.ok && JSON.stringify(p.history()) === JSON.stringify({ done: [{ scale: 2 }], undone: [] }), JSON.stringify(p.history()));
  }

  // [guard] two undos at once, the first refused: the second must not take back the step below it
  {
    const p = await page({ a: { scale: 1, tag: 'x' } });
    const one = await p.d.setField(p.engine, await p.entry('a'), 'scale', 2);
    await p.d.setField(p.engine, one.entry, 'tag', 'y');
    p.fields.a.tag = 'hand';
    p.hold();
    const both = [p.d.undo(p.engine), p.d.undo(p.engine)];
    await p.release();
    const [u1, u2] = await Promise.all(both);
    check('[guard] overlapping undos, the top one refused: nothing below it moves', !u1.ok && !u2.ok && p.fields.a.scale === 2 && p.history().done.length === 2 && !p.history().undone.length, JSON.stringify({ f: p.fields.a, h: p.history() }));
  }

  // [guard] M2: a second drag from the same held entry starts from what the first one saved
  {
    const p = await page({ a: { x: 0, z: 0 } }), e = await p.entry('a');
    p.hold();
    const both = [p.d.moveEntry(p.engine, e, { x: 5, y: 0, z: 0, yaw: 0 }), p.d.moveEntry(p.engine, e, { x: 7, y: 0, z: 0, yaw: 0 })];
    await tick();
    await p.release();
    const [m1, m2] = await Promise.all(both);
    check('[guard] a drag made while a save runs is saved, not refused as a conflict', m1.ok && m2.ok && p.fields.a.x === 7 && m2.entry.position.x === 7, JSON.stringify({ m1, m2, f: p.fields.a }));
    await p.d.undo(p.engine); await p.d.undo(p.engine);
    check('both drags undo in order, back to the first value', p.fields.a.x === 0 && p.history().undone.length === 2, JSON.stringify(p.fields.a));
  }

  // [guard] a turn handle on a tilted entry adds to the y of its [x, y, z], and the x and z stay as written
  {
    const p = await page({ a: { x: 0, z: 0, rot: [0.3, 0.2, 0] } }), r = await p.d.moveEntry(p.engine, await p.entry('a'), { x: 0, y: 0, z: 0, yaw: 0.5 });
    check('[guard] turning an entry with a three-axis rot writes three numbers', r.ok && JSON.stringify(p.fields.a.rot) === '[0.3,0.7,0]', JSON.stringify({ r, f: p.fields.a }));
  }

  // [guard] M2: two rows saved from one held entry, the second against the first's result
  {
    const p = await page({ a: { scale: 1, tag: 'x' } }), e = await p.entry('a');
    p.hold();
    const both = [p.d.setField(p.engine, e, 'scale', 2), p.d.setField(p.engine, e, 'tag', 'y')];
    await tick();
    await p.release();
    const [, second] = await Promise.all(both);
    const again = await p.d.setField(p.engine, e, 'scale', 3);
    check('[guard] tabbing through two rows: an edit from the stale entry after them still lands', second.ok && again.ok && p.fields.a.scale === 3 && p.fields.a.tag === 'y', JSON.stringify(again));
  }

  // [guard] a server that does not answer is a refused step, not a history entry and not a stopped queue
  {
    const p = await page({ a: { scale: 1 } }), e = await p.entry('a');
    p.down(true);
    const r = await p.d.setField(p.engine, e, 'scale', 2);
    p.down(false);
    const r2 = await p.d.setField(p.engine, e, 'scale', 3);
    check('[guard] a dead server leaves no step in the history, and the next step runs', !r.ok && /did not answer/.test(r.error) && r2.ok && p.history().done.length === 1, JSON.stringify({ r, h: p.history() }));
  }

  // a step that reloads the page ends the queue: what is behind it would write against a page that is going
  {
    const p = await page({ guard: { start: { x: 1, z: 1 } }, a: { scale: 1 } });
    const e = await p.entry('a'), rec = p.engine.world.get('guard');
    rec.kind = 'npc';
    const npc = await p.entry('guard');
    const both = [p.d.moveEntry(p.engine, npc, { x: 4, y: 0, z: 1, yaw: 0 }), p.d.setField(p.engine, e, 'scale', 2)];
    const [m, s] = await Promise.all(both);
    check('a step behind a page reload is not sent', m.reloading && s.reloading && p.reloads === 1 && p.fields.a.scale === 1, JSON.stringify({ m, s, reloads: p.reloads }));
  }

  // cheap ones from the same review: an axis left alone, a typo in a json row, an id only the file has, a press that moved nothing
  {
    const p = await page({ a: { x: 1.23456, z: 0 }, 'crate-1': { x: 0 } }), e = await p.entry('a');
    await p.d.moveEntry(p.engine, e, { x: 1.23456, y: 0, z: 3, yaw: 0 });
    check('an axis the drag left alone keeps its digits', p.fields.a.x === 1.23456 && p.fields.a.z === 3, JSON.stringify(p.fields.a));
    const typo = await p.d.setField(p.engine, (await p.entry('a')), 'list', '[1, 2');
    check('a broken list in a json row is refused, not written as a string', !typo.ok && p.fields.a.list === undefined, JSON.stringify(typo));
    p.engine.world.get('crate-1') && p.engine.ops.run('thing.remove', { id: 'crate-1' });   // collected: only the file has it now
    p.engine.thing = (t => id => { try { return t(id); } catch { return { id, definedAt: 'content/props.js:1', position: { x: 0, y: 0, z: 0 } }; } })(p.engine.thing);
    const add = await p.d.addEntry(p.engine, { name: 'crate', model: true }, { x: 1, z: 1 });
    check('Add skips an id the file has and the world does not', add.ok && !!p.fields['crate-2'], JSON.stringify(add));
    const moved = [];
    p.engine.ops.run = (op, a) => { moved.push(op); return { ok: true }; };
    const still = await p.entry('a');
    await p.d.moveEntry(p.engine, still, { ...still.position, yaw: still.yaw });
    check('a press that moved nothing writes nothing to the record', !moved.length, moved.join());
    // [guard] a refused drag puts the model back, and the id stayed marked as moved: the next press that moved nothing wrote to the record
    const held = await p.entry('a');
    p.d.previewEntry(p.engine, held, { x: 9, y: 0, z: 9, yaw: 0 });
    p.fields.a.x = 8;   // a hand edit: the write below is refused
    const refused = await p.d.moveEntry(p.engine, held, { x: 9, y: 0, z: 9, yaw: 0 });
    moved.length = 0;
    await p.d.moveEntry(p.engine, held, { ...held.position, yaw: held.yaw });
    check('[guard] after a refused drag a press that moved nothing writes nothing either', !refused.ok && !moved.length, moved.join());
  }

  // [guard] M1: the server's reload decision, with the real hook and a real file
  {
    const dir = mkdtempSync(join(tmpdir(), 'td-hot-')), file = join(dir, 'content', 'props.js');
    try {
      mkdirSync(join(dir, 'content'));
      const T1 = "export default [\n  { id: 'a', model: 'box', x: 1 },\n];\n";
      writeFileSync(file, T1);
      writeFileSync(join(dir, 'main.js'), '\n');
      const plugin = /** @type {any} */ (threedogEditor());
      plugin.configResolved({ root: dir });
      let handler;
      plugin.configureServer({ middlewares: { use: (_, fn) => { handler = fn; } }, environments: { client: { moduleGraph: { onFileChange() {} } } } });
      const post = body => new Promise(done => {
        const res = { setHeader() {}, end: t => done(JSON.parse(t)) };
        const req = { method: 'POST', headers: { host: 'localhost:5173', origin: 'http://localhost:5173' }, socket: { remoteAddress: '127.0.0.1' },
          on(ev, fn) { if (ev === 'data') fn(Buffer.from(JSON.stringify(body))); if (ev === 'end') fn(); return this; }, destroy() {} };
        handler(req, res);
      });
      const r = await post({ op: 'write', id: 'a', kind: 'props', file: 'content/props.js', fields: { x: 2 }, expect: { x: 1 } });
      const ours = readFileSync(file, 'utf8');
      check('the fixture write went through', r.ok && ours.includes('x: 2'), JSON.stringify(r));
      const hot = async () => plugin.handleHotUpdate({ file });
      check('our own write does not reload the page', (await hot())?.length === 0);
      writeFileSync(file, ours.replace('x: 2', 'x: 3'));
      check('a hand edit reloads it', await hot() === undefined);
      writeFileSync(file, ours);
      check('[guard] a file put back to our last text reloads it too', await hot() === undefined);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // every test of a run shares this process: editor-loop needs the real fetch
  for (const k of ['sessionStorage', 'location', 'requestAnimationFrame']) delete globalThis[k];
  globalThis.fetch = realFetch;
}
