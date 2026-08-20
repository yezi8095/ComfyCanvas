import {
  getBuiltinNodeDefinition,
  getLegacyPreferredInputPort,
} from "../nodes/builtins";
import type { CanvasNode, CanvasProject } from "../project/types";
import {
  canConnectPortKinds,
  type GraphLink,
  type PortDataKind,
  type PortSpec,
} from "./types";

export type GraphLinkIssueCode =
  | "missing-node"
  | "missing-port"
  | "self-link"
  | "duplicate-link"
  | "type-mismatch"
  | "cycle"
  | "single-input-occupied"
  | "legacy-port-unresolved";

export interface GraphLinkIssue {
  id: string;
  code: GraphLinkIssueCode;
  severity: "error" | "warning";
  nodeId: string;
  portId?: string;
  linkId?: string;
  message: string;
  suggestion?: string;
}

export interface CompatiblePortPair {
  fromPort: PortSpec;
  toPort: PortSpec;
  /** Exact matches sort ahead of wildcard `any` matches. */
  exactType: boolean;
}

export interface NewLinkOptions {
  id?: string;
  fromPort?: string;
  toPort?: string;
}

export interface NewLinkValidationResult {
  valid: boolean;
  link?: GraphLink;
  issues: GraphLinkIssue[];
  compatiblePorts: CompatiblePortPair[];
}

export interface LegacyLinkUpgradeResult {
  project: CanvasProject;
  issues: GraphLinkIssue[];
}

const issue = (
  code: GraphLinkIssueCode,
  nodeId: string,
  message: string,
  details: Partial<Pick<GraphLinkIssue, "portId" | "linkId" | "suggestion" | "severity">> = {},
): GraphLinkIssue => ({
  id: `${code}:${details.linkId || nodeId}:${details.portId || "node"}`,
  code,
  severity: details.severity || "error",
  nodeId,
  message,
  ...(details.portId ? { portId: details.portId } : {}),
  ...(details.linkId ? { linkId: details.linkId } : {}),
  ...(details.suggestion ? { suggestion: details.suggestion } : {}),
});

const findNode = (project: CanvasProject, id: string) =>
  project.nodes.find((node) => node.id === id);

const outputPorts = (node: CanvasNode): readonly PortSpec[] =>
  getBuiltinNodeDefinition(node.kind)?.outputs || [];

const inputPorts = (node: CanvasNode): readonly PortSpec[] =>
  getBuiltinNodeDefinition(node.kind)?.inputs || [];

const portPairScore = (pair: CompatiblePortPair) => {
  let score = pair.exactType ? 100 : 0;
  if (pair.fromPort.id === pair.toPort.id) score += 20;
  if (pair.toPort.required) score += 5;
  return score;
};

/** Returns all type-compatible output/input pairs in deterministic preference order. */
export const inferCompatiblePorts = (
  project: CanvasProject,
  fromId: string,
  toId: string,
): CompatiblePortPair[] => {
  const fromNode = findNode(project, fromId);
  const toNode = findNode(project, toId);
  if (!fromNode || !toNode) return [];

  const pairs = outputPorts(fromNode).flatMap((fromPort) =>
    inputPorts(toNode)
      .filter((toPort) => canConnectPortKinds(fromPort.kind, toPort.kind))
      .map((toPort) => ({
        fromPort,
        toPort,
        exactType: fromPort.kind === toPort.kind,
      })),
  );

  return pairs.sort((left, right) => portPairScore(right) - portPairScore(left));
};

const wouldCreateCycle = (project: CanvasProject, fromId: string, toId: string) => {
  const adjacency = new Map<string, Set<string>>();
  for (const link of project.links) {
    const targets = adjacency.get(link.from) || new Set<string>();
    targets.add(link.to);
    adjacency.set(link.from, targets);
  }

  const pending = [toId];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === fromId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const target of adjacency.get(current) || []) pending.push(target);
  }
  return false;
};

const linkIdentity = (link: Pick<GraphLink, "from" | "fromPort" | "to" | "toPort">) =>
  `${link.from}:${link.fromPort || ""}->${link.to}:${link.toPort || ""}`;

