import type { StoredComfyWorkflow } from "../../ComfyWorkflowParameters";
import type { CanvasNode, CanvasProject } from "./types";

/**
 * Importing a portable project may bring a ComfyUI workflow library with it.
 * This module keeps that operation deliberately separate from localStorage and
 * React: callers can validate the package, inspect the report, and only then
 * decide whether to write the resulting library.
 */

export type WorkflowImportSkipReason =
  | "invalid"
  | "duplicate-incoming"
  | "duplicate-existing";

export type WorkflowImportSkip = {
  source: "incoming" | "existing";
  id?: string;
  reason: WorkflowImportSkipReason;
  message: string;
};

export type WorkflowIdRemap = {
  sourceId: string;
  targetId: string;
  name: string;
  reason: "id-conflict";
};

export type WorkflowImportReuse = {
  id: string;
  name: string;
  reason: "same-content";
};

export type ComfyWorkflowImportReport = {
  incomingTotal: number;
  accepted: number;
  added: number;
  reused: WorkflowImportReuse[];
  remapped: WorkflowIdRemap[];
  skipped: WorkflowImportSkip[];
  /** Canvas node IDs whose selected library workflow was rewritten. */
  rewrittenCanvasNodeIds: string[];
};

export type WorkflowIdFactoryInput = {
  /** The ID in the portable package that collided with this computer's library. */
  sourceId: string;
  /** Stable semantic fingerprint of format + raw workflow content. */
  fingerprint: string;
  /** Increments only if a generated candidate already exists. */
  attempt: number;
};

export type WorkflowIdFactory = (input: WorkflowIdFactoryInput) => string;

export type MergeComfyWorkflowImportOptions = {
  /**
   * Optional only for host-specific IDs or deterministic tests.  A bad or
   * colliding custom value never overwrites an existing workflow; the safe
   * deterministic fallback is used instead.
   */
  idFactory?: WorkflowIdFactory;
};

export type ComfyWorkflowImportResult = {
  merged: StoredComfyWorkflow[];
  project: CanvasProject;
  remapped: WorkflowIdRemap[];
  skipped: WorkflowImportSkip[];
  report: ComfyWorkflowImportReport;
};

type RecordValue = Record<string, unknown>;

const hasOwn = (value: RecordValue, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isPlainRecord = (value: unknown): value is RecordValue => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const nonEmptyString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0;

/**
 * Package companions are JSON.  Reject non-JSON values here instead of
 * allowing a poisoned/cyclic object to break localStorage later in App.
 */
const isJsonValue = (value: unknown, ancestors = new Set<object>(), depth = 0): boolean => {
  if (depth > 160) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    const valid = value.every((item) => isJsonValue(item, ancestors, depth + 1));
    ancestors.delete(value);
    return valid;
  }
  if (!isPlainRecord(value) || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Object.keys(value).every((key) => isJsonValue(value[key], ancestors, depth + 1));
  ancestors.delete(value);
  return valid;
};

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Canonical JSON means semantically identical graphs compare despite key order. */
const canonicalJson = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as RecordValue;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
};

const workflowFingerprint = (workflow: Pick<StoredComfyWorkflow, "format" | "content" | "apiContent">) =>
  canonicalJson({
    format: workflow.format,
    content: workflow.content,
    apiContent: workflow.apiContent === undefined ? null : workflow.apiContent,
  });

