import type { ManagedWorkspaceAsset } from "./workspaceAssetClient";
import type { CanvasProject } from "../project/types";

type UnknownRecord = Record<string, unknown>;

export type LegacyMediaKind = "image" | "video" | "audio";

export type LegacyMediaLocator =
  | { type: "node"; nodeId: string }
  | { type: "ai-reference"; nodeId: string; referenceId?: string; referenceIndex: number };

export interface LegacyMediaMigrationItem {
  id: string;
  label: string;
  kind: LegacyMediaKind;
  mimeType: string;
  fileName: string;
  dataUrl: string;
  locator: LegacyMediaLocator;
}

export interface LegacyMediaMigrationPlan {
  projectId: string;
  items: LegacyMediaMigrationItem[];
}

export interface LegacyMediaReplacement {
  src: string;
  localPath: string;
  asset: ManagedWorkspaceAsset;
}

export interface ApplyLegacyMediaMigrationResult {
  project: CanvasProject;
  applied: boolean;
  reason?: "node-missing" | "source-changed" | "reference-missing";
}

const MEDIA_KINDS = new Set<LegacyMediaKind>(["image", "video", "audio"]);
const DATA_URL_PATTERN = /^data:([^;,\s]+)?(?:;[^,]*)?,/i;
const SAFE_FILE_CHARACTER = /[^\p{L}\p{N}._-]+/gu;

const isRecord = (value: unknown): value is UnknownRecord =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

export const isLegacyInlineMediaSource = (value: unknown): value is string =>
  typeof value === "string" && DATA_URL_PATTERN.test(value);

const dataUrlMimeType = (dataUrl: string) =>
  DATA_URL_PATTERN.exec(dataUrl)?.[1]?.toLowerCase() || "application/octet-stream";

const kindFromMimeType = (mimeType: string): LegacyMediaKind | null => {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return null;
};

const extensionForMimeType = (mimeType: string) => ({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
}[mimeType] || "bin");

const safeMigrationFileName = (name: string, mimeType: string) => {
  const normalized = name.trim().replace(SAFE_FILE_CHARACTER, "-").replace(/^-+|-+$/g, "");
  const base = normalized || "legacy-media";
  return /\.[A-Za-z0-9]{1,8}$/.test(base)
    ? base
    : `${base}.${extensionForMimeType(mimeType)}`;
};

const referenceArray = (workflow: unknown): UnknownRecord[] => {
  if (!isRecord(workflow) || !Array.isArray(workflow.references)) return [];
  return workflow.references.filter(isRecord);
};

/**
 * Build an explicit migration plan without mutating the project. Only the two
 * legacy storage shapes owned by the canvas are considered: a media node's
 * `src` and an AI node's direct `workflow.references[].src`.
 */
export const planLegacyMediaMigration = (
  project: CanvasProject,
  projectId: string,
): LegacyMediaMigrationPlan => {
  const items: LegacyMediaMigrationItem[] = [];

  project.nodes.forEach((node) => {
    if (MEDIA_KINDS.has(node.kind as LegacyMediaKind) && isLegacyInlineMediaSource(node.src)) {
      const mimeType = dataUrlMimeType(node.src);
      const mimeKind = kindFromMimeType(mimeType);
      const kind = mimeKind || node.kind as LegacyMediaKind;
      items.push({
        id: `node:${node.id}`,
        label: node.name || node.fileName || `${kind} 素材`,
        kind,
        mimeType,
        fileName: safeMigrationFileName(node.fileName || node.name || `${kind}-${node.id}`, mimeType),
        dataUrl: node.src,
        locator: { type: "node", nodeId: node.id },
      });
    }

    referenceArray(node.workflow).forEach((reference, referenceIndex) => {
      if (!isLegacyInlineMediaSource(reference.src)) return;
      const mimeType = dataUrlMimeType(reference.src);
      const kind = kindFromMimeType(mimeType);
      // AI references are media inputs. Unknown or text data URLs are not
      // silently reclassified and therefore stay untouched.
      if (!kind) return;
      const referenceId = typeof reference.id === "string" && reference.id ? reference.id : undefined;
      const referenceName = typeof reference.name === "string" && reference.name
        ? reference.name
        : `参考素材 ${referenceIndex + 1}`;
      items.push({
        id: `reference:${node.id}:${referenceId || referenceIndex}`,
        label: `${node.name || "AI 节点"} · ${referenceName}`,
        kind,
        mimeType,
        fileName: safeMigrationFileName(referenceName, mimeType),
        dataUrl: reference.src,
        locator: { type: "ai-reference", nodeId: node.id, referenceId, referenceIndex },
      });
    });
  });

  return { projectId, items };
};

