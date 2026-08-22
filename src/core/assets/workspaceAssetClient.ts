/**
 * Small frontend boundary for the desktop media store.
 *
 * This module deliberately never converts an entire File into a data URL and
 * never falls back to localStorage.  The Rust side owns durable file storage;
 * this client only streams one bounded Blob slice at a time through Tauri.
 */

export const DEFAULT_WORKSPACE_ASSET_CHUNK_BYTES = 1024 * 1024;

export type WorkspaceAssetCommand =
  | "begin_workspace_asset"
  | "append_workspace_asset_chunk"
  | "commit_workspace_asset"
  | "abort_workspace_asset"
  | "import_workspace_asset_from_path"
  | "cache_comfy_output_media"
  | "list_workspace_assets"
  | "delete_workspace_asset";

export type WorkspaceAssetInvoker = (
  command: WorkspaceAssetCommand,
  arguments_: Record<string, unknown>,
) => Promise<unknown>;

export type WorkspaceAssetChunkReader = (chunk: Blob) => Promise<string>;

/** The durable descriptor returned by the Rust media store after commit. */
export interface ManagedWorkspaceAsset {
  projectId: string;
  assetId: string;
  /** Absolute local path is intentionally optional while older backends roll out. */
  localPath?: string;
  fileName: string;
  mimeType: string;
  size: number;
}

/** Exact DTOs returned by the current Rust workspace-media commands. */
export interface BeginWorkspaceAssetResponse {
  uploadId: string;
  projectId: string;
  assetId: string;
  fileName: string;
  mimeType: string;
  expectedBytes: number;
  bytesWritten: number;
  maxBytes: number;
}

export interface AppendWorkspaceAssetChunkResponse {
  uploadId: string;
  bytesWritten: number;
  expectedBytes: number;
}

export interface CommitWorkspaceAssetResponse {
  projectId: string;
  assetId: string;
  fileName: string;
  mimeType: string;
  bytes: number;
  localPath: string;
}

export interface AbortWorkspaceAssetResponse {
  uploadId: string;
  aborted: boolean;
}

export interface DeleteWorkspaceAssetResponse {
  projectId: string;
  assetId: string;
  deleted: boolean;
}

export interface WorkspaceAssetCommandOptions {
  /** Override only for tests or an explicitly supplied desktop bridge. */
  invoke?: WorkspaceAssetInvoker;
}

export interface UploadWorkspaceAssetRequest {
  /** The project that owns the asset in the desktop media store. */
  projectId: string;
  /** Caller-created stable id. Path separators and traversal are rejected. */
  assetId: string;
  /** A File or Blob. It is read one slice at a time, never as a whole data URL. */
  file: Blob;
  /** Required for a plain Blob; a File's name is used otherwise. */
  fileName?: string;
  mimeType?: string;
  /** Defaults to 1 MiB. Kept injectable for tests and constrained in production. */
  chunkBytes?: number;
}

export interface UploadWorkspaceAssetOptions {
  /** Override only for tests or an explicitly supplied desktop bridge. */
  invoke?: WorkspaceAssetInvoker;
  /** Override only for tests; production uses a chunk-only Blob reader. */
  readChunkAsBase64?: WorkspaceAssetChunkReader;
}

export interface CacheComfyOutputMediaRequest {
  endpoint: string;
  filename: string;
  subfolder?: string;
  projectId: string;
  assetId: string;
}

export interface ImportWorkspaceAssetFromPathRequest {
  projectId: string;
  assetId: string;
  sourcePath: string;
  fileName: string;
  mimeType?: string;
}

export type WorkspaceAssetUploadStage = "validate" | "begin" | "read" | "append" | "commit";

export class WorkspaceAssetUploadError extends Error {
  readonly stage: WorkspaceAssetUploadStage;
  readonly cause: unknown;
  readonly abortError?: unknown;

  constructor(
    stage: WorkspaceAssetUploadStage,
    cause: unknown,
    abortError?: unknown,
  ) {
    super(`桌面媒体上传${uploadStageLabel(stage)}失败：${errorMessage(cause)}`);
    this.name = "WorkspaceAssetUploadError";
    this.stage = stage;
    this.cause = cause;
    this.abortError = abortError;
  }
}

export class DesktopMediaStoreUnavailableError extends Error {
  constructor() {
    super("桌面媒体仓储只在桌面版可用");
    this.name = "DesktopMediaStoreUnavailableError";
  }
}

type UploadFallback = Omit<ManagedWorkspaceAsset, "localPath">;
type UnknownRecord = Record<string, unknown>;

const SAFE_ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