/** A small deterministic, non-cryptographic hash is enough for a local ID suffix. */
const stableHash = (value: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

const fallbackWorkflowId: WorkflowIdFactory = ({ sourceId, fingerprint, attempt }) =>
  `${sourceId}--import-${stableHash(fingerprint)}${attempt ? `-${attempt + 1}` : ""}`;

const normalizedId = (value: string) => value.trim();

const optionalJson = (raw: RecordValue, key: string): { present: boolean; value?: unknown } | null => {
  if (!hasOwn(raw, key)) return { present: false };
  const value = raw[key];
  return value === undefined || !isJsonValue(value) ? null : { present: true, value };
};

/**
 * Narrows an unknown project companion to the data we actually store.  Extra
 * package fields are intentionally not copied into localStorage.
 */
export const isStoredComfyWorkflow = (value: unknown): value is StoredComfyWorkflow => {
  if (!isPlainRecord(value)) return false;
  if (!nonEmptyString(value.id) || !nonEmptyString(value.name) || typeof value.description !== "string") return false;
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string")) return false;
  if (value.format !== "workflow" && value.format !== "api") return false;
  if (!hasOwn(value, "content") || !isJsonValue(value.content)) return false;
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return false;
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return false;
  return optionalJson(value, "apiContent") !== null
    && optionalJson(value, "interface") !== null
    && optionalJson(value, "parameters") !== null;
};

const normalizeWorkflow = (value: StoredComfyWorkflow): StoredComfyWorkflow => {
  const raw = value as unknown as RecordValue;
  const normalized: StoredComfyWorkflow = {
    id: normalizedId(value.id),
    name: value.name.trim(),
    description: value.description,
    tags: value.tags.map((tag) => tag.trim()).filter(Boolean),
    format: value.format,
    content: cloneJson(value.content),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  (['apiContent', 'interface', 'parameters'] as const).forEach((key) => {
    const optional = optionalJson(raw, key);
    if (optional?.present) {
      // The StoredComfyWorkflow optional fields are intentionally opaque to
      // this importer. Their own scanner validates their finer structure.
      (normalized as Record<string, unknown>)[key] = cloneJson(optional.value);
    }
  });
  return normalized;
};

const collectIncoming = (incoming: unknown): unknown[] => Array.isArray(incoming) ? incoming : [];

const addSkip = (
  skipped: WorkflowImportSkip[],
  source: WorkflowImportSkip["source"],
  id: unknown,
  reason: WorkflowImportSkipReason,
  message: string,
) => {
  skipped.push({ source, id: typeof id === "string" && id.trim() ? id.trim() : undefined, reason, message });
};

const allocateWorkflowId = (
  sourceId: string,
  fingerprint: string,
  usedIds: Set<string>,
  factory?: WorkflowIdFactory,
) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const input = { sourceId, fingerprint, attempt };
    const proposed = attempt === 0 && factory ? factory(input) : fallbackWorkflowId(input);
    const candidate = typeof proposed === "string" ? normalizedId(proposed) : "";
    if (candidate && !usedIds.has(candidate)) return candidate;
  }
  // This branch is practically unreachable, but preserves the no-overwrite
  // promise even when a host passes a broken ID factory.
  let attempt = 100;
  let candidate = fallbackWorkflowId({ sourceId, fingerprint, attempt });
  while (usedIds.has(candidate)) {
    attempt += 1;
    candidate = fallbackWorkflowId({ sourceId, fingerprint, attempt });
  }
  return candidate;
};

const isComfyCanvasWorkflow = (workflow: RecordValue) => workflow.__ymComfyPackage === true;

const rewriteNodeWorkflow = (
  node: CanvasNode,
  remap: ReadonlyMap<string, string>,
): CanvasNode => {
  if (!isPlainRecord(node.workflow)) return node;
  const workflow = node.workflow;
  let next: RecordValue | undefined;
  const rewrite = (key: "comfyWorkflowId" | "libraryId") => {
    const sourceId = workflow[key];
    if (typeof sourceId !== "string") return;
    const targetId = remap.get(sourceId);
    if (!targetId || targetId === sourceId) return;
    next ||= { ...workflow };
    next[key] = targetId;
  };
  rewrite("comfyWorkflowId");
  if (isComfyCanvasWorkflow(workflow)) rewrite("libraryId");
  return next ? { ...node, workflow: next } : node;
};

