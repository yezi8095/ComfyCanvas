import { describe, expect, it } from "vitest";

import { connectNodes, deleteNodes, moveGroup } from "./commands";
import type { CanvasNode, CanvasProject } from "./types";

const makeNode = (overrides: Partial<CanvasNode> & Pick<CanvasNode, "id" | "kind">): CanvasNode => ({
  x: 0,
  y: 0,
  width: 240,
  height: 160,
  name: overrides.id,
  ...overrides,
});

const makeProject = (overrides: Partial<CanvasProject> = {}): CanvasProject => ({
  nodes: [],
  links: [],
  view: { x: 0, y: 0, zoom: 1 },
  groups: [],
  ...overrides,
});

describe("deleteNodes", () => {
  it("cleans links, group membership and known workflow references in one command", () => {
    const keep = makeNode({
      id: "generator",
      kind: "onlineVideo",
      workflow: {
        prompt: "运镜",
        references: [
          { id: "image-delete", name: "删除", src: "delete.png" },
          { id: "image-keep", name: "保留", src: "keep.png" },
          "image-delete",
          { externalId: "image-delete" },
        ],
      },
    });
    const project = makeProject({
      nodes: [
        keep,
        makeNode({ id: "image-delete", kind: "image" }),
        makeNode({ id: "image-keep", kind: "image" }),
        makeNode({ id: "text-keep", kind: "text" }),
      ],
      links: [
        { id: "delete-out", from: "image-delete", to: "generator" },
        { id: "delete-in", from: "generator", to: "image-delete" },
        { id: "keep-link", from: "image-keep", to: "generator" },
      ],
      groups: [
        {
          id: "group-remains",
          name: "仍是分组",
          nodeIds: ["image-delete", "image-keep", "text-keep"],
          bounds: { x: 0, y: 0, w: 500, h: 300 },
        },
        {
          id: "group-collapses",
          name: "只剩一个节点",
          nodeIds: ["image-delete", "generator", "generator"],
          bounds: { x: 10, y: 10, w: 500, h: 300 },
        },
        {
          id: "group-empty",
          name: "没有节点",
          nodeIds: ["image-delete"],
          bounds: { x: 20, y: 20, w: 500, h: 300 },
        },
      ],
    });
    const before = structuredClone(project);

    const result = deleteNodes(project, ["image-delete"]);

    expect(result.nodes.map((node) => node.id)).toEqual(["generator", "image-keep", "text-keep"]);
    expect(result.links).toEqual([{
      id: "keep-link",
      from: "image-keep",
      fromPort: "image",
      to: "generator",
      toPort: "firstFrame",
    }]);
    expect(result.groups).toEqual([{
      id: "group-remains",
      name: "仍是分组",
      nodeIds: ["image-keep", "text-keep"],
      bounds: { x: 0, y: 0, w: 500, h: 300 },
    }]);
    expect(result.nodes[0].workflow).toEqual({
      prompt: "运镜",
      references: [
        { id: "image-keep", name: "保留", src: "keep.png" },
        { externalId: "image-delete" },
      ],
    });
    expect(project).toEqual(before);
  });

  it("keeps unknown workflow and reference shapes untouched", () => {
    const classWorkflow = new (class Workflow {
      references = [{ id: "deleted" }];
    })();
    const unknownEntry = new (class Reference {
      id = "deleted";
    })();
    const project = makeProject({
      nodes: [
        makeNode({ id: "deleted", kind: "image" }),
        makeNode({ id: "class-workflow", kind: "aiImage", workflow: classWorkflow }),
        makeNode({
          id: "plain-workflow",
          kind: "aiImage",
          workflow: { references: [unknownEntry, { id: "deleted" }] },
        }),
      ],
    });

    const result = deleteNodes(project, ["deleted"]);

    expect(result.nodes[0].workflow).toBe(classWorkflow);
    expect((result.nodes[1].workflow as { references: unknown[] }).references).toEqual([unknownEntry]);
  });
});

