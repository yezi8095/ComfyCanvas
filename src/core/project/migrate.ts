import type { CanvasNode, CanvasProject } from "./types";
import { upgradeLegacyLinks } from "../graph/validation";

export const CURRENT_PROJECT_SCHEMA = 3;

export const annotationMetrics = (text: string | undefined, requestedWidth: number, requestedFontSize = 19) => {
  const width = Math.max(140, Math.min(620, requestedWidth));
  const fontSize = Math.max(12, Math.min(48, Math.round(requestedFontSize)));
  const charsPerLine = Math.max(5, Math.floor((width - 12) / (fontSize * .98)));
  const rows = (text || "情绪转折点。\n冷静的表象下是汹涌的告别。")
    .split("\n")
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
  return { width, height: Math.max(82, Math.min(420, Math.ceil(rows * fontSize * 1.72 + 28))), fontSize };
};

const normalizeAnnotations = (project: CanvasProject): CanvasProject => {
  const pointerIds = new Set(project.nodes.filter((node) => node.kind === "annotationPointer").map((node) => node.id));
  const addedPointers: CanvasNode[] = [];
  const nodes = project.nodes.map((node) => {
    if (node.kind === "annotationPointer") {
      const width = Math.max(32, Math.min(120, node.width));
      const ratio = node.width > 0 ? node.height / node.width : 1;
      return { ...node, width, height: Math.max(32, Math.round(width * ratio)) };
    }
    if (node.kind !== "annotation") return node;
    const fontSize = node.fontSize ?? 19;
    const { width, height } = annotationMetrics(node.text, node.width, fontSize);
    if (node.pointerId && pointerIds.has(node.pointerId)) return { ...node, width, height, fontSize };

    // A migration must be idempotent.  A deterministic ID prevents the main
    // project and its history snapshot from receiving different pointers.
    const pointerId = `annotation-pointer-${node.id}`;
    if (!pointerIds.has(pointerId)) {
      pointerIds.add(pointerId);
      addedPointers.push({
        id: pointerId,
        kind: "annotationPointer",
        x: node.x + width - 18,
        y: node.y + height - 20,
        width: 58,
        height: 58,
        name: "批注指向",
        rotation: node.rotation || 0,
        mirrored: node.mirrored,
        annotationId: node.id,
        createdAt: node.createdAt || 0,
      });
    }
    return { ...node, width, height, fontSize, pointerId, mirrored: undefined };
  });
  return addedPointers.length ? { ...project, nodes: [...nodes, ...addedPointers] } : { ...project, nodes };
};

const migrateLegacyVideoOutputs = (project: CanvasProject): CanvasProject => {
  const outputs: CanvasNode[] = [];
  const nodes = project.nodes.map((node) => {
    if (node.kind !== "onlineVideo" || !node.src) {
      return node.kind === "onlineVideo" && node.width > 400
        ? { ...node, width: 360, height: 240, name: node.name === "可选节点" ? "AI 视频生成" : node.name }
        : node;
    }
    const outputId = `video-output-${node.id}`;
    outputs.push({
      id: outputId,
      kind: "video",
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      name: node.name,
      fileName: node.fileName,
      src: node.src,
      localPath: node.localPath,
      mediaWidth: node.mediaWidth,
      mediaHeight: node.mediaHeight,
      createdAt: node.createdAt,
    });
    const {
      src: _src,
      fileName: _fileName,
      localPath: _localPath,
      mediaWidth: _mediaWidth,
      mediaHeight: _mediaHeight,
      createdAt: _createdAt,
      ...generator
    } = node;
    return { ...generator, y: node.y + node.height + 70, width: 360, height: 240, name: "AI 视频生成", status: "done" };
  });
  const outputLinks = outputs
    .filter((output) => !project.links.some((link) => link.from === output.id.replace(/^video-output-/, "") && link.to === output.id))
    .map((output) => ({ id: `legacy-video-link-${output.id}`, from: output.id.replace(/^video-output-/, ""), to: output.id }));
  return { ...project, nodes: [...nodes, ...outputs], links: [...project.links, ...outputLinks] };
};

