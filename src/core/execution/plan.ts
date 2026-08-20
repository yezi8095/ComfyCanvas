import type { GraphLink, PortSpec } from "../graph/types";
import type { GraphLinkIssue, GraphLinkIssueCode } from "../graph/validation";
import { validateNewLink } from "../graph/validation";
import { getBuiltinNodeDefinition } from "../nodes/builtins";
import type { CanvasNode, CanvasProject } from "../project/types";

/**
 * The part of the graph a user asked to run.  The plan deliberately does not
 * submit jobs: it only answers what is safe to schedule and why a node is
 * blocked.  Keeping this here makes it usable by Canvas, ComfyUI and a future
 * queue without coupling any of them to React state.
 */
export type ExecutionRunScope = "single" | "downstream" | "workflow";

export type ExecutionPlanIssueCode =
  | GraphLinkIssueCode
  | "target-missing"
  | "non-executable"
  | "orphan-link"
  | "invalid-input-link"
  | "missing-input"
  | "upstream-blocked";

export interface ExecutionPlanIssue {
  id: string;
  code: ExecutionPlanIssueCode;
  severity: "error" | "warning";
  nodeId: string;
  portId?: string;
  linkId?: string;
  message: string;
  suggestion?: string;
}

export interface ExecutionPlanOptions {
  scope: ExecutionRunScope;
  /** Required for `single` and `downstream`; ignored for `workflow`. */
  nodeId?: string;
}

export interface ExecutionPlan {
  scope: ExecutionRunScope;
  targetNodeId?: string;
  /** Nodes the requested scope would schedule, in deterministic canvas order. */
  scheduledNodeIds: string[];
  /** Alias for consumers that only need the selected run scope. */
  nodeIds: string[];
  /** All transitive graph dependencies of the requested node. */
  upstreamNodeIds: string[];
  /** All transitive graph consumers of the requested node. */
  downstreamNodeIds: string[];
  /** Topological order within `scheduledNodeIds`; cyclic leftovers stay last. */
  executionOrder: string[];
  /** Scheduled nodes with no blocking graph/configuration issue. */
  runnableNodeIds: string[];
  /** Scheduled nodes that must not be submitted. */
  blockedNodeIds: string[];
  /** Diagnostics suitable for inline node/edge error rendering. */
  issues: ExecutionPlanIssue[];
}

interface AnalysedLink {
  link: GraphLink;
  /** The link has real endpoints, explicit ports and compatible types. */
  structural: boolean;
}

interface GraphAnalysis {
  nodeById: ReadonlyMap<string, CanvasNode>;
  nodeOrder: ReadonlyMap<string, number>;
  executableNodeIds: readonly string[];
  links: readonly AnalysedLink[];
  issues: readonly ExecutionPlanIssue[];
}

const error = (
  id: string,
  code: ExecutionPlanIssueCode,
  nodeId: string,
  message: string,
  details: Partial<Pick<ExecutionPlanIssue, "portId" | "linkId" | "suggestion">> = {},
): ExecutionPlanIssue => ({
  id,
  code,
  severity: "error",
  nodeId,
  message,
  ...(details.portId ? { portId: details.portId } : {}),
  ...(details.linkId ? { linkId: details.linkId } : {}),
  ...(details.suggestion ? { suggestion: details.suggestion } : {}),
});

const asPlanIssue = (current: GraphLinkIssue): ExecutionPlanIssue => ({
  id: `graph:${current.id}`,
  code: current.code,
  severity: current.severity,
  nodeId: current.nodeId,
  ...(current.portId ? { portId: current.portId } : {}),
  ...(current.linkId ? { linkId: current.linkId } : {}),
  message: current.message,
  ...(current.suggestion ? { suggestion: current.suggestion } : {}),
});

const uniqueIssues = (issues: readonly ExecutionPlanIssue[]) => {
  const seen = new Set<string>();
  return issues.filter((current) => {
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    return true;
  });
};

