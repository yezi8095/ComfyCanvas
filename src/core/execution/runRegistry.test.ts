import { describe, expect, it } from "vitest";

import { createRunRegistry } from "./runRegistry";

describe("RunRegistry", () => {
  it("gives every launch a unique id and permits only its current running owner to commit", () => {
    const registry = createRunRegistry();
    const first = registry.start("project-a", "image-node");
    const second = registry.start("project-a", "video-node");

    expect(first.runId).not.toBe(second.runId);
    expect(registry.canCommit(first.projectId, first.nodeId, first.runId)).toBe(true);
    expect(registry.canCommit(second.projectId, second.nodeId, second.runId)).toBe(true);
    expect(registry.canCommit("project-b", first.nodeId, first.runId)).toBe(false);
  });

  it("invalidates a slow old result immediately when the same node is started again", () => {
    const registry = createRunRegistry();
    const oldRun = registry.start("project-a", "image-node");
    const newRun = registry.start("project-a", "image-node");

    expect(newRun.runId).not.toBe(oldRun.runId);
    expect(registry.canCommit("project-a", "image-node", oldRun.runId)).toBe(false);
    expect(registry.canCommit("project-a", "image-node", newRun.runId)).toBe(true);

    // A stale handler must not be allowed to finish (and thereby disturb) the
    // newer run it no longer owns.
    expect(registry.finish("project-a", "image-node", oldRun.runId)).toBe(false);
    expect(registry.canCommit("project-a", "image-node", newRun.runId)).toBe(true);
  });

  it("keeps cancellation terminal even if delayed UI cleanup later calls finish", () => {
    const registry = createRunRegistry();
    const run = registry.start("project-a", "video-node");

    expect(registry.cancel(run.projectId, run.nodeId, run.runId)).toBe(true);
    expect(registry.getSnapshot(run.projectId, run.nodeId)).toMatchObject({
      runId: run.runId,
      status: "cancelled",
    });
    expect(registry.canCommit(run.projectId, run.nodeId, run.runId)).toBe(false);
    expect(registry.finish(run.projectId, run.nodeId, run.runId)).toBe(false);
    expect(registry.cancel(run.projectId, run.nodeId, run.runId)).toBe(false);
    expect(registry.canCommit(run.projectId, run.nodeId, run.runId)).toBe(false);
  });

  it("makes completed tokens terminal and never permits a duplicate result commit", () => {
    const registry = createRunRegistry();
    const run = registry.start("project-a", "script-node");

    expect(registry.finish(run.projectId, run.nodeId, run.runId)).toBe(true);
    expect(registry.getSnapshot(run.projectId, run.nodeId)).toMatchObject({
      runId: run.runId,
      status: "finished",
    });
    expect(registry.canCommit(run.projectId, run.nodeId, run.runId)).toBe(false);
    expect(registry.finish(run.projectId, run.nodeId, run.runId)).toBe(false);
  });

  it("invalidates every running node in a replaced project without touching other projects", () => {
    const registry = createRunRegistry();
    const image = registry.start("project-a", "image-node");
    const video = registry.start("project-a", "video-node");
    const other = registry.start("project-b", "image-node");

    expect(registry.invalidateProject("project-a")).toBe(2);
    expect(registry.canCommit(image.projectId, image.nodeId, image.runId)).toBe(false);
    expect(registry.canCommit(video.projectId, video.nodeId, video.runId)).toBe(false);
    expect(registry.getSnapshot("project-a", "image-node")?.status).toBe("invalidated");
    expect(registry.canCommit(other.projectId, other.nodeId, other.runId)).toBe(true);
    expect(registry.invalidateProject("project-a")).toBe(0);
  });

  it("does not let a pre-invalidation completion affect a new run", () => {
    const registry = createRunRegistry();
    const oldRun = registry.start("project-a", "workflow-node");
    registry.invalidateProject("project-a");
    const newRun = registry.start("project-a", "workflow-node");

    expect(registry.finish(oldRun.projectId, oldRun.nodeId, oldRun.runId)).toBe(false);
    expect(registry.canCommit(newRun.projectId, newRun.nodeId, newRun.runId)).toBe(true);
  });
});