const isRecord = (value: unknown): value is UnknownRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const readAliasedString = (record: UnknownRecord, aliases: readonly string[]): string | undefined => {
  for (const alias of aliases) {
    const value = asNonEmptyString(record[alias]);
    if (value) return value;
  }
  return undefined;
};

const readNonNegativeNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
};

const unwrapAssetResponse = (value: unknown): UnknownRecord => {
  if (!isRecord(value)) return {};
  // Rust command responses have used direct records, { asset }, and { data }.
  // Only descend into a record with useful fields, so a wrapper cannot erase a
  // valid direct response.
  for (const key of ["asset", "data", "result"]) {
    const nested = value[key];
    if (!isRecord(nested)) continue;
    if (readAliasedString(nested, ["assetId", "asset_id", "localPath", "local_path", "path"])) {
      return nested;
    }
  }
  return value;
};

/**
 * Accept snake_case/camelCase response variants while never trusting an
 * incomplete backend response more than the caller's upload metadata.
 */
export const normalizeManagedWorkspaceAsset = (
  response: unknown,
  fallback: UploadFallback,
): ManagedWorkspaceAsset => {
  const value = unwrapAssetResponse(response);
  const localPath = readAliasedString(value, ["localPath", "local_path", "path"]);
  const fileName = readAliasedString(value, ["fileName", "file_name", "filename", "name"]) || fallback.fileName;
  const mimeType = readAliasedString(value, ["mimeType", "mime_type", "mime"]) || fallback.mimeType;
  const projectId = readAliasedString(value, ["projectId", "project_id"]) || fallback.projectId;
  const assetId = readAliasedString(value, ["assetId", "asset_id"]) || fallback.assetId;
  const size = readNonNegativeNumber(value.size ?? value.totalBytes ?? value.total_bytes ?? value.bytes) ?? fallback.size;

  return {
    projectId,
    assetId,
    ...(localPath ? { localPath } : {}),
    fileName,
    mimeType,
    size,
  };
};

const normalizeUploadId = (response: unknown): string => {
  const stringResponse = asNonEmptyString(response);
  if (stringResponse) return stringResponse.trim();
  if (!isRecord(response)) throw new Error("桌面媒体仓储没有返回上传编号");

  const direct = readAliasedString(response, ["uploadId", "upload_id"]);
  if (direct) return direct;
  for (const key of ["data", "result"]) {
    const nested = response[key];
    if (!isRecord(nested)) continue;
    const value = readAliasedString(nested, ["uploadId", "upload_id"]);
    if (value) return value;
  }
  throw new Error("桌面媒体仓储没有返回上传编号");
};

const normalizeFileName = (input: UploadWorkspaceAssetRequest): string => {
  const possibleFile = input.file as Blob & { name?: unknown };
  const fileName = asNonEmptyString(input.fileName) || asNonEmptyString(possibleFile.name) || "asset.bin";
  if (/[/\\\0]/.test(fileName)) {
    throw new Error("文件名不能包含路径分隔符");
  }
  return fileName;
};

const normalizeChunkBytes = (value: number | undefined): number => {
  const chunkBytes = value ?? DEFAULT_WORKSPACE_ASSET_CHUNK_BYTES;
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > MAX_CHUNK_BYTES) {
    throw new Error(`分块大小必须是 1 到 ${MAX_CHUNK_BYTES} 字节之间的整数`);
  }
  return chunkBytes;
};

const validateRequest = (input: UploadWorkspaceAssetRequest) => {
  if (!SAFE_ASSET_ID.test(input.projectId)) {
    throw new Error("项目编号只能使用字母、数字、短横线和下划线，且不能以符号开头");
  }
  if (!SAFE_ASSET_ID.test(input.assetId)) {
    throw new Error("素材编号只能使用字母、数字、短横线和下划线，且不能以符号开头");
  }
  if (!(input.file instanceof Blob)) throw new Error("请选择有效的文件或 Blob 素材");
  const fileName = normalizeFileName(input);
  const chunkBytes = normalizeChunkBytes(input.chunkBytes);
  const mimeType = asNonEmptyString(input.mimeType) || input.file.type || "application/octet-stream";
  return { fileName, chunkBytes, mimeType };
};

const validateManagedAssetIdentity = (projectId: string, assetId?: string) => {
  if (!SAFE_ASSET_ID.test(projectId)) {
    throw new Error("项目编号只能使用字母、数字、短横线和下划线，且不能以符号开头");
  }
  if (assetId !== undefined && !SAFE_ASSET_ID.test(assetId)) {
    throw new Error("素材编号只能使用字母、数字、短横线和下划线，且不能以符号开头");
  }
};

