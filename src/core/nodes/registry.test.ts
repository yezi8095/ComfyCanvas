import { afterEach, describe, expect, it } from "vitest";

import {
  clearNodeDefinitionsForTests,
  getNodeDefinition,
  listNodeDefinitions,
  registerNodeDefinition,
} from "./registry";
import type { NodeDefinition } from "./types";

const textDefinition: NodeDefinition = {
  type: "text",
  version: 1,
  label: "文本",
  description: "提供提示词或剧本文本",
  inputs: [{ id: "context", label: "上下文", kind: "text", direction: "input", multiple: true }],
  outputs: [{ id: "text", label: "文本", kind: "text", direction: "output" }],
  basicControls: [{ id: "text", label: "正文", type: "textarea", defaultValue: "" }],
  advancedControls: [],
};

afterEach(() => {
  clearNodeDefinitionsForTests();
});

describe("node definition registry", () => {
  it("registers, retrieves and lists the same frozen definition", () => {
    registerNodeDefinition(textDefinition);

    const stored = getNodeDefinition("text");
    expect(stored).toEqual(textDefinition);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(listNodeDefinitions()).toEqual([stored]);
    expect(getNodeDefinition("missing")).toBeUndefined();
  });

  it("rejects duplicate node kinds so definitions cannot silently override each other", () => {
    registerNodeDefinition(textDefinition);

    expect(() => registerNodeDefinition({ ...textDefinition, label: "另一个文本节点" }))
      .toThrow("节点类型已注册：text");
    expect(getNodeDefinition("text")?.label).toBe("文本");
  });

  it("can be reset between isolated application or test registries", () => {
    registerNodeDefinition(textDefinition);
    clearNodeDefinitionsForTests();

    expect(listNodeDefinitions()).toEqual([]);
    expect(() => registerNodeDefinition(textDefinition)).not.toThrow();
  });
});
