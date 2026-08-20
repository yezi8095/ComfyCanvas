import type { CanvasNodeKind } from "../nodes/types";

/**
 * Import/export never copies files out of the user's machine.  This module is
 * the deliberately conservative truth source for explaining that boundary to
 * the UI.  It has no browser, Tauri or localStorage dependency, so it can run
 * before importing a package and in tests.
 */
export const PROJECT_PORTABILITY_MANIFEST_VERSION = 1 as const;

export type ProjectPortabilityStatus = "portable" | "requiresRebind" | "missing";

export type ProjectPortabilityCategory =
  | "projectPackage"
  | "canvasMedia"
  | "workflowReference"
  | "workflowLibrary"
  | "promptLibrary"
  | "directorAsset"
  | "directorTimeline";

export type ProjectPortabilityCode =
  | "data-url-included"
  | "remote-url"
  | "local-file"
  | "local-protocol"
  | "blob-url"
  | "session-only"
  | "source-missing"
  | "source-invalid"
  | "workflow-library-invalid"
  | "workflow-library-empty"
  | "workflow-included"
  | "workflow-not-found"
  | "workflow-invalid"
  | "workflow-unselected"
  | "reference-invalid"
  | "reference-node-missing"
  | "prompt-library-invalid"
  | "prompt-library-entry-invalid"
  | "director-asset-invalid"
  | "director-asset-duplicate"
  | "director-canvas-node-missing"
  | "director-timeline-asset-missing"
  | "director-timeline-rebind";

export interface ProjectPortabilityItem {
  /** Stable within one analysis result.  It is safe to use as a list key. */
  id: string;
  status: ProjectPortabilityStatus;
  category: ProjectPortabilityCategory;
  code: ProjectPortabilityCode;
  label: string;
  message: string;
  /** Canvas node / workflow / director asset that needs attention, if known. */
  subjectId?: string;
  /** Never a copy of file bytes; useful for a UI that wants to show the source. */
  source?: string;
}

export interface ProjectPortabilitySummary {
  portable: number;
  requiresRebind: number;
  missing: number;
  /** True only when importing the JSON can reproduce every declared dependency. */
  fullyPortable: boolean;
}

export interface ProjectPortabilityReport {
  manifestVersion: typeof PROJECT_PORTABILITY_MANIFEST_VERSION;
  /** `package` is a versioned export; `project` is a legacy raw canvas JSON. */
  packageKind: "package" | "project" | "invalid";
  packageVersion?: number;
  items: ProjectPortabilityItem[];
  summary: ProjectPortabilitySummary;
}

/** Optional, additive export field for a later App integration.  It is a
 * snapshot for display only: callers must re-run the analyzer after imports or
 * source changes instead of trusting a stale manifest. */
export interface ProjectPortabilityManifest {
  type: "ym-project-portability";
  version: typeof PROJECT_PORTABILITY_MANIFEST_VERSION;
  generatedAt: number;
  report: ProjectPortabilityReport;
}

type RecordValue = Record<string, unknown>;

type RawCanvasNode = {
  id: string;
  kind: CanvasNodeKind | string;
  name: string;
  src?: unknown;
  localPath?: unknown;
  sessionOnly?: unknown;
  workflow?: unknown;
};

type SourceDescriptor = {
  src?: unknown;
  localPath?: unknown;
  sessionOnly?: unknown;
  /** Director external imports intentionally treat their FileReader data as
   * temporary, even when an old package still happens to contain it. */
  dataIsSessionOnly?: boolean;
};

type SourceAssessment = Pick<ProjectPortabilityItem, "status" | "code" | "message" | "source">;

const mediaKinds = new Set<CanvasNodeKind>(["image", "video", "audio"]);

const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stringValue = (value: unknown) => typeof value === "string" ? value.trim() : "";

const validNode = (value: unknown): RawCanvasNode | null => {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  if (!id) return null;
  return {
    id,
    kind: typeof value.kind === "string" ? value.kind : "text",
    name: stringValue(value.name) || id,
    src: value.src,
    localPath: value.localPath,
    sessionOnly: value.sessionOnly,
    workflow: value.workflow,
  };
};

