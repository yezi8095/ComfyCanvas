import { normalizeProject } from "./migrate";
import type { CanvasProject, ProjectHistoryRecord } from "./types";

export interface StoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ProjectWorkspaceSnapshot {
  activeId: string;
  activeName: string;
  project: CanvasProject;
  history: ProjectHistoryRecord[];
}

type ProjectIndexRecord = Pick<ProjectHistoryRecord, "id" | "name" | "updatedAt">;

export const PROJECT_INDEX_KEY = "ym-project-index-v2";
export const ACTIVE_PROJECT_KEY = "ym-active-project";
export const LEGACY_CURRENT_PROJECT_KEY = "comfy-canvas-offline-v1";
export const LEGACY_HISTORY_KEY = "ym-project-history-v1";
export const LEGACY_PROJECT_NAME_KEY = "ym-project-name";
export const projectDocumentKey = (id: string) => `ym-project-document-v2:${id}`;
/**
 * The index is deliberately small: documents are stored separately so one
 * project with large local media cannot make the whole workspace unreadable.
 */
export const MAX_PROJECT_HISTORY = 24;

const parseJson = <T>(storage: StoragePort, key: string, fallback: T): T => {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
};

const readDocument = (storage: StoragePort, id: string): CanvasProject | null => {
  const value = parseJson<CanvasProject | null>(storage, projectDocumentKey(id), null);
  return value?.nodes && Array.isArray(value.nodes) ? normalizeProject(value) : null;
};

export const loadProjectWorkspace = (
  storage: StoragePort,
  fallback: CanvasProject,
  createId: () => string,
): ProjectWorkspaceSnapshot => {
  // Keep reading legacy history even when a valid v2 index exists. During the
  // one-time migration an earlier build may have written only the active v2
  // document; ignoring the remaining v1 records here would make those projects
  // unreachable before they can receive their own v2 documents.
  const legacyHistoryValue = parseJson<unknown>(storage, LEGACY_HISTORY_KEY, []);
  const legacyHistory = Array.isArray(legacyHistoryValue)
    ? legacyHistoryValue.flatMap((item) => {
        const record = item as Partial<ProjectHistoryRecord>;
        if (!record.id || !record.project?.nodes || !Array.isArray(record.project.nodes)) return [];
        return [{
          id: record.id,
          name: record.name || "历史项目",
          updatedAt: Number(record.updatedAt) || 0,
          project: normalizeProject(record.project),
        }];
      })
    : [];
  const requestedId = storage.getItem(ACTIVE_PROJECT_KEY) || "";
  const index = parseJson<ProjectIndexRecord[]>(storage, PROJECT_INDEX_KEY, []);
  const validIndex = Array.isArray(index)
    ? index.filter((item) => item && typeof item.id === "string" && typeof item.name === "string")
    : [];

  if (validIndex.length) {
    const requested = validIndex.find((item) => item.id === requestedId);
    const activeMeta = requested || validIndex[0];
    const history = validIndex.flatMap((item) => {
      const project = readDocument(storage, item.id);
      return project ? [{ ...item, project }] : [];
    });
    const active = history.find((item) => item.id === activeMeta.id) || history[0];
    if (active) {
      const v2Ids = new Set(history.map((item) => item.id));
      return {
        activeId: active.id,
        activeName: active.name,
        project: active.project,
        history: [
          ...history,
          ...legacyHistory.filter((item) => !v2Ids.has(item.id)),
        ].slice(0, MAX_PROJECT_HISTORY),
      };
    }
  }

  // Legacy keys are intentionally read independently. A corrupt history value
  // must never make a valid current project disappear.
  const legacyCurrentValue = parseJson<CanvasProject | null>(storage, LEGACY_CURRENT_PROJECT_KEY, null);
  const legacyCurrent = legacyCurrentValue?.nodes && Array.isArray(legacyCurrentValue.nodes)
    ? normalizeProject(legacyCurrentValue)
    : null;
  const legacyActive = legacyHistory.find((item) => item.id === requestedId);
  const project = legacyActive?.project || legacyCurrent || legacyHistory[0]?.project || normalizeProject(fallback);
  const activeId = legacyActive?.id || requestedId || createId();
  const activeName = storage.getItem(LEGACY_PROJECT_NAME_KEY) || legacyActive?.name || "未命名项目";
  const currentRecord: ProjectHistoryRecord = {
    id: activeId,
    name: activeName,
    updatedAt: Date.now(),
    project,
  };
  return {
    activeId,
    activeName,
    project,
    history: [currentRecord, ...legacyHistory.filter((item) => item.id !== activeId)].slice(0, 24),
  };
};

