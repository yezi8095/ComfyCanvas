import type { AssetRef } from "../assets/types";
import type { GraphValidationIssue } from "../graph/types";

export type JobStatus = "idle" | "validating" | "queued" | "running" | "cancelling" | "cancelled" | "failed" | "completed";

export interface CostEstimate {
  input: number;
  output: number;
  total: number;
  currency: "points" | "provider" | "free";
  detail: string;
}

export interface ExecutionRequest {
  nodeId: string;
  projectId: string;
  providerId: string;
  modelId?: string;
  inputs: Record<string, unknown>;
  parameters: Record<string, unknown>;
}

export interface ExecutionJob {
  id: string;
  request: ExecutionRequest;
  status: JobStatus;
  progress?: number;
  message?: string;
  startedAt?: number;
  completedAt?: number;
  results?: AssetRef[];
  issues?: GraphValidationIssue[];
}

export interface ExecutionAdapter {
  readonly id: string;
  validate(request: ExecutionRequest): Promise<GraphValidationIssue[]> | GraphValidationIssue[];
  estimate(request: ExecutionRequest): Promise<CostEstimate> | CostEstimate;
  submit(request: ExecutionRequest): Promise<ExecutionJob>;
  poll(job: ExecutionJob): Promise<ExecutionJob>;
  cancel(job: ExecutionJob): Promise<void>;
  collect(job: ExecutionJob): Promise<AssetRef[]>;
}
