// BT-B (old-mine blind test, docs/testing/usability/2026-11-10-old-mine-blind.md items 4-5): the reverb send/return and lit particles.
// Guards (cannot be bypassed): the reverb is read back as a real signal out of its return (an analyser after the ConvolverNode, a tone on a
// sending bus), not only its settings; lit dust is read from the uploaded color attribute and the rendered picture on both renderer routes.
const READY = { timeout: 60000 };

export const specs = [
  {
    name: "[guard] BT-B lit particles: lit dust is dark without lights, follows three's point-light formula beside a lamp on both routes, ignores a spot pointed away; unlit dust stays as given",
    url: '/tests/fx-particles/index.html',
    software: true,
    async run({ page, check, ev }) {
      await page.waitForFunction(() => window.fxLit, null, READY);
      const r = await ev(() => window.fxLit());
      for (const [n, c] of Object.entries(r.routes)) {
        check(`${n}: no light, no color`, c.dark.red === 0 && c.dark.mean < 0.5, JSON.stringify(c.dark));
        check(`${n}: beside the lamp the color is color * light / pi / d^2, uploaded`, Math.abs(c.lamp.red - c.expect) < 1e-3 && c.lamp.uploaded, JSON.stringify(c));
        check(`${n}: the picture brightens with the lamp`, c.lamp.mean > c.dark.mean + 3, JSON.stringify([c.dark.mean, c.lamp.mean]));
        check(`${n}: a spot pointed away lights nothing`, c.spotAway === 0, String(c.spotAway));
        check(`${n}: under engine.still a lamp added then removed is seen both times (the light walk counts frames, not game time)`, c.still.on > 0.1 && c.still.off === 0, JSON.stringify(c.still));
        check(`${n}: an unlit effect keeps its color`, c.unlit === c.unlitExpect, JSON.stringify([c.unlit, c.unlitExpect]));
      }
    },
  },
  {
    name: '[guard] BT-B reverb: off until asked; a tone on a sending bus comes back out of the return after it ends; wet / sends / places / off',
    url: '/tests/audio/index.html',
    async run({ page, check, ev, frames }) {
      await page.waitForFunction(() => window.engine?.stateApplied, null, READY);
      check('off by default: nothing in info', await ev(() => !('reverb' in engine.audio.info)));
      await ev(() => engine.audio.reverb({ sends: { sfx: 1 }, decay: 1.5, size: 0.5, wet: 1 }));   // before the click: kept until audio unlocks
      check('asked before unlock: kept, not built', await ev(() => engine.audio.info.reverb.built === false));
      const box = await page.locator('#view').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await ev(() => __t.until(() => engine.audio.running, 3000));
      const g = await ev(() => { const b = engine.audio._reverb.nodes.conv.buffer; return { built: engine.audio.info.reverb.built, ch: b.numberOfChannels, dur: b.duration }; });
      check('built on unlock: a stereo impulse of pre-delay + decay seconds', g.built && g.ch === 2 && Math.abs(g.dur - (0.04 + 1.5)) < 0.01, JSON.stringify(g));
      // the real signal: a short tone on sfx, then the return alone, listened to after the tone ended; then the same with the send at 0
      const heard = await ev(async () => {
        const a = engine.audio, ctx = a.ctx, an = ctx.createAnalyser(); an.fftSize = 2048; a._reverb.nodes.out.connect(an);
        const buf = new Float32Array(an.fftSize), rms = () => { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; return Math.sqrt(s / buf.length); };
        const t0 = ctx.currentTime; a.tone({ freq: 440, dur: 0.1, vol: 0.8, bus: 'sfx' });
        await __t.until(() => ctx.currentTime > t0 + 0.35, 5000).catch(() => {});
        const tail = rms(), clock = ctx.currentTime - t0;
        a.reverb({ sends: { sfx: 0 } }); const t1 = ctx.currentTime;
        await __t.until(() => ctx.currentTime > t1 + 2, 8000).catch(() => {});
        a.tone({ freq: 440, dur: 0.1, vol: 0.8, bus: 'sfx' }); const t2 = ctx.currentTime;
        await __t.until(() => ctx.currentTime > t2 + 0.35, 5000).catch(() => {});
        return { tail, clock, quiet: rms() };
      });
      check('the tail: the return still sounds 0.25 s after the tone ended, and is silent with the send at 0', heard.clock > 0.3 && heard.tail > 1e-3 && heard.quiet < heard.tail / 10, JSON.stringify(heard));
      // a place changes the wet only: a send fading on its own is not cut short (audio clock seconds)
      const fades = await ev(async () => {
        const a = engine.audio, ctx = a.ctx, node = () => { const s = a._reverb.nodes.sends.sfx; return s.g ?? s; }, g = () => node().gain.value;   // the send node, whichever shape holds it
        a.reverb({ sends: { sfx: 1 } }); await __t.until(() => g() > 0.99, 2000).catch(() => {});
        a.reverb({ sends: { sfx: 0.2 }, fade: 3 }); a.reverbPlace(0.5, 0.05); const t0 = ctx.currentTime;
        await __t.until(() => ctx.currentTime > t0 + 0.3, 5000).catch(() => {});
        const mid = g(); a.reverbPlace(null, 0); a.reverb({ sends: { sfx: 0 } });
        return { mid, clock: ctx.currentTime - t0 };
      });
      check('a place wet change leaves a send fade running', fades.clock >= 0.3 && fades.mid > 0.5, JSON.stringify(fades));
      // off / on cycles cut the bus -> send link too: count the live edges out of the sfx bus tap
      const edges = await ev(() => {
        const a = engine.audio, tap = a._duckNodes.sfx, P = AudioNode.prototype, live = new Set(), con = P.connect, dis = P.disconnect;
        P.connect = function (d, ...x) { if (this === tap) live.add(d); return con.call(this, d, ...x); };
        P.disconnect = function (d, ...x) { if (this === tap) { if (d) live.delete(d); else live.clear(); } return dis.call(this, d, ...x); };
        try { for (let i = 0; i < 3; i++) { a.reverb(null); a.reverb({ sends: { sfx: 0 }, decay: 1.5 }); } } finally { P.connect = con; P.disconnect = dis; }
        return { live: live.size, current: live.has(a._reverb.nodes.sends.sfx.g ?? a._reverb.nodes.sends.sfx) };
      });
      check('off / on cycles leave one send on the bus, not one per cycle', edges.live === 1 && edges.current, JSON.stringify(edges));
      const r = await ev(() => {
        const a = engine.audio, bad = f => { try { f(); return 'no error'; } catch (e) { return e.message; } };
        const out = { unknown: bad(() => a.reverb({ sends: { nope: 1 } })), range: bad(() => a.reverb({ wet: 2 })) };
        const conv = a._reverb.nodes.conv; a.reverb({ wet: 0.2 }); out.sameConv = a._reverb.nodes.conv === conv;
        a.reverb({ wet: 0.2, decay: 3 }); out.newConv = a._reverb.nodes.conv !== conv && Math.abs(a._reverb.nodes.conv.buffer.duration - 3.04) < 0.01;
        engine.ambience.add({ reverb: 0.7, when: { state: 'combat' }, fade: 0.1 });
        out.noSound = bad(() => engine.ambience.add({ reverb: 0.5, sound: 'hum' }));
        return out;
      });
      check('an unknown bus and an out-of-range wet are refused with the fix', /nope/.test(r.unknown) && /wet/.test(r.range), JSON.stringify(r));
      check('wet changes on the same convolver; decay builds a new impulse', r.sameConv && r.newConv, JSON.stringify(r));
      check('a reverb rule with a sound is refused', /plays no sound/.test(r.noSound), r.noSound);
      await ev(() => { engine.audio.state = 'combat'; }); await frames(20);
      const placed = await ev(() => engine.audio.info.reverb);
      check('a place sets wet while its rule holds', placed.place === 0.7 && placed.wet === 0.7, JSON.stringify(placed));
      await ev(() => { engine.audio.state = null; }); await frames(20);
      check("leaving it gives the game's wet back", await ev(() => engine.audio.info.reverb.wet === 0.2 && !('place' in engine.audio.info.reverb)));
      await ev(() => engine.audio.reverb(null));
      check('null turns it off', await ev(() => !('reverb' in engine.audio.info)));
    },
  },
];
