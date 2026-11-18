// fadeScreen keeps one cover per owner (game / flow / skip / each cutscene); the screen shows the darkest.
export const specs = [
  {
    name: 'fadeScreen: each owner keeps its own cover; the screen shows the darkest',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const tick = () => new Promise(r => setTimeout(r, 0));
        engine.haltLoop();
        const cover = () => +document.querySelector('.threedog-fade').style.getPropertyValue('--threedog-fade');
        // a cutscene holds the screen black, then waits
        const p = engine.timeline.play([{ fade: 0 }, { wait: 100 }, { fade: 0.2, to: 0 }]);
        await tick(); engine.step(0.05, { render: false }); await tick();
        const before = cover();
        // a scene transition by another owner must not lift the cutscene's cover
        const t = engine.flow.transition(() => {}, { fade: 0, autosave: false, music: false });
        for (let i = 0; i < 6; i++) { await tick(); engine.step(0.05, { render: false }); }
        await t;
        const during = cover();
        engine.timeline.skip();
        for (let i = 0; i < 6; i++) { await tick(); engine.step(0.05, { render: false }); }
        await p;
        return { before, during, after: cover() };
      });
      check('the cutscene covers the screen', r.before === 1, r);
      check('a transition by another owner does not clear the cutscene cover', r.during === 1, r);
      check('when the cutscene ends its own cover is lifted', r.after === 0, r);
    },
  },
  {
    name: 'fadeScreen: a cutscene that ends dark hands its cover to the next scene change',
    url: '/tests/city/index.html',
    async run({ check, ev }) {
      const r = await ev(async () => {
        const tick = () => new Promise(r => setTimeout(r, 0));
        engine.haltLoop();
        const cover = () => +document.querySelector('.threedog-fade').style.getPropertyValue('--threedog-fade');
        const p = engine.timeline.play([{ fade: 0 }]);
        for (let i = 0; i < 4; i++) { await tick(); engine.step(0.05, { render: false }); }
        await p;
        const dark = cover();
        const t = engine.flow.transition(() => {}, { fade: 0, autosave: false, music: false });
        for (let i = 0; i < 8; i++) { await tick(); engine.step(0.05, { render: false }); }
        await t;
        return { dark, after: cover() };
      });
      check('the finished cutscene leaves the screen dark', r.dark === 1, r);
      check('the next flow.transition lifts it (no permanent black screen)', r.after === 0, r);
    },
  },
];
