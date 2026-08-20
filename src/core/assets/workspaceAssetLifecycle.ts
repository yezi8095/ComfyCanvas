import {
  deleteWorkspaceAsset,
  type ManagedWorkspaceAsset,
} from "./workspaceAssetClient";

export type ManagedAssetDelete = (
  projectId: string,
  assetId: string,
) => Promise<boolean>;

export type ManagedAssetCleanupResult =
  | { status: "retained" }
  | { status: "deleted"; deleted: boolean }
  | { status: "failed"; error: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object");

/**
 * Search persisted project/director state for an exact managed descriptor.
 * Only the semantic `assetId` and `localPath` fields count as references; a
 * prompt that happens to contain the same text cannot retain or delete files.
 */
export const isManagedWorkspaceAssetReferenced = (
  asset: Pick<ManagedWorkspaceAsset, "assetId" | "localPath">,
  roots: readonly unknown[],
): boolean => {
  const visited = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (!isRecord(value)) return false;
    if (visited.has(value)) return false;
    visited.add(value);
    if (value.assetId === asset.assetId) return true;
    if (asset.localPath && value.localPath === asset.localPath) return true;
    return Object.values(value).some(visit);
  };
  return roots.some(visit);
};

/**
 * Conservative cleanup for a newly uploaded asset which failed to attach.
 * Existing assets are never passed here. Even then, a final reference scan is
 * required immediately before the exact backend deletion.
 */
export const cleanupUnattachedWorkspaceAsset = async (
  asset: ManagedWorkspaceAsset | undefined,
  referenceRoots: readonly unknown[],
  remove: ManagedAssetDelete = deleteWorkspaceAsset,
): Promise<ManagedAssetCleanupResult> => {
  if (!asset || isManagedWorkspaceAssetReferenced(asset, referenceRoots)) {
    return { status: "retained" };
  }
  try {
    return {
      status: "deleted",
      deleted: await remove(asset.projectId, asset.assetId),
    };
  } catch (error) {
    return { status: "failed", error };
  }
};
