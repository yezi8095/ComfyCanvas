import type { GraphLink } from "../graph/types";
import type { CanvasNodeKind } from "../nodes/types";

export type GenerationSource = "comfy" | "byok" | "cloud";

export interface StoryboardRow {
  shot: string;
  visual: string;
  dialogue: string;
  imageId?: string;
}

export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
  text?: string;
  storyboard?: StoryboardRow[];
  src?: string;
  /** Live provider preview retained as a recovery route for generated media. */
  fallbackSrc?: string;
  /** Avoid retrying the same failed preview address on every render. */
  mediaFallbackTried?: boolean;
  fileName?: string;
  localPath?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  workflow?: unknown;
  onlineProvider?: string;
  status?: string;
  createdAt?: number;
  rotation?: number;
  locked?: boolean;
  mirrored?: boolean;
  pointerId?: string;
  annotationId?: string;
  fontSize?: number;
  validationErrors?: string[];
}

export interface NodeGroup {
  id: string;
  name: string;
  nodeIds: string[];
  bounds: { x: number; y: number; w: number; h: number };
}

export interface CanvasProject {
  nodes: CanvasNode[];
  links: GraphLink[];
  view: { x: number; y: number; zoom: number };
  groups?: NodeGroup[];
  schemaVersion?: number;
}

export interface ProjectHistoryRecord {
  id: string;
  name: string;
  updatedAt: number;
  project: CanvasProject;
}
