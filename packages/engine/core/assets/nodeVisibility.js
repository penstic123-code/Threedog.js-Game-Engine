// KHR_node_visibility: a glTF node authored hidden ({ "extensions": { "KHR_node_visibility": { "visible": false } } }). three's GLTFLoader (0.187)
// does not read it, so a part hidden in Blender showed in the game. The children of a hidden node are hidden with it, which Object3D.visible already does.
// Registered on the engine's GLTFLoader (Assets.js): `loader.register(nodeVisibility)`.
const NAME = 'KHR_node_visibility';

/** GLTFLoader plugin: after the file is built, set visible = false on every node that says so */
export function nodeVisibility(parser) {
  return {
    name: NAME,
    async afterRoot() {
      const nodes = parser.json.nodes ?? [];
      for (let i = 0; i < nodes.length; i++) if (nodes[i].extensions?.[NAME]?.visible === false) (await parser.getDependency('node', i)).visible = false;
    },
  };
}
