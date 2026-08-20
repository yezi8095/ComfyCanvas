import { describe, expect, it } from "vitest";
import type { CanvasProject } from "../project/types";
import {
  applyLegacyMediaMigration,
  canApplyLegacyMediaMigration,
  isLegacyMediaMigrationItemCurrent,
  legacyDataUrlToBlob,
  planLegacyMediaMigration,
} from "./legacyMediaMigration";

const imageData = "data:image/png;base64,SGVsbG8=";
const videoData = "data:video/mp4;base64,VmlkZW8=";

const project = (): CanvasProject => ({
  view: { x: 0, y: 0, zoom: 1 },
  links: [],
  nodes: [
    { id: "image-1", kind: "image", x: 0, y: 0, width: 100, height: 100, name: "角色 / 正面", src: imageData },
    { id: "text-1", kind: "text", x: 0, y: 0, width: 100, height: 100, name: "文本", text: imageData },
    {
      id: "ai-video",
      kind: "onlineVideo",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      name: "AI 视频",
      workflow: {
        prompt: "起舞",
        references: [
          { id: "ref-1", name: "首帧.jpg", kind: "image", src: imageData, source: "external" },
          { id: "ref-2", name: "已有文件", kind: "video", src: "asset://video.mp4", localPath: "D:\\video.mp4" },
          { id: "not-media", name: "文本", src: "data:text/plain;base64,SGk=" },
        ],
      },
    },
    { id: "video-1", kind: "video", x: 0, y: 0, width: 100, height: 100, name: "片段", src: videoData },
  ],
});

describe("legacy media migration", () => {
  it("plans only inline media nodes and direct AI references", () => {
    const plan = planLegacyMediaMigration(project(), "project-a");
    expect(plan.projectId).toBe("project-a");
    expect(plan.items.map((item) => item.id)).toEqual([
      "node:image-1",
      "reference:ai-video:ref-1",
      "node:video-1",
    ]);
    expect(plan.items[0]).toMatchObject({ mimeType: "image/png", kind: "image", fileName: "角色-正面.png" });
    expect(plan.items[1].locator).toEqual({ type: "ai-reference", nodeId: "ai-video", referenceId: "ref-1", referenceIndex: 0 });
  });

  it("replaces a node only after the exact planned source still matches", () => {
    const original = project();
    const item = planLegacyMediaMigration(original, "project-a").items[0];
    const replacement = {
      src: "asset://managed.png",
      localPath: "D:\\managed.png",
      asset: { projectId: "project-a", assetId: "asset-1", fileName: "managed.png", mimeType: "image/png", size: 5 },
    };
    const applied = applyLegacyMediaMigration(original, item, replacement);
    expect(applied.applied).toBe(true);
    expect(applied.project.nodes[0]).toMatchObject({ src: "asset://managed.png", localPath: "D:\\managed.png" });
    expect(original.nodes[0].src).toBe(imageData);

    const changed = { ...original, nodes: original.nodes.map((node) => node.id === "image-1" ? { ...node, src: "data:image/png;base64,NEW" } : node) };
    expect(isLegacyMediaMigrationItemCurrent(changed, item)).toBe(false);
    expect(applyLegacyMediaMigration(changed, item, replacement)).toMatchObject({ project: changed, applied: false, reason: "source-changed" });
  });

  it("patches one AI reference without overwriting concurrent workflow edits", () => {
    const original = project();
    const item = planLegacyMediaMigration(original, "project-a").items[1];
    const current = {
      ...original,
      nodes: original.nodes.map((node) => node.id === "ai-video"
        ? { ...node, workflow: { ...(node.workflow as object), prompt: "用户刚刚修改的提示词" } }
        : node),
    };
    const applied = applyLegacyMediaMigration(current, item, {
      src: "asset://reference.png",
      localPath: "D:\\reference.png",
      asset: { projectId: "project-a", assetId: "asset-ref", fileName: "reference.png", mimeType: "image/png", size: 5 },
    });
    expect(applied.applied).toBe(true);
    const workflow = applied.project.nodes.find((node) => node.id === "ai-video")?.workflow as { prompt: string; references: Array<{ src: string; localPath?: string }> };
    expect(workflow.prompt).toBe("用户刚刚修改的提示词");
    expect(workflow.references[0]).toMatchObject({ src: "asset://reference.png", localPath: "D:\\reference.png" });
    expect(workflow.references[1].src).toBe("asset://video.mp4");
  });

  it("refuses to write after a node or reference is removed", () => {
    const original = project();
    const items = planLegacyMediaMigration(original, "project-a").items;
    const withoutImage = { ...original, nodes: original.nodes.filter((node) => node.id !== "image-1") };
    const replacement = {
      src: "asset://managed.png",
      localPath: "D:\\managed.png",
      asset: { projectId: "project-a", assetId: "asset", fileName: "managed.png", mimeType: "image/png", size: 5 },
    };
    expect(applyLegacyMediaMigration(withoutImage, items[0], replacement).reason).toBe("node-missing");

    const withoutReference = {
      ...original,
      nodes: original.nodes.map((node) => node.id === "ai-video"
        ? { ...node, workflow: { ...(node.workflow as object), references: [] } }
        : node),
    };
    expect(applyLegacyMediaMigration(withoutReference, items[1], replacement).reason).toBe("reference-missing");
  });

  it("rejects a committed upload after the active project changes", () => {
    const original = project();
    const plan = planLegacyMediaMigration(original, "project-a");
    expect(canApplyLegacyMediaMigration(plan, "project-a", original, plan.items[0])).toBe(true);
    expect(canApplyLegacyMediaMigration(plan, "project-b", original, plan.items[0])).toBe(false);
  });

  it("decodes base64 and percent encoded data URLs into typed blobs", async () => {
    const base64 = legacyDataUrlToBlob(imageData);
    expect(base64.type).toBe("image/png");
    expect(await base64.text()).toBe("Hello");

    const plain = legacyDataUrlToBlob("data:image/svg+xml,%3Csvg%3E%E4%B8%AD%3C%2Fsvg%3E");
    expect(plain.type).toBe("image/svg+xml");
    expect(await plain.text()).toBe("<svg>中</svg>");
  });
});