const sortByCanvasOrder = (nodeOrder: ReadonlyMap<string, number>, ids: Iterable<string>) =>
  [...new Set(ids)].sort((left, right) => (nodeOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (nodeOrder.get(right) ?? Number.MAX_SAFE_INTEGER));

const isExecutable = (node: CanvasNode | undefined) => Boolean(node && getBuiltinNodeDefinition(node.kind));

const port = (node: CanvasNode, direction: "input" | "output", id: string): PortSpec | undefined =>
  (direction === "input"
    ? getBuiltinNodeDefinition(node.kind)?.inputs
    : getBuiltinNodeDefinition(node.kind)?.outputs
  )?.find((current) => current.id === id);

/**
 * Validate every stored edge against its explicit typed ports.  A legacy edge
 * with only node ids is deliberately not inferred here: changing a saved
 * connection at run time is more dangerous than reporting it for repair.
 */
const analyseGraph = (project: CanvasProject): GraphAnalysis => {
  const nodeById = new Map(project.nodes.map((node) => [node.id, node]));
  const nodeOrder = new Map(project.nodes.map((node, index) => [node.id, index]));
  const executableNodeIds = project.nodes
    .filter((node) => isExecutable(node))
    .map((node) => node.id);
  const issues: ExecutionPlanIssue[] = [];
  const links: AnalysedLink[] = project.links.map((link, linkIndex) => {
    const fromNode = nodeById.get(link.from);
    const toNode = nodeById.get(link.to);

    if (!fromNode || !toNode) {
      const remainingNode = fromNode || toNode;
      if (remainingNode) {
        issues.push(error(
          `orphan-link:${link.id}:${remainingNode.id}:${linkIndex}`,
          "orphan-link",
          remainingNode.id,
          "这条连线有一端节点已不存在，无法作为可运行依赖。",
          {
            linkId: link.id,
            suggestion: "删除失效连线，或恢复缺失的上游/下游节点。",
          },
        ));
      }

      // validateNewLink also produces the precise missing endpoint diagnostic.
      const withoutCurrent = {
        ...project,
        links: project.links.filter((_, index) => index !== linkIndex),
      };
      issues.push(...validateNewLink(withoutCurrent, link.from, link.to, {
        id: link.id,
        fromPort: link.fromPort,
        toPort: link.toPort,
      }).issues.map(asPlanIssue));
      return { link, structural: false };
    }

    if (!link.fromPort || !link.toPort) {
      issues.push(error(
        `legacy-port-unresolved:${link.id}:${linkIndex}`,
        "legacy-port-unresolved",
        toNode.id,
        "旧连线没有保存输入/输出插槽，运行前无法安全判断该把结果送到哪里。",
        {
          linkId: link.id,
          suggestion: "在画布上删除这条旧连线后重新连接，并明确选择插槽。",
        },
      ));
      return { link, structural: false };
    }

    const withoutCurrent = {
      ...project,
      links: project.links.filter((_, index) => index !== linkIndex),
    };
    const validation = validateNewLink(withoutCurrent, link.from, link.to, {
      id: link.id,
      fromPort: link.fromPort,
      toPort: link.toPort,
    });

    // Cycles are diagnosed per member below, rather than only on the final
    // edge that happened to close the loop.
    const nonCycleIssues = validation.issues.filter((current) => current.code !== "cycle");
    issues.push(...nonCycleIssues.map(asPlanIssue));
    // A malformed stored link can report its bad source port on the upstream
    // node.  The consumer must still be blocked: otherwise a run would simply
    // drop that input and make it look as though the canvas connection worked.
    if (
      nonCycleIssues.some((current) => current.severity === "error")
      && !nonCycleIssues.some((current) => current.nodeId === toNode.id)
    ) {
      issues.push(error(
        `invalid-input-link:${link.id}:${linkIndex}`,
        "invalid-input-link",
        toNode.id,
        "这条进入当前节点的连线引用了不存在或不兼容的插槽，不能安全传入上游结果。",
        {
          linkId: link.id,
          suggestion: "删除这条连线后重新连接，并选择当前节点实际存在的输入插槽。",
        },
      ));
    }
    return {
      link,
      structural: nonCycleIssues.every((current) => current.severity !== "error"),
    };
  });

  const structuralLinks = links.filter((current) => current.structural).map((current) => current.link);
  for (const nodeId of findCyclicNodeIds(executableNodeIds, structuralLinks)) {
    issues.push(error(
      `cycle:${nodeId}`,
      "cycle",
      nodeId,
      "该节点位于循环连线中，执行顺序无法确定。",
      { suggestion: "断开一条从下游返回上游的连线后再运行。" },
    ));
  }

  return {
    nodeById,
    nodeOrder,
    executableNodeIds,
    links,
    issues: uniqueIssues(issues),
  };
};

const structuralLinks = (analysis: GraphAnalysis) =>
  analysis.links.filter((current) => current.structural).map((current) => current.link);

const adjacencyFor = (links: readonly GraphLink[], direction: "upstream" | "downstream") => {
  const result = new Map<string, string[]>();
  links.forEach((link) => {
    const from = direction === "downstream" ? link.from : link.to;
    const to = direction === "downstream" ? link.to : link.from;
    const current = result.get(from) || [];
    current.push(to);
    result.set(from, current);
  });
  return result;
};

const walk = (
  startId: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  nodeOrder: ReadonlyMap<string, number>,
) => {
  const visited = new Set<string>();
  const pending = [...(adjacency.get(startId) || [])];
  while (pending.length) {
    const current = pending.pop()!;
    if (current === startId || visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) || []) pending.push(next);
  }
  return sortByCanvasOrder(nodeOrder, visited);
};