const mediaKindFromFilename = (name?: string): "image" | "video" | "audio" | null => {
  const value = (name || "").toLowerCase().split("?")[0];
  if (/\.(mp3|wav|m4a|aac|flac|ogg|opus|wma)$/i.test(value)) return "audio";
  if (/\.(mp4|mov|mkv|avi|webm|m4v|wmv)$/i.test(value)) return "video";
  if (/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(value)) return "image";
  return null;
};

/**
 * Some custom Comfy savers report an MP4 in the `images` history group. Older
 * app versions therefore persisted a canvas image node whose source was an
 * MP4, producing the broken-image icon visible after a successful run. Repair
 * that persisted shape every time a project is opened.
 */
const normalizeMediaKinds = (project: CanvasProject): CanvasProject => ({
  ...project,
  nodes: project.nodes.map((node) => {
    if (node.kind !== "image" && node.kind !== "video" && node.kind !== "audio") return node;
    const inferred = mediaKindFromFilename(node.fileName || node.name);
    return inferred && inferred !== node.kind ? { ...node, kind: inferred } : node;
  }),
});

export interface NormalizeProjectOptions {
  /** Reset process-only states when restoring a project from persistence. */
  resetTransient?: boolean;
}

export const normalizeProject = (
  input: CanvasProject,
  { resetTransient = true }: NormalizeProjectOptions = {},
): CanvasProject => {
  const sourceSchema = Number.isFinite(input.schemaVersion) ? Number(input.schemaVersion) : 0;
  const inputZoom = input.view && Number.isFinite(input.view.zoom) ? input.view.zoom : 1;
  // Older releases could persist a nearly invisible canvas after a viewport
  // regression. This is deliberately version-gated so a schema-3 user may
  // still choose a zoom below 45% without it being overwritten on every load.
  const migratedZoom = sourceSchema < 3 && inputZoom < .45 ? .65 : inputZoom;
  const base: CanvasProject = {
    nodes: Array.isArray(input.nodes) ? input.nodes : [],
    links: Array.isArray(input.links) ? input.links : [],
    view: input.view && Number.isFinite(input.view.zoom)
      ? { x: Number(input.view.x) || 0, y: Number(input.view.y) || 0, zoom: Math.max(.08, Math.min(4, migratedZoom)) }
      : { x: 0, y: 0, zoom: 1 },
    groups: Array.isArray(input.groups) ? input.groups : [],
    schemaVersion: CURRENT_PROJECT_SCHEMA,
  };
  const migrated = upgradeLegacyLinks(normalizeMediaKinds(normalizeAnnotations(migrateLegacyVideoOutputs(base)))).project;
  const nodeIds = new Set(migrated.nodes.map((node) => node.id));
  const seenLinks = new Set<string>();
  return {
    ...migrated,
    nodes: resetTransient
      ? migrated.nodes.map((node) => ["running", "stopping"].includes(node.status || "") ? { ...node, status: "idle" } : node)
      : migrated.nodes,
    links: migrated.links.filter((link) => {
      const identity = `${link.from}:${link.fromPort || ""}->${link.to}:${link.toPort || ""}`;
      if (!nodeIds.has(link.from) || !nodeIds.has(link.to) || seenLinks.has(identity)) return false;
      seenLinks.add(identity);
      return true;
    }),
    groups: (migrated.groups || [])
      .map((group) => {
        const seenNodeIds = new Set<string>();
        return {
          ...group,
          nodeIds: group.nodeIds.filter((id) => {
            if (!nodeIds.has(id) || seenNodeIds.has(id)) return false;
            seenNodeIds.add(id);
            return true;
          }),
        };
      })
      .filter((group) => group.nodeIds.length >= 2),
  };
};