const uploadStageLabel = (stage: WorkspaceAssetUploadStage) => ({
  validate: "校验",
  begin: "初始化",
  read: "读取分块",
  append: "写入分块",
  commit: "提交",
})[stage];

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error || "未知错误");

const stripDataUrlPrefix = (value: string) => {
  const marker = value.indexOf("base64,");
  return marker >= 0 && /^data:/i.test(value) ? value.slice(marker + "base64,".length) : value;
};

/**
 * Browser-compatible base64 encoder that materializes only the supplied Blob
 * slice.  A 1 MiB upload chunk therefore never creates a full-file data URL.
 */
export const readBlobChunkAsBase64: WorkspaceAssetChunkReader = async (chunk) => {
  const bytes = new Uint8Array(await chunk.arrayBuffer());
  let binary = "";
  const blockSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize));
  }
  if (typeof btoa !== "function") {
    throw new Error("当前运行环境不支持分块 Base64 编码");
  }
  return btoa(binary);
};

const isTauriDesktopRuntime = () => {
  if (typeof window === "undefined") return false;
  const candidate = window as Window & { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown };
  return !!(candidate.__TAURI__ || candidate.__TAURI_INTERNALS__);
};

/**
 * Default bridge. The dynamic import stays inside this function so ordinary
 * browser builds do not claim to have a persistent media store.
 */
export const invokeDesktopWorkspaceAsset: WorkspaceAssetInvoker = async (command, arguments_) => {
  if (!isTauriDesktopRuntime()) throw new DesktopMediaStoreUnavailableError();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(command, arguments_);
};

const abortQuietly = async (invoke: WorkspaceAssetInvoker, uploadId: string): Promise<unknown | undefined> => {
  try {
    await invoke("abort_workspace_asset", { uploadId });
    return undefined;
  } catch (error) {
    return error;
  }
};

/**
 * Stream one asset into the Rust workspace store.  Any failure after `begin`
 * attempts `abort` exactly once; the primary error remains visible to callers.
 */
export const uploadWorkspaceAsset = async (
  input: UploadWorkspaceAssetRequest,
  options: UploadWorkspaceAssetOptions = {},
): Promise<ManagedWorkspaceAsset> => {
  let normalized: { fileName: string; chunkBytes: number; mimeType: string };
  try {
    normalized = validateRequest(input);
  } catch (error) {
    throw new WorkspaceAssetUploadError("validate", error);
  }

  const invoke = options.invoke || invokeDesktopWorkspaceAsset;
  const readChunkAsBase64 = options.readChunkAsBase64 || readBlobChunkAsBase64;
  const fallback: UploadFallback = {
    projectId: input.projectId,
    assetId: input.assetId,
    fileName: normalized.fileName,
    mimeType: normalized.mimeType,
    size: input.file.size,
  };

  let uploadId: string;
  try {
    const began = await invoke("begin_workspace_asset", {
      projectId: input.projectId,
      assetId: input.assetId,
      filename: normalized.fileName,
      mimeType: normalized.mimeType,
      totalBytes: input.file.size,
    });
    uploadId = normalizeUploadId(began);
  } catch (error) {
    throw new WorkspaceAssetUploadError("begin", error);
  }

  const failAfterBegin = async (stage: Extract<WorkspaceAssetUploadStage, "read" | "append" | "commit">, error: unknown): Promise<never> => {
    const abortError = await abortQuietly(invoke, uploadId);
    throw new WorkspaceAssetUploadError(stage, error, abortError);
  };

  for (let offset = 0; offset < input.file.size; offset += normalized.chunkBytes) {
    const chunk = input.file.slice(offset, Math.min(input.file.size, offset + normalized.chunkBytes));
    let base64Chunk: string;
    try {
      base64Chunk = stripDataUrlPrefix(await readChunkAsBase64(chunk));
      if (!base64Chunk) throw new Error("分块编码为空");
    } catch (error) {
      return failAfterBegin("read", error);
    }

    try {
      await invoke("append_workspace_asset_chunk", { uploadId, base64Chunk });
    } catch (error) {
      return failAfterBegin("append", error);
    }
  }

  try {
    const committed = await invoke("commit_workspace_asset", { uploadId });
    return normalizeManagedWorkspaceAsset(committed, fallback);
  } catch (error) {
    return failAfterBegin("commit", error);
  }
};

/**
 * Import a file path emitted by Tauri's native drop event without routing a
 * large video through WebView memory. The Rust side accepts only exact paths
 * that Tauri authorized for this user drop.
 */