/**
 * Safely merges imported ComfyUI library companions into a local workflow
 * library. Existing local IDs always win. If the package uses that ID for
 * different graph content, its workflow is given a deterministic isolated ID
 * and every matching reference in the imported canvas is rewritten.
 */
export const mergeImportedComfyWorkflows = (
  incoming: unknown,
  existing: readonly StoredComfyWorkflow[],
  project: CanvasProject,
  options: MergeComfyWorkflowImportOptions = {},
): ComfyWorkflowImportResult => {
  const skipped: WorkflowImportSkip[] = [];
  const existingById = new Map<string, StoredComfyWorkflow>();
  const merged: StoredComfyWorkflow[] = [];

  existing.forEach((candidate) => {
    if (!isStoredComfyWorkflow(candidate)) {
      addSkip(skipped, "existing", (candidate as { id?: unknown } | null)?.id, "invalid", "本机工作流库中有一项结构不完整，已跳过，避免覆盖导入项目。");
      return;
    }
    const normalized = normalizeWorkflow(candidate);
    const prior = existingById.get(normalized.id);
    if (prior) {
      addSkip(skipped, "existing", normalized.id, "duplicate-existing", "本机工作流库包含重复 ID，已保留最先出现的有效工作流。");
      return;
    }
    existingById.set(normalized.id, normalized);
    merged.push(normalized);
  });

  const usedIds = new Set(existingById.keys());
  const seenIncomingIds = new Set<string>();
  const remapped: WorkflowIdRemap[] = [];
  const reused: WorkflowImportReuse[] = [];
  let accepted = 0;
  let added = 0;

  collectIncoming(incoming).forEach((candidate) => {
    if (!isStoredComfyWorkflow(candidate)) {
      addSkip(skipped, "incoming", isRecord(candidate) ? candidate.id : undefined, "invalid", "项目包内有一项 ComfyUI 工作流结构不完整，已跳过。");
      return;
    }
    const normalized = normalizeWorkflow(candidate);
    if (seenIncomingIds.has(normalized.id)) {
      addSkip(skipped, "incoming", normalized.id, "duplicate-incoming", "项目包内有重复的 ComfyUI 工作流 ID，已保留最先出现的一项。");
      return;
    }
    seenIncomingIds.add(normalized.id);
    accepted += 1;

    const current = existingById.get(normalized.id);
    if (!current) {
      existingById.set(normalized.id, normalized);
      usedIds.add(normalized.id);
      merged.push(normalized);
      added += 1;
      return;
    }

    const incomingFingerprint = workflowFingerprint(normalized);
    if (workflowFingerprint(current) === incomingFingerprint) {
      reused.push({ id: current.id, name: current.name, reason: "same-content" });
      return;
    }

    const isolatedId = allocateWorkflowId(normalized.id, incomingFingerprint, usedIds, options.idFactory);
    const isolated = { ...normalized, id: isolatedId };
    existingById.set(isolatedId, isolated);
    usedIds.add(isolatedId);
    merged.push(isolated);
    added += 1;
    remapped.push({ sourceId: normalized.id, targetId: isolatedId, name: normalized.name, reason: "id-conflict" });
  });

  const remapBySourceId = new Map(remapped.map((entry) => [entry.sourceId, entry.targetId]));
  const rewrittenCanvasNodeIds: string[] = [];
  const nodes = project.nodes.map((node) => {
    const next = rewriteNodeWorkflow(node, remapBySourceId);
    if (next !== node) rewrittenCanvasNodeIds.push(node.id);
    return next;
  });
  const nextProject = rewrittenCanvasNodeIds.length ? { ...project, nodes } : project;
  const report: ComfyWorkflowImportReport = {
    incomingTotal: collectIncoming(incoming).length,
    accepted,
    added,
    reused,
    remapped,
    skipped,
    rewrittenCanvasNodeIds,
  };

  return { merged, project: nextProject, remapped, skipped, report };
};