const sourceAssessment = ({ src, localPath, sessionOnly, dataIsSessionOnly = false }: SourceDescriptor): SourceAssessment => {
  const normalizedSource = stringValue(src);
  const normalizedPath = stringValue(localPath);
  if (sessionOnly === true) {
    return {
      status: "requiresRebind",
      code: "session-only",
      message: "这是仅当前会话可用的素材；导入到另一台电脑后需要重新选择文件。",
      source: normalizedSource || normalizedPath || undefined,
    };
  }
  if (src !== undefined && typeof src !== "string") {
    return { status: "missing", code: "source-invalid", message: "素材地址不是有效文本，无法恢复。" };
  }
  if (localPath !== undefined && typeof localPath !== "string") {
    return { status: "missing", code: "source-invalid", message: "素材本机路径不是有效文本，无法恢复。" };
  }
  if (!normalizedSource) {
    if (normalizedPath) {
      return {
        status: "requiresRebind",
        code: "local-file",
        message: "素材只记录了原电脑的本机路径；导入后请重新绑定文件。",
        source: normalizedPath,
      };
    }
    return { status: "missing", code: "source-missing", message: "素材没有可恢复的地址或内嵌内容。" };
  }
  if (/^data:/i.test(normalizedSource)) {
    if (dataIsSessionOnly) {
      return {
        status: "requiresRebind",
        code: "session-only",
        message: "该外部素材的 Data URL 属于临时会话内容；导入后请重新选择文件。",
        source: normalizedSource,
      };
    }
    return {
      status: "portable",
      code: "data-url-included",
      message: "素材数据已内嵌在项目 JSON 中，可随项目导入。",
      source: normalizedSource,
    };
  }
  if (/^blob:/i.test(normalizedSource)) {
    return {
      status: "requiresRebind",
      code: "blob-url",
      message: "浏览器 Blob 地址只在原会话有效；导入后请重新绑定文件。",
      source: normalizedSource,
    };
  }
  if (/^https?:/i.test(normalizedSource)) {
    return {
      status: "portable",
      code: "remote-url",
      message: "素材使用远程 URL；另一台电脑仍需能够访问该网络地址。",
      source: normalizedSource,
    };
  }
  if (/^(?:asset:|tauri:|file:)/i.test(normalizedSource) || /^[a-z]:[\\/]/i.test(normalizedSource) || /^\\\\/.test(normalizedSource)) {
    return {
      status: "requiresRebind",
      code: /^(?:asset:|tauri:)/i.test(normalizedSource) ? "local-protocol" : "local-file",
      message: "素材引用原电脑的本机文件或应用协议；导入后请重新绑定文件。",
      source: normalizedSource,
    };
  }
  return {
    status: "requiresRebind",
    code: "local-file",
    message: "素材地址不是可验证的跨设备 URL；为避免误判，请在导入后重新绑定。",
    source: normalizedSource,
  };
};

const addItem = (
  items: ProjectPortabilityItem[],
  item: Omit<ProjectPortabilityItem, "id">,
) => {
  items.push({ ...item, id: `${item.category}:${item.subjectId || "package"}:${items.length}` });
};

const toItem = (
  category: ProjectPortabilityCategory,
  label: string,
  subjectId: string | undefined,
  assessment: SourceAssessment,
): Omit<ProjectPortabilityItem, "id"> => ({
  category,
  label,
  subjectId,
  ...assessment,
});

type WorkflowLibraryEntry = { id: string; name: string; valid: boolean; runnableApi: boolean };

