import { describe, expect, it, vi } from "vitest";

import { CURRENT_PROJECT_SCHEMA, normalizeProject } from "./migrate";
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

describe("normalizeProject", () => {
  it("repairs an MP4 that an older custom Comfy saver persisted as an image node", () => {
    const result = normalizeProject(makeProject({
      nodes: [makeNode({
        id: "minimax-output",
        kind: "image",
        name: "MiniMax_H3_00004_.mp4",
        src: "http://127.0.0.1:8188/view?filename=MiniMax_H3_00004_.mp4&type=output",
      })],
    }));

    expect(result.nodes[0]).toMatchObject({ kind: "video", name: "MiniMax_H3_00004_.mp4" });
  });

  it("migrates legacy video outputs and annotations idempotently", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T08:00:00.000Z"));

    try {
      const input = makeProject({
        schemaVersion: 1,
        nodes: [
          makeNode({
            id: "note-1",
            kind: "annotation",
            x: 20,
            y: 30,
            width: 250,
            height: 90,
            name: "镜头批注",
            text: "人物停下脚步。",
            mirrored: true,
          }),
          makeNode({
            id: "video-generator-1",
            kind: "onlineVideo",
            x: 400,
            y: 120,
            width: 480,
            height: 300,
            name: "旧视频节点",
            src: "data:video/mp4;base64,AAAA",
            fileName: "legacy.mp4",
            mediaWidth: 1920,
            mediaHeight: 1080,
            status: "running",
          }),
        ],
      });

      const first = normalizeProject(input);
      const second = normalizeProject(first);

      expect(second).toEqual(first);
      expect(first.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA);
      expect(first.nodes.map((node) => node.id)).toEqual([
        "note-1",
        "video-generator-1",
        "video-output-video-generator-1",
        "annotation-pointer-note-1",
      ]);

      const annotation = first.nodes.find((node) => node.id === "note-1");
      const pointer = first.nodes.find((node) => node.id === "annotation-pointer-note-1");
      const generator = first.nodes.find((node) => node.id === "video-generator-1");
      const output = first.nodes.find((node) => node.id === "video-output-video-generator-1");

      expect(annotation).toMatchObject({ pointerId: "annotation-pointer-note-1", mirrored: undefined });
      expect(pointer).toMatchObject({ kind: "annotationPointer", annotationId: "note-1", mirrored: true });
      expect(generator).toMatchObject({ kind: "onlineVideo", width: 360, height: 240, status: "done" });
      expect(generator).not.toHaveProperty("src");
      expect(output).toMatchObject({ kind: "video", src: "data:video/mp4;base64,AAAA", fileName: "legacy.mp4" });
      expect(first.links).toEqual([{
        id: "legacy-video-link-video-output-video-generator-1",
        from: "video-generator-1",
        fromPort: "video",
        to: "video-output-video-generator-1",
        toPort: "source",
      }]);

      // Normalization must never mutate the document supplied by a repository.
      expect(input.nodes).toHaveLength(2);
      expect(input.nodes[0]).not.toHaveProperty("pointerId");
      expect(input.nodes[1]).toHaveProperty("src", "data:video/mp4;base64,AAAA");
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes orphan and duplicate links while preserving valid port identities", () => {
    const project = makeProject({
      nodes: [
        makeNode({ id: "source", kind: "image" }),
        makeNode({ id: "target", kind: "aiImage" }),
      ],
      links: [
        { id: "valid", from: "source", fromPort: "image", to: "target", toPort: "reference" },
        { id: "duplicate", from: "source", fromPort: "image", to: "target", toPort: "reference" },
        { id: "different-port", from: "source", fromPort: "mask", to: "target", toPort: "reference" },
        { id: "missing-source", from: "missing", to: "target" },
        { id: "missing-target", from: "source", to: "missing" },
      ],
    });

    expect(normalizeProject(project).links).toEqual([
      { id: "valid", from: "source", fromPort: "image", to: "target", toPort: "reference" },
      { id: "different-port", from: "source", fromPort: "mask", to: "target", toPort: "reference" },
    ]);
  });

  it("removes orphan node ids from groups without changing the surviving order", () => {
    const project = makeProject({
      nodes: [
        makeNode({ id: "node-a", kind: "text" }),
        makeNode({ id: "node-b", kind: "image" }),
      ],
      groups: [{
        id: "group-1",
        name: "有效分组",
        nodeIds: ["node-b", "missing", "node-a", "missing-again"],
        bounds: { x: 10, y: 20, w: 500, h: 300 },
      }],
    });

    expect(normalizeProject(project).groups).toEqual([{
      id: "group-1",
      name: "有效分组",
      nodeIds: ["node-b", "node-a"],
      bounds: { x: 10, y: 20, w: 500, h: 300 },
    }]);
  });

  it("removes empty, single-node and duplicate-only groups", () => {
    const project = makeProject({
      nodes: [
        makeNode({ id: "node-a", kind: "text" }),
        makeNode({ id: "node-b", kind: "image" }),
      ],
      groups: [
        {
          id: "empty",
          name: "空组",
          nodeIds: ["missing"],
          bounds: { x: 0, y: 0, w: 100, h: 100 },
        },
        {
          id: "single",
          name: "单节点组",
          nodeIds: ["node-a", "missing"],
          bounds: { x: 0, y: 0, w: 100, h: 100 },
        },
        {
          id: "duplicate-only",
          name: "重复单节点组",
          nodeIds: ["node-a", "node-a"],
          bounds: { x: 0, y: 0, w: 100, h: 100 },
        },
        {
          id: "valid",
          name: "有效组",
          nodeIds: ["node-b", "node-b", "node-a"],
          bounds: { x: 0, y: 0, w: 100, h: 100 },
        },
      ],
    });

    expect(normalizeProject(project).groups).toEqual([{
      id: "valid",
      name: "有效组",
      nodeIds: ["node-b", "node-a"],
      bounds: { x: 0, y: 0, w: 100, h: 100 },
    }]);
  });

  describe("schema 3 viewport migration", () => {
    it.each([
      [undefined, .12],
      [1, .44],
      [2, .449],
    ])("repairs legacy schema %s zoom %s once", (schemaVersion, zoom) => {
      const project = makeProject({
        schemaVersion,
        view: { x: 375, y: -240, zoom },
      });

      const migrated = normalizeProject(project);
      const normalizedAgain = normalizeProject(migrated);

      expect(migrated.schemaVersion).toBe(3);
      expect(migrated.view).toEqual({ x: 375, y: -240, zoom: .65 });
      expect(normalizedAgain).toEqual(migrated);
    });

    it("keeps the 45% legacy boundary unchanged", () => {
      const result = normalizeProject(makeProject({
        schemaVersion: 2,
        view: { x: 12, y: 34, zoom: .45 },
      }));

      expect(result.view).toEqual({ x: 12, y: 34, zoom: .45 });
    });

    it.each([.44, .2, .08])("preserves an intentional schema-3 zoom of %s", (zoom) => {
      const result = normalizeProject(makeProject({
        schemaVersion: 3,
        view: { x: -8, y: 19, zoom },
      }));

      expect(result.view).toEqual({ x: -8, y: 19, zoom });
    });

    it("keeps normal legacy zoom values unchanged", () => {
      const result = normalizeProject(makeProject({
        schemaVersion: 2,
        view: { x: 8, y: 9, zoom: .8 },
      }));

      expect(result.view).toEqual({ x: 8, y: 9, zoom: .8 });
    });
  });

  it.each(["running", "stopping"])("resets transient %s status to idle", (status) => {
    const project = makeProject({
      nodes: [makeNode({ id: status, kind: "api", status })],
    });

    expect(normalizeProject(project).nodes[0].status).toBe("idle");
  });

  it.each(["idle", "done", "error"])("preserves durable %s status", (status) => {
    const project = makeProject({
      nodes: [makeNode({ id: status, kind: "api", status })],
    });

    expect(normalizeProject(project).nodes[0].status).toBe(status);
  });
});