export const saveProjectDocument = (
  storage: StoragePort,
  record: ProjectHistoryRecord,
) => {
  storage.setItem(projectDocumentKey(record.id), JSON.stringify(normalizeProject(record.project)));
  storage.setItem(ACTIVE_PROJECT_KEY, record.id);
};

export const saveProjectIndex = (storage: StoragePort, records: ProjectHistoryRecord[]) => {
  const index: ProjectIndexRecord[] = records.map(({ id, name, updatedAt }) => ({ id, name, updatedAt }));
  storage.setItem(PROJECT_INDEX_KEY, JSON.stringify(index));
};

export const removeProjectDocument = (storage: StoragePort, id: string) => {
  storage.removeItem(projectDocumentKey(id));
};

export interface SaveProjectWorkspaceResult {
  /** The exact records retained in the new index, ordered with the active one first. */
  records: ProjectHistoryRecord[];
  /** Documents that were successfully removed after the new index was written. */
  removedDocumentIds: string[];
  /** Conservative, best-effort removal of fully superseded v1 storage keys. */
  legacyCleanup: LegacyProjectCleanupReport;
}

export type LegacyCleanupStatus = "missing" | "removed" | "retained" | "remove-failed";

export interface LegacyProjectCleanupReport {
  verifiedV2: boolean;
  current: LegacyCleanupStatus;
  history: LegacyCleanupStatus;
}

const normalizeWorkspaceRecord = (record: ProjectHistoryRecord): ProjectHistoryRecord => ({
  ...record,
  name: record.name || "未命名项目",
  project: normalizeProject(record.project),
});

type StoredJsonResult =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "valid"; value: unknown };

const readStoredJson = (storage: StoragePort, key: string): StoredJsonResult => {
  const raw = storage.getItem(key);
  if (raw === null) return { status: "missing" };
  try {
    return { status: "valid", value: JSON.parse(raw) as unknown };
  } catch {
    return { status: "invalid" };
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const isStoredProject = (value: unknown): value is CanvasProject =>
  isRecord(value) && Array.isArray(value.nodes) && Array.isArray(value.links) && isRecord(value.view);

const stableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJsonValue(value[key])]),
  );
};

const stableProjectJson = (project: CanvasProject) =>
  JSON.stringify(stableJsonValue(normalizeProject(project)));

const isLegacyMediaDataUrl = (value: unknown): value is string =>
  typeof value === "string" && /^data:(?:image|video|audio)\//i.test(value);

const hasManagedMediaSource = (value: Record<string, unknown>) =>
  typeof value.localPath === "string" && Boolean(value.localPath.trim()) &&
  /(?:^|[/\\])legacy-[A-Za-z0-9_-]+--[^/\\]+$/.test(value.localPath) &&
  typeof value.src === "string" && Boolean(value.src.trim()) &&
  !/^data:/i.test(value.src);

const serializedProjectDocumentCache = new WeakMap<CanvasProject, string>();

const serializeProjectDocument = (project: CanvasProject) => {
  const cached = serializedProjectDocumentCache.get(project);
  if (cached !== undefined) return cached;
  const serialized = JSON.stringify(normalizeProject(project));
  // Project updates are immutable. Historical project objects therefore keep
  // a stable serialized form and do not need to be normalized/stringified on
  // every autosave of a different active project.
  serializedProjectDocumentCache.set(project, serialized);
  return serialized;
};

const saveProjectDocumentVerified = (
  storage: StoragePort,
  record: ProjectHistoryRecord,
) => {
  const key = projectDocumentKey(record.id);
  const serialized = serializeProjectDocument(record.project);
  if (storage.getItem(key) !== serialized) storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) {
    throw new Error(`project document write was not persisted: ${record.id}`);
  }
};

const saveProjectIndexVerified = (
  storage: StoragePort,
  records: readonly ProjectHistoryRecord[],
) => {
  const serialized = JSON.stringify(
    records.map(({ id, name, updatedAt }) => ({ id, name, updatedAt })),
  );
  storage.setItem(PROJECT_INDEX_KEY, serialized);
  if (storage.getItem(PROJECT_INDEX_KEY) !== serialized) {
    throw new Error("project index write was not persisted");
  }
};