const inspectWorkflowLibrary = (raw: unknown, items: ProjectPortabilityItem[]): Map<string, WorkflowLibraryEntry> | null => {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) {
    addItem(items, {
      status: "missing", category: "workflowLibrary", code: "workflow-library-invalid", label: "ComfyUI 工作流库",
      message: "工作流库不是数组，无法恢复其中的工作流。",
    });
    return new Map();
  }
  if (raw.length === 0) {
    addItem(items, {
      status: "portable", category: "workflowLibrary", code: "workflow-library-empty", label: "ComfyUI 工作流库",
      message: "项目包未包含 ComfyUI 工作流；当前未引用时不会阻止导入。",
    });
    return new Map();
  }

  const result = new Map<string, WorkflowLibraryEntry>();
  raw.forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      addItem(items, {
        status: "missing", category: "workflowLibrary", code: "workflow-library-invalid", label: `工作流 #${index + 1}`,
        message: "工作流条目不是对象，无法恢复。",
      });
      return;
    }
    const id = stringValue(candidate.id);
    const name = stringValue(candidate.name) || (id ? `工作流 ${id}` : `工作流 #${index + 1}`);
    const format = candidate.format;
    const content = candidate.content;
    const apiContent = candidate.apiContent;
    const payloadIsValid = format === "workflow"
      ? isRecord(content)
      : format === "api"
        ? isRecord(content) || isRecord(apiContent)
        : false;
    if (!id || result.has(id)) {
      addItem(items, {
        status: "missing", category: "workflowLibrary", code: "workflow-library-invalid", label: name, subjectId: id || undefined,
        message: !id ? "工作流缺少稳定 ID，节点无法可靠引用它。" : "工作流 ID 重复，节点无法确定该使用哪一个工作流。",
      });
      return;
    }
    const valid = payloadIsValid;
    // Creation nodes submit API prompts.  A visual Workflow-only document is
    // valuable in the library, but it is not a runnable selection until it
    // has API content (or is converted/scanned by the workflow library).
    const runnableApi = valid && (format === "api" || isRecord(apiContent));
    result.set(id, { id, name, valid, runnableApi });
    addItem(items, {
      status: valid ? "portable" : "missing",
      category: "workflowLibrary",
      code: valid ? "workflow-included" : "workflow-invalid",
      label: name,
      subjectId: id,
      message: valid ? "工作流 JSON 已随项目包保存。运行前仍会以当前 ComfyUI 的节点/模型为准校验。" : "工作流缺少可用的 Workflow/API JSON 或格式标记，无法运行。",
    });
  });
  return result;
};

const inspectPromptLibrary = (raw: unknown, items: ProjectPortabilityItem[]) => {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    addItem(items, {
      status: "missing", category: "promptLibrary", code: "prompt-library-invalid", label: "提示词库",
      message: "提示词库不是数组，无法导入。",
    });
    return;
  }
  if (raw.length === 0) {
    addItem(items, {
      status: "portable", category: "promptLibrary", code: "workflow-library-empty", label: "提示词库",
      message: "项目包包含空提示词库。",
    });
    return;
  }
  raw.forEach((entry, index) => {
    const value = stringValue(entry);
    addItem(items, {
      status: value ? "portable" : "missing",
      category: "promptLibrary",
      code: value ? "workflow-included" : "prompt-library-entry-invalid",
      label: value || `提示词 #${index + 1}`,
      message: value ? "提示词文本已随项目包保存。" : "提示词条目为空或不是文本，无法恢复。",
    });
  });
};

const recordReferences = (workflow: unknown) =>
  isRecord(workflow) && Array.isArray(workflow.references) ? workflow.references : undefined;

const workflowValue = (workflow: unknown, key: string) =>
  isRecord(workflow) ? workflow[key] : undefined;

