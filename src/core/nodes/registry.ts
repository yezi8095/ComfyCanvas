import type { NodeDefinition } from "./types";

const definitions = new Map<string, NodeDefinition>();

export const registerNodeDefinition = (definition: NodeDefinition) => {
  if (definitions.has(definition.type)) throw new Error(`节点类型已注册：${definition.type}`);
  definitions.set(definition.type, Object.freeze({ ...definition }));
};

export const getNodeDefinition = (type: string) => definitions.get(type);
export const listNodeDefinitions = () => [...definitions.values()];
export const clearNodeDefinitionsForTests = () => definitions.clear();
