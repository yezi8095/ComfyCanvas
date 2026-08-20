import { describe, expect, it } from "vitest";

import type { GraphLink } from "../graph/types";
import type { CanvasNode, CanvasProject } from "../project/types";
import { createExecutionInputSignature } from "./inputSignature";

const node = (id: string, kind: CanvasNode["kind"], fields: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  kind,
  x: 0,
  y: 0,
  width: 320,
  height: 180,
  name: id,
  ...fields,
});

const project = (nodes: CanvasNode[], links: GraphLink[] = []): CanvasProject => ({
  nodes,
  links,
  view: { x: 0, y: 0, zoom: 1 },
});

describe("execution input signature", () => {
  it("ignores visual layout and transient execution state", () => {
    const original = project([
      node("prompt", "text", { text: "雨夜里的追逐" }),
      node("image", "aiImage", { workflow: { model: "seedream", steps: 28 } }),
    ], [{ id: "prompt-image", from: "prompt", fromPort: "text", to: "image", toPort: "prompt" }]);
    const moved = structuredClone(original);
    moved.view = { x: 999, y: -55, zoom: 2 };
    moved.nodes[0] = {
      ...moved.nodes[0],
      x: 2500,
      y: -1000,
      width: 11,
      height: 12,
      status: "running",
      createdAt: 123456,
      rotation: 90,
      validationErrors: ["temporary"],
    };

    expect(createExecutionInputSignature(original, "image"))
      .toBe(createExecutionInputSignature(moved, "image"));
  });

  it("changes for prompt, workflow, storyboard and reference-media content", () => {
    const base = project([
      node("reference", "image", {
        src: "data:image/png;base64,AAAA-REFERENCE-A",
        fileName: "hero.png",
        mediaWidth: 768,
        mediaHeight: 1024,
      }),
      node("story", "storyboard", { storyboard: [{ shot: "1", visual: "雨夜", dialogue: "快走" }] }),
      node("video", "onlineVideo", { text: "人物回头", workflow: { duration: 5, model: "seedance" } }),
    ], [
      { id: "reference-video", from: "reference", fromPort: "image", to: "video", toPort: "firstFrame" },
      { id: "story-video", from: "story", fromPort: "text", to: "video", toPort: "prompt" },
    ]);
    const baseline = createExecutionInputSignature(base, "video");

    const promptChanged = structuredClone(base);
    promptChanged.nodes[2].text = "人物转身离开";
    const workflowChanged = structuredClone(base);
    workflowChanged.nodes[2].workflow = { duration: 10, model: "seedance" };
    const storyboardChanged = structuredClone(base);
    storyboardChanged.nodes[1].storyboard![0].dialogue = "不要回头";
    const referenceChanged = structuredClone(base);
    referenceChanged.nodes[0].src = "data:image/png;base64,BBBB-REFERENCE-B";

    expect(createExecutionInputSignature(promptChanged, "video")).not.toBe(baseline);
    expect(createExecutionInputSignature(workflowChanged, "video")).not.toBe(baseline);
    expect(createExecutionInputSignature(storyboardChanged, "video")).not.toBe(baseline);
    expect(createExecutionInputSignature(referenceChanged, "video")).not.toBe(baseline);
  });

  it("tracks recursive upstream dependencies and real source/target ports only", () => {
    const base = project([
      node("prompt", "text", { text: "剑客站在山顶" }),
      node("picture", "aiImage", { text: "山峰", workflow: { model: "banana" } }),
      node("movie", "onlineVideo", { workflow: { model: "kling" } }),
      node("unrelated", "text", { text: "this branch must not affect the video" }),
    ], [
      { id: "prompt-picture", from: "prompt", fromPort: "text", to: "picture", toPort: "prompt" },
      { id: "picture-movie", from: "picture", fromPort: "image", to: "movie", toPort: "firstFrame" },
    ]);
    const baseline = createExecutionInputSignature(base, "movie");

    const upstreamChanged = structuredClone(base);
    upstreamChanged.nodes[0].text = "剑客在雨中回头";
    const reconnected = structuredClone(base);
    reconnected.links[1].toPort = "lastFrame";
    const unrelatedChanged = structuredClone(base);
    unrelatedChanged.nodes[3].text = "different";

    expect(createExecutionInputSignature(upstreamChanged, "movie")).not.toBe(baseline);
    expect(createExecutionInputSignature(reconnected, "movie")).not.toBe(baseline);
    expect(createExecutionInputSignature(unrelatedChanged, "movie")).toBe(baseline);
  });

  it("is stable across canvas/link ordering and never exposes input plaintext", () => {
    const secret = "fake-api-key-for-redaction-test-only";
    const dataUrl = "data:image/png;base64,VERY-LONG-REFERENCE-BYTES";
    const base = project([
      node("prompt", "text", { text: "夜景人物" }),
      node("image", "aiImage", { src: dataUrl, workflow: { apiKey: secret, prompt: "ignore no values" } }),
      node("video", "onlineVideo", { text: "让人物走向镜头" }),
    ], [
      { id: "prompt-video", from: "prompt", fromPort: "text", to: "video", toPort: "prompt" },
      { id: "image-video", from: "image", fromPort: "image", to: "video", toPort: "firstFrame" },
    ]);
    const reordered = project([...base.nodes].reverse(), [...base.links].reverse());
    const signature = createExecutionInputSignature(base, "video");

    expect(createExecutionInputSignature(reordered, "video")).toBe(signature);
    expect(signature).toMatch(/^exec-input:v1:[0-9a-f]{16}$/);
    expect(signature).not.toContain(secret);
    expect(signature).not.toContain(dataUrl);
    expect(signature).not.toContain("夜景人物");
  });

  it("handles cycles and dangling upstream links without recursion failure", () => {
    const graph = project([
      node("first", "text", { text: "first" }),
      node("second", "aiText", { text: "second" }),
    ], [
      { id: "first-second", from: "first", fromPort: "text", to: "second", toPort: "prompt" },
      { id: "second-first", from: "second", fromPort: "text", to: "first", toPort: "context" },
      { id: "missing-first", from: "deleted", fromPort: "text", to: "first", toPort: "context" },
    ]);

    const signature = createExecutionInputSignature(graph, "second");
    const changed = structuredClone(graph);
    changed.nodes[0].text = "changed";

    expect(signature).toMatch(/^exec-input:v1:[0-9a-f]{16}$/);
    expect(createExecutionInputSignature(changed, "second")).not.toBe(signature);
  });
});
