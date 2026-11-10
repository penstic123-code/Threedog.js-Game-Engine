// What any camera module must provide (fields: see gameplay/inventory.contract.js; shared check: @threedog/tools/contract). It installs as engine.cameraRig.
// Exactly what other code reads from engine.cameraRig: forward() / right() (control: 'camera', faceMode 'camera', targeting), follow(object, opts?)
// (addPlayer, entering / leaving a vehicle), focusPoint() (photo, where the world loads), screenToGround(ndcX, ndcY) (click-to-move, placing
// things); sensitivity / invertY are optional fields the settings menu writes when present. A camera that places engine.camera itself during a
// cutscene takeover leaves it alone while engine.cameraOverride is set (common.js).
export default {
  name: 'cameraRig',
  api: ['forward', 'right', 'follow', 'focusPoint', 'screenToGround'],
  fields: ['target'],   // what follow() follows: a ragdoll checks it before borrowing the camera, and leaves a camera the game moved elsewhere
  ops: [],
  events: [],
  saves: {},
  describe: true,
  options: {},
  probe: { setup: [], emits: [], state: null },
  // the returned directions are unit vectors on the XZ plane: the shared check reads them
  directions: ['forward', 'right'],
};