const inspectWorkflowReference = (
  reference: unknown,
  index: number,
  owner: RawCanvasNode,
  nodesById: ReadonlyMap<string, RawCanvasNode>,
  items: ProjectPortabilityItem[],
) => {
  const label = `“${owner.name}”的参考 ${index + 1}`;
  if (typeof reference === "string") {
    const id = reference.trim();
    const target = nodesById.get(id);
    if (!id || !target) {
      addItem(items, { status: "missing", category: "workflowReference", code: "reference-node-missing", label, subjectId: id || owner.id, message: "参考素材节点不存在，无法在导入后恢复。" });
      return;
    }
    if (!mediaKinds.has(target.kind as CanvasNodeKind)) {
      addItem(items, { status: "missing", category: "workflowReference", code: "reference-invalid", label, subjectId: id, message: "参考指向的不是图片、视频或音频素材节点。" });
      return;
    }
    addItem(items, toItem("workflowReference", label, id, sourceAssessment(target)));
    return;
  }
  if (!isRecord(reference)) {
    addItem(items, { status: "missing", category: "workflowReference", code: "reference-invalid", label, subjectId: owner.id, message: "参考条目不是可识别的素材引用。" });
    return;
  }
  const id = stringValue(reference.id);
  if (reference.src !== undefined || reference.localPath !== undefined || reference.sessionOnly === true) {
    addItem(items, toItem("workflowReference", label, id || owner.id, sourceAssessment({
      src: reference.src,
      localPath: reference.localPath,
      sessionOnly: reference.sessionOnly,
    })));
    return;
  }
  const target = id ? nodesById.get(id) : undefined;
  if (!target) {
    addItem(items, { status: "missing", category: "workflowReference", code: "reference-node-missing", label, subjectId: id || owner.id, message: "参考素材没有内嵌内容且未找到对应的画布节点。" });
    return;
  }
  if (!mediaKinds.has(target.kind as CanvasNodeKind)) {
    addItem(items, { status: "missing", category: "workflowReference", code: "reference-invalid", label, subjectId: id, message: "参考指向的不是图片、视频或音频素材节点。" });
    return;
  }
  addItem(items, toItem("workflowReference", label, id, sourceAssessment(target)));
};

const inspectNodeWorkflow = (
  node: RawCanvasNode,
  nodesById: ReadonlyMap<string, RawCanvasNode>,
  workflows: ReadonlyMap<string, WorkflowLibraryEntry> | null,
  items: ProjectPortabilityItem[],
) => {
  const workflow = node.workflow;
  if (!isRecord(workflow)) return;
  const source = stringValue(workflow.source);
  const comfyWorkflowId = stringValue(workflow.comfyWorkflowId);
  if (comfyWorkflowId) {
    const selected = workflows?.get(comfyWorkflowId);
    if (!workflows) {
      addItem(items, { status: "missing", category: "workflowReference", code: "workflow-not-found", label: `“${node.name}”的 ComfyUI 工作流`, subjectId: comfyWorkflowId, message: "节点引用了 ComfyUI 工作流，但项目包没有包含工作流库。" });
    } else if (!selected) {
      addItem(items, { status: "missing", category: "workflowReference", code: "workflow-not-found", label: `“${node.name}”的 ComfyUI 工作流`, subjectId: comfyWorkflowId, message: "节点引用的 ComfyUI 工作流不在项目包中。" });
    } else if (!selected.valid || !selected.runnableApi) {
      addItem(items, { status: "missing", category: "workflowReference", code: "workflow-invalid", label: `“${node.name}”的 ComfyUI 工作流`, subjectId: comfyWorkflowId, message: `引用的工作流“${selected.name}”没有可运行的 API Prompt；请在工作流库转换/扫描后重新选择。` });
    } else {
      addItem(items, { status: "portable", category: "workflowReference", code: "workflow-included", label: `“${node.name}”的 ComfyUI 工作流`, subjectId: comfyWorkflowId, message: `已找到随项目包导入的工作流“${selected.name}”。` });
    }
  } else if (source === "comfy") {
    const runnable = workflows ? [...workflows.values()].filter((item) => item.valid && item.runnableApi) : [];
    if (runnable.length === 1) {
      addItem(items, { status: "portable", category: "workflowReference", code: "workflow-included", label: `“${node.name}”的 ComfyUI 工作流`, subjectId: runnable[0].id, message: `项目包只有一个可运行工作流“${runnable[0].name}”；应用可自动选择它。` });
    } else {
      addItem(items, { status: "requiresRebind", category: "workflowReference", code: "workflow-unselected", label: `“${node.name}”的 ComfyUI 工作流`, subjectId: node.id, message: "节点选择了本地 ComfyUI，但没有固定工作流；导入后请重新选择或扫描工作流。" });
    }
  }

  const references = recordReferences(workflow);
  if (workflow.references !== undefined && !references) {
    addItem(items, { status: "missing", category: "workflowReference", code: "reference-invalid", label: `“${node.name}”的参考素材`, subjectId: node.id, message: "参考素材不是数组，无法恢复。" });
    return;
  }
  references?.forEach((reference, index) => inspectWorkflowReference(reference, index, node, nodesById, items));
};

