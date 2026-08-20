import { describe, expect, it } from "vitest";
import {
  classifyProjectJson,
  isCanvasProjectPayload,
  projectImportKindMessage,
} from "./importFormat";

const canvasNode = {
  id: "canvas-image",
  kind: "image",
  name: "参考图",
  x: 12,
  y: 24,
  width: 320,
  height: 180,
};

describe("project import format", () => {
  it("recognizes a real canvas project instead of only checking nodes", () => {
    const packageValue = { nodes: [canvasNode], links: [], view: { x: 0, y: 0, zoom: 1 } };
    expect(isCanvasProjectPayload(packageValue)).toBe(true);
    expect(classifyProjectJson(packageValue)).toBe("canvas");
  });

  it("rejects a ComfyUI editor workflow even when its nodes list is empty", () => {
    const workflow = { last_node_id: 0, last_link_id: 0, nodes: [], links: [], version: 0.4 };
    expect(isCanvasProjectPayload(workflow)).toBe(false);
    expect(classifyProjectJson(workflow)).toBe("comfy-ui");
    expect(projectImportKindMessage("comfy-ui")).toContain("ComfyUI 编辑器工作流");
  });

  it("recognizes a ComfyUI API prompt separately from a project", () => {
    const workflow = {
      "3": { class_type: "KSampler", inputs: { seed: 1 } },
      "8": { class_type: "SaveImage", inputs: { filename_prefix: "test" } },
    };
    expect(classifyProjectJson(workflow)).toBe("comfy-api");
    expect(projectImportKindMessage("comfy-api")).toContain("ComfyUI API 工作流");
  });

  it("recognizes a wrapped ComfyUI API prompt but not an editor workflow", () => {
    const wrapped = {
      prompt: { "3": { class_type: "KSampler", inputs: { seed: 1 } } },
    };
    const editor = {
      last_node_id: 3,
      last_link_id: 0,
      nodes: [{ id: 3, type: "KSampler" }],
      links: [],
      version: 0.4,
    };

    expect(classifyProjectJson(wrapped)).toBe("comfy-api");
    expect(classifyProjectJson(editor)).toBe("comfy-ui");
  });

  it("does not mistake arbitrary JSON for a canvas project", () => {
    expect(classifyProjectJson({ hello: "world" })).toBe("unknown");
    expect(classifyProjectJson([{ class_type: "KSampler" }])).toBe("unknown");
  });
});