/** Returns every transitive typed dependency of a node, without mutating the project. */
export const getUpstreamNodeIds = (project: CanvasProject, nodeId: string): string[] => {
  const analysis = analyseGraph(project);
  return walk(nodeId, adjacencyFor(structuralLinks(analysis), "upstream"), analysis.nodeOrder)
    .filter((id) => isExecutable(analysis.nodeById.get(id)));
};

/** Returns every transitive typed consumer of a node, without mutating the project. */
export const getDownstreamNodeIds = (project: CanvasProject, nodeId: string): string[] => {
  const analysis = analyseGraph(project);
  return walk(nodeId, adjacencyFor(structuralLinks(analysis), "downstream"), analysis.nodeOrder)
    .filter((id) => isExecutable(analysis.nodeById.get(id)));
};

/**
 * A successful upstream re-run invalidates all descendants.  The caller owns
 * persistence/status changes; this helper only returns the exact node ids.
 */
export const getInvalidatedDownstreamNodeIds = getDownstreamNodeIds;

/** Alias intended for queue code that reads more naturally at the call site. */
export const invalidateDownstream = getDownstreamNodeIds;

const findCyclicNodeIds = (nodeIds: readonly string[], links: readonly GraphLink[]) => {
  const adjacency = adjacencyFor(links, "downstream");
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cyclic = new Set<string>();
  let index = 0;

  const visit = (nodeId: string) => {
    indices.set(nodeId, index);
    lowLinks.set(nodeId, index);
    index += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const next of adjacency.get(nodeId) || []) {
      if (!indices.has(next)) {
        visit(next);
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId)!, lowLinks.get(next)!));
      } else if (onStack.has(next)) {
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId)!, indices.get(next)!));
      }
    }

    if (lowLinks.get(nodeId) !== indices.get(nodeId)) return;
    const component: string[] = [];
    let current: string | undefined;
    do {
      current = stack.pop();
      if (!current) break;
      onStack.delete(current);
      component.push(current);
    } while (current !== nodeId);

    const selfCycle = component.length === 1 && (adjacency.get(nodeId) || []).includes(nodeId);
    if (component.length > 1 || selfCycle) component.forEach((member) => cyclic.add(member));
  };

  nodeIds.forEach((nodeId) => {
    if (!indices.has(nodeId)) visit(nodeId);
  });
  return cyclic;
};

const topologicalOrder = (
  scheduledNodeIds: readonly string[],
  links: readonly GraphLink[],
  nodeOrder: ReadonlyMap<string, number>,
) => {
  const scheduled = new Set(scheduledNodeIds);
  const indegree = new Map(scheduledNodeIds.map((id) => [id, 0]));
  const adjacency = new Map<string, string[]>();
  links.forEach((link) => {
    if (!scheduled.has(link.from) || !scheduled.has(link.to)) return;
    indegree.set(link.to, (indegree.get(link.to) || 0) + 1);
    const targets = adjacency.get(link.from) || [];
    targets.push(link.to);
    adjacency.set(link.from, targets);
  });

  const queue = sortByCanvasOrder(nodeOrder, scheduledNodeIds.filter((id) => indegree.get(id) === 0));
  const result: string[] = [];
  while (queue.length) {
    const current = queue.shift()!;
    result.push(current);
    for (const next of adjacency.get(current) || []) {
      const nextDegree = (indegree.get(next) || 0) - 1;
      indegree.set(next, nextDegree);
      if (nextDegree === 0) {
        queue.push(next);
        queue.sort((left, right) => (nodeOrder.get(left) ?? 0) - (nodeOrder.get(right) ?? 0));
      }
    }
  }

  // Keep output deterministic and inspectable even for a blocked cycle.
  return [...result, ...scheduledNodeIds.filter((id) => !result.includes(id))];
};

const addRequiredInputIssues = (analysis: GraphAnalysis, issues: ExecutionPlanIssue[]) => {
  const incoming = new Map<string, Set<string>>();
  structuralLinks(analysis).forEach((link) => {
    if (!link.toPort) return;
    const key = `${link.to}:${link.toPort}`;
    const ports = incoming.get(key) || new Set<string>();
    ports.add(link.from);
    incoming.set(key, ports);
  });

  for (const nodeId of analysis.executableNodeIds) {
    const definition = getBuiltinNodeDefinition(analysis.nodeById.get(nodeId)!.kind);
    definition?.inputs.filter((input) => input.required).forEach((input) => {
      if (incoming.get(`${nodeId}:${input.id}`)?.size) return;
      issues.push(error(
        `missing-input:${nodeId}:${input.id}`,
        "missing-input",
        nodeId,
        `缺少必需输入“${input.label}”。`,
        {
          portId: input.id,
          suggestion: `把兼容结果连接到“${input.label}”插槽。`,
        },
      ));
    });
  }
};

