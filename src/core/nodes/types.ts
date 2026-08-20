import type { PortSpec } from "../graph/types";

export type CanvasNodeKind =
  | "image"
  | "video"
  | "audio"
  | "text"
  | "storyboard"
  | "api"
  | "batch"
  | "aiText"
  | "aiImage"
  | "onlineVideo"
  | "annotation"
  | "annotationPointer";

export interface NodeControlSpec {
  id: string;
  label: string;
  type: "text" | "textarea" | "number" | "boolean" | "select" | "range" | "asset";
  description?: string;
  options?: Array<{ label: string; value: string }>;
  defaultValue?: unknown;
}

export interface NodeDefinition {
  type: CanvasNodeKind;
  version: number;
  label: string;
  description: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  basicControls: NodeControlSpec[];
  advancedControls: NodeControlSpec[];
}
