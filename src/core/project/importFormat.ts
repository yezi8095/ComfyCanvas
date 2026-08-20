import type { CanvasNodeKind } from "../nodes/types";

export type ProjectJsonKind = "canvas" | "comfy-ui" | "comfy-api" | "unknown";

const canvasNodeKinds = new Set<CanvasNodeKind>([
  "image", "video", "audio", "text", "storyboard", "api", "batch",
  "aiText", "aiImage", "onlineVideo", "annotation", "annotationPointer",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const isComfyUiEditorPayload = (value: Record<string, unknown>) => {
  const nodes = value.nodes;
  if (!Array.isArray(nodes)) return false;
  // The editor keeps one or more of these top-level bookkeeping fields even
  // when the graph is empty. They let us reject an empty editor graph rather
  // than silently treating it as an empty 亿幕 project.
  if ("last_node_id" in value || "last_link_id" in value || "version" in value) return true;
  return nodes.some((node) => isRecord(node) && (
    typeof node.type === "string" ||
    typeof node.class_type === "string" ||
    typeof node.id === "number"
  ));
};

/**
 * A ComfyUI editor save and an 亿幕 canvas project both have a top-level
 * `nodes` array.  Never use that property alone to decide that a file is a
 * canvas project: editor nodes use numeric ids and a `type`, whereas canvas
 * nodes have a typed, positioned card contract.
 */
export const isCanvasProjectPayload = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (isComfyUiEditorPayload(value)) return false;
  const nodes = value.nodes;
  if (!Array.isArray(nodes)) return false;
  return nodes.every((node) => {
    if (!isRecord(node)) return false;
    return typeof node.id === "string" &&
      typeof node.kind === "string" && canvasNodeKinds.has(node.kind as CanvasNodeKind) &&
      typeof node.name === "string" &&
      [node.x, node.y, node.width, node.height].every((coordinate) =>
        typeof coordinate === "number" && Number.isFinite(coordinate),
      ) && Number(node.width) > 0 && Number(node.height) > 0;
  });
};

const hasComfyApiNodes = (value: Record<string, unknown>) =>
  Object.values(value).some((node) => isRecord(node) && typeof node.class_type === "string");

const isComfyApiPayload = (value: Record<string, unknown>) => {
  if (hasComfyApiNodes(value)) return true;
  // Some ComfyUI integrations wrap the API node map in `{ prompt: ... }`.
  // Accept that contract, but never fall back to “any object is runnable”.
  return isRecord(value.prompt) && hasComfyApiNodes(value.prompt);
};

/** Classify JSON before choosing whether to open a project or import a workflow. */
export const classifyProjectJson = (value: unknown): ProjectJsonKind => {
  if (!isRecord(value)) return "unknown";
  if (isComfyUiEditorPayload(value)) return "comfy-ui";
  if (isCanvasProjectPayload(value)) return "canvas";
  if (isComfyApiPayload(value)) return "comfy-api";
  return "unknown";
};

export const projectImportKindMessage = (kind: Exclude<ProjectJsonKind, "canvas">) => {
  if (kind === "comfy-ui") {
    return "检测到这是 ComfyUI 编辑器工作流，不是亿幕画布项目。请在 ComfyUI 中导出 API JSON 后使用“导入 API 工作流”，或在工作流库中导入。";
  }
  if (kind === "comfy-api") {
    return "检测到这是 ComfyUI API 工作流，不是亿幕画布项目。请将文件拖到画布中导入 API 工作流，或在工作流库中导入。";
  }
  return "项目文件格式不正确";
};