const cloneProjectJson = (project: CanvasProject): CanvasProject =>
  JSON.parse(JSON.stringify(normalizeProject(project))) as CanvasProject;

/**
 * Compare a v1 project with its v2 successor. The sole tolerated difference is
 * the explicit legacy-media migration performed by the desktop app: a media
 * DataURL becomes a non-DataURL preview plus a non-empty managed localPath.
 * Every other project field must remain byte-for-byte equivalent after stable
 * key ordering.
 */
export const isLegacyProjectFullyRepresented = (
  legacyProject: CanvasProject,
  v2Project: CanvasProject,
): boolean => {
  const legacy = cloneProjectJson(legacyProject);
  const current = cloneProjectJson(v2Project);
  const currentById = new Map(current.nodes.map((node) => [node.id, node]));

  for (const legacyNode of legacy.nodes) {
    const currentNode = currentById.get(legacyNode.id);
    if (!currentNode) return false;
    if (
      (legacyNode.kind === "image" || legacyNode.kind === "video" || legacyNode.kind === "audio") &&
      isLegacyMediaDataUrl(legacyNode.src) &&
      hasManagedMediaSource(currentNode as unknown as Record<string, unknown>)
    ) {
      legacyNode.src = "__managed_workspace_media__";
      currentNode.src = "__managed_workspace_media__";
      delete legacyNode.localPath;
      delete currentNode.localPath;
    }

    const legacyWorkflow = isRecord(legacyNode.workflow) ? legacyNode.workflow : null;
    const currentWorkflow = isRecord(currentNode.workflow) ? currentNode.workflow : null;
    if (!legacyWorkflow || !currentWorkflow || !Array.isArray(legacyWorkflow.references) || !Array.isArray(currentWorkflow.references)) continue;
    const currentReferences = currentWorkflow.references;
    legacyWorkflow.references.forEach((legacyReference, referenceIndex) => {
      if (!isRecord(legacyReference) || !isLegacyMediaDataUrl(legacyReference.src)) return;
      const referenceId = typeof legacyReference.id === "string" && legacyReference.id ? legacyReference.id : null;
      const currentIndex = referenceId
        ? currentReferences.findIndex((candidate) => isRecord(candidate) && candidate.id === referenceId)
        : referenceIndex;
      const currentReference = currentReferences[currentIndex];
      if (!isRecord(currentReference) || !hasManagedMediaSource(currentReference)) return;
      legacyReference.src = "__managed_workspace_media__";
      currentReference.src = "__managed_workspace_media__";
      delete legacyReference.localPath;
      delete currentReference.localPath;
    });
  }

  return stableProjectJson(legacy) === stableProjectJson(current);
};

const removeLegacyKey = (storage: StoragePort, key: string): LegacyCleanupStatus => {
  try {
    storage.removeItem(key);
    return storage.getItem(key) === null ? "removed" : "remove-failed";
  } catch {
    return "remove-failed";
  }
};

/**
 * Delete v1 keys only after reading back a complete, equivalent v2 workspace.
 * The two legacy keys are independent: an obsolete current snapshot can be
 * removed while a multi-project legacy history remains as its only backup.
 */
