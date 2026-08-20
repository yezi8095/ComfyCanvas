export type AssetKind = "image" | "video" | "audio" | "text";

export interface AssetRef {
  id: string;
  kind: AssetKind;
  name: string;
  src?: string;
  localPath?: string;
  width?: number;
  height?: number;
  duration?: number;
  createdAt: number;
  sourceNodeId?: string;
  metadata?: Record<string, string | number | boolean>;
}
