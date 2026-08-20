import { describe, expect, it } from "vitest";

import type { CanvasNode, CanvasProject } from "../project/types";
import {
  inferCompatiblePorts,
  upgradeLegacyLinks,
  validateNewLink,
} from "./validation";

const node = (id: string, kind: CanvasNode["kind"]): CanvasNode => ({
  id,
  kind,
  x: 0,
  y: 0,
  width: 320,
  height: 180,
  name: id,
});

const project = (
  nodes: CanvasNode[],
  links: CanvasProject["links"] = [],
): CanvasProject => ({
  nodes,
  links,
  view: { x: 0, y: 0, zoom: 1 },
});

describe("inferCompatiblePorts", () => {
  it.each([
    ["text", "aiImage", "text", "prompt"],
    ["image", "onlineVideo", "image", "firstFrame"],
    ["text", "onlineVideo", "text", "prompt"],
    ["image", "aiText", "image", "references"],
  ] as const)("allows %s -> %s", (fromKind, toKind, fromPort, toPort) => {
    const graph = project([node("from", fromKind), node("to", toKind)]);
    const pairs = inferCompatiblePorts(graph, "from", "to");

    expect(pairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromPort: expect.objectContaining({ id: fromPort }),
          toPort: expect.objectContaining({ id: toPort }),
        }),
      ]),
    );
    expect(validateNewLink(graph, "from", "to").valid).toBe(true);
  });

  it("rejects audio -> AI image instead of guessing by node name", () => {
    const graph = project([node("sound", "audio"), node("paint", "aiImage")]);
    const result = validateNewLink(graph, "sound", "paint");

    expect(inferCompatiblePorts(graph, "sound", "paint")).toEqual([]);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "type-mismatch", nodeId: "paint" }),
    ]);
  });

  it("returns no ports for non-executable annotation nodes", () => {
    const graph = project([node("note", "annotation"), node("paint", "aiImage")]);
    expect(inferCompatiblePorts(graph, "note", "paint")).toEqual([]);
  });
});

describe("validateNewLink", () => {
  it("resolves explicitly selected compatible ports into a complete link", () => {
    const graph = project([node("photo", "image"), node("movie", "onlineVideo")]);
    const result = validateNewLink(graph, "photo", "movie", {
      id: "chosen-link",
      fromPort: "image",
      toPort: "lastFrame",
    });

    expect(result).toMatchObject({
      valid: true,
      issues: [],
      link: {
        id: "chosen-link",
        from: "photo",
        fromPort: "image",
        to: "movie",
        toPort: "lastFrame",
      },
    });
  });

  it("rejects a type mismatch even when both requested port ids exist", () => {
    const graph = project([node("sound", "audio"), node("movie", "onlineVideo")]);
    const result = validateNewLink(graph, "sound", "movie", {
      fromPort: "audio",
      toPort: "firstFrame",
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "type-mismatch", portId: "firstFrame" }),
    ]);
  });

  it("rejects self-links", () => {
    const graph = project([node("copy", "text")]);
    const result = validateNewLink(graph, "copy", "copy");

    expect(result.valid).toBe(false);
    expect(result.issues.some((current) => current.code === "self-link")).toBe(true);
  });

  it("rejects a duplicate port-to-port link", () => {
    const graph = project(
      [node("words", "text"), node("paint", "aiImage")],
      [
        {
          id: "existing",
          from: "words",
          fromPort: "text",
          to: "paint",
          toPort: "prompt",
        },
      ],
    );
    const result = validateNewLink(graph, "words", "paint");

    expect(result.valid).toBe(false);
    expect(result.issues.some((current) => current.code === "duplicate-link")).toBe(true);
  });

  it("rejects a second source on a single-value input", () => {
    const graph = project(
      [node("words-a", "text"), node("words-b", "text"), node("paint", "aiImage")],
      [
        {
          id: "first-source",
          from: "words-a",
          fromPort: "text",
          to: "paint",
          toPort: "prompt",
        },
      ],
    );
    const result = validateNewLink(graph, "words-b", "paint");

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "single-input-occupied", portId: "prompt" }),
    ]);
  });

  it("allows multiple image references on a multi-value input", () => {
    const graph = project(
      [node("image-a", "image"), node("image-b", "image"), node("paint", "aiImage")],
      [
        {
          id: "first-reference",
          from: "image-a",
          fromPort: "image",
          to: "paint",
          toPort: "references",
        },
      ],
    );
    const result = validateNewLink(graph, "image-b", "paint");

    expect(result.valid).toBe(true);
    expect(result.link?.toPort).toBe("references");
  });

  it("rejects a link that would close a directed cycle", () => {
    const graph = project(
      [node("first", "text"), node("second", "aiText")],
      [
        {
          id: "forward",
          from: "first",
          fromPort: "text",
          to: "second",
          toPort: "prompt",
        },
      ],
    );
    const result = validateNewLink(graph, "second", "first");

    expect(result.valid).toBe(false);
    expect(result.issues.some((current) => current.code === "cycle")).toBe(true);
  });

  it("reports missing endpoint nodes without throwing", () => {
    const result = validateNewLink(project([node("words", "text")]), "words", "missing");
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "missing-node", nodeId: "missing" }),
    ]);
  });
});

describe("upgradeLegacyLinks", () => {
  it.each([
    ["text", "aiImage", "text", "prompt"],
    ["image", "onlineVideo", "image", "firstFrame"],
    ["text", "onlineVideo", "text", "prompt"],
    ["image", "aiText", "image", "references"],
  ] as const)(
    "upgrades an endpoint-only %s -> %s link",
    (fromKind, toKind, fromPort, toPort) => {
      const original = project(
        [node("from", fromKind), node("to", toKind)],
        [{ id: "legacy", from: "from", to: "to" }],
      );
      const result = upgradeLegacyLinks(original);

      expect(result.issues).toEqual([]);
      expect(result.project.links[0]).toEqual({
        id: "legacy",
        from: "from",
        fromPort,
        to: "to",
        toPort,
      });
      expect(original.links[0]).toEqual({ id: "legacy", from: "from", to: "to" });
    },
  );

  it("preserves an explicitly known port while filling the missing endpoint", () => {
    const original = project(
      [node("photo", "image"), node("movie", "onlineVideo")],
      [{ id: "partial", from: "photo", to: "movie", toPort: "lastFrame" }],
    );
    const result = upgradeLegacyLinks(original);

    expect(result.issues).toEqual([]);
    expect(result.project.links[0]).toMatchObject({
      fromPort: "image",
      toPort: "lastFrame",
    });
  });

  it("keeps an ambiguous wildcard legacy link unchanged and returns an issue", () => {
    const original = project(
      [node("workflow", "api"), node("movie", "onlineVideo")],
      [{ id: "ambiguous", from: "workflow", to: "movie" }],
    );
    const result = upgradeLegacyLinks(original);

    expect(result.project.links[0]).toEqual(original.links[0]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "legacy-port-unresolved",
        linkId: "ambiguous",
        nodeId: "movie",
      }),
    ]);
  });

  it("reports orphan legacy links instead of deleting project data silently", () => {
    const original = project(
      [node("words", "text")],
      [{ id: "orphan", from: "words", to: "missing" }],
    );
    const result = upgradeLegacyLinks(original);

    expect(result.project.links).toEqual(original.links);
    expect(result.issues[0]).toMatchObject({
      code: "legacy-port-unresolved",
      linkId: "orphan",
      nodeId: "missing",
    });
  });
});