const findCurrentReference = (
  project: CanvasProject,
  locator: Extract<LegacyMediaLocator, { type: "ai-reference" }>,
) => {
  const node = project.nodes.find((candidate) => candidate.id === locator.nodeId);
  if (!node) return { node: undefined, reference: undefined, index: -1 };
  const references = referenceArray(node.workflow);
  const index = locator.referenceId
    ? references.findIndex((reference) => reference.id === locator.referenceId)
    : locator.referenceIndex;
  return { node, reference: references[index], index };
};

/** True only while the exact legacy source named by the plan still exists. */
export const isLegacyMediaMigrationItemCurrent = (
  project: CanvasProject,
  item: LegacyMediaMigrationItem,
) => {
  if (item.locator.type === "node") {
    const node = project.nodes.find((candidate) => candidate.id === item.locator.nodeId);
    return node?.src === item.dataUrl;
  }
  return findCurrentReference(project, item.locator).reference?.src === item.dataUrl;
};

/** Project identity and source equality form the asynchronous commit boundary. */
export const canApplyLegacyMediaMigration = (
  plan: LegacyMediaMigrationPlan,
  activeProjectId: string,
  project: CanvasProject,
  item: LegacyMediaMigrationItem,
) => plan.projectId === activeProjectId && isLegacyMediaMigrationItemCurrent(project, item);

/**
 * Apply one committed asset to the latest project snapshot. The original
 * DataURL must still match exactly. This makes a project switch, node delete,
 * reference removal or user replacement a stale result instead of a write.
 */
export const applyLegacyMediaMigration = (
  project: CanvasProject,
  item: LegacyMediaMigrationItem,
  replacement: LegacyMediaReplacement,
): ApplyLegacyMediaMigrationResult => {
  if (item.locator.type === "node") {
    const index = project.nodes.findIndex((node) => node.id === item.locator.nodeId);
    if (index < 0) return { project, applied: false, reason: "node-missing" };
    if (project.nodes[index].src !== item.dataUrl) {
      return { project, applied: false, reason: "source-changed" };
    }
    const nodes = [...project.nodes];
    nodes[index] = { ...nodes[index], src: replacement.src, localPath: replacement.localPath };
    return { project: { ...project, nodes }, applied: true };
  }

  const located = findCurrentReference(project, item.locator);
  if (!located.node) return { project, applied: false, reason: "node-missing" };
  if (!located.reference || located.index < 0) {
    return { project, applied: false, reason: "reference-missing" };
  }
  if (located.reference.src !== item.dataUrl) {
    return { project, applied: false, reason: "source-changed" };
  }

  const workflow = located.node.workflow as UnknownRecord;
  const references = [...(workflow.references as unknown[])];
  references[located.index] = {
    ...located.reference,
    src: replacement.src,
    localPath: replacement.localPath,
  };
  const nodes = project.nodes.map((node) => node.id === located.node?.id
    ? { ...node, workflow: { ...workflow, references } }
    : node);
  return { project: { ...project, nodes }, applied: true };
};

const decodeBase64InParts = (payload: string) => {
  // Keep chunks divisible by four so every atob call starts at a Base64
  // quantum boundary. This avoids one full decoded binary string in memory.
  const encodedChunkCharacters = 256 * 1024;
  const parts: ArrayBuffer[] = [];
  for (let offset = 0; offset < payload.length; offset += encodedChunkCharacters) {
    const binary = atob(payload.slice(offset, offset + encodedChunkCharacters));
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    parts.push(buffer);
  }
  return parts;
};

/** Convert an existing inline source to a Blob without a second full data URL. */
export const legacyDataUrlToBlob = (dataUrl: string): Blob => {
  const comma = dataUrl.indexOf(",");
  const header = comma >= 0 ? dataUrl.slice(0, comma) : "";
  if (comma < 0 || !/^data:/i.test(header)) throw new Error("旧媒体不是有效 DataURL");
  const mimeType = dataUrlMimeType(dataUrl);
  const payload = dataUrl.slice(comma + 1);
  if (/;base64(?:;|$)/i.test(header)) {
    return new Blob(decodeBase64InParts(payload.replace(/\s+/g, "")), { type: mimeType });
  }
  try {
    return new Blob([decodeURIComponent(payload)], { type: mimeType });
  } catch {
    throw new Error("旧媒体 DataURL 的文本编码无效");
  }
};
