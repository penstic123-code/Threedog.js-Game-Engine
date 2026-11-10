// Streaming after start: content with unseen textures or materials is uploaded and compiled before it is attached (core/stream/prepare.js), so the frame that first
// draws it does not compile; content sharing compiled materials attaches in the same step; walking away and back gives the memory back (owner-disposed, game textures kept).
// Why both renderers: WebGL compiles programs, WebGPU builds pipelines and counts GPU bytes; the readying and the release must hold on each.
const cases = (label, gpu) => ({
  name: `[guard] stream after start (${label}): unseen materials readied before the first draw, memory back after six round trips`,
  url: '/tests/backend/index.html',
  software: true,
  async run({ check, ev }) {
    const r = await ev(g => { return window.streamCases(g); }, gpu);
    console.log(`  stream ${label} numbers:`, JSON.stringify({ fresh: r.fresh, kit: r.kit, trips: r.trips.map(t => t.total ?? `${t.geometries}g/${t.textures}t`), metric: r.metric.value }));
    check('an unseen material is compiled once, its texture uploaded, before it is attached', r.fresh.compiled === 1 && r.fresh.uploadedBeforeDraw >= 1 && r.fresh.attachedInStep === false && r.fresh.attached, JSON.stringify(r.fresh));
    check('compiled while behind the camera: turning to it draws it with no new program', r.fresh.programsOnTurn === 0 && r.fresh.drawn, JSON.stringify(r.fresh));
    if (!gpu) check('WebGL: its program exists before the first draw, and no frame counts as a compile stall', r.fresh.programsBeforeDraw >= 1 && r.fresh.stallsAfterAttach === 0, JSON.stringify(r.fresh));
    check('a material start() compiled: attached in the same step, nothing compiled', r.kit.attachedInStep === true && r.kit.compiled === 0, JSON.stringify(r.kit));
    check('every round trip loaded all 25 and unloaded them again; a reused material is forgotten when disposed and compiled again', r.trips.every(t => t.ok), JSON.stringify(r.trips));
    const first = r.trips[0], last = r.trips.at(-1);
    check('geometries and textures back to the first trip\'s count', last.geometries === first.geometries && last.textures === first.textures, JSON.stringify(r.trips));
    // no tolerance from the second trip on: the leak this guards (two compileAsync calls at once, core/stream/prepare.js) was 784 bytes and 4 records per trip
    if (gpu) check('WebGPU: info.memory.total and the render records flat from the second trip on', r.trips.slice(1).every(t => t.total === r.trips[1].total && t.records === r.trips[1].records) && last.total - first.total <= 4096, JSON.stringify(r.trips.map(t => [t.total, t.records])));
    check("the game's shared texture was never disposed", r.sharedDisposed === 0, r.sharedDisposed);
    if (gpu) check('gpuMemoryMB is a budget value, in the notice against the game limit, in describe and inspect perf', r.metric.value > 0 && r.metric.notice.includes('gpuMemoryMB') && r.metric.describe.mb > 0 && r.metric.describe.is.includes('estimate') && r.metric.perfText, JSON.stringify(r.metric));
    else check('WebGL: no byte count, so no gpuMemoryMB value and no describe field', r.metric.value === null && r.metric.describe === undefined && !r.metric.perfText, JSON.stringify(r.metric));
  },
});
export const specs = [cases('WebGL', false), cases('WebGPU', true)];
