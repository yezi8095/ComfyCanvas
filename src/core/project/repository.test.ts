import { describe, expect, it, vi } from "vitest";

import { CURRENT_PROJECT_SCHEMA } from "./migrate";
import {
  ACTIVE_PROJECT_KEY,
  LEGACY_CURRENT_PROJECT_KEY,
  LEGACY_HISTORY_KEY,
  LEGACY_PROJECT_NAME_KEY,
  MAX_PROJECT_HISTORY,
  PROJECT_INDEX_KEY,
  cleanupFullyMigratedLegacyProjectKeys,
  isLegacyProjectFullyRepresented,
  loadProjectWorkspace,
  projectDocumentKey,
  removeProjectDocument,
  saveProjectDocument,
  saveProjectIndex,
  saveProjectWorkspace,
  type StoragePort,
} from "./repository";
import type { CanvasProject, ProjectHistoryRecord } from "./types";

class MemoryStorage implements StoragePort {
  readonly values = new Map<string, string>();

  constructor(entries: Record<string, string> = {}) {
    Object.entries(entries).forEach(([key, value]) => this.values.set(key, value));
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

class FailingStorage extends MemoryStorage {
  constructor(private readonly failingKey: string, entries: Record<string, string> = {}) {
    super(entries);
  }

  override setItem(key: string, value: string) {
    if (key === this.failingKey) throw new Error(`storage write failed: ${key}`);
    super.setItem(key, value);
  }
}

class SilentDropStorage extends MemoryStorage {
  constructor(private readonly droppedKey: string, entries: Record<string, string> = {}) {
    super(entries);
  }

  override setItem(key: string, value: string) {
    if (key === this.droppedKey) return;
    super.setItem(key, value);
  }
}

class NonRemovingStorage extends MemoryStorage {
  override removeItem(_key: string) {
    // Simulates a storage adapter that acknowledges but does not remove.
  }
}

const makeProject = (nodeId: string, status = "idle"): CanvasProject => ({
  nodes: [{
    id: nodeId,
    kind: "text",
    x: 10,
    y: 20,
    width: 260,
    height: 180,
    name: nodeId,
    text: `${nodeId} content`,
    status,
  }],
  links: [],
  view: { x: 30, y: 40, zoom: 1 },
  groups: [],
});

const legacyMediaProject = (managed = false): CanvasProject => ({
  nodes: [
    {
      id: "legacy-image",
      kind: "image",
      x: 10,
      y: 20,
      width: 300,
      height: 400,
      name: "角色图",
      src: managed ? "asset://localhost/portrait.png" : "data:image/png;base64,AAAA",
      ...(managed ? { localPath: "D:\\workspace-v1\\legacy-image--portrait.png" } : {}),
    },
    {
      id: "ai-image",
      kind: "aiImage",
      x: 400,
      y: 20,
      width: 360,
      height: 240,
      name: "AI 图片",
      workflow: {
        prompt: "保持角色一致",
        references: [{
          id: "reference-1",
          name: "参考.png",
          src: managed ? "asset://localhost/reference.png" : "data:image/png;base64,BBBB",
          ...(managed ? { localPath: "D:\\workspace-v1\\legacy-reference--reference.png" } : {}),
        }],
      },
    },
  ],
  links: [],
  view: { x: 30, y: 40, zoom: 1 },
  groups: [],
});

describe("project repository", () => {
  it("recovers a valid legacy current project when legacy history JSON is corrupt", () => {
    const current = makeProject("current-node", "running");
    const storage = new MemoryStorage({
      [ACTIVE_PROJECT_KEY]: "legacy-current",
      [LEGACY_HISTORY_KEY]: "{ this is not valid JSON",
      [LEGACY_CURRENT_PROJECT_KEY]: JSON.stringify(current),
      [LEGACY_PROJECT_NAME_KEY]: "仍可恢复的项目",
    });
    const createId = vi.fn(() => "generated-id");

    const workspace = loadProjectWorkspace(storage, makeProject("fallback-node"), createId);

    expect(workspace.activeId).toBe("legacy-current");
    expect(workspace.activeName).toBe("仍可恢复的项目");
    expect(workspace.project.nodes[0]).toMatchObject({ id: "current-node", status: "idle" });
    expect(workspace.history).toHaveLength(1);
    expect(workspace.history[0].project.nodes[0].id).toBe("current-node");
    expect(createId).not.toHaveBeenCalled();
  });

  it("loads v2 index metadata and resolves each project from its independent document", () => {
    const first = makeProject("first-node");
    const second = makeProject("second-node", "stopping");
    const storage = new MemoryStorage({
      [ACTIVE_PROJECT_KEY]: "project-b",
      [PROJECT_INDEX_KEY]: JSON.stringify([
        { id: "project-a", name: "项目 A", updatedAt: 10 },
        { id: "project-b", name: "项目 B", updatedAt: 20 },
      ]),
      [projectDocumentKey("project-a")]: JSON.stringify(first),
      [projectDocumentKey("project-b")]: JSON.stringify(second),
    });
    const createId = vi.fn(() => "unused-id");

    const workspace = loadProjectWorkspace(storage, makeProject("fallback-node"), createId);

    expect(workspace.activeId).toBe("project-b");
    expect(workspace.activeName).toBe("项目 B");
    expect(workspace.project.nodes[0]).toMatchObject({ id: "second-node", status: "idle" });
    expect(workspace.history.map(({ id, name, updatedAt, project }) => ({
      id,
      name,
      updatedAt,
      nodeId: project.nodes[0].id,
    }))).toEqual([
      { id: "project-a", name: "项目 A", updatedAt: 10, nodeId: "first-node" },
      { id: "project-b", name: "项目 B", updatedAt: 20, nodeId: "second-node" },
    ]);
    expect(createId).not.toHaveBeenCalled();
  });

  it("keeps legacy-only history visible until each record receives a v2 document", () => {
    const storage = new MemoryStorage({
      [ACTIVE_PROJECT_KEY]: "project-a",
      [PROJECT_INDEX_KEY]: JSON.stringify([
        { id: "project-a", name: "项目 A", updatedAt: 20 },
      ]),
      [projectDocumentKey("project-a")]: JSON.stringify(makeProject("node-a")),
      [LEGACY_HISTORY_KEY]: JSON.stringify([
        { id: "project-a", name: "旧的项目 A", updatedAt: 10, project: makeProject("stale-node-a") },
        { id: "legacy-only", name: "仅旧历史", updatedAt: 5, project: makeProject("legacy-only-node") },
      ]),
    });

    const workspace = loadProjectWorkspace(storage, makeProject("fallback"), () => "unused");

    expect(workspace.activeId).toBe("project-a");
    expect(workspace.project.nodes[0].id).toBe("node-a");
    expect(workspace.history.map((record) => record.id)).toEqual(["project-a", "legacy-only"]);
    expect(workspace.history[1].project.nodes[0].id).toBe("legacy-only-node");
  });

  it("migrates valid legacy history records and selects the requested legacy project", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T09:30:00.000Z"));

    try {
      const storage = new MemoryStorage({
        [ACTIVE_PROJECT_KEY]: "legacy-b",
        [LEGACY_HISTORY_KEY]: JSON.stringify([
          { id: "legacy-a", name: "旧项目 A", updatedAt: 100, project: makeProject("legacy-a-node") },
          { id: "invalid-without-project", name: "损坏记录", updatedAt: 150 },
          { id: "legacy-b", name: "旧项目 B", updatedAt: 200, project: makeProject("legacy-b-node", "running") },
        ]),
      });

      const workspace = loadProjectWorkspace(storage, makeProject("fallback-node"), () => "generated-id");

      expect(workspace.activeId).toBe("legacy-b");
      expect(workspace.activeName).toBe("旧项目 B");
      expect(workspace.project.nodes[0]).toMatchObject({ id: "legacy-b-node", status: "idle" });
      expect(workspace.history.map((record) => record.id)).toEqual(["legacy-b", "legacy-a"]);
      expect(workspace.history[0]).toMatchObject({
        id: "legacy-b",
        name: "旧项目 B",
        updatedAt: Date.now(),
      });
      expect(workspace.history[1]).toMatchObject({
        id: "legacy-a",
        name: "旧项目 A",
        updatedAt: 100,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves a normalized project document, active id, and metadata-only index", () => {
    const storage = new MemoryStorage();
    const records: ProjectHistoryRecord[] = [
      { id: "project-a", name: "项目 A", updatedAt: 100, project: makeProject("node-a", "running") },
      { id: "project-b", name: "项目 B", updatedAt: 200, project: makeProject("node-b") },
    ];

    saveProjectDocument(storage, records[0]);
    saveProjectIndex(storage, records);

    expect(storage.getItem(ACTIVE_PROJECT_KEY)).toBe("project-a");
    expect(JSON.parse(storage.getItem(projectDocumentKey("project-a")) || "null")).toMatchObject({
      schemaVersion: CURRENT_PROJECT_SCHEMA,
      nodes: [{ id: "node-a", status: "idle" }],
    });
    expect(JSON.parse(storage.getItem(PROJECT_INDEX_KEY) || "null")).toEqual([
      { id: "project-a", name: "项目 A", updatedAt: 100 },
      { id: "project-b", name: "项目 B", updatedAt: 200 },
    ]);
  });

  it("deletes only the requested v2 project document", () => {
    const storage = new MemoryStorage({
      [ACTIVE_PROJECT_KEY]: "project-a",
      [PROJECT_INDEX_KEY]: JSON.stringify([{ id: "project-a", name: "项目 A", updatedAt: 100 }]),
      [projectDocumentKey("project-a")]: JSON.stringify(makeProject("node-a")),
      [projectDocumentKey("project-b")]: JSON.stringify(makeProject("node-b")),
    });

    removeProjectDocument(storage, "project-a");

    expect(storage.getItem(projectDocumentKey("project-a"))).toBeNull();
    expect(storage.getItem(projectDocumentKey("project-b"))).not.toBeNull();
    expect(storage.getItem(ACTIVE_PROJECT_KEY)).toBe("project-a");
    expect(storage.getItem(PROJECT_INDEX_KEY)).not.toBeNull();
  });

  it("persists an active document with a capped index and cleans only known truncated documents", () => {
    const active: ProjectHistoryRecord = {
      id: "active",
      name: "当前项目",
      updatedAt: 999,
      project: makeProject("active-node", "running"),
    };
    const history = Array.from({ length: MAX_PROJECT_HISTORY + 2 }, (_, index): ProjectHistoryRecord => ({
      id: `history-${index}`,
      name: `历史 ${index}`,
      updatedAt: index,
      project: makeProject(`node-${index}`),
    }));
    const storage = new MemoryStorage({
      unrelated_document: JSON.stringify(makeProject("unrelated")),
      ...Object.fromEntries(history.map((record) => [projectDocumentKey(record.id), JSON.stringify(record.project)])),
    });

    const result = saveProjectWorkspace(storage, active, history);

    expect(result.records).toHaveLength(MAX_PROJECT_HISTORY);
    expect(result.records.map((record) => record.id)).toEqual([
      "active",
      ...history.slice(0, MAX_PROJECT_HISTORY - 1).map((record) => record.id),
    ]);
    expect(result.removedDocumentIds).toEqual(history.slice(MAX_PROJECT_HISTORY - 1).map((record) => record.id));
    expect(storage.getItem(ACTIVE_PROJECT_KEY)).toBe("active");
    expect(JSON.parse(storage.getItem(PROJECT_INDEX_KEY) || "null")).toEqual(
      result.records.map(({ id, name, updatedAt }) => ({ id, name, updatedAt })),
    );
    expect(JSON.parse(storage.getItem(projectDocumentKey("active")) || "null")).toMatchObject({
      schemaVersion: CURRENT_PROJECT_SCHEMA,
      nodes: [{ id: "active-node", status: "idle" }],
    });
    history.slice(MAX_PROJECT_HISTORY - 1).forEach((record) => {
      expect(storage.getItem(projectDocumentKey(record.id))).toBeNull();
    });
    expect(storage.getItem("unrelated_document")).not.toBeNull();
  });

  it("does not delete truncated documents when the new index cannot be saved", () => {
    const active: ProjectHistoryRecord = {
      id: "active",
      name: "当前项目",
      updatedAt: 999,
      project: makeProject("active-node"),
    };
    const history = Array.from({ length: MAX_PROJECT_HISTORY + 1 }, (_, index): ProjectHistoryRecord => ({
      id: `history-${index}`,
      name: `历史 ${index}`,
      updatedAt: index,
      project: makeProject(`node-${index}`),
    }));
    const dropped = history.at(-1)!;
    const storage = new FailingStorage(PROJECT_INDEX_KEY, {
      [PROJECT_INDEX_KEY]: JSON.stringify([{ id: "previous", name: "上一次索引", updatedAt: 1 }]),
      [projectDocumentKey(dropped.id)]: JSON.stringify(dropped.project),
      unrelated_document: JSON.stringify(makeProject("unrelated")),
    });

    expect(() => saveProjectWorkspace(storage, active, history)).toThrow("storage write failed");

    expect(storage.getItem(projectDocumentKey(dropped.id))).not.toBeNull();
    expect(storage.getItem("unrelated_document")).not.toBeNull();
    expect(storage.getItem(PROJECT_INDEX_KEY)).toBe(JSON.stringify([{ id: "previous", name: "上一次索引", updatedAt: 1 }]));
  });

  it("recognizes only the explicit DataURL-to-managed-path migration as equivalent", () => {
    expect(isLegacyProjectFullyRepresented(legacyMediaProject(), legacyMediaProject(true))).toBe(true);

    const edited = legacyMediaProject(true);
    edited.nodes[1].workflow = {
      ...(edited.nodes[1].workflow as object),
      prompt: "迁移后又修改了提示词",
    };
    expect(isLegacyProjectFullyRepresented(legacyMediaProject(), edited)).toBe(false);

    const remoteWithoutManagedPath = legacyMediaProject(true);
    delete remoteWithoutManagedPath.nodes[0].localPath;
    expect(isLegacyProjectFullyRepresented(legacyMediaProject(), remoteWithoutManagedPath)).toBe(false);
  });

  it("removes both legacy keys only after the v2 document and index read back", () => {
    const legacy = legacyMediaProject();
    const active: ProjectHistoryRecord = {
      id: "active",
      name: "当前项目",
      updatedAt: 200,
      project: legacyMediaProject(true),
    };
    const storage = new MemoryStorage({
      [LEGACY_CURRENT_PROJECT_KEY]: JSON.stringify(legacy),
      [LEGACY_HISTORY_KEY]: JSON.stringify([{ id: "active", name: "旧项目名", updatedAt: 100, project: legacy }]),
    });

    const result = saveProjectWorkspace(storage, active, [active]);

    expect(result.legacyCleanup).toEqual({
      verifiedV2: true,
      current: "removed",
      history: "removed",
    });
    expect(storage.getItem(LEGACY_CURRENT_PROJECT_KEY)).toBeNull();
    expect(storage.getItem(LEGACY_HISTORY_KEY)).toBeNull();
    expect(storage.getItem(projectDocumentKey("active"))).not.toBeNull();
  });

  it("keeps all legacy keys when a storage adapter silently drops the v2 document", () => {
    const legacy = legacyMediaProject();
    const active: ProjectHistoryRecord = {
      id: "active",
      name: "当前项目",
      updatedAt: 200,
      project: legacyMediaProject(true),
    };
    const storage = new SilentDropStorage(projectDocumentKey("active"), {
      [LEGACY_CURRENT_PROJECT_KEY]: JSON.stringify(legacy),
      [LEGACY_HISTORY_KEY]: JSON.stringify([{ id: "active", name: "当前项目", updatedAt: 100, project: legacy }]),
    });

    expect(() => saveProjectWorkspace(storage, active, [active])).toThrow(
      "project document write was not persisted: active",
    );
    expect(storage.getItem(LEGACY_CURRENT_PROJECT_KEY)).not.toBeNull();
    expect(storage.getItem(LEGACY_HISTORY_KEY)).not.toBeNull();
  });

  it("does not touch legacy rollback keys when the v2 index write throws", () => {
    const legacy = legacyMediaProject();
    const active: ProjectHistoryRecord = {
      id: "active",
      name: "当前项目",
      updatedAt: 200,
      project: legacyMediaProject(true),
    };
    const storage = new FailingStorage(PROJECT_INDEX_KEY, {
      [LEGACY_CURRENT_PROJECT_KEY]: JSON.stringify(legacy),
      [LEGACY_HISTORY_KEY]: JSON.stringify([{ id: "active", name: "当前项目", updatedAt: 100, project: legacy }]),
    });

    expect(() => saveProjectWorkspace(storage, active, [active])).toThrow("storage write failed");
    expect(storage.getItem(LEGACY_CURRENT_PROJECT_KEY)).not.toBeNull();
    expect(storage.getItem(LEGACY_HISTORY_KEY)).not.toBeNull();
  });

  it("persists every retained history document before publishing the v2 index", () => {
    const active: ProjectHistoryRecord = {
      id: "active",
      name: "当前项目",
      updatedAt: 200,
      project: makeProject("active-node"),
    };
    const older: ProjectHistoryRecord = {
      id: "older",
      name: "旧项目",
      updatedAt: 100,
      project: makeProject("older-node"),
    };
    const storage = new MemoryStorage();

    saveProjectWorkspace(storage, active, [active, older]);

    expect(JSON.parse(storage.getItem(projectDocumentKey("active")) || "null").nodes[0].id).toBe("active-node");
    expect(JSON.parse(storage.getItem(projectDocumentKey("older")) || "null").nodes[0].id).toBe("older-node");
    expect(JSON.parse(storage.getItem(PROJECT_INDEX_KEY) || "null").map((item: { id: string }) => item.id)).toEqual([
      "active",
      "older",
    ]);
  });

  it("does not publish an index when an inactive history document cannot be persisted", () => {
    const active: ProjectHistoryRecord = {
      id: "active",
      name: "当前项目",
      updatedAt: 200,
      project: makeProject("active-node"),
    };
    const older: ProjectHistoryRecord = {
      id: "older",
      name: "旧项目",
      updatedAt: 100,
      project: makeProject("older-node"),
    };
    const previousIndex = JSON.stringify([{ id: "previous", name: "原索引", updatedAt: 1 }]);
    const storage = new SilentDropStorage(projectDocumentKey("older"), {
      [PROJECT_INDEX_KEY]: previousIndex,
      [LEGACY_HISTORY_KEY]: JSON.stringify([older]),
    });

    expect(() => saveProjectWorkspace(storage, active, [active, older])).toThrow(
      "project document write was not persisted: older",
    );
    expect(storage.getItem(PROJECT_INDEX_KEY)).toBe(previousIndex);
    expect(storage.getItem(LEGACY_HISTORY_KEY)).not.toBeNull();
  });

  it("rejects a silently dropped index and preserves legacy rollback data", () => {
    const active: ProjectHistoryRecord = {
      id: "active",
      name: "当前项目",
      updatedAt: 200,
      project: makeProject("active-node"),
    };
    const storage = new SilentDropStorage(PROJECT_INDEX_KEY, {
      [LEGACY_CURRENT_PROJECT_KEY]: JSON.stringify(active.project),
    });

    expect(() => saveProjectWorkspace(storage, active, [active])).toThrow(
      "project index write was not persisted",
    );
    expect(storage.getItem(LEGACY_CURRENT_PROJECT_KEY)).not.toBeNull();
  });

  it("keeps an entire legacy history if any historical document is missing from v2", () => {
    const legacy = legacyMediaProject();
    const active: ProjectHistoryRecord = {
      id: "active",
      name: "当前项目",
      updatedAt: 200,
      project: legacyMediaProject(true),
    };
    const missingHistory = makeProject("only-in-v1");
    const storage = new MemoryStorage({
      [LEGACY_CURRENT_PROJECT_KEY]: JSON.stringify(legacy),
      [LEGACY_HISTORY_KEY]: JSON.stringify([
        { id: "active", name: "当前项目", updatedAt: 100, project: legacy },
        { id: "not-yet-migrated", name: "仅在旧历史", updatedAt: 90, project: missingHistory },
      ]),
    });

    const result = saveProjectWorkspace(storage, active, [active]);

    expect(result.legacyCleanup).toEqual({ verifiedV2: true, current: "removed", history: "retained" });
    expect(storage.getItem(LEGACY_CURRENT_PROJECT_KEY)).toBeNull();
    expect(storage.getItem(LEGACY_HISTORY_KEY)).not.toBeNull();
  });

  it("keeps a legacy key when the v2 project has an unrelated edit", () => {
    const legacy = legacyMediaProject();
    const edited = legacyMediaProject(true);
    edited.nodes[0].name = "用户改过的名称";
    const active: ProjectHistoryRecord = { id: "active", name: "当前项目", updatedAt: 200, project: edited };
    const storage = new MemoryStorage({
      [LEGACY_CURRENT_PROJECT_KEY]: JSON.stringify(legacy),
      [LEGACY_HISTORY_KEY]: JSON.stringify([{ id: "active", name: "当前项目", updatedAt: 100, project: legacy }]),
    });

    const result = saveProjectWorkspace(storage, active, [active]);

    expect(result.legacyCleanup).toEqual({ verifiedV2: true, current: "retained", history: "retained" });
  });

  it("reports a refused removal without failing a verified v2 save", () => {
    const legacy = legacyMediaProject();
    const active: ProjectHistoryRecord = { id: "active", name: "当前项目", updatedAt: 200, project: legacyMediaProject(true) };
    const storage = new NonRemovingStorage({
      [LEGACY_CURRENT_PROJECT_KEY]: JSON.stringify(legacy),
      [LEGACY_HISTORY_KEY]: JSON.stringify([{ id: "active", name: "当前项目", updatedAt: 100, project: legacy }]),
    });
    saveProjectDocument(storage, active);
    saveProjectIndex(storage, [active]);

    expect(cleanupFullyMigratedLegacyProjectKeys(storage, active)).toEqual({
      verifiedV2: true,
      current: "remove-failed",
      history: "remove-failed",
    });
  });
});