type DirectorAssetState = { status: ProjectPortabilityStatus; label: string };

const inspectDirector = (
  director: unknown,
  rawAssets: unknown,
  mediaNodes: ReadonlyMap<string, RawCanvasNode>,
  items: ProjectPortabilityItem[],
) => {
  const assetStates = new Map<string, DirectorAssetState>();
  mediaNodes.forEach((node, id) => {
    assetStates.set(id, { status: sourceAssessment(node).status, label: node.name });
  });

  if (rawAssets !== undefined && !Array.isArray(rawAssets)) {
    addItem(items, { status: "missing", category: "directorAsset", code: "director-asset-invalid", label: "导演台素材库", message: "导演台素材库不是数组，无法恢复。" });
  } else if (Array.isArray(rawAssets)) {
    const seen = new Set<string>();
    rawAssets.forEach((candidate, index) => {
      if (!isRecord(candidate)) {
        addItem(items, { status: "missing", category: "directorAsset", code: "director-asset-invalid", label: `导演台素材 #${index + 1}`, message: "素材描述不是对象，无法恢复。" });
        return;
      }
      const id = stringValue(candidate.id);
      const name = stringValue(candidate.name) || (id ? `素材 ${id}` : `导演台素材 #${index + 1}`);
      if (!id) {
        addItem(items, { status: "missing", category: "directorAsset", code: "director-asset-invalid", label: name, message: "导演台素材缺少 ID，时间线无法引用。" });
        return;
      }
      if (seen.has(id)) {
        addItem(items, { status: "missing", category: "directorAsset", code: "director-asset-duplicate", label: name, subjectId: id, message: "导演台素材 ID 重复，时间线无法确定所用文件。" });
        return;
      }
      seen.add(id);
      const source = stringValue(candidate.source) || "canvas";
      if (source === "canvas") {
        const node = mediaNodes.get(id);
        if (!node) {
          addItem(items, { status: "missing", category: "directorAsset", code: "director-canvas-node-missing", label: name, subjectId: id, message: "导演台素材指向的画布媒体节点不存在。" });
          assetStates.set(id, { status: "missing", label: name });
          return;
        }
        const assessment = sourceAssessment(node);
        addItem(items, toItem("directorAsset", name, id, {
          ...assessment,
          message: assessment.status === "portable" ? "导演台引用画布素材，画布素材可随项目恢复。" : `导演台引用画布素材：${assessment.message}`,
        }));
        assetStates.set(id, { status: assessment.status, label: name });
        return;
      }
      if (source !== "external") {
        addItem(items, { status: "missing", category: "directorAsset", code: "director-asset-invalid", label: name, subjectId: id, message: "导演台素材来源未知，无法确定如何恢复。" });
        assetStates.set(id, { status: "missing", label: name });
        return;
      }
      const assessment = sourceAssessment({
        src: candidate.src,
        localPath: candidate.localPath,
        sessionOnly: candidate.sessionOnly,
        dataIsSessionOnly: true,
      });
      addItem(items, toItem("directorAsset", name, id, assessment));
      assetStates.set(id, { status: assessment.status, label: name });
    });
  }

  if (director === undefined || director === null) return;
  if (!isRecord(director)) {
    addItem(items, { status: "missing", category: "directorTimeline", code: "director-asset-invalid", label: "导演台时间线", message: "导演台时间线不是对象，无法恢复。" });
    return;
  }
  (["timeline", "audio"] as const).forEach((track) => {
    const clips = director[track];
    if (clips === undefined) return;
    if (!Array.isArray(clips)) {
      addItem(items, { status: "missing", category: "directorTimeline", code: "director-asset-invalid", label: `导演台${track === "audio" ? "音频" : "视频"}轨道`, message: "轨道片段不是数组，无法恢复。" });
      return;
    }
    clips.forEach((candidate, index) => {
      const assetId = isRecord(candidate) ? stringValue(candidate.assetId) : "";
      const label = `导演台${track === "audio" ? "音频" : "视频"}片段 ${index + 1}`;
      const asset = assetId ? assetStates.get(assetId) : undefined;
      if (!asset) {
        addItem(items, { status: "missing", category: "directorTimeline", code: "director-timeline-asset-missing", label, subjectId: assetId || undefined, message: "时间线片段找不到对应素材，导入后无法播放。" });
      } else if (asset.status !== "portable") {
        addItem(items, { status: "requiresRebind", category: "directorTimeline", code: "director-timeline-rebind", label, subjectId: assetId, message: `时间线使用“${asset.label}”，需重新绑定或修复该素材后才能播放。` });
      }
    });
  });
};

