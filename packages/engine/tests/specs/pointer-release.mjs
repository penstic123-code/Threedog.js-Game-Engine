// A locked mouse and things to click: a real lock from a real click, and real mouse and key presses on what opens. Why real: under a lock the cursor is gone and the click
// lands on the canvas, which no synthetic click on the button would show. Headless Chromium keeps Esc from ending a lock, so the Esc presses here run on a window that
// has already let go, which is the state the player is in; the player's own Esc under a lock is covered by input-context.mjs.
const lock = async (page, ev) => {
  const box = await page.locator('#view').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return ev(() => __t.until(() => engine.page.pointerLocked, 3000).then(() => true, () => false));   // the page's own flag: pointerLockElement is set before its event arrives
};
const released = ev => ev(() => __t.until(() => !document.pointerLockElement, 3000).then(() => true, () => false));

export const specs = [
  {
    name: '[guard] pointer release: a window opened under a lock can be clicked, and an ending window survives Esc',
    url: '/tests/uinav/index.html',
    async run({ page, check, ev, frames }) {
      await ev(() => { engine.cameraRig.pointerLock = true; });
      check('a click locks the mouse', await lock(page, ev));
      await ev(() => {
        window.clicks = 0;
        window.end = makeWindow(engine, { id: 'end', title: () => 'Run over', closable: false, render: () => '<button class="threedog-btn" data-act="again">Again</button>' });
        end.el.addEventListener('click', ev => { if (ev.target.closest('[data-act="again"]')) window.clicks++; });
        end.toggle(true);
      });
      check('the window lets go of the mouse', await released(ev));
      const b = await page.locator('[data-act="again"]').boundingBox();
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      check('a real mouse click reaches its button', await ev(() => window.clicks) === 1);
      await page.keyboard.press('Escape'); await frames(3);
      await page.keyboard.press('Escape'); await frames(3);
      check('two Esc do not close an ending window', await ev(() => end.open));
      check('it has no close button', await ev(() => !end.el.querySelector('.threedog-close')));
      await ev(() => { end.toggle(false); window.plain = makeWindow(engine, { id: 'plain', title: () => 'Plain', render: () => '<p>x</p>' }); plain.toggle(true); });
      await page.keyboard.press('Escape'); await frames(3);
      check('an ordinary window still closes with Esc', await ev(() => !plain.open));
      await frames(3);
      check('the next click locks again', await lock(page, ev));
    },
  },
  {
    name: '[guard] pointer release: the settings menu lets go under a lock; a game ending the lock itself opens no menu, by either way',
    url: '/?cutscene=skip',
    async run({ page, check, ev, frames }) {
      await ev(() => { engine.cameraRig.pointerLock = true; });
      check('a click locks the mouse', await lock(page, ev));
      await ev(() => { engine.ui.open('settings'); });
      check('ui.open(settings) lets go of the mouse', await released(ev));
      await ev(() => { engine.ui.close('settings'); });
      await frames(3);
      check('locked again', await lock(page, ev));
      await ev(() => { document.exitPointerLock(); });
      check('document.exitPointerLock() ends the lock', await released(ev));
      await frames(3);
      check('and opens no menu', await ev(() => !engine.ui.isOpen('settings') && engine.runState.state === 'running'), JSON.stringify(await ev(() => engine.runState)));
      check('locked again', await lock(page, ev));
      await ev(() => { engine.page.releaseLock(); });
      check('engine.page.releaseLock() ends the lock', await released(ev));
      await frames(3);
      check('and opens no menu', await ev(() => !engine.ui.isOpen('settings')));
    },
  },
];
