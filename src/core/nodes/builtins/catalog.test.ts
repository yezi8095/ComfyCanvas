import { describe, expect, it } from "vitest";

import type { CanvasNodeKind } from "../types";
import {
  getBuiltinNodeDefinition,
  getLegacyPreferredInputPort,
  listBuiltinNodeDefinitions,
} from ".";

const expectedKinds: CanvasNodeKind[] = [
  "text",
  "storyboard",
  "image",
  "video",
  "audio",
  "aiText",
  "aiImage",
  "onlineVideo",
  "api",
  "batch",
];

describe("built-in node port catalog", () => {
  it("publishes a typed definition for every executable built-in kind", () => {
    expect(listBuiltinNodeDefinitions().map((definition) => definition.type)).toEqual(expectedKinds);

    for (const kind of expectedKinds) {
      const definition = getBuiltinNodeDefinition(kind);
      expect(definition?.type).toBe(kind);
      expect(definition?.outputs.length).toBeGreaterThan(0);
      expect(definition?.outputs.every((port) => port.direction === "output")).toBe(true);
      expect(definition?.inputs.every((port) => port.direction === "input")).toBe(true);
    }
  });

  it("keeps generation model inputs separated by media type", () => {
    expect(getBuiltinNodeDefinition("aiText")?.inputs.map((port) => [port.id, port.kind])).toEqual([
      ["prompt", "text"],
      ["context", "text"],
      ["references", "image"],
    ]);
    expect(getBuiltinNodeDefinition("aiImage")?.inputs.map((port) => [port.id, port.kind])).toEqual([
      ["prompt", "text"],
      ["references", "image"],
    ]);
    expect(getBuiltinNodeDefinition("onlineVideo")?.inputs.map((port) => [port.id, port.kind])).toEqual([
      ["prompt", "text"],
      ["firstFrame", "image"],
      ["lastFrame", "image"],
      ["references", "image"],
    ]);
  });

  it("declares stable legacy defaults for common authoring connections", () => {
    expect(getLegacyPreferredInputPort("aiImage", "text")).toBe("prompt");
    expect(getLegacyPreferredInputPort("aiText", "image")).toBe("references");
    expect(getLegacyPreferredInputPort("onlineVideo", "image")).toBe("firstFrame");
    expect(getLegacyPreferredInputPort("onlineVideo", "text")).toBe("prompt");
  });

  it("does not pretend annotations are executable graph nodes", () => {
    expect(getBuiltinNodeDefinition("annotation")).toBeUndefined();
    expect(getBuiltinNodeDefinition("annotationPointer")).toBeUndefined();
  });
});