/**
 * Analyses either a versioned `.json` project package or the legacy raw canvas
 * shape.  The function does not change, serialize, fetch or probe any source;
 * it only reports what is actually present in the JSON being imported.
 */
export const analyzeProjectPortability = (input: unknown): ProjectPortabilityReport => {
  const items: ProjectPortabilityItem[] = [];
  if (!isRecord(input) || !Array.isArray(input.nodes)) {
    addItem(items, { status: "missing", category: "projectPackage", code: "source-invalid", label: "项目文件", message: "项目文件缺少 nodes 数组，无法导入为画布项目。" });
    return {
      manifestVersion: PROJECT_PORTABILITY_MANIFEST_VERSION,
      packageKind: "invalid",
      items,
      summary: { portable: 0, requiresRebind: 0, missing: 1, fullyPortable: false },
    };
  }

  const packageVersion = typeof input.__ymProjectPackage === "number" && Number.isFinite(input.__ymProjectPackage)
    ? input.__ymProjectPackage
    : undefined;
  const nodes: RawCanvasNode[] = [];
  const nodeIds = new Set<string>();
  input.nodes.forEach((candidate, index) => {
    const parsed = validNode(candidate);
    if (!parsed) {
      addItem(items, { status: "missing", category: "projectPackage", code: "source-invalid", label: `画布节点 #${index + 1}`, message: "节点不是有效对象或缺少 ID，无法可靠导入。" });
      return;
    }
    if (nodeIds.has(parsed.id)) {
      addItem(items, { status: "missing", category: "projectPackage", code: "source-invalid", label: parsed.name, subjectId: parsed.id, message: "画布节点 ID 重复，连接和引用无法确定目标。" });
      return;
    }
    nodeIds.add(parsed.id);
    nodes.push(parsed);
  });
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const mediaById = new Map(nodes.filter((node) => mediaKinds.has(node.kind as CanvasNodeKind)).map((node) => [node.id, node]));

  nodes.filter((node) => mediaKinds.has(node.kind as CanvasNodeKind)).forEach((node) => {
    addItem(items, toItem("canvasMedia", node.name, node.id, sourceAssessment(node)));
  });

  const workflows = inspectWorkflowLibrary(input.comfyWorkflows, items);
  inspectPromptLibrary(input.promptLibrary, items);
  nodes.forEach((node) => inspectNodeWorkflow(node, nodesById, workflows, items));
  inspectDirector(input.director, input.directorAssets, mediaById, items);

  const summary = items.reduce<ProjectPortabilitySummary>((current, item) => {
    current[item.status] += 1;
    return current;
  }, { portable: 0, requiresRebind: 0, missing: 0, fullyPortable: false });
  summary.fullyPortable = summary.requiresRebind === 0 && summary.missing === 0;
  return {
    manifestVersion: PROJECT_PORTABILITY_MANIFEST_VERSION,
    packageKind: packageVersion === undefined ? "project" : "package",
    packageVersion,
    items,
    summary,
  };
};

/** Creates an additive report that callers may place in an export as
 * `portabilityManifest`.  Re-analyse at import time; the snapshot does not
 * replace real validation of the incoming JSON. */
export const createProjectPortabilityManifest = (
  input: unknown,
  generatedAt = Date.now(),
): ProjectPortabilityManifest => ({
  type: "ym-project-portability",
  version: PROJECT_PORTABILITY_MANIFEST_VERSION,
  generatedAt,
  report: analyzeProjectPortability(input),
});