const isTargetPortOccupied = (project: CanvasProject, toId: string, toPort: PortSpec) =>
  !toPort.multiple && project.links.some((link) => link.to === toId && link.toPort === toPort.id);

const candidateLink = (
  fromId: string,
  toId: string,
  pair: CompatiblePortPair,
  id?: string,
): GraphLink => ({
  id: id || `link:${fromId}:${pair.fromPort.id}->${toId}:${pair.toPort.id}`,
  from: fromId,
  fromPort: pair.fromPort.id,
  to: toId,
  toPort: pair.toPort.id,
});

/**
 * Validates a prospective connection without mutating the project. When ports
 * are omitted the highest ranked available compatible pair is selected.
 */
export const validateNewLink = (
  project: CanvasProject,
  fromId: string,
  toId: string,
  options: NewLinkOptions = {},
): NewLinkValidationResult => {
  const issues: GraphLinkIssue[] = [];
  const fromNode = findNode(project, fromId);
  const toNode = findNode(project, toId);

  if (!fromNode) {
    issues.push(issue("missing-node", fromId, `找不到上游节点“${fromId}”。`));
  }
  if (!toNode) {
    issues.push(issue("missing-node", toId, `找不到下游节点“${toId}”。`));
  }
  if (!fromNode || !toNode) return { valid: false, issues, compatiblePorts: [] };

  if (fromId === toId) {
    issues.push(issue("self-link", toId, "节点不能连接到自身。"));
  }

  const fromDefinitionPorts = outputPorts(fromNode);
  const toDefinitionPorts = inputPorts(toNode);
  const requestedFromPort = options.fromPort
    ? fromDefinitionPorts.find((port) => port.id === options.fromPort)
    : undefined;
  const requestedToPort = options.toPort
    ? toDefinitionPorts.find((port) => port.id === options.toPort)
    : undefined;

  if (options.fromPort && !requestedFromPort) {
    issues.push(
      issue("missing-port", fromId, `上游节点没有输出插槽“${options.fromPort}”。`, {
        portId: options.fromPort,
      }),
    );
  }
  if (options.toPort && !requestedToPort) {
    issues.push(
      issue("missing-port", toId, `下游节点没有输入插槽“${options.toPort}”。`, {
        portId: options.toPort,
      }),
    );
  }

  let compatiblePorts = inferCompatiblePorts(project, fromId, toId);
  if (options.fromPort) {
    compatiblePorts = compatiblePorts.filter((pair) => pair.fromPort.id === options.fromPort);
  }
  if (options.toPort) {
    compatiblePorts = compatiblePorts.filter((pair) => pair.toPort.id === options.toPort);
  }

  if (
    requestedFromPort &&
    requestedToPort &&
    !canConnectPortKinds(requestedFromPort.kind, requestedToPort.kind)
  ) {
    issues.push(
      issue(
        "type-mismatch",
        toId,
        `不能把 ${requestedFromPort.kind} 输出连接到 ${requestedToPort.kind} 输入。`,
        {
          portId: requestedToPort.id,
          suggestion: `请选择 ${requestedFromPort.kind} 类型的输入插槽。`,
        },
      ),
    );
  } else if (!options.fromPort && !options.toPort && compatiblePorts.length === 0) {
    const sourceKinds = [...new Set(fromDefinitionPorts.map((port) => port.kind))].join(" / ") || "无";
    const targetKinds = [...new Set(toDefinitionPorts.map((port) => port.kind))].join(" / ") || "无";
    issues.push(
      issue("type-mismatch", toId, `没有可连接的插槽：上游输出 ${sourceKinds}，下游需要 ${targetKinds}。`),
    );
  }

  const selectedPair =
    compatiblePorts.find((pair) => {
      const proposal = candidateLink(fromId, toId, pair, options.id);
      const duplicate = project.links.some((link) => linkIdentity(link) === linkIdentity(proposal));
      return !duplicate && !isTargetPortOccupied(project, toId, pair.toPort);
    }) || compatiblePorts[0];
  const link = selectedPair ? candidateLink(fromId, toId, selectedPair, options.id) : undefined;

  if (link && selectedPair) {
    if (project.links.some((current) => linkIdentity(current) === linkIdentity(link))) {
      issues.push(
        issue("duplicate-link", toId, "这两个插槽已经连接。", {
          portId: selectedPair.toPort.id,
        }),
      );
    }
    if (isTargetPortOccupied(project, toId, selectedPair.toPort)) {
      issues.push(
        issue("single-input-occupied", toId, `输入插槽“${selectedPair.toPort.label}”只能连接一次。`, {
          portId: selectedPair.toPort.id,
          suggestion: "先断开现有连线，或选择支持多个输入的参考图插槽。",
        }),
      );
    }
  }

  if (wouldCreateCycle(project, fromId, toId)) {
    issues.push(
      issue("cycle", toId, "这条连线会形成环路，节点图只能保持单向无环。", {
        suggestion: "删除下游返回上游的连线后再连接。",
      }),
    );
  }

  return {
    valid: issues.every((current) => current.severity !== "error") && Boolean(link),
    ...(link ? { link } : {}),
    issues,
    compatiblePorts,
  };
};

