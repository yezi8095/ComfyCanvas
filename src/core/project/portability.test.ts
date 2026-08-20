import { describe, expect, it } from "vitest";

import {
  PROJECT_PORTABILITY_MANIFEST_VERSION,
  analyzeProjectPortability,
  createProjectPortabilityManifest,
} from "./portability";

const node = (id: string, kind: string, source: Record<string, unknown> = {}) => ({
  id,
  kind,
  name: id,
  x: 0,
  y: 0,
  width: 100,
  height: 80,
  ...source,
});

const bySubject = (report: ReturnType<typeof analyzeProjectPortability>, subjectId: string) =>
  report.items.filter((item) => item.subjectId === subjectId);

describe("project package portability", () => {
  it("classifies only JSON-contained data and remote URLs as portable", () => {
    const report = analyzeProjectPortability({
      __ymProjectPackage: 2,
      nodes: [
        node("embedded", "image", { src: "data:image/png;base64,AAAA" }),
        node("remote", "video", { src: "https://cdn.example.com/clip.mp4" }),
        node("path", "audio", { localPath: "D:\\media\\voice.wav" }),
        node("blob", "image", { src: "blob:https://canvas/temporary" }),
        node("empty", "video"),
      ],
    });

    expect(bySubject(report, "embedded")[0]).toMatchObject({ status: "portable", code: "data-url-included" });
    expect(bySubject(report, "remote")[0]).toMatchObject({ status: "portable", code: "remote-url" });
    expect(bySubject(report, "path")[0]).toMatchObject({ status: "requiresRebind", code: "local-file" });
    expect(bySubject(report, "blob")[0]).toMatchObject({ status: "requiresRebind", code: "blob-url" });
    expect(bySubject(report, "empty")[0]).toMatchObject({ status: "missing", code: "source-missing" });
    expect(report.summary).toMatchObject({ portable: 2, requiresRebind: 2, missing: 1, fullyPortable: false });
  });

  it("checks included workflow library entries against every configured Comfy node", () => {
    const report = analyzeProjectPortability({
      __ymProjectPackage: 2,
      nodes: [
        node("selected", "aiImage", { workflow: { source: "comfy", comfyWorkflowId: "valid" } }),
        node("dangling", "onlineVideo", { workflow: { source: "comfy", comfyWorkflowId: "gone" } }),
        node("unselected", "aiText", { workflow: { source: "comfy" } }),
      ],
      comfyWorkflows: [
        { id: "valid", name: "可运行工作流", format: "api", content: { "1": { class_type: "SaveImage", inputs: {} } } },
        { id: "also-valid", name: "另一条可运行工作流", format: "api", content: { "2": { class_type: "SaveImage", inputs: {} } } },
        { id: "broken", name: "损坏工作流", format: "workflow", content: null },
      ],
      promptLibrary: ["镜头缓慢推进", "电影感"],
    });

    expect(bySubject(report, "valid")).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "workflowLibrary", status: "portable" }),
      expect.objectContaining({ category: "workflowReference", status: "portable" }),
    ]));
    expect(bySubject(report, "gone")).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "missing", code: "workflow-not-found" }),
    ]));
    expect(bySubject(report, "unselected")).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "requiresRebind", code: "workflow-unselected" }),
    ]));
    expect(bySubject(report, "broken")).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "missing", code: "workflow-invalid" }),
    ]));
  });

  it("checks references stored inside node workflows without assuming an ID is recoverable", () => {
    const report = analyzeProjectPortability({
      nodes: [
        node("canvas-image", "image", { src: "data:image/png;base64,AAAA" }),
        node("generator", "aiImage", {
          workflow: {
            references: [
              "canvas-image",
              { id: "external-data", src: "data:image/png;base64,BBBB" },
              { id: "temporary", src: "blob:https://canvas/1" },
              { id: "deleted-source" },
              42,
            ],
          },
        }),
      ],
    });

    expect(bySubject(report, "canvas-image")).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "canvasMedia", status: "portable" }),
      expect.objectContaining({ category: "workflowReference", status: "portable" }),
    ]));
    expect(bySubject(report, "external-data")[0]).toMatchObject({ category: "workflowReference", status: "portable" });
    expect(bySubject(report, "temporary")[0]).toMatchObject({ category: "workflowReference", status: "requiresRebind", code: "blob-url" });
    expect(bySubject(report, "deleted-source")[0]).toMatchObject({ category: "workflowReference", status: "missing", code: "reference-node-missing" });
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "workflowReference", status: "missing", code: "reference-invalid" }),
    ]));
  });

  it("does not claim director assets or timeline clips are portable when their sources are session-only or absent", () => {
    const report = analyzeProjectPortability({
      __ymProjectPackage: 2,
      nodes: [node("canvas-local", "image", { localPath: "C:\\input\\hero.png" })],
      directorAssets: [
        { id: "canvas-local", kind: "image", name: "画布角色", source: "canvas" },
        { id: "session", kind: "video", name: "临时视频", source: "external", src: "data:video/mp4;base64,AAAA" },
        { id: "missing-canvas", kind: "image", name: "丢失角色", source: "canvas" },
      ],
      director: {
        timeline: [{ assetId: "canvas-local" }, { assetId: "session" }, { assetId: "no-such-asset" }],
        audio: [],
      },
    });

    expect(bySubject(report, "canvas-local")).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "directorAsset", status: "requiresRebind" }),
      expect.objectContaining({ category: "directorTimeline", status: "requiresRebind" }),
    ]));
    expect(bySubject(report, "session")).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "directorAsset", status: "requiresRebind", code: "session-only" }),
      expect.objectContaining({ category: "directorTimeline", status: "requiresRebind" }),
    ]));
    expect(bySubject(report, "missing-canvas")[0]).toMatchObject({ status: "missing", code: "director-canvas-node-missing" });
    expect(bySubject(report, "no-such-asset")[0]).toMatchObject({ status: "missing", code: "director-timeline-asset-missing" });
  });

  it("remains backward compatible with raw canvas JSON and produces an additive manifest without mutation", () => {
    const raw = {
      nodes: [node("remote", "image", { src: "https://cdn.example.com/image.png" })],
      links: [],
      view: { x: 0, y: 0, zoom: 1 },
    };
    const before = JSON.stringify(raw);
    const report = analyzeProjectPortability(raw);
    const manifest = createProjectPortabilityManifest(raw, 1234);

    expect(report.packageKind).toBe("project");
    expect(report.summary.fullyPortable).toBe(true);
    expect(manifest).toMatchObject({
      type: "ym-project-portability",
      version: PROJECT_PORTABILITY_MANIFEST_VERSION,
      generatedAt: 1234,
      report,
    });
    expect(JSON.stringify(raw)).toBe(before);
  });
});
