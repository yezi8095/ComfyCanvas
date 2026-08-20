import { describe, expect, it } from "vitest";

import type { GraphLink } from "../graph/types";
import type { CanvasNode, CanvasProject } from "../project/types";
import {
  getDownstreamNodeIds,
  getInvalidatedDownstreamNodeIds,
  getUpstreamNodeIds,
  planExecution,
  planExecutionScope,
} from "./plan";

const node = (id: string, kind: CanvasNode["kind"]): CanvasNode => ({
  id,
  kind,
  x: 0,
  y: 0,
  width: 320,
  height: 180,
  name: id,
});

const project = (nodes: CanvasNode[], links: GraphLink[] = []): CanvasProject => ({
  nodes,
  links,
  view: { x: 0, y: 0, zoom: 1 },
});

describe("execution planning", () => {
  it("plans typed text, image, video and API nodes without guessing node names", () => {
    const graph = project(
      [
        node("words", "text"),
        node("photo", "image"),
        node("movie", "onlineVideo"),
        node("clip", "video"),
        node("workflow", "api"),
      ],
      [
        { id: "words-movie", from: "words", fromPort: "text", to: "movie", toPort: "prompt" },
        { id: "photo-movie", from: "photo", fromPort: "image", to: "movie", toPort: "firstFrame" },
        { id: "movie-clip", from: "movie", fromPort: "video", to: "clip", toPort: "source" },
        { id: "clip-workflow", from: "clip", fromPort: "video", to: "workflow", toPort: "input" },
      ],
    );

    const single = planExecution(graph, { scope: "single", nodeId: "workflow" });
    expect(single.scheduledNodeIds).toEqual(["workflow"]);
    expect(single.upstreamNodeIds).toEqual(["words", "photo", "movie", "clip"]);
    expect(single.runnableNodeIds).toEqual(["workflow"]);
    expect(single.issues).toEqual([]);

    const downstream = planExecutionScope(graph, "downstream", "movie");
    expect(downstream.nodeIds).toEqual(["movie", "clip", "workflow"]);
    expect(downstream.executionOrder).toEqual(["movie", "clip", "workflow"]);

    const workflow = planExecution(graph, { scope: "workflow" });
    expect(workflow.executionOrder).toEqual(["words", "photo", "movie", "clip", "workflow"]);
    expect(workflow.runnableNodeIds).toEqual(workflow.executionOrder);
  });

  it("finds direct and transitive dependants for stale-result invalidation", () => {
    const graph = project(
      [node("copy", "text"), node("paint", "aiImage"), node("movie", "onlineVideo"), node("output", "video")],
      [
        { id: "copy-paint", from: "copy", fromPort: "text", to: "paint", toPort: "prompt" },
        { id: "paint-movie", from: "paint", fromPort: "image", to: "movie", toPort: "firstFrame" },
        { id: "movie-output", from: "movie", fromPort: "video", to: "output", toPort: "source" },
      ],
    );

    expect(getDownstreamNodeIds(graph, "copy")).toEqual(["paint", "movie", "output"]);
    expect(getInvalidatedDownstreamNodeIds(graph, "paint")).toEqual(["movie", "output"]);
    expect(getUpstreamNodeIds(graph, "output")).toEqual(["copy", "paint", "movie"]);
  });

  it("blocks a target with a dangling/orphan edge instead of silently running it", () => {
    const graph = project(
      [node("paint", "aiImage")],
      [{ id: "missing-prompt", from: "deleted-text", fromPort: "text", to: "paint", toPort: "prompt" }],
    );

    const plan = planExecution(graph, { scope: "single", nodeId: "paint" });
    expect(plan.runnableNodeIds).toEqual([]);
    expect(plan.blockedNodeIds).toEqual(["paint"]);
    expect(plan.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "orphan-link", nodeId: "paint", linkId: "missing-prompt" }),
    ]));
  });

  it("blocks bad typed ports and reports the exact mismatch", () => {
    const graph = project(
      [node("sound", "audio"), node("paint", "aiImage")],
      [{ id: "bad-port", from: "sound", fromPort: "audio", to: "paint", toPort: "prompt" }],
    );

    const plan = planExecution(graph, { scope: "single", nodeId: "paint" });
    expect(plan.blockedNodeIds).toEqual(["paint"]);
    expect(plan.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "type-mismatch", nodeId: "paint", portId: "prompt" }),
    ]));
  });

  it("blocks the receiving node when an imported link names a missing source port", () => {
    const graph = project(
      [node("copy", "text"), node("paint", "aiImage")],
      [{ id: "stale-source-slot", from: "copy", fromPort: "old-output", to: "paint", toPort: "prompt" }],
    );

    const plan = planExecution(graph, { scope: "single", nodeId: "paint" });
    expect(plan.runnableNodeIds).toEqual([]);
    expect(plan.blockedNodeIds).toEqual(["paint"]);
    expect(plan.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing-port", nodeId: "copy", portId: "old-output" }),
      expect.objectContaining({
        code: "invalid-input-link",
        nodeId: "paint",
        linkId: "stale-source-slot",
      }),
    ]));
  });

  it("does not block an unrelated target when another branch has a broken imported link", () => {
    const graph = project(
      [node("copy", "text"), node("paint", "aiImage"), node("other-copy", "text"), node("other-paint", "aiImage")],
      [
        { id: "valid-prompt", from: "copy", fromPort: "text", to: "paint", toPort: "prompt" },
        { id: "stale-other-slot", from: "other-copy", fromPort: "old-output", to: "other-paint", toPort: "prompt" },
      ],
    );

    const plan = planExecution(graph, { scope: "single", nodeId: "paint" });
    expect(plan.runnableNodeIds).toEqual(["paint"]);
    expect(plan.blockedNodeIds).toEqual([]);
  });

  it("blocks every member of a graph cycle, with a stable inspectable order", () => {
    const graph = project(
      [node("first", "text"), node("second", "aiText"), node("downstream", "aiImage")],
      [
        { id: "first-second", from: "first", fromPort: "text", to: "second", toPort: "prompt" },
        { id: "second-first", from: "second", fromPort: "text", to: "first", toPort: "context" },
        { id: "second-downstream", from: "second", fromPort: "text", to: "downstream", toPort: "prompt" },
      ],
    );

    const plan = planExecution(graph, { scope: "workflow" });
    expect(plan.executionOrder).toEqual(["first", "second", "downstream"]);
    expect(plan.blockedNodeIds).toEqual(["first", "second", "downstream"]);
    expect(plan.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "cycle", nodeId: "first" }),
      expect.objectContaining({ code: "cycle", nodeId: "second" }),
      expect.objectContaining({ code: "upstream-blocked", nodeId: "downstream" }),
    ]));
  });

  it("does not mutate frozen project data while planning", () => {
    const graph = project(
      [node("prompt", "text"), node("paint", "aiImage")],
      [{ id: "prompt-paint", from: "prompt", fromPort: "text", to: "paint", toPort: "prompt" }],
    );
    const snapshot = JSON.parse(JSON.stringify(graph)) as CanvasProject;
    Object.freeze(graph.nodes);
    Object.freeze(graph.links);
    Object.freeze(graph.view);
    Object.freeze(graph);

    expect(() => planExecution(graph, { scope: "workflow" })).not.toThrow();
    expect(graph).toEqual(snapshot);
  });
});
