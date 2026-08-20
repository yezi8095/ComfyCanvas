import { describe, expect, it } from "vitest";

import type { StoredComfyWorkflow } from "../../ComfyWorkflowParameters";
import {
  isStoredComfyWorkflow,
  mergeImportedComfyWorkflows,
} from "./comfyWorkflowImport";
import type { CanvasProject } from "./types";

const workflow = (id: string, content: unknown, overrides: Partial<StoredComfyWorkflow> = {}): StoredComfyWorkflow => ({
  id,
  name: `工作流 ${id}`,
  description: "测试工作流",
  tags: ["测试"],
  format: "api",
  content,
  createdAt: 10,
  updatedAt: 20,
  ...overrides,
});

const project = (nodes: CanvasProject["nodes"]): CanvasProject => ({
  nodes,
  links: [],
  view: { x: 0, y: 0, zoom: 1 },
});

describe("Comfy workflow companion import", () => {
  it("accepts only structurally complete workflow entries and removes duplicate incoming IDs", () => {
    const valid = workflow("portrait", { prompt: { "1": { class_type: "KSampler" } } });
    const malformed = { ...workflow("bad", { prompt: {} }), tags: "not-an-array" };
    const result = mergeImportedComfyWorkflows([valid, malformed, { ...valid, name: "重复" }], [], project([]));

    expect(result.merged).toHaveLength(1);
    expect(result.merged[0]).toMatchObject({ id: "portrait", name: "工作流 portrait" });
    expect(result.report).toMatchObject({ incomingTotal: 3, accepted: 1, added: 1 });
    expect(result.skipped.map((entry) => entry.reason)).toEqual(["invalid", "duplicate-incoming"]);
    expect(isStoredComfyWorkflow(valid)).toBe(true);
    expect(isStoredComfyWorkflow(malformed)).toBe(false);
  });

  it("reuses a local workflow when the same ID has the same semantic content", () => {
    const existing = workflow("same", { prompt: { "1": { inputs: { text: "hello" } } } }, { name: "本机名称" });
    const incoming = workflow("same", { prompt: { "1": { inputs: { text: "hello" } } } }, { name: "包内名称", tags: ["导入"] });
    const canvas = project([{
      id: "node-a", kind: "aiImage", x: 0, y: 0, width: 200, height: 120, name: "图片",
      workflow: { source: "comfy", comfyWorkflowId: "same" },
    }]);

    const result = mergeImportedComfyWorkflows([incoming], [existing], canvas);

    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].name).toBe("本机名称");
    expect(result.remapped).toEqual([]);
    expect(result.report.reused).toEqual([{ id: "same", name: "本机名称", reason: "same-content" }]);
    expect(result.project).toBe(canvas);
  });

  it("isolates a conflicting ID and rewrites both standard and packaged canvas workflow references", () => {
    const local = workflow("shared", { prompt: { "1": { inputs: { text: "本机" } } } });
    const imported = workflow("shared", { prompt: { "1": { inputs: { text: "项目包" } } } });
    const canvas = project([
      {
        id: "standard", kind: "aiImage", x: 0, y: 0, width: 200, height: 120, name: "图片",
        workflow: { source: "comfy", comfyWorkflowId: "shared" },
      },
      {
        id: "package", kind: "api", x: 0, y: 0, width: 200, height: 120, name: "API",
        workflow: { __ymComfyPackage: true, libraryId: "shared", content: {}, parameters: [], values: {} },
      },
      {
        id: "not-package", kind: "api", x: 0, y: 0, width: 200, height: 120, name: "其他",
        workflow: { libraryId: "shared" },
      },
    ]);

    const result = mergeImportedComfyWorkflows([imported], [local], canvas, {
      idFactory: () => "shared-imported-copy",
    });

    expect(result.merged.map((item) => item.id)).toEqual(["shared", "shared-imported-copy"]);
    expect(result.remapped).toEqual([{
      sourceId: "shared", targetId: "shared-imported-copy", name: "工作流 shared", reason: "id-conflict",
    }]);
    expect((result.project.nodes[0].workflow as { comfyWorkflowId: string }).comfyWorkflowId).toBe("shared-imported-copy");
    expect((result.project.nodes[1].workflow as { libraryId: string }).libraryId).toBe("shared-imported-copy");
    expect((result.project.nodes[2].workflow as { libraryId: string }).libraryId).toBe("shared");
    expect(result.report.rewrittenCanvasNodeIds).toEqual(["standard", "package"]);
    expect((canvas.nodes[0].workflow as { comfyWorkflowId: string }).comfyWorkflowId).toBe("shared");
  });

  it("uses a stable safe fallback when a supplied factory collides with local IDs", () => {
    const local = workflow("shared", { prompt: { "1": { inputs: { text: "local" } } } });
    const occupied = workflow("occupied", { prompt: {} });
    const imported = workflow("shared", { prompt: { "1": { inputs: { text: "package" } } } });

    const first = mergeImportedComfyWorkflows([imported], [local, occupied], project([]), { idFactory: () => "occupied" });
    const second = mergeImportedComfyWorkflows([imported], [local, occupied], project([]), { idFactory: () => "occupied" });

    expect(first.remapped[0].targetId).not.toBe("occupied");
    expect(first.remapped[0].targetId).not.toBe("shared");
    expect(first.remapped[0].targetId).toBe(second.remapped[0].targetId);
  });

  it("does not allow non-finite metadata or cyclic workflow content into the merged library", () => {
    const cyclic: { prompt?: unknown } = {};
    cyclic.prompt = cyclic;
    const invalidTime = { ...workflow("time", {}), createdAt: Number.NaN };
    const result = mergeImportedComfyWorkflows([
      { ...workflow("cycle", cyclic) },
      invalidTime,
    ], [], project([]));

    expect(result.merged).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.every((entry) => entry.reason === "invalid")).toBe(true);
  });
});
