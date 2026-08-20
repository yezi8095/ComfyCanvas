import type { GraphLink } from "../graph/types";
import type { CanvasNode, CanvasProject } from "../project/types";

/**
 * A stable, privacy-safe fingerprint of the inputs that can affect one canvas
 * execution.  It is intentionally not a project checksum: moving a card,
 * selecting it, or updating a transient run status must not invalidate an
 * already completed result.
 */
export type ExecutionInputSignature = string;

const SIGNATURE_VERSION = "exec-input:v1";

// These fields only affect presentation, interaction, or persisted run state.
// Keep execution data explicit below rather than accidentally making a visual
// change invalidate an expensive image/video generation.
const NON_EXECUTION_NODE_FIELDS = new Set<string>([
  "id",
  "kind",
  "x",
  "y",
  "width",
  "height",
  "name",
  "status",
  "createdAt",
  "rotation",
  "locked",
  "mirrored",
  "pointerId",
  "annotationId",
  "fontSize",
  "validationErrors",
  "selected",
  "isSelected",
  "hovered",
  "isHovered",
  "focused",
  "dragging",
  "resizing",
  "zIndex",
  "order",
  "collapsed",
  "color",
  "theme",
  "position",
  "bounds",
]);

const KNOWN_EXECUTION_NODE_FIELDS = new Set<string>([
  "text",
  "storyboard",
  "src",
  "fileName",
  "localPath",
  "mediaWidth",
  "mediaHeight",
  "workflow",
  "onlineProvider",
]);

/** A tiny synchronous FNV-1a implementation suitable for browser and Tauri. */
const hashText = (value: string) => {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
};

/**
 * Leaves no plaintext prompt, data URL, local path, or provider secret in a
 * generated signature.  Length is useful for avoiding accidental collisions
 * in diagnostic tooling without exposing the source itself.
 */
const valueDigest = (value: string) => `${value.length}:${hashText(value)}`;

type SafeValue =
  | null
  | boolean
  | number
  | string
  | SafeValue[]
  | { [key: string]: SafeValue };

interface NormaliseContext {
  seen: WeakMap<object, number>;
  nextReferenceId: number;
}

/**
 * Convert arbitrary imported workflow data into deterministic JSON without
 * retaining plaintext strings.  Workflows are normally JSON, but Maps, Sets,
 * Dates and circular values are handled defensively so an imported bad graph
 * can be fingerprinted instead of crashing the canvas.
 */
const normaliseValue = (value: unknown, context: NormaliseContext): SafeValue => {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
      return { $string: valueDigest(value) };
    case "boolean":
      return value;
    case "number":
      if (Number.isNaN(value)) return { $number: "NaN" };
      if (!Number.isFinite(value)) return { $number: value > 0 ? "Infinity" : "-Infinity" };
      return value;
    case "bigint":
      return { $bigint: valueDigest(value.toString()) };
    case "undefined":
      return { $undefined: true };
    case "symbol":
      return { $symbol: valueDigest(String(value)) };
    case "function":
      return { $function: valueDigest(value.name || "anonymous") };
    default:
      break;
  }

  const objectValue = value as object;
  const seen = context.seen.get(objectValue);
  if (seen !== undefined) return { $ref: seen };
  const referenceId = context.nextReferenceId;
  context.nextReferenceId += 1;
  context.seen.set(objectValue, referenceId);

  if (value instanceof Date) {
    const time = value.getTime();
    return { $date: Number.isNaN(time) ? "invalid" : valueDigest(value.toISOString()) };
  }

  if (Array.isArray(value)) {
    return {
      $id: referenceId,
      $array: value.map((item) => normaliseValue(item, context)),
    };
  }

  if (value instanceof Map) {
    const entries = [...value.entries()]
      .map(([key, entryValue]) => [normaliseValue(key, context), normaliseValue(entryValue, context)] as SafeValue[])
      .sort((left, right) => JSON.stringify(left[0]).localeCompare(JSON.stringify(right[0])));
    return { $id: referenceId, $map: entries };
  }

  if (value instanceof Set) {
    const entries = [...value.values()]
      .map((entryValue) => normaliseValue(entryValue, context))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return { $id: referenceId, $set: entries };
  }

  const result: { [key: string]: SafeValue } = { $id: referenceId };
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    try {
      result[key] = normaliseValue((value as Record<string, unknown>)[key], context);
    } catch {
      // Accessors from an imported object should not make generation unusable.
      result[key] = { $unreadable: true };
    }
  }
  return result;
};

