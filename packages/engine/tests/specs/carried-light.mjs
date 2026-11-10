// A light the player carries is not shadowed by the player's hidden body (modules/camera/common.js HIDE_RIG._carriedLights); the sun still casts the body's
// shadow. Judged by pixels on both renderers (tests/carried-light). 不许绕开: the lamp is placed the way a game does it (no engine call, no option).
const run = async ({ page, check, ev }) => {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await ev(() => window.carriedRun());
  console.log('  carried light numbers:', JSON.stringify(r));
  const { left, right } = r.lamp;
  check(`the carried lamp lights both halves of its pool (left ${left}, right ${right}): no black wedge from the hidden body`, right > 20 && left > right * 0.6, JSON.stringify(r));
  check(`the sun still casts the hidden body's shadow (middle ${r.sun.middle}, sides ${r.sun.sides})`, r.sun.sides > 20 && r.sun.middle < r.sun.sides * 0.7 && r.sunKeepsBody && r.bodyHidden, JSON.stringify(r));
  check('the body shown again gives the lamp its hidden layer back', r.lampDropsBody && r.backAfterUnhide, JSON.stringify(r));
  check(`a lamp whose shadow redraws only on request is redrawn when the body is hidden (left ${r.manual.left}, right ${r.manual.right})`,
    r.manual.right > 20 && r.manual.left > r.manual.right * 0.6, JSON.stringify(r));
  check('a carried lamp taken out of the scene gets its hidden layer back', r.carriedBeforeRemove && r.removedGetsBack, JSON.stringify(r));
};
export const specs = [
  { name: '[guard] carried lamp in first person on WebGLRenderer: both halves lit, the sun keeps the body shadow', url: '/tests/carried-light/index.html', software: true, run },
  { name: '[guard] carried lamp in first person on WebGPURenderer: both halves lit, the sun keeps the body shadow', url: '/tests/carried-light/index.html?r=gpu', software: true, run },
];