describe("connectNodes", () => {
  const project = makeProject({
    nodes: [
      makeNode({ id: "source", kind: "image" }),
      makeNode({ id: "target", kind: "aiImage" }),
    ],
    links: [{ id: "existing", from: "source", fromPort: "image", to: "target", toPort: "reference" }],
  });

  it("adds a valid port-to-port link without mutating its input", () => {
    const before = structuredClone(project);
    const result = connectNodes(project, {
      id: "mask-link",
      from: "source",
      fromPort: "mask",
      to: "target",
      toPort: "reference",
    });

    expect(result.links).toHaveLength(2);
    expect(result.links[1]).toEqual({
      id: "mask-link",
      from: "source",
      fromPort: "mask",
      to: "target",
      toPort: "reference",
    });
    expect(project).toEqual(before);
  });

  it.each([
    ["duplicate identity", { id: "new-id", from: "source", fromPort: "image", to: "target", toPort: "reference" }],
    ["duplicate id", { id: "existing", from: "source", fromPort: "mask", to: "target", toPort: "reference" }],
    ["missing source", { id: "missing-source", from: "missing", to: "target" }],
    ["missing target", { id: "missing-target", from: "source", to: "missing" }],
    ["self link", { id: "self", from: "source", to: "source" }],
  ])("rejects %s", (_label, link) => {
    expect(connectNodes(project, link).links).toEqual(project.links);
  });
});

describe("moveGroup", () => {
  it("moves the frame and all member nodes by exactly the same delta", () => {
    const project = makeProject({
      nodes: [
        makeNode({ id: "member-a", kind: "image", x: 20, y: 30 }),
        makeNode({ id: "member-b", kind: "text", x: 200, y: 80 }),
        makeNode({ id: "outside", kind: "video", x: 800, y: 900 }),
      ],
      groups: [{
        id: "group",
        name: "镜头组",
        nodeIds: ["member-a", "member-b"],
        bounds: { x: 10, y: 15, w: 500, h: 300 },
      }],
    });
    const before = structuredClone(project);

    const result = moveGroup(project, "group", { x: 45, y: -10 });

    expect(result.nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual([
      { id: "member-a", x: 65, y: 20 },
      { id: "member-b", x: 245, y: 70 },
      { id: "outside", x: 800, y: 900 },
    ]);
    expect(result.groups?.[0].bounds).toEqual({ x: 55, y: 5, w: 500, h: 300 });
    expect(project).toEqual(before);
  });

  it("does not move anything for a missing group or a non-finite delta", () => {
    const project = makeProject({
      nodes: [makeNode({ id: "node", kind: "image", x: 20, y: 30 })],
      groups: [{
        id: "group",
        name: "镜头组",
        nodeIds: ["node"],
        bounds: { x: 10, y: 15, w: 500, h: 300 },
      }],
    });

    expect(moveGroup(project, "missing", { x: 1, y: 1 }).nodes[0]).toMatchObject({ x: 20, y: 30 });
    expect(moveGroup(project, "group", { x: Number.NaN, y: 1 }).nodes[0]).toMatchObject({ x: 20, y: 30 });
  });
});

describe("runtime command normalization", () => {
  const runningProject = makeProject({
    schemaVersion: 3,
    nodes: [
      makeNode({ id: "running", kind: "onlineVideo", status: "running" }),
      makeNode({ id: "stopping", kind: "aiImage", status: "stopping" }),
      makeNode({ id: "source", kind: "image" }),
      makeNode({ id: "target", kind: "aiImage" }),
    ],
    groups: [{
      id: "group",
      name: "运行中分组",
      nodeIds: ["running", "stopping"],
      bounds: { x: 0, y: 0, w: 500, h: 300 },
    }],
  });

  it("does not reset unrelated running states while deleting", () => {
    const result = deleteNodes(runningProject, ["source"]);
    expect(result.nodes.find((node) => node.id === "running")?.status).toBe("running");
    expect(result.nodes.find((node) => node.id === "stopping")?.status).toBe("stopping");
  });

  it("does not reset unrelated running states while connecting", () => {
    const result = connectNodes(runningProject, { id: "link", from: "source", to: "target" });
    expect(result.nodes.find((node) => node.id === "running")?.status).toBe("running");
    expect(result.nodes.find((node) => node.id === "stopping")?.status).toBe("stopping");
  });

  it("does not reset group member running states while moving", () => {
    const result = moveGroup(runningProject, "group", { x: 20, y: 30 });
    expect(result.nodes.find((node) => node.id === "running")?.status).toBe("running");
    expect(result.nodes.find((node) => node.id === "stopping")?.status).toBe("stopping");
  });
});