export const cleanupFullyMigratedLegacyProjectKeys = (
  storage: StoragePort,
  expectedActive: ProjectHistoryRecord,
): LegacyProjectCleanupReport => {
  const retained: LegacyProjectCleanupReport = {
    verifiedV2: false,
    current: storage.getItem(LEGACY_CURRENT_PROJECT_KEY) === null ? "missing" : "retained",
    history: storage.getItem(LEGACY_HISTORY_KEY) === null ? "missing" : "retained",
  };
  // This is the steady state after migration. Previously every save still
  // stable-sorted and serialized the active project twice just to discover
  // that no legacy rollback data remained.
  if (retained.current === "missing" && retained.history === "missing") {
    return { ...retained, verifiedV2: true };
  }
  if (storage.getItem(ACTIVE_PROJECT_KEY) !== expectedActive.id) return retained;

  const indexValue = readStoredJson(storage, PROJECT_INDEX_KEY);
  const documentValue = readStoredJson(storage, projectDocumentKey(expectedActive.id));
  if (indexValue.status !== "valid" || documentValue.status !== "valid") return retained;
  if (!Array.isArray(indexValue.value) || !isStoredProject(documentValue.value)) return retained;
  const index = indexValue.value.filter(isRecord);
  if (!index.some((entry) => entry.id === expectedActive.id)) return retained;
  if (stableProjectJson(documentValue.value) !== stableProjectJson(expectedActive.project)) return retained;

  const report: LegacyProjectCleanupReport = { ...retained, verifiedV2: true };
  const legacyCurrent = readStoredJson(storage, LEGACY_CURRENT_PROJECT_KEY);
  if (legacyCurrent.status === "valid" && isStoredProject(legacyCurrent.value)) {
    if (isLegacyProjectFullyRepresented(legacyCurrent.value, documentValue.value)) {
      report.current = removeLegacyKey(storage, LEGACY_CURRENT_PROJECT_KEY);
    }
  }

  const legacyHistory = readStoredJson(storage, LEGACY_HISTORY_KEY);
  if (legacyHistory.status === "valid" && Array.isArray(legacyHistory.value)) {
    const seenIds = new Set<string>();
    const everyLegacyRecordIsInV2 = legacyHistory.value.every((value) => {
      if (!isRecord(value) || typeof value.id !== "string" || !value.id || !isStoredProject(value.project) || seenIds.has(value.id)) return false;
      seenIds.add(value.id);
      const metadata = index.find((entry) => entry.id === value.id);
      if (!metadata) return false;
      const legacyUpdatedAt = Number(value.updatedAt) || 0;
      const v2UpdatedAt = Number(metadata.updatedAt) || 0;
      if (v2UpdatedAt < legacyUpdatedAt) return false;
      const v2Document = readStoredJson(storage, projectDocumentKey(value.id));
      return v2Document.status === "valid" && isStoredProject(v2Document.value) &&
        isLegacyProjectFullyRepresented(value.project, v2Document.value);
    });
    if (everyLegacyRecordIsInV2) {
      report.history = removeLegacyKey(storage, LEGACY_HISTORY_KEY);
    }
  }
  return report;
};

/**
 * Persist the complete retained workspace and its metadata index as one safe
 * save. Every project named by the new index has a verified v2 document first.
 *
 * Documents are written first, then the metadata index, and the active pointer
 * last. Old documents and legacy rollback keys are removed only after every
 * write succeeds. This intentionally leaves harmless orphan documents behind
 * on storage failures instead of creating an index that names a missing file.
 *
 * `history` is the caller's known workspace history, not a storage scan. For
 * that reason cleanup is restricted to ids explicitly present in `history`
 * which were truncated by the 24-project retention limit; unrelated documents
 * are never touched.
 */
export const saveProjectWorkspace = (
  storage: StoragePort,
  activeRecord: ProjectHistoryRecord,
  history: readonly ProjectHistoryRecord[],
): SaveProjectWorkspaceResult => {
  const active = normalizeWorkspaceRecord(activeRecord);
  const seenIds = new Set<string>();
  const orderedRecords = [active, ...history]
    .flatMap((record) => {
      if (!record?.id || seenIds.has(record.id)) return [];
      seenIds.add(record.id);
      return [record.id === active.id ? active : normalizeWorkspaceRecord(record)];
    })
    .slice(0, MAX_PROJECT_HISTORY);

  // Do not let a failed or silently dropped setItem lead to cleanup. This loop
  // is also the one-time v1-history migration: inactive records receive their
  // own v2 documents before their ids are allowed into the v2 index.
  orderedRecords.forEach((record) => saveProjectDocumentVerified(storage, record));
  saveProjectIndexVerified(storage, orderedRecords);
  storage.setItem(ACTIVE_PROJECT_KEY, active.id);
  if (storage.getItem(ACTIVE_PROJECT_KEY) !== active.id) {
    throw new Error(`active project pointer write was not persisted: ${active.id}`);
  }

  // Read-back verification happens inside the cleanup helper. A StoragePort
  // that silently drops a write therefore cannot trigger legacy deletion.
  const legacyCleanup = cleanupFullyMigratedLegacyProjectKeys(storage, active);

  const retainedIds = new Set(orderedRecords.map((record) => record.id));
  const cleanupCandidates = [...new Set(history.map((record) => record.id))]
    .filter((id) => id && !retainedIds.has(id));
  const removedDocumentIds: string[] = [];

  for (const id of cleanupCandidates) {
    try {
      removeProjectDocument(storage, id);
      removedDocumentIds.push(id);
    } catch {
      // The index is already authoritative. Keep an undeleted orphan rather
      // than failing a successful save or attempting to delete another id.
    }
  }

  return { records: orderedRecords, removedDocumentIds, legacyCleanup };
};
