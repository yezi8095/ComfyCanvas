import type { GraphLink } from "../graph/types";
import { normalizeProject } from "./migrate";
import type { CanvasNode, CanvasProject, NodeGroup } from "./types";

export interface GroupMoveDelta {
  x: number;
  y: number;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const referenceNodeId = (reference: unknown): string | undefined => {
  if (typeof reference === "string") return reference;
  if (!isPlainRecord(reference)) return undefined;
  return typeof reference.id === "string" ? reference.id : undefined;
};

/**
 * Removes only references whose shape is known to point at a canvas node.
 * Unknown workflow objects and unknown reference entries are deliberately kept.
 */
const withoutDeletedWorkflowReferences = (workflow: unknown, deletedIds: ReadonlySet<string>): unknown => {
  if (!isPlainRecord(workflow) || !Array.isArray(workflow.references)) return workflow;
  const references = workflow.references.filter((reference) => {
    const nodeId = referenceNodeId(reference);
    return nodeId === undefined || !deletedIds.has(nodeId);
  });
  return references.length === workflow.references.length ? workflow : { ...workflow, references };
};

const uniqueSurvivingNodeIds = (nodeIds: readonly string[], deletedIds: ReadonlySet<string>) => {
  const seen = new Set<string>();
  return nodeIds.filter((nodeId) => {
    if (deletedIds.has(nodeId) || seen.has(nodeId)) return false;
    seen.add(nodeId);
    return true;
  });
};

/**
 * Deletes canvas nodes and all project-level relationships that would otherwise
 * point at them. Groups with fewer than two surviving nodes stop being groups.
 */
export const deleteNodes = (project: CanvasProject, ids: Iterable<string>): CanvasProject => {
  const deletedIds = new Set(ids);
  if (deletedIds.size === 0) return normalizeProject(project, { resetTransient: false });

  const nodes: CanvasNode[] = project.nodes
    .filter((node) => !deletedIds.has(node.id))
    .map((node) => {
      const workflow = withoutDeletedWorkflowReferences(node.workflow, deletedIds);
      return workflow === node.workflow ? node : { ...node, workflow };
    });
  const links = project.links.filter(
    (link) => !deletedIds.has(link.from) && !deletedIds.has(link.to),
  );
  const groups: NodeGroup[] = (project.groups || [])
    .map((group) => ({
      ...group,
      nodeIds: uniqueSurvivingNodeIds(group.nodeIds, deletedIds),
    }))
    .filter((group) => group.nodeIds.length >= 2);

  return normalizeProject({ ...project, nodes, links, groups }, { resetTransient: false });
};

const linkIdentity = (link: GraphLink) =>
  `${link.from}:${link.fromPort || ""}->${link.to}:${link.toPort || ""}`;

/**
 * Adds a link only when both endpoints exist and neither its ID nor its complete
 * port-to-port identity is already present.
 */
export const connectNodes = (project: CanvasProject, link: GraphLink): CanvasProject => {
  const normalized = normalizeProject(project, { resetTransient: false });
  const nodeIds = new Set(normalized.nodes.map((node) => node.id));
  const identity = linkIdentity(link);
  const invalid =
    !link.id ||
    link.from === link.to ||
    !nodeIds.has(link.from) ||
    !nodeIds.has(link.to) ||
    normalized.links.some((current) => current.id === link.id || linkIdentity(current) === identity);

  return invalid
    ? normalized
    : normalizeProject(
        { ...normalized, links: [...normalized.links, { ...link }] },
        { resetTransient: false },
      );
};

/**
 * Moves a group frame and every node that belongs to it by the same delta.
 */
export const moveGroup = (
  project: CanvasProject,
  groupId: string,
  delta: GroupMoveDelta,
): CanvasProject => {
  const normalized = normalizeProject(project, { resetTransient: false });
  const group = (normalized.groups || []).find((candidate) => candidate.id === groupId);
  if (!group || !Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return normalized;

  const memberIds = new Set(group.nodeIds);
  const nodes = normalized.nodes.map((node) =>
    memberIds.has(node.id) ? { ...node, x: node.x + delta.x, y: node.y + delta.y } : node,
  );
  const groups = (normalized.groups || []).map((candidate) =>
    candidate.id === groupId
      ? {
          ...candidate,
          bounds: {
            ...candidate.bounds,
            x: candidate.bounds.x + delta.x,
            y: candidate.bounds.y + delta.y,
          },
        }
      : candidate,
  );

  return normalizeProject({ ...normalized, nodes, groups }, { resetTransient: false });
};
