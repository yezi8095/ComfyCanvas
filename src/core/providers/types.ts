export type ModelCapability = "text" | "image" | "video";
export type ProviderProtocol = "openai" | "gemini" | "ollama" | "dashscope" | "kling" | "volcengine";
export type VideoGenerationMode = "text" | "image" | "firstLast" | "reference";

export interface ProviderModel {
  id: string;
  kind: ModelCapability | "unknown";
  /** A model may expose more than one output capability. `kind` remains the
   * primary capability for older saved configurations. */
  capabilities?: ModelCapability[];
  modes?: VideoGenerationMode[];
  purpose: string;
}

export interface ProviderConfig {
  endpoint: string;
  apiKey: string;
  apiSecret?: string;
  klingAuth?: "apiKey" | "aksk";
  model: string;
  protocol?: ProviderProtocol;
  capabilities?: ModelCapability[];
  custom?: boolean;
  detectedModels?: ProviderModel[];
  /** One optional default per node type. The legacy `model` field remains for
   * old projects and adapters that only expose a single model. */
  defaultModels?: Partial<Record<ModelCapability, string>>;
}

export type ProviderConfigs = Record<string, ProviderConfig>;

export interface ProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ModelCapability[];
  discoverModels(config: ProviderConfig): Promise<ProviderModel[]>;
  test(config: ProviderConfig): Promise<{ ok: boolean; message: string }>;
}