const addBlockedUpstreamIssues = (analysis: GraphAnalysis, issues: ExecutionPlanIssue[]) => {
  const blocked = new Set(
    issues
      .filter((current) => current.severity === "error" && analysis.nodeById.has(current.nodeId))
      .map((current) => current.nodeId),
  );
  const propagationLinks = structuralLinks(analysis);
  let changed = true;
  while (changed) {
    changed = false;
    for (const link of propagationLinks) {
      if (!blocked.has(link.from) || blocked.has(link.to)) continue;
      blocked.add(link.to);
      issues.push(error(
        `upstream-blocked:${link.from}:${link.to}:${link.toPort || "input"}`,
        "upstream-blocked",
        link.to,
        "上游节点存在错误，当前节点不能安全运行。",
        {
          portId: link.toPort,
          linkId: link.id,
          suggestion: "先修复上游节点或断开该依赖后再运行。",
        },
      ));
      changed = true;
    }
  }
};

/**
 * Computes a non-mutating execution plan from the typed canvas graph.
 *
 * It intentionally validates only topology and port contracts. Provider keys,
 * model files, prompt contents and remote API availability belong to adapters
 * and are added as execution-job diagnostics later.
 */
export const planExecution = (
  project: CanvasProject,
  options: ExecutionPlanOptions,
): ExecutionPlan => {
  const analysis = analyseGraph(project);
  const issues = [...analysis.issues];
  const requestedNode = options.nodeId ? analysis.nodeById.get(options.nodeId) : undefined;
  let scheduledNodeIds: string[] = [];
  let upstreamNodeIds: string[] = [];
  let downstreamNodeIds: string[] = [];

  if (options.scope === "workflow") {
    scheduledNodeIds = [...analysis.executableNodeIds];
  } else if (!options.nodeId || !requestedNode) {
    issues.push(error(
      `target-missing:${options.nodeId || "none"}`,
      "target-missing",
      options.nodeId || "",
      "没有找到要运行的节点。",
      { suggestion: "请选择画布上的生成/工作流节点后再运行。" },
    ));
  } else if (!isExecutable(requestedNode)) {
    issues.push(error(
      `non-executable:${requestedNode.id}`,
      "non-executable",
      requestedNode.id,
      "该节点是注释或辅助元素，不能直接运行。",
      { suggestion: "请选择 AI 生成、媒体或 API 工作流节点。" },
    ));
  } else {
    upstreamNodeIds = walk(
      requestedNode.id,
      adjacencyFor(structuralLinks(analysis), "upstream"),
      analysis.nodeOrder,
    ).filter((id) => isExecutable(analysis.nodeById.get(id)));
    downstreamNodeIds = walk(
      requestedNode.id,
      adjacencyFor(structuralLinks(analysis), "downstream"),
      analysis.nodeOrder,
    ).filter((id) => isExecutable(analysis.nodeById.get(id)));
    scheduledNodeIds = options.scope === "single"
      ? [requestedNode.id]
      : [requestedNode.id, ...downstreamNodeIds];
  }

  addRequiredInputIssues(analysis, issues);
  addBlockedUpstreamIssues(analysis, issues);
  const unique = uniqueIssues(issues);
  const blocked = new Set(
    unique
      .filter((current) => current.severity === "error")
      .map((current) => current.nodeId),
  );
  const orderedScheduled = sortByCanvasOrder(analysis.nodeOrder, scheduledNodeIds);
  const blockedNodeIds = orderedScheduled.filter((id) => blocked.has(id));
  const runnableNodeIds = orderedScheduled.filter((id) => !blocked.has(id));

  return {
    scope: options.scope,
    ...(options.nodeId ? { targetNodeId: options.nodeId } : {}),
    scheduledNodeIds: orderedScheduled,
    nodeIds: [...orderedScheduled],
    upstreamNodeIds,
    downstreamNodeIds,
    executionOrder: topologicalOrder(orderedScheduled, structuralLinks(analysis), analysis.nodeOrder),
    runnableNodeIds,
    blockedNodeIds,
    issues: unique,
  };
};

/** Convenience overload for callers that store scope and node separately. */
export const planExecutionScope = (
  project: CanvasProject,
  scope: ExecutionRunScope,
  nodeId?: string,
) => planExecution(project, { scope, ...(nodeId ? { nodeId } : {}) });