const unknownDigest = (value: unknown) => {
  const normalised = normaliseValue(value, { seen: new WeakMap(), nextReferenceId: 1 });
  return hashText(JSON.stringify(normalised));
};

const optionalStringDigest = (value: string | undefined) =>
  value === undefined ? undefined : valueDigest(value);

const nodeInput = (node: CanvasNode) => {
  const dynamicNode = node as unknown as Record<string, unknown>;
  const extraFields: Record<string, string> = {};
  for (const key of Object.keys(dynamicNode).sort()) {
    if (NON_EXECUTION_NODE_FIELDS.has(key) || KNOWN_EXECUTION_NODE_FIELDS.has(key)) continue;
    extraFields[key] = unknownDigest(dynamicNode[key]);
  }

  return {
    // IDs make topology unambiguous while the final returned value remains a
    // hash, so neither an identifier nor a local file name is exposed.
    id: valueDigest(node.id),
    kind: node.kind,
    text: optionalStringDigest(node.text),
    storyboard: node.storyboard === undefined ? undefined : unknownDigest(node.storyboard),
    src: optionalStringDigest(node.src),
    fileName: optionalStringDigest(node.fileName),
    localPath: optionalStringDigest(node.localPath),
    mediaWidth: node.mediaWidth,
    mediaHeight: node.mediaHeight,
    workflow: node.workflow === undefined ? undefined : unknownDigest(node.workflow),
    onlineProvider: optionalStringDigest(node.onlineProvider),
    ...(Object.keys(extraFields).length ? { extraFields } : {}),
  };
};

const sortLink = (left: GraphLink, right: GraphLink) => {
  const leftKey = [left.to, left.toPort || "", left.from, left.fromPort || ""].join("\u0000");
  const rightKey = [right.to, right.toPort || "", right.from, right.fromPort || ""].join("\u0000");
  return leftKey.localeCompare(rightKey);
};

/**
 * Builds a deterministic, recursive input signature for one target node.
 *
 * Only the target and its incoming transitive dependencies take part.  Links
 * record their real input/output port IDs, allowing a rewire to invalidate a
 * previous result even when the source cards contain identical media.  The
 * traversal uses a visited set, so malformed cycles remain safe to inspect.
 */
export const createExecutionInputSignature = (
  project: CanvasProject,
  nodeId: string,
): ExecutionInputSignature => {
  const nodesById = new Map(project.nodes.map((node) => [node.id, node]));
  const incomingByTarget = new Map<string, GraphLink[]>();
  for (const link of project.links) {
    const incoming = incomingByTarget.get(link.to) || [];
    incoming.push(link);
    incomingByTarget.set(link.to, incoming);
  }

  const visited = new Set<string>();
  const missingNodeIds = new Set<string>();
  const relevantLinks: GraphLink[] = [];
  const visit = (currentId: string) => {
    if (visited.has(currentId)) return;
    visited.add(currentId);

    const current = nodesById.get(currentId);
    if (!current) {
      missingNodeIds.add(currentId);
      return;
    }

    for (const link of [...(incomingByTarget.get(currentId) || [])].sort(sortLink)) {
      relevantLinks.push(link);
      visit(link.from);
    }
  };
  visit(nodeId);

  const nodeInputs = [...visited]
    .map((id) => nodesById.get(id))
    .filter((node): node is CanvasNode => Boolean(node))
    .map(nodeInput)
    .sort((left, right) => left.id.localeCompare(right.id));

  const payload = {
    version: SIGNATURE_VERSION,
    target: valueDigest(nodeId),
    targetExists: nodesById.has(nodeId),
    nodes: nodeInputs,
    missingNodes: [...missingNodeIds].map(valueDigest).sort(),
    links: relevantLinks
      .sort(sortLink)
      .map((link) => ({
        from: valueDigest(link.from),
        to: valueDigest(link.to),
        fromPort: optionalStringDigest(link.fromPort),
        toPort: optionalStringDigest(link.toPort),
      })),
  };

  return `${SIGNATURE_VERSION}:${hashText(JSON.stringify(payload))}`;
};

/** Alias kept readable at canvas call sites. */
export const getExecutionInputSignature = createExecutionInputSignature;