export const importWorkspaceAssetFromPath = async (
  input: ImportWorkspaceAssetFromPathRequest,
  options: WorkspaceAssetCommandOptions = {},
): Promise<ManagedWorkspaceAsset> => {
  validateManagedAssetIdentity(input.projectId, input.assetId);
  const sourcePath = input.sourcePath.trim();
  if (!sourcePath) throw new Error("拖入素材路径不能为空");
  const fileName = input.fileName.trim();
  if (!fileName || /[/\\\0]/.test(fileName)) throw new Error("拖入素材文件名无效");
  const mimeType = input.mimeType?.trim() || "application/octet-stream";
  const invoke = options.invoke || invokeDesktopWorkspaceAsset;
  const response = await invoke("import_workspace_asset_from_path", {
    projectId: input.projectId,
    assetId: input.assetId,
    filename: fileName,
    mimeType,
    sourcePath,
  });
  const asset = normalizeManagedWorkspaceAsset(response, {
    projectId: input.projectId,
    assetId: input.assetId,
    fileName,
    mimeType,
    size: 0,
  });
  if (!asset.localPath) throw new Error("桌面媒体仓储没有返回拖入素材路径");
  return asset;
};

/**
 * Ask the Rust backend to download a durable ComfyUI output directly into the
 * managed store. This avoids WebView CORS/Origin rejection and never moves a
 * potentially large generated video through renderer IPC.
 */
export const cacheComfyOutputMedia = async (
  input: CacheComfyOutputMediaRequest,
  options: WorkspaceAssetCommandOptions = {},
): Promise<ManagedWorkspaceAsset> => {
  validateManagedAssetIdentity(input.projectId, input.assetId);
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    throw new Error("ComfyUI 接口地址无效");
  }
  if (!(["http:", "https:"] as const).includes(endpoint.protocol as "http:" | "https:")) {
    throw new Error("ComfyUI 接口地址只支持 http:// 或 https://");
  }
  const filename = input.filename.trim();
  if (!filename || filename.length > 260 || /[/\\\0]/.test(filename)) {
    throw new Error("ComfyUI 输出文件名无效");
  }
  const subfolder = (input.subfolder || "").trim();
  if (subfolder.length > 520 || /[\\:\0]/.test(subfolder) || subfolder.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("ComfyUI 输出子目录无效");
  }
  const invoke = options.invoke || invokeDesktopWorkspaceAsset;
  const response = await invoke("cache_comfy_output_media", {
    endpoint: endpoint.toString().replace(/\/$/, ""),
    filename,
    subfolder,
    projectId: input.projectId,
    assetId: input.assetId,
  });
  const asset = normalizeManagedWorkspaceAsset(response, {
    projectId: input.projectId,
    assetId: input.assetId,
    fileName: filename,
    mimeType: "application/octet-stream",
    size: 0,
  });
  if (!asset.localPath) throw new Error("桌面媒体仓储没有返回 ComfyUI 缓存路径");
  return asset;
};

/**
 * List only files owned by one exact managed-workspace project. The backend
 * never accepts a directory path from the renderer, so this cannot enumerate
 * arbitrary user folders.
 */
export const listWorkspaceAssets = async (
  projectId: string,
  options: WorkspaceAssetCommandOptions = {},
): Promise<ManagedWorkspaceAsset[]> => {
  validateManagedAssetIdentity(projectId);
  const invoke = options.invoke || invokeDesktopWorkspaceAsset;
  const response = await invoke("list_workspace_assets", { projectId });
  if (!Array.isArray(response)) throw new Error("桌面媒体仓储返回了无效的素材列表");
  return response.map((item) => normalizeManagedWorkspaceAsset(item, {
    projectId,
    assetId: "unknown",
    fileName: "asset.bin",
    mimeType: "application/octet-stream",
    size: 0,
  })).filter((item) => item.projectId === projectId && item.assetId !== "unknown");
};

/**
 * Remove exactly one app-managed asset. This function deliberately has no
 * project-wide or directory-delete mode. Callers must first establish that a
 * just-uploaded asset was never attached to live project state.
 */
export const deleteWorkspaceAsset = async (
  projectId: string,
  assetId: string,
  options: WorkspaceAssetCommandOptions = {},
): Promise<boolean> => {
  validateManagedAssetIdentity(projectId, assetId);
  const invoke = options.invoke || invokeDesktopWorkspaceAsset;
  const response = await invoke("delete_workspace_asset", { projectId, assetId });
  if (typeof response === "boolean") return response;
  if (!isRecord(response)) throw new Error("桌面媒体仓储返回了无效的删除结果");
  return response.deleted === true;
};
