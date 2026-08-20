import { describe, expect, it, vi } from "vitest";
import {
  cleanupUnattachedWorkspaceAsset,
  isManagedWorkspaceAssetReferenced,
} from "./workspaceAssetLifecycle";

const asset = {
  projectId: "project_1",
  assetId: "asset_1",
  localPath: "C:\\app\\workspace-v1\\projects\\project_1\\assets\\asset_1--portrait.png",
  fileName: "portrait.png",
  mimeType: "image/png",
  size: 12,
};

describe("workspace asset lifecycle", () => {
  it("recognizes exact canvas and director references", () => {
    expect(isManagedWorkspaceAssetReferenced(asset, [{ nodes: [{ localPath: asset.localPath }] }])).toBe(true);
    expect(isManagedWorkspaceAssetReferenced(asset, [{ directorAssets: [{ assetId: asset.assetId }] }])).toBe(true);
    expect(isManagedWorkspaceAssetReferenced(asset, [{ prompt: asset.localPath }])).toBe(false);
    expect(isManagedWorkspaceAssetReferenced(asset, [{ assetId: "asset_10" }])).toBe(false);
  });

  it("retains an uploaded asset if any live state already references it", async () => {
    const remove = vi.fn(async () => true);
    await expect(cleanupUnattachedWorkspaceAsset(asset, [{ assetId: asset.assetId }], remove))
      .resolves.toEqual({ status: "retained" });
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes only the exact new asset when no state references it", async () => {
    const remove = vi.fn(async () => true);
    await expect(cleanupUnattachedWorkspaceAsset(asset, [{ assetId: "other" }], remove))
      .resolves.toEqual({ status: "deleted", deleted: true });
    expect(remove).toHaveBeenCalledWith("project_1", "asset_1");
  });

  it("reports deletion failures without throwing over the original import flow", async () => {
    const error = new Error("locked");
    await expect(cleanupUnattachedWorkspaceAsset(asset, [], async () => { throw error; }))
      .resolves.toEqual({ status: "failed", error });
  });
});
