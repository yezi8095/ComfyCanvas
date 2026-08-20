/**
 * A small, UI-independent ownership registry for asynchronous node runs.
 *
 * Starting the same node again replaces the prior token immediately.  Async
 * adapters must check `canCommit` right before they write a result back to the
 * canvas.  This prevents a slower, older request from overwriting a newer run.
 *
 * The registry deliberately owns no timers.  In particular, cancelling a run
 * is terminal: a delayed loading-state timeout cannot make that run writable
 * again unless code explicitly starts a brand new run and receives a new id.
 */

export type RunStatus = "running" | "cancelled" | "finished" | "invalidated";

export interface RunToken {
  readonly projectId: string;
  readonly nodeId: string;
  readonly runId: string;
}

export interface RunSnapshot extends RunToken {
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
}

interface MutableRunRecord extends RunSnapshot {
  status: RunStatus;
  endedAt?: number;
}

let runSequence = 0;

const createRunId = () => {
  runSequence += 1;
  const sequence = runSequence.toString(36);
  const uuid = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : undefined;

  // The monotonic counter makes ids distinct even when starts happen in the
  // same millisecond.  UUID keeps ids distinct across app reloads/processes.
  return uuid
    ? `run_${Date.now().toString(36)}_${sequence}_${uuid}`
    : `run_${Date.now().toString(36)}_${sequence}`;
};

const cloneSnapshot = (record: MutableRunRecord): RunSnapshot => ({
  projectId: record.projectId,
  nodeId: record.nodeId,
  runId: record.runId,
  status: record.status,
  startedAt: record.startedAt,
  ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
});

/**
 * Owns the currently valid asynchronous run for every project/node pair.
 *
 * `finish` and `cancel` only change the matching currently-owned run.  A
 * stale completion from an old request therefore cannot finish, cancel or
 * revive the newer request that replaced it.
 */
export class RunRegistry {
  private readonly byProject = new Map<string, Map<string, MutableRunRecord>>();

  /** Begin a new run and immediately invalidate any older run of this node. */
  start(projectId: string, nodeId: string): RunToken {
    const nodeRuns = this.byProject.get(projectId) || new Map<string, MutableRunRecord>();
    this.byProject.set(projectId, nodeRuns);

    const now = Date.now();
    const record: MutableRunRecord = {
      projectId,
      nodeId,
      runId: createRunId(),
      status: "running",
      startedAt: now,
    };
    nodeRuns.set(nodeId, record);

    return {
      projectId: record.projectId,
      nodeId: record.nodeId,
      runId: record.runId,
    };
  }

  /**
   * True only while this exact run remains the current running owner of the
   * node.  Call it immediately before committing an async result to state.
   */
  canCommit(projectId: string, nodeId: string, runId: string): boolean {
    const record = this.byProject.get(projectId)?.get(nodeId);
    return record?.runId === runId && record.status === "running";
  }

  /**
   * Mark this exact current run as cancelled.  It is intentionally not
   * removed: keeping the terminal state makes cancellation irreversible for
   * the old token, including after any UI loading timeout fires.
   */
  cancel(projectId: string, nodeId: string, runId: string): boolean {
    return this.end(projectId, nodeId, runId, "cancelled");
  }

  /**
   * Mark this exact current run as finished.  Finishing is terminal, so a
   * duplicate/late completion cannot commit a second result.
   */
  finish(projectId: string, nodeId: string, runId: string): boolean {
    return this.end(projectId, nodeId, runId, "finished");
  }

  /**
   * Invalidate every active run in a project, for example when importing,
   * deleting, or replacing the project.  Returns the number of runs changed.
   * Terminal records are retained only for the existing project/node keys;
   * they cannot become commit-capable again without `start` creating a new id.
   */
  invalidateProject(projectId: string): number {
    const nodeRuns = this.byProject.get(projectId);
    if (!nodeRuns) return 0;

    const now = Date.now();
    let invalidated = 0;
    nodeRuns.forEach((record) => {
      if (record.status !== "running") return;
      record.status = "invalidated";
      record.endedAt = now;
      invalidated += 1;
    });
    return invalidated;
  }

  /** Read-only diagnostic state for a node's latest token, if it has one. */
  getSnapshot(projectId: string, nodeId: string): RunSnapshot | undefined {
    const record = this.byProject.get(projectId)?.get(nodeId);
    return record ? cloneSnapshot(record) : undefined;
  }

  private end(projectId: string, nodeId: string, runId: string, status: "cancelled" | "finished") {
    const record = this.byProject.get(projectId)?.get(nodeId);
    if (!record || record.runId !== runId || record.status !== "running") return false;

    record.status = status;
    record.endedAt = Date.now();
    return true;
  }
}

/** A convenience factory for adapters that prefer composition over classes. */
export const createRunRegistry = () => new RunRegistry();
