export type PortDataKind = "text" | "image" | "video" | "audio" | "latent" | "workflow" | "any";

export type PortDirection = "input" | "output";

export interface PortSpec {
  id: string;
  label: string;
  kind: PortDataKind;
  direction: PortDirection;
  required?: boolean;
  multiple?: boolean;
  description?: string;
}

export interface GraphLink {
  id: string;
  from: string;
  to: string;
  fromPort?: string;
  toPort?: string;
}

export interface GraphValidationIssue {
  id: string;
  nodeId: string;
  portId?: string;
  severity: "error" | "warning";
  code:
    | "missing-input"
    | "type-mismatch"
    | "missing-model"
    | "disconnected-output"
    | "provider-offline"
    | "invalid-configuration";
  message: string;
  suggestion?: string;
}

export const canConnectPortKinds = (source: PortDataKind, target: PortDataKind) =>
  source === "any" || target === "any" || source === target;