const legacyCandidates = (
  project: CanvasProject,
  link: GraphLink,
): CompatiblePortPair[] =>
  inferCompatiblePorts(project, link.from, link.to).filter(
    (pair) =>
      (!link.fromPort || pair.fromPort.id === link.fromPort) &&
      (!link.toPort || pair.toPort.id === link.toPort),
  );

const selectLegacyPair = (
  fromNode: CanvasNode,
  toNode: CanvasNode,
  candidates: CompatiblePortPair[],
): CompatiblePortPair | undefined => {
  if (candidates.length === 1) return candidates[0];

  for (const sourceKind of new Set(candidates.map((pair) => pair.fromPort.kind))) {
    const preferredInput = getLegacyPreferredInputPort(toNode.kind, sourceKind as PortDataKind);
    if (!preferredInput) continue;
    const preferred = candidates.filter((pair) => pair.toPort.id === preferredInput);
    if (preferred.length === 1) return preferred[0];
  }

  // A single output plus a single input kind is safe even when a wildcard is involved.
  const outputIds = new Set(candidates.map((pair) => pair.fromPort.id));
  const inputIds = new Set(candidates.map((pair) => pair.toPort.id));
  if (outputIds.size === 1 && inputIds.size === 1) return candidates[0];

  void fromNode;
  return undefined;
};

/**
 * Adds typed port ids to endpoint-only legacy links. Ambiguous links are kept
 * untouched and reported, so migration never silently changes their meaning.
 */
export const upgradeLegacyLinks = (project: CanvasProject): LegacyLinkUpgradeResult => {
  const issues: GraphLinkIssue[] = [];
  const links = project.links.map((link) => {
    if (link.fromPort && link.toPort) return { ...link };

    const fromNode = findNode(project, link.from);
    const toNode = findNode(project, link.to);
    if (!fromNode || !toNode) {
      const missingId = fromNode ? link.to : link.from;
      issues.push(
        issue("legacy-port-unresolved", missingId, "旧连线指向不存在的节点，无法补全插槽。", {
          linkId: link.id,
          suggestion: "删除这条失效连线并重新连接。",
        }),
      );
      return { ...link };
    }

    const candidates = legacyCandidates(project, link);
    const selected = selectLegacyPair(fromNode, toNode, candidates);
    if (!selected) {
      issues.push(
        issue(
          "legacy-port-unresolved",
          toNode.id,
          candidates.length
            ? "旧连线对应多个兼容插槽，无法安全判断原来的目标。"
            : "旧连线两端没有兼容插槽。",
          {
            linkId: link.id,
            suggestion: "在画布上重新连接并明确选择输入插槽。",
          },
        ),
      );
      return { ...link };
    }

    return {
      ...link,
      fromPort: link.fromPort || selected.fromPort.id,
      toPort: link.toPort || selected.toPort.id,
    };
  });

  return {
    project: {
      ...project,
      nodes: project.nodes.map((node) => ({ ...node })),
      links,
      view: { ...project.view },
      ...(project.groups
        ? { groups: project.groups.map((group) => ({ ...group, nodeIds: [...group.nodeIds] })) }
        : {}),
    },
    issues,
  };
};
