import {
  ChangeEvent,
  PointerEvent,
  WheelEvent,
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import MediaLibrary from "./MediaLibrary";
import DirectorMode from "./DirectorMode";
import CloudPointsCenter from "./CloudPointsCenter";
import { AI_IMAGE_PROVIDER_PRESETS, AI_TEXT_PROVIDER_PRESETS, AiGenerationComposer, AiGenerationNodeView, type AiImageSettings, type AiProviderOption, type AiReferenceImage, type AiTextSettings } from "./AiGenerationNodes";
import WorkflowLibrary from "./WorkflowLibrary";
import { applyComfyParameters, bindCanvasInputsToComfyWorkflow, comfyParameterHelp, COMFY_WORKFLOW_STORE, isBasicComfyParameter, prepareComfyVisualOutput, readComfyWorkflowLibrary, scanComfyParameters, selectComfyHistoryMedia, validateComfyWorkflow, type ComfyHistoryOutputs, type ComfyParameter, type ComfyWorkflowDiagnostic, type ComfyWorkflowInterface } from "./ComfyWorkflowParameters";
import { CLOUD_VIDEO_MODE_LABELS, cloudModelsFor, cloudPlatformsFor, defaultCloudModel, estimateCloudPoints, supportsCloudVideoMode, type CloudVideoMode } from "./CloudModelCatalog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import defaultRainPlatform from "./assets/default-rain-platform.png";
import defaultRooftopOutput from "./assets/default-rooftop-output.png";
import defaultPaperboatOutput from "./assets/default-paperboat-output.png";
import type { GraphLink as Link } from "./core/graph/types";
import type { CanvasNodeKind as Kind } from "./core/nodes/types";
import type {
  ModelCapability,
  ProviderConfig as OnlineProviderConfig,
  ProviderConfigs as OnlineProviderConfigs,
  ProviderModel as DetectedProviderModel,
  ProviderProtocol,
} from "./core/providers/types";
import {
  imageCapabilitiesFor,
  imageRequestSizeFor,
  normalizeImageGenerationOptions,
  validateImageGenerationOptions,
  type ImageAspectRatio,
  type ImageQuality,
  type ImageResolution,
} from "./core/providers/imageCapabilities";
import { chooseCompatibleModel } from "./core/providers/modelSelection";
import {
  createStoryboardFramePlan,
  normalizeStoryboardFramePlans,
  parseGeneratedStoryboard,
  storyboardGenerationSystemPrompt,
} from "./core/storyboard/generation";
import {
  normalizeVideoGenerationOptions,
  supportsVideoAudio,
  validateVideoGenerationInput,
  videoCapabilitiesFor,
  videoInputLimitForMode,
  videoModeLabel,
  videoQualitiesFor,
  type VideoGenerationMode,
} from "./core/providers/videoCapabilities";
import type {
  ApiGenerationRecord,
  CanvasNode as NodeItem,
  CanvasProject as Project,
  GenerationSource,
  NodeGroup,
  ProjectHistoryRecord as HistoryProject,
  StoryboardRow,
} from "./core/project/types";
import { annotationMetrics, normalizeProject } from "./core/project/migrate";
import { deleteNodes } from "./core/project/commands";
import { redactProjectSecrets } from "./core/project/export";
import {
  classifyProjectJson,
  projectImportKindMessage,
} from "./core/project/importFormat";
import {
  analyzeProjectPortability,
  createProjectPortabilityManifest,
} from "./core/project/portability";
import { mergeImportedComfyWorkflows } from "./core/project/comfyWorkflowImport";
import { validateNewLink, type NewLinkOptions } from "./core/graph/validation";
import {
  loadProjectWorkspace,
  removeDeletedProjectStorage,
  saveProjectIndex,
  saveProjectWorkspace,
  type ProjectWorkspaceSnapshot,
} from "./core/project/repository";
import {
  AUTOSAVE_MINUTES_STORE,
  DEFAULT_AUTOSAVE_MINUTES,
  MAX_AUTOSAVE_MINUTES,
  MIN_AUTOSAVE_MINUTES,
  normalizeAutosaveMinutes,
} from "./core/project/autosave";
import {
  planExecution,
  type ExecutionPlanIssue,
} from "./core/execution/plan";
import {
  createRunRegistry,
  type RunToken,
} from "./core/execution/runRegistry";
import { createExecutionInputSignature } from "./core/execution/inputSignature";
import {
  cacheComfyOutputMedia,
  importWorkspaceAssetFromPath,
  uploadWorkspaceAsset,
  type ManagedWorkspaceAsset,
} from "./core/assets/workspaceAssetClient";
import { cleanupUnattachedWorkspaceAsset } from "./core/assets/workspaceAssetLifecycle";
import {
  applyLegacyMediaMigration,
  canApplyLegacyMediaMigration,
  legacyDataUrlToBlob,
  planLegacyMediaMigration,
} from "./core/assets/legacyMediaMigration";
type ComfyCanvasWorkflow = {
  __ymComfyPackage: true;
  libraryId?: string;
  content: unknown;
  parameters: ComfyParameter[];
  values: Record<string, string | number | boolean>;
  interface?: ComfyWorkflowInterface;
};
const isComfyCanvasWorkflow = (value: unknown): value is ComfyCanvasWorkflow => Boolean(value && typeof value === "object" && (value as Record<string, unknown>).__ymComfyPackage === true);
const referencedComfyWorkflowIds = (canvas: Project) => {
  const ids = new Set<string>();
  canvas.nodes.forEach((node) => {
    if (isComfyCanvasWorkflow(node.workflow) && node.workflow.libraryId) {
      ids.add(node.workflow.libraryId);
      return;
    }
    if (node.workflow && typeof node.workflow === "object" && !Array.isArray(node.workflow)) {
      const workflowId = (node.workflow as { comfyWorkflowId?: unknown }).comfyWorkflowId;
      if (typeof workflowId === "string" && workflowId.trim()) ids.add(workflowId);
    }
  });
  return ids;
};
type OnlineVideoSettings = {
  source?: GenerationSource;
  provider?: string;
  model?: string;
  /** False/omitted follows the provider's saved default model. */
  modelPinned?: boolean;
  mode?: "text" | "image" | "firstLast" | "reference";
  prompt?: string;
  ratio?: string;
  quality?: string;
  duration?: number;
  amount?: number;
  audio?: boolean;
  references?: OnlineReference[];
  comfyWorkflowId?: string;
  comfyValues?: Record<string, string | number | boolean>;
};
type OnlineReference = {
  id: string;
  name: string;
  kind: "image" | "video";
  src: string;
  /** Desktop-managed inputs keep their binary outside the project JSON. */
  localPath?: string;
  source: "external" | "generated";
};
type McpToolInfo = { name: string; description?: string };
type McpServerConfig = { id: string; name: string; endpoint: string; token: string; enabled: boolean; tools: McpToolInfo[]; lastStatus?: string };
type CloudSettings = { endpoint: string; accessToken: string; accountLabel: string };
const ONLINE_PROVIDER_STORE = "ym-online-provider-configs-v1";
const CATEGORY_PROVIDER_STORE = "ym-online-provider-configs-by-node-v1";
const MCP_SERVER_STORE = "ym-mcp-server-configs-v1";
const CLOUD_STORE = "ym-cloud-account-v1";
const PROMPT_LIBRARY_STORE = "yimu-prompt-library";
type CategoryProviderConfigs = Record<ModelCapability, OnlineProviderConfigs>;
const emptyCategoryProviderConfigs = (): CategoryProviderConfigs => ({ text: {}, image: {}, video: {} });
/**
 * The old store was keyed only by platform.  Split it once so a text model
 * can never leak into an image/video setup again.  Only models that actually
 * match a category are migrated; ambiguous old data is left out deliberately.
 */
const migrateCategoryProviderConfigs = (stored: OnlineProviderConfigs): CategoryProviderConfigs => {
  const next = emptyCategoryProviderConfigs();
  Object.entries(stored || {}).forEach(([provider, config]) => {
    (['text', 'image', 'video'] as ModelCapability[]).forEach((capability) => {
      const requested = config.defaultModels?.[capability] || '';
      const model = requested && capabilitiesForModel(classifyProviderModel(requested)).includes(capability)
        ? requested
        : config.model && capabilitiesForModel(classifyProviderModel(config.model)).includes(capability)
          ? config.model
          : '';
      const detectedModels = (config.detectedModels || []).filter((item) => capabilitiesForModel(item).includes(capability));
      const matchingModel = providerModelMatches(provider, model, config.custom) ? model : '';
      const matchingDetectedModels = detectedModels.filter((item) => providerModelMatches(provider, item.id, config.custom));
      if (!matchingModel && !matchingDetectedModels.length) return;
      next[capability][provider] = {
        ...config,
        model: matchingModel || matchingDetectedModels[0]?.id || '',
        defaultModels: matchingModel ? { [capability]: matchingModel } : {},
        capabilities: [capability],
        detectedModels: matchingDetectedModels,
      };
    });
  });
  return next;
};
type PromptLibraryEntry = {
  id: string;
  text: string;
  /** "正面提示词"、"负面提示词"或用户自己命名的分类。 */
  category: string;
  createdAt: number;
};
const readPromptLibrary = (): PromptLibraryEntry[] => {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PROMPT_LIBRARY_STORE) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item, index) => {
      if (typeof item === "string" && item.trim()) return [{ id: `legacy-${index}-${item.trim()}`, text: item.trim(), category: "未分类", createdAt: 0 }];
      if (!item || typeof item !== "object") return [];
      const value = item as Partial<PromptLibraryEntry>;
      return typeof value.text === "string" && value.text.trim()
        ? [{ id: value.id || `prompt-${index}`, text: value.text.trim(), category: value.category?.trim() || "未分类", createdAt: Number(value.createdAt) || 0 }]
        : [];
    }).slice(0, 160);
  } catch { return []; }
};
const generationSourceLabel: Record<GenerationSource, string> = {
  comfy: "本地 ComfyUI",
  byok: "已保存 API 配置",
  cloud: "已保存 API 配置",
};
const ONLINE_PROVIDER_DEFAULTS: Record<string, Omit<OnlineProviderConfig, "apiKey">> = {
  OpenAI: { endpoint: "https://api.openai.com/v1", model: "gpt-4.1-mini", protocol: "openai", capabilities: ["text", "image"] },
  OpenRouter: { endpoint: "https://openrouter.ai/api/v1", model: "", protocol: "openai", capabilities: ["text"], detectedModels: [] },
  DeepSeek: { endpoint: "https://api.deepseek.com/v1", model: "deepseek-chat", protocol: "openai", capabilities: ["text"], detectedModels: [{ id: "deepseek-chat", kind: "text", purpose: "文本、对话或剧本生成" }] },
  Moonshot: { endpoint: "https://api.moonshot.cn/v1", model: "", protocol: "openai", capabilities: ["text"], detectedModels: [] },
  "硅基流动 SiliconFlow": { endpoint: "https://api.siliconflow.cn/v1", model: "", protocol: "openai", capabilities: ["text", "image"], detectedModels: [] },
  "Ollama（本地）": {
    endpoint: "http://127.0.0.1:11434",
    model: "",
    protocol: "ollama",
    capabilities: ["text"],
    detectedModels: [],
  },
  "阿里百炼·万相": {
    endpoint: "https://dashscope.aliyuncs.com/api/v1",
    model: "wan2.6-t2v",
    protocol: "dashscope",
    capabilities: ["text", "video"],
    detectedModels: [
      { id: "wan2.6-t2v", kind: "video", modes: ["text"], purpose: "视频 · 文生视频" },
      { id: "wan2.6-i2v-flash", kind: "video", modes: ["image"], purpose: "视频 · 图生视频（单首帧）" },
      { id: "wan2.2-kf2v-flash", kind: "video", modes: ["firstLast"], purpose: "视频 · 首尾帧（2 张图片）" },
    ],
  },
  "可灵 Kling": {
    endpoint: "https://api.klingai.com",
    model: "kling-v1-6",
    klingAuth: "apiKey",
    protocol: "kling",
    capabilities: ["video"],
    detectedModels: [
      { id: "kling-v1-6", kind: "video", modes: ["text", "image", "firstLast"], purpose: "视频 · 文生视频 / 图生视频 / 首尾帧（2 张图片）" },
    ],
  },
  "豆包·火山方舟": {
    endpoint: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seedance-1-0-pro-250528",
    protocol: "volcengine",
    capabilities: ["video"],
    detectedModels: [
      { id: "doubao-seedance-1-0-pro-250528", kind: "video", modes: ["text", "image", "firstLast"], purpose: "视频 · 文生视频 / 图生视频 / 首尾帧（2 张图片）" },
    ],
  },
  "Google Nano Banana": {
    endpoint: "https://generativelanguage.googleapis.com/v1",
    model: "gemini-3.1-flash-image",
    protocol: "gemini",
    capabilities: ["image"],
    detectedModels: [
      { id: "gemini-3.1-flash-image", kind: "image", purpose: "图片生成 / 多图参考 / 最高 4K" },
      { id: "gemini-3.1-flash-lite-image", kind: "image", purpose: "低成本快速图片生成 / 1K" },
      { id: "gemini-3-pro-image", kind: "image", purpose: "专业图片生成 / 精准文字 / 最高 4K" },
      { id: "gemini-2.5-flash-image", kind: "image", purpose: "旧版 Nano Banana / 低延迟 1K" },
    ],
  },
  "Pollinations（免费测试）": {
    endpoint: "https://gen.pollinations.ai/v1",
    model: "flux",
    protocol: "openai",
    capabilities: ["image"],
    detectedModels: [{ id: "flux", kind: "image", purpose: "免费测试 · 文生图（Flux）" }],
  },
  "MiniMax Hailuo": { endpoint: "https://api.minimax.chat/v1", model: "MiniMax-Text-01", protocol: "openai", capabilities: ["text"] },
};
const classifyProviderModel = (id: string): DetectedProviderModel => {
  const value = id.toLowerCase();
  const isVideo = /seedance|hailuo|video|\bt2v\b|\bi2v\b|kling|sora|veo|hunyuanvideo/.test(value);
  if (isVideo) {
    let modes: CloudVideoMode[] = [];
    if (/seedance[-_.]?2/.test(value)) modes = ["text", "image", "reference"];
    else if (/hailuo[-_.]?02/.test(value)) modes = ["text", "image", "firstLast"];
    else if (/hailuo[-_.]?2\.3/.test(value)) modes = ["text", "image"];
    else if (/i2v/.test(value)) modes = ["image"];
    else if (/t2v/.test(value)) modes = ["text"];
    return { id, kind: "video", modes, purpose: modes.length ? `视频 · ${modes.map((mode) => CLOUD_VIDEO_MODE_LABELS[mode]).join(" / ")}` : "视频模型 · 具体输入能力待平台确认" };
  }
  if (/seedream|gpt-image|gemini.*image|nano[-_.]?banana|image[-_.]?\d|flux|stable[-_.]?diffusion|sdxl|wan.*image/.test(value)) return { id, kind: "image", purpose: "图片生成 / 图片编辑" };
  if (/gpt|qwen|claude|deepseek|gemini|minimax[-_.]?m|llama|mistral|moonshot|kimi|glm|yi[-_/]|grok|chat|text/.test(value)) return { id, kind: "text", purpose: "文本、对话或剧本生成" };
  return { id, kind: "unknown", purpose: "用途待确认，不会自动用于生成" };
};
const capabilitiesForModel = (model: DetectedProviderModel): ModelCapability[] => {
  if (model.capabilities?.length) return [...new Set(model.capabilities)];
  // Repair legacy/manual classifications when the model ID itself is
  // unambiguous (for example a `t2v` model previously marked as image).
  const inferred = classifyProviderModel(model.id).kind;
  if (inferred !== "unknown") return [inferred];
  return model.kind === "unknown" ? [] : [model.kind];
};
const modelCapabilityLabel = (capability: ModelCapability) => capability === "text" ? "文本" : capability === "image" ? "图片" : "视频";
const providerForExplicitModelId = (id: string): string | undefined => {
  const value = id.trim().toLowerCase();
  if (/^kling(?:[-_.\s]|$)/.test(value)) return "可灵 Kling";
  if (/^deepseek(?:[-_.\s]|$)/.test(value)) return "DeepSeek";
  if (/^(qwen|wanx?|wan2|wan[-_.]?video)(?:[-_.\s]|$)/.test(value)) return "阿里百炼·万相";
  if (/^(gpt|dall-e)(?:[-_.\s]|$)/.test(value)) return "OpenAI";
  if (/^(gemini|nano[-_.]?banana)(?:[-_.\s]|$)/.test(value)) return "Google Nano Banana";
  if (/^minimax(?:[-_.\s]|$)/.test(value)) return "MiniMax Hailuo";
  return undefined;
};
const providerModelMatches = (provider: string, model: string, custom?: boolean) => {
  const owner = providerForExplicitModelId(model);
  return Boolean(custom || !owner || owner === provider);
};
const sanitizeCategoryProviderConfigs = (configs: CategoryProviderConfigs): CategoryProviderConfigs => {
  const next = emptyCategoryProviderConfigs();
  (['text', 'image', 'video'] as ModelCapability[]).forEach((capability) => {
    Object.entries(configs[capability] || {}).forEach(([provider, config]) => {
      // Records are deliberately siloed by node type.  Older preview builds
      // could leave an image model in the text record's model input; discard
      // that model on load instead of letting it look like a shared setting.
      const detectedModels = (config.detectedModels || []).filter((model) =>
        providerModelMatches(provider, model.id, config.custom)
        && capabilitiesForModel(model).includes(capability),
      );
      const storedModel = config.defaultModels?.[capability] || config.model || "";
      const model = providerModelMatches(provider, storedModel, config.custom)
        && capabilitiesForModel(classifyProviderModel(storedModel)).includes(capability)
        ? storedModel
        : detectedModels[0]?.id || "";
      // DashScope's OpenAI-compatible endpoint is valid for compatible text
      // calls, but it must never be used for Wan video tasks.  The video API
      // has its own /api/v1 routes; repair records created by earlier shared
      // configuration screens before they are shown or submitted again.
      const endpoint = provider === "阿里百炼·万相" && capability === "video"
        && /dashscope\.aliyuncs\.com\/compatible-mode/i.test(config.endpoint || "")
        ? "https://dashscope.aliyuncs.com/api/v1"
        : config.endpoint;
      next[capability][provider] = {
        ...config,
        endpoint,
        model,
        defaultModels: model ? { [capability]: model } : {},
        detectedModels,
        capabilities: [capability],
      };
    });
  });
  return next;
};
const normalizeExplicitProviderModelId = (id: string): string => {
  const value = id.trim();
  if (/^kling[-_.]?v?3(?:[-_.]?0)?[-_.]?turbo$/i.test(value)) return "kling-v3";
  if (/^kling[-_.]?v?3[-_.]?0$/i.test(value)) return "kling-v3";
  return value;
};
const repairMisplacedProviderModels = (stored: OnlineProviderConfigs): OnlineProviderConfigs => {
  let next = stored;
  Object.entries(stored).forEach(([provider, config]) => {
    const normalizedModel = normalizeExplicitProviderModelId(config.model || "");
    const targetProvider = providerForExplicitModelId(normalizedModel);
    if (normalizedModel !== config.model) {
      if (next === stored) next = { ...stored };
      next[provider] = { ...config, model: normalizedModel };
    }
    if (!targetProvider || targetProvider === provider || config.custom) return;
    if (next === stored) next = { ...stored };
    const targetDefaults = ONLINE_PROVIDER_DEFAULTS[targetProvider];
    const targetConfig = next[targetProvider]
      ? { ...targetDefaults, ...next[targetProvider] }
      : { ...targetDefaults, apiKey: "" };
    next[targetProvider] = { ...targetConfig, model: normalizedModel };
    next[provider] = {
      ...config,
      model: ONLINE_PROVIDER_DEFAULTS[provider]?.model || "",
    };
  });
  return next;
};
const humanizeApiError = (error: unknown) => {
  const raw = String(error).replace(/^Error:\s*/i, "").replace(/\s+/g, " ").trim();
  // Status text is for action, not an unbounded transport dump. The full raw
  // response is still written to the log at the call site.
  if (/HTTP 401|\b401\b|unauthenticated|invalid (api )?key|鉴权失败/i.test(raw)) return "鉴权失败：请检查 API Key / Access Key / Secret Key 是否正确且属于当前项目。";
  if (/HTTP 403|\b403\b|permission|forbidden|权限/i.test(raw)) return "权限不足：请在平台控制台开通该模型，并检查项目或地区权限。";
  if (/HTTP 404|\b404\b|not found|找不到/i.test(raw)) return "找不到接口或模型：请检查接口地址、模型 ID，以及模型是否已开通。";
  if (/HTTP 429|\b429\b|rate limit|quota|余额|余额不足|insufficient/i.test(raw)) return "额度或频率受限：请检查余额、并发限制、套餐和平台配额。";
  if (/timed? out|超时|timeout/i.test(raw)) return "请求超时：请检查网络或地区连通性，稍后再试。";
  if (/network|连接|connect|dns|certificate/i.test(raw)) return "无法连接平台：请检查接口地址、网络代理、证书或地区网络限制。";
  return raw.length > 160 ? `${raw.slice(0, 157)}…` : raw || "未知错误，请打开运行日志查看详情。";
};
const typeLabel: Record<Kind, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  text: "文本",
  storyboard: "脚本/分镜",
  api: "API 工作流",
  batch: "批量收集",
  aiText: "AI 剧本",
  aiImage: "AI 图片",
  onlineVideo: "AI 视频",
  annotation: "镜头批注",
  annotationPointer: "批注指向",
};
const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const BROWSER_INLINE_MEDIA_MAX_BYTES = 4 * 1024 * 1024;

/** Browser fallback for the development preview only.  The desktop build
 * streams the file into AppLocalData instead, so a large file is never placed
 * in localStorage as one giant Base64 string. */
const readFileAsDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("无法读取媒体文件"));
    reader.readAsDataURL(file);
  });

const readSourceAsDataUrl = async (source: string) => {
  if (!source || source.startsWith("data:")) return source;
  const response = await fetch(source);
  if (!response.ok) throw new Error(`无法读取参考图：HTTP ${response.status}`);
  return readFileAsDataUrl(await response.blob());
};

type ImportedWorkspaceMedia = {
  src: string;
  localPath?: string;
  /** Present only for a newly committed desktop-store file. It lets an import
   * that loses its target remove that exact unreferenced file. */
  managedAsset?: ManagedWorkspaceAsset;
};

const storeMediaForProject = async (
  file: File,
  projectId: string,
): Promise<ImportedWorkspaceMedia> => {
  if (!isTauri()) {
    if (file.size > BROWSER_INLINE_MEDIA_MAX_BYTES) {
      throw new Error("浏览器预览模式只允许保存不超过 4 MB 的媒体；请使用桌面版导入大型图片、视频或音频。");
    }
    return { src: await readFileAsDataUrl(file) };
  }
  const asset = await uploadWorkspaceAsset({
    projectId,
    assetId: newId(),
    file,
  });
  if (!asset.localPath) {
    await cleanupUnattachedWorkspaceAsset(asset, []);
    throw new Error("桌面媒体仓储没有返回可预览的文件路径");
  }
  let src: string;
  try {
    src = convertFileSrc(asset.localPath);
  } catch (error) {
    await cleanupUnattachedWorkspaceAsset(asset, []);
    throw new Error(`桌面素材路径无法转换为安全预览地址：${humanizeApiError(error)}`);
  }
  return {
    src,
    localPath: asset.localPath,
    managedAsset: asset,
  };
};

/**
 * ComfyUI's `/view` URL is only a live preview address.  Persist successful
 * results into the application's managed media store before putting a card
 * on the canvas, otherwise a Comfy restart, port change, or output cleanup
 * turns an old video into a 0:00 / 0:00 blank player after reopening a
 * project.  A caching failure deliberately does not discard a successful
 * generation: the caller can still use the live Comfy preview and see a
 * clear log entry.
 */
const cacheComfyGeneratedMedia = async (
  endpoint: string,
  file: { filename: string; subfolder?: string },
  projectId: string,
): Promise<ImportedWorkspaceMedia | null> => {
  if (!isTauri()) return null;
  const asset = await cacheComfyOutputMedia({
    endpoint,
    filename: file.filename,
    subfolder: file.subfolder,
    projectId,
    assetId: newId(),
  });
  if (!asset.localPath) {
    await cleanupUnattachedWorkspaceAsset(asset, []);
    throw new Error("无法保存 ComfyUI 结果：桌面媒体仓储没有返回本机文件路径");
  }
  return {
    src: convertFileSrc(asset.localPath),
    localPath: asset.localPath,
    managedAsset: asset,
  };
};

const parseComfyViewSource = (source: string | undefined) => {
  if (!source) return null;
  try {
    const url = new URL(source);
    if (!(["http:", "https:"] as const).includes(url.protocol as "http:" | "https:")) return null;
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    if (!normalizedPath.endsWith("/view")) return null;
    const filename = url.searchParams.get("filename")?.trim() || "";
    const subfolder = url.searchParams.get("subfolder")?.trim() || "";
    const type = url.searchParams.get("type")?.trim() || "output";
    if (!filename || type !== "output") return null;
    const endpointPath = normalizedPath.slice(0, -"/view".length);
    return {
      endpoint: `${url.origin}${endpointPath}`,
      filename,
      subfolder,
      sourceUrl: url.toString(),
    };
  } catch {
    return null;
  }
};

/** Resolve an already-managed asset for cards saved by earlier app versions. */
const managedPreviewSrc = (localPath: string | undefined): string | undefined => {
  if (!localPath) return undefined;
  try {
    return convertFileSrc(localPath);
  } catch {
    return undefined;
  }
};
const appendTypedLink = (
  project: Project,
  from: string,
  to: string,
  options: NewLinkOptions = {},
) => {
  const validation = validateNewLink(project, from, to, {
    ...options,
    id: options.id || newId(),
  });
  return validation.valid && validation.link
    ? { project: { ...project, links: [...project.links, validation.link] }, issues: [] }
    : { project, issues: validation.issues };
};
const graphIssueText = (issues: ReturnType<typeof validateNewLink>["issues"]) =>
  issues.map((issue) => issue.suggestion ? `${issue.message} ${issue.suggestion}` : issue.message).join(" ");
const GRAPH_VALIDATION_PREFIX = "连线：";
const COMFY_VALIDATION_PREFIX = "ComfyUI：";
const EXECUTION_VALIDATION_PREFIX = "运行前：";
const withoutExecutionValidationErrors = (errors: string[] | undefined) =>
  (errors || []).filter((entry) => !entry.startsWith(EXECUTION_VALIDATION_PREFIX));
const executionPlanIssueText = (issue: ExecutionPlanIssue) =>
  `${issue.message}${issue.suggestion ? ` ${issue.suggestion}` : ""}`;

/**
 * Keep ComfyUI's structured preflight result intact until it reaches the
 * canvas.  Turning it into a delimited Error string loses the node/slot/type
 * coordinates that people need in order to repair a workflow.
 */
class ComfyWorkflowValidationError extends Error {
  readonly diagnostics: ComfyWorkflowDiagnostic[];

  constructor(diagnostics: ComfyWorkflowDiagnostic[]) {
    const errors = diagnostics.filter((diagnostic) => diagnostic.level === "error");
    super(errors[0]?.message || "ComfyUI 工作流校验未通过");
    this.name = "ComfyWorkflowValidationError";
    this.diagnostics = diagnostics;
  }
}

const comfyDiagnosticTitle = (diagnostic: ComfyWorkflowDiagnostic) => {
  const labels: Record<string, string> = {
    "required-input-missing": "缺少必需输入",
    "slot-type-mismatch": "插槽类型不匹配",
    "source-node-missing": "来源节点不存在",
    "source-output-missing": "来源输出不存在",
    "missing-media-output": "未找到媒体输出",
    "output-media-input-missing": "输出节点未接媒体",
    "media-loader-ambiguous": "媒体加载槽不明确",
    "source-schema-unavailable": "来源节点类型未确认",
    "target-schema-unavailable": "目标节点类型未确认",
    "node-schema-unavailable": "节点接口未确认",
    "output-schema-unavailable": "输出接口未确认",
    "output-node-without-media-contract": "输出节点没有媒体合同",
    "output-history-missing": "输出节点未回传媒体",
    "object-info-required": "未读取节点接口",
    "prompt-slot-unbound": "未找到正向文本槽",
    "prompt-slot-ambiguous": "正向文本槽不明确",
    "media-loader-unbound": "未找到媒体加载槽",
  };
  return diagnostic.code ? labels[diagnostic.code] || "ComfyUI 工作流提示" : "ComfyUI 工作流提示";
};

const comfyDiagnosticLocation = (diagnostic: ComfyWorkflowDiagnostic) => {
  const location: string[] = [];
  if (diagnostic.nodeId) location.push(`节点 #${diagnostic.nodeId}`);
  if (diagnostic.input) location.push(`插槽「${diagnostic.input}」`);
  if (diagnostic.sourceNodeId) location.push(`来源 #${diagnostic.sourceNodeId}`);
  if (typeof diagnostic.sourceOutputIndex === "number") location.push(`输出 #${diagnostic.sourceOutputIndex}`);
  return location.join(" · ");
};

const comfyDiagnosticSummary = (diagnostic: ComfyWorkflowDiagnostic) => {
  const location = comfyDiagnosticLocation(diagnostic);
  return `${COMFY_VALIDATION_PREFIX}${location ? `${location}：` : ""}${diagnostic.message}`;
};

const comfyDiagnosticRepair = (diagnostic: ComfyWorkflowDiagnostic) => {
  if (diagnostic.code === "slot-type-mismatch") {
    const source = diagnostic.sourceNodeId ? `来源节点 #${diagnostic.sourceNodeId}` : "来源节点";
    const target = diagnostic.nodeId ? `节点 #${diagnostic.nodeId}` : "目标节点";
    return `在 ComfyUI 中把 ${source} 的 ${diagnostic.actualType || "实际"} 输出，改接到可接受该类型的插槽；或为 ${target} 的「${diagnostic.input || "目标"}」接入 ${diagnostic.expectedType || "所需"} 输出。`;
  }
  if (diagnostic.code === "required-input-missing" || diagnostic.code === "output-media-input-missing") {
    return `在 ComfyUI 中为节点 #${diagnostic.nodeId || "?"} 的「${diagnostic.input || "必需"}」提供 ${diagnostic.expectedType || "所需类型"}：连接同类型上游输出，或填写该节点允许的固定值。`;
  }
  if (diagnostic.code === "source-node-missing" || diagnostic.code === "source-output-missing") {
    return "该工作流引用已失效。请在 ComfyUI 中重新连线并重新导出 API JSON；不要手工猜测旧节点 ID。";
  }
  if (diagnostic.code === "missing-media-output") {
    return "请把最终图片、视频或音频分支连到真实保存/预览输出节点，再重新导出或刷新当前 API 工作流。";
  }
  if (diagnostic.code === "output-history-missing") {
    return "任务已完成但该已验证输出节点没有在 /history 回传媒体。请检查该保存/预览节点是否启用、是否连接了媒体输入，以及 ComfyUI 是否支持把该节点结果写入 history。";
  }
  if (diagnostic.code === "media-loader-ambiguous") {
    return "请在工作流中只保留一个对应素材的上传字段，或让自定义节点的 object_info 提供 upload 标记，然后重试。";
  }
  if (diagnostic.code === "object-info-required") {
    return "请确认本地 ComfyUI 已启动且 /object_info 可访问，再重新运行；画布不会用保存的旧接口猜测提示词或媒体槽。";
  }
  if (diagnostic.code === "prompt-slot-unbound" || diagnostic.code === "prompt-slot-ambiguous") {
    return "请在 ComfyUI 中确认正向提示词使用 STRING/TEXT 槽，并让当前 /object_info 能看到该槽；若有多个同级正向分支，请明确保留一个可写入分支。";
  }
  if (diagnostic.code === "media-loader-unbound") {
    return "请把画布素材接到工作流中带 image_upload、video_upload 或 audio_upload 标记的加载节点，再重新导出 API JSON。";
  }
  return "请按上面的节点、插槽和类型提示在 ComfyUI 中修复；修复后点击“重试”会重新读取当前 object_info 校验。";
};

const withoutComfyValidationErrors = (errors: string[] | undefined) =>
  (errors || []).filter((entry) => !entry.startsWith(COMFY_VALIDATION_PREFIX));
const groupNewId = () => "grp-" + newId();
const nodeSize: Record<Kind, [number, number]> = {
  image: [300, 220],
  video: [320, 220],
  audio: [220, 82],
  text: [270, 175],
  storyboard: [380, 230],
  api: [156, 80],
  batch: [560, 360],
  aiText: [360, 220],
  aiImage: [360, 240],
  onlineVideo: [360, 240],
  annotation: [250, 115],
  annotationPointer: [58, 58],
};

/**
 * ComfyUI history only gives us a filename.  Read the browser-decoded media
 * dimensions before creating a canvas card so a portrait video is never put
 * into the old hard-coded landscape 320×220 frame and cropped by object-fit.
 */
const readGeneratedMediaDimensions = (kind: Extract<Kind, "image" | "video">, src: string) =>
  new Promise<{ width: number; height: number } | null>((resolve) => {
    if (kind === "image") {
      const image = new Image();
      image.onload = () => resolve(image.naturalWidth > 0 && image.naturalHeight > 0
        ? { width: image.naturalWidth, height: image.naturalHeight }
        : null);
      image.onerror = () => resolve(null);
      image.src = src;
      return;
    }
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => resolve(video.videoWidth > 0 && video.videoHeight > 0
      ? { width: video.videoWidth, height: video.videoHeight }
      : null);
    video.onerror = () => resolve(null);
    video.src = src;
  });

const generatedMediaCardSize = (kind: Extract<Kind, "image" | "video">, dimensions: { width: number; height: number } | null) => {
  const [fallbackWidth, fallbackHeight] = nodeSize[kind];
  if (!dimensions) return { width: fallbackWidth, height: fallbackHeight };
  // Keep cards practical on the canvas while preserving the decoded aspect
  // ratio. The 29px allowance is the media card's filename/title bar.
  const width = Math.max(180, Math.min(440, Math.round(300 * dimensions.width / dimensions.height)));
  return { width, height: Math.max(120, Math.round(width * dimensions.height / dimensions.width) + 29) };
};
const onlineVideoSizeForRatio = (ratio?: string): [number, number] => {
  const [rawWidth, rawHeight] = (ratio || "16:9").split(":").map(Number);
  if (!(rawWidth > 0 && rawHeight > 0)) return nodeSize.onlineVideo;
  const scale = Math.min(460 / rawWidth, 380 / rawHeight);
  return [Math.round(rawWidth * scale), Math.round(rawHeight * scale)];
};
const CANVAS_SPATIAL_BUCKET = 900;
const buildCanvasSpatialIndex = (nodes: NodeItem[]) => {
  const buckets = new Map<string, Set<string>>();
  for (const node of nodes) {
    const minColumn = Math.floor(node.x / CANVAS_SPATIAL_BUCKET);
    const maxColumn = Math.floor((node.x + node.width) / CANVAS_SPATIAL_BUCKET);
    const minRow = Math.floor(node.y / CANVAS_SPATIAL_BUCKET);
    const maxRow = Math.floor((node.y + node.height) / CANVAS_SPATIAL_BUCKET);
    for (let column = minColumn; column <= maxColumn; column += 1) {
      for (let row = minRow; row <= maxRow; row += 1) {
        const key = `${column}:${row}`;
        const bucket = buckets.get(key) || new Set<string>();
        bucket.add(node.id);
        buckets.set(key, bucket);
      }
    }
  }
  return buckets;
};
const queryCanvasSpatialIndex = (
  buckets: Map<string, Set<string>>,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
) => {
  const ids = new Set<string>();
  const minColumn = Math.floor(bounds.minX / CANVAS_SPATIAL_BUCKET);
  const maxColumn = Math.floor(bounds.maxX / CANVAS_SPATIAL_BUCKET);
  const minRow = Math.floor(bounds.minY / CANVAS_SPATIAL_BUCKET);
  const maxRow = Math.floor(bounds.maxY / CANVAS_SPATIAL_BUCKET);
  for (let column = minColumn; column <= maxColumn; column += 1) {
    for (let row = minRow; row <= maxRow; row += 1) {
      for (const id of buckets.get(`${column}:${row}`) || []) ids.add(id);
    }
  }
  return ids;
};
const mediaKindFromName = (name?: string): Extract<Kind, "image" | "video" | "audio"> | null => {
  const value = (name || "").toLowerCase();
  if (/\.(mp3|wav|m4a|aac|flac|ogg|opus|wma)$/i.test(value)) return "audio";
  if (/\.(mp4|mov|mkv|avi|webm|m4v|wmv)$/i.test(value)) return "video";
  if (/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(value)) return "image";
  return null;
};
const mediaMimeTypeFromName = (name: string) => {
  const extension = name.split(".").pop()?.toLowerCase() || "";
  const known: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp", avif: "image/avif",
    mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo", webm: "video/webm", m4v: "video/x-m4v", wmv: "video/x-ms-wmv",
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/opus", wma: "audio/x-ms-wma",
  };
  return known[extension] || "application/octet-stream";
};
const defaultStoryboard = (): StoryboardRow[] => [
  { shot: "1", visual: "", dialogue: "" },
];
const storyboardText = (rows: StoryboardRow[] = []) =>
  rows
    .map((row) => {
      const title = `镜头 ${row.shot || "未命名"}`;
      const visual = row.visual ? `画面：${row.visual}` : "";
      const dialogue = row.dialogue ? `台词：${row.dialogue}` : "";
      return [title, visual, dialogue].filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
function starter(): Project {
  return normalizeProject({
    // Keep the complete opening composition centred in the usable canvas.
    // The two notes are intentionally offset from the media cards so the
    // default project reads as one balanced storyboard at first glance.
    view: { x: 6, y: 96, zoom: 0.86 },
    links: [],
    nodes: [
      {
        id: newId(),
        kind: "image",
        x: 360,
        y: 140,
        width: 620,
        height: 378,
        name: "场景 12 · 雨夜，天台",
        src: defaultRainPlatform,
        createdAt: Date.now(),
      },
      {
        id: newId(),
        kind: "text",
        x: 370,
        y: 535,
        width: 590,
        height: 160,
        name: "雨夜，天台",
        text: "场景 12\n\n雨夜，天台\n\n她独自站在天台边缘，城市在脚下沉默。风吹起她的发梢，她没有回头。远处霓虹闪烁，一声汽笛划破夜色。",
        createdAt: Date.now(),
      },
      {
        id: newId(), kind: "image", x: 1060, y: 150, width: 270, height: 180,
        name: "输出 01", src: defaultRooftopOutput, createdAt: Date.now(),
      },
      {
        id: newId(), kind: "image", x: 1060, y: 415, width: 270, height: 180,
        name: "输出 02", src: defaultPaperboatOutput, createdAt: Date.now(),
      },
      {
        id: newId(), kind: "annotation", x: 70, y: 205, width: 250, height: annotationMetrics("情绪转折点。\n冷静的表象下是汹涌的告别。", 250).height,
        name: "镜头批注", text: "情绪转折点。\n冷静的表象下是汹涌的告别。", fontSize: 19, rotation: -8, createdAt: Date.now(),
      },
      {
        id: newId(), kind: "annotation", x: 1375, y: 452, width: 210, height: annotationMetrics("备选镜头：\n更克制，更留白。", 210).height,
        name: "镜头批注", text: "备选镜头：\n更克制，更留白。", fontSize: 19, rotation: 7, createdAt: Date.now(),
      },
    ],
  });
}
const safeProject = normalizeProject;
let initialWorkspaceCache: ProjectWorkspaceSnapshot | null = null;
const initialWorkspace = () => {
  if (!initialWorkspaceCache) {
    initialWorkspaceCache = loadProjectWorkspace(localStorage, starter(), newId);
  }
  return initialWorkspaceCache;
};
function AudioWave({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const wasDragged = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const format = (seconds: number) => {
    const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
  };
  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play().then(() => setPlaying(true)).catch(() => {});
    else {
      audio.pause();
      setPlaying(false);
    }
  };
  const restart = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    audio.play().then(() => setPlaying(true)).catch(() => {});
  };
  return (
    <button
      className={`audio-wave ${playing ? "playing" : ""}`}
      title="单击播放或暂停，双击从头播放"
      onPointerDown={(event) => { pointerStart.current = { x: event.clientX, y: event.clientY }; wasDragged.current = false; }}
      onPointerMove={(event) => { const start = pointerStart.current; if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) wasDragged.current = true; }}
      onClick={() => { if (!wasDragged.current) toggle(); }}
      onDoubleClick={() => { if (!wasDragged.current) restart(); }}
    >
      <audio
        ref={audioRef}
        src={src}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onEnded={() => setPlaying(false)}
      />
      <span className="audio-bars" aria-hidden="true">
        {Array.from({ length: 18 }).map((_, index) => (
          <i key={index} style={{ animationDelay: `${index * -0.07}s` }} />
        ))}
      </span>
      <time className="audio-time">{format(current)} / {format(duration)}</time>
    </button>
  );
}
function VideoCanvas({
  src,
  fallbackSrc,
  onMetadata,
  onPlaybackError,
}: {
  src: string;
  fallbackSrc?: string;
  onMetadata: (width: number, height: number) => void;
  onPlaybackError?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [activeSrc, setActiveSrc] = useState(src);
  useEffect(() => {
    setCurrent(0);
    setDuration(0);
    setLoadError(false);
    setActiveSrc(src);
  }, [src, fallbackSrc]);
  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }
    const root = element.closest(".canvas");
    const observer = new IntersectionObserver(([entry]) => {
      const visible = Boolean(entry?.isIntersecting);
      if (!visible) videoRef.current?.pause();
      setShouldLoad(visible);
    }, { root, rootMargin: "320px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const format = (seconds: number) => {
    const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
  };
  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  };
  return (
    <div
      ref={containerRef}
      className="canvas-video-player"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => shouldLoad ? toggle() : setShouldLoad(true)}
      title="点击播放或暂停"
    >
      {shouldLoad ? <video
        ref={videoRef}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          setLoadError(false);
          setDuration(video.duration);
          onMetadata(video.videoWidth, video.videoHeight);
        }}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onEnded={() => setCurrent(duration)}
        onError={() => {
          // A generated ComfyUI video is persisted locally for project
          // portability, but the asset protocol can occasionally be one
          // render behind right after a commit. Retry the original /view URL
          // exactly once before reporting a real preview error.
          if (fallbackSrc && fallbackSrc !== activeSrc) {
            setActiveSrc(fallbackSrc);
            return;
          }
          setLoadError(true);
          onPlaybackError?.();
        }}
        src={activeSrc}
      /> : <div className="canvas-video-sleep"><span>▶</span><small>视频进入视野后加载</small></div>}
      {loadError ? <div className="canvas-video-load-error">视频预览无法读取：本机缓存和 ComfyUI 原始结果都不可用。</div> : null}
      <div className="canvas-video-tools" aria-hidden="true">
        <time>{format(current)} / {format(duration)}</time>
      </div>
    </div>
  );
}

function CinematicLanding({
  onEnterCanvas,
  onOpenScript,
  onOpenImage,
  onGenerate,
  projectName,
  onProjectNameChange,
}: {
  onEnterCanvas: () => void;
  onOpenScript: () => void;
  onOpenImage: () => void;
  onGenerate: (prompt: string) => void;
  projectName: string;
  onProjectNameChange: (value: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [notesVisible, setNotesVisible] = useState(true);
  const submit = () => onGenerate(prompt.trim());
  return (
    <section className="cinematic-landing" aria-label="亿幕画布默认创作页">
      <header className="cinematic-landing-header">
        <button className="cinematic-brand" onClick={onEnterCanvas} title="进入无限画布">亿幕画布</button>
        <label className="cinematic-project-name"><i /><input value={projectName} onChange={(event) => onProjectNameChange(event.target.value)} aria-label="项目名称" /></label>
        <nav aria-label="创作入口">
          <button onClick={onOpenScript}>脚本</button>
          <button onClick={onOpenImage}>画面</button>
          <button className="cinematic-generate-nav" onClick={submit}>生成</button>
        </nav>
      </header>
      <button
        className="cinematic-note-toggle"
        aria-pressed={notesVisible}
        onClick={() => setNotesVisible((visible) => !visible)}
      >
        {notesVisible ? "隐藏批注" : "镜头批注"}
      </button>
      <div className="cinematic-stage">
        {notesVisible && <button className="cinematic-note left" onClick={() => setNotesVisible(false)} title="点击隐藏镜头批注">
          <span>情绪转折点。<br />冷静的表象下是汹涌的告别。</span><i />
        </button>}
        <article className="cinematic-main-card">
          <img src={defaultRainPlatform} alt="雨夜室内，桌灯旁独坐的人物" />
          <div className="cinematic-main-copy">
            <small>场景 12</small>
            <h1>雨夜，天台</h1>
            <p>她独自站在天台边缘，城市在脚下沉默。风吹起她的发梢，<br />她没有回头。远处霓虹闪烁，一声汽笛划破夜色。</p>
          </div>
        </article>
        <aside className="cinematic-outputs" aria-label="输出镜头">
          <article><img src={defaultRooftopOutput} alt="雨夜天台的孤独背影" /><footer><span>输出 01</span><i /></footer></article>
          <article><img src={defaultPaperboatOutput} alt="雨水中漂浮的纸船" /><footer><span>输出 02</span><i /></footer></article>
        </aside>
        {notesVisible && <button className="cinematic-note right" onClick={() => setNotesVisible(false)} title="点击隐藏镜头批注">
          <span>备选镜头：<br />更克制，更留白。</span><i />
        </button>}
      </div>
      <form className="cinematic-prompt" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <input value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="描述你想要生成的画面…" aria-label="生成画面描述" />
        <button type="submit">生成</button>
      </form>
    </section>
  );
}

function BufferedProjectTextarea({
  nodeId,
  value,
  onCommit,
  className,
  placeholder = "输入剧本、提示词、镜头说明或对白……",
  autoFocus = true,
  onDraft,
  onSubmit,
}: {
  nodeId: string;
  value: string;
  onCommit: (value: string) => void;
  className?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onDraft?: (value: string, field: HTMLTextAreaElement) => void;
  onSubmit?: (value: string) => void;
}) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const timerRef = useRef<number | null>(null);
  const idleRef = useRef<number | null>(null);
  const committed = useRef(value);
  const commitRef = useRef(onCommit);
  const draftRef = useRef(onDraft);
  const submitRef = useRef(onSubmit);
  commitRef.current = onCommit;
  draftRef.current = onDraft;
  submitRef.current = onSubmit;
  useEffect(() => {
    committed.current = value;
    const field = fieldRef.current;
    if (field && document.activeElement !== field && field.value !== value) field.value = value;
  }, [nodeId, value]);
  const cancelScheduledCommit = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    if (idleRef.current !== null && "cancelIdleCallback" in window) {
      window.cancelIdleCallback(idleRef.current);
    }
    idleRef.current = null;
  };
  const flush = () => {
    cancelScheduledCommit();
    const next = fieldRef.current?.value ?? committed.current;
    if (next === committed.current) return;
    committed.current = next;
    commitRef.current(next);
  };
  const queueCommit = () => {
    cancelScheduledCommit();
    // Keep the native textarea local while the user is typing. Reconcile the
    // project only after both the typing burst and current rendering work stop.
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const commitWhenIdle = () => {
        idleRef.current = null;
        const next = fieldRef.current?.value ?? committed.current;
        if (next === committed.current) return;
        committed.current = next;
        startTransition(() => commitRef.current(next));
      };
      if ("requestIdleCallback" in window) {
        idleRef.current = window.requestIdleCallback(commitWhenIdle, { timeout: 3000 });
      } else {
        idleRef.current = setTimeout(commitWhenIdle, 0);
      }
    }, 900);
  };
  useEffect(() => () => flush(), [nodeId]);
  return <textarea
    ref={fieldRef}
    className={className}
    autoFocus={autoFocus}
    defaultValue={value}
    onInput={(event) => {
      draftRef.current?.(event.currentTarget.value, event.currentTarget);
      queueCommit();
    }}
    onKeyDown={(event) => {
      if (event.key === "Enter" && !event.shiftKey && submitRef.current) {
        event.preventDefault();
        const next = event.currentTarget.value;
        flush();
        submitRef.current(next);
      }
    }}
    onBlur={flush}
    placeholder={placeholder}
  />;
}

function OneShotGenerationTrigger({
  requestId,
  run,
}: {
  requestId: string;
  run: () => void | Promise<void>;
}) {
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    void runRef.current();
  }, [requestId]);
  return null;
}
export default function App() {
  const [project, setProject] = useState<Project>(() => initialWorkspace().project);
  const [historyId, setHistoryId] = useState(() => initialWorkspace().activeId);
  const [historyProjects, setHistoryProjects] = useState<HistoryProject[]>(() => initialWorkspace().history);
  const [selected, setSelected] = useState<string[]>([]);
  const [selectedLinks, setSelectedLinks] = useState<string[]>([]);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    node?: string;
  } | null>(null);
  const [disconnectMenu, setDisconnectMenu] = useState<{
    x: number;
    y: number;
    target: string;
  } | null>(null);
  const [panning, setPanning] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [cinematicLandingOpen, setCinematicLandingOpen] = useState(false);
  const [projectName, setProjectName] = useState(() => initialWorkspace().activeName);
  // Project identity may change while a file reader or a remote generation is
  // waiting.  These refs are the authoritative latest snapshot for synchronous
  // flushes; React state remains the rendering source of truth.
  const projectRef = useRef(project);
  const historyIdRef = useRef(historyId);
  const projectNameRef = useRef(projectName);
  const historyProjectsRef = useRef(historyProjects);
  // Explicit legacy-media migrations are asynchronous maintenance sessions.
  // Project activation invalidates the session before a committed upload can
  // patch a different canvas.
  const legacyMigrationSequence = useRef(0);
  const mediaRecoveryAttempted = useRef(new Set<string>());
  projectRef.current = project;
  historyIdRef.current = historyId;
  projectNameRef.current = projectName;
  historyProjectsRef.current = historyProjects;
  // Saving on close/switch is synchronous, so keep the ref in step with an
  // input event instead of waiting for React to render the edited title.
  const updateActiveProjectName = (nextName: string) => {
    projectNameRef.current = nextName;
    setProjectName(nextName);
  };
  const [navOpen, setNavOpen] = useState(false);
  const [selectionBox, setSelectionBox] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [lineSelectionBox, setLineSelectionBox] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [activeText, setActiveText] = useState<string | null>(null);
  const [editingAnnotation, setEditingAnnotation] = useState<string | null>(null);
  const [activeOnlineVideo, setActiveOnlineVideo] = useState<string | null>(null);
  const [pendingVideoRegeneration, setPendingVideoRegeneration] = useState<{
    requestId: string;
    sourceNodeId: string;
    prompt: string;
  } | null>(null);
  const [onlinePopover, setOnlinePopover] = useState<{
    nodeId: string;
    kind: "reference" | "effect" | "character" | "camera" | "promptLibrary" | "settings" | "params";
  } | null>(null);
  const [atReferenceMenu, setAtReferenceMenu] = useState<{
    nodeId: string;
    start: number;
    end: number;
  } | null>(null);
  const [promptLibraryTarget, setPromptLibraryTarget] = useState<{ nodeId: string; kind: "ai" | "video" } | null>(null);
  const [promptLibraryText, setPromptLibraryText] = useState("");
  const [promptLibraryEntries, setPromptLibraryEntries] = useState<PromptLibraryEntry[]>(readPromptLibrary);
  const [promptLibrarySearch, setPromptLibrarySearch] = useState("");
  const [promptLibraryCategory, setPromptLibraryCategory] = useState("正面提示词");
  const [promptLibraryFilter, setPromptLibraryFilter] = useState("全部");
  const savePromptLibrary = (entries: PromptLibraryEntry[]) => {
    const next = entries.slice(0, 160);
    setPromptLibraryEntries(next);
    localStorage.setItem(PROMPT_LIBRARY_STORE, JSON.stringify(next));
  };
  const insertPromptLibraryEntry = (entry: PromptLibraryEntry) => {
    const target = promptLibraryTarget;
    if (!target) return;
    change((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id !== target.nodeId ? node : {
        ...node,
        workflow: {
          ...((node.workflow && typeof node.workflow === "object" ? node.workflow : {}) as Record<string, unknown>),
          prompt: `${String((node.workflow as { prompt?: unknown } | undefined)?.prompt || "").trim()}${(node.workflow as { prompt?: unknown } | undefined)?.prompt ? " " : ""}${entry.text}`,
        },
      }),
    }));
    setPromptLibraryTarget(null);
    setMessage(`已写入“${entry.category}”提示词`);
  };
  const [activeStoryboard, setActiveStoryboard] = useState<string | null>(null);
  const [storyboardPaste, setStoryboardPaste] = useState("");
  const [previewImage, setPreviewImage] = useState<NodeItem | null>(null);
  const [dropTextTarget, setDropTextTarget] = useState<string | null>(null);
  const [mediaPickerText, setMediaPickerText] = useState<string | null>(null);
  const [recentOpen, setRecentOpen] = useState(false);
  const [recent, setRecent] = useState<NodeItem[]>([]);
  const [message, setMessage] = useState("已离线保存");
  const [legacyMigrationProgress, setLegacyMigrationProgress] = useState({
    running: false,
    total: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    current: "",
  });
  const [settings, setSettings] = useState(false);
  const [preferences, setPreferences] = useState(false);
  const [onlineApiOpen, setOnlineApiOpen] = useState(false);
  const [serviceConfigSection, setServiceConfigSection] = useState<"models" | "mcp">("models");
  // Keep the configuration focused on the node type being configured.
  const [providerCapabilityFilter, setProviderCapabilityFilter] = useState<ModelCapability | "all">("text");
  const [cloudPointsOpen, setCloudPointsOpen] = useState(false);
  const [onlineConfigTab, setOnlineConfigTab] = useState<"byok" | "cloud">("byok");
  const [onlineConfigProvider, setOnlineConfigProvider] = useState("阿里百炼·万相");
  const [providerModelDraft, setProviderModelDraft] = useState("");
  // The API dialog is opened repeatedly from different node composers. Keep
  // its unfinished model text while the user is configuring the same
  // provider/capability; reopening must never look like it cleared a saved
  // configuration. A deliberate provider or capability switch gets the
  // corresponding saved default instead.
  const providerDraftContextRef = useRef<string | null>(null);
  const [customProviderName, setCustomProviderName] = useState("");
  const [customProviderDraft, setCustomProviderDraft] = useState<OnlineProviderConfig | null>(null);
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [testingProvider, setTestingProvider] = useState(false);
  const [providerTestResult, setProviderTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [onlineProviderConfigs, setOnlineProviderConfigs] = useState<OnlineProviderConfigs>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(ONLINE_PROVIDER_STORE) || "{}") as OnlineProviderConfigs;
      const ollama = stored?.["Ollama（本地）"];
      if (ollama && !ollama.detectedModels?.length && ["llama3.2", "qwen2.5", "deepseek-r1"].includes(ollama.model)) {
        stored["Ollama（本地）"] = { ...ollama, model: "" };
      }
      return stored && typeof stored === "object" ? repairMisplacedProviderModels(stored) : {};
    } catch { return {}; }
  });
  const [categoryProviderConfigs, setCategoryProviderConfigs] = useState<CategoryProviderConfigs>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(CATEGORY_PROVIDER_STORE) || "null") as Partial<CategoryProviderConfigs> | null;
      if (stored && typeof stored === "object" && stored.text && stored.image && stored.video) {
        return sanitizeCategoryProviderConfigs({
          text: stored.text || {},
          image: stored.image || {},
          video: stored.video || {},
        });
      }
      const legacy = JSON.parse(localStorage.getItem(ONLINE_PROVIDER_STORE) || "{}") as OnlineProviderConfigs;
      return migrateCategoryProviderConfigs(legacy && typeof legacy === "object" ? legacy : {});
    } catch { return emptyCategoryProviderConfigs(); }
  });
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(MCP_SERVER_STORE) || "[]") as McpServerConfig[];
      return Array.isArray(stored) ? stored : [];
    } catch { return []; }
  });
  const [activeMcpServer, setActiveMcpServer] = useState<string | null>(null);
  const [testingMcp, setTestingMcp] = useState(false);
  const [cloudSettings, setCloudSettings] = useState<CloudSettings>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(CLOUD_STORE) || "{}") as Partial<CloudSettings>;
      return {
        endpoint: typeof stored.endpoint === "string" ? stored.endpoint : "",
        accessToken: typeof stored.accessToken === "string" ? stored.accessToken : "",
        accountLabel: typeof stored.accountLabel === "string" ? stored.accountLabel : "",
      };
    } catch {
      return { endpoint: "", accessToken: "", accountLabel: "" };
    }
  });
  const [activeApiConfig, setActiveApiConfig] = useState<string | null>(null);
  // Runtime-only because a ComfyUI schema may change between app launches.
  // The text badge on the node is persisted separately for a quick reminder,
  // while this map keeps the exact node/slot/type coordinates expandable.
  const [comfyDiagnostics, setComfyDiagnostics] = useState<Record<string, ComfyWorkflowDiagnostic[]>>({});
  const [expandedComfyDiagnostics, setExpandedComfyDiagnostics] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [mediaLibraryOpen, setMediaLibraryOpen] = useState(false);
  const [directorOpen, setDirectorOpen] = useState(false);
  const [workflowLibraryOpen, setWorkflowLibraryOpen] = useState(false);
  const [activeAiNode, setActiveAiNode] = useState<string | null>(null);
  // These two full-screen surfaces use different interaction models.  Never
  // leave both mounted over the canvas: even when one is visually on top, the
  // other can still keep a transparent pointer layer alive underneath it.
  const openMediaLibrary = () => {
    setDirectorOpen(false);
    setMediaLibraryOpen(true);
  };
  const openDirectorMode = () => {
    setMediaLibraryOpen(false);
    setDirectorOpen(true);
  };
  const [openAiConfig, setOpenAiConfig] = useState(() => {
    try { return JSON.parse(localStorage.getItem("ym-openai-config") || "{}") as { endpoint?: string; apiKey?: string; model?: string }; } catch { return {}; }
  });
  const [defaultSaveDir, setDefaultSaveDir] = useState(
    () => localStorage.getItem("ym-default-save-dir") || "",
  );
  const [workspaceAssetDir, setWorkspaceAssetDir] = useState("");
  const [autosaveMinutes, setAutosaveMinutes] = useState(() => normalizeAutosaveMinutes(
    localStorage.getItem(AUTOSAVE_MINUTES_STORE) || DEFAULT_AUTOSAVE_MINUTES,
  ));
  const [autosaveMinutesDraft, setAutosaveMinutesDraft] = useState(() => String(autosaveMinutes));
  // The product uses one deliberate default visual language: noir editorial.
  // Keep the class for CSS scoping, but don't restore legacy colour themes.
  const resolvedTheme = "obsidian";
  const [topMenuOpen, setTopMenuOpen] = useState(false);
  const [canvasShortcutsOpen, setCanvasShortcutsOpen] = useState(false);
  const [comfyConnected, setComfyConnected] = useState(false);
  const [apiUrl, setApiUrl] = useState(
    () => localStorage.getItem("comfy-bridge") || "http://127.0.0.1:8189",
  );
  const [clipboard, setClipboard] = useState<NodeItem[]>([]);
  const [groupNameInput, setGroupNameInput] = useState<string | null>(null);

  useEffect(() => {
    if (!activeAiNode && !activeOnlineVideo) return;
    const closeComposerFromOutside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".ai-composer,.online-video-composer")) return;
      setActiveAiNode(null);
      setActiveOnlineVideo(null);
      setOnlinePopover(null);
      setAtReferenceMenu(null);
    };
    document.addEventListener("pointerdown", closeComposerFromOutside, true);
    return () => document.removeEventListener("pointerdown", closeComposerFromOutside, true);
  }, [activeAiNode, activeOnlineVideo]);

  const configuredCategory = providerCapabilityFilter === "all" ? "text" : providerCapabilityFilter;
  const categoryConfigs = categoryProviderConfigs[configuredCategory];
  const resolvedProviderConfig = (provider: string, capability: ModelCapability) => {
    const saved = categoryProviderConfigs[capability][provider];
    const defaults = ONLINE_PROVIDER_DEFAULTS[provider];
    return saved
      ? { ...defaults, ...saved }
      : defaults ? { ...defaults, apiKey: "", model: "", defaultModels: {}, detectedModels: [] } : undefined;
  };
  const selectedOnlineProvider = customProviderDraft || resolvedProviderConfig(onlineConfigProvider, configuredCategory)
    || { endpoint: "", apiKey: "", model: "", protocol: "openai" as ProviderProtocol, capabilities: [configuredCategory], custom: true, detectedModels: [] };
  const selectedOnlineProviderModels = [
    ...((selectedOnlineProvider.detectedModels || []) as DetectedProviderModel[]),
    ...(customProviderDraft ? [] : (ONLINE_PROVIDER_DEFAULTS[onlineConfigProvider]?.detectedModels || []) as DetectedProviderModel[]),
  ].filter((model, index, models) => models.findIndex((candidate) => candidate.id === model.id) === index);
  const editedProviderModelId = providerModelDraft.trim();
  const selectedOnlineProviderModel = selectedOnlineProviderModels.find((model) => model.id === editedProviderModelId);
  const selectedOnlineProviderModelCapabilities = editedProviderModelId
    ? capabilitiesForModel(selectedOnlineProviderModel || classifyProviderModel(editedProviderModelId))
    : [];
  const openAiProvider = resolvedProviderConfig("OpenAI", "text")
    || { ...ONLINE_PROVIDER_DEFAULTS.OpenAI, apiKey: openAiConfig.apiKey || "" };
  const onlineProviderNames = [...new Set([...Object.keys(ONLINE_PROVIDER_DEFAULTS), ...Object.keys(onlineProviderConfigs)])];
  const defaultModelForProvider = (provider: string, capability: ModelCapability) => {
    const config = resolvedProviderConfig(provider, capability);
    return config?.defaultModels?.[capability] || config?.model || "";
  };
  useEffect(() => {
    if (!onlineApiOpen || serviceConfigSection !== "models") return;
    const category = providerCapabilityFilter === "all" ? "text" : providerCapabilityFilter;
    const context = `${onlineConfigProvider}::${category}`;
    if (providerDraftContextRef.current === context) return;
    providerDraftContextRef.current = context;
    setProviderModelDraft(defaultModelForProvider(onlineConfigProvider, category));
  }, [onlineApiOpen, onlineConfigProvider, providerCapabilityFilter, serviceConfigSection]);
  const capabilitiesForProvider = (provider: string): ModelCapability[] => {
    const config = ONLINE_PROVIDER_DEFAULTS[provider];
    return [...new Set([
      ...(config?.capabilities || []),
      ...(config?.detectedModels || []).flatMap(capabilitiesForModel),
    ])];
  };
  const modelsForProvider = (provider: string, capability: ModelCapability) => {
    const config = resolvedProviderConfig(provider, capability);
    const detectedModels = config?.detectedModels || [];
    const detected = detectedModels.filter((model) => capabilitiesForModel(model).includes(capability)).map((model) => model.id);
    const configuredId = config?.defaultModels?.[capability] || config?.model;
    const configuredModel = configuredId
      ? detectedModels.find((model) => model.id === configuredId) || classifyProviderModel(configuredId)
      : null;
    const configured = configuredId && configuredModel && capabilitiesForModel(configuredModel).includes(capability) ? [configuredId] : [];
    return [...new Set([...configured, ...detected])];
  };
  const compatibleModelForProvider = (
    provider: string,
    capability: ModelCapability,
    ...candidates: Array<string | undefined>
  ) => {
    const compatible = modelsForProvider(provider, capability);
    return chooseCompatibleModel(compatible, ...candidates);
  };
  /**
   * The canvas must not offer a provider merely because it has a built-in
   * preset.  A selectable provider is a saved, usable connection for that
   * node type.  This keeps the normal path as: save once → choose here →
   * generate, instead of opening the configuration dialog after every click.
   */
  const providerIsReadyFor = (provider: string, capability: ModelCapability) => {
    const config = resolvedProviderConfig(provider, capability);
    const savedConfig = categoryProviderConfigs[capability][provider];
    if (!savedConfig) return false;
    if (!config?.endpoint?.trim()) return false;
    if (provider === "Ollama（本地）") {
      return Boolean(config.model?.trim() || modelsForProvider(provider, capability).length);
    }
    if (provider === "OpenAI") return Boolean(config?.apiKey?.trim());
    return Boolean(savedConfig?.apiKey?.trim());
  };
  const presetModelsForProvider = (provider: string, capability: ModelCapability) => {
    if (capability === "text") {
      const name = provider === "阿里百炼·万相" ? "阿里百炼·通义千问" : provider === "MiniMax Hailuo" ? "MiniMax" : provider;
      return AI_TEXT_PROVIDER_PRESETS[name as keyof typeof AI_TEXT_PROVIDER_PRESETS]?.models || [];
    }
    if (capability === "image") return AI_IMAGE_PROVIDER_PRESETS[provider as keyof typeof AI_IMAGE_PROVIDER_PRESETS]?.models || [];
    return [];
  };
  const readyProviderNamesFor = (capability: ModelCapability) => Object.keys(categoryProviderConfigs[capability])
    .filter((provider) => providerIsReadyFor(provider, capability))
    .filter((provider) => modelsForProvider(provider, capability).length > 0 || presetModelsForProvider(provider, capability).length > 0);
  const textProviderOptions: AiProviderOption[] = readyProviderNamesFor("text")
    .map((provider) => {
      const name = provider === "阿里百炼·万相" ? "阿里百炼·通义千问" : provider === "MiniMax Hailuo" ? "MiniMax" : provider;
      const preset = AI_TEXT_PROVIDER_PRESETS[name as keyof typeof AI_TEXT_PROVIDER_PRESETS];
      const models = [...new Set([...modelsForProvider(provider, "text"), ...(preset?.models || [])])];
      return { name, models, defaultModel: models[0] || "" };
    });
  const imageProviderOptions: AiProviderOption[] = [
    ...readyProviderNamesFor("image").map((provider) => {
      const preset = AI_IMAGE_PROVIDER_PRESETS[provider as keyof typeof AI_IMAGE_PROVIDER_PRESETS];
      const models = [...new Set([...modelsForProvider(provider, "image"), ...(preset?.models || [])])];
      return { name: provider, models, defaultModel: models[0] || "" };
    }),
  ];
  const filteredOnlineProviderNames = [...new Set([
    ...Object.keys(categoryConfigs),
    ...Object.keys(ONLINE_PROVIDER_DEFAULTS).filter((provider) => capabilitiesForProvider(provider).includes(configuredCategory)),
  ])];
  const activeMcpConfig = mcpServers.find((server) => server.id === activeMcpServer) || mcpServers[0] || null;
  const onlineVideoProviderNames = readyProviderNamesFor("video");
  const updateOnlineProviderConfig = (patch: Partial<OnlineProviderConfig>) => {
    if (customProviderDraft) {
      setCustomProviderDraft((current) => current ? { ...current, ...patch, custom: true, capabilities: [configuredCategory] } : current);
      return;
    }
    setCategoryProviderConfigs((current) => {
      const category = providerCapabilityFilter === "all" ? "text" : providerCapabilityFilter;
      const existing = current[category][onlineConfigProvider];
      const defaults = ONLINE_PROVIDER_DEFAULTS[onlineConfigProvider];
      const base = existing
        ? { ...defaults, ...existing }
        : { ...defaults, endpoint: "", apiKey: "", model: "", defaultModels: {}, detectedModels: [], capabilities: [category] };
      return { ...current, [category]: { ...current[category], [onlineConfigProvider]: { ...base, ...patch, capabilities: [category] } } };
    });
  };
  const addOrUpdateProviderModel = () => {
    const id = normalizeExplicitProviderModelId(providerModelDraft);
    if (!id) {
      setMessage("请先填写要加入当前平台的模型 ID。");
      return;
    }
    const category = providerCapabilityFilter === "all" ? "text" : providerCapabilityFilter;
    const targetProvider = providerForExplicitModelId(id);
    if (targetProvider && targetProvider !== onlineConfigProvider && !selectedOnlineProvider.custom) {
      const classified = classifyProviderModel(id);
      setOnlineProviderConfigs((current) => {
        const targetConfig = current[targetProvider]
          ? { ...ONLINE_PROVIDER_DEFAULTS[targetProvider], ...current[targetProvider] }
          : { ...ONLINE_PROVIDER_DEFAULTS[targetProvider], apiKey: "" };
        const detectedModels = [
          ...(targetConfig.detectedModels || []).filter((model) => model.id !== id),
          classified,
        ];
        return {
          ...current,
          [targetProvider]: {
            ...targetConfig,
            model: targetConfig.model || id,
            defaultModels: { ...(targetConfig.defaultModels || {}), [category]: id },
            detectedModels,
            capabilities: [...new Set([...(targetConfig.capabilities || []), ...capabilitiesForModel(classified)])],
          },
        };
      });
      setOnlineConfigProvider(targetProvider);
      setProviderModelDraft(id);
      setProviderTestResult(null);
      setMessage(`“${id}”属于“${targetProvider}”，已放入正确平台的模型库；平台密钥仍只需配置一次。`);
      return;
    }
    const classified = classifyProviderModel(id);
    const existing = selectedOnlineProviderModels.find((model) => model.id === id);
    const knownCapabilities = capabilitiesForModel(existing || classified);
    if (knownCapabilities.length > 0 && !knownCapabilities.includes(category)) {
      setMessage(`“${id}”是${knownCapabilities.map(modelCapabilityLabel).join("/")}模型，不能加入当前“${modelCapabilityLabel(category)}”配置。`);
      return;
    }
    const model: DetectedProviderModel = existing
      ? { ...existing, capabilities: knownCapabilities }
      : { ...classified, kind: category, capabilities: [category], purpose: `${modelCapabilityLabel(category)}生成模型` };
    const detectedModels = [
      ...(selectedOnlineProvider.detectedModels || []).filter((item) => item.id !== id),
      model,
    ];
    updateOnlineProviderConfig({
      model: selectedOnlineProvider.model || id,
      defaultModels: { ...(selectedOnlineProvider.defaultModels || {}), [category]: id },
      detectedModels,
      capabilities: [...new Set([...(selectedOnlineProvider.capabilities || []), ...capabilitiesForModel(model)])],
    });
    setProviderModelDraft(id);
    setMessage(`已把“${id}”保存为“${modelCapabilityLabel(category)}”模型；它会出现在对应节点的参数选择中。`);
  };
  const removeProviderModel = (id: string) => {
    const detectedModels = (selectedOnlineProvider.detectedModels || []).filter((model) => model.id !== id);
    const nextDefault = selectedOnlineProvider.model === id ? detectedModels[0]?.id || "" : selectedOnlineProvider.model;
    const capabilities = [...new Set(detectedModels.flatMap(capabilitiesForModel))];
    const defaultModels = Object.fromEntries(Object.entries(selectedOnlineProvider.defaultModels || {}).filter(([, model]) => model !== id));
    updateOnlineProviderConfig({ detectedModels, model: nextDefault, defaultModels, capabilities });
    if (providerModelDraft === id) setProviderModelDraft(nextDefault);
    setMessage(`已从“${onlineConfigProvider}”移除模型“${id}”；平台接口和密钥保持不变。`);
  };
  const setDefaultProviderModel = (id: string) => {
    const category = providerCapabilityFilter === "all" ? "text" : providerCapabilityFilter;
    const model = selectedOnlineProviderModels.find((item) => item.id === id) || classifyProviderModel(id);
    const detectedModels = (selectedOnlineProvider.detectedModels || []).some((item) => item.id === id)
      ? selectedOnlineProvider.detectedModels || []
      : [...(selectedOnlineProvider.detectedModels || []), { ...model, capabilities: capabilitiesForModel(model) }];
    updateOnlineProviderConfig({
      model: selectedOnlineProvider.model || id,
      defaultModels: { ...(selectedOnlineProvider.defaultModels || {}), [category]: id },
      detectedModels,
    });
    setProviderModelDraft(id);
    setMessage(`已将“${id}”设为“${onlineConfigProvider}”的默认${modelCapabilityLabel(category)}模型。`);
  };
  const openOnlineConfiguration = (_tab: "byok" | "cloud", provider?: string, capability?: ModelCapability) => {
    if (provider && (onlineProviderNames.includes(provider) || Object.values(categoryProviderConfigs).some((configs) => Boolean(configs[provider])))) setOnlineConfigProvider(provider);
    if (capability) setProviderCapabilityFilter(capability);
    setOnlineConfigTab("byok");
    setOnlineApiOpen(true);
  };
  const startCustomProvider = () => {
    const category = providerCapabilityFilter === "all" ? "text" : providerCapabilityFilter;
    setCustomProviderName("");
    setCustomProviderDraft({ endpoint: "", apiKey: "", model: "", protocol: "openai", capabilities: [category], custom: true, detectedModels: [] });
    setProviderModelDraft("");
    setProviderTestResult(null);
  };
  const removeConfiguredProvider = () => {
    const category = providerCapabilityFilter === "all" ? "text" : providerCapabilityFilter;
    if (!categoryProviderConfigs[category][onlineConfigProvider]) return;
    setCategoryProviderConfigs((current) => {
      const { [onlineConfigProvider]: _removed, ...remaining } = current[category];
      return { ...current, [category]: remaining };
    });
    const nextProvider = filteredOnlineProviderNames.find((name) => name !== onlineConfigProvider) || "OpenAI";
    setOnlineConfigProvider(nextProvider);
    setProviderModelDraft("");
    setProviderTestResult(null);
    setMessage(`已删除${modelCapabilityLabel(category)}配置中的“${onlineConfigProvider}”。其他节点类型的同名配置不受影响。`);
  };
  const discoverProviderModels = async () => {
    if (!selectedOnlineProvider.endpoint?.trim()) { setMessage("请先填写接口地址"); return; }
    if (onlineConfigProvider !== "Ollama（本地）" && !selectedOnlineProvider.apiKey?.trim()) { setMessage("请先填写 API Key"); return; }
    setDiscoveringModels(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const ids = await invoke<string[]>("discover_api_models", { provider: onlineConfigProvider, endpoint: selectedOnlineProvider.endpoint, apiKey: selectedOnlineProvider.apiKey || "" });
      const category = providerCapabilityFilter === "all" ? "text" : providerCapabilityFilter;
      const discovered = ids
        .map(classifyProviderModel)
        .filter((model) => capabilitiesForModel(model).includes(category))
        .filter((model) => providerModelMatches(onlineConfigProvider, model.id, selectedOnlineProvider.custom));
      const detectedModels = (selectedOnlineProvider.detectedModels || [])
        .filter((model) => capabilitiesForModel(model).includes(category));
      discovered.forEach((model) => {
        const existing = detectedModels.findIndex((item) => item.id === model.id);
        if (existing >= 0) detectedModels[existing] = { ...model, capabilities: [category], kind: category };
        else detectedModels.push({ ...model, capabilities: [category], kind: category });
      });
      const defaultModel = selectedOnlineProvider.model && providerModelMatches(onlineConfigProvider, selectedOnlineProvider.model, selectedOnlineProvider.custom)
        ? selectedOnlineProvider.model
        : detectedModels[0]?.id || "";
      updateOnlineProviderConfig({ detectedModels, model: defaultModel, defaultModels: defaultModel ? { [category]: defaultModel } : {} });
      setProviderModelDraft(defaultModel);
      setMessage(discovered.length
        ? `已从 ${onlineConfigProvider} 检索到 ${ids.length} 个模型，其中 ${discovered.length} 个可用于当前${modelCapabilityLabel(category)}节点。`
        : `接口返回 ${ids.length} 个模型，但没有识别到可用于当前${modelCapabilityLabel(category)}节点的模型；可手动填写模型 ID。`);
    } catch (error) {
      setMessage(`模型识别失败：${String(error).replace(/^Error: /, "")}`);
    } finally { setDiscoveringModels(false); }
  };
  const testOnlineProvider = async () => {
    if (!selectedOnlineProvider.endpoint?.trim()) { setProviderTestResult({ ok: false, text: "请先填写接口地址。" }); return; }
    if (onlineConfigProvider !== "Ollama（本地）" && !selectedOnlineProvider.apiKey?.trim()) { setProviderTestResult({ ok: false, text: "请先填写 API Key 或 Access Key。" }); return; }
    if (onlineConfigProvider === "可灵 Kling" && selectedOnlineProvider.klingAuth === "aksk" && !selectedOnlineProvider.apiSecret?.trim()) { setProviderTestResult({ ok: false, text: "AK/SK 签名方式还需要填写 Secret Key。" }); return; }
    setTestingProvider(true);
    setProviderTestResult(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ provider: string; detail: string; model?: string }>("test_provider_connection", {
        provider: onlineConfigProvider,
        endpoint: selectedOnlineProvider.endpoint,
        apiKey: selectedOnlineProvider.apiKey,
        apiSecret: selectedOnlineProvider.apiSecret || null,
        model: selectedOnlineProvider.model || "",
      });
      setProviderTestResult({ ok: true, text: result.detail });
      // A saved connection must be immediately usable by node composers. For
      // providers which expose a model list, refresh it here instead of asking
      // the user to classify or manually register model IDs in a second step.
      if (!["可灵 Kling", "豆包·火山方舟", "Google Nano Banana"].includes(onlineConfigProvider)) {
        await discoverProviderModels();
      }
      setMessage(`${result.provider} 连接测试通过`);
    } catch (error) {
      const text = humanizeApiError(error);
      setProviderTestResult({ ok: false, text });
      setMessage(`连接测试失败：${text}`);
    } finally {
      setTestingProvider(false);
    }
  };
  const setConfiguredModelCapability = (capability: ModelCapability, enabled: boolean) => {
    const id = normalizeExplicitProviderModelId(providerModelDraft);
    if (!id) return;
    const targetProvider = providerForExplicitModelId(id);
    if (targetProvider && targetProvider !== onlineConfigProvider && !selectedOnlineProvider.custom) {
      setMessage(`“${id}”属于“${targetProvider}”，请先点击“加入模型库”，系统会切换到正确平台。`);
      return;
    }
    const classified = classifyProviderModel(id);
    const existing = selectedOnlineProviderModels.find((model) => model.id === id);
    const currentCapabilities = capabilitiesForModel(existing || classified);
    const nextCapabilities = enabled
      ? [...new Set([...currentCapabilities, capability])]
      : currentCapabilities.filter((item) => item !== capability);
    const primaryKind = existing?.kind !== "unknown" && existing?.kind && nextCapabilities.includes(existing.kind)
      ? existing.kind
      : nextCapabilities[0] || "unknown";
    const detectedModel: DetectedProviderModel = {
      ...classified,
      ...existing,
      id,
      kind: primaryKind,
      capabilities: nextCapabilities,
      purpose: nextCapabilities.length
        ? `${nextCapabilities.map(modelCapabilityLabel).join(" / ")}生成模型`
        : "用途待确认，不会自动用于生成",
    };
    const detectedModels = [
      ...(selectedOnlineProvider.detectedModels || []).filter((model) => model.id !== id),
      detectedModel,
    ];
    const capabilities = [...new Set(detectedModels.flatMap(capabilitiesForModel))];
    updateOnlineProviderConfig({ detectedModels, capabilities, model: selectedOnlineProvider.model || id });
  };
  const addMcpServer = () => {
    const id = newId();
    const server: McpServerConfig = { id, name: "新 MCP 服务", endpoint: "http://127.0.0.1:3000/mcp", token: "", enabled: true, tools: [] };
    setMcpServers((current) => [...current, server]);
    setActiveMcpServer(id);
  };
  const updateMcpServer = (id: string, patch: Partial<McpServerConfig>) => setMcpServers((current) => current.map((server) => server.id === id ? { ...server, ...patch } : server));
  const testMcpServer = async (server: McpServerConfig) => {
    if (!server.endpoint.trim()) { setMessage("请先填写 MCP Streamable HTTP 地址"); return; }
    setTestingMcp(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ server_name: string; protocol_version: string; tools: McpToolInfo[] }>("test_mcp_server", { endpoint: server.endpoint, token: server.token || null });
      updateMcpServer(server.id, { name: server.name === "新 MCP 服务" ? result.server_name : server.name, tools: result.tools, lastStatus: `已连接 · ${result.protocol_version} · ${result.tools.length} 个工具` });
      setMessage(`MCP 已连接，发现 ${result.tools.length} 个工具`);
    } catch (error) {
      const detail = humanizeApiError(error);
      updateMcpServer(server.id, { lastStatus: `连接失败 · ${detail}` });
      setMessage(`MCP 连接失败：${detail}`);
    } finally { setTestingMcp(false); }
  };
  const cloudConfigured = Boolean(cloudSettings.endpoint.trim() && cloudSettings.accessToken.trim());

  // 有些 Windows 文件选择器会把音频 MIME 标成 video/*。用扩展名校正旧项目和新导入，
  // 让 MP3 永远进入音频节点、素材库和粗剪预览音轨。
  useEffect(() => {
    setProject((current) => {
      let changed = false;
      const nodes = current.nodes.map((node) => {
        const inferred = mediaKindFromName(node.fileName || node.name);
        if (!inferred || inferred === node.kind || (node.kind !== "image" && node.kind !== "video" && node.kind !== "audio")) return node;
        changed = true;
        const [width, height] = nodeSize[inferred];
        return {
          ...node,
          kind: inferred,
          width,
          height,
          mediaWidth: inferred === "audio" ? undefined : node.mediaWidth,
          mediaHeight: inferred === "audio" ? undefined : node.mediaHeight,
        };
      });
      const next = changed ? { ...current, nodes } : current;
      if (next !== current) projectRef.current = next;
      return next;
    });
  }, []);
  const drag = useRef<{
    startX: number;
    startY: number;
    origin: Project["view"];
  } | null>(null);
  const moving = useRef<{
    startX: number;
    startY: number;
    nodes: Record<string, { x: number; y: number }>;
    sourceId?: string;
    groupBounds?: { minX: number; minY: number; maxX: number; maxY: number };
    isGroupDrag?: string;
    startBounds?: { x: number; y: number; w: number; h: number };
    startProject: Project;
  } | null>(null);
  const marquee = useRef<{ x: number; y: number } | null>(null);
  const marqueeIncludesLinks = useRef(false);
  const lineMarquee = useRef<{ x: number; y: number } | null>(null);
  const pendingChange = useRef<((project: Project) => Project) | null>(null);
  const frame = useRef<number | null>(null);
  const autoConnectSequence = useRef(0);
  // FileReader callbacks are asynchronous too. A later project switch or a
  // second import must make an earlier selected JSON file harmless.
  const projectImportSequence = useRef(0);
  const activeProjectImportReader = useRef<FileReader | null>(null);
  const undoHistory = useRef<Project[]>([]);
  // All asynchronous adapters share this registry. A completion may only
  // mutate the canvas while its exact project/node/run token is still active.
  const runRegistry = useRef(createRunRegistry());
  const activeProjectIdRef = useRef(historyId);
  const linking = useRef<{ from: string; x: number; y: number; side: "in" | "out" } | null>(null);
  const [draftLink, setDraftLink] = useState<{
    from: string;
    x: number;
    y: number;
    side: "in" | "out";
  } | null>(null);
  const [linkAddMenu, setLinkAddMenu] = useState<{
    x: number;
    y: number;
    point: { x: number; y: number };
    from: string;
    side: "in" | "out";
  } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const transientView = useRef<Project["view"] | null>(null);
  const transientNodePositions = useRef<Map<string, { x: number; y: number }>>(new Map());
  const fileRef = useRef<HTMLInputElement>(null);
  const onlineReferenceRef = useRef<HTMLInputElement>(null);
  const textMediaRef = useRef<HTMLInputElement>(null);
  const apiRef = useRef<HTMLInputElement>(null);
  const pendingKind = useRef<Kind>("image");
  const [mediaTarget, setMediaTarget] = useState<string | null>(null);
  const [externalTextTarget, setExternalTextTarget] = useState<string | null>(
    null,
  );
  const [externalDropActive, setExternalDropActive] = useState(false);
  const [apiPoint, setApiPoint] = useState<{ x: number; y: number } | null>(
    null,
  );
  const pastePoint = useRef<{ x: number; y: number } | null>(null);

  /**
   * A project import is a document-level operation. Abort the old reader when
   * a newer file is selected or the active document changes; the sequence
   * check remains as a second guard because FileReader abort events are async.
   */
  const invalidatePendingProjectImport = () => {
    projectImportSequence.current += 1;
    const reader = activeProjectImportReader.current;
    activeProjectImportReader.current = null;
    if (reader?.readyState === FileReader.LOADING) reader.abort();
  };
  /**
   * Apply the final drag/pan/resize frame before a synchronous save. React may
   * not render that frame before a close event, but the ref is the snapshot
   * persisted by the project repository.
   */
  const flushPendingFrameChange = () => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    frame.current = null;
    const pending = pendingChange.current;
    pendingChange.current = null;
    if (!pending) return projectRef.current;
    const updated = pending(projectRef.current);
    projectRef.current = updated;
    setProject(updated);
    return updated;
  };
  const persistProjectSnapshot = (
    snapshot: Project,
    id = historyIdRef.current,
    name = projectNameRef.current,
    announce = false,
  ) => {
    const record: HistoryProject = {
      id,
      name: name.trim() || "未命名项目",
      updatedAt: Date.now(),
      project: safeProject(snapshot),
    };
    try {
      // A switch must never depend on the next debounce tick to protect the
      // user's most recent edit. The repository keeps the document, active
      // pointer and small index ordered; only documents intentionally pushed
      // beyond the history cap may be removed, and only after a successful
      // index write.
      const saved = saveProjectWorkspace(localStorage, record, historyProjectsRef.current);
      historyProjectsRef.current = saved.records;
      setHistoryProjects(saved.records);
      if (announce) setMessage("已离线保存");
      return true;
    } catch {
      if (announce) setMessage("媒体较大：自动保存空间不足，请立即使用“导出项目”完整保存");
      return false;
    }
  };
  const flushActiveProjectSave = () =>
    persistProjectSnapshot(flushPendingFrameChange(), historyIdRef.current, projectNameRef.current);
  /**
   * Atomically retire the old project's asynchronous work before React shows a
   * different document.  Updating the refs synchronously closes the small
   * window between an event handler calling setProject/setHistoryId and the
   * next render, where a slow network/FileReader result used to write into the
   * newly selected project.
  */
  const activateProjectIdentity = (nextId: string, nextName: string, nextProject: Project) => {
    const previousId = historyIdRef.current;
    // Treat every activation as an execution boundary. All current callers
    // switch ids, but retaining this invariant also protects a future
    // “reload this project” action from accepting a stale result.
    runRegistry.current.invalidateProject(previousId);
    invalidatePendingProjectImport();
    // A drag/resize/pan update is scheduled on the next animation frame. It
    // belongs to the document in which the gesture began, never to the next
    // project selected before that frame has run.
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    frame.current = null;
    pendingChange.current = null;
    drag.current = null;
    moving.current = null;
    marquee.current = null;
    marqueeIncludesLinks.current = false;
    lineMarquee.current = null;
    linking.current = null;
    setDraftLink(null);
    legacyMigrationSequence.current += 1;
    setLegacyMigrationProgress((current) => current.running
      ? { ...current, running: false, current: "已因项目切换停止" }
      : current);
    activeProjectIdRef.current = nextId;
    historyIdRef.current = nextId;
    projectNameRef.current = nextName;
    projectRef.current = nextProject;
  };
  const canCommitRun = (token: RunToken) =>
    activeProjectIdRef.current === token.projectId &&
    runRegistry.current.canCommit(token.projectId, token.nodeId, token.runId) &&
    projectRef.current.nodes.some((node) => node.id === token.nodeId);
  /**
   * A run owns both a node token and the exact graph inputs it was submitted
   * with.  Stopping/restarting/switching projects is handled by RunRegistry;
   * this extra check covers a different case: the user edits the prompt,
   * reference media, upstream text or bound workflow while a provider is
   * still working.  That old result must never overwrite the edited card.
   */
  const canCommitRunWithInputs = (token: RunToken, inputSignature: string) => {
    if (!canCommitRun(token)) return false;
    if (createExecutionInputSignature(projectRef.current, token.nodeId) === inputSignature) return true;

    // Cancel only this exact token.  If the user has already started a newer
    // run, RunRegistry rejects the cancellation and we leave its UI untouched.
    if (runRegistry.current.cancel(token.projectId, token.nodeId, token.runId)) {
      setRuntimeNodeStatus(token.nodeId, "idle");
      addLog(`已丢弃 ${token.nodeId} 的旧生成结果：运行期间输入、参考素材或工作流已变更`);
      setMessage("生成期间已修改提示词、参考素材或工作流，旧结果已丢弃；请重新生成。");
    }
    return false;
  };
  const resetProjectSession = () => {
    // None of these UI handles describe the next document. Keeping even one
    // of them alive can make an old node id receive edits or diagnostics after
    // a history/open/import transition.
    setSelected([]);
    setSelectedLinks([]);
    setClipboard([]);
    setRecent([]);
    setRecentOpen(false);
    setActiveText(null);
    setActiveStoryboard(null);
    setActiveAiNode(null);
    setActiveOnlineVideo(null);
    setActiveApiConfig(null);
    setApiPoint(null);
    setMediaTarget(null);
    setExternalTextTarget(null);
    setDropTextTarget(null);
    setMediaPickerText(null);
    setEditingAnnotation(null);
    setPreviewImage(null);
    setStoryboardPaste("");
    setSelectionBox(null);
    setLineSelectionBox(null);
    setPanning(false);
    setOnlinePopover(null);
    setAtReferenceMenu(null);
    setPromptLibraryText("");
    setGroupNameInput(null);
    setMenu(null);
    setDisconnectMenu(null);
    setLinkAddMenu(null);
    setMediaLibraryOpen(false);
    setDirectorOpen(false);
    setWorkflowLibraryOpen(false);
    setComfyDiagnostics({});
    setExpandedComfyDiagnostics(null);
    setLogs([]);
    setLogsOpen(false);
    setSettings(false);
    setPreferences(false);
    setOnlineApiOpen(false);
    setCloudPointsOpen(false);
    setProviderTestResult(null);
    setTopMenuOpen(false);
    setCanvasShortcutsOpen(false);
    setNavOpen(false);
    setStudioOpen(false);
    setCinematicLandingOpen(false);
  };
  useEffect(() => {
    activeProjectIdRef.current = historyId;
    undoHistory.current = [];
  }, [historyId]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const updateCanvasSize = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      setCanvasSize((current) => current.width === width && current.height === height
        ? current
        : { width, height });
    };
    updateCanvasSize();
    const observer = new ResizeObserver(updateCanvasSize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    // Save on the user's wall-clock cadence. Refs always point at the active
    // project, so continuous editing cannot postpone the save and switching
    // projects cannot make the timer write an old document.
    let idleSave: number | null = null;
    const save = () => {
      idleSave = null;
      void persistProjectSnapshot(
        flushPendingFrameChange(),
        historyIdRef.current,
        projectNameRef.current,
        true,
      );
    };
    const timer = window.setInterval(() => {
      // localStorage serialization is synchronous. Use an idle slot so the
      // autosave clock does not interrupt a keystroke or an active gesture.
      if (idleSave !== null) return;
      idleSave = "requestIdleCallback" in window
        ? window.requestIdleCallback(save, { timeout: 15_000 })
        : setTimeout(save, 750);
    }, autosaveMinutes * 60 * 1000);
    return () => {
      window.clearInterval(timer);
      if (idleSave !== null) {
        if ("cancelIdleCallback" in window) window.cancelIdleCallback(idleSave);
        else clearTimeout(idleSave);
      }
    };
  }, [autosaveMinutes]);
  useEffect(() => {
    // `pagehide` covers the desktop WebView closing path and `beforeunload`
    // covers browser development mode. Both handlers are synchronous by
    // design: localStorage is the last reliable point before the process exits.
    const flushBeforeLeaving = () => {
      flushActiveProjectSave();
    };
    window.addEventListener("pagehide", flushBeforeLeaving);
    window.addEventListener("beforeunload", flushBeforeLeaving);
    return () => {
      window.removeEventListener("pagehide", flushBeforeLeaving);
      window.removeEventListener("beforeunload", flushBeforeLeaving);
    };
  }, []);
  useEffect(() => {
    localStorage.setItem("comfy-bridge", apiUrl);
  }, [apiUrl]);
  useEffect(() => {
    localStorage.setItem("ym-default-save-dir", defaultSaveDir);
  }, [defaultSaveDir]);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<string>("get_workspace_asset_root"))
      .then((path) => {
        if (active) setWorkspaceAssetDir(path);
      })
      .catch(() => {
        if (active) setWorkspaceAssetDir("暂时无法读取本机素材目录");
      });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    localStorage.setItem(AUTOSAVE_MINUTES_STORE, String(autosaveMinutes));
  }, [autosaveMinutes]);
  useEffect(() => {
    localStorage.setItem(ONLINE_PROVIDER_STORE, JSON.stringify(onlineProviderConfigs));
  }, [onlineProviderConfigs]);
  useEffect(() => {
    localStorage.setItem(CATEGORY_PROVIDER_STORE, JSON.stringify(categoryProviderConfigs));
  }, [categoryProviderConfigs]);
  useEffect(() => {
    localStorage.setItem(MCP_SERVER_STORE, JSON.stringify(mcpServers));
  }, [mcpServers]);
  useEffect(() => {
    localStorage.setItem(CLOUD_STORE, JSON.stringify(cloudSettings));
  }, [cloudSettings]);
  useEffect(() => {
    const clear = () => {
      setMenu(null);
      setDisconnectMenu(null);
    };
    window.addEventListener("pointerdown", clear);
    return () => window.removeEventListener("pointerdown", clear);
  }, []);
  useEffect(() => {
    const stopDrag = () => {
      drag.current = null;
      moving.current = null;
      linking.current = null;
      setDraftLink(null);
      setPanning(false);
    };
    window.addEventListener("pointerup", stopDrag);
    return () => window.removeEventListener("pointerup", stopDrag);
  }, []);
  const selectedNodes = useMemo(
    () => project.nodes.filter((n) => selected.includes(n.id)),
    [project.nodes, selected],
  );
  const studioStats = useMemo(
    () => ({
      script: project.nodes.filter((node) => node.kind === "text").length,
      media: project.nodes.filter((node) =>
        ["image", "video", "audio"].includes(node.kind),
      ).length,
      workflow: project.nodes.filter((node) => node.kind === "api").length,
      output: recent.length,
    }),
    [project.nodes, recent.length],
  );
  const activeTextNode = useMemo(
    () => project.nodes.find((node) => node.id === activeText) || null,
    [project.nodes, activeText],
  );
  const activeOnlineVideoNode = useMemo(
    () => project.nodes.find((node) => node.id === activeOnlineVideo && (node.kind === "onlineVideo" || node.kind === "video")) || null,
    [project.nodes, activeOnlineVideo],
  );
  const activeAiNodeItem = useMemo(
    () => project.nodes.find((node) => node.id === activeAiNode && (node.kind === "aiText" || node.kind === "aiImage" || node.kind === "text" || node.kind === "image")) || null,
    [project.nodes, activeAiNode],
  );
  const activeComfyApiNode = useMemo(
    () => project.nodes.find((node) => node.id === activeApiConfig && node.kind === "api" && !node.onlineProvider) || null,
    [project.nodes, activeApiConfig],
  );
  const activeAiReferences = useMemo(
    () => activeAiNodeItem ? project.links
      .filter((link) => link.to === activeAiNodeItem.id)
      .map((link) => project.nodes.find((node) => node.id === link.from))
      .filter((node): node is NodeItem => Boolean(node?.kind === "image" && node.src))
      .map((node) => ({ id: node.id, name: node.name, src: node.src! })) : [],
    [project.links, project.nodes, activeAiNodeItem],
  );
  const activeAiLinkedTextInputs = useMemo(
    () => activeAiNodeItem ? project.links
      .filter((link) => link.to === activeAiNodeItem.id)
      .map((link) => project.nodes.find((node) => node.id === link.from))
      .map((node) => node?.kind === "text" ? node.text || "" : node?.kind === "storyboard" ? storyboardText(node.storyboard) : "")
      .filter((text) => text.trim()) : [],
    [project.links, project.nodes, activeAiNodeItem],
  );
  const canvasAiImages = useMemo(
    () => project.nodes
      .filter((node): node is NodeItem & { src: string } => node.kind === "image" && Boolean(node.src))
      .map((node) => ({ id: node.id, name: node.name, src: node.src })),
    [project.nodes],
  );
  const activeTextSources = useMemo(
    () =>
      activeTextNode
        ? (project.links
            .filter((link) => link.to === activeTextNode.id)
            .map((link) => project.nodes.find((node) => node.id === link.from))
            .filter(Boolean) as NodeItem[])
        : [],
    [project.links, project.nodes, activeTextNode],
  );
  useEffect(() => {
    const field = document.querySelector<HTMLTextAreaElement>(
      ".script-composer textarea",
    );
    if (!field) return;
    field.style.height = "auto";
    const maximum = Math.max(112, Math.floor(window.innerHeight * 0.5) - 138);
    field.style.height = `${Math.min(field.scrollHeight, maximum)}px`;
  }, [activeText, activeTextNode?.text]);
  const activeStoryboardNode = useMemo(
    () => project.nodes.find((node) => node.id === activeStoryboard) || null,
    [project.nodes, activeStoryboard],
  );
  const canvasMedia = useMemo(
    () =>
      project.nodes.filter(
        (node) =>
          (node.kind === "image" || node.kind === "video") && Boolean(node.src),
      ),
    [project.nodes],
  );
  const change = (fn: (p: Project) => Project) =>
    setProject((current) => {
      const next = fn(current);
      if (next !== current) {
        undoHistory.current = [
          ...undoHistory.current.slice(-5),
          // 项目采用不可变更新；保留旧引用即可撤销，避免大型视频 Data URL
          // 在每一次移动节点时被完整序列化，造成素材库和画布卡顿。
          current,
        ];
        projectRef.current = next;
      }
      return next;
    });
  // Loading/error labels belong to a running task, not to the user's edit
  // history.  Keeping them out of `change()` prevents Ctrl+Z from restoring a
  // stale “running” card after a task has already completed or been stopped.
  const setRuntimeNodeStatus = (nodeId: string, status: NodeItem["status"]) =>
    setProject((current) => {
      let changed = false;
      const nodes = current.nodes.map((node) => {
        if (node.id !== nodeId || node.status === status) return node;
        changed = true;
        return { ...node, status };
      });
      const next = changed ? { ...current, nodes } : current;
      if (next !== current) projectRef.current = next;
      return next;
    });
  /**
   * The renderer can draw a link before a provider has a chance to consume it.
   * Keep the graph contract at the execution boundary too: otherwise an old
   * project or an imported workflow can still submit an orphaned/mismatched
   * connection even though new links are checked when they are created.
   */
  const validateExecutionGraph = (nodeId: string, actionLabel: string, projectSnapshot: Project = projectRef.current) => {
    const plan = planExecution(projectSnapshot, { scope: "single", nodeId });
    const relevantNodeIds = new Set([nodeId, ...plan.upstreamNodeIds]);
    const relevantIssues = plan.issues.filter((issue) => relevantNodeIds.has(issue.nodeId));
    const blockingIssues = relevantIssues.filter((issue) => issue.severity === "error");
    const issuesByNode = new Map<string, ExecutionPlanIssue[]>();
    blockingIssues.forEach((issue) => {
      const current = issuesByNode.get(issue.nodeId) || [];
      current.push(issue);
      issuesByNode.set(issue.nodeId, current);
    });

    // Graph preflight feedback is transient state, not an edit the user should
    // need to undo.  It is deliberately stored with the project only so the
    // affected cards turn red and explain the exact repair point.
    setProject((current) => {
      let changed = false;
      const nodes = current.nodes.map((candidate) => {
        if (!relevantNodeIds.has(candidate.id)) return candidate;
        const nextErrors = [
          ...withoutExecutionValidationErrors(candidate.validationErrors),
          ...(issuesByNode.get(candidate.id) || []).map(
            (issue) => `${EXECUTION_VALIDATION_PREFIX}${executionPlanIssueText(issue)}`,
          ),
        ];
        const previous = candidate.validationErrors || [];
        if (previous.length === nextErrors.length && previous.every((entry, index) => entry === nextErrors[index])) {
          return candidate;
        }
        changed = true;
        return { ...candidate, validationErrors: nextErrors };
      });
      const next = changed ? { ...current, nodes } : current;
      if (next !== current) projectRef.current = next;
      return next;
    });

    if (!plan.blockedNodeIds.includes(nodeId)) {
      relevantIssues
        .filter((issue) => issue.severity === "warning")
        .forEach((issue) => addLog(`${actionLabel}运行前检查：${executionPlanIssueText(issue)}`));
      return true;
    }

    const targetIssue = blockingIssues.find((issue) => issue.nodeId === nodeId) || blockingIssues[0];
    const detail = targetIssue
      ? executionPlanIssueText(targetIssue)
      : "存在未修复的连线或上游依赖。";
    addLog(`${actionLabel}运行前检查未通过：${detail}`);
    setMessage(`${actionLabel}未提交：${detail}`);
    return false;
  };
  const connectCanvasNodes = (
    from: string,
    to: string,
    options: NewLinkOptions = {},
  ) => {
    const proposal = appendTypedLink(project, from, to, options);
    if (proposal.issues.length) {
      const detail = graphIssueText(proposal.issues);
      setProject((current) => {
        const next = {
          ...current,
          nodes: current.nodes.map((node) => node.id === to
            ? {
                ...node,
                validationErrors: [
                  ...(node.validationErrors || []).filter((entry) => !entry.startsWith(GRAPH_VALIDATION_PREFIX)),
                  `${GRAPH_VALIDATION_PREFIX}${detail}`,
                ],
              }
            : node),
        };
        projectRef.current = next;
        return next;
      });
      setMessage(`无法连接：${detail}`);
      return false;
    }
    change((current) => {
      const clean = {
        ...current,
        nodes: current.nodes.map((node) => node.id === to
          ? {
              ...node,
              validationErrors: (node.validationErrors || []).filter((entry) => !entry.startsWith(GRAPH_VALIDATION_PREFIX)),
            }
          : node),
      };
      return appendTypedLink(clean, from, to, options).project;
    });
    setMessage("节点已按数据类型连接");
    return true;
  };
  const undo = () => {
    // Do not let a drag frame queued just before Ctrl+Z run after the restored
    // snapshot and appear as an unexplained extra move.
    flushPendingFrameChange();
    const previous = undoHistory.current.pop();
    if (!previous) return;
    // A saved edit snapshot must never resurrect an old asynchronous status.
    // normalizeProject resets transient running/stopping states while keeping
    // the user-authored nodes, links, groups and view intact.
    // Undo changes the user's intended graph. Do not let an in-flight request
    // from the graph we just reverted append an output afterward.
    runRegistry.current.invalidateProject(activeProjectIdRef.current);
    const restored = safeProject(previous);
    projectRef.current = restored;
    setProject(restored);
    setSelected([]);
    setMenu(null);
    setMessage("已撤销上一步操作");
  };
  useEffect(() => {
    const isEditable = (target: EventTarget | null) =>
      target instanceof Element &&
      Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
    const clearStaticSelection = () => {
      if (isEditable(document.activeElement)) return;
      const selection = window.getSelection();
      if (selection?.rangeCount) selection.removeAllRanges();
    };
    // F7 is a WebView2 browser accelerator for caret browsing.  Capture all
    // key phases before the canvas and keep static labels from retaining a
    // browser-selection caret should a previous WebView session have enabled
    // it.  Inputs/textareas stay fully selectable and editable.
    const blockCaretBrowsing = (event: KeyboardEvent) => {
      if (event.key !== "F7") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      clearStaticSelection();
    };
    const preventStaticSelection = (event: Event) => {
      if (isEditable(event.target)) return;
      event.preventDefault();
      clearStaticSelection();
    };
    const dismissStaticSelection = (event: Event) => {
      if (!isEditable(event.target)) clearStaticSelection();
    };
    const onSelectionChange = () => clearStaticSelection();
    const style = document.createElement("style");
    style.dataset.caretGuard = "true";
    style.textContent = [
      ".app, .app *:not(input):not(textarea):not(select):not([contenteditable='true']) { caret-color: transparent !important; }",
      ".app input, .app textarea, .app select, .app [contenteditable='true'] { caret-color: auto !important; }",
    ].join("\n");
    document.head.appendChild(style);
    window.addEventListener("keydown", blockCaretBrowsing, true);
    window.addEventListener("keyup", blockCaretBrowsing, true);
    document.addEventListener("selectstart", preventStaticSelection, true);
    document.addEventListener("pointerdown", dismissStaticSelection, true);
    document.addEventListener("selectionchange", onSelectionChange, true);
    return () => {
      window.removeEventListener("keydown", blockCaretBrowsing, true);
      window.removeEventListener("keyup", blockCaretBrowsing, true);
      document.removeEventListener("selectstart", preventStaticSelection, true);
      document.removeEventListener("pointerdown", dismissStaticSelection, true);
      document.removeEventListener("selectionchange", onSelectionChange, true);
      style.remove();
    };
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = Boolean(
        target?.closest("input, textarea, [contenteditable='true']"),
      );
      // WebView/Chromium uses F7 for caret browsing. In a node canvas this
      // makes static labels look like broken editable text, so keep it off.
      if (event.key === "F7") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === "z" && !editing) {
        event.preventDefault();
        undo();
      }
      if (event.ctrlKey && event.key.toLowerCase() === "a" && !editing) {
        event.preventDefault();
        setSelected(project.nodes.map((node) => node.id));
        setMessage(`已全选 ${project.nodes.length} 个内容`);
      }
      if (event.ctrlKey && event.key.toLowerCase() === "s" && !editing) {
        event.preventDefault();
        exportProject();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [project.nodes]);
  const frameChange = (fn: (p: Project) => Project) => {
    pendingChange.current = fn;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      const next = pendingChange.current;
      pendingChange.current = null;
      frame.current = null;
      if (next) {
        setProject((current) => {
          const updated = next(current);
          projectRef.current = updated;
          return updated;
        });
      }
    });
  };
  const world = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const view = transientView.current || projectRef.current.view;
    return {
      x: (clientX - rect.left - view.x) / view.zoom,
      y: (clientY - rect.top - view.y) / view.zoom,
    };
  };
  const viewportCenter = () => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect
      ? {
          x: (rect.width / 2 - project.view.x) / project.view.zoom,
          y: (rect.height / 2 - project.view.y) / project.view.zoom,
        }
      : { x: 360, y: 260 };
  };
  const navigateTo = (worldX: number, worldY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    change((p) => ({
      ...p,
      view: { ...p.view, x: rect.width / 2 - worldX * p.view.zoom, y: rect.height / 2 - worldY * p.view.zoom },
    }));
  };
  const addAtViewport = (kind: Kind, extra: Partial<NodeItem> = {}) => {
    const point = viewportCenter();
    const [width, height] = nodeSize[kind];
    return add(kind, { x: point.x - width / 2, y: point.y - height / 2 }, extra);
  };
  const openComfyNodeParameters = (node: NodeItem) => {
    const current = node.workflow;
    const packaged: ComfyCanvasWorkflow = isComfyCanvasWorkflow(current) ? current : {
      __ymComfyPackage: true,
      content: current,
      parameters: scanComfyParameters(current),
      values: {},
    };
    if (!isComfyCanvasWorkflow(current)) {
      change((project) => ({ ...project, nodes: project.nodes.map((item) => item.id === node.id ? { ...item, workflow: packaged } : item) }));
    }
    setActiveApiConfig(node.id);
  };
  const configureOpenAi = () => {
    const endpoint = window.prompt("OpenAI 接口地址", openAiConfig.endpoint || "https://api.openai.com/v1");
    if (endpoint === null) return;
    const apiKey = window.prompt("OpenAI API Key", openAiConfig.apiKey || "");
    if (apiKey === null) return;
    const model = window.prompt("图片模型", openAiConfig.model || "gpt-image-1");
    if (model === null) return;
    const next = { endpoint, apiKey, model };
    setOpenAiConfig(next);
    localStorage.setItem("ym-openai-config", JSON.stringify(next));
    setMessage("OpenAI 默认配置已保存，新节点会自动使用");
  };
  const addLog = (entry: string) => setLogs((items) => [`${new Date().toLocaleTimeString()}  ${entry}`, ...items].slice(0, 80));
  const recoverComfyVideoPreview = async (node: NodeItem, source: string | undefined) => {
    const descriptor = parseComfyViewSource(source);
    if (!descriptor) {
      if (node.mediaFallbackTried) return;
      change((current) => ({
        ...current,
        nodes: current.nodes.map((item) => item.id === node.id ? {
          ...item,
          mediaFallbackTried: true,
          validationErrors: [...new Set([...(item.validationErrors || []), "媒体预览无法读取：没有可恢复的 ComfyUI output 地址。"])],
        } : item),
      }));
      setMessage("视频预览无法读取：该旧节点没有可恢复的 ComfyUI 输出地址，请重新生成或重新导入原文件。");
      return;
    }
    const sourceProjectId = historyIdRef.current;
    const recoveryKey = `${sourceProjectId}\u0000${node.id}\u0000${descriptor.sourceUrl}`;
    if (mediaRecoveryAttempted.current.has(recoveryKey)) return;
    mediaRecoveryAttempted.current.add(recoveryKey);
    setMessage(`正在通过桌面后端恢复视频“${descriptor.filename}”…`);
    try {
      const recovered = await cacheComfyGeneratedMedia(descriptor.endpoint, descriptor, sourceProjectId);
      if (!recovered?.localPath) throw new Error("桌面后端没有返回可播放的缓存路径");
      if (historyIdRef.current !== sourceProjectId || !projectRef.current.nodes.some((item) => item.id === node.id)) {
        if (recovered.managedAsset) await cleanupUnattachedWorkspaceAsset(recovered.managedAsset, []);
        return;
      }
      change((current) => ({
        ...current,
        nodes: current.nodes.map((item) => item.id === node.id ? {
          ...item,
          src: recovered.src,
          localPath: recovered.localPath,
          fallbackSrc: descriptor.sourceUrl,
          mediaFallbackTried: false,
          validationErrors: (item.validationErrors || []).filter((error) => !error.startsWith("媒体预览无法读取")),
        } : item),
      }));
      addLog(`ComfyUI 视频恢复：已通过桌面后端缓存 ${descriptor.filename}`);
      setMessage(`视频“${descriptor.filename}”已恢复到本机素材库，画布将重新载入画面。`);
    } catch (error) {
      const detail = humanizeApiError(error);
      change((current) => ({
        ...current,
        nodes: current.nodes.map((item) => item.id === node.id ? {
          ...item,
          mediaFallbackTried: true,
          validationErrors: [...new Set([...(item.validationErrors || []).filter((message) => !message.startsWith("媒体预览无法读取")), `媒体预览无法读取：桌面后端恢复失败（${detail}）`])],
        } : item),
      }));
      addLog(`ComfyUI 视频恢复失败：${detail}`);
      setMessage(`视频恢复失败：${detail}`);
    }
  };
  const legacyMigrationPlan = useMemo(
    () => planLegacyMediaMigration(project, historyId),
    // View movement does not change inline media. Avoid rescanning every node
    // after a pan/zoom-only project update.
    [historyId, project.nodes],
  );
  const migrateLegacyMedia = async () => {
    if (legacyMigrationProgress.running) return;
    const plan = planLegacyMediaMigration(projectRef.current, historyIdRef.current);
    if (!plan.items.length) {
      setMessage("当前项目没有需要迁移的旧版内嵌媒体。");
      setTopMenuOpen(false);
      return;
    }
    if (!isTauri()) {
      setMessage(`检测到 ${plan.items.length} 项旧版内嵌媒体。浏览器预览没有本机素材仓库，请用桌面开发版打开项目后再迁移。`);
      setTopMenuOpen(false);
      return;
    }

    const session = ++legacyMigrationSequence.current;
    let completed = 0;
    let failed = 0;
    let skipped = 0;
    setLegacyMigrationProgress({ running: true, total: plan.items.length, completed, failed, skipped, current: "准备迁移" });
    setMessage(`开始迁移 ${plan.items.length} 项旧媒体；原内容会保留到每一项成功写入后。`);

    for (let index = 0; index < plan.items.length; index += 1) {
      const item = plan.items[index];
      const isCurrentSession = () => legacyMigrationSequence.current === session;
      if (!isCurrentSession() || activeProjectIdRef.current !== plan.projectId) {
        skipped += plan.items.length - index;
        break;
      }
      if (!canApplyLegacyMediaMigration(plan, activeProjectIdRef.current, projectRef.current, item)) {
        skipped += 1;
        setLegacyMigrationProgress({ running: true, total: plan.items.length, completed, failed, skipped, current: `已跳过：${item.label}` });
        continue;
      }

      setLegacyMigrationProgress({ running: true, total: plan.items.length, completed, failed, skipped, current: item.label });
      setMessage(`正在迁移 ${index + 1}/${plan.items.length}：${item.label}`);
      let uploadedAsset: ManagedWorkspaceAsset | undefined;
      try {
        const asset = await uploadWorkspaceAsset({
          projectId: plan.projectId,
          assetId: `legacy-${newId()}`,
          file: legacyDataUrlToBlob(item.dataUrl),
          fileName: item.fileName,
          mimeType: item.mimeType,
        });
        uploadedAsset = asset;
        if (!asset.localPath) {
          await cleanupUnattachedWorkspaceAsset(asset, [projectRef.current]);
          uploadedAsset = undefined;
          throw new Error("本机素材仓库没有返回文件路径");
        }

        // Upload completion is not permission to write. Re-check both the
        // maintenance session and the exact source against the latest project.
        if (!isCurrentSession() || !canApplyLegacyMediaMigration(plan, activeProjectIdRef.current, projectRef.current, item)) {
          skipped += 1;
          await cleanupUnattachedWorkspaceAsset(asset, [projectRef.current]);
          uploadedAsset = undefined;
          setLegacyMigrationProgress({ running: true, total: plan.items.length, completed, failed, skipped, current: `已拒绝过期回写：${item.label}` });
          continue;
        }

        const applied = applyLegacyMediaMigration(projectRef.current, item, {
          src: convertFileSrc(asset.localPath),
          localPath: asset.localPath,
          asset,
        });
        if (!applied.applied) {
          skipped += 1;
          await cleanupUnattachedWorkspaceAsset(asset, [projectRef.current]);
          uploadedAsset = undefined;
          continue;
        }
        projectRef.current = applied.project;
        setProject(applied.project);
        uploadedAsset = undefined;
        completed += 1;
      } catch (error) {
        if (uploadedAsset) await cleanupUnattachedWorkspaceAsset(uploadedAsset, [projectRef.current]);
        failed += 1;
        addLog(`旧媒体迁移失败 · ${item.label}：${error instanceof Error ? error.message : String(error)}`);
      }
      setLegacyMigrationProgress({ running: true, total: plan.items.length, completed, failed, skipped, current: item.label });
    }

    const stillActive = legacyMigrationSequence.current === session && activeProjectIdRef.current === plan.projectId;
    if (stillActive) {
      const saved = persistProjectSnapshot(projectRef.current, plan.projectId, projectNameRef.current);
      const remaining = planLegacyMediaMigration(projectRef.current, plan.projectId).items.length;
      setLegacyMigrationProgress({ running: false, total: plan.items.length, completed, failed, skipped, current: "" });
      setMessage(!saved
        ? `旧媒体已迁入本机仓库，但项目快照仍因本机存储不足未保存。请不要关闭应用，先“导出项目”留底后再清理旧项目存储。`
        : remaining === 0
        ? `旧媒体迁移完成：成功 ${completed} 项${skipped ? `，跳过 ${skipped} 项` : ""}。项目现在只保存本机素材引用。`
        : `旧媒体迁移完成：成功 ${completed} 项，失败 ${failed} 项，跳过 ${skipped} 项；仍有 ${remaining} 项，可再次点击迁移重试。`);
    }
  };
  const navigateFromMinimap = (event: React.MouseEvent<HTMLDivElement>) => {
    const map = event.currentTarget.getBoundingClientRect();
    const canvas = canvasRef.current?.getBoundingClientRect();
    if (!canvas) return;
    const x = ((event.clientX - map.left) / map.width) * 6000;
    const y = ((event.clientY - map.top) / map.height) * 3200;
    change((p) => ({
      ...p,
      view: {
        ...p.view,
        x: canvas.width / 2 - x * p.view.zoom,
        y: canvas.height / 2 - y * p.view.zoom,
      },
    }));
  };
  const add = (
    kind: Kind,
    at?: { x: number; y: number },
    extra: Partial<NodeItem> = {},
  ) => {
    const pos = at || { x: 320, y: 230 };
    const [width, height] = nodeSize[kind];
    const storyboard =
      kind === "storyboard" ? extra.storyboard || defaultStoryboard() : undefined;
    const item: NodeItem = {
      id: newId(),
      kind,
      x: pos.x,
      y: pos.y,
      width,
      height,
      name: extra.name || typeLabel[kind],
      status: "idle",
      createdAt: extra.createdAt || Date.now(),
      ...extra,
      storyboard,
      text:
        kind === "storyboard"
          ? extra.text || storyboardText(storyboard)
          : extra.text,
    };
    change((p) => ({ ...p, nodes: [...p.nodes, item] }));
    setSelected([item.id]);
    return item;
  };
  const aiTextWorkflowFor = (outputMode: "script" | "storyboardFrames" = "script"): AiTextSettings => {
    const connection = textProviderOptions[0];
    return {
      source: "byok", provider: connection?.name || "OpenAI", model: connection?.defaultModel || "gpt-4.1-mini",
      genre: "剧情短片", format: "标准影视剧本", length: "中篇",
      tone: "电影感", audience: "大众", language: "简体中文",
      creativity: 0.8, episodeCount: 1, episodeMinutes: 5,
      includeStoryboard: true, includeCharacters: true, outputMode,
      storyboardRatio: "16:9", storyboardStyle: "电影写实",
      storyboardFrames: [createStoryboardFramePlan(0)],
    };
  };
  const openTextAiComposer = (nodeId: string, outputMode: "script" | "storyboardFrames") => {
    change((current) => ({
      ...current,
      nodes: current.nodes.map((node) => {
        if (node.id !== nodeId) return node;
        const stored = (node.workflow || {}) as AiTextSettings;
        const workflow = node.workflow
          ? {
              ...aiTextWorkflowFor(outputMode),
              ...stored,
              outputMode,
              storyboardFrames: normalizeStoryboardFramePlans(stored.storyboardFrames),
            }
          : aiTextWorkflowFor(outputMode);
        return { ...node, workflow };
      }),
    }));
    setActiveText(null);
    setActiveStoryboard(null);
    setActiveAiNode(null);
    setActiveOnlineVideo(null);
    setActiveAiNode(nodeId);
  };
  const addAiTextNode = (at: { x: number; y: number }) => {
    return add("aiText", at, {
    name: "AI 剧本生成",
    workflow: aiTextWorkflowFor("script"),
  });
  };
  const addAiImageNode = (at: { x: number; y: number }) => {
    const connection = imageProviderOptions[0];
    return add("aiImage", at, {
    name: "AI 图片生成",
    workflow: {
      source: "byok", provider: connection?.name || "OpenAI", model: connection?.defaultModel || "gpt-image-1",
      mode: "text", ratio: "1:1", resolution: "1024", amount: 1,
      quality: "low", style: "电影写实", seed: -1, guidance: 7,
    } satisfies AiImageSettings,
  });
  };
  const addAiVideoNode = (at: { x: number; y: number }) => {
    const provider = onlineVideoProviderNames[0] || "未选择平台";
    const model = compatibleModelForProvider(provider, "video");
    const capabilities = videoCapabilitiesFor(provider, model);
    return add("onlineVideo", at, {
    name: "AI 视频生成",
    workflow: {
      source: "byok", provider, model, mode: capabilities.modes[0], ratio: "16:9",
      quality: "720P", duration: 5, amount: 1, audio: true,
    } satisfies OnlineVideoSettings,
  });
  };
  const addLinkedNode = (kind: Exclude<Kind, "api">) => {
    const link = linkAddMenu;
    if (!link) return;
    const [width, height] = nodeSize[kind];
    const storyboard = kind === "storyboard" ? defaultStoryboard() : undefined;
    const item: NodeItem = {
      id: newId(), kind, x: link.point.x, y: link.point.y, width, height, createdAt: Date.now(),
      name: typeLabel[kind], status: "idle", storyboard,
      text: kind === "storyboard" ? storyboardText(storyboard) : undefined,
    };
    const candidate = { ...project, nodes: [...project.nodes, item] };
    const from = link.side === "out" ? link.from : item.id;
    const to = link.side === "out" ? item.id : link.from;
    const connected = appendTypedLink(candidate, from, to);
    if (connected.issues.length) {
      setMessage(`无法添加并连接此节点：${graphIssueText(connected.issues)}`);
      return;
    }
    change(() => connected.project);
    setSelected([item.id]);
    setLinkAddMenu(null);
  };
  const openFile = (kind: Kind, nodeId: string) => {
    pendingKind.current = kind;
    setMediaTarget(nodeId);
    fileRef.current?.click();
  };
  const discardUnattachedImport = async (imported: ImportedWorkspaceMedia) => {
    const result = await cleanupUnattachedWorkspaceAsset(
      imported.managedAsset,
      [projectRef.current],
    );
    return result.status === "failed"
      ? " 新素材未能自动清理，请稍后在素材管理中重试。"
      : "";
  };
  const importOnlineReference = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const targetId = activeOnlineVideo;
    const sourceProjectId = historyIdRef.current;
    event.target.value = "";
    if (!file || !targetId) return;
    const kind = mediaKind(file);
    if (kind !== "image" && kind !== "video") {
      setMessage("参考内容仅支持图片或视频文件。");
      return;
    }
    const targetNode = project.nodes.find((node) => node.id === targetId);
    const targetConfig = (targetNode?.workflow || {}) as OnlineVideoSettings;
    if ((targetConfig.source || "byok") === "byok") {
      const providerConfig = resolvedProviderConfig(targetConfig.provider || "", "video");
      const model = compatibleModelForProvider(
        targetConfig.provider || "",
        "video",
        targetConfig.model,
        providerConfig?.model,
      );
      if (!model) {
        setMessage(`“${targetConfig.provider || "当前平台"}”没有已确认的视频模型，不能添加视频生成参考。`);
        return;
      }
      const capabilities = videoCapabilitiesFor(targetConfig.provider || "", model);
      const normalized = normalizeVideoGenerationOptions(capabilities, {
        mode: targetConfig.mode,
        amount: targetConfig.amount,
      });
      const limit = videoInputLimitForMode(capabilities, normalized.mode);
      const linkedImageIds = project.links
        .filter((link) => link.to === targetId)
        .map((link) => project.nodes.find((node) => node.id === link.from))
        .filter((node): node is NodeItem => node?.kind === "image" && Boolean(node.src))
        .map((node) => node.id);
      // Canvas references are also persisted in `references`; count their IDs
      // once so a first/last-frame request can still add its second image.
      const imageReferenceIds = new Set([
        ...linkedImageIds,
        ...(targetConfig.references || [])
          .filter((item) => item.kind === "image" && Boolean(item.src))
          .map((item) => item.id),
      ]);
      if (kind !== "image") {
        setMessage(`“${model || "未选择模型"}”当前只接收图片输入，不能添加视频参考。`);
        return;
      }
      if (limit.maximum === 0 || imageReferenceIds.size >= limit.maximum) {
        setMessage(`“${model || "未选择模型"}”的${videoModeLabel(normalized.mode)}最多接收 ${limit.maximum} 张图片；请切换模式或先移除已有参考。`);
        return;
      }
    }
    void (async () => {
      let imported: ImportedWorkspaceMedia;
      try {
        imported = await storeMediaForProject(file, sourceProjectId);
      } catch (error) {
        setMessage(`无法添加参考“${file.name}”：${humanizeApiError(error)}`);
        return;
      }
      if (historyIdRef.current !== sourceProjectId || !projectRef.current.nodes.some((node) => node.id === targetId)) {
        const cleanupMessage = await discardUnattachedImport(imported);
        setMessage(`已取消添加“${file.name}”：导入期间目标项目或节点已改变。${cleanupMessage}`);
        return;
      }
      const reference: OnlineReference = {
        id: newId(),
        name: file.name,
        kind,
        src: imported.src,
        localPath: imported.localPath,
        source: "external",
      };
      change((current) => ({
        ...current,
        nodes: current.nodes.map((node) => {
          if (node.id !== targetId) return node;
          const config = (node.workflow || {}) as OnlineVideoSettings;
          return { ...node, workflow: { ...config, references: [...(config.references || []), reference] } };
        }),
      }));
      setMessage(`已添加外部参考：“${file.name}”。`);
    })();
  };
  /**
   * AI 文本/图片编辑器只负责选择参考图；真正的文件落盘必须由宿主
   * 统一处理，避免它把整张图片编码进项目 JSON/localStorage。这里在
   * 异步上传完成后再次确认项目与节点仍然是发起导入时的目标，过期
   * 导入只会被丢弃，不会意外挂到后来切换的画布上。
   */
  const importAiReference = async (nodeId: string, file: File): Promise<AiReferenceImage> => {
    const sourceProjectId = historyIdRef.current;
    if (mediaKind(file) !== "image") {
      throw new Error("AI 参考仅支持图片文件");
    }
    const imported = await storeMediaForProject(file, sourceProjectId);
    if (
      historyIdRef.current !== sourceProjectId ||
      !projectRef.current.nodes.some((candidate) => candidate.id === nodeId)
    ) {
      const cleanupMessage = await discardUnattachedImport(imported);
      throw new Error(`导入期间目标项目或节点已改变，参考图未挂入。${cleanupMessage}`);
    }
    return {
      id: `reference-${newId()}`,
      name: file.name,
      src: imported.src,
      localPath: imported.localPath,
    };
  };
  const importMedia = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f || !mediaTarget) return;
    const target = mediaTarget;
    const sourceProjectId = historyIdRef.current;
    e.target.value = "";
    const kind = pendingKind.current;
    void (async () => {
      let imported: ImportedWorkspaceMedia;
      try {
        imported = await storeMediaForProject(f, sourceProjectId);
      } catch (error) {
        setMediaTarget(null);
        setMessage(`无法导入“${f.name}”：${humanizeApiError(error)}`);
        return;
      }
      const finish = () => {
        setMessage(isTauri() ? "媒体已安全存入桌面工作区并放入节点" : "媒体已放入节点（浏览器预览模式仅保存小文件）");
        setMediaTarget(null);
      };
      const apply = async (mediaWidth: number, mediaHeight: number) => {
        if (historyIdRef.current !== sourceProjectId || !projectRef.current.nodes.some((node) => node.id === target)) {
          setMediaTarget(null);
          const cleanupMessage = await discardUnattachedImport(imported);
          setMessage(`已取消导入“${f.name}”：导入期间目标项目或节点已改变。${cleanupMessage}`);
          return;
        }
        const scale = Math.min(480 / mediaWidth, 320 / mediaHeight, 1);
        const width = Math.max(160, Math.round(mediaWidth * scale));
        const height = Math.round((width * mediaHeight) / mediaWidth) + 29;
        change((p) => ({
          ...p,
          nodes: p.nodes.map((n) =>
            n.id === target
              ? {
                  ...n,
                  name: f.name,
                  fileName: f.name,
                  src: imported.src,
                  localPath: imported.localPath,
                  mediaWidth,
                  mediaHeight,
                  width,
                  height,
                }
              : n,
          ),
        }));
        finish();
      };
      if (kind === "image") {
        const image = new Image();
        image.onload = () => void apply(image.naturalWidth, image.naturalHeight);
        image.onerror = () => void apply(320, 220);
        image.src = imported.src;
      } else if (kind === "video") {
        const video = document.createElement("video");
        video.onloadedmetadata = () => void apply(video.videoWidth, video.videoHeight);
        video.onerror = () => void apply(320, 220);
        video.src = imported.src;
      } else {
        if (historyIdRef.current !== sourceProjectId || !projectRef.current.nodes.some((node) => node.id === target)) {
          setMediaTarget(null);
          const cleanupMessage = await discardUnattachedImport(imported);
          setMessage(`已取消导入“${f.name}”：导入期间目标项目或节点已改变。${cleanupMessage}`);
          return;
        }
        change((p) => ({
          ...p,
          nodes: p.nodes.map((n) =>
            n.id === target ? { ...n, name: f.name, fileName: f.name, src: imported.src, localPath: imported.localPath } : n,
          ),
        }));
        finish();
      }
    })();
  };
  const importApi = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const sourceProjectId = historyIdRef.current;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        if (historyIdRef.current !== sourceProjectId) {
          setMessage(`已取消导入“${f.name}”：读取期间已切换项目。`);
          return;
        }
        const currentProject = projectRef.current;
        const rect = canvasRef.current?.getBoundingClientRect();
        const fallback = rect
          ? {
              x: (rect.width / 2 - currentProject.view.x) / currentProject.view.zoom,
              y: (rect.height / 2 - currentProject.view.y) / currentProject.view.zoom,
            }
          : { x: 410, y: 270 };
        const workflow = JSON.parse(String(reader.result));
        const kind = classifyProjectJson(workflow);
        if (kind === "comfy-ui") {
          setMessage("检测到这是 ComfyUI 编辑器工作流，不能作为 API 节点直接运行。请在 ComfyUI 中保存为 API 格式，或导入工作流库转换。");
          return;
        }
        if (kind !== "comfy-api") {
          setMessage("这个 JSON 不是可运行的 ComfyUI API 工作流；未向画布添加节点。");
          return;
        }
        add("api", apiPoint || fallback, {
          name: f.name.replace(/\.json$/i, ""),
          workflow,
          status: "idle",
        });
        setApiPoint(null);
        setMessage("API 工作流已导入");
      } catch {
        setMessage("这个 JSON 不是可读取的 API 工作流");
      }
    };
    reader.readAsText(f);
    e.target.value = "";
  };
  const mediaKind = (
    file: File,
  ): Extract<Kind, "image" | "video" | "audio"> | null => {
    const fromName = mediaKindFromName(file.name);
    if (fromName) return fromName;
    if (file.type.startsWith("image/")) return "image";
    if (file.type.startsWith("video/")) return "video";
    if (file.type.startsWith("audio/")) return "audio";
    return null;
  };
  const measureMedia = (kind: Extract<Kind, "image" | "video">, src: string) =>
    new Promise<{ width: number; height: number }>((resolve) => {
      if (kind === "image") {
        const image = new Image();
        image.onload = () =>
          resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => resolve({ width: 300, height: 220 });
        image.src = src;
      } else {
        const video = document.createElement("video");
        video.onloadedmetadata = () =>
          resolve({ width: video.videoWidth, height: video.videoHeight });
        video.onerror = () => resolve({ width: 320, height: 220 });
        video.src = src;
      }
    });
  const commitDroppedMedia = async (
    imported: ImportedWorkspaceMedia,
    kind: Extract<Kind, "image" | "video" | "audio">,
    fileName: string,
    at: { x: number; y: number },
    sourceProjectId: string,
    textTarget?: string,
  ) => {
    const src = imported.src;
    let width = nodeSize[kind][0];
    let height = nodeSize[kind][1];
    let mediaWidth: number | undefined;
    let mediaHeight: number | undefined;
    if (kind === "image" || kind === "video") {
      const size = await measureMedia(kind, src);
      mediaWidth = size.width;
      mediaHeight = size.height;
      const scale = Math.min(360 / size.width, 250 / size.height, 1);
      width = Math.max(160, Math.round(size.width * scale));
      height = Math.round((width * size.height) / size.width) + 29;
    }
    const item: NodeItem = {
      id: newId(),
      kind,
      x: at.x,
      y: at.y,
      width,
      height,
      name: fileName,
      fileName,
      src,
      localPath: imported.localPath,
      mediaWidth,
      mediaHeight,
      status: "idle",
      createdAt: Date.now(),
    };
    // FileReader/video metadata are asynchronous. Construct the new document
    // from React's current state at commit time so a node/line added while the
    // file was reading is never overwritten by an old `project` closure.
    if (historyIdRef.current !== sourceProjectId) {
      const cleanupMessage = await discardUnattachedImport(imported);
      setMessage(`已取消导入“${fileName}”：读取期间已切换项目。${cleanupMessage}`);
      return;
    }
    let linkIssues: ReturnType<typeof appendTypedLink>["issues"] = [];
    change((current) => {
      const candidate = { ...current, nodes: [...current.nodes, item] };
      const linked = textTarget
        ? appendTypedLink(candidate, item.id, textTarget)
        : { project: candidate, issues: [] as ReturnType<typeof appendTypedLink>["issues"] };
      linkIssues = linked.issues;
      return linked.project;
    });
    if (textTarget) setMessage(linkIssues.length
      ? `素材已导入，但无法连接：${graphIssueText(linkIssues)}`
      : "已导入素材并连接到文本节点的参考插槽");
    else setMessage(isTauri()
      ? "素材已安全存入桌面工作区并添加到画布"
      : "素材已添加到画布（浏览器预览模式仅保存小文件）");
  };
  const addDroppedMedia = async (
    file: File,
    at: { x: number; y: number },
    textTarget?: string,
  ) => {
    const sourceProjectId = historyIdRef.current;
    const kind = mediaKind(file);
    if (!kind) return;
    let imported: ImportedWorkspaceMedia;
    try {
      imported = await storeMediaForProject(file, sourceProjectId);
    } catch (error) {
      setMessage(`无法导入素材“${file.name}”：${humanizeApiError(error)}`);
      return;
    }
    await commitDroppedMedia(imported, kind, file.name, at, sourceProjectId, textTarget);
  };
  const importExternalTextMedia = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const textNode = project.nodes.find(
      (node) => node.id === externalTextTarget,
    );
    if (file && textNode) {
      addDroppedMedia(
        file,
        { x: Math.max(30, textNode.x - 310), y: textNode.y },
        textNode.id,
      );
      setMessage("正在添加外部素材到文本参考");
    }
    setExternalTextTarget(null);
    e.target.value = "";
  };
  const addDroppedApiPayload = (
    workflow: unknown,
    fileName: string,
    at: { x: number; y: number },
    sourceProjectId: string,
  ) => {
    if (historyIdRef.current !== sourceProjectId) {
      setMessage(`已取消导入“${fileName}”：读取期间已切换项目。`);
      return;
    }
    if (classifyProjectJson(workflow) !== "comfy-api") {
      setMessage("这个 JSON 不是可读取的 ComfyUI API 工作流");
      return;
    }
    add("api", at, {
      name: fileName.replace(/\.json$/i, ""),
      workflow,
      status: "idle",
    });
    setMessage("API 工作流已拖入画布");
  };
  /**
   * Every file-open entry point funnels through this one path.  Dragging a
   * project onto the canvas must receive the same migration, credential
   * redaction, portability report and companion-library restoration as the
   * regular “打开项目” file picker.
   */
  const openProjectPackage = (rawPackage: unknown, fallbackName: string, sourceLabel = "项目") => {
    try {
      const imported = redactProjectSecrets(rawPackage);
      const p = imported.value as Record<string, any>;
      const packageKind = classifyProjectJson(p);
      if (packageKind !== "canvas") throw Error(projectImportKindMessage(packageKind));
      if (p.__ymProjectPackage !== undefined && p.__ymProjectPackage !== 1 && p.__ymProjectPackage !== 2) {
        throw Error(`该项目包版本（v${String(p.__ymProjectPackage)}）当前应用尚不支持。请升级亿幕画布后再导入，避免只恢复一部分数据。`);
      }
      // Normalize/migrate the actual canvas before portability inspection and
      // persistence. The report, the document and the active view therefore
      // all describe the same schema version instead of three subtly different
      // snapshots of an old export.
      const normalizedCanvas = safeProject({
        nodes: p.nodes,
        links: p.links || [],
        view: p.view || { x: 190, y: 130, zoom: 1 },
        groups: Array.isArray(p.groups) ? p.groups : [],
      });
      const normalizedPackage = {
        ...p,
        nodes: normalizedCanvas.nodes,
        links: normalizedCanvas.links,
        view: normalizedCanvas.view,
        groups: normalizedCanvas.groups || [],
      };
      // Do not trust a manifest from an older export.  Check the actual JSON
      // that is about to be stored on this computer instead.
      const portability = analyzeProjectPortability(normalizedPackage);
      if (portability.packageKind === "invalid") throw Error("invalid project");
      const attention = portability.summary.requiresRebind + portability.summary.missing;
      if (attention) {
        const examples = portability.items
          .filter((item) => item.status !== "portable")
          .slice(0, 3)
          .map((item) => `• ${item.label}：${item.message}`)
          .join("\n");
        if (!window.confirm(
          `迁移检查发现 ${portability.summary.requiresRebind} 项需要重新绑定、${portability.summary.missing} 项缺失。\n` +
          `不会伪造恢复本机文件或临时素材。\n\n${examples}${attention > 3 ? "\n• 其余项目将在打开后保留为待处理状态。" : ""}\n\n仍要导入吗？`,
        )) return false;
      }
      if (!flushActiveProjectSave()) {
        setMessage("当前项目未能离线保存，已取消打开新项目。请先导出当前项目或清理本机存储空间。");
        return false;
      }

      const nextProjectId = newId();
      const isPortablePackage = p.__ymProjectPackage === 1 || p.__ymProjectPackage === 2;

      let nextProject = normalizedCanvas;
      // Project packages can carry selected ComfyUI workflows.  The local
      // library is shared by existing projects, so never let an imported ID
      // overwrite a different local graph: isolate the imported workflow and
      // rewrite only references inside the imported canvas before it is saved.
      const workflowImport = isPortablePackage && Array.isArray(p.comfyWorkflows)
        ? mergeImportedComfyWorkflows(p.comfyWorkflows, readComfyWorkflowLibrary(), nextProject)
        : null;
      if (workflowImport) nextProject = safeProject(workflowImport.project);
      const nextProjectName = typeof p.projectName === "string" && p.projectName.trim()
        ? p.projectName.trim()
        : fallbackName.replace(/\.json$/i, "");
      if (!persistProjectSnapshot(nextProject, nextProjectId, nextProjectName)) {
        setMessage("导入项目无法写入本机存储，已保持当前项目不变。请先导出或清理本机存储空间后重试。");
        return false;
      }
      // Import companion data only after the canvas document itself is safely
      // present. These library keys are global, so restore every touched value
      // if a quota failure happens midway; a failed import must not leave half
      // of somebody else's workflow/prompt library behind.
      let companionImportIssue = false;
      if (isPortablePackage) {
        const previousValues = new Map<string, string | null>();
        const writeCompanion = (key: string, value: string) => {
          if (!previousValues.has(key)) previousValues.set(key, localStorage.getItem(key));
          localStorage.setItem(key, value);
        };
        try {
          if (p.director && typeof p.director === "object") {
            writeCompanion(`ym-director-editor-v3:${nextProjectId}`, JSON.stringify(p.director));
          }
          if (Array.isArray(p.directorAssets)) {
            writeCompanion(`ym-director-assets-v1:${nextProjectId}`, JSON.stringify(p.directorAssets));
          }
          if (workflowImport && workflowImport.report.accepted > 0) {
            writeCompanion(COMFY_WORKFLOW_STORE, JSON.stringify(workflowImport.merged));
          }
          if (Array.isArray(p.promptLibrary)) {
            const currentPrompts = (() => {
              try {
                const value = JSON.parse(localStorage.getItem("yimu-prompt-library") || "[]");
                return Array.isArray(value) ? value : [];
              } catch {
                return [];
              }
            })();
            writeCompanion(
              "yimu-prompt-library",
              JSON.stringify([...new Set([...p.promptLibrary, ...currentPrompts])].slice(0, 96)),
            );
          }
        } catch {
          companionImportIssue = true;
          previousValues.forEach((previous, key) => {
            try {
              if (previous === null) localStorage.removeItem(key);
              else localStorage.setItem(key, previous);
            } catch {
              // The project document is already safe. A later import/export
              // can recover it even when the companion store is out of space.
            }
          });
        }
      }
      undoHistory.current = [];
      activateProjectIdentity(nextProjectId, nextProjectName, nextProject);
      setProject(nextProject);
      setHistoryId(nextProjectId);
      setProjectName(nextProjectName);
      resetProjectSession();
      const portabilityText = portability.summary.fullyPortable
        ? "迁移检查：所有已声明依赖可恢复"
        : `迁移检查：${portability.summary.requiresRebind} 项需重新绑定、${portability.summary.missing} 项缺失`;
      const credentialText = imported.redactedPaths.length
        ? `；为安全起见已忽略 ${imported.redactedPaths.length} 个项目内密钥/Token`
        : "";
      const workflowText = workflowImport && workflowImport.report.incomingTotal
        ? `；工作流：新增 ${workflowImport.report.added} 个、复用 ${workflowImport.report.reused.length} 个${workflowImport.report.remapped.length ? `，已隔离 ${workflowImport.report.remapped.length} 个同名 ID` : ""}${workflowImport.report.skipped.length ? `，跳过 ${workflowImport.report.skipped.length} 个不完整/重复条目` : ""}`
        : "";
      setMessage(isPortablePackage
        ? `${sourceLabel}已打开，${companionImportIssue ? "附带粗剪预览/工作流未能保存，请清理存储后重新导入；" : "粗剪预览与工作流已恢复；"}${portabilityText}${workflowText}${credentialText}`
        : `旧版${sourceLabel}已打开；${portabilityText}${credentialText}`);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      const knownMessage = detail.startsWith("检测到这是 ComfyUI") ||
        detail.startsWith("该项目包版本") ||
        detail === "项目文件格式不正确";
      setMessage(knownMessage ? detail : "项目文件格式不正确");
      return false;
    }
  };

  /**
   * One guarded FileReader path for both the picker and a JSON dropped on the
   * canvas. A late reader can neither activate an old project nor add an API
   * node into a project selected after the read began.
   */
  const readProjectJsonFile = (
    file: File,
    onValue: (value: unknown, sourceProjectId: string) => void,
  ) => {
    const sourceProjectId = historyIdRef.current;
    invalidatePendingProjectImport();
    const importSequence = projectImportSequence.current;
    const reader = new FileReader();
    activeProjectImportReader.current = reader;
    const isCurrentRead = () =>
      importSequence === projectImportSequence.current &&
      sourceProjectId === historyIdRef.current;
    const clearIfActive = () => {
      if (activeProjectImportReader.current === reader) activeProjectImportReader.current = null;
    };
    reader.onload = () => {
      clearIfActive();
      if (!isCurrentRead()) return;
      try {
        onValue(JSON.parse(String(reader.result || "")), sourceProjectId);
      } catch {
        setMessage(`无法打开“${file.name}”：项目文件不是有效 JSON。`);
      }
    };
    reader.onerror = () => {
      clearIfActive();
      if (isCurrentRead()) setMessage(`无法读取“${file.name}”，请检查文件是否仍可访问。`);
    };
    reader.onabort = () => clearIfActive();
    reader.readAsText(file);
  };
  const openDroppedProject = (file: File, at: { x: number; y: number }) => {
    readProjectJsonFile(file, (data, sourceProjectId) => {
      const kind = classifyProjectJson(data);
      if (kind === "canvas" || kind === "comfy-ui") {
        // `openProjectPackage` owns migration, secret redaction, portability
        // checks and the final synchronous flush. An editor workflow reaches
        // the same path solely to receive its precise “not a project” hint.
        openProjectPackage(data, file.name, "拖入的项目");
        return;
      }
      if (kind === "comfy-api") {
        addDroppedApiPayload(data, file.name, at, sourceProjectId);
        return;
      }
      setMessage("拖入的 JSON 既不是亿幕画布项目，也不是可读取的 ComfyUI API 工作流。");
    });
  };
  const linkMediaToText = (sourceId: string, textId: string) => {
    if (project.links.some((link) => link.from === sourceId && link.to === textId)) {
      setMessage("这张素材已经连接到文本节点");
      return;
    }
    connectCanvasNodes(sourceId, textId, { toPort: "references" });
  };
  const removeAiReference = (nodeId: string, reference: AiReferenceImage) => {
    change((current) => {
      const links = current.links.filter((link) => !(link.from === reference.id && link.to === nodeId));
      const hasLinkedImage = links
        .filter((link) => link.to === nodeId)
        .some((link) => current.nodes.some((node) => node.id === link.from && node.kind === "image" && Boolean(node.src)));
      return {
        ...current,
        links,
        nodes: current.nodes.map((node) => {
          if (node.id !== nodeId) return node;
          const workflow = (node.workflow && typeof node.workflow === "object" ? node.workflow : {}) as AiTextSettings & AiImageSettings;
          const references = (workflow.references || []).filter((item) => item.id !== reference.id);
          return {
            ...node,
            workflow: {
              ...workflow,
              references,
              ...(node.kind === "image" || node.kind === "aiImage"
                ? { mode: references.length || hasLinkedImage ? workflow.mode || "image" : "text" }
                : {}),
            },
          };
        }),
      };
    });
    setMessage(`已移除参考“${reference.name}”并断开对应连线。`);
  };
  const updateStoryboardRow = (
    nodeId: string,
    rowIndex: number,
    patch: Partial<StoryboardRow>,
  ) => {
    change((current) => {
      const node = current.nodes.find((item) => item.id === nodeId);
      if (!node) return current;
      const rows = [...(node.storyboard || defaultStoryboard())];
      rows[rowIndex] = { ...rows[rowIndex], ...patch };
      const imageId = patch.imageId;
      const updated = {
        ...current,
        nodes: current.nodes.map((item) =>
          item.id === nodeId
            ? { ...item, storyboard: rows, text: storyboardText(rows) }
            : item,
        ),
      };
      return imageId && !current.links.some((link) => link.from === imageId && link.to === nodeId)
        ? appendTypedLink(updated, imageId, nodeId, { toPort: "references" }).project
        : updated;
    });
  };
  const addStoryboardRow = (nodeId: string) =>
    change((current) => ({
      ...current,
      nodes: current.nodes.map((node) => {
        if (node.id !== nodeId) return node;
        const rows = [...(node.storyboard || defaultStoryboard()), {
          shot: String((node.storyboard || defaultStoryboard()).length + 1),
          visual: "",
          dialogue: "",
        }];
        return { ...node, storyboard: rows, text: storyboardText(rows) };
      }),
    }));
  const fillStoryboardFromText = (nodeId: string, source: string) => {
    const lines = source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const tableRows = lines
      .filter((line) => line.includes("|"))
      .map((line) => line.split("|").map((cell) => cell.trim()).filter(Boolean))
      .filter((cells) => cells.length > 1)
      .filter((cells) => !cells.some((cell) => /^[-:]+$/.test(cell)))
      .filter((cells) => !cells.some((cell) => /镜号|时长|景别|画面内容/.test(cell)));
    const rows: StoryboardRow[] = tableRows.length
      ? tableRows.map((cells, index) => ({
          shot: cells[0] || String(index + 1),
          visual: cells[3] || cells[1] || "",
          dialogue: cells[5] || cells[2] || "",
        }))
      : source
          .split(/\n\s*(?=(?:镜头|第?\s*\d+\s*[、.、．]))/)
          .map((block, index) => ({
            shot: block.match(/(?:镜头|第)?\s*(\d+)/)?.[1] || String(index + 1),
            visual: block.trim(),
            dialogue: "",
          }))
          .filter((row) => row.visual);
    if (!rows.length) return;
    change((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === nodeId
          ? { ...node, storyboard: rows, text: storyboardText(rows) }
          : node,
      ),
    }));
    setStoryboardPaste("");
    setMessage(`已自动填入 ${rows.length} 个分镜`);
  };
  const fitStoryboardNode = (nodeId: string) =>
    change((current) => ({
      ...current,
      nodes: current.nodes.map((node) => {
        if (node.id !== nodeId) return node;
        const rows = node.storyboard || defaultStoryboard();
        const contentHeight = rows.reduce((total, row) => {
          const lines = Math.max(
            1,
            Math.ceil(Math.max(row.visual.length, row.dialogue.length) / 54),
          );
          return total + Math.max(34, lines * 18 + 14);
        }, 42);
        return { ...node, height: Math.min(620, Math.max(150, 31 + contentHeight + 25)) };
      }),
    }));
  const recordMediaSize = (id: string, width: number, height: number) => {
    if (!width || !height) return;
    change((current) => {
      const target = current.nodes.find((node) => node.id === id);
      if (
        !target ||
        (target.mediaWidth === width && target.mediaHeight === height)
      )
        return current;
      return {
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === id
            ? { ...node, mediaWidth: width, mediaHeight: height }
            : node,
        ),
      };
    });
  };
  const textDragOver = (event: React.DragEvent, textId: string) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setDropTextTarget(textId);
  };
  const textDrop = (event: React.DragEvent, textNode: NodeItem) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTextTarget(null);
    const sourceId = event.dataTransfer.getData(
      "application/x-comfy-canvas-media",
    );
    const source = project.nodes.find((node) => node.id === sourceId);
    if (source && (source.kind === "image" || source.kind === "video")) {
      linkMediaToText(source.id, textNode.id);
      return;
    }
    Array.from(event.dataTransfer.files).forEach((file, index) => {
      const x = Math.max(30, textNode.x - 310);
      addDroppedMedia(file, { x, y: textNode.y + index * 42 }, textNode.id);
    });
  };
  const canvasDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setExternalDropActive(false);
    setDropTextTarget(null);
    const point = world(event.clientX, event.clientY);
    Array.from(event.dataTransfer.files).forEach((file, index) => {
      const at = { x: point.x + index * 32, y: point.y + index * 32 };
      if (/\.json$/i.test(file.name) || file.type === "application/json") {
        openDroppedProject(file, at);
      } else {
        addDroppedMedia(file, at);
      }
    });
  };
  const droppedFileName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || "拖入文件";
  const addNativeDroppedPath = async (path: string, at: { x: number; y: number }) => {
    const fileName = droppedFileName(path);
    const sourceProjectId = historyIdRef.current;
    if (/\.json$/i.test(fileName)) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const raw = await invoke<string>("read_dropped_workflow_file", { path });
        const data = JSON.parse(raw);
        const kind = classifyProjectJson(data);
        if (kind === "canvas" || kind === "comfy-ui") {
          openProjectPackage(data, fileName, "拖入的项目");
        } else if (kind === "comfy-api") {
          addDroppedApiPayload(data, fileName, at, sourceProjectId);
        } else {
          setMessage("拖入的 JSON 既不是亿幕画布项目，也不是可运行的 ComfyUI API 工作流。");
        }
      } catch (error) {
        setMessage(`无法读取拖入的工作流“${fileName}”：${humanizeApiError(error)}`);
      }
      return;
    }
    const kind = mediaKindFromName(fileName);
    if (!kind) {
      setMessage(`暂不支持拖入“${fileName}”；请选择图片、视频、音频或 API 工作流 JSON。`);
      return;
    }
    try {
      const asset = await importWorkspaceAssetFromPath({
        projectId: sourceProjectId,
        assetId: newId(),
        sourcePath: path,
        fileName,
        mimeType: mediaMimeTypeFromName(fileName),
      });
      if (!asset.localPath) throw new Error("桌面素材仓储没有返回预览路径");
      await commitDroppedMedia({
        src: convertFileSrc(asset.localPath),
        localPath: asset.localPath,
        managedAsset: asset,
      }, kind, fileName, at, sourceProjectId);
    } catch (error) {
      setMessage(`无法拖入素材“${fileName}”：${humanizeApiError(error)}`);
    }
  };
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const appWindow = getCurrentWindow();
      const scaleFactor = await appWindow.scaleFactor().catch(() => 1);
      const removeListener = await appWindow.onDragDropEvent((event) => {
        if (event.payload.type === "leave") {
          setExternalDropActive(false);
          return;
        }
        const position = event.payload.position;
        const clientX = position.x / scaleFactor;
        const clientY = position.y / scaleFactor;
        const rect = canvasRef.current?.getBoundingClientRect();
        const overCanvas = Boolean(rect && clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom);
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setExternalDropActive(overCanvas);
          return;
        }
        setExternalDropActive(false);
        if (!overCanvas || !rect) {
          setMessage("请把文件拖到画布空白区域后松开");
          return;
        }
        const point = world(clientX, clientY);
        const paths = event.payload.paths;
        void (async () => {
          for (const [index, path] of paths.entries()) {
            await addNativeDroppedPath(path, { x: point.x + index * 32, y: point.y + index * 32 });
          }
        })();
      });
      if (disposed) removeListener();
      else unlisten = removeListener;
    })().catch((error) => setMessage(`桌面拖放初始化失败：${humanizeApiError(error)}`));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    const before = {
      x: (e.clientX - rect.left - project.view.x) / project.view.zoom,
      y: (e.clientY - rect.top - project.view.y) / project.view.zoom,
    };
    const zoom = Math.min(
      3,
      Math.max(0.35, project.view.zoom * (e.deltaY > 0 ? 0.9 : 1.1)),
    );
    change((p) => ({
      ...p,
      view: {
        zoom,
        x: e.clientX - rect.left - before.x * zoom,
        y: e.clientY - rect.top - before.y * zoom,
      },
    }));
  };
  const canvasDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    const isMiddleMarquee = e.button === 1;
    const target = e.target as HTMLElement;
    const isGrp = !!target.closest(".node-group");
    if (isMiddleMarquee && target.closest("button,input,textarea,select,.menu,.toolbar,.ai-composer,.online-video-composer")) return;
    if (!isMiddleMarquee && !isGrp && target.closest(".node,.menu,.topbar,.toolbar")) return;
    if (isMiddleMarquee) e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!isMiddleMarquee && isGrp) { setMenu(null); return; }
    setMenu(null);
    setDisconnectMenu(null);
    setLinkAddMenu(null);
    setRecentOpen(false);
    setSettings(false);
    setPreferences(false);
    setTopMenuOpen(false);
    setSelectedLinks([]);
    setActiveText(null);
    setActiveStoryboard(null);
    setActiveOnlineVideo(null);
    setOnlinePopover(null);
    if (isMiddleMarquee) {
      const point = world(e.clientX, e.clientY);
      marquee.current = point;
      marqueeIncludesLinks.current = true;
      setSelectionBox({ x: point.x, y: point.y, width: 0, height: 0 });
      setSelected([]);
      setSelectedLinks([]);
      return;
    }
    if (e.ctrlKey && e.altKey) {
      const point = world(e.clientX, e.clientY);
      lineMarquee.current = point;
      setLineSelectionBox({ x: point.x, y: point.y, width: 0, height: 0 });
      setSelectedLinks([]);
      return;
    }
    if (e.ctrlKey) {
      const point = world(e.clientX, e.clientY);
      marquee.current = point;
      marqueeIncludesLinks.current = false;
      setSelectionBox({ x: point.x, y: point.y, width: 0, height: 0 });
      setSelected([]);
      return;
    }
    setSelected([]);
    setPanning(true);
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      origin: project.view,
    };
  };
  const canvasMove = (e: PointerEvent<HTMLElement>) => {
    if (lineMarquee.current) {
      const point = world(e.clientX, e.clientY);
      const start = lineMarquee.current;
      setLineSelectionBox({
        x: Math.min(start.x, point.x), y: Math.min(start.y, point.y),
        width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y),
      });
      return;
    }
    if (marquee.current) {
      const point = world(e.clientX, e.clientY);
      const start = marquee.current;
      setSelectionBox({
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        width: Math.abs(point.x - start.x),
        height: Math.abs(point.y - start.y),
      });
      return;
    }
    if (drag.current) {
      const d = drag.current;
      const view = {
        ...d.origin,
        x: d.origin.x + e.clientX - d.startX,
        y: d.origin.y + e.clientY - d.startY,
      };
      transientView.current = view;
      if (gridRef.current) gridRef.current.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    }
    if (moving.current) {
      const d = moving.current;
      const dx = (e.clientX - d.startX) / project.view.zoom,
        dy = (e.clientY - d.startY) / project.view.zoom;
      transientNodePositions.current.clear();
      for (const node of project.nodes) {
        const origin = d.nodes[node.id];
        if (!origin) continue;
        let x = origin.x + dx;
        let y = origin.y + dy;
        if (d.groupBounds) {
          x = Math.max(d.groupBounds.minX, Math.min(d.groupBounds.maxX - node.width, x));
          y = Math.max(d.groupBounds.minY, Math.min(d.groupBounds.maxY - node.height, y));
        }
        transientNodePositions.current.set(node.id, { x, y });
        const element = gridRef.current?.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`);
        if (element) {
          element.style.left = `${x}px`;
          element.style.top = `${y}px`;
        }
      }
      if (d.isGroupDrag && d.startBounds) {
        const group = gridRef.current?.querySelector<HTMLElement>(`[data-group-id="${d.isGroupDrag}"]`);
        if (group) {
          group.style.left = `${d.startBounds.x + dx}px`;
          group.style.top = `${d.startBounds.y + dy}px`;
        }
      }
      const positions = transientNodePositions.current;
      for (const link of project.links) {
        if (!positions.has(link.from) && !positions.has(link.to)) continue;
        const source = canvasNodeIndex.get(link.from);
        const target = canvasNodeIndex.get(link.to);
        const path = document.getElementById(`wire-${link.id}`);
        if (!source || !target || !path) continue;
        const sourcePosition = positions.get(source.id) || source;
        const targetPosition = positions.get(target.id) || target;
        const x1 = sourcePosition.x + source.width;
        const y1 = sourcePosition.y + source.height / 2;
        const x2 = targetPosition.x;
        const y2 = targetPosition.y + target.height / 2;
        const bend = Math.max(42, Math.abs(x2 - x1) * 0.38);
        path.setAttribute("d", `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
      }
    }
    if (linking.current) {
      const p = world(e.clientX, e.clientY);
      setDraftLink({ from: linking.current.from, x: p.x, y: p.y, side: linking.current.side });
    }
  };
  const linksIntersectingSelectionBox = (box: { x: number; y: number; width: number; height: number }) => {
    const intersects = (minX: number, minY: number, maxX: number, maxY: number) =>
      minX < box.x + box.width && maxX > box.x && minY < box.y + box.height && maxY > box.y;
    return project.links.filter((link) => {
      const a = project.nodes.find((node) => node.id === link.from);
      const b = project.nodes.find((node) => node.id === link.to);
      if (!a || !b) return false;
      const x1 = a.x + a.width, y1 = a.y + a.height / 2;
      const x2 = b.x, y2 = b.y + b.height / 2;
      const bend = Math.max(42, Math.abs(x2 - x1) * .38);
      return intersects(Math.min(x1, x2, x1 + bend, x2 - bend), Math.min(y1, y2), Math.max(x1, x2, x1 + bend, x2 - bend), Math.max(y1, y2));
    }).map((link) => link.id);
  };
  const canvasUp = (e: PointerEvent<HTMLElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    if (lineMarquee.current && lineSelectionBox) {
      const box = lineSelectionBox;
      setSelectedLinks(linksIntersectingSelectionBox(box));
      lineMarquee.current = null;
      setLineSelectionBox(null);
    }
    if (marquee.current && selectionBox) {
      const box = selectionBox;
      setSelected(
        project.nodes
          .filter(
            (node) =>
              node.x < box.x + box.width &&
              node.x + node.width > box.x &&
              node.y < box.y + box.height &&
              node.y + node.height > box.y,
          )
          .map((node) => node.id),
      );
      if (marqueeIncludesLinks.current) setSelectedLinks(linksIntersectingSelectionBox(box));
      marquee.current = null;
      marqueeIncludesLinks.current = false;
      setSelectionBox(null);
    }
    const mediaMove = moving.current;
    const finalPositions = new Map(transientNodePositions.current);
    const moveDistance = mediaMove
      ? Math.hypot(e.clientX - mediaMove.startX, e.clientY - mediaMove.startY)
      : 0;
    let movementRecorded = false;
    let mediaAttached = false;
    const rememberMovement = () => {
      if (!mediaMove || movementRecorded || moveDistance < 1) return;
      undoHistory.current = [...undoHistory.current.slice(-5), mediaMove.startProject];
      movementRecorded = true;
    };
    if (mediaMove?.sourceId) {
      const sourceId = mediaMove.sourceId;
      const point = world(e.clientX, e.clientY);
      const textTarget = project.nodes.find(
        (node) =>
          node.kind === "text" &&
          point.x >= node.x &&
          point.x <= node.x + node.width &&
          point.y >= node.y &&
          point.y <= node.y + node.height,
      );
      if (textTarget) {
        const original = mediaMove.nodes[sourceId];
        const proposal = appendTypedLink(project, sourceId, textTarget.id);
        if (proposal.issues.length) {
          setMessage(`无法作为文本参考：${graphIssueText(proposal.issues)}`);
        } else {
          setProject((current) => {
            const resetPosition = {
              ...current,
              nodes: current.nodes.map((node) =>
                node.id === sourceId && original
                  ? { ...node, x: original.x, y: original.y }
                  : node,
              ),
            };
            const next = appendTypedLink(resetPosition, sourceId, textTarget.id).project;
            projectRef.current = next;
            return next;
          });
          rememberMovement();
          mediaAttached = true;
          setMessage("图片已连接到文本节点的参考图片插槽");
        }
      }
    }
    const activeLink = linking.current;
    if (activeLink && !(e.target as HTMLElement).closest(".node")) {
      setLinkAddMenu({
        x: e.clientX,
        y: e.clientY,
        point: world(e.clientX, e.clientY),
        from: activeLink.from,
        side: activeLink.side,
      });
    }
    if (mediaMove?.isGroupDrag) {
      const dx2 = (e.clientX - mediaMove.startX) / project.view.zoom;
      const dy2 = (e.clientY - mediaMove.startY) / project.view.zoom;
      setProject((current) => {
        const next = {
          ...current,
          nodes: current.nodes.map((node) => finalPositions.has(node.id) ? { ...node, ...finalPositions.get(node.id)! } : node),
          groups: (current.groups || []).map((group) => group.id === mediaMove.isGroupDrag && mediaMove.startBounds
            ? { ...group, bounds: { ...mediaMove.startBounds, x: mediaMove.startBounds.x + dx2, y: mediaMove.startBounds.y + dy2 } }
            : group),
        };
        projectRef.current = next;
        return next;
      });
      rememberMovement();
    } else if (mediaMove && !mediaAttached) {
      setProject((current) => {
        const next = {
          ...current,
          nodes: current.nodes.map((node) => finalPositions.has(node.id) ? { ...node, ...finalPositions.get(node.id)! } : node),
        };
        projectRef.current = next;
        return next;
      });
      rememberMovement();
    }
    const finalView = transientView.current;
    if (finalView) {
      setProject((current) => {
        const next = { ...current, view: finalView };
        projectRef.current = next;
        return next;
      });
    }
    setPanning(false);
    drag.current = null;
    moving.current = null;
    transientView.current = null;
    transientNodePositions.current.clear();
    linking.current = null;
    setDraftLink(null);
  };
  const nodeDown = (e: PointerEvent, n: NodeItem) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // Keep receiving movement when the pointer starts on an image or video frame.
    // This makes click-and-hold dragging work across the entire picture, not only its title.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setSelectedLinks([]);
    const next = e.ctrlKey
      ? selected.includes(n.id)
        ? selected.filter((id) => id !== n.id)
        : [...selected, n.id]
      : selected.includes(n.id)
        ? selected
        : [n.id];
    setSelected(next);
    if (n.locked) return;
    let grpBounds: any = undefined;
    const ng = (project.groups || []).find((g) => g.nodeIds.includes(n.id));
    if (ng) { const b = ng.bounds || (() => { const gns = project.nodes.filter((x) => ng.nodeIds.includes(x.id)); const xs2 = gns.map((x) => x.x), ys2 = gns.map((x) => x.y), xe2 = gns.map((x) => x.x + x.width), ye2 = gns.map((x) => x.y + x.height); return { x: Math.min(...xs2) - 12, y: Math.min(...ys2) - 12, w: Math.max(...xe2) - Math.min(...xs2) + 24, h: Math.max(...ye2) - Math.min(...ys2) + 24 }; })(); grpBounds = { minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h }; }
    // A text annotation owns its pointer, so moving the text keeps its visual
    // relationship to the arrow.  The arrow itself remains independently movable.
    const movingIds = new Set(next);
    project.nodes.forEach((node) => {
      if (node.kind === "annotation" && next.includes(node.id) && node.pointerId) {
        movingIds.add(node.pointerId);
      }
    });
    const movingNodes = Object.fromEntries(
      project.nodes
        .filter((x) => movingIds.has(x.id))
        .map((x) => [x.id, { x: x.x, y: x.y }]),
    );
    moving.current = {
      startX: e.clientX,
      startY: e.clientY,
      nodes: movingNodes,
      sourceId: n.kind === "image" || n.kind === "video" ? n.id : undefined,
      groupBounds: grpBounds,
      startProject: project,
    };
  };
  const nodeMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    pastePoint.current = world(e.clientX, e.clientY);
    const keepSelection = selected.includes(id);
    if (!keepSelection) setSelected([id]);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      node: keepSelection && selected.length > 1 ? "__selection__" : id,
    });
  };
  const canvasMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".node")) return;
    e.preventDefault();
    pastePoint.current = world(e.clientX, e.clientY);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      node: undefined,
    });
  };
  const deleteCanvasNodes = (ids: string[]) => {
    if (!ids.length) return;
    const projectId = activeProjectIdRef.current;
    ids.forEach((id) => {
      const activeRun = runRegistry.current.getSnapshot(projectId, id);
      if (activeRun?.status === "running") {
        // Deleting is a local ownership boundary. The provider may finish its
        // task, but its delayed result cannot create an orphan node here.
        runRegistry.current.cancel(projectId, id, activeRun.runId);
      }
    });
    change((p) => deleteNodes(p, ids));
  };
  const deleteSelected = () => {
    deleteCanvasNodes(selected);
    setSelected([]);
  };
  const copy = () => {
    setClipboard(selectedNodes);
    setMessage(`已复制 ${selectedNodes.length} 个节点`);
  };
  const paste = () => {
    if (!clipboard.length) return;
    const minX = Math.min(...clipboard.map((node) => node.x));
    const minY = Math.min(...clipboard.map((node) => node.y));
    const at = pastePoint.current || { x: minX + 36, y: minY + 36 };
    const copies = clipboard.map((n) => ({
      ...n,
      id: newId(),
      x: at.x + n.x - minX,
      y: at.y + n.y - minY,
      name: `${n.name} 副本`,
    }));
    change((p) => ({ ...p, nodes: [...p.nodes, ...copies] }));
    setSelected(copies.map((n) => n.id));
  };
  const resetView = () =>
    change((p) => ({ ...p, view: { x: 6, y: 96, zoom: 0.86 } }));
  const newProject = () => {
    if (!window.confirm("将开始一个新的默认项目。当前画布会被替换，建议先导出项目。是否继续？")) return;
    if (!flushActiveProjectSave()) {
      setMessage("当前项目未能离线保存，已取消新建。请先导出当前项目或清理本机存储空间。");
      return;
    }
    const id = newId();
    const nextProject = starter();
    if (!persistProjectSnapshot(nextProject, id, "未命名项目")) {
      setMessage("新项目无法写入本机存储，已保持当前项目不变。请先导出或清理本机存储空间后重试。");
      return;
    }
    undoHistory.current = [];
    activateProjectIdentity(id, "未命名项目", nextProject);
    setHistoryId(id);
    setProject(nextProject);
    setProjectName("未命名项目");
    resetProjectSession();
    setMessage("已新建项目");
  };
  const exportProject = async () => {
    // Export must include the very last drag/resize frame even if it has not
    // reached React state yet. The same snapshot is used for every companion
    // key, so a saved JSON never combines one project's canvas with another
    // project's director data.
    const canvasProject = safeProject(flushPendingFrameChange());
    const exportProjectId = historyIdRef.current;
    const exportProjectName = projectNameRef.current.trim() || "未命名项目";
    // The library is app-wide for backward compatibility, but a project export
    // should only carry the workflows this canvas actually names. Otherwise
    // importing Project A can silently replace unrelated Project B workflows.
    const workflowIds = referencedComfyWorkflowIds(canvasProject);
    const projectWorkflows = readComfyWorkflowLibrary()
      .filter((workflow) => workflowIds.has(workflow.id));
    const readStoredJson = (key: string, fallback: unknown) => {
      try { return JSON.parse(localStorage.getItem(key) || "") as unknown; } catch { return fallback; }
    };
    // Keep this package self-describing.  The manifest is a report only: it
    // never pretends that a path or a browser Blob is a portable media file.
    const rawProjectPackage = {
      ...canvasProject,
      __ymProjectPackage: 2,
      projectName: exportProjectName,
      comfyWorkflows: projectWorkflows,
      promptLibrary: readStoredJson("yimu-prompt-library", []),
      director: readStoredJson(`ym-director-editor-v3:${exportProjectId}`, null),
      directorAssets: readStoredJson(`ym-director-assets-v1:${exportProjectId}`, []),
    };
    const { value: projectPackage, redactedPaths } = redactProjectSecrets(rawProjectPackage);
    const portability = analyzeProjectPortability(projectPackage);
    const portabilityWarnings = portability.items
      .filter((item) => item.status !== "portable")
      .map((item) => `${item.label}：${item.message}`);
    const manifest = createProjectPortabilityManifest(projectPackage);
    // Source URLs are already present in the project itself. Keeping them a
    // second time in the display-only manifest can double a large Data URL
    // export (and quickly makes video projects impossible to share).
    const compactManifest = {
      ...manifest,
      report: {
        ...manifest.report,
        items: manifest.report.items.map(({ source: _source, ...item }) => item),
      },
    };
    const content = JSON.stringify({
      ...projectPackage,
      portabilityWarnings,
      portabilityManifest: compactManifest,
    }, null, 2);
    const portabilitySuffix = portability.summary.fullyPortable
      ? "项目可在另一台电脑直接恢复"
      : `${portability.summary.requiresRebind} 项需重新绑定、${portability.summary.missing} 项缺失`;
    const credentialSuffix = redactedPaths.length
      ? `；已移除 ${redactedPaths.length} 个密钥/Token 字段`
      : "";
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { invoke } = await import("@tauri-apps/api/core");
      const filename = `亿幕画布项目-${new Date().toISOString().slice(0, 10)}.json`;
      let defaultPath = filename;
      if (defaultSaveDir) {
        const { join } = await import("@tauri-apps/api/path");
        defaultPath = await join(defaultSaveDir, filename);
      }
      const path = await save({
        defaultPath,
        filters: [{ name: "离线画布项目", extensions: ["json"] }],
      });
      if (!path) return;
      await invoke("save_project", { path, content });
      setMessage(`项目已保存到本机；${portabilitySuffix}${credentialSuffix}`);
    } catch {
      const blob = new Blob([content], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `离线画布项目-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      setMessage(`项目文件已导出；${portabilitySuffix}${credentialSuffix}`);
    }
  };
  const chooseDefaultSaveDir = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ directory: true, multiple: false, title: "选择亿幕画布默认保存位置" });
      if (typeof path === "string") setDefaultSaveDir(path);
    } catch {
      setMessage("当前环境无法选择目录");
    }
  };
  const openWorkspaceAssetDir = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_workspace_asset_root");
    } catch (error) {
      setMessage(`无法打开本机素材目录：${String(error)}`);
    }
  };
  const commitAutosaveMinutes = () => {
    const next = normalizeAutosaveMinutes(autosaveMinutesDraft);
    setAutosaveMinutesDraft(String(next));
    setAutosaveMinutes(next);
    setMessage(`自动保存间隔已设为 ${next} 分钟`);
  };
  const closeApplication = async () => {
    if (!flushActiveProjectSave()) {
      setMessage("当前项目尚未保存，已取消关闭。请先导出项目或清理本机存储空间后再试。");
      return;
    }
    try {
      await getCurrentWindow().close();
    } catch (error) {
      setMessage(`关闭失败：${String(error)}`);
    }
  };
  const openHistoryProject = (item: HistoryProject) => {
    if (item.id === historyIdRef.current) return;
    if (!flushActiveProjectSave()) {
      setMessage("当前项目未能离线保存，已取消切换。请先导出当前项目或清理本机存储空间。");
      return;
    }
    const nextProject = safeProject(item.project);
    if (!persistProjectSnapshot(nextProject, item.id, item.name)) {
      setMessage("目标项目无法写入本机存储，已取消切换。请先导出当前项目或清理本机存储空间。");
      return;
    }
    undoHistory.current = [];
    activateProjectIdentity(item.id, item.name, nextProject);
    setProject(nextProject);
    setHistoryId(item.id);
    setProjectName(item.name);
    resetProjectSession();
    setPreferences(false);
    setMessage("历史项目已打开");
  };
  const deleteHistoryProject = (id: string) => {
    const deletingActive = id === historyIdRef.current;
    const nextHistory = historyProjectsRef.current.filter((item) => item.id !== id);
    try {
      let retainedHistory = nextHistory;
      if (deletingActive) {
        // Deleting the document currently on screen used to be blocked, which
        // made the last remaining history card impossible to remove. Commit a
        // fresh empty project first so autosave and close handlers always have
        // a valid active identity, then retire the requested project.
        const replacementId = newId();
        const replacementName = "未命名项目";
        const replacementProject = starter();
        const saved = saveProjectWorkspace(localStorage, {
          id: replacementId,
          name: replacementName,
          updatedAt: Date.now(),
          project: replacementProject,
        }, nextHistory);
        retainedHistory = saved.records;
        removeDeletedProjectStorage(localStorage, id, true);
        undoHistory.current = [];
        activateProjectIdentity(replacementId, replacementName, replacementProject);
        setProject(replacementProject);
        setHistoryId(replacementId);
        setProjectName(replacementName);
        resetProjectSession();
      } else {
        // Keep the index authoritative before removing the document. If
        // storage is full, leave the visible history and document untouched.
        saveProjectIndex(localStorage, nextHistory);
        removeDeletedProjectStorage(localStorage, id);
      }
      historyProjectsRef.current = retainedHistory;
      setHistoryProjects(retainedHistory);
      if (isTauri()) {
        void import("@tauri-apps/api/core")
          .then(({ invoke }) => invoke("delete_workspace_project_assets", { projectId: id }))
          .catch((error) => setLogs((current) => [...current, `项目素材清理失败：${String(error)}`]));
      }
      setMessage("历史项目已删除");
    } catch {
      setMessage("历史项目删除失败，请导出项目后检查本机存储空间");
    }
  };
  const downloadMedia = async (node: NodeItem) => {
    if (!node.src && !node.localPath) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await save({ defaultPath: node.fileName || node.name });
      if (!path) return;
      let dataUrl: string | null = node.src?.startsWith("data:")
        ? node.src
        : null;
      if (!node.localPath && !dataUrl && node.src) {
        const blob = await fetch(node.src).then((response) => {
          if (!response.ok) throw Error("无法读取媒体文件");
          return response.blob();
        });
        dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(Error("无法读取媒体文件"));
          reader.readAsDataURL(blob);
        });
      }
      await invoke("save_media", {
        path,
        sourcePath: node.localPath || null,
        dataUrl,
      });
      setMessage("媒体已下载到本地");
    } catch (error) {
      setMessage(`下载失败：${String(error).replace(/^Error: /, "")}`);
    }
  };
  const importProject = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    readProjectJsonFile(f, (data) => {
      // The package path performs schema migration, portability inspection,
      // secret redaction and a synchronous save of the current project before
      // replacing the canvas. It also identifies a pasted ComfyUI workflow
      // instead of opening it as a malformed project.
      openProjectPackage(data, f.name);
    });
    e.target.value = "";
  };
  const autoConnect = async (silent = false) => {
    const sequence = ++autoConnectSequence.current;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{
        connected: boolean;
        endpoint: string;
        detail: string;
      }>("find_comfyui");
      // A slow earlier probe must not overwrite a later manual reconnect.
      if (sequence !== autoConnectSequence.current) return;
      if (result.connected) {
        setApiUrl(result.endpoint);
        setComfyConnected(true);
        if (!silent) setMessage(result.detail);
      } else {
        setComfyConnected(false);
        if (!silent) setMessage(result.detail);
      }
    } catch {
      if (sequence !== autoConnectSequence.current) return;
      setComfyConnected(false);
      if (!silent) setMessage("自动连接组件没有启动，请使用新版桌面程序");
    }
  };
  useEffect(() => {
    void autoConnect(true);
    const checkVisibleConnection = () => {
      if (document.visibilityState === "visible") void autoConnect(true);
    };
    // Connection discovery is informational while no task is being submitted.
    // A 30-second cadence is responsive enough without continuously waking the
    // desktop backend while the user is typing or arranging the canvas.
    const timer = window.setInterval(checkVisibleConnection, 30_000);
    window.addEventListener("focus", checkVisibleConnection);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", checkVisibleConnection);
      autoConnectSequence.current += 1;
    };
  }, []);
  const prepareLinkedWorkflow = async (
    apiId: string,
    rawWorkflow: unknown,
    promptOverride = "",
    projectSnapshot: Project = projectRef.current,
    // Imported Comfy API JSON may use custom nodes whose /object_info contract
    // is incomplete.  Those workflows already run in ComfyUI, so let ComfyUI
    // be the final validator instead of rejecting them because the canvas has
    // no typed sockets for every private/custom input.
    deferValidationToComfy = false,
  ) => {
    const { invoke } = await import("@tauri-apps/api/core");
    const seen = new Set<string>();
    const sources: NodeItem[] = [];
    const visit = (target: string) =>
      projectSnapshot.links
        .filter((link) => link.to === target)
        .forEach((link) => {
          if (seen.has(link.from)) return;
          seen.add(link.from);
          const source = projectSnapshot.nodes.find((node) => node.id === link.from);
          if (!source) return;
          sources.push(source);
          visit(source.id);
        });
    visit(apiId);
    const linkedText = sources
      .filter(
        (source) => source.kind === "text" || source.kind === "storyboard",
      )
      .map((source) =>
        source.kind === "storyboard"
          ? storyboardText(source.storyboard).trim()
          : source.text?.trim(),
      )
      .filter(Boolean)
      .join("\n\n");
    const text = [promptOverride.trim(), linkedText].filter(Boolean).join("\n\n");
    const media = sources
      .filter(
        (source) =>
          source.kind === "image" ||
          source.kind === "video" ||
          source.kind === "audio",
      )
      .filter((source) => source.src || source.localPath);
    const uploaded: Array<{ kind: Kind; name: string }> = [];
    for (const source of media) {
      const name = await invoke<string>("upload_comfy_media", {
        endpoint: apiUrl,
        filename: source.fileName || source.name || `canvas-${source.id}`,
        dataUrl: source.src?.startsWith("data:") ? source.src : null,
        localPath: source.localPath || null,
      });
      uploaded.push({ kind: source.kind, name });
    }
    const copiedWorkflow = JSON.parse(JSON.stringify(rawWorkflow)) as Record<
      string,
      unknown
    >;
    // ComfyUI 的“API 格式”有两种常见形态：直接节点图，或 { prompt: 节点图 }。
    // /prompt 接口只接受节点图，不能把外层 prompt 再包一次，否则画布提交的
    // 实际任务会与 ComfyUI 页面运行的任务不同。
    const workflow = (
      copiedWorkflow.prompt && typeof copiedWorkflow.prompt === "object"
        ? copiedWorkflow.prompt
        : copiedWorkflow
    ) as Record<
      string,
      { class_type?: string; inputs?: Record<string, unknown> }
    >;
    const byKind = (kind: Kind) =>
      uploaded.filter((item) => item.kind === kind).map((item) => item.name);
    // Always read the live schema. A workflow can be edited or a custom node
    // updated after it was imported, so old node ids/types must never be trusted.
    const objectInfo = await invoke<Record<string, any>>("get_comfy_object_info", { endpoint: apiUrl });
    if (!objectInfo || typeof objectInfo !== "object" || Array.isArray(objectInfo) || !Object.keys(objectInfo).length) {
      throw new ComfyWorkflowValidationError([{
        level: "error",
        code: "object-info-required",
        message: "ComfyUI 返回的 /object_info 为空，无法验证当前工作流的 STRING/TEXT、图片、视频和音频插槽；已阻止提交以避免提示词或素材被静默丢弃。",
      }]);
    }
    const bound = bindCanvasInputsToComfyWorkflow(workflow, {
      text,
      image: byKind("image"),
      video: byKind("video"),
      audio: byKind("audio"),
    }, objectInfo);
    const preparedOutput = prepareComfyVisualOutput(bound.graph, objectInfo);
    const structural = validateComfyWorkflow(preparedOutput.graph, objectInfo);
    const rawDiagnostics = [...bound.diagnostics, ...preparedOutput.diagnostics, ...structural.diagnostics];
    // Custom video savers can run normally in ComfyUI while omitting part of
    // their media contract from /object_info.  Only proven broken API links
    // block submission; ComfyUI remains the final validator for custom nodes.
    const blockingCodes = new Set(["source-node-missing", "source-output-missing", "slot-type-mismatch"]);
    const diagnostics = rawDiagnostics.map((diagnostic) => diagnostic.level === "error" && (deferValidationToComfy || !blockingCodes.has(diagnostic.code || ""))
      ? { ...diagnostic, level: "warning" as const, message: `${diagnostic.message}（兼容模式：该自定义节点的接口信息不完整，已交由 ComfyUI 按原工作流验证。）` }
      : diagnostic);
    const errors = diagnostics.filter((diagnostic) => diagnostic.level === "error");
    if (errors.length) throw new ComfyWorkflowValidationError(diagnostics);
    return {
      workflow: preparedOutput.graph,
      summary:
        `${text ? "文字" : ""}${uploaded.length ? `${text ? " + " : ""}${uploaded.map((item) => typeLabel[item.kind]).join("、")}` : ""}` ||
        "工作流原始参数",
      diagnostics,
      interface: structural.interface,
      outputTargets: preparedOutput.outputTargets,
    };
  };
  const stopRun = async (id: string) => {
    const runProjectId = activeProjectIdRef.current;
    const activeRun = runRegistry.current.getSnapshot(runProjectId, id);
    // ComfyUI's /interrupt is global. More importantly, cancellation is bound
    // to one runId: a delayed stop from an old run must never stop a fast
    // retry on the same node.
    if (activeRun?.status === "cancelled") {
      setMessage("停止请求已发送，正在等待 ComfyUI 结束当前任务…");
      return;
    }
    if (!activeRun || activeRun.status !== "running") {
      setMessage("当前节点没有可停止的运行任务。");
      return;
    }
    if (!runRegistry.current.cancel(runProjectId, id, activeRun.runId)) return;
    const item = project.nodes.find((node) => node.id === id);
    setRuntimeNodeStatus(id, "stopping");
    const source = (item?.workflow && typeof item.workflow === "object"
      ? (item.workflow as { source?: GenerationSource }).source
      : undefined);
    const usesLocalComfy = (item?.kind === "api" && !item.onlineProvider) || source === "comfy";
    if (usesLocalComfy) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("interrupt_comfyui", { endpoint: apiUrl });
      } catch (error) {
        addLog(`停止 ComfyUI：${String(error).replace(/^Error: /, "")}`);
      }
    }
    setMessage(usesLocalComfy
      ? "已向 ComfyUI 发送一次停止请求，正在等待任务退出…"
      : "已取消本次画布回流；远程服务若已开始执行，可能仍会在平台侧完成，但结果不会写回画布。",
    );
    window.setTimeout(() => {
      const snapshot = runRegistry.current.getSnapshot(runProjectId, id);
      if (activeProjectIdRef.current !== runProjectId || snapshot?.runId !== activeRun.runId || snapshot.status !== "cancelled") return;
      // The token remains cancelled forever. This is only a visual reset after
      // the requested cancellation grace period, never a permission to commit
      // a late result from the remote task.
      setRuntimeNodeStatus(id, "idle");
      setMessage(usesLocalComfy
        ? "停止请求已完成；如 ComfyUI 仍显示任务，请在 ComfyUI 中仅点击一次红色 X。"
        : "本次生成已停止接收结果；可在对应平台控制台查看或取消远程任务。",
      );
    }, 5000);
  };
  const run = async (
    id: string,
    replaceTargetId?: string,
    workflowOverride?: unknown,
    promptOverride = "",
    inputProjectOverride?: Project,
  ) => {
    const runProjectId = activeProjectIdRef.current;
    // Capture the inputs at the moment the user presses Run.  The matching
    // input signature below prevents late results from replacing a newer edit;
    // this snapshot also keeps Comfy binding and OpenAI prompt collection in
    // sync with that signature instead of reading a later React closure.
    const inputProject = inputProjectOverride || projectRef.current;
    const runIsCurrent = (token: RunToken, inputSignature: string) =>
      canCommitRunWithInputs(token, inputSignature);
    const item = inputProject.nodes.find((n) => n.id === id);
    if (!item) {
      setMessage("运行失败：画布中没有找到目标节点");
      return;
    }
    // A direct Comfy API workflow is self-contained: “0 个画布输入” does
    // not mean it cannot run.  Its custom node interface is validated by the
    // connected ComfyUI instance, not by the generic canvas socket catalogue.
    const isImportedLocalComfyApi = item.kind === "api" && !item.onlineProvider;
    if (!isImportedLocalComfyApi && !validateExecutionGraph(id, "工作流", inputProject)) return;
    if (isImportedLocalComfyApi) {
      addLog("导入的 Comfy API 工作流：跳过画布通用插槽拦截，交由 ComfyUI 按原工作流校验。");
    }
    // 旧版画布会把任意“在线平台”都按 OpenAI 图片接口提交，这会导致
    // 视频平台收到错误请求。只有明确的 OpenAI 兼容节点才允许走该分支。
    if (item?.onlineProvider && item.onlineProvider !== "OpenAI 兼容接口") {
      const provider = item.onlineProvider;
      addLog(`${provider}：该平台的视频协议尚未适配，未提交任务`);
      setMessage(`“${provider}”尚未完成专用协议适配；不会提交任务或扣费。请使用“在线 AI 视频”节点选择生成来源。`);
      return;
    }
    if (item?.onlineProvider === "OpenAI 兼容接口") {
      const nodeConfig = (item.workflow || {}) as { endpoint?: string; apiKey?: string; model?: string };
      const previous = nodeConfig.apiKey ? nodeConfig : openAiConfig;
      if (!previous.endpoint || !previous.apiKey || !previous.model) {
        const endpoint = window.prompt("OpenAI 接口地址", previous.endpoint || "https://api.openai.com/v1");
        if (endpoint === null) return;
        const apiKey = window.prompt("OpenAI API Key（仅保存在本机项目）", previous.apiKey || "");
        if (apiKey === null) return;
        const model = window.prompt("图片模型：gpt-image-1 或 gpt-image-1-mini", previous.model || "gpt-image-1");
        if (model === null) return;
        change((p) => ({ ...p, nodes: p.nodes.map((n) => n.id === id ? { ...n, workflow: { endpoint, apiKey, model }, status: "online" } : n) }));
        setMessage("OpenAI 配置已保存，再点击一次运行生成图片");
        return;
      }
      const seen = new Set<string>();
      const text: string[] = [];
      const visit = (target: string) => inputProject.links.filter((link) => link.to === target).forEach((link) => {
        if (seen.has(link.from)) return;
        seen.add(link.from);
        const source = inputProject.nodes.find((node) => node.id === link.from);
        if (!source) return;
        if (source.kind === "text") text.push(source.text || "");
        if (source.kind === "storyboard") text.push(storyboardText(source.storyboard));
        visit(source.id);
      });
      visit(id);
      const prompt = text.filter(Boolean).join("\n\n");
      if (!prompt) { setMessage("请先连接一个文本/提示词节点到 OpenAI API"); return; }
      const runToken = runRegistry.current.start(runProjectId, id);
      const runInputSignature = createExecutionInputSignature(inputProject, id);
      setRuntimeNodeStatus(id, "running");
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        setMessage("OpenAI 正在生成图片…");
        const src = await invoke<string>("generate_openai_image", { endpoint: previous.endpoint, apiKey: previous.apiKey, prompt, model: previous.model });
        if (!runIsCurrent(runToken, runInputSignature)) return;
        const targets = inputProject.links.filter((link) => link.from === id).map((link) => link.to);
        const outputId = replaceTargetId || targets.map((target) => inputProject.nodes.find((node) => node.id === target)).find((node) => node?.kind === "image")?.id;
        change((p) => ({ ...p, nodes: p.nodes.map((n) => n.id === id ? { ...n, status: "done" } : n.id === outputId ? { ...n, src, name: `OpenAI-${previous.model}.png`, fileName: `OpenAI-${previous.model}.png` } : n) }));
        runRegistry.current.finish(runToken.projectId, runToken.nodeId, runToken.runId);
        setMessage("OpenAI 图片已生成并传入连接的图片节点");
      } catch (error) {
        addLog(`OpenAI：${String(error).replace(/^Error: /, "")}`);
        if (runIsCurrent(runToken, runInputSignature)) {
          setRuntimeNodeStatus(id, "error");
          runRegistry.current.finish(runToken.projectId, runToken.nodeId, runToken.runId);
          setMessage(`OpenAI 生成失败：${humanizeApiError(error)}`);
        }
      }
      return;
    }
    const storedWorkflow = isComfyCanvasWorkflow(item.workflow)
      ? applyComfyParameters(item.workflow.content, item.workflow.parameters, item.workflow.values)
      : item.workflow;
    const runnableWorkflow = workflowOverride || storedWorkflow;
    if (!runnableWorkflow) {
      setMessage("请通过“导入 API”把 ComfyUI 的 API JSON 放入画布");
      return;
    }
    const runToken = runRegistry.current.start(runProjectId, id);
    const runInputSignature = createExecutionInputSignature(inputProject, id);
    setRuntimeNodeStatus(id, "running");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      let prepared;
      try {
        prepared = await prepareLinkedWorkflow(
          id,
          runnableWorkflow,
          promptOverride,
          inputProject,
          isImportedLocalComfyApi,
        );
        if (!runIsCurrent(runToken, runInputSignature)) return;
      } catch (error) {
        if (!(error instanceof ComfyWorkflowValidationError)) throw error;
        const errors = error.diagnostics.filter((diagnostic) => diagnostic.level === "error");
        if (runIsCurrent(runToken, runInputSignature)) {
          setComfyDiagnostics((current) => ({ ...current, [id]: error.diagnostics }));
          setExpandedComfyDiagnostics(id);
          change((p) => ({
            ...p,
            nodes: p.nodes.map((n) => n.id === id ? {
              ...n,
              status: "error",
              validationErrors: [
                ...withoutComfyValidationErrors(n.validationErrors),
                ...errors.map(comfyDiagnosticSummary),
              ],
            } : n),
          }));
          setMessage(`工作流校验未通过：${comfyDiagnosticTitle(errors[0] || error.diagnostics[0])}`);
          errors.forEach((diagnostic) => addLog(`ComfyUI 连线校验：${comfyDiagnosticSummary(diagnostic)}`));
          runRegistry.current.finish(runToken.projectId, runToken.nodeId, runToken.runId);
        }
        return;
      }
      // Warnings and successful media binding are still useful after the task
      // starts.  Keep them on this canvas session, but clear stale preflight
      // errors only after the current live schema has passed validation.
      setComfyDiagnostics((current) => ({ ...current, [id]: prepared.diagnostics }));
      change((p) => ({
        ...p,
        nodes: p.nodes.map((node) => node.id === id
          ? { ...node, validationErrors: withoutComfyValidationErrors(node.validationErrors) }
          : node),
      }));
      const mappingNotes = prepared.diagnostics
        .filter((diagnostic) => diagnostic.level !== "warning")
        .map((diagnostic) => diagnostic.message);
      mappingNotes.forEach((note) => addLog(`ComfyUI 自动适配：${note}`));
      setMessage(`正在把已连接的 ${prepared.summary} 传入 ComfyUI…${mappingNotes.length ? " 已完成节点适配。" : ""}`);
      const queued = await invoke<{ prompt_id?: string }>("queue_comfyui", {
        endpoint: apiUrl,
        workflow: prepared.workflow,
        // Ask ComfyUI to execute the media-producing output nodes verified
        // from the live schema.  Without this, a workflow containing both a
        // text PreviewAny node and VHS_VideoCombine can complete only the text
        // preview, leaving /history without the MP4 that the canvas expects.
        outputTargets: prepared.outputTargets,
      });
      if (!runIsCurrent(runToken, runInputSignature)) return;
      const promptId = queued.prompt_id;
      if (!promptId) throw Error("ComfyUI 没有返回任务编号");
      setMessage("ComfyUI 正在生成，画布会在任务完成后自动接收结果；再次点击节点中央按钮可停止任务");
      type HistoryItem = {
        status?: { status_str?: string };
        outputs?: ComfyHistoryOutputs;
      };
      let history: Record<string, HistoryItem> | undefined;
      let historyFailures = 0;
      let lastHistoryFailure = "";
      // LTX 等本地视频工作流在高分辨率、多参考图、音频和放大链路同时启用时，
      // 实测可能略超过 15 分钟。画布必须比 ComfyUI 的真实任务耐心：只要
      // 连接仍可读，就保持最多一小时的轮询，用户仍可随时按“停止”主动中断。
      // 这避免成片前数秒被前端错误判定为超时、而 MP4 留在 ComfyUI 输出目录。
      for (let count = 0; count < 3600; count++) {
        if (!runIsCurrent(runToken, runInputSignature)) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!runIsCurrent(runToken, runInputSignature)) return;
        try {
          history = await invoke("get_comfy_history", {
            endpoint: apiUrl,
            promptId,
          });
          historyFailures = 0;
        } catch (error) {
          historyFailures += 1;
          lastHistoryFailure = humanizeApiError(error);
          // ComfyUI may briefly refuse /history while its queue is switching
          // or a large video is being encoded.  Do not mark a healthy remote
          // task failed because of one transient polling error.
          if (historyFailures >= 5) {
            throw Error(`连续 ${historyFailures} 次无法读取 ComfyUI 任务状态：${lastHistoryFailure}`);
          }
          if (historyFailures === 1 || historyFailures === 3) {
            addLog(`ComfyUI 任务状态暂时不可读（第 ${historyFailures}/5 次），将自动重试：${lastHistoryFailure}`);
          }
          continue;
        }
        if (history?.[promptId]) break;
      }
      const result = history?.[promptId];
      if (!result) throw Error("生成等待超时");
      if (result.status?.status_str && result.status.status_str !== "success")
        throw Error(`ComfyUI 返回：${result.status.status_str}`);
      const outputs = result.outputs;
      if (!outputs) throw Error("ComfyUI 未返回生成文件");
      const generated: NodeItem[] = [];
      // Prefer live-schema targets. If a custom saver omitted its media
      // contract, compatibility mode may inspect only this task's history and
      // only files explicitly marked `type: output`. Temporary PreviewImage or
      // unsaved VHS files are never promoted into canvas assets.
      const compatibilityCandidates = prepared.outputTargets.length ? [] : Object.keys(outputs);
      const compatibilitySelection = selectComfyHistoryMedia(
        outputs,
        compatibilityCandidates,
        { requireExplicitOutputType: true },
      );
      const compatibilityOutputTargets = prepared.outputTargets.length
        ? prepared.outputTargets
        : [...new Set(compatibilitySelection.media.map((item) => item.outputNodeId))];
      const usingCompatibilityOutputFallback = prepared.outputTargets.length === 0 && compatibilityOutputTargets.length > 0;
      const selection = prepared.outputTargets.length
        ? selectComfyHistoryMedia(outputs, compatibilityOutputTargets)
        : compatibilitySelection;
      const returnedMedia = selection.media;
      const returnedTargetIds = new Set(returnedMedia.map((item) => item.outputNodeId));
      const historyDiagnostics = prepared.outputTargets
        .filter((nodeId) => !returnedTargetIds.has(nodeId))
        .map((nodeId): ComfyWorkflowDiagnostic => ({
          level: returnedMedia.length ? "warning" : "error",
          code: "output-history-missing",
          nodeId,
          message: `已验证的输出节点 #${nodeId} 没有在本次 ComfyUI /history 中回传图片、视频或音频；画布不会改用其他节点的结果。`,
        }));
      const filteredIntermediate = selection.discarded.filter((media) => media.reason === "intermediate-file" || media.reason === "unverified-file");
      const filteredCompanions = selection.discarded.filter((media) => media.reason === "video-companion" || media.reason === "duplicate-file");
      const mediaFilterDiagnostics: ComfyWorkflowDiagnostic[] = [];
      if (filteredIntermediate.length) mediaFilterDiagnostics.push({
        level: "info",
        code: "history-intermediate-media-ignored",
        message: `已忽略 ${filteredIntermediate.length} 个临时 Preview/未验证 History 文件；它们不会作为最终素材回流画布。`,
      });
      if (filteredCompanions.length) mediaFilterDiagnostics.push({
        level: "info",
        code: "history-video-companion-ignored",
        message: `已忽略 ${filteredCompanions.length} 个与最终视频重复的缩略图、伴生音频或重复文件。独立音频保存节点的结果仍会保留。`,
      });
      if (mediaFilterDiagnostics.length) {
        mediaFilterDiagnostics.forEach((diagnostic) => addLog(`ComfyUI 输出筛选：${diagnostic.message}`));
      }
      const compatibilityDiagnostics: ComfyWorkflowDiagnostic[] = [];
      if (usingCompatibilityOutputFallback) {
        const compatibilityDiagnostic: ComfyWorkflowDiagnostic = {
          level: "warning",
          code: "history-output-compatibility-fallback",
          message: "该自定义工作流未在 /object_info 声明媒体输出；已仅从本次任务 /history 中明确标记为 output 的持久文件回流，临时 Preview 不会回流。",
        };
        compatibilityDiagnostics.push(compatibilityDiagnostic);
        addLog(`ComfyUI 兼容回流：${compatibilityDiagnostic.message}`);
      }
      if (historyDiagnostics.length || mediaFilterDiagnostics.length || compatibilityDiagnostics.length) {
        setComfyDiagnostics((current) => ({
          ...current,
          [id]: [...prepared.diagnostics, ...compatibilityDiagnostics, ...historyDiagnostics, ...mediaFilterDiagnostics],
        }));
      }
      for (const { file, kind } of returnedMedia) {
        // A ComfyUI endpoint can be local or remote and its history payload is
        // not a filesystem authorization token. Always read generated media
        // through ComfyUI's /view contract instead of exposing `fullpath`
        // through Tauri's asset protocol.
        const liveSrc = `${apiUrl.replace(/\/$/, "")}/view?filename=${encodeURIComponent(file.filename)}&subfolder=${encodeURIComponent(file.subfolder || "")}&type=${encodeURIComponent(file.type || "output")}`;
        let persistedMedia: ImportedWorkspaceMedia | null = null;
        try {
          persistedMedia = await cacheComfyGeneratedMedia(apiUrl, file, runProjectId);
        } catch (cacheError) {
          // The generation itself is successful and must still return to the
          // canvas. Persisting is best effort here; leave a visible run log so
          // a user understands why this individual card remains live-only.
          addLog(`ComfyUI 结果未能保存到本机素材库，将暂时使用 ComfyUI 预览地址：${humanizeApiError(cacheError)}`);
        }
        // Prefer the managed copy. It survives a ComfyUI restart and is
        // readable by the desktop asset protocol. VideoCanvas retries the
        // live /view URL once if the just-written local asset is not ready.
        const src = persistedMedia?.src || liveSrc;
        const dimensions = kind === "image" || kind === "video"
          ? await readGeneratedMediaDimensions(kind, src)
          : null;
        const cardSize = kind === "image" || kind === "video"
          ? generatedMediaCardSize(kind, dimensions)
          : { width: nodeSize[kind][0], height: nodeSize[kind][1] };
        generated.push({
          id: newId(),
          kind,
          x: item.x + item.width + 110,
          y: item.y + generated.length * (cardSize.height + 50),
          width: cardSize.width,
          height: cardSize.height,
          name: file.filename,
          src,
          ...(src !== liveSrc ? { fallbackSrc: liveSrc } : {}),
          ...(persistedMedia?.localPath ? { localPath: persistedMedia.localPath } : {}),
          ...(dimensions ? { mediaWidth: dimensions.width, mediaHeight: dimensions.height } : {}),
          createdAt: Date.now(),
        });
      }
      if (!generated.length) {
        const expectedOutputs = prepared.outputTargets.length
          ? `已验证的输出节点（${prepared.outputTargets.map((nodeId) => `#${nodeId}`).join("、")}）`
          : "本次任务的输出节点";
        throw Error(`ComfyUI 已执行，但${expectedOutputs}没有返回图片、视频或音频文件。请检查保存/预览节点是否启用，以及 ComfyUI 的 /history 是否记录该节点结果。`);
      }
      const replacement = replaceTargetId
        ? generated.find((node) => node.kind === inputProject.nodes.find((node) => node.id === replaceTargetId)?.kind) || generated[0]
        : undefined;
      const appended = replacement ? generated.filter((node) => node.id !== replacement.id) : generated;
      if (!runIsCurrent(runToken, runInputSignature)) return;
      setRecent((items) => [...generated, ...items]);
      setRecentOpen(true);
      change((p) => {
        let next: Project = {
          ...p,
          nodes: [
          ...p.nodes.map((node) =>
            node.id === id ? { ...node, status: "done", validationErrors: withoutComfyValidationErrors(node.validationErrors) }
              : node.id === replaceTargetId && replacement
                ? { ...node, src: replacement.src, localPath: replacement.localPath, name: replacement.name, fileName: replacement.name }
                : node,
          ),
            ...appended,
          ],
        };
        for (const output of appended) next = appendTypedLink(next, id, output.id).project;
        return next;
      });
      setMessage(
        replacement
          ? "生成成功：已替换当前媒体"
          : generated.length
          ? `生成成功：${generated.length} 个结果已显示并连接到画布`
          : "生成成功，但没有可预览文件",
      );
      runRegistry.current.finish(runToken.projectId, runToken.nodeId, runToken.runId);
    } catch (error) {
      if (runIsCurrent(runToken, runInputSignature)) {
        setRuntimeNodeStatus(id, "error");
        runRegistry.current.finish(runToken.projectId, runToken.nodeId, runToken.runId);
        setMessage(`生成失败：${humanizeApiError(error)}`);
      }
    }
  };
  const getAiTextProviderConnection = (settings: AiTextSettings) => {
    const provider = (settings.provider === "OpenAI 兼容" ? "OpenAI" : settings.provider || "OpenAI") as keyof typeof AI_TEXT_PROVIDER_PRESETS;
    const preset = AI_TEXT_PROVIDER_PRESETS[provider] || AI_TEXT_PROVIDER_PRESETS.OpenAI;
    if (provider === "阿里百炼·通义千问") {
      const config = resolvedProviderConfig("阿里百炼·万相", "text");
      return { provider, endpoint: config?.endpoint || preset.endpoint, apiKey: config?.apiKey || "", model: settings.model || config?.model || preset.defaultModel, visionModel: config?.model || preset.visionModel };
    }
    if (provider === "MiniMax") {
      const config = resolvedProviderConfig("MiniMax Hailuo", "text");
      return { provider, endpoint: config?.endpoint || preset.endpoint, apiKey: config?.apiKey || "", model: settings.model || config?.model || preset.defaultModel, visionModel: config?.model || preset.visionModel };
    }
    if (provider === "Ollama（本地）") {
      const config = resolvedProviderConfig("Ollama（本地）", "text") || ONLINE_PROVIDER_DEFAULTS["Ollama（本地）"];
      const model = settings.model || config.model || "";
      return { provider, endpoint: config.endpoint, apiKey: "", model, visionModel: model };
    }
    if (provider !== "OpenAI" && categoryProviderConfigs.text[provider]) {
      const config = resolvedProviderConfig(provider, "text")!;
      const model = settings.model || config.model || "";
      return { provider, endpoint: config.endpoint, apiKey: config.apiKey || "", model, visionModel: config.model || preset.visionModel };
    }
    return { provider: "OpenAI" as const, endpoint: openAiProvider.endpoint || preset.endpoint, apiKey: openAiProvider.apiKey || "", model: settings.model || openAiProvider.model || preset.defaultModel, visionModel: openAiProvider.model || preset.visionModel };
  };
  const requestAiTextProviderConfiguration = (provider: string) => {
    if (provider === "阿里百炼·通义千问") {
      openOnlineConfiguration("byok", "阿里百炼·万相", "text");
      setMessage("请保存阿里百炼 API Key；文本和图片理解会自动使用通义千问兼容接口。");
    } else if (provider === "MiniMax") {
      openOnlineConfiguration("byok", "MiniMax Hailuo", "text");
      setMessage("请保存 MiniMax API Key；文本和视觉模型会自动匹配。");
    } else if (provider === "Ollama（本地）") {
      openOnlineConfiguration("byok", "Ollama（本地）", "text");
      setMessage("请先测试本地 Ollama 连接并选择已安装的模型。");
    } else if (onlineProviderNames.includes(provider)) {
      openOnlineConfiguration("byok", provider, "text");
      setMessage(`请完成“${provider}”的接口地址、API Key 和文本模型配置。`);
    } else {
      openOnlineConfiguration("byok", "OpenAI", "text");
      setMessage("请填写 OpenAI 或兼容接口的地址、API Key 和模型。");
    }
  };
  const describeAiTextImage = async (node: NodeItem, image: AiReferenceImage) => {
    const sourceProjectId = activeProjectIdRef.current;
    const isRecognitionCurrent = () =>
      activeProjectIdRef.current === sourceProjectId &&
      projectRef.current.nodes.some((candidate) => candidate.id === node.id);
    const settings = (node.workflow || {}) as AiTextSettings;
    const connection = getAiTextProviderConnection(settings);
    const usesOllama = connection.provider === "Ollama（本地）";
    if (usesOllama && !connection.visionModel.trim()) {
      throw new Error("当前 Ollama 尚未选择模型；请点底部“未配置/已配置”，选择一个支持视觉的本地模型");
    }
    if (!usesOllama && !connection.apiKey) {
      throw new Error(`当前 ${connection.provider} 尚未配置 API Key；请点底部“未配置/已配置”完成设置`);
    }
    const { invoke } = await import("@tauri-apps/api/core");
    setMessage(`正在使用 ${connection.provider} 识别“${image.name}”中的人物与场景…`);
    try {
      // Desktop references are stored in AppLocalData and displayed through
      // convertFileSrc. Convert only this outbound request to a data URL;
      // never write the expanded binary back into the project.
      const imageData = await readSourceAsDataUrl(image.src);
      const description = usesOllama
        ? await invoke<string>("describe_ollama_image", {
          endpoint: connection.endpoint,
          model: connection.visionModel,
          imageData,
        })
        : await invoke<string>("describe_openai_image", {
          endpoint: connection.endpoint,
          apiKey: connection.apiKey,
          model: connection.visionModel,
          imageData,
        });
      if (!isRecognitionCurrent()) {
        throw new Error("识别期间目标项目或节点已改变，结果未写入");
      }
      setMessage(`已识别“${image.name}”，人物与场景信息已写入文本框。`);
      return description.trim();
    } catch (error) {
      const detail = String(error).replace(/^Error: /, "");
      if (isRecognitionCurrent()) setMessage(`图片识别失败：${detail}`);
      throw error;
    }
  };
  const generateAiNode = async (node: NodeItem, promptOverride?: string) => {
    const isTextGeneration = node.kind === "aiText" || node.kind === "text";
    const isImageGeneration = node.kind === "aiImage" || node.kind === "image";
    const isDirectNode = node.kind === "text" || node.kind === "image";
    const settings = (node.workflow || {}) as AiTextSettings & AiImageSettings;
    const closeGenerationEditors = () => {
      setActiveAiNode(null);
      setPromptLibraryTarget(null);
      setAtReferenceMenu(null);
    };
    const isStoryboardFramesGeneration = isTextGeneration && settings.outputMode === "storyboardFrames";
    const upstreamNodes = project.links
      .filter((link) => link.to === node.id)
      .map((link) => project.nodes.find((item) => item.id === link.from))
      .filter((item): item is NodeItem => Boolean(item));
    const upstreamText = upstreamNodes
      .map((item) => item.kind === "text" ? item.text || "" : item.kind === "storyboard" ? storyboardText(item.storyboard) : "")
      .filter((text) => text.trim());
    const effectivePrompt = promptOverride ?? [settings.prompt || "", ...upstreamText].filter((text) => text.trim()).join("\n\n");
    const upstreamImages = upstreamNodes
      .filter((item): item is NodeItem & { src: string } => item.kind === "image" && Boolean(item.src))
      .map((item) => ({ id: item.id, name: item.name, src: item.src }));
    if (!validateExecutionGraph(node.id, isTextGeneration ? "剧本" : "图片")) return;
    if (settings.source === "cloud") {
      setMessage("该旧节点使用了已移除的云积分来源，请选择并保存 API Key 后重试。");
      openOnlineConfiguration("byok");
      return;
    }
    if (settings.source === "comfy") {
      const localSettings = settings as (AiTextSettings & AiImageSettings) & { comfyWorkflowId?: string; comfyValues?: Record<string, string | number | boolean> };
      const workflows = readComfyWorkflowLibrary().filter((item) => item.apiContent || item.format === "api");
      // A newly added local generation node should be usable immediately when
      // there is exactly one compatible workflow in the library. Requiring a
      // second click just to choose the only option made the canvas feel as if
      // it was redirecting to settings instead of generating.
      const workflow = workflows.find((item) => item.id === localSettings.comfyWorkflowId)
        || (workflows.length === 1 ? workflows[0] : undefined);
      if (!workflow) {
        setMessage("请先选择一个已扫描参数的 ComfyUI 工作流。");
        setWorkflowLibraryOpen(true);
        return;
      }
      const selectedComfyWorkflowSettings = !localSettings.comfyWorkflowId
        ? { ...localSettings, comfyWorkflowId: workflow.id }
        : null;
      const inputProjectOverride = selectedComfyWorkflowSettings
        ? {
            ...projectRef.current,
            nodes: projectRef.current.nodes.map((candidate) => candidate.id === node.id
              ? { ...candidate, workflow: selectedComfyWorkflowSettings }
              : candidate),
          }
        : undefined;
      if (selectedComfyWorkflowSettings) {
        change((p) => ({
          ...p,
          nodes: p.nodes.map((candidate) => candidate.id === node.id
            ? { ...candidate, workflow: selectedComfyWorkflowSettings }
            : candidate),
        }));
      }
      const apiContent = workflow.apiContent || (workflow.format === "api" ? workflow.content : undefined);
      if (!apiContent) {
        setMessage("这个 Workflow JSON 还没有转换成 API 格式，请在工作流库点击“扫描参数”。");
        setWorkflowLibraryOpen(true);
        return;
      }
      const configured = applyComfyParameters(apiContent, workflow.parameters || [], localSettings.comfyValues || {});
      setMessage(`正在使用本地工作流“${workflow.name}”运行 ${workflow.parameters?.filter((parameter) => parameter.enabled).length || 0} 项参数${localSettings.comfyWorkflowId ? "…" : "（已自动选择唯一工作流）…"}`);
      await run(node.id, undefined, configured, effectivePrompt, inputProjectOverride);
      return;
    }
    const textConnection = isTextGeneration ? getAiTextProviderConnection(settings as AiTextSettings) : null;
    const imageSettings = isImageGeneration ? settings as AiImageSettings : null;
    const imageProvider = imageSettings?.provider || "OpenAI";
    const imageProviderConfig = resolvedProviderConfig(imageProvider, "image");
    const googleConfig = resolvedProviderConfig("Google Nano Banana", "image");
    if (isTextGeneration && textConnection?.provider !== "Ollama（本地）" && !textConnection?.apiKey) {
      requestAiTextProviderConfiguration(textConnection?.provider || "OpenAI");
      return;
    }
    if (isTextGeneration && textConnection?.provider === "Ollama（本地）" && !textConnection!.model.trim()) {
      openOnlineConfiguration("byok", "Ollama（本地）", "text");
      setMessage("请先启动 Ollama，点击“自动读取并识别模型”，再选择已安装模型。 ");
      return;
    }
    if (isImageGeneration && imageProvider === "Google Nano Banana" && (!googleConfig?.endpoint || !googleConfig.apiKey)) {
      openOnlineConfiguration("byok", "Google Nano Banana", "image");
      setMessage("请先填写 Google AI Studio 的 Gemini API Key。");
      return;
    }
    const openAiImageProvider = resolvedProviderConfig("OpenAI", "image");
    if (isImageGeneration && imageProvider === "OpenAI" && (!openAiImageProvider?.endpoint || !openAiImageProvider.apiKey)) {
      openOnlineConfiguration("byok", "OpenAI", "image");
      setMessage("请先填写 OpenAI 或兼容接口地址和 API Key。");
      return;
    }
    if (isImageGeneration && !["OpenAI", "Google Nano Banana", "阿里百炼·万相", "Midjourney（手动命令）"].includes(imageProvider) && (!imageProviderConfig?.capabilities?.includes("image") || imageProviderConfig.protocol !== "openai")) {
      setMessage(`“${imageProvider}”没有可用的图片生成协议；请配置支持图片生成的 OpenAI 兼容接口。`);
      return;
    }
    if (isImageGeneration && !["OpenAI", "Google Nano Banana", "Midjourney（手动命令）"].includes(imageProvider) && (!imageProviderConfig?.endpoint || !imageProviderConfig.apiKey || !imageSettings?.model)) {
      openOnlineConfiguration("byok", imageProvider, "image");
      setMessage(`请先完成“${imageProvider}”的接口地址、API Key 和图片模型配置。`);
      return;
    }
    const effectiveImageModel = imageSettings?.model
      || (imageProvider === "Google Nano Banana" ? googleConfig?.model : undefined)
      || (imageProvider === "OpenAI" ? openAiImageProvider?.model : imageProviderConfig?.model)
      || "gpt-image-1";
    const imageCapabilities = imageSettings && imageProvider !== "Midjourney（手动命令）"
      ? imageCapabilitiesFor(imageProvider, effectiveImageModel)
      : null;
    // The editor exposes a shared parameter vocabulary. Do not silently
    // replace a user's selected size or batch with a profile default; the
    // capability check below reports the exact unsupported combination.
    const normalizedImageOptions = imageSettings && imageCapabilities
      ? {
          ratio: imageSettings.ratio as ImageAspectRatio,
          resolution: imageSettings.resolution as ImageResolution,
          amount: Math.max(1, Math.min(5, Number(imageSettings.amount) || 1)),
          quality: imageSettings.quality as ImageQuality,
        }
      : null;
    if (imageSettings && imageCapabilities && normalizedImageOptions) {
      const optionErrors = validateImageGenerationOptions(imageCapabilities, {
        ratio: normalizedImageOptions.ratio,
        resolution: normalizedImageOptions.resolution,
        amount: normalizedImageOptions.amount,
        quality: normalizedImageOptions.quality,
      });
      if (optionErrors.length) {
        setMessage(`图片参数无效：${optionErrors.join("；")}`);
        return;
      }
    }
    const normalizedWorkflow = normalizedImageOptions && imageSettings
      ? { ...imageSettings, ...normalizedImageOptions, model: effectiveImageModel }
      : node.workflow;
    // React may batch the following state write until this event completes.
    // Sign the same projected node state now, rather than reading a ref that
    // still contains the pre-normalisation workflow for one render tick.
    const inputProject = {
      ...projectRef.current,
      nodes: projectRef.current.nodes.map((item) => item.id === node.id
        ? { ...item, workflow: normalizedWorkflow }
        : item),
    };
    change((current) => ({
      ...current,
      nodes: current.nodes.map((item) => item.id === node.id
        ? { ...item, workflow: normalizedWorkflow }
        : item),
    }));
    // Persist any capability-normalized image settings before taking the
    // execution snapshot. Otherwise the app would invalidate its own task as
    // soon as the normalized ratio/quality reached project state.
    const runToken = runRegistry.current.start(activeProjectIdRef.current, node.id);
    const runInputSignature = createExecutionInputSignature(inputProject, node.id);
    setRuntimeNodeStatus(node.id, "running");
    const generationRecord: ApiGenerationRecord = {
      kind: isTextGeneration ? "text" : "image",
      sourceNodeId: node.id,
      workflow: normalizedWorkflow,
      prompt: effectivePrompt,
      createdAt: Date.now(),
    };
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (isTextGeneration) {
        const textSettings = settings as AiTextSettings;
        const storyboardFrames = normalizeStoryboardFramePlans(textSettings.storyboardFrames);
        const systemPrompt = isStoryboardFramesGeneration
          ? storyboardGenerationSystemPrompt({
              frames: storyboardFrames,
              ratio: textSettings.storyboardRatio || "16:9",
              style: textSettings.storyboardStyle || "电影写实",
              language: textSettings.language || "简体中文",
            })
          : [
              "你是一名专业影视编剧。请直接输出结构完整、可拍摄的中文剧本。",
              `题材：${textSettings.genre || "剧情短片"}`,
              `格式：${textSettings.format || "标准影视剧本"}`,
              `篇幅：${textSettings.length || "中篇"}`,
              `风格：${textSettings.tone || "电影感"}`,
              `集数：${textSettings.episodeCount || 1}，每集约 ${textSettings.episodeMinutes || 5} 分钟`,
              textSettings.includeCharacters ? "先给出人物小传。" : "",
              textSettings.includeStoryboard ? "剧本后附关键分镜建议。" : "",
              "必须包含场次、时间、地点、人物、动作和对白，不要解释创作过程。",
            ].filter(Boolean).join("\n");
        const result = textConnection!.provider === "Ollama（本地）"
          ? await invoke<string>("generate_ollama_text", {
              endpoint: textConnection!.endpoint,
              prompt: effectivePrompt,
              model: textConnection!.model,
              systemPrompt,
              temperature: textSettings.creativity || 0.8,
            })
          : await invoke<string>("generate_openai_text", {
              endpoint: textConnection!.endpoint,
              apiKey: textConnection!.apiKey,
              prompt: effectivePrompt,
              model: textConnection!.model,
              systemPrompt,
              temperature: textSettings.creativity || 0.8,
            });
        if (!canCommitRunWithInputs(runToken, runInputSignature)) return;
        if (isStoryboardFramesGeneration) {
          const rows: StoryboardRow[] = parseGeneratedStoryboard(result, storyboardFrames);
          const output: NodeItem = {
            id: newId(),
            kind: "storyboard",
            x: node.x + node.width + 90,
            y: node.y,
            width: nodeSize.storyboard[0],
            height: Math.min(620, Math.max(nodeSize.storyboard[1], 104 + rows.length * 52)),
            name: `AI 分镜画面（${rows.length}个）`,
            storyboard: rows,
            text: storyboardText(rows),
            generationRecord,
            status: "done",
            createdAt: Date.now(),
          };
          change((current) => appendTypedLink({ ...current, nodes: [...current.nodes.map((item) => item.id === node.id ? { ...item, status: "done" } : item), output] }, node.id, output.id).project);
          setActiveAiNode(null);
          setActiveStoryboard(output.id);
          setSelected([output.id]);
          setMessage(`已生成 ${rows.length} 个分镜画面；可在分镜表格中继续添加或修改。`);
        } else if (isDirectNode) {
          change((current) => ({ ...current, nodes: current.nodes.map((item) => item.id === node.id ? { ...item, text: result, status: "done", generationRecord } : item) }));
          setMessage("AI 剧本已直接写入当前文本节点");
        } else {
          const output: NodeItem = { id: newId(), kind: "text", x: node.x + node.width + 90, y: node.y, width: 420, height: 320, name: "AI 完整剧本", text: result, status: "done", generationRecord, createdAt: Date.now() };
          change((current) => appendTypedLink({ ...current, nodes: [...current.nodes.map((item) => item.id === node.id ? { ...item, status: "done" } : item), output] }, node.id, output.id).project);
          setMessage("完整剧本已生成并连接到画布");
        }
        runRegistry.current.finish(runToken.projectId, runToken.nodeId, runToken.runId);
        closeGenerationEditors();
      } else {
        const currentImageSettings = { ...imageSettings!, ...(normalizedImageOptions || {}), model: effectiveImageModel };
        const fullPrompt = [effectivePrompt, `视觉风格：${currentImageSettings.style || "电影写实"}`, currentImageSettings.negativePrompt ? `避免：${currentImageSettings.negativePrompt}` : ""].filter(Boolean).join("\n");
        const references = [...upstreamImages, ...(currentImageSettings.references || []).filter((reference) => !upstreamImages.some((item) => item.id === reference.id))];
        if (imageProvider === "Midjourney（手动命令）") {
          const command = `/imagine prompt: ${fullPrompt.replace(/\s+/g, " ").trim()} --ar ${currentImageSettings.ratio || "1:1"}`;
          try { await navigator.clipboard.writeText(command); } catch { /* Clipboard permissions can be denied; the text node remains available. */ }
          if (!canCommitRunWithInputs(runToken, runInputSignature)) return;
          const output: NodeItem = { id: newId(), kind: "text", x: node.x + node.width + 90, y: node.y, width: 520, height: 220, name: "Midjourney 手动命令", text: command, status: "done", createdAt: Date.now() };
          change((current) => ({ ...current, nodes: [...current.nodes.map((item) => item.id === node.id ? { ...item, status: "done" } : item), output] }));
          runRegistry.current.finish(runToken.projectId, runToken.nodeId, runToken.runId);
          closeGenerationEditors();
          setMessage("Midjourney 官方未开放公共 API；已生成安全的手动命令并尝试复制，请到官方网页或 Discord 提交后导回结果。");
          return;
        }
        if (currentImageSettings.mode === "image" && references.length === 0) {
          throw new Error("图生图模式需要先添加或连接至少一张参考图片");
        }
        const referenceLimit = imageCapabilities?.referenceImageLimit ?? 1;
        if (references.length > 0 && referenceLimit === 0) {
          throw new Error(`模型“${effectiveImageModel}”不支持图片参考，请切换到文生图或选择支持图生图的模型`);
        }
        // Managed desktop files are previewed from AppLocalData. Convert an
        // image to a Data URL only at the moment an external provider needs
        // it; it is never written back into the project JSON.
        const referenceData = await Promise.all(references.slice(0, referenceLimit).map((reference) => readSourceAsDataUrl(reference.src)));
        if (!canCommitRunWithInputs(runToken, runInputSignature)) return;
        const requestSize = imageCapabilities && normalizedImageOptions?.resolution
          ? imageRequestSizeFor(
              imageCapabilities,
              normalizedImageOptions.ratio as ImageAspectRatio,
              normalizedImageOptions.resolution as ImageResolution,
            )
          : undefined;
        const generatedSources = imageProvider === "阿里百炼·万相"
          ? await (async () => {
              // Qwen Image permits 1–6 images in a single task. Split the
              // node's 1–10 batch into real provider tasks instead of showing
              // an option that the request silently ignores.
              let remaining = Math.max(1, Math.min(5, Number(currentImageSettings.amount) || 1));
              const images: string[] = [];
              while (remaining > 0) {
                const batch = Math.min(6, remaining);
                const result = await invoke<string[]>("generate_dashscope_image", {
                  endpoint: imageProviderConfig!.endpoint,
                  apiKey: imageProviderConfig!.apiKey,
                  prompt: fullPrompt,
                  model: effectiveImageModel,
                  ratio: currentImageSettings.ratio || "1:1",
                  resolution: currentImageSettings.resolution || "1024",
                  amount: batch,
                  imageData: referenceData[0] || null,
                });
                images.push(...result);
                remaining -= batch;
              }
              return images;
            })()
          : [imageProvider === "Google Nano Banana"
          ? await invoke<string>("generate_google_image", {
              endpoint: googleConfig!.endpoint,
              apiKey: googleConfig!.apiKey,
              prompt: fullPrompt,
              model: currentImageSettings.model || googleConfig!.model || "gemini-3.1-flash-image",
              ratio: currentImageSettings.ratio || "1:1",
              resolution: currentImageSettings.resolution || "1024",
              imageData: referenceData.filter(Boolean),
            })
          : referenceData[0]
          ? await invoke<string>("generate_openai_image_edit", {
              endpoint: imageProvider === "OpenAI" ? openAiProvider.endpoint : imageProviderConfig!.endpoint,
              apiKey: imageProvider === "OpenAI" ? openAiProvider.apiKey : imageProviderConfig!.apiKey,
              prompt: fullPrompt,
              model: effectiveImageModel,
              imageData: referenceData[0],
              size: requestSize,
              quality: normalizedImageOptions?.quality,
            })
          : await invoke<string>("generate_openai_image", {
              endpoint: imageProvider === "OpenAI" ? openAiProvider.endpoint : imageProviderConfig!.endpoint,
              apiKey: imageProvider === "OpenAI" ? openAiProvider.apiKey : imageProviderConfig!.apiKey,
              prompt: fullPrompt,
              model: effectiveImageModel,
              size: requestSize,
            quality: normalizedImageOptions?.quality,
          })];
        const src = generatedSources[0];
        if (!src) throw new Error("图片接口没有返回生成结果");
        if (!canCommitRunWithInputs(runToken, runInputSignature)) return;
        // The request aspect ratio is not enough: providers can return an
        // exact frame such as 576×1024. Decode it before creating the canvas
        // card so the renderer does not crop that portrait image into the old
        // fixed landscape 300×220 node.
        const decodedImageDimensions = await readGeneratedMediaDimensions("image", src);
        if (!canCommitRunWithInputs(runToken, runInputSignature)) return;
        const imageCardSize = generatedMediaCardSize("image", decodedImageDimensions);
        const imageName = `AI图片-${Date.now()}.png`;
        const extraOutputs = await Promise.all(generatedSources.slice(1).map(async (extraSrc, index) => {
          const dimensions = await readGeneratedMediaDimensions("image", extraSrc);
          const card = generatedMediaCardSize("image", dimensions);
          const output: NodeItem = {
            id: newId(), kind: "image", x: node.x + node.width + 90, y: node.y + (index + 1) * (card.height + 34),
            width: card.width, height: card.height, name: `AI图片-${Date.now()}-${index + 2}.png`, fileName: `AI图片-${Date.now()}-${index + 2}.png`, src: extraSrc, status: "done", createdAt: Date.now(),
            mediaWidth: dimensions?.width || card.width, mediaHeight: dimensions?.height || card.height - 29,
            generationRecord,
          };
          return output;
        }));
        if (!canCommitRunWithInputs(runToken, runInputSignature)) return;
        if (isDirectNode) {
          change((current) => extraOutputs.reduce((next, output) => appendTypedLink(next, node.id, output.id).project, {
            ...current,
            nodes: [...current.nodes.map((item) => item.id === node.id ? {
            ...item,
            status: "done",
            src,
            fileName: imageName,
            width: imageCardSize.width,
            height: imageCardSize.height,
            mediaWidth: decodedImageDimensions?.width || imageCardSize.width,
            mediaHeight: decodedImageDimensions?.height || imageCardSize.height - 29,
            generationRecord,
          } : item), ...extraOutputs],
          }));
          setMessage(`${imageProvider === "Google Nano Banana" ? "Nano Banana" : "OpenAI"} 图片已直接生成到当前图片节点`);
        } else {
          const output: NodeItem = {
            id: newId(), kind: "image", x: node.x + node.width + 90, y: node.y,
            width: imageCardSize.width, height: imageCardSize.height,
            name: imageName, fileName: imageName, src, status: "done", createdAt: Date.now(),
            mediaWidth: decodedImageDimensions?.width || imageCardSize.width,
            mediaHeight: decodedImageDimensions?.height || imageCardSize.height - 29,
            generationRecord,
          };
          change((current) => [output, ...extraOutputs].reduce((next, generated) => appendTypedLink(next, node.id, generated.id).project, { ...current, nodes: [...current.nodes.map((item) => item.id === node.id ? { ...item, status: "done", src } : item), output, ...extraOutputs] }));
          setMessage(`${imageProvider === "Google Nano Banana" ? "Nano Banana" : "OpenAI"} 图片已生成并连接到画布${upstreamText.length ? `；已合并 ${upstreamText.length} 个文本输入` : ""}${references.length ? `；已使用 ${Math.min(references.length, 14)} 张参考图` : ""}`);
        }
        runRegistry.current.finish(runToken.projectId, runToken.nodeId, runToken.runId);
        closeGenerationEditors();
      }
    } catch (error) {
      if (canCommitRunWithInputs(runToken, runInputSignature)) {
        setRuntimeNodeStatus(node.id, "error");
        runRegistry.current.finish(runToken.projectId, runToken.nodeId, runToken.runId);
        setMessage(`AI 生成失败：${humanizeApiError(error)}`);
      }
    }
  };
  const cloneGenerationWorkflow = (workflow: unknown) => {
    if (!workflow || typeof workflow !== "object") return {};
    return JSON.parse(JSON.stringify(workflow)) as Record<string, unknown>;
  };
  const apiGenerationContextFor = (targetId: string) => {
    const snapshot = projectRef.current;
    const target = snapshot.nodes.find((node) => node.id === targetId);
    if (!target) return null;
    const savedRecord = target.generationRecord;
    const isApiGenerator = (candidate: NodeItem | undefined) => {
      if (!candidate || !["aiText", "aiImage", "onlineVideo", "text", "image", "video"].includes(candidate.kind)) return false;
      if (!candidate.workflow || typeof candidate.workflow !== "object") return false;
      const workflow = candidate.workflow as { source?: GenerationSource; provider?: string; model?: string };
      if (workflow.source === "comfy" || workflow.source === "cloud") return false;
      return candidate.kind === "aiText" || candidate.kind === "aiImage" || candidate.kind === "onlineVideo" || Boolean(workflow.provider || workflow.model);
    };
    const linkedSource = snapshot.links
      .filter((link) => link.to === target.id)
      .map((link) => snapshot.nodes.find((node) => node.id === link.from))
      .find(isApiGenerator);
    const isDirectGeneratedTarget = ["text", "image", "video"].includes(target.kind)
      && target.status === "done"
      && Boolean(target.text || target.src);
    const source = snapshot.nodes.find((node) => node.id === savedRecord?.sourceNodeId)
      || linkedSource
      || (isDirectGeneratedTarget && isApiGenerator(target) ? target : undefined);
    if (!source || !isApiGenerator(source)) return null;
    const sourceWorkflow = cloneGenerationWorkflow(savedRecord?.workflow || source.workflow);
    const sourceKind: ApiGenerationRecord["kind"] = source.kind === "onlineVideo" || source.kind === "video"
      ? "video"
      : source.kind === "aiImage" || source.kind === "image"
        ? "image"
        : "text";
    const linkedText = snapshot.links
      .filter((link) => link.to === source.id)
      .map((link) => snapshot.nodes.find((node) => node.id === link.from))
      .map((node) => node?.kind === "text" ? node.text || "" : node?.kind === "storyboard" ? storyboardText(node.storyboard) : "")
      .filter((text) => text.trim());
    const record: ApiGenerationRecord = savedRecord || {
      kind: sourceKind,
      sourceNodeId: source.id,
      workflow: sourceWorkflow,
      prompt: [String(sourceWorkflow.prompt || ""), ...linkedText].filter((text) => text.trim()).join("\n\n"),
      createdAt: target.createdAt || Date.now(),
    };
    return { target, source, record };
  };
  const restoreApiGenerationSource = (source: NodeItem, record: ApiGenerationRecord) => {
    const workflow = cloneGenerationWorkflow(record.workflow);
    const restored = { ...source, workflow };
    change((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === source.id ? restored : node),
    }));
    return restored;
  };
  const modifyApiGeneration = (targetId: string) => {
    const context = apiGenerationContextFor(targetId);
    if (!context) return;
    restoreApiGenerationSource(context.source, context.record);
    setActiveText(null);
    setActiveStoryboard(null);
    setPromptLibraryTarget(null);
    setAtReferenceMenu(null);
    if (context.record.kind === "video") {
      setActiveAiNode(null);
      setOnlinePopover(null);
      setActiveOnlineVideo(context.source.id);
    } else {
      setActiveOnlineVideo(null);
      setOnlinePopover(null);
      setActiveAiNode(context.source.id);
    }
    setMenu(null);
    setMessage("已恢复这次生成前的提示词、参考素材和参数，可修改后再次生成。");
  };
  const regenerateApiOutput = (targetId: string) => {
    const context = apiGenerationContextFor(targetId);
    if (!context) return;
    const restored = restoreApiGenerationSource(context.source, context.record);
    setMenu(null);
    if (context.record.kind === "video") {
      setActiveAiNode(null);
      setActiveOnlineVideo(context.source.id);
      setPendingVideoRegeneration({
        requestId: newId(),
        sourceNodeId: context.source.id,
        prompt: context.record.prompt,
      });
      setMessage("已按该视频保存的原提示词和参数重新提交。");
      return;
    }
    setActiveOnlineVideo(null);
    setActiveAiNode(null);
    setMessage(`正在按该${context.record.kind === "image" ? "图片" : "文本/分镜"}保存的原内容重新生成…`);
    void generateAiNode(restored, context.record.prompt);
  };
  const resize = (e: PointerEvent, id: string) => {
    e.stopPropagation();
    const n = project.nodes.find((x) => x.id === id)!;
    const startProject = project;
    let resized = false;
    const sx = e.clientX,
      sy = e.clientY,
      w = n.width,
      h = n.height;
    const preserveMediaRatio =
      (n.kind === "image" || n.kind === "video") &&
      n.mediaWidth &&
      n.mediaHeight;
    const preservePointerRatio = n.kind === "annotationPointer";
    const move = (ev: globalThis.PointerEvent) => {
      resized = true;
      frameChange((p) => ({
        ...p,
        nodes: p.nodes.map((x) => {
          if (x.id !== id) return x;
          const minWidth = n.kind === "annotation" ? 140 : n.kind === "annotationPointer" ? 32 : 170;
          const minHeight = n.kind === "annotation" ? 70 : n.kind === "annotationPointer" ? 32 : 90;
          const width = Math.max(minWidth, w + (ev.clientX - sx) / p.view.zoom);
          if (x.kind === "annotation") {
            const dx = (ev.clientX - sx) / p.view.zoom;
            const dy = (ev.clientY - sy) / p.view.zoom;
            const horizontalResize = Math.abs(dx) > Math.abs(dy) * 1.5;
            const baseFontSize = n.fontSize ?? 19;
            const fontSize = horizontalResize
              ? baseFontSize
              : Math.max(12, Math.min(48, baseFontSize * (width / Math.max(1, w))));
            const { width: annotationWidth, height: annotationHeight } = annotationMetrics(x.text, width, fontSize);
            return { ...x, width: annotationWidth, height: annotationHeight, fontSize };
          }
          return preserveMediaRatio
            ? {
                ...x,
                width,
                height: Math.max(
                  90,
                  Math.round((width * n.mediaHeight!) / n.mediaWidth!) + 29,
                ),
              }
            : preservePointerRatio
              ? {
                  ...x,
                  width: Math.min(220, width),
                  height: Math.max(minHeight, Math.round(Math.min(220, width) * h / Math.max(1, w))),
                }
            : {
                ...x,
                width,
                height: Math.max(minHeight, h + (ev.clientY - sy) / p.view.zoom),
              };
        }),
      }));
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      if (resized) undoHistory.current = [...undoHistory.current.slice(-5), startProject];
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };
  const rotateAnnotation = (e: PointerEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const n = project.nodes.find((item) => item.id === id);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!n || !rect || n.locked) return;
    const centerX = rect.left + project.view.x + (n.x + n.width / 2) * project.view.zoom;
    const centerY = rect.top + project.view.y + (n.y + n.height / 2) * project.view.zoom;
    const startAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX) * 180 / Math.PI;
    const startRotation = n.rotation || 0;
    const startProject = project;
    let rotated = false;
    const move = (event: globalThis.PointerEvent) => {
      const angle = Math.atan2(event.clientY - centerY, event.clientX - centerX) * 180 / Math.PI;
      rotated = true;
      frameChange((p) => ({
        ...p,
        nodes: p.nodes.map((item) => item.id === id ? { ...item, rotation: startRotation + angle - startAngle } : item),
      }));
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      if (rotated) undoHistory.current = [...undoHistory.current.slice(-5), startProject];
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };
  const curve = (x1: number, y1: number, x2: number, y2: number) =>
    `M ${x1} ${y1} C ${x1 + Math.max(42, Math.abs(x2 - x1) * 0.38)} ${y1}, ${x2 - Math.max(42, Math.abs(x2 - x1) * 0.38)} ${y2}, ${x2} ${y2}`;
  const curveFromLeft = (x1: number, y1: number, x2: number, y2: number) =>
    `M ${x1} ${y1} C ${x1 - Math.max(42, Math.abs(x2 - x1) * 0.38)} ${y1}, ${x2 + Math.max(42, Math.abs(x2 - x1) * 0.38)} ${y2}, ${x2} ${y2}`;
  const canvasNodeIndex = useMemo(() => new Map(project.nodes.map((node) => [node.id, node])), [project.nodes]);
  const canvasSpatialIndex = useMemo(() => buildCanvasSpatialIndex(project.nodes), [project.nodes]);
  const draftPath = draftLink && canvasNodeIndex.get(draftLink.from);
  const portWorldSize = 14 / Math.min(1, project.view.zoom);
  const portStyle = {
    width: portWorldSize,
    height: portWorldSize,
    top: `calc(50% - ${portWorldSize / 2}px)`,
  };
  // A render-time getBoundingClientRect() forced Chromium to complete layout
  // before unrelated state updates, including prompt typing. ResizeObserver
  // keeps the dimensions current without that synchronous layout barrier.
  const viewportWidth = canvasSize.width;
  const viewportHeight = canvasSize.height;
  const overscan = 1200 / project.view.zoom;
  const viewportBounds = {
    minX: -project.view.x / project.view.zoom - overscan,
    minY: -project.view.y / project.view.zoom - overscan,
    maxX: (viewportWidth - project.view.x) / project.view.zoom + overscan,
    maxY: (viewportHeight - project.view.y) / project.view.zoom + overscan,
  };
  const alwaysVisibleNodeIds = new Set([
    ...selected,
    activeText || "",
    activeStoryboard || "",
    activeOnlineVideo || "",
  ]);
  const nearbyNodeIds = queryCanvasSpatialIndex(canvasSpatialIndex, viewportBounds);
  for (const id of alwaysVisibleNodeIds) if (id) nearbyNodeIds.add(id);
  const visibleCanvasNodes = [...nearbyNodeIds]
    .map((id) => canvasNodeIndex.get(id))
    .filter((node): node is NodeItem => Boolean(node))
    .filter((node) => alwaysVisibleNodeIds.has(node.id)
      || (node.x < viewportBounds.maxX && node.x + node.width > viewportBounds.minX
        && node.y < viewportBounds.maxY && node.y + node.height > viewportBounds.minY));
  const visibleNodeIdSet = new Set(visibleCanvasNodes.map((node) => node.id));
  const svgLinks = project.links.filter((link) => {
    if (selectedLinks.includes(link.id) || visibleNodeIdSet.has(link.from) || visibleNodeIdSet.has(link.to)) return true;
    const source = canvasNodeIndex.get(link.from);
    const target = canvasNodeIndex.get(link.to);
    if (!source || !target) return false;
    const x1 = source.x + source.width, y1 = source.y + source.height / 2;
    const x2 = target.x, y2 = target.y + target.height / 2;
    return Math.min(x1, x2) < viewportBounds.maxX && Math.max(x1, x2) > viewportBounds.minX
      && Math.min(y1, y2) < viewportBounds.maxY && Math.max(y1, y2) > viewportBounds.minY;
  }).map((link) => {
    const source = canvasNodeIndex.get(link.from)!;
    const target = canvasNodeIndex.get(link.to)!;
    const x1 = source.x + source.width, y1 = source.y + source.height / 2;
    const x2 = target.x, y2 = target.y + target.height / 2;
    const active = selected.includes(link.from) || selected.includes(link.to);
    const selectedWire = selectedLinks.includes(link.id);
    return <path id={`wire-${link.id}`} className={(active ? "active " : "") + (selectedWire ? "selected-wire" : "")} key={link.id} d={curve(x1, y1, x2, y2)} />;
  });
  return (
<main className={`app theme-${resolvedTheme}${studioOpen ? " studio-open" : ""}`} onContextMenu={(e) => e.preventDefault()}>
      {cinematicLandingOpen && <CinematicLanding
        onEnterCanvas={() => setCinematicLandingOpen(false)}
        onOpenScript={() => {
          setCinematicLandingOpen(false);
          addAtViewport("aiText", {
            name: "AI 剧本生成",
            workflow: {
              source: "byok", provider: "OpenAI", model: "gpt-4.1-mini",
              genre: "剧情短片", format: "标准影视剧本", length: "中篇",
              tone: "电影感", audience: "大众", language: "简体中文",
              creativity: 0.8, episodeCount: 1, episodeMinutes: 5,
              includeStoryboard: true, includeCharacters: true,
            } satisfies AiTextSettings,
          });
        }}
        onOpenImage={() => {
          setCinematicLandingOpen(false);
          addAtViewport("aiImage", {
            name: "AI 图片生成",
            workflow: {
              source: "byok", provider: "OpenAI", model: "gpt-image-1",
              mode: "text", ratio: "1:1", resolution: "1024",
              amount: 1, quality: "low", style: "电影写实", seed: -1, guidance: 7,
            } satisfies AiImageSettings,
          });
        }}
        onGenerate={(prompt) => {
          setCinematicLandingOpen(false);
          addAtViewport("aiImage", {
            name: "AI 图片生成",
            workflow: {
              source: "byok", provider: "OpenAI", model: "gpt-image-1",
              mode: "text", prompt: prompt || "雨夜天台，电影感，克制留白",
              ratio: "1:1", resolution: "1024", amount: 1,
              quality: "low", style: "电影写实", seed: -1, guidance: 7,
            } satisfies AiImageSettings,
          });
        }}
        projectName={projectName}
        onProjectNameChange={updateActiveProjectName}
      />}
      <header className="topbar">
        <div className="topbar-drag-region" data-tauri-drag-region aria-hidden="true" />
        <div className="brand">
          <i className={`connection-dot ${comfyConnected ? "connected" : "disconnected"}`} title={comfyConnected ? "ComfyUI 已连接" : "ComfyUI 未连接"} />
          <b>亿幕画布</b>
        </div>
        <label className="canvas-project-name" title="点击修改项目名称">
          <input value={projectName} onChange={(event) => updateActiveProjectName(event.target.value)} aria-label="项目名称" />
        </label>
        <div className="top-actions">
          <button onClick={newProject}>新建项目</button>
          <button onClick={openMediaLibrary} title="素材库" className="media-lib-btn"><span className="media-lib-grid-icon"><span></span><span></span><span></span><span></span></span></button>
          <div className="top-more" onPointerDown={(e) => e.stopPropagation()}>
            <button aria-label="更多项目操作" onClick={() => setTopMenuOpen(!topMenuOpen)}>•••</button>
            {topMenuOpen && (
              <div className="top-menu">
                <button onClick={() => { exportProject(); setTopMenuOpen(false); }}>导出项目</button>
                {(legacyMigrationProgress.running || legacyMigrationPlan.items.length > 0) && <button
                  disabled={legacyMigrationProgress.running}
                  title="把旧项目内嵌在浏览器存储中的图片、视频、音频逐项迁入桌面本机素材仓库"
                  onClick={() => void migrateLegacyMedia()}
                >
                  {legacyMigrationProgress.running
                    ? `迁移旧媒体 ${legacyMigrationProgress.completed + legacyMigrationProgress.failed + legacyMigrationProgress.skipped}/${legacyMigrationProgress.total}`
                    : `迁移旧媒体到本机素材仓库（${legacyMigrationPlan.items.length}）`}
                </button>}
                <label className="button">
                  打开项目
                  <input type="file" accept=".json" onChange={(e) => { importProject(e); setTopMenuOpen(false); }} />
                </label>
                <button onClick={() => { setWorkflowLibraryOpen(true); setTopMenuOpen(false); }}>工作流库</button>
                <button onClick={() => { autoConnect(); setTopMenuOpen(false); }}>自动连接</button>
                <button onClick={() => { setSettings(!settings); setPreferences(false); setTopMenuOpen(false); }}>连接设置</button>
                <button onClick={() => { setPreferences(!preferences); setSettings(false); setTopMenuOpen(false); }}>设置</button>
                <button onClick={() => { setCanvasShortcutsOpen(true); setTopMenuOpen(false); }}>查看快捷键</button>
              </div>
            )}
          </div>
        </div>
        <div className="window-controls" aria-label="窗口控制">
          <button title="最小化" aria-label="最小化" onPointerDown={(e) => e.stopPropagation()} onClick={() => void getCurrentWindow().minimize().catch((error) => setMessage(`最小化失败：${String(error)}`))}>−</button>
          <button title="最大化或还原" aria-label="最大化或还原" onPointerDown={(e) => e.stopPropagation()} onClick={() => void getCurrentWindow().toggleMaximize().catch((error) => setMessage(`最大化失败：${String(error)}`))}>□</button>
          <button className="window-close" title="关闭应用" aria-label="关闭应用" onPointerDown={(e) => e.stopPropagation()} onClick={() => void closeApplication()}>×</button>
        </div>
      </header>
      {settings && (
        <section className="settings">
          <b>ComfyUI 本机接口</b>
          <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} />
          <small>
            点击“自动连接”会检查本机 8189 和 8188 端口；不使用 ComfyUI
            时无需连接。
          </small>
        </section>
      )}
      {preferences && (
        <section className="settings app-preferences">
          <b>画布设置</b>
          <label>默认项目保存位置</label>
          <div className="setting-path">
            <input value={defaultSaveDir} onChange={(e) => setDefaultSaveDir(e.target.value)} />
            <button onClick={chooseDefaultSaveDir}>更改</button>
          </div>
          <label>本机素材存储位置</label>
          <div className="setting-path managed-asset-path">
            <input
              aria-label="本机素材存储位置"
              value={workspaceAssetDir || "正在读取本机素材目录…"}
              readOnly
              title={workspaceAssetDir}
            />
            <button onClick={() => void openWorkspaceAssetDir()} disabled={!workspaceAssetDir}>打开</button>
          </div>
          <small className="managed-asset-help">生成及导入的图片、视频和音频按项目保存在这里；该目录由程序管理。</small>
          <div className="autosave-setting">
            <label htmlFor="autosave-minutes">自动保存间隔</label>
            <div className="autosave-minute-input">
              <input
                id="autosave-minutes"
                aria-label="自动保存间隔（分钟）"
                type="number"
                min={MIN_AUTOSAVE_MINUTES}
                max={MAX_AUTOSAVE_MINUTES}
                step={1}
                value={autosaveMinutesDraft}
                onChange={(event) => setAutosaveMinutesDraft(event.target.value)}
                onBlur={commitAutosaveMinutes}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              <span>分钟</span>
            </div>
            <small>1–1440 分钟，修改后立即生效并保存在本机。</small>
          </div>
          <b className="history-title">历史项目</b>
          <button className="log-button" onClick={() => setLogsOpen(!logsOpen)}>运行日志</button>
          {logsOpen && <div className="log-panel">{logs.length ? logs.map((log, index) => <small key={index}>{log}</small>) : <small>暂无日志</small>}</div>}
          <div className="project-history">
            {historyProjects.length === 0 ? <small>暂无历史项目</small> : historyProjects.map((item) => (
              <div className="history-item" key={item.id}>
                <button onClick={() => openHistoryProject(item)}>{item.name}</button>
                <small>{new Date(item.updatedAt).toLocaleString("zh-CN")}</small>
                <button className="history-delete" onClick={() => deleteHistoryProject(item.id)}>删除</button>
              </div>
            ))}
          </div>
        </section>
      )}
      {onlineApiOpen && (
        <div className="online-provider-backdrop" onPointerDown={() => setOnlineApiOpen(false)}>
          <section className={`online-provider-dialog ${serviceConfigSection === "models" ? "api-config-dialog" : "mcp-config-dialog"}`} onPointerDown={(event) => event.stopPropagation()}>
            <header>
              <div><span>工作流连接</span><b>{serviceConfigSection === "models" ? "模型 API 配置" : "MCP 工具配置"}</b><small>{serviceConfigSection === "models" ? "按文本、图片、视频能力独立管理平台与模型。" : "连接 Streamable HTTP MCP 服务并读取可用工具。"}</small></div>
            </header>
            {serviceConfigSection === "models" ? <div className="provider-config-grid">
              <div className="provider-capability-tabs" aria-label="配置用途">
                {(["text", "image", "video"] as ModelCapability[]).map((capability) => <button key={capability} type="button" className={providerCapabilityFilter === capability ? "active" : ""} onClick={() => {
                  const savedProviders = Object.keys(categoryProviderConfigs[capability]);
                  const available = [...new Set([
                    ...savedProviders,
                    ...Object.keys(ONLINE_PROVIDER_DEFAULTS).filter((provider) => capabilitiesForProvider(provider).includes(capability)),
                  ])];
                  // A category switch is a real context switch: load its own
                  // saved provider/model, never leave the preceding tab's
                  // unfinished model in the input.
                  const nextProvider = savedProviders.includes(onlineConfigProvider)
                    ? onlineConfigProvider
                    : savedProviders[0] || available[0] || onlineConfigProvider;
                  providerDraftContextRef.current = `${nextProvider}::${capability}`;
                  setProviderCapabilityFilter(capability);
                  setOnlineConfigProvider(nextProvider);
                  setProviderModelDraft(defaultModelForProvider(nextProvider, capability));
                  setProviderTestResult(null);
                }}>{modelCapabilityLabel(capability)}配置</button>)}
              </div>
              <label className="provider-platform-field">{modelCapabilityLabel(providerCapabilityFilter === "all" ? "text" : providerCapabilityFilter)}平台
                <span className="provider-select-row">{customProviderDraft ? <input autoFocus value={customProviderName} onChange={(event) => setCustomProviderName(event.target.value)} placeholder="输入新平台名称" aria-label="新平台名称" /> : <select value={onlineConfigProvider} onChange={(event) => { const provider = event.target.value; const category = providerCapabilityFilter === "all" ? "text" : providerCapabilityFilter; setOnlineConfigProvider(provider); setProviderModelDraft(defaultModelForProvider(provider, category)); setProviderTestResult(null); }}>
                  {filteredOnlineProviderNames.map((provider) => <option key={provider}>{provider}{categoryConfigs[provider]?.custom ? " · 自定义" : ""}</option>)}
                </select>}<button type="button" title={customProviderDraft ? "取消新增平台" : "添加平台"} onClick={() => customProviderDraft ? (setCustomProviderDraft(null), setCustomProviderName("")) : startCustomProvider()}>{customProviderDraft ? "取消" : "＋平台"}</button>{!customProviderDraft && categoryConfigs[onlineConfigProvider] && <button type="button" className="provider-delete-button" title="删除当前平台配置" aria-label="删除当前平台配置" onClick={removeConfiguredProvider}>×</button>}</span>
              </label>
              <label className="provider-endpoint-field">接口地址
                <input value={selectedOnlineProvider.endpoint} onChange={(event) => updateOnlineProviderConfig({ endpoint: event.target.value })} />
              </label>
              {onlineConfigProvider === "可灵 Kling" && <label>认证方式
                <select value={selectedOnlineProvider.klingAuth || "apiKey"} onChange={(event) => updateOnlineProviderConfig({ klingAuth: event.target.value as "apiKey" | "aksk", ...(event.target.value === "apiKey" ? { apiSecret: "" } : {}) })}>
                  <option value="apiKey">单 API Key（新版开放平台）</option>
                  <option value="aksk">Access Key + Secret Key（旧版签名）</option>
                </select>
              </label>}
              {onlineConfigProvider !== "Ollama（本地）" && <label className="provider-key-field">{onlineConfigProvider === "可灵 Kling" ? (selectedOnlineProvider.klingAuth === "aksk" ? "Access Key" : "API Key") : onlineConfigProvider === "Google Nano Banana" ? "Gemini API Key" : "API 密钥"}
                <input type="password" value={selectedOnlineProvider.apiKey} onChange={(event) => updateOnlineProviderConfig({ apiKey: event.target.value })} placeholder={onlineConfigProvider === "可灵 Kling" ? (selectedOnlineProvider.klingAuth === "aksk" ? "粘贴可灵 Access Key" : "粘贴可灵单 API Key") : onlineConfigProvider === "Google Nano Banana" ? "粘贴 Google AI Studio 的 Gemini API Key" : "粘贴平台 API Key"} />
              </label>}
              {onlineConfigProvider === "可灵 Kling" && selectedOnlineProvider.klingAuth === "aksk" && <label>Secret Key
                <input type="password" value={selectedOnlineProvider.apiSecret || ""} onChange={(event) => updateOnlineProviderConfig({ apiSecret: event.target.value })} placeholder="粘贴可灵 Secret Key（只保存在本机）" />
              </label>}
              <label className="provider-model-field">{modelCapabilityLabel(providerCapabilityFilter === "all" ? "text" : providerCapabilityFilter)}模型
                <input
                  list="online-provider-model-options"
                  value={providerModelDraft}
                  onChange={(event) => setProviderModelDraft(event.target.value)}
                  placeholder={providerCapabilityFilter === "video" ? "例如 wan2.6-t2v" : providerCapabilityFilter === "image" ? "例如 qwen-image-2.0" : "例如 deepseek-chat"}
                  spellCheck={false}
                />
                {selectedOnlineProviderModels.length > 0 && <datalist id="online-provider-model-options">
                  {selectedOnlineProviderModels.filter((model) => capabilitiesForModel(model).includes(providerCapabilityFilter === "all" ? "text" : providerCapabilityFilter)).map((model) => <option value={model.id} key={model.id}>{model.purpose}</option>)}
                </datalist>}
                <small className="provider-model-choice-note">填一个当前节点要使用的模型即可；保存后只显示在对应节点。</small>
              </label>
              <div className="provider-model-discovery">
                <button className="provider-discover-button" title="检索可用模型" aria-label="检索可用模型" disabled={discoveringModels || !selectedOnlineProvider.endpoint?.trim() || (onlineConfigProvider !== "Ollama（本地）" && !selectedOnlineProvider.apiKey?.trim())} onClick={() => void discoverProviderModels()}>{discoveringModels ? "…" : "⌕"}</button>
                <button className="provider-test-button" title="测试连接" aria-label="测试连接" disabled={testingProvider || !selectedOnlineProvider.endpoint?.trim() || (onlineConfigProvider !== "Ollama（本地）" && !selectedOnlineProvider.apiKey?.trim())} onClick={() => void testOnlineProvider()}>{testingProvider ? "…" : "◉"}</button>
                <small>{onlineConfigProvider === "Ollama（本地）" ? "测试会读取本机 Ollama 已安装模型；不需要 API Key，也不会创建生成任务。" : onlineConfigProvider === "Google Nano Banana" ? "测试会读取 Gemini 模型权限；不创建图片，不扣生成额度。" : onlineConfigProvider === "可灵 Kling" ? (selectedOnlineProvider.klingAuth === "aksk" ? "测试会用 Access Key + Secret Key 生成签名并读取任务列表；不创建视频任务。" : "测试会使用单 API Key 读取任务列表；不创建视频任务。") : onlineConfigProvider === "豆包·火山方舟" ? "测试会读取模型/推理接入点权限；不创建视频任务。" : "测试会访问模型接口，不会创建生成任务；密钥只在本机请求时使用。"}</small>
              </div>
              <div className={`provider-status ${providerTestResult ? (providerTestResult.ok ? "success" : "error") : "idle"}`} title={providerTestResult?.text || "尚未测试"}><i />{providerTestResult?.text || "尚未测试"}</div>
              <footer>
                <button className="primary" onClick={() => {
                  const normalizedDraft = normalizeExplicitProviderModelId(providerModelDraft);
                  const category = providerCapabilityFilter === "all" ? "text" : providerCapabilityFilter;
                  const providerName = customProviderDraft ? customProviderName.trim() : onlineConfigProvider;
                  if (!providerName) { setMessage("请先填写新平台名称，再保存配置。"); return; }
                  const targetProvider = providerForExplicitModelId(normalizedDraft);
                  if (targetProvider && targetProvider !== providerName && !selectedOnlineProvider.custom) {
                    setOnlineConfigProvider(targetProvider);
                    setProviderModelDraft(normalizedDraft);
                    setMessage(`“${normalizedDraft}”属于“${targetProvider}”，不能保存到“${providerName}”。已切换到正确平台，请填写该平台的接口和密钥后保存。`);
                    return;
                  }
                  const rawDraftModel = normalizedDraft
                    ? selectedOnlineProviderModels.find((model) => model.id === normalizedDraft) || classifyProviderModel(normalizedDraft)
                    : null;
                  const draftCapabilities = rawDraftModel ? capabilitiesForModel(rawDraftModel) : [];
                  if (normalizedDraft && draftCapabilities.length > 0 && !draftCapabilities.includes(category)) {
                    setMessage(`“${normalizedDraft}”不是${modelCapabilityLabel(category)}模型，无法保存到当前配置。`);
                    return;
                  }
                  const draftModel = rawDraftModel && normalizedDraft
                    ? (draftCapabilities.length ? rawDraftModel : { ...rawDraftModel, kind: category, capabilities: [category], purpose: `${modelCapabilityLabel(category)}生成模型` })
                    : null;
                  const detectedModels = draftModel
                    ? [...(selectedOnlineProvider.detectedModels || []).filter((model) => model.id !== normalizedDraft), draftModel]
                    : selectedOnlineProvider.detectedModels || [];
                  const normalizedModel = normalizeExplicitProviderModelId(selectedOnlineProvider.model || normalizedDraft);
                  const providerConfig = {
                    ...selectedOnlineProvider,
                    custom: selectedOnlineProvider.custom || Boolean(customProviderDraft),
                    model: normalizedModel,
                    defaultModels: normalizedDraft ? { ...(selectedOnlineProvider.defaultModels || {}), [category]: normalizedDraft } : selectedOnlineProvider.defaultModels,
                    detectedModels,
                    capabilities: [...new Set(detectedModels.flatMap(capabilitiesForModel))],
                  } as OnlineProviderConfig;
                  const next = { ...categoryProviderConfigs, [category]: { ...categoryProviderConfigs[category], [providerName]: { ...providerConfig, capabilities: [category] } } };
                  setCategoryProviderConfigs(next);
                  localStorage.setItem(CATEGORY_PROVIDER_STORE, JSON.stringify(next));
                  setMessage(normalizedModel !== selectedOnlineProvider.model
                    ? `${providerName} 已保存；模型名称已按可灵 API 纠正为 ${normalizedModel}`
                    : `${providerName} 已保存：${modelCapabilityLabel(category)}节点会使用上方模型，其他节点配置互不干扰。`);
                  // A later reopen must reflect the just-saved model, rather
                  // than an old unsaved draft that happened to be left in the
                  // dialog before clicking Save.
                  providerDraftContextRef.current = null;
                  if (customProviderDraft) {
                    setOnlineConfigProvider(providerName);
                    setCustomProviderDraft(null);
                    setCustomProviderName("");
                  }
                  setOnlineApiOpen(false);
                }}>保存本机配置</button>
              </footer>
            </div> : <>
              <div className="mcp-config-layout">
                <aside><button className="mcp-add" onClick={addMcpServer}>＋ 添加 MCP 服务</button>{mcpServers.map((server) => <button className={activeMcpConfig?.id === server.id ? "active" : ""} key={server.id} onClick={() => setActiveMcpServer(server.id)}><b>{server.name}</b><small>{server.lastStatus || "尚未测试"}</small></button>)}</aside>
                <main>{activeMcpConfig ? <>
                  <label>服务名称<input value={activeMcpConfig.name} onChange={(event) => updateMcpServer(activeMcpConfig.id, { name: event.target.value })} /></label>
                  <label>Streamable HTTP 地址<input value={activeMcpConfig.endpoint} onChange={(event) => updateMcpServer(activeMcpConfig.id, { endpoint: event.target.value })} placeholder="https://example.com/mcp" /></label>
                  <label>Bearer Token（可选）<input type="password" value={activeMcpConfig.token} onChange={(event) => updateMcpServer(activeMcpConfig.id, { token: event.target.value })} /></label>
                  <label className="mcp-enabled"><input type="checkbox" checked={activeMcpConfig.enabled} onChange={(event) => updateMcpServer(activeMcpConfig.id, { enabled: event.target.checked })} />允许工作流使用此服务</label>
                  <div className="mcp-tools"><header><b>已发现工具</b><span>{activeMcpConfig.tools.length}</span></header>{activeMcpConfig.tools.length ? activeMcpConfig.tools.map((tool) => <div key={tool.name}><b>{tool.name}</b><small>{tool.description || "无说明"}</small></div>) : <p>测试连接后会从 tools/list 读取工具，不会伪造工具名称。</p>}</div>
                  <footer><button className="danger" onClick={() => { setMcpServers((current) => current.filter((server) => server.id !== activeMcpConfig.id)); setActiveMcpServer(null); }}>删除</button><button className="primary" disabled={testingMcp} onClick={() => void testMcpServer(activeMcpConfig)}>{testingMcp ? "正在读取工具…" : "测试连接并读取工具"}</button></footer>
                </> : <div className="mcp-empty"><b>还没有 MCP 服务</b><small>添加后可测试连接并读取服务实际公开的工具。</small><button onClick={addMcpServer}>添加第一个 MCP 服务</button></div>}</main>
              </div>
            </>}
          </section>
        </div>
      )}
      <CloudPointsCenter open={cloudPointsOpen} onClose={() => setCloudPointsOpen(false)} />
      {canvasShortcutsOpen && (
        <div className="canvas-shortcuts-backdrop" onPointerDown={() => setCanvasShortcutsOpen(false)}>
          <section className="canvas-shortcuts-dialog" onPointerDown={(event) => event.stopPropagation()}>
            <div>
              <span>亿幕画布</span>
              <b>画布快捷键</b>
              <small>在非文本输入状态下可用</small>
            </div>
            <dl>
              <div><dt>滚轮</dt><dd>以鼠标位置为中心缩放画布</dd></div>
              <div><dt>左键空白处拖动</dt><dd>移动画布视角</dd></div>
              <div><dt>按住中键拖动</dt><dd>框选节点与连接线</dd></div>
              <div><dt>Ctrl + 拖动</dt><dd>矩形框选节点</dd></div>
              <div><dt>Ctrl + Alt + 拖动</dt><dd>框选连接线；选中后可批量断开</dd></div>
              <div><dt>Ctrl + A</dt><dd>选中全部节点</dd></div>
              <div><dt>Ctrl + Z</dt><dd>撤销上一步操作（最多 6 步）</dd></div>
              <div><dt>Ctrl + S</dt><dd>导出并保存当前项目</dd></div>
              <div><dt>右键空白处</dt><dd>添加文本、素材或 API 工作流</dd></div>
            </dl>
            <footer><button onClick={() => setCanvasShortcutsOpen(false)}>关闭</button></footer>
          </section>
        </div>
      )}
      <button
        className={`studio-toggle ${studioOpen ? "open" : ""}`}
        onClick={() => setStudioOpen(!studioOpen)}
      >
        {studioOpen ? "‹ 收起工作台" : "创作工作台 ›"}
      </button>
      <aside className={`studio-sidebar ${studioOpen ? "open" : ""}`} onWheel={(event) => event.stopPropagation()}>
        <div className="sidebar-title">
          <span className="brand-mark">✦</span>
          <div>
            <b>创作工作台</b>
            <small>本地项目 · 每 {autosaveMinutes} 分钟自动保存</small>
          </div>
          <button className="director-mode-button" onClick={openDirectorMode} title="打开粗剪预览，编排并检查镜头、视频、音频和字幕">
            <span>
              <strong>粗剪预览</strong>
              <small>编排并预览镜头、音轨与字幕</small>
            </span>
            <em>预览编辑</em>
          </button>
        </div>
        <section className="project-overview">
          <span>当前创作链路</span>
          <strong>从灵感到成片</strong>
          <div className="overview-counts">
            <i>
              {studioStats.script}
              <small>脚本</small>
            </i>
            <i>
              {studioStats.media}
              <small>素材</small>
            </i>
            <i>
              {studioStats.workflow}
              <small>工作流</small>
            </i>
          </div>
        </section>
        <section className="flow-library">
          <p>01　创意与脚本</p>
          <button
            className="side-action text"
            onClick={() => addAtViewport("text")}
          >
            <b>＋</b>
            <span>
              添加文本节点<small>写提示词、文案与备注</small>
            </span>
          </button>
          <button
            className="side-action text"
            onClick={() => addAtViewport("storyboard")}
          >
            <b>▤</b>
            <span>
              添加脚本/分镜<small>整理镜头、画面与台词</small>
            </span>
          </button>
          <p>02　素材与参考</p>
          <button
            className="side-action image"
            onClick={() => addAtViewport("image")}
          >
            <b>▧</b>
            <span>
              图片参考<small>角色、场景、首帧</small>
            </span>
          </button>
          <button
            className="side-action video"
            onClick={() => addAtViewport("video")}
          >
            <b>▶</b>
            <span>
              视频素材<small>片段、动作与镜头</small>
            </span>
          </button>
          <button
            className="side-action audio"
            onClick={() => addAtViewport("audio")}
          >
            <b>♪</b>
            <span>
              音频素材<small>配音、音乐与音效</small>
            </span>
          </button>
          <button
            className="side-action workflow"
            onClick={() => setWorkflowLibraryOpen(true)}
          >
            <b>↗</b>
            <span>
              Comfy 工作流库<small>保存、转换与复用工作流</small>
            </span>
          </button>
          <div className="online-api-picker">
            <button
              className="side-action online-api"
              onClick={() => {
                const activeVideoProvider = ((activeOnlineVideoNode?.workflow || {}) as OnlineVideoSettings).provider;
                setServiceConfigSection("models");
                openOnlineConfiguration("byok", activeVideoProvider && activeVideoProvider !== "未选择平台" ? activeVideoProvider : undefined, "video");
              }}
            >
              <b>◌</b>
              <span>
                模型 API 配置<small>按文本、图片、视频管理平台</small>
              </span>
            </button>
            <button className="side-action online-api" onClick={() => { setServiceConfigSection("mcp"); openOnlineConfiguration("byok"); }}>
              <b>⌘</b><span>MCP 工具配置<small>连接服务并读取可用工具</small></span>
            </button>
          </div>
        </section>
          <section className="flow-guide">
          <span>使用方式</span>
          <ol>
            <li>先放入脚本或素材</li>
            <li>连到 Comfy 工作流</li>
            <li>运行后继续复用结果</li>
          </ol>
          </section>
          <div className="studio-credit">亿幕画布——创造新奇迹 · 湫 × 小C 创作</div>
          <section className="navigator-section">
          <button onClick={() => setNavOpen(!navOpen)}>
            <span>画布导航</span>
            <small>{navOpen ? "收起" : "展开"}</small>
          </button>
          {navOpen && (
            <>
              <div className="sidebar-minimap" onClick={navigateFromMinimap}>
                {project.nodes.map((node) => (
                  <i
                    key={node.id}
                    className={node.kind}
                    style={{
                      left: `${Math.max(2, Math.min(94, node.x / 60))}%`,
                      top: `${Math.max(2, Math.min(90, node.y / 36))}%`,
                      width: `${Math.max(3, Math.min(18, node.width / 42))}%`,
                      height: `${Math.max(3, Math.min(12, node.height / 32))}%`,
                    }}
                  />
                ))}
              </div>
              <small className="navigator-tip">点击任意位置定位画布</small>
            </>
          )}
        </section>
      </aside>
      <aside className="toolbar">
        <button
          title="添加图片节点"
          onClick={() => add("image", { x: 350, y: 260 })}
        >
          ▧<span>图片</span>
        </button>
        <button
          title="添加视频节点"
          onClick={() => add("video", { x: 350, y: 260 })}
        >
          ▶<span>视频</span>
        </button>
        <button
          title="添加音频节点"
          onClick={() => add("audio", { x: 350, y: 260 })}
        >
          ♪<span>音频</span>
        </button>
        <button
          title="添加文本"
          onClick={() => add("text", { x: 350, y: 260 })}
        >
          T<span>文本</span>
        </button>
        <button
          title="导入 ComfyUI API 工作流"
          onClick={() => {
            setApiPoint(null);
            apiRef.current?.click();
          }}
        >
          ⇢<span>导入 API</span>
        </button>
        <i />
        <button title="重置视图" onClick={resetView}>
          ◎<span>居中</span>
        </button>
      </aside>
      <input
        ref={fileRef}
        className="hidden"
        type="file"
        accept="image/*,video/*,audio/*"
        onChange={importMedia}
      />
      <input
        ref={onlineReferenceRef}
        className="hidden"
        type="file"
        accept="image/*,video/*"
        onChange={importOnlineReference}
      />
      <input
        ref={textMediaRef}
        className="hidden"
        type="file"
        accept="image/*,video/*"
        onChange={importExternalTextMedia}
      />
      <input
        ref={apiRef}
        className="hidden"
        type="file"
        accept=".json,application/json"
        onChange={importApi}
      />
      <section
        ref={canvasRef}
        className="canvas"
        style={{ cursor: selectionBox ? "crosshair" : panning ? "grabbing" : "grab" }}
        onWheel={wheel}
        onPointerDownCapture={(event) => { if (event.button === 1) canvasDown(event); }}
        onPointerDown={(event) => { if (event.button !== 1) canvasDown(event); }}
        onPointerMove={canvasMove}
        onPointerUp={canvasUp}
        onAuxClick={(event) => { if (event.button === 1) event.preventDefault(); }}
        onContextMenu={canvasMenu}
        onDragEnter={(event) => { event.preventDefault(); setExternalDropActive(true); }}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setExternalDropActive(true); }}
        onDragLeave={(event) => {
          const next = event.relatedTarget;
          if (!(next instanceof Node) || !event.currentTarget.contains(next)) setExternalDropActive(false);
        }}
        onDrop={canvasDrop}
      >
        {externalDropActive && <div className="canvas-drop-hint" aria-live="polite">
          <b>松开即可加入画布</b>
          <span>支持图片、视频、音频和 API 工作流 JSON</span>
        </div>}
        {selectedLinks.length > 0 && (
          <button
            className="disconnect-selected-links"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              const count = selectedLinks.length;
              change((p) => ({ ...p, links: p.links.filter((link) => !selectedLinks.includes(link.id)) }));
              setSelectedLinks([]);
              setMessage(`已断开 ${count} 条连接线`);
            }}
          >断开已选连线（{selectedLinks.length}）</button>
        )}
        <div
          ref={gridRef}
          className="grid"
          style={{
            transform: `translate(${project.view.x}px, ${project.view.y}px) scale(${project.view.zoom})`,
          }}
        >
          <svg className="wires">
            {svgLinks}
            {draftPath && (
              <path
                className="draft"
                d={(draftLink!.side === "in" ? curveFromLeft : curve)(
                  draftLink!.side === "in" ? draftPath.x : draftPath.x + draftPath.width,
                  draftPath.y + draftPath.height / 2,
                  draftLink!.x,
                  draftLink!.y,
                )}
              />
            )}
          </svg>
          {selectionBox && (
            <div
              style={{
                position: "absolute",
                left: selectionBox.x,
                top: selectionBox.y,
                width: selectionBox.width,
                height: selectionBox.height,
                border: "1px solid #9ee6da",
                background: "#8fe5d51c",
                pointerEvents: "none",
                zIndex: 10,
              }}
            />
          )}
          {lineSelectionBox && (
            <div
              style={{ position: "absolute", left: lineSelectionBox.x, top: lineSelectionBox.y, width: lineSelectionBox.width, height: lineSelectionBox.height, border: "1px dashed #ffbf7b", background: "#ffbd5319", pointerEvents: "none", zIndex: 11 }}
            />
          )}
              {(project.groups || []).filter((group) =>
                group.bounds.x < viewportBounds.maxX && group.bounds.x + group.bounds.w > viewportBounds.minX
                && group.bounds.y < viewportBounds.maxY && group.bounds.y + group.bounds.h > viewportBounds.minY,
              ).map((g) => {
                const gn = g.nodeIds.map((id) => canvasNodeIndex.get(id)).filter((n): n is NodeItem => !!n);
                if (gn.length < 2) return null;
                const minX = g.bounds.x;
                const minY = g.bounds.y;
                const maxX = g.bounds.x + g.bounds.w;
                const maxY = g.bounds.y + g.bounds.h;
                const gnds = Object.fromEntries(gn.map((x) => [x.id, { x: x.x, y: x.y }]));
                return <div key={g.id} data-group-id={g.id} className="node-group" style={{ position: "absolute", left: minX, top: minY, width: maxX - minX, height: maxY - minY }} onPointerDown={(e) => { if (e.button !== 0) return; moving.current = { startX: e.clientX, startY: e.clientY, nodes: gnds, isGroupDrag: g.id, startBounds: { x: g.bounds.x, y: g.bounds.y, w: g.bounds.w, h: g.bounds.h }, startProject: project }; }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, node: "__group_" + g.id }); }}><span className="node-group-name" title="双击重新命名" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => { e.stopPropagation(); setGroupNameInput(g.id); }}>{g.name}</span></div>;
              })}
          {visibleCanvasNodes.map((n) => (
            <article
              key={n.id}
              data-node-id={n.id}
              className={`node ${n.kind} status-${n.status || "idle"} ${n.validationErrors?.length ? "validation-error" : ""} ${selected.includes(n.id) ? "selected" : ""} ${dropTextTarget === n.id ? "drop-target" : ""} ${n.locked ? "locked" : ""} ${n.mirrored ? "mirrored" : ""}`}
              style={{ left: n.x, top: n.y, width: n.width, height: n.height, transform: n.kind === "annotation" || n.kind === "annotationPointer" ? `rotate(${n.rotation || 0}deg)` : undefined }}
              onPointerDown={(e) => nodeDown(e, n)}
              onContextMenu={(e) => nodeMenu(e, n.id)}
              onDragOver={
                n.kind === "text"
                  ? (event) => textDragOver(event, n.id)
                  : undefined
              }
              onDragLeave={
                n.kind === "text" ? () => setDropTextTarget(null) : undefined
              }
              onDrop={
                n.kind === "text" ? (event) => textDrop(event, n) : undefined
              }
            >
              {n.kind !== "api" && n.kind !== "annotation" && n.kind !== "annotationPointer" && (
                <div className="node-head">
                  <span>{typeLabel[n.kind]}</span>
                  <em>{n.kind === "text" ? "文本/提示词" : n.name}</em>
                  {n.mediaWidth && n.mediaHeight && (
                    <small>
                      {n.mediaWidth} × {n.mediaHeight}
                    </small>
                  )}
                </div>
              )}
              {n.status === "running" && (n.kind === "image" || n.kind === "text" || n.kind === "video") && (
                <div className="node-generation-progress" aria-label="AI 生成中">
                  <i>生成</i><span>处理中</span>
                </div>
              )}
              {n.kind !== "annotation" && n.kind !== "annotationPointer" && <>
              <span
                className="port in"
                style={{ ...portStyle, left: -(portWorldSize / 2 + 1) }}
                title="输入连接点：点击可管理并断开线路"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  const p = world(e.clientX, e.clientY);
                  linking.current = { from: n.id, x: p.x, y: p.y, side: "in" };
                  setDraftLink({ from: n.id, x: p.x, y: p.y, side: "in" });
                }}
                onPointerUp={(e) => {
                  e.stopPropagation();
                  const from = linking.current?.from;
                  if (from && from !== n.id) {
                    const side = linking.current?.side || "out";
                    const source = side === "out" ? from : n.id;
                    const target = side === "out" ? n.id : from;
                    connectCanvasNodes(source, target);
                    linking.current = null;
                    setDraftLink(null);
                  } else {
                    linking.current = null;
                    setDraftLink(null);
                    const incoming = project.links.filter(
                      (link) => link.to === n.id,
                    );
                    if (incoming.length) {
                      setSelected([n.id, ...incoming.map((link) => link.from)]);
                      setDisconnectMenu({
                        x: e.clientX,
                        y: e.clientY,
                        target: n.id,
                      });
                    }
                  }
                }}
              />
              <span
                className="port out"
                style={{ ...portStyle, right: -(portWorldSize / 2 + 1) }}
                title="输出连接点（可连接多个节点）"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  const p = world(e.clientX, e.clientY);
                  linking.current = { from: n.id, x: p.x, y: p.y, side: "out" };
                  setDraftLink({ from: n.id, x: p.x, y: p.y, side: "out" });
                }}
                onPointerUp={(e) => {
                  e.stopPropagation();
                  const active = linking.current;
                  if (!active || active.from === n.id) return;
                  const from = active.side === "in" ? n.id : active.from;
                  const to = active.side === "in" ? active.from : n.id;
                  connectCanvasNodes(from, to);
                  linking.current = null;
                  setDraftLink(null);
                }}
              />
              </>}
              {n.kind !== "api" && n.kind !== "annotation" && n.kind !== "annotationPointer" && n.validationErrors?.length ? (
                <button
                  type="button"
                  className="node-validation-badge"
                  title={n.validationErrors.join("\n")}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => setMessage(n.validationErrors?.join("；") || "运行前检查发现问题")}
                >
                  ⚠ {n.validationErrors.length} 项待修复
                </button>
              ) : null}
              {n.kind === "image" &&
                (n.src ? (
                  <img
                    draggable={false}
                    loading="lazy"
                    decoding="async"
                    src={n.src}
                    alt={n.name}
                    style={{ objectFit: "cover" }}
                    onLoad={(event) =>
                      recordMediaSize(
                        n.id,
                        event.currentTarget.naturalWidth,
                        event.currentTarget.naturalHeight,
                      )
                    }
                    onError={() => {
                      if (!n.src?.includes("asset.localhost")) return;
                      change((p) => ({
                        ...p,
                        nodes: p.nodes.map((x) =>
                          x.id === n.id
                            ? {
                                ...x,
                                src: `http://127.0.0.1:8188/view?filename=${encodeURIComponent(n.name)}&subfolder=&type=output`,
                              }
                            : x,
                        ),
                      }));
                    }}
                  />
                ) : (
                  <div className="empty node-inline-actions">
                    <button
                      className="node-add-primary"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => openFile("image", n.id)}
                    >
                      ＋ 添加图片
                    </button>
                    <button className="node-add-ai" onPointerDown={(e) => e.stopPropagation()} onClick={() => {
                      const connection = imageProviderOptions[0];
                      change((p) => ({ ...p, nodes: p.nodes.map((node) => node.id === n.id ? { ...node, workflow: node.workflow || { source: "byok", provider: connection?.name || "OpenAI", model: connection?.defaultModel || "gpt-image-1", mode: "text", ratio: "1:1", resolution: "1024", amount: 1, quality: "low", style: "电影写实", seed: -1, guidance: 7 } satisfies AiImageSettings } : node) }));
                      setActiveText(null); setActiveStoryboard(null); setActiveOnlineVideo(null); setActiveAiNode(n.id);
                    }}>✦ AI 图片生成</button>
                  </div>
                ))}
              {n.kind === "video" &&
                (n.src ? (
                  <VideoCanvas
                    src={managedPreviewSrc(n.localPath) || n.src}
                    fallbackSrc={managedPreviewSrc(n.localPath)
                      ? (n.fallbackSrc || n.src)
                      : (n.fallbackSrc || (/^(?:LTX2|LTX)/i.test(n.fileName || n.name)
                        ? `${apiUrl.replace(/\/$/, "")}/view?filename=${encodeURIComponent(n.fileName || n.name)}&subfolder=LTX2&type=output`
                        : undefined))}
                    onMetadata={(width, height) =>
                      recordMediaSize(
                        n.id,
                        width,
                        height,
                      )
                    }
                    onPlaybackError={() => {
                      const recoverySource = n.fallbackSrc
                        || (parseComfyViewSource(n.src) ? n.src : undefined)
                        || (/^(?:LTX2|LTX)/i.test(n.fileName || n.name)
                          ? `${apiUrl.replace(/\/$/, "")}/view?filename=${encodeURIComponent(n.fileName || n.name)}&subfolder=LTX2&type=output`
                          : undefined);
                      void recoverComfyVideoPreview(n, recoverySource);
                    }}
                  />
                ) : (
                  <div className="empty node-inline-actions">
                    <button
                      className="node-add-primary"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => openFile("video", n.id)}
                    >
                      ＋ 添加视频
                    </button>
                    <button className="node-add-ai" onPointerDown={(e) => e.stopPropagation()} onClick={() => {
                      const provider = onlineVideoProviderNames[0] || "未选择平台";
                      const model = modelsForProvider(provider, "video")[0] || resolvedProviderConfig(provider, "video")?.model || "";
                      const capabilities = videoCapabilitiesFor(provider, model);
                      change((p) => ({ ...p, nodes: p.nodes.map((node) => node.id === n.id ? { ...node, workflow: node.workflow || { source: "byok", provider, model, mode: capabilities.modes[0], ratio: "16:9", quality: "720P", duration: 5, amount: 1, audio: true } satisfies OnlineVideoSettings } : node) }));
                      setActiveText(null); setActiveStoryboard(null); setActiveAiNode(null); setActiveOnlineVideo(n.id);
                    }}>✦ AI 视频生成</button>
                  </div>
                ))}
              {n.kind === "audio" &&
                (n.src ? (
                  <AudioWave src={n.src} />
                ) : (
                  <div className="empty">
                    <button
                      style={{
                        border: "1px solid #536466",
                        background: "#293235",
                        color: "#dce8e7",
                        padding: "9px 14px",
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => openFile("audio", n.id)}
                    >
                      ＋ 添加音频
                    </button>
                  </div>
                ))}
              {n.kind === "annotation" && <div className="annotation-node">
                {editingAnnotation === n.id ? (
                  <textarea
                    autoFocus
                    value={n.text ?? "情绪转折点。\n冷静的表象下是汹涌的告别。"}
                    style={{ fontSize: n.fontSize ?? 19 }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onChange={(event) => change((p) => ({ ...p, nodes: p.nodes.map((x) => {
                      if (x.id !== n.id) return x;
                      const text = event.target.value;
                      const { width, height } = annotationMetrics(text, x.width, x.fontSize ?? 19);
                      return { ...x, text, width, height };
                    }) }))}
                    onBlur={() => setEditingAnnotation(null)}
                    onKeyDown={(event) => { if (event.key === "Escape") setEditingAnnotation(null); }}
                    aria-label="镜头批注内容"
                  />
                ) : (
                  <div className="annotation-text" style={{ fontSize: n.fontSize ?? 19 }} title="双击修改批注" onClick={(event) => { if (event.detail === 2) { event.stopPropagation(); setEditingAnnotation(n.id); } }} onDoubleClick={(event) => { event.stopPropagation(); setEditingAnnotation(n.id); }}>
                    {n.text ?? "情绪转折点。\n冷静的表象下是汹涌的告别。"}
                  </div>
                )}
                <div className="annotation-tools" onPointerDown={(event) => event.stopPropagation()}>
                  <button title="修改批注文字" onClick={() => setEditingAnnotation(n.id)}>编辑</button>
                  <button className={n.locked ? "active" : ""} title={n.locked ? "解除固定" : "固定位置"} onClick={() => change((p) => ({ ...p, nodes: p.nodes.map((x) => x.id === n.id ? { ...x, locked: !x.locked } : x) }))}>{n.locked ? "解锁" : "固定"}</button>
                </div>
              </div>}
              {n.kind === "annotationPointer" && <div className="annotation-pointer-node">
                <svg viewBox="0 0 54 58" aria-hidden="true">
                  <g transform={n.mirrored ? "translate(54 0) scale(-1 1)" : undefined}>
                    <path d="M16 6 C 13 20, 10 37, 20 47 C 28 54, 38 50, 42 42" />
                    <path d="M34 42 L42 42 L40 50" />
                  </g>
                </svg>
                <div className="annotation-tools" onPointerDown={(event) => event.stopPropagation()}>
                  <button className={n.mirrored ? "active" : ""} title="镜像指向箭头" onClick={() => change((p) => ({ ...p, nodes: p.nodes.map((x) => x.id === n.id ? { ...x, mirrored: !x.mirrored } : x) }))}>镜像</button>
                  <button className={n.locked ? "active" : ""} title={n.locked ? "解除固定" : "固定位置"} onClick={() => change((p) => ({ ...p, nodes: p.nodes.map((x) => x.id === n.id ? { ...x, locked: !x.locked } : x) }))}>{n.locked ? "解锁" : "固定"}</button>
                </div>
              </div>}
              {(n.kind === "aiText" || n.kind === "aiImage") && (
                <AiGenerationNodeView
                  node={n as NodeItem & { kind: "aiText" | "aiImage" }}
                  onOpen={() => {
                    setActiveText(null);
                    setActiveStoryboard(null);
                    setActiveOnlineVideo(null);
                    setActiveAiNode(n.id);
                  }}
                />
              )}
              {n.kind === "onlineVideo" && (() => {
                const config: OnlineVideoSettings = {
                  source: "byok",
                  provider: "未选择平台",
                  mode: "text",
                  ratio: "16:9",
                  quality: "720P",
                  duration: 5,
                  amount: 1,
                  audio: true,
                  ...((n.workflow || {}) as OnlineVideoSettings),
                };
                const nodeProviderConfig = resolvedProviderConfig(config.provider || "", "video");
                const nodeModel = compatibleModelForProvider(
                  config.provider || "",
                  "video",
                  config.modelPinned ? config.model : nodeProviderConfig?.model,
                  config.model,
                );
                const nodeCapabilities = videoCapabilitiesFor(config.provider || "", nodeModel);
                const normalizedNodeOptions = normalizeVideoGenerationOptions(nodeCapabilities, {
                  mode: config.mode,
                  amount: config.amount,
                });
                const nodeSupportsAudio = supportsVideoAudio(nodeCapabilities, normalizedNodeOptions.mode);
                const update = (patch: Partial<OnlineVideoSettings>) => change((p) => ({
                  ...p,
                  nodes: p.nodes.map((x) => x.id === n.id ? { ...x, workflow: { ...config, ...patch } } : x),
                }));
                const modeLabels: Record<NonNullable<OnlineVideoSettings["mode"]>, string> = {
                  text: "文生视频", image: "图生视频", firstLast: "首尾帧视频", reference: "参考图视频",
                };
                return <>
                  <button
                    className="online-video-trigger ai-generation-node video"
                    onClick={() => {
                      setActiveText(null);
                      setActiveStoryboard(null);
                      setActiveAiNode(null);
                      setActiveOnlineVideo(n.id);
                    }}
                    title="AI 视频生成 · 点击配置"
                  >
                      <div className="ai-generation-node-empty">
                        <span>✦</span>
                        <b>AI 视频生成</b>
                        <small>{onlineVideoProviderNames.length
                          ? `${config.provider === "未选择平台" ? "选择已保存的平台" : `${config.provider} · ${nodeModel || "没有匹配的视频模型"}`} · ${nodeModel ? nodeCapabilities.modes.map(videoModeLabel).join("、") : "请到配置台指定视频能力"}`
                          : "先保存视频 API 配置，再直接选择模型生成"}</small>
                      </div>
                  </button>
                  <div className="online-video-body" onPointerDown={(event) => event.stopPropagation()}>
                  <div className="online-video-topline">
                    <span className="online-video-signal" />
                    <select value={config.provider} onChange={(event) => {
                      const provider = event.target.value;
                      const providerConfig = resolvedProviderConfig(provider, "video");
                      const model = compatibleModelForProvider(provider, "video", providerConfig?.model);
                      const nextCapabilities = videoCapabilitiesFor(provider, model);
                      const nextOptions = normalizeVideoGenerationOptions(nextCapabilities, { mode: config.mode, amount: config.amount });
                      update({ provider, model, modelPinned: false, mode: nextOptions.mode, amount: nextOptions.amount });
                    }}>
                      <option>未选择平台</option>
                      {onlineVideoProviderNames.map((provider) => <option key={provider}>{provider}</option>)}
                    </select>
                    <select value={normalizedNodeOptions.mode} onChange={(event) => update({ mode: event.target.value as OnlineVideoSettings["mode"] })}>
                      {nodeCapabilities.modes.map((mode) => <option value={mode} key={mode}>{modeLabels[mode]}</option>)}
                    </select>
                  </div>
                  <BufferedProjectTextarea
                    nodeId={n.id}
                    value={config.prompt || ""}
                    autoFocus={false}
                    onCommit={(prompt) => update({ prompt })}
                    placeholder="描述你想要生成的视频画面；可连接文本、图片或首尾帧作为参考…"
                  />
                  <div className="online-video-tools">
                    <button title="提示词优化" onClick={() => setMessage("提示词优化会在接入模型后启用")}>✧ 优化</button>
                    <button title="翻译提示词" onClick={() => setMessage("提示词翻译会在接入模型后启用")}>文A 翻译</button>
                    <label>比例<select value={config.ratio} onChange={(event) => update({ ratio: event.target.value })}>{["Auto", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].map((item) => <option key={item}>{item}</option>)}</select></label>
                    <label>清晰度<select value={config.quality} onChange={(event) => update({ quality: event.target.value })}>{videoQualitiesFor(nodeCapabilities, config.ratio || "16:9", normalizedNodeOptions.mode).map((item) => <option key={item}>{item}</option>)}</select></label>
                    <label>时长<select value={config.duration} onChange={(event) => update({ duration: Number(event.target.value) })}>{[5, 6, 8, 10].map((item) => <option value={item} key={item}>{item} 秒</option>)}</select></label>
                    <label>数量<select value={normalizedNodeOptions.amount} onChange={(event) => update({ amount: Number(event.target.value) })}>{nodeCapabilities.amounts.map((item) => <option value={item} key={item}>{item} 个</option>)}</select></label>
                    <button disabled={!nodeSupportsAudio} title={nodeSupportsAudio ? "生成音频" : "当前模型没有原生音频合同"} className={config.audio && nodeSupportsAudio ? "active" : ""} onClick={() => update({ audio: !config.audio })}>{nodeSupportsAudio ? "🔊 音频" : "🔇 无原生音频"}</button>
                  </div>
                  <div className="online-video-footer">
                    <small>{modeLabels[normalizedNodeOptions.mode]} · {config.ratio} · {config.quality} · {config.duration}s · {normalizedNodeOptions.amount}个</small>
                    <button onClick={() => setMessage(config.provider === "未选择平台" ? "请先选择在线平台并配置 API 密钥" : `“${config.provider}”节点已准备好，平台接入后即可运行`)}>生成视频 ↑</button>
                  </div>
                  </div>
                </>;
              })()}
              {n.kind === "batch" && (() => {
                const collected = project.links
                  .filter((link) => link.to === n.id)
                  .map((link) => project.nodes.find((node) => node.id === link.from))
                  .filter((node): node is NodeItem => !!node && (node.kind === "image" || node.kind === "video"));
                return (
                  <div className="batch-collector">
                    <div className="batch-collector-summary">
                      <b>生成内容</b>
                      <span>{collected.length} 项</span>
                    </div>
                    {collected.length ? (
                      <div className="batch-collector-grid">
                        {collected.map((item) => (
                          <div className="batch-collector-item" key={item.id} title={item.name}>
                            {item.kind === "image" && item.src ? (
                              <img draggable={false} src={item.src} alt={item.name} />
                            ) : item.kind === "video" && item.src ? (
                              <video src={item.src} muted preload="metadata" />
                            ) : (
                              <span className="batch-waiting">等待生成…</span>
                            )}
                            <small>{item.name}</small>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="batch-collector-empty">
                        将生成的图片或视频节点连接到这里<br />
                        <small>结果会自动汇总在这个框内</small>
                      </div>
                    )}
                  </div>
                );
              })()}
              {n.kind === "text" && (
                <>
                  <button
                    className="text-trigger"
                    style={{
                      width: "100%",
                      height: "calc(100% - 29px)",
                      padding: 12,
                      color: "#dce8e7",
                      textAlign: "left",
                      whiteSpace: "pre-wrap",
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      setActiveStoryboard(null);
                      setActiveAiNode(null);
                      setActiveOnlineVideo(null);
                      setActiveText(n.id);
                    }}
                  >
                    {n.text || "点击输入文本"}
                  </button>
                  {!n.text && <div className="text-ai-actions" onPointerDown={(event) => event.stopPropagation()}>
                    <button className="text-add-ai" onClick={() => openTextAiComposer(n.id, "script")}>✦ AI 剧本生成</button>
                    <button className="text-add-ai storyboard" onClick={() => openTextAiComposer(n.id, "storyboardFrames")}>▦ AI 分镜画面</button>
                  </div>}
                  {false && activeText === n.id && (
                    <div
                      className="text-editor"
                      style={{
                        position: "absolute",
                        zIndex: 30,
                        top: n.height + 10,
                        left: 0,
                        width: 420,
                        padding: 13,
                        background: "#202729",
                        border: "1px solid #698181",
                        boxShadow: "0 16px 32px #0009",
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <b style={{ fontSize: 12, color: "#aeece1" }}>
                        上一个连接内容
                      </b>
                      <div
                        className="reference"
                        style={{
                          display: "grid",
                          gap: 7,
                          maxHeight: 150,
                          overflow: "auto",
                          margin: "9px 0",
                          color: "#b7c2c2",
                          fontSize: 12,
                        }}
                      >
                        {project.links
                          .filter((link) => link.to === n.id)
                          .map((link) =>
                            project.nodes.find((node) => node.id === link.from),
                          )
                          .filter(Boolean)
                          .map((source) => (
                            <div key={source!.id}>
                              {source!.kind === "image" && source!.src ? (
                                <img
                                  src={source!.src}
                                  alt={source!.name}
                                  style={{
                                    maxWidth: "100%",
                                    maxHeight: 120,
                                    objectFit: "contain",
                                  }}
                                />
                              ) : source!.kind === "video" && source!.src ? (
                                <video
                                  src={source!.src}
                                  controls
                                  preload="metadata"
                                  style={{ maxWidth: "100%", maxHeight: 120 }}
                                />
                              ) : source!.kind === "audio" && source!.src ? (
                                <audio
                                  src={source!.src}
                                  controls
                                  style={{ width: "100%" }}
                                />
                              ) : (
                                <span>{source!.text || source!.name}</span>
                              )}
                            </div>
                          ))}
                        {!project.links.some((link) => link.to === n.id) && (
                          <span>还没有连接上游图片、视频或文字。</span>
                        )}
                      </div>
                      <textarea
                        autoFocus
                        style={{
                          width: "100%",
                          height: 180,
                          resize: "vertical",
                          padding: 10,
                          border: "1px solid #536466",
                          background: "#121617",
                          color: "#f0f4f4",
                          font: "13px/1.6 Microsoft YaHei UI",
                        }}
                        value={n.text || ""}
                        onChange={(e) =>
                          change((p) => ({
                            ...p,
                            nodes: p.nodes.map((x) =>
                              x.id === n.id
                                ? { ...x, text: e.target.value }
                                : x,
                            ),
                          }))
                        }
                        placeholder="输入文字…"
                      />
                    </div>
                  )}
                </>
              )}
              {n.kind === "storyboard" && (
                <button
                  className="storyboard-trigger"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    setActiveText(null);
                    fitStoryboardNode(n.id);
                    setActiveStoryboard(n.id);
                  }}
                >
                  <table>
                    <thead>
                      <tr>
                        <th>镜头</th>
                        <th>画面</th>
                        <th>台词</th>
                        <th>参考</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(n.storyboard || defaultStoryboard()).slice(0, 4).map((row, index) => {
                        const reference = project.nodes.find((item) => item.id === row.imageId);
                        return (
                          <tr key={`${n.id}-${index}`}>
                            <td>{row.shot || index + 1}</td>
                            <td>{row.visual || "未填写"}</td>
                            <td>{row.dialogue || "—"}</td>
                            <td>
                              {reference?.src ? <img src={reference.src} alt={reference.name} /> : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <small>点击编辑分镜表</small>
                </button>
              )}
              {n.kind === "api" && (() => {
                const nodeDiagnostics = n.onlineProvider ? [] : comfyDiagnostics[n.id] || [];
                const nodeErrors = nodeDiagnostics.filter((diagnostic) => diagnostic.level === "error");
                const diagnosticsOpen = expandedComfyDiagnostics === n.id;
                return <>
                  {!n.onlineProvider && <button className="api-config-toggle comfy" onPointerDown={(event) => event.stopPropagation()} onClick={() => openComfyNodeParameters(n)}>参数</button>}
                  {n.onlineProvider && <>
                    <i className={`api-config-dot ${((n.workflow as { endpoint?: string; apiKey?: string; model?: string } | undefined)?.endpoint && (n.workflow as { endpoint?: string; apiKey?: string; model?: string } | undefined)?.apiKey && (n.workflow as { endpoint?: string; apiKey?: string; model?: string } | undefined)?.model) ? "ready" : ""}`} />
                    <button className="api-config-toggle" onPointerDown={(e) => e.stopPropagation()} onClick={() => setActiveApiConfig(activeApiConfig === n.id ? null : n.id)}>配置</button>
                    {activeApiConfig === n.id && (() => { const cfg = (n.workflow || {}) as { endpoint?: string; apiKey?: string; model?: string }; const update = (patch: Partial<typeof cfg>) => change((p) => ({ ...p, nodes: p.nodes.map((x) => x.id === n.id ? { ...x, workflow: { ...cfg, ...patch } } : x) })); return <div className="api-config-panel" onPointerDown={(e) => e.stopPropagation()}><label>地址<input value={cfg.endpoint || ""} onChange={(e) => update({ endpoint: e.target.value })} placeholder="https://api.openai.com/v1" /></label><label>API 密钥<input type="password" value={cfg.apiKey || ""} onChange={(e) => update({ apiKey: e.target.value })} /></label><label>模型<select disabled={!cfg.endpoint || !cfg.apiKey} value={cfg.model || "gpt-image-1"} onChange={(e) => update({ model: e.target.value })}><option>gpt-image-1</option><option>gpt-image-1-mini</option></select></label></div>; })()}
                  </>}
                  <button
                    className={`run ${n.status || "idle"}`}
                    disabled={n.status === "stopping"}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => n.status === "running" ? stopRun(n.id) : run(n.id)}
                  >
                    {n.status === "running"
                      ? "停止"
                      : n.status === "stopping"
                      ? "停止中…"
                      : n.onlineProvider
                      ? "运行"
                      : n.status === "error"
                        ? "重试"
                        : "运行"}
                  </button>
                  <span className={`api-status ${n.status || "idle"}`}>
                    {n.onlineProvider
                      ? ""
                      : n.status === "done"
                      ? "已完成"
                      : n.status === "running"
                        ? ""
                        : n.status === "error"
                          ? "需处理"
                          : "待运行"}
                  </span>
                  <div className="api-meta">
                    <span>
                      {project.links.filter((link) => link.to === n.id).length}{" "}
                      个输入
                    </span>
                  </div>
                  {!n.onlineProvider && nodeDiagnostics.length ? (
                    <div className="comfy-diagnostic-control" onPointerDown={(event) => event.stopPropagation()}>
                      <button
                        className={nodeErrors.length ? "has-errors" : "has-notes"}
                        title={nodeErrors.length ? `发现 ${nodeErrors.length} 项 ComfyUI 预检错误，点击查看节点、插槽和修复方式` : "查看本次 ComfyUI 自动适配记录"}
                        aria-expanded={diagnosticsOpen}
                        onClick={() => setExpandedComfyDiagnostics(diagnosticsOpen ? null : n.id)}
                      >
                        {nodeErrors.length ? `⚠ ${nodeErrors.length} 项` : `ⓘ ${nodeDiagnostics.length} 项`}
                      </button>
                      {diagnosticsOpen && (
                        <section className="comfy-diagnostic-popover" role="status" aria-label="ComfyUI 工作流诊断">
                          <header>
                            <span>COMFYUI 运行前检查</span>
                            <button title="收起诊断" onClick={() => setExpandedComfyDiagnostics(null)}>×</button>
                          </header>
                          <p className="comfy-diagnostic-intro">已按当前 ComfyUI 的 object_info 检查；不会把旧节点 ID 或节点名称猜测为正确连线。</p>
                          <div className="comfy-diagnostic-list">
                            {nodeDiagnostics.map((diagnostic, index) => {
                              const location = comfyDiagnosticLocation(diagnostic);
                              const type = diagnostic.expectedType || diagnostic.actualType;
                              return <article key={`${n.id}-${diagnostic.code || "diagnostic"}-${index}`} className={diagnostic.level}>
                                <header><b>{diagnostic.level === "error" ? "错误" : diagnostic.level === "warning" ? "注意" : "已适配"} · {comfyDiagnosticTitle(diagnostic)}</b>{diagnostic.code && <code>{diagnostic.code}</code>}</header>
                                {location && <span className="comfy-diagnostic-location">{location}</span>}
                                {type && <span className="comfy-diagnostic-types">期望 {diagnostic.expectedType || "—"} · 实际 {diagnostic.actualType || "—"}</span>}
                                <p>{diagnostic.message}</p>
                                <small>如何修复：{comfyDiagnosticRepair(diagnostic)}</small>
                              </article>;
                            })}
                          </div>
                          <footer>
                            <button onClick={() => { setLogsOpen(true); nodeErrors.forEach((diagnostic) => addLog(`ComfyUI 连线校验：${comfyDiagnosticSummary(diagnostic)}`)); }}>写入运行日志</button>
                            <button className="primary" disabled={n.status === "running" || n.status === "stopping"} onClick={() => void run(n.id)}>{n.status === "running" ? "正在运行" : "重试校验"}</button>
                          </footer>
                        </section>
                      )}
                    </div>
                  ) : n.validationErrors?.length ? <div className="workflow-validation" title={n.validationErrors.join("\n")}>{n.validationErrors.slice(0, 2).map((error, index) => <span key={`${n.id}-validation-${index}`}>⚠ {error}</span>)}</div> : null}
                  <small
                    title={n.name}
                    style={{
                      position: "absolute",
                      left: 8,
                      right: 8,
                      bottom: -19,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: "#b9c6c5",
                      fontSize: 10,
                      textAlign: "center",
                    }}
                  >
                    {n.name}
                  </small>
                </>;
              })()}
              {n.kind !== "api" && n.kind !== "audio" && (
                <span
                  className="resize"
                  onPointerDown={(e) => resize(e, n.id)}
                />
              )}
              {(n.kind === "annotation" || n.kind === "annotationPointer") && !n.locked && <span className="rotate" title="按住拖动，自由旋转" onPointerDown={(e) => rotateAnnotation(e, n.id)}>转</span>}
            </article>
          ))}
        </div>
        <div className="canvas-status">
          <span>画布 {Math.round(project.view.zoom * 100)}%</span>
          <button onClick={resetView}>定位全部内容</button>
        </div>
        <div className="minimap" title="画布导航图">
          <div className="minimap-world">
            {project.nodes.map((node) => (
              <i
                key={node.id}
                className={node.kind}
                style={{
                  left: Math.max(3, Math.min(136, node.x / 42)),
                  top: Math.max(3, Math.min(84, node.y / 32)),
                  width: Math.max(5, Math.min(25, node.width / 28)),
                  height: Math.max(4, Math.min(13, node.height / 28)),
                }}
              />
            ))}
          </div>
          <small>
            {studioStats.output
              ? `${studioStats.output} 个生成结果`
              : "暂无生成结果"}
          </small>
        </div>
        <div className="hint">
          滚轮缩放 · 拖动画布移动 · 右键添加 · Ctrl + 点击多选
        </div>
        <div
          className={`canvas-navigator ${navOpen ? "open" : ""}`}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button onClick={() => setNavOpen(!navOpen)}>
            {navOpen ? "收起导航" : "画布导航"}
          </button>
          {navOpen && (
            <div
              className="canvas-minimap"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={navigateFromMinimap}
            >
              {project.nodes.map((node) => (
                <i
                  key={node.id}
                  className={node.kind}
                  style={{
                    left: `${Math.max(2, Math.min(94, node.x / 60))}%`,
                    top: `${Math.max(2, Math.min(90, node.y / 36))}%`,
                    width: `${Math.max(3, Math.min(18, node.width / 42))}%`,
                    height: `${Math.max(3, Math.min(12, node.height / 32))}%`,
                  }}
                />
              ))}
            </div>
          )}
        </div>
        <div className="canvas-live-status" aria-live="polite" title={message}>
          <span>{message}</span>
        </div>
      </section>
      {previewImage?.src && (
        <div className="media-lightbox" onClick={() => setPreviewImage(null)}>
          <div onClick={(event) => event.stopPropagation()}>
            <button onClick={() => setPreviewImage(null)}>×</button>
            <img src={previewImage.src} alt={previewImage.name} />
            <small>{previewImage.name}</small>
          </div>
        </div>
      )}
      {activeOnlineVideoNode && (() => {
        const config: OnlineVideoSettings = {
          source: "byok", provider: "未选择平台", mode: "text", ratio: "16:9", quality: "720P", duration: 5, amount: 1, audio: true,
          ...((activeOnlineVideoNode.workflow || {}) as OnlineVideoSettings),
        };
        const source: GenerationSource = config.source || "byok";
        const update = (patch: Partial<OnlineVideoSettings>) => change((p) => ({
          ...p,
          nodes: p.nodes.map((node) => node.id === activeOnlineVideoNode.id ? { ...node, workflow: { ...config, ...patch } } : node),
        }));
        const modes: Record<NonNullable<OnlineVideoSettings["mode"]>, string> = { text: "文生视频", image: "图生视频", firstLast: "首尾帧视频", reference: "参考图视频" };
        const linkedReferences = project.links
          .filter((link) => link.to === activeOnlineVideoNode.id)
          .map((link) => project.nodes.find((node) => node.id === link.from))
          .filter((node): node is NodeItem => Boolean(node?.src && (node.kind === "image" || node.kind === "video")))
          .map((node) => ({ id: node.id, name: node.name, kind: node.kind as "image" | "video", src: node.src!, source: "generated" as const }));
        const linkedTextInputs = project.links
          .filter((link) => link.to === activeOnlineVideoNode.id)
          .map((link) => project.nodes.find((node) => node.id === link.from))
          .filter((node): node is NodeItem => Boolean(node && (node.kind === "text" || node.kind === "storyboard")))
          .map((node) => node.kind === "text" ? node.text || "" : storyboardText(node.storyboard))
          .filter((text) => text.trim());
        const references = [...(config.references || []), ...linkedReferences.filter((item) => !(config.references || []).some((reference) => reference.id === item.id))];
        const cloudPlatforms = cloudPlatformsFor("video");
        const cloudPlatform = cloudPlatforms.includes(config.provider || "") ? config.provider! : cloudPlatforms[0];
        const cloudModels = cloudModelsFor("video", cloudPlatform);
        const cloudModel = cloudModels.find((model) => model.id === config.model) || defaultCloudModel("video", cloudPlatform);
        const cloudMode = (config.mode || "text") as CloudVideoMode;
        const cloudModeText = (cloudModel?.videoModes || []).map((mode) => CLOUD_VIDEO_MODE_LABELS[mode]).join(" / ");
        const activeByokProvider = resolvedProviderConfig(config.provider || "", "video");
        const allByokModels = activeByokProvider?.detectedModels || [];
        const byokModels = modelsForProvider(config.provider || "", "video").map((id) => {
          const detected = allByokModels.find((model) => model.id === id) || classifyProviderModel(id);
          const modes = [...videoCapabilitiesFor(config.provider || "", id).modes];
          return {
            ...detected,
            kind: "video" as const,
            modes,
            purpose: `视频 · ${modes.map(videoModeLabel).join(" / ")}`,
          };
        });
        const selectedByokModelId = compatibleModelForProvider(
          config.provider || "",
          "video",
          config.modelPinned ? config.model : activeByokProvider?.model,
          config.model,
        );
        const byokModel = byokModels.find((model) => model.id === selectedByokModelId);
        const hasCompatibleByokVideoModel = Boolean(selectedByokModelId && byokModel);
        const byokVideoCapabilities = videoCapabilitiesFor(config.provider || "", selectedByokModelId);
        const normalizedByokVideoOptions = normalizeVideoGenerationOptions(byokVideoCapabilities, {
          mode: config.mode,
          amount: config.amount,
        });
        const byokSelectableModes: readonly VideoGenerationMode[] = byokModels.length
          ? [...new Set(byokModels.flatMap((model) => videoCapabilitiesFor(config.provider || "", model.id).modes))]
          : ["text"];
        const selectableVideoModes: readonly VideoGenerationMode[] = source === "byok"
          ? byokSelectableModes
          : source === "cloud"
            ? cloudModel?.videoModes || ["text"]
            : ["text"];
        const genericVideoRatios = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "2:1", "1:2"];
        const genericVideoQualities = ["480P", "540P", "720P", "1080P", "1440P (2K)", "2160P (4K)"];
        const selectableVideoAmounts = source === "byok" ? [1, 2, 3, 4, 5] : [1];
        const displayedVideoMode = source === "byok" ? normalizedByokVideoOptions.mode : (config.mode || "text") as VideoGenerationMode;
        const displayedVideoAmount = source === "byok" ? normalizedByokVideoOptions.amount : 1;
        const byokVideoRatios = byokVideoCapabilities.ratios;
        const byokVideoQualities = videoQualitiesFor(byokVideoCapabilities, config.ratio || "16:9", displayedVideoMode);
        const displayedVideoQuality = source === "byok"
          ? (config.quality || byokVideoQualities[0])
          : config.quality;
        const byokVideoDuration = byokVideoCapabilities.duration;
        const displayedVideoDuration = source === "byok"
          ? Math.min(25, Math.max(2, Number(config.duration) || 5))
          : config.duration;
        const byokSupportsAudio = supportsVideoAudio(byokVideoCapabilities, displayedVideoMode);
        const displayedVideoAudio = source === "byok" ? byokSupportsAudio && config.audio !== false : config.audio !== false;
        const displayedByokInputLimit = videoInputLimitForMode(byokVideoCapabilities, displayedVideoMode);
        const connectedImageReferenceCount = references.filter((item) => item.kind === "image" && Boolean(item.src)).length;
        const referenceAddDisabled = source === "byok" && (
          displayedByokInputLimit.maximum === 0 || connectedImageReferenceCount >= displayedByokInputLimit.maximum
        );
        const cloudEstimate = config.source === "cloud" ? estimateCloudPoints("video", cloudModel?.id, {
          promptLength: (config.prompt || "").length + linkedTextInputs.join("\n").length,
          references: references.length,
          amount: displayedVideoAmount,
          resolution: displayedVideoQuality,
          duration: config.duration,
          audio: config.audio,
        }) : null;
        const popover = onlinePopover?.nodeId === activeOnlineVideoNode.id ? onlinePopover.kind : null;
        const activeAtReference = atReferenceMenu?.nodeId === activeOnlineVideoNode.id ? atReferenceMenu : null;
        const generatedCandidates = project.nodes.filter((node) =>
          node.id !== activeOnlineVideoNode.id &&
          (node.kind === "image" || node.kind === "video") &&
          Boolean(node.src) && (Boolean(node.createdAt) || project.links.some((link) => link.from !== activeOnlineVideoNode.id && link.to === node.id)),
        );
        const attachReference = (media: NodeItem) => {
          const exists = project.links.some((link) => link.from === media.id && link.to === activeOnlineVideoNode.id);
          const activeMode = source === "byok" ? normalizedByokVideoOptions.mode : config.mode || "text";
          if (source === "byok") {
            const limit = videoInputLimitForMode(byokVideoCapabilities, activeMode);
            if (media.kind !== "image") {
              setMessage(`当前“${selectedByokModelId || "未选择模型"}”只接收图片输入，不能把视频作为${videoModeLabel(activeMode)}参考。`);
              return;
            }
            const existingImageCount = references.filter((item) => item.kind === "image" && Boolean(item.src)).length;
            if (!exists && limit.maximum === 0) {
              setMessage(`当前“${selectedByokModelId || "未选择模型"}”的${videoModeLabel(activeMode)}不接收图片参考。`);
              return;
            }
            if (!exists && existingImageCount >= limit.maximum) {
              const countText = limit.minimum === limit.maximum ? `恰好 ${limit.maximum}` : `最多 ${limit.maximum}`;
              setMessage(`当前“${selectedByokModelId || "未选择模型"}”的${videoModeLabel(activeMode)}只支持${countText}张图片；请先移除已有参考。`);
              return;
            }
          }
          const occupiedFramePorts = project.links
            .filter((link) => link.to === activeOnlineVideoNode.id)
            .map((link) => link.toPort)
            .filter(Boolean);
          const targetPort = activeMode === "reference"
            ? "references"
            : activeMode === "firstLast"
              ? (occupiedFramePorts.includes("firstFrame") ? "lastFrame" : "firstFrame")
              : "firstFrame";
          if (!exists && !connectCanvasNodes(media.id, activeOnlineVideoNode.id, { toPort: targetPort })) return;
          if (!(config.references || []).some((item) => item.id === media.id)) {
            update({ references: [...(config.references || []), { id: media.id, name: media.name, kind: media.kind as "image" | "video", src: media.src || "", source: "generated" }] });
          }
          setOnlinePopover(null);
          setMessage(`已将“${media.name}”作为视频参考连接。`);
        };
        const removeReference = (reference: OnlineReference) => {
          change((current) => ({
            ...current,
            links: current.links.filter((link) => !(link.from === reference.id && link.to === activeOnlineVideoNode.id)),
            nodes: current.nodes.map((node) => node.id === activeOnlineVideoNode.id
              ? {
                  ...node,
                  workflow: {
                    ...((node.workflow || {}) as OnlineVideoSettings),
                    references: (((node.workflow || {}) as OnlineVideoSettings).references || []).filter((item) => item.id !== reference.id),
                  },
                }
              : node),
          }));
          setMessage(`已移除参考：“${reference.name}”。`);
        };
        const insertAtReference = (index: number) => {
          const prompt = config.prompt || "";
          const start = activeAtReference?.start ?? prompt.length;
          const end = activeAtReference?.end ?? prompt.length;
          update({ prompt: `${prompt.slice(0, start)}@图片${index + 1} ${prompt.slice(end)}` });
          setAtReferenceMenu(null);
        };
        const appendPrompt = (text: string) => update({ prompt: `${config.prompt || ""}${config.prompt ? "，" : ""}${text}` });
        const rewritePrompt = async (action: "optimize" | "translate") => {
          const prompt = (config.prompt || "").trim();
          const sourceProjectId = activeProjectIdRef.current;
          const sourceNodeId = activeOnlineVideoNode.id;
          const isRewriteCurrent = () => {
            if (activeProjectIdRef.current !== sourceProjectId) return false;
            const currentNode = projectRef.current.nodes.find((node) => node.id === sourceNodeId);
            if (!currentNode) return false;
            const currentWorkflow = (currentNode.workflow || {}) as OnlineVideoSettings;
            return (currentWorkflow.prompt || "").trim() === prompt;
          };
          const providerConfig = resolvedProviderConfig(config.provider || "", "text");
          if (!prompt) { setMessage("请先输入提示词，再进行优化或翻译。"); return; }
          if (config.provider !== "阿里百炼·万相" || !providerConfig?.apiKey) {
            openOnlineConfiguration("byok", "阿里百炼·万相", "text");
            setMessage(`${action === "translate" ? "翻译" : "优化"}需要阿里百炼密钥；已打开本机配置。`);
            return;
          }
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            setMessage(action === "translate" ? "正在翻译提示词…" : "正在优化提示词…");
            const result = await invoke<string>("rewrite_alibaba_prompt", {
              endpoint: providerConfig.endpoint,
              apiKey: providerConfig.apiKey,
              prompt,
              action,
            });
            if (!isRewriteCurrent()) {
              addLog("提示词优化结果已丢弃：项目、节点或原始提示词已改变");
              return;
            }
            // Do not spread the render-time `config` back into state: the
            // user may have changed a different video option while the
            // rewrite request was in flight.
            change((current) => ({
              ...current,
              nodes: current.nodes.map((node) => node.id === sourceNodeId
                ? { ...node, workflow: { ...(node.workflow || {}), prompt: result.trim() } }
                : node),
            }));
            setMessage(action === "translate" ? "提示词已翻译为英文。" : "提示词已优化，可直接生成。" );
          } catch (error) {
            const detail = String(error).replace(/^Error: /, "");
            addLog(`提示词${action === "translate" ? "翻译" : "优化"}：${detail}`);
            if (isRewriteCurrent()) setMessage(`提示词${action === "translate" ? "翻译" : "优化"}失败：${humanizeApiError(detail)}`);
          }
        };
        const nodeElement = document.querySelector<HTMLElement>(`article[data-node-id="${activeOnlineVideoNode.id}"]`);
        const nodeRect = nodeElement?.getBoundingClientRect();
        const panelWidth = Math.min(760, Math.max(520, window.innerWidth - 24));
        const nodeCenter = nodeRect ? nodeRect.left + nodeRect.width / 2 : panelWidth / 2;
        const panelLeft = Math.max(12, Math.min(nodeCenter - panelWidth / 2, window.innerWidth - panelWidth - 12));
        const panelTop = Math.max(12, (nodeRect?.bottom || 12) + 8);
        const comfyLibraryItems = readComfyWorkflowLibrary().filter((item) => item.apiContent || item.format === "api");
        const selectedComfyItem = comfyLibraryItems.find((item) => item.id === config.comfyWorkflowId)
          || (comfyLibraryItems.length === 1 ? comfyLibraryItems[0] : undefined);
        const publishedComfyParameters = (selectedComfyItem?.parameters || []).filter((parameter) => parameter.enabled && isBasicComfyParameter(parameter));
        const generateOnlineVideo = async (promptOverride?: string) => {
          const prompt = [promptOverride ?? config.prompt ?? "", ...linkedTextInputs].filter((text) => text.trim()).join("\n\n").trim();
          if (!prompt) {
            setMessage(`请先写入视频提示词；也可以把文本或参考素材连接到${generationSourceLabel[source]}节点。`);
            return;
          }
          if (!validateExecutionGraph(activeOnlineVideoNode.id, "视频")) return;
          if (source === "comfy") {
            if (!comfyConnected) {
              void autoConnect();
              setMessage("正在检查本地 ComfyUI。连接成功后，请绑定一个导入的 API 工作流。");
              return;
            }
            if (!selectedComfyItem) {
              setWorkflowLibraryOpen(true);
              setMessage("请选择工作流库中的视频 API 工作流，并扫描要调整的参数。");
              return;
            }
            const selectedComfyWorkflowSettings = !config.comfyWorkflowId
              ? { ...config, comfyWorkflowId: selectedComfyItem.id, comfyValues: config.comfyValues || {} }
              : null;
            const inputProjectOverride = selectedComfyWorkflowSettings
              ? {
                  ...projectRef.current,
                  nodes: projectRef.current.nodes.map((item) => item.id === activeOnlineVideoNode.id
                    ? { ...item, workflow: selectedComfyWorkflowSettings }
                    : item),
                }
              : undefined;
            if (selectedComfyWorkflowSettings) update(selectedComfyWorkflowSettings);
            const apiContent = selectedComfyItem.apiContent || (selectedComfyItem.format === "api" ? selectedComfyItem.content : undefined);
            if (!apiContent) {
              setWorkflowLibraryOpen(true);
              setMessage("该工作流还没有 API 数据，请在工作流库中点击“扫描参数”。");
              return;
            }
            const configured = applyComfyParameters(apiContent, selectedComfyItem.parameters || [], config.comfyValues || {});
            setMessage(`正在运行本地视频工作流“${selectedComfyItem.name}”…`);
            await run(activeOnlineVideoNode.id, undefined, configured, prompt, inputProjectOverride);
            return;
          }
          if (source === "byok") {
            if (!onlineVideoProviderNames.includes(config.provider || "")) {
              openOnlineConfiguration("byok", config.provider === "未选择平台" ? undefined : config.provider, "video");
              setMessage("请先保存一个支持视频的 API 配置；保存后会直接显示在当前视频节点的平台和模型下拉框中。 ");
              return;
            }
            const providerConfig = resolvedProviderConfig(config.provider || "", "video");
            if (!providerConfig?.endpoint || !providerConfig.apiKey) {
              openOnlineConfiguration("byok", config.provider, "video");
              setMessage(`请先完成“${config.provider}”的接口地址和密钥配置。`);
              return;
            }
            if (!hasCompatibleByokVideoModel || !modelsForProvider(config.provider || "", "video").includes(selectedByokModelId)) {
              openOnlineConfiguration("byok", config.provider, "video");
              setMessage(`“${config.provider}”当前没有已确认的视频模型；文本或图片模型不会填入视频节点。请在配置台为正确模型勾选“视频”。`);
              return;
            }
            if (config.provider === "可灵 Kling" && providerConfig.klingAuth === "aksk" && !providerConfig.apiSecret?.trim()) {
              openOnlineConfiguration("byok", config.provider, "video");
              setMessage("可灵 AK/SK 签名方式需要同时填写 Access Key 和 Secret Key。");
              return;
            }
            if (!["阿里百炼·万相", "可灵 Kling", "豆包·火山方舟"].includes(config.provider || "")) {
              setMessage(`“${config.provider}”还没有专用视频协议适配，请使用万相、可灵或豆包。`);
              return;
            }
            const configuredModel = selectedByokModelId;
            const requestCapabilities = videoCapabilitiesFor(config.provider || "", configuredModel);
            const normalizedRequestOptions = normalizeVideoGenerationOptions(requestCapabilities, {
              mode: config.mode,
              amount: config.amount,
            });
            const requestMode = normalizedRequestOptions.mode;
            const supportedRequestQualities = videoQualitiesFor(requestCapabilities, config.ratio || "16:9", requestMode);
            const requestQuality = config.quality || supportedRequestQualities[0];
            const durationContract = requestCapabilities.duration;
            const requestDuration = Math.min(25, Math.max(2, Number(config.duration) || 5));
            const requestAmount = Math.min(5, Math.max(1, Number(config.amount) || 1));
            const requestAudio = config.audio !== false;
            const hasNormalizedVideoSettings = normalizedRequestOptions.changed
              || requestAmount !== config.amount
              || configuredModel !== config.model
              || config.modelPinned !== true;
            const normalizedVideoPatch: Partial<OnlineVideoSettings> = {
              model: configuredModel,
              modelPinned: true,
              mode: requestMode,
              amount: requestAmount,
              quality: requestQuality,
              duration: requestDuration,
              audio: requestAudio,
            };
            const generationRecord: ApiGenerationRecord = {
              kind: "video",
              sourceNodeId: activeOnlineVideoNode.id,
              workflow: { ...config, ...normalizedVideoPatch },
              prompt,
              createdAt: Date.now(),
            };
            if (hasNormalizedVideoSettings) {
              update(normalizedVideoPatch);
            }
            const parameterErrors: string[] = [];
            if (!requestCapabilities.ratios.includes(config.ratio || "16:9")) parameterErrors.push(`已确认比例为 ${requestCapabilities.ratios.join(" / ")}`);
            if (!supportedRequestQualities.includes(requestQuality as (typeof supportedRequestQualities)[number])) parameterErrors.push(`已确认清晰度为 ${supportedRequestQualities.join(" / ")}`);
            if (requestDuration < durationContract.minimum || requestDuration > durationContract.maximum) parameterErrors.push(`已确认时长为 ${durationContract.minimum}-${durationContract.maximum} 秒`);
            if (requestAudio && !supportsVideoAudio(requestCapabilities, requestMode)) parameterErrors.push("当前模型未确认支持原生音频");
            if (parameterErrors.length) {
              setMessage(`“${configuredModel}”当前不能按所选参数生成：${parameterErrors.join("；")}。`);
              return;
            }
            const unsupportedReferences = references.filter((item) => item.kind !== "image" || !item.src);
            if (unsupportedReferences.length) {
              setMessage(`“${configuredModel}”当前适配只会传递图片参考；请移除 ${unsupportedReferences.map((item) => `“${item.name}”`).join("、")} 后再生成。`);
              return;
            }
            const imageReferences = references.filter((item) => item.kind === "image" && Boolean(item.src));
            const inputErrors = validateVideoGenerationInput(requestCapabilities, {
              mode: requestMode,
              amount: requestAmount,
              imageCount: imageReferences.length,
            });
            if (inputErrors.length) {
              setMessage(`“${configuredModel}”${inputErrors.join("；")}。`);
              return;
            }
            const mentionedReference = Array.from(prompt.matchAll(/@图片(\d+)/g))
              .map((match) => references[Number(match[1]) - 1])
              .find((item): item is OnlineReference => Boolean(item?.src && item.kind === "image"));
            const firstFrameLink = project.links.find((link) => link.to === activeOnlineVideoNode.id && link.toPort === "firstFrame");
            const lastFrameLink = project.links.find((link) => link.to === activeOnlineVideoNode.id && link.toPort === "lastFrame");
            const firstFrameReference = imageReferences.find((item) => item.id === firstFrameLink?.from)
              || mentionedReference
              || imageReferences[0];
            const lastFrameReference = imageReferences.find((item) => item.id === lastFrameLink?.from)
              || imageReferences.find((item) => item.id !== firstFrameReference?.id);
            if (requestMode === "firstLast" && (!firstFrameReference || !lastFrameReference || firstFrameReference.id === lastFrameReference.id)) {
              setMessage(`“${configuredModel}”的首尾帧需要两张不同的图片，并分别连接到首帧和尾帧。`);
              return;
            }
            const selectedImageReferences = requestMode === "text"
              ? []
              : requestMode === "image"
                ? firstFrameReference ? [firstFrameReference] : []
                : requestMode === "firstLast"
                  ? [firstFrameReference!, lastFrameReference!]
                  : imageReferences;
            const requestModel = normalizeExplicitProviderModelId(configuredModel);
            const providerShortName = config.provider === "可灵 Kling" ? "可灵" : config.provider === "豆包·火山方舟" ? "豆包" : "万相";
            // `update()` is batched by React. Sign the same configuration that
            // it will persist, so automatic capability normalisation cannot
            // make this very request look stale on its own completion.
            const inputProject = hasNormalizedVideoSettings
              ? {
                  ...projectRef.current,
                  nodes: projectRef.current.nodes.map((item) => item.id === activeOnlineVideoNode.id
                    ? { ...item, workflow: { ...config, ...normalizedVideoPatch } }
                    : item),
                }
              : projectRef.current;
            const runToken = runRegistry.current.start(activeProjectIdRef.current, activeOnlineVideoNode.id);
            const runInputSignature = createExecutionInputSignature(inputProject, activeOnlineVideoNode.id);
            setRuntimeNodeStatus(activeOnlineVideoNode.id, "running");
            let providerProgressTimer: number | undefined;
            try {
              const { invoke } = await import("@tauri-apps/api/core");
              const imageInputDetail = requestMode === "firstLast"
                ? "首帧与尾帧各 1 张图片"
                : selectedImageReferences.length
                  ? `${selectedImageReferences.length} 张图片`
                  : "文生视频";
              setMessage(`${providerShortName}正在提交“${requestModel}”${videoModeLabel(requestMode)}任务（密钥已读取 · ${imageInputDetail} · ${requestQuality} · ${requestDuration}s）${linkedTextInputs.length ? `，并合并 ${linkedTextInputs.length} 个文本输入` : ""}…`);
              // A canvas image may now be stored in AppLocalData. Convert it
              // only for this outbound API request; keeping its preview URL in
              // the node avoids persisting Base64 into the project itself.
              const requestImages = await Promise.all(selectedImageReferences.map(async (reference) => [
                reference.id,
                await readSourceAsDataUrl(reference.src),
              ] as const));
              if (!canCommitRunWithInputs(runToken, runInputSignature)) return;
              const requestImageById = new Map(requestImages);
              const providerRequestStartedAt = Date.now();
              providerProgressTimer = window.setInterval(() => {
                if (!runRegistry.current.canCommit(runToken.projectId, runToken.nodeId, runToken.runId)) return;
                const elapsedSeconds = Math.max(1, Math.round((Date.now() - providerRequestStartedAt) / 1000));
                setMessage(`${providerShortName}密钥已随请求发送；正在等待平台生成“${requestModel}”（已等待 ${elapsedSeconds} 秒）…`);
              }, 15_000);
              const result = await invoke<{ task_id: string; request_id?: string; video_url: string }>("generate_provider_video", {
                provider: config.provider,
                endpoint: providerConfig.endpoint,
                apiKey: providerConfig.apiKey,
                apiSecret: providerConfig.apiSecret || null,
                model: requestModel,
                prompt,
                mode: requestMode,
                ratio: config.ratio || "16:9",
                quality: requestQuality,
                duration: requestDuration,
                audio: requestAudio,
                imageUrls: requestImages.map(([, source]) => source),
                firstFrameUrl: requestMode === "firstLast" || requestMode === "image" ? requestImageById.get(firstFrameReference?.id || "") || null : null,
                lastFrameUrl: requestMode === "firstLast" ? requestImageById.get(lastFrameReference?.id || "") || null : null,
                amount: normalizedRequestOptions.amount,
              });
              if (!canCommitRunWithInputs(runToken, runInputSignature)) return;
              // The provider may return a different valid frame than the
              // requested ratio. Decode the finished video and size the card
              // from its actual frame, rather than leaving a portrait result
              // inside the old landscape node and cropping it with cover.
              const decodedVideoDimensions = await readGeneratedMediaDimensions("video", result.video_url);
              if (!canCommitRunWithInputs(runToken, runInputSignature)) return;
              const requestedSize = onlineVideoSizeForRatio(config.ratio);
              const cardSize = decodedVideoDimensions
                ? generatedMediaCardSize("video", decodedVideoDimensions)
                : { width: requestedSize[0], height: requestedSize[1] + 29 };
              const generatedWidth = cardSize.width;
              const generatedHeight = cardSize.height - 29;
              const generated: NodeItem = {
                id: newId(), kind: "video", x: activeOnlineVideoNode.x + activeOnlineVideoNode.width + 80, y: activeOnlineVideoNode.y,
                width: cardSize.width, height: cardSize.height, name: `${providerShortName}-${result.task_id}.mp4`, fileName: `${providerShortName}-${result.task_id}.mp4`, src: result.video_url, createdAt: Date.now(),
                generationRecord,
              };
              if (activeOnlineVideoNode.kind === "video") {
                change((p) => ({ ...p, nodes: p.nodes.map((node) => node.id === activeOnlineVideoNode.id ? { ...node, status: "done", src: result.video_url, fileName: generated.fileName, name: generated.name, width: cardSize.width, height: cardSize.height, mediaWidth: decodedVideoDimensions?.width || generatedWidth, mediaHeight: decodedVideoDimensions?.height || generatedHeight, generationRecord } : node) }));
                // Direct video nodes reuse their own card instead of adding a
                // second card, but the output is still a newly generated
                // asset and must appear in the same recent-media tray.
                setRecent((items) => [generated, ...items]);
                setRecentOpen(true);
                setMessage(`${providerShortName}视频已直接生成到当前视频节点。`);
              } else {
                setRecent((items) => [generated, ...items]);
                setRecentOpen(true);
                change((p) => appendTypedLink({
                  ...p,
                  nodes: [...p.nodes.map((node) => node.id === activeOnlineVideoNode.id ? { ...node, status: "done" } : node), generated],
                }, activeOnlineVideoNode.id, generated.id).project);
                setMessage(`${providerShortName}视频生成成功，已创建独立视频素材节点并连接到 AI 视频节点。`);
              }
              runRegistry.current.finish(runToken.projectId, runToken.nodeId, runToken.runId);
            } catch (error) {
              const detail = String(error).replace(/^Error: /, "");
              addLog(`${config.provider}：${detail}`);
              if (canCommitRunWithInputs(runToken, runInputSignature)) {
                setRuntimeNodeStatus(activeOnlineVideoNode.id, "error");
                runRegistry.current.finish(runToken.projectId, runToken.nodeId, runToken.runId);
                const authenticationFailure = config.provider === "可灵 Kling" && /\b401\b|auth failed|unauthorized|鉴权失败/i.test(detail);
                setMessage(authenticationFailure
                  ? "可灵生成未提交：API 鉴权失败（401）。请在“添加配置”中确认密钥类型；单 API Key 与 Access Key + Secret Key 不能混用，修改后请先点“测试连接”。"
                  : `${providerShortName}生成失败：${humanizeApiError(detail)}`);
              }
            } finally {
              if (providerProgressTimer !== undefined) window.clearInterval(providerProgressTimer);
            }
            return;
          }
          if (!cloudConfigured) {
            openOnlineConfiguration("cloud");
            setMessage("请先配置亿幕云端服务地址和登录令牌。 ");
            return;
          }
          setMessage("亿幕云端配置已保存，但云端账户、积分账本与任务服务尚未部署；当前不会扣费或提交任务。 ");
        };
        return <section className="online-video-composer online-video-unified-console" onPointerDown={(event) => event.stopPropagation()}>
          {pendingVideoRegeneration?.sourceNodeId === activeOnlineVideoNode.id && <OneShotGenerationTrigger
            requestId={pendingVideoRegeneration.requestId}
            run={() => {
              const request = pendingVideoRegeneration;
              setPendingVideoRegeneration(null);
              return generateOnlineVideo(request.prompt);
            }}
          />}
          <button className="online-video-console-close" title="关闭" onClick={() => setActiveOnlineVideo(null)}>×</button>
          <div className="online-reference-dock" aria-label="参考素材">
            {references.length > 0 && <div className="online-reference-stack" title="鼠标移入展开全部参考素材">
              {references.slice(0, 6).map((item, index) => <div className="online-reference-stack-card" key={item.id} title={`@图片${index + 1} · ${item.name}`}>
                {item.kind === "video" ? <video src={item.src} muted playsInline /> : <img src={item.src} alt={item.name} />}
                <span className="online-reference-label">图片{index + 1}</span>
                <button aria-label={`移除 ${item.name}`} title="移除参考" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); removeReference(item); }}>×</button>
              </div>)}
            </div>}
            <div className="online-reference-adders">
              <button className="online-reference-add canvas" disabled={referenceAddDisabled} title={referenceAddDisabled ? "当前模式暂时不能再添加参考图" : "从画布生成内容添加参考"} aria-label="从画布生成内容添加参考" onClick={() => setOnlinePopover({ nodeId: activeOnlineVideoNode.id, kind: "reference" })}><strong>＋</strong><small>画布生成</small></button>
              <button className="online-reference-add computer" disabled={referenceAddDisabled} title={referenceAddDisabled ? "当前模式暂时不能再添加参考图" : "从电脑选择图片参考"} aria-label="从电脑选择图片参考" onClick={() => onlineReferenceRef.current?.click()}><strong>＋</strong><small>电脑文件</small></button>
            </div>
            <div className="online-reference-actions">
              <button className="online-prompt-library-trigger online-prompt-library-trigger-inline" title="打开提示词库：搜索、分类、保存并写入当前提示词" onClick={() => setPromptLibraryTarget({ nodeId: activeOnlineVideoNode.id, kind: "video" })}>提示词库</button>
              {references.length > 0 && <button className="online-at-reference-trigger" title="选择参考图并写入提示词；不会打开或更改配置" onClick={() => { setOnlinePopover(null); setAtReferenceMenu({ nodeId: activeOnlineVideoNode.id, start: (config.prompt || "").length, end: (config.prompt || "").length }); }}>@图片</button>}
            </div>
          </div>
          {activeAtReference && references.length > 0 && <div className="online-at-reference-menu" onPointerDown={(event) => event.stopPropagation()}>
            <small>选择后仅写入提示词，不会更改配置</small>
            <div>{references.slice(0, 6).map((item, index) => <button key={item.id} title={`写入 @图片${index + 1}`} onClick={() => insertAtReference(index)}>
              {item.kind === "video" ? <video src={item.src} muted playsInline /> : <img src={item.src} alt="" />}<span>@图片{index + 1}</span>
            </button>)}</div>
          </div>}
          {popover && popover !== "settings" && popover !== "params" && <div className="online-video-popover">
            {popover === "reference" && <>
              <b>从画布已生成内容添加</b>
              <small>点击后自动连线；电脑文件请使用上方“电脑文件＋”。</small>
              {generatedCandidates.length ? <div className="online-reference-list">{generatedCandidates.map((item) => <button key={item.id} onClick={() => attachReference(item)}>{item.src && (item.kind === "video" ? <video src={item.src} muted playsInline /> : <img src={item.src} alt="" />)}<span>{item.kind === "video" ? "视频" : "图片"} · {item.name}</span></button>)}</div> : <small>还没有生成内容。先生成图片或视频后，会自动出现在这里。</small>}
            </>}
            {popover === "character" && <><b>角色参考</b><small>选择已生成的角色图后会自动连线并写入提示词。</small><div className="online-reference-list">{generatedCandidates.filter((item) => item.kind === "image").map((item) => <button key={item.id} onClick={() => attachReference(item)}>{item.src && <img src={item.src} alt="" />}<span>{item.name}</span></button>)}</div></>}
            {popover === "effect" && <><b>选择特效</b><div className="online-token-list">{["电影级光影", "慢动作", "粒子飞散", "胶片质感", "梦幻柔焦"].map((item) => <button key={item} onClick={() => { appendPrompt(item); setOnlinePopover(null); }}>{item}</button>)}</div></>}
            {popover === "camera" && <><b>选择运镜</b><div className="online-token-list">{["镜头缓慢推进", "镜头缓慢拉远", "从左向右平移", "低机位仰拍", "环绕主体运镜"].map((item) => <button key={item} onClick={() => { appendPrompt(item); setOnlinePopover(null); }}>{item}</button>)}</div></>}
            {popover === "promptLibrary" && <><b>提示词库</b><small>已改为独立面板，可搜索、分类、重命名并插入当前提示词。</small><button onClick={() => setPromptLibraryTarget({ nodeId: activeOnlineVideoNode.id, kind: "video" })}>打开提示词库</button></>}
          </div>}
          {linkedTextInputs.length > 0 && <div className="online-linked-input-note" title="这些内容来自连到当前视频节点的文本或分镜节点，会在提交时自动合并进提示词。">已连接 {linkedTextInputs.length} 条文本输入 · 生成时自动带入</div>}
          <BufferedProjectTextarea
            className="online-video-prompt"
            nodeId={activeOnlineVideoNode.id}
            value={config.prompt || ""}
            onCommit={(prompt) => update({ prompt })}
            onDraft={(value, field) => {
              const caret = field.selectionStart ?? value.length;
              const match = value.slice(0, caret).match(/@[^\s，。；、,.!?]*$/);
              if (match && references.length > 0) setAtReferenceMenu({ nodeId: activeOnlineVideoNode.id, start: caret - match[0].length, end: caret });
              else setAtReferenceMenu(null);
            }}
            onSubmit={(prompt) => void generateOnlineVideo(prompt)}
            placeholder="描述你想要生成的画面内容，输入 @ 可引用上方图片"
          />
          <div className="online-video-consolebar">
            {source === "byok" && (onlineVideoProviderNames.length ? <select aria-label="平台" value={onlineVideoProviderNames.includes(config.provider || "") ? config.provider : ""} onChange={(event) => {
              const provider = event.target.value;
              const requestedMode = (config.mode || "text") as VideoGenerationMode;
              const candidateIds = modelsForProvider(provider, "video");
              const model = candidateIds.find((id) => videoCapabilitiesFor(provider, id).modes.includes(requestedMode))
                || candidateIds[0]
                || "";
              const nextCapabilities = videoCapabilitiesFor(provider, model);
              const nextOptions = normalizeVideoGenerationOptions(nextCapabilities, { mode: requestedMode, amount: config.amount });
              update({ provider, model, modelPinned: false, mode: nextOptions.mode, amount: nextOptions.amount });
            }}>
              {!onlineVideoProviderNames.includes(config.provider || "") && <option value="">选择已保存的视频平台</option>}
              {onlineVideoProviderNames.map((provider) => <option key={provider}>{provider}</option>)}
            </select> : <span className="online-video-source-status">先添加视频配置</span>)}
            {source === "byok" && byokModels.length > 0 && <select className="cloud-video-model-select" aria-label="自带密钥视频模型" title={byokModel?.purpose} value={byokModel?.id || ""} onChange={(event) => {
              const nextCapabilities = videoCapabilitiesFor(config.provider || "", event.target.value);
              const nextOptions = normalizeVideoGenerationOptions(nextCapabilities, { mode: config.mode, amount: config.amount });
              update({ model: event.target.value, modelPinned: true, mode: nextOptions.mode, amount: nextOptions.amount });
            }}>{byokModels.map((model) => <option value={model.id} key={model.id}>{model.id}｜{model.purpose}</option>)}</select>}
            {source === "byok" && byokModels.length === 0 && <button className="online-video-source-status" onClick={() => openOnlineConfiguration("byok", config.provider, "video")} title="当前平台没有已确认的视频生成模型">无匹配视频模型</button>}
            {source === "comfy" && <button className={`online-video-source-status ${comfyConnected ? "ready" : ""}`} title="检查本地 ComfyUI" onClick={() => void autoConnect()}>{comfyConnected ? "本地已连接" : "未连接 ComfyUI"}</button>}
            {source === "comfy" && <select className="online-video-workflow-select" aria-label="ComfyUI 工作流" value={config.comfyWorkflowId || ""} onChange={(event) => update({ comfyWorkflowId: event.target.value, comfyValues: {} })}><option value="">选择工作流</option>{comfyLibraryItems.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select>}
            {source === "cloud" && <select aria-label="云端视频平台" value={cloudPlatform} onChange={(event) => {
              const provider = event.target.value;
              const platformModels = cloudModelsFor("video", provider);
              const nextModel = platformModels.find((model) => supportsCloudVideoMode(model, cloudMode)) || defaultCloudModel("video", provider);
              const nextMode = supportsCloudVideoMode(nextModel, cloudMode) ? cloudMode : nextModel?.videoModes?.[0] || "text";
              update({ provider, model: nextModel?.id, mode: nextMode });
            }}>{cloudPlatforms.map((platform) => <option key={platform}>{platform}</option>)}</select>}
            {source === "cloud" && <select className="cloud-video-model-select" aria-label="云端视频模型" title={cloudModel?.description} value={cloudModel?.id || ""} onChange={(event) => {
              const nextModel = cloudModels.find((model) => model.id === event.target.value);
              update({ model: event.target.value, mode: supportsCloudVideoMode(nextModel, cloudMode) ? cloudMode : nextModel?.videoModes?.[0] || "text" });
            }}>{cloudModels.map((model) => <option value={model.id} key={model.id}>{model.label}｜{(model.videoModes || []).map((mode) => CLOUD_VIDEO_MODE_LABELS[mode]).join("、")}</option>)}</select>}
            {source === "cloud" && cloudModel && <span className="cloud-model-purpose" title={cloudModel.description}><b>{cloudModeText}</b><small>{cloudModel.description}</small></span>}
            <select aria-label="视频生成模式" value={displayedVideoMode} onChange={(event) => {
              const mode = event.target.value as VideoGenerationMode;
              if (source === "byok") {
                if (byokVideoCapabilities.modes.includes(mode)) {
                  update({ mode, amount: byokVideoCapabilities.amounts[0] });
                  return;
                }
                const compatible = byokModels.find((model) => videoCapabilitiesFor(config.provider || "", model.id).modes.includes(mode));
                if (compatible) {
                  const capabilities = videoCapabilitiesFor(config.provider || "", compatible.id);
                  update({ mode, model: compatible.id, modelPinned: true, amount: capabilities.amounts[0] });
                  setMessage(`已自动切换到支持“${videoModeLabel(mode)}”的 ${compatible.id}。`);
                } else {
                  setMessage(`“${config.provider}”当前已配置模型不支持“${videoModeLabel(mode)}”。`);
                }
                return;
              }
              const cloudMode = mode as CloudVideoMode;
              if (source !== "cloud" || supportsCloudVideoMode(cloudModel, cloudMode)) { update({ mode: cloudMode }); return; }
              const samePlatformModel = cloudModels.find((model) => supportsCloudVideoMode(model, cloudMode));
              const compatibleModel = samePlatformModel || cloudModelsFor("video").find((model) => supportsCloudVideoMode(model, cloudMode));
              update({ mode: cloudMode, provider: compatibleModel?.platform || cloudPlatform, model: compatibleModel?.id || cloudModel?.id });
              setMessage(compatibleModel ? `已自动切换到支持“${CLOUD_VIDEO_MODE_LABELS[cloudMode]}”的 ${compatibleModel.label}。` : `当前云端模型暂不支持“${CLOUD_VIDEO_MODE_LABELS[cloudMode]}”。`);
            }}>{selectableVideoModes.map((mode) => <option value={mode} key={mode}>{modes[mode]}{source === "byok" && !byokVideoCapabilities.modes.includes(mode) ? "（将自动换模型）" : source === "cloud" && !supportsCloudVideoMode(cloudModel, mode as CloudVideoMode) ? "（将自动换模型）" : ""}</option>)}</select>
            <div className="online-video-menu-anchor">
              <button className="online-video-params-trigger" title={source === "byok" && !byokSupportsAudio ? "当前模型不支持原生音频" : "视频参数"} aria-label="视频参数" onClick={() => setOnlinePopover(popover === "params" ? null : { nodeId: activeOnlineVideoNode.id, kind: "params" })}>▭ {source === "comfy" ? `${selectedComfyItem?.name || "选择工作流"} · ${publishedComfyParameters.length}项参数` : `${config.ratio} · ${displayedVideoQuality} · ${displayedVideoDuration}s · ${displayedVideoAmount}个 · ${displayedVideoAudio ? "🔊" : "🔇"}`}⌄</button>
              {popover === "params" && <div className="online-video-floating-popover online-video-params-popover">
                <b>{source === "comfy" ? "ComfyUI 工作流参数" : "视频参数"}</b><small>{source === "comfy" ? "参数来自工作流库，只修改当前节点的运行副本。" : "通用参数可自由选择；生成前会检查当前模型的已确认能力。"}</small>
                {source === "byok" && <small>当前模型已确认：比例 {byokVideoRatios.join(" / ")}；清晰度 {byokVideoQualities.join(" / ")}；时长 {byokVideoDuration.minimum}-{byokVideoDuration.maximum} 秒；单任务 {byokVideoCapabilities.amounts.join("、")} 个。</small>}
                {source === "comfy" ? <div className="online-comfy-parameter-list">
                  {!selectedComfyItem && <small>请先从下方选择一个工作流。</small>}
                  {selectedComfyItem && !publishedComfyParameters.length && <button onClick={() => setWorkflowLibraryOpen(true)}>到工作流库扫描参数</button>}
                  {publishedComfyParameters.map((parameter) => <label title={comfyParameterHelp(parameter)} key={parameter.id}><span>{parameter.label} <i className="comfy-help">?</i><small>{parameter.nodeTitle} · {parameter.input}</small></span>{parameter.kind === "boolean"
                    ? <select value={String(config.comfyValues?.[parameter.id] ?? parameter.value)} onChange={(event) => update({ comfyValues: { ...(config.comfyValues || {}), [parameter.id]: event.target.value === "true" } })}><option value="true">开启</option><option value="false">关闭</option></select>
                    : <input type={parameter.kind === "number" ? "number" : "text"} value={String(config.comfyValues?.[parameter.id] ?? parameter.value)} onChange={(event) => update({ comfyValues: { ...(config.comfyValues || {}), [parameter.id]: parameter.kind === "number" ? Number(event.target.value) : event.target.value } })} />}</label>)}
                </div> : <>
                <div className="online-param-section online-param-wide"><strong>比例</strong><div className="online-param-options online-param-ratios">{(source === "byok" ? genericVideoRatios : ["Auto", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]).map((item) => <button className={config.ratio === item ? "active" : ""} key={item} onClick={() => update({ ratio: item })}>{item}</button>)}</div></div>
                <div className="online-param-section"><strong>清晰度</strong><div className="online-param-options">{(source === "byok" ? genericVideoQualities : ["480P", "720P", "1080P"]).map((item) => <button className={displayedVideoQuality === item ? "active" : ""} key={item} onClick={() => update({ quality: item })}>{item}</button>)}</div></div>
                <div className="online-param-section"><strong>视频时长</strong><label className="online-duration-control"><input type="range" min="2" max="25" step="1" value={displayedVideoDuration} onChange={(event) => update({ duration: Number(event.target.value) })} /><output>{displayedVideoDuration} 秒</output></label></div>
                <div className="online-param-section"><strong>生成音频</strong>{source === "byok" && !byokSupportsAudio ? <small>当前模型不支持原生音频；不会提交音频参数。</small> : <div className="online-param-options two"><button className={config.audio ? "active" : ""} onClick={() => update({ audio: true })}>开启</button><button className={!config.audio ? "active" : ""} onClick={() => update({ audio: false })}>关闭</button></div>}</div>
                <div className="online-param-section"><strong>生成数量</strong><div className="online-param-options three">{selectableVideoAmounts.map((item) => <button className={displayedVideoAmount === item ? "active" : ""} key={item} onClick={() => update({ amount: item })}>{item}个</button>)}</div></div>
                </>}
              </div>}
            </div>
            <button className="online-video-icon-button" title="提示词优化" aria-label="提示词优化" onClick={() => void rewritePrompt("optimize")}>✧</button><button className="online-video-icon-button" title="翻译提示词为英文" aria-label="翻译提示词为英文" onClick={() => void rewritePrompt("translate")}>文</button><div className="online-video-menu-anchor"><button className="online-video-icon-button" title="生成来源设置" aria-label="生成来源设置" onClick={() => setOnlinePopover(popover === "settings" ? null : { nodeId: activeOnlineVideoNode.id, kind: "settings" })}>☷</button>{popover === "settings" && <div className="online-video-floating-popover online-video-source-popover"><b>生成设置</b><small>本地 ComfyUI 在这里切换；云端平台请用左侧“添加配置 / 已配置”管理。</small><div className="online-settings-sources"><button className={source === "comfy" ? "active" : ""} onClick={() => { update({ source: "comfy" }); void autoConnect(); setOnlinePopover(null); }}>本地 ComfyUI</button><button className={source === "byok" ? "active" : ""} onClick={() => { update({ source: "byok" }); setOnlinePopover(null); }}>已保存 API 配置</button></div></div>}</div>
            <button className="online-video-generate" disabled={source === "byok" && !hasCompatibleByokVideoModel} title={source === "byok" && !hasCompatibleByokVideoModel ? "请先配置真正支持视频的模型" : "生成视频（Enter）"} onClick={() => void generateOnlineVideo()}>{source === "byok" && !hasCompatibleByokVideoModel ? "配置视频模型" : "生成"} <span>↵</span></button>
          </div>
        </section>;
      })()}
      {activeTextNode && (
        <section
          className={`script-composer ${dropTextTarget === activeTextNode.id ? "drop-ready" : ""}`}
          onPointerDown={(event) => event.stopPropagation()}
          onDragOver={(event) => textDragOver(event, activeTextNode.id)}
          onDragLeave={() => setDropTextTarget(null)}
          onDrop={(event) => textDrop(event, activeTextNode)}
        >
          <div className="composer-top">
            <div>
              <span>创作输入</span>
              <b>{activeTextNode.name}</b>
              <small>连接内容会在运行时自动传给工作流</small>
            </div>
            <button onClick={() => setActiveText(null)}>收起</button>
          </div>
          <div className="composer-references">
            {activeTextSources.length ? (
              activeTextSources.map((source) => (
                <div className="composer-reference" key={source.id}>
                  <small>
                    {typeLabel[source.kind]} · {source.name}
                  </small>
                  {source.kind === "image" && source.src ? (
                    <img src={source.src} alt={source.name} />
                  ) : source.kind === "video" && source.src ? (
                    <video src={source.src} preload="metadata" muted />
                  ) : source.kind === "audio" && source.src ? (
                    <audio src={source.src} controls />
                  ) : (
                    <p>{source.text || source.name}</p>
                  )}
                </div>
              ))
            ) : (
              <div className="composer-empty-reference">
                把图片、视频、音频或另一个文本节点连到这里，参考内容会显示在上方。
              </div>
            )}
            <div className="composer-add-reference">
              <button
                title="从画布添加图片或视频参考"
                onClick={() =>
                  setMediaPickerText(
                    mediaPickerText === activeTextNode.id
                      ? null
                      : activeTextNode.id,
                  )
                }
              >
                ＋ 添加素材
              </button>
              {mediaPickerText === activeTextNode.id && (
                <div className="canvas-media-picker">
                  <b>选择画布素材</b>
                  {canvasMedia.length ? (
                    canvasMedia.map((media) => (
                      <button
                        key={media.id}
                        onClick={() => {
                          linkMediaToText(media.id, activeTextNode.id);
                          setMediaPickerText(null);
                        }}
                      >
                        {media.kind === "image" ? "图片" : "视频"} ·{" "}
                        {media.name}
                      </button>
                    ))
                  ) : (
                    <small>画布中还没有可添加的图片或视频</small>
                  )}
                  <hr />
                  <button
                    className="external-media-option"
                    onClick={() => {
                      setExternalTextTarget(activeTextNode.id);
                      setMediaPickerText(null);
                      textMediaRef.current?.click();
                    }}
                  >
                    ＋ 选择外部图片或视频
                  </button>
                </div>
              )}
            </div>
          </div>
          <BufferedProjectTextarea
            nodeId={activeTextNode.id}
            value={activeTextNode.text || ""}
            onCommit={(text) => change((current) => ({
              ...current,
              nodes: current.nodes.map((node) => node.id === activeTextNode.id ? { ...node, text } : node),
            }))}
          />
        </section>
      )}
      {activeStoryboardNode && (
        <section
          className="storyboard-composer"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="composer-top">
            <div>
              <span>分镜创作</span>
              <b>{activeStoryboardNode.name}</b>
              <small>可填写镜头、画面和台词；选中的图片会自动连线并作为工作流参考。</small>
            </div>
          </div>
          <div className="storyboard-import">
            <textarea
              value={storyboardPaste}
              onChange={(event) => setStoryboardPaste(event.target.value)}
              placeholder="粘贴 Markdown / 表格 / 分镜文字，可自动拆分并填入下方表格"
            />
            <div>
              <button
                onClick={() => fillStoryboardFromText(activeStoryboardNode.id, storyboardPaste)}
                disabled={!storyboardPaste.trim()}
              >
                自动填入表格
              </button>
              <button
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    setStoryboardPaste(text);
                    fillStoryboardFromText(activeStoryboardNode.id, text);
                  } catch {
                    setMessage("无法读取剪贴板，请粘贴到输入框后点击自动填入");
                  }
                }}
              >
                从剪贴板自动填入
              </button>
            </div>
          </div>
          <div className="storyboard-table-wrap">
            <table className="storyboard-table">
              <thead>
                <tr>
                  <th>镜头</th>
                  <th>画面描述</th>
                  <th>台词 / 音效</th>
                  <th>参考图片</th>
                </tr>
              </thead>
              <tbody>
                {(activeStoryboardNode.storyboard || defaultStoryboard()).map(
                  (row, index) => {
                    const image = canvasMedia.find((item) => item.id === row.imageId);
                    return (
                      <tr key={`${activeStoryboardNode.id}-${index}`}>
                        <td>
                          <input
                            value={row.shot}
                            onChange={(event) =>
                              updateStoryboardRow(activeStoryboardNode.id, index, {
                                shot: event.target.value,
                              })
                            }
                            placeholder="1"
                          />
                        </td>
                        <td>
                          <textarea
                            value={row.visual}
                            onChange={(event) =>
                              updateStoryboardRow(activeStoryboardNode.id, index, {
                                visual: event.target.value,
                              })
                            }
                            placeholder="景别、人物、动作、运镜…"
                          />
                        </td>
                        <td>
                          <textarea
                            value={row.dialogue}
                            onChange={(event) =>
                              updateStoryboardRow(activeStoryboardNode.id, index, {
                                dialogue: event.target.value,
                              })
                            }
                            placeholder="对白、旁白或音效…"
                          />
                        </td>
                        <td>
                          <select
                            value={row.imageId || ""}
                            onChange={(event) =>
                              updateStoryboardRow(activeStoryboardNode.id, index, {
                                imageId: event.target.value || undefined,
                              })
                            }
                          >
                            <option value="">不使用图片</option>
                            {canvasMedia
                              .filter((item) => item.kind === "image")
                              .map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.name}
                                </option>
                              ))}
                          </select>
                          {image?.src && (
                            <div
                              className="storyboard-reference-thumb"
                              title="双击放大查看"
                              onDoubleClick={() => setPreviewImage(image)}
                            >
                              <img src={image.src} alt={image.name} />
                              <button
                                title="放大查看"
                                onClick={() => setPreviewImage(image)}
                              >
                                ⌕
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  },
                )}
              </tbody>
            </table>
          </div>
          <button
            className="add-storyboard-row"
            onClick={() => addStoryboardRow(activeStoryboardNode.id)}
          >
            ＋ 添加分镜
          </button>
        </section>
      )}
      <aside className={`recent ${recentOpen ? "open" : ""}`}>
        <button
          className="recent-tab"
          onClick={() => setRecentOpen(!recentOpen)}
        >
          <i className={recent.length ? "has-output" : ""} />
          近期生成 {recentOpen ? "›" : "‹"}
        </button>
        {recentOpen && (
          <div className="recent-body">
            <b>近期生成</b>
            {recent.length ? (
              recent.map((x) => (
                <div
                  key={x.id}
                  className="recent-item"
                  style={{ marginTop: 14, display: "grid", gap: 6 }}
                >
                  {x.kind === "video" ? (
                    <video
                      src={x.src}
                      controls
                      style={{ width: "100%", maxHeight: 160 }}
                    />
                  ) : x.kind === "audio" ? (
                    <audio src={x.src} controls style={{ width: "100%" }} />
                  ) : (
                    <img
                      src={x.src}
                      alt={x.name}
                      style={{
                        width: "100%",
                        maxHeight: 160,
                        objectFit: "contain",
                      }}
                    />
                  )}
                  <span
                    style={{
                      fontSize: 11,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {x.name}
                  </span>
                  <button
                    style={{
                      border: "1px solid #506063",
                      padding: "6px",
                      fontSize: 11,
                    }}
                    onClick={() =>
                      add(
                        x.kind,
                        { x: 420, y: 300 },
                        {
                          name: x.name,
                          src: x.src,
                          localPath: x.localPath,
                          fallbackSrc: x.fallbackSrc,
                          fileName: x.fileName || x.name,
                          mediaWidth: x.mediaWidth,
                          mediaHeight: x.mediaHeight,
                        },
                      )
                    }
                  >
                    放到画布
                  </button>
                </div>
              ))
            ) : (
              <p>
                ComfyUI 的生成结果会放在这里。
                <br />
                手动导入的素材不会提醒。
              </p>
            )}
          </div>
        )}
      </aside>
      {menu && (
        <div
          className="menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {menu.node && menu.node.startsWith("__group_") ? (
            <button className="danger" onClick={() => { const gid = menu.node?.replace("__group_", ""); if (gid) change((p) => ({ ...p, groups: (p.groups || []).filter((g) => g.id !== gid) })); setMenu(null); }}>拆分组别</button>
          ) : menu.node ? (
            <>
              <button
                onClick={() => {
                  copy();
                  setMenu(null);
                }}
              >
                {menu.node === "__selection__" ? "复制所选" : "复制"}
              </button>
              {menu.node === "__selection__" && selected.length > 1 && (
                <button onClick={() => { setGroupNameInput("new"); setMenu(null); }}>打组</button>
              )}
              <button
                onClick={() => {
                  paste();
                  setMenu(null);
                }}
              >
                粘贴节点
              </button>
              {(() => {
                const node = project.nodes.find((item) => item.id === menu.node);
                return node && ["image", "video", "audio"].includes(node.kind) && (node.src || node.localPath) ? (
                  <button
                    onClick={() => {
                      downloadMedia(node);
                      setMenu(null);
                    }}
                  >
                    下载媒体
                  </button>
                ) : null;
              })()}
              {(() => {
                const context = menu.node ? apiGenerationContextFor(menu.node) : null;
                return context ? <>
                  <button onClick={() => modifyApiGeneration(context.target.id)}>修改</button>
                  <button onClick={() => regenerateApiOutput(context.target.id)}>重新生成</button>
                </> : null;
              })()}
              {(() => {
                const target = project.nodes.find((node) => node.id === menu.node);
                const grpForNode = (project.groups || []).find((g) => g.nodeIds.includes(menu.node || "")); if (grpForNode && menu.node !== "__selection__") {
  return <button className="danger" onClick={() => { change((p) => ({ ...p, groups: (p.groups || []).map((g2) => g2.id === grpForNode.id ? { ...g2, nodeIds: g2.nodeIds.filter((id) => id !== menu.node) } : g2).filter((g2) => g2.nodeIds.length > 1) })); setMenu(null); }}>拆分节点</button>;
}
const workflowId = project.links
                  .filter((link) => link.to === menu.node)
                  .map((link) => link.from)
                  .find((id) => project.nodes.find((node) => node.id === id)?.kind === "api");
                return workflowId && target && ["image", "video", "audio"].includes(target.kind) ? (
                  <button
                    onClick={() => {
                      run(workflowId, target.id);
                      setMenu(null);
                    }}
                  >
                    重新生成
                  </button>
                ) : null;
              })()}
              <button
                className="danger"
                onClick={() => {
                  deleteSelected();
                  setMenu(null);
                }}
              >
                {menu.node === "__selection__" ? "删除所选" : "删除"}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  add("text", pastePoint.current || viewportCenter());
                  setMenu(null);
                }}
              >
                文本/提示词
              </button>
              <button
                onClick={() => {
                  add("storyboard", pastePoint.current || viewportCenter());
                  setMenu(null);
                }}
              >
                脚本/分镜
              </button>
              <button
                onClick={() => {
                  add("image", pastePoint.current || viewportCenter());
                  setMenu(null);
                }}
              >
                添加图片
              </button>
              <button
                onClick={() => {
                  add("video", pastePoint.current || viewportCenter());
                  setMenu(null);
                }}
              >
                添加视频
              </button>
              <button
                onClick={() => {
                  add("audio", pastePoint.current || viewportCenter());
                  setMenu(null);
                }}
              >
                添加音频
              </button>
              <button
                onClick={() => {
                  add("batch", pastePoint.current || viewportCenter());
                  setMenu(null);
                }}
              >
                批量收集
              </button>
              <button
                onClick={() => {
                  setApiPoint(pastePoint.current || viewportCenter());
                  apiRef.current?.click();
                  setMenu(null);
                }}
              >
                导入 API 工作流
              </button>
              <button
                onClick={() => {
                  const position = pastePoint.current || viewportCenter();
                  const text = "情绪转折点。\n冷静的表象下是汹涌的告别。";
                  const { width, height } = annotationMetrics(text, 250);
                  const annotationId = newId();
                  const pointerId = newId();
                  change((project) => ({
                    ...project,
                    nodes: [
                      ...project.nodes,
                      { id: annotationId, kind: "annotation", x: position.x, y: position.y, width, height, name: "镜头批注", text, rotation: -8, pointerId, createdAt: Date.now() },
                      { id: pointerId, kind: "annotationPointer", x: position.x + width - 18, y: position.y + height - 20, width: 58, height: 58, name: "批注指向", rotation: -8, annotationId, createdAt: Date.now() },
                    ],
                  }));
                  setMenu(null);
                }}
              >
                添加镜头批注
              </button>
              <hr />
              <button
                onClick={() => {
                  paste();
                  setMenu(null);
                }}
              >
                粘贴
              </button>
            </>
          )}
        </div>
      )}
      {linkAddMenu && (
        <div
          className="menu link-add-menu"
          style={{ left: linkAddMenu.x, top: linkAddMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <small>松开后添加并自动连线</small>
          <button onClick={() => addLinkedNode("image")}>添加图片</button>
          <button onClick={() => addLinkedNode("video")}>添加视频</button>
          <button onClick={() => addLinkedNode("audio")}>添加音频</button>
          <button onClick={() => addLinkedNode("text")}>添加文本</button>
          <button onClick={() => setLinkAddMenu(null)}>取消</button>
        </div>
      )}
      {disconnectMenu && (
        <div
          className="menu"
          style={{ left: disconnectMenu.x, top: disconnectMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <b
            style={{
              display: "block",
              padding: "7px 10px",
              fontSize: 11,
              color: "#aebbbb",
            }}
          >
            选择要断开的线路
          </b>
          {project.links
            .filter((link) => link.to === disconnectMenu.target)
            .map((link) => (
              <button
                key={link.id}
                className="danger"
                onClick={() => {
                  change((p) => ({
                    ...p,
                    links: p.links.filter((item) => item.id !== link.id),
                  }));
                  setDisconnectMenu(null);
                  setMessage("线路已断开");
                }}
              >
                断开：
                {project.nodes.find((node) => node.id === link.from)?.name ||
                  "来源节点"}
              </button>
          ))}
        </div>
      )}
      {activeAiNodeItem && !activeOnlineVideoNode && (
        <AiGenerationComposer
          node={activeAiNodeItem as NodeItem & { kind: "aiText" | "aiImage" | "text" | "image" }}
          referenceImages={activeAiReferences}
          linkedTextInputs={activeAiLinkedTextInputs}
          canvasImages={canvasAiImages}
          onUpdate={(workflow) => change((current) => ({
            ...current,
            nodes: current.nodes.map((node) => node.id === activeAiNodeItem.id ? { ...node, workflow } : node),
          }))}
          onGenerate={() => void generateAiNode(activeAiNodeItem)}
          onClose={() => setActiveAiNode(null)}
          onOpenWorkflowLibrary={() => setWorkflowLibraryOpen(true)}
          onDescribeImage={(image) => describeAiTextImage(activeAiNodeItem, image)}
          onImportReference={(file) => importAiReference(activeAiNodeItem.id, file)}
          onRemoveReference={(reference) => removeAiReference(activeAiNodeItem.id, reference)}
          providerOptions={activeAiNodeItem.kind === "aiText" || activeAiNodeItem.kind === "text" ? textProviderOptions : imageProviderOptions}
          onOpenApiConfiguration={() => {
            const workflow = (activeAiNodeItem.workflow || {}) as AiTextSettings & AiImageSettings;
            if (activeAiNodeItem.kind === "aiText" || activeAiNodeItem.kind === "text") {
              requestAiTextProviderConfiguration(workflow.provider || "OpenAI");
              return;
            }
            openOnlineConfiguration("byok", workflow.provider || "OpenAI", "image");
            setMessage("先保存图片平台的接口地址、API Key 和模型；保存后会直接出现在这个图片节点。 ");
          }}
          onOpenPromptLibrary={() => setPromptLibraryTarget({ nodeId: activeAiNodeItem.id, kind: "ai" })}
        />
      )}
      {activeComfyApiNode && isComfyCanvasWorkflow(activeComfyApiNode.workflow) && (() => {
        const workflow = activeComfyApiNode.workflow;
        const visibleParameters = workflow.parameters.filter((parameter) => parameter.enabled && isBasicComfyParameter(parameter));
        const latestDiagnostics = comfyDiagnostics[activeComfyApiNode.id] || [];
        const latestErrors = latestDiagnostics.filter((diagnostic) => diagnostic.level === "error");
        const updatePackage = (next: ComfyCanvasWorkflow) => change((project) => ({ ...project, nodes: project.nodes.map((node) => node.id === activeComfyApiNode.id ? { ...node, workflow: next } : node) }));
        return <section className="comfy-node-parameter-panel" onPointerDown={(event) => event.stopPropagation()}>
          <header><div><span>COMFYUI WORKFLOW</span><b>{activeComfyApiNode.name}</b><small>参数只保存在当前画布节点；运行时写入工作流副本</small></div><button onClick={() => setActiveApiConfig(null)}>×</button></header>
          <div className="comfy-node-parameter-toolbar">
            <button className="active">基础参数 {visibleParameters.length}</button>
            <small>这里只保留日常生成需要调整的项目</small>
            <button onClick={() => setWorkflowLibraryOpen(true)}>高级参数到工作流库修改 ↗</button>
          </div>
          <div className="comfy-node-parameter-grid basic">{visibleParameters.length ? visibleParameters.map((parameter) => <label title={comfyParameterHelp(parameter)} className="enabled" key={parameter.id}>
            <span><b>{parameter.label} <i className="comfy-help">?</i></b><small>{parameter.nodeTitle} · {parameter.input}</small></span>
            {parameter.kind === "boolean" ? <select value={String(workflow.values[parameter.id] ?? parameter.value)} onChange={(event) => updatePackage({ ...workflow, values: { ...workflow.values, [parameter.id]: event.target.value === "true" } })}><option value="true">开启</option><option value="false">关闭</option></select>
              : <input type={parameter.kind === "number" ? "number" : "text"} value={String(workflow.values[parameter.id] ?? parameter.value)} onChange={(event) => updatePackage({ ...workflow, values: { ...workflow.values, [parameter.id]: parameter.kind === "number" ? Number(event.target.value) : event.target.value } })} />}
          </label>) : <div className="comfy-node-parameter-empty">没有扫描到可编辑输入。请确认添加的是 ComfyUI API JSON；Workflow JSON 需要先在工作流库连接 ComfyUI并扫描转换。</div>}</div>
          {latestDiagnostics.length > 0 && <section className={`comfy-parameter-diagnostics ${latestErrors.length ? "has-errors" : ""}`}>
            <header><div><b>{latestErrors.length ? `${latestErrors.length} 项运行前错误` : "最近一次自动适配"}</b><small>来自当前连接的 ComfyUI object_info；修复后点击运行会重新扫描，不会沿用旧节点 ID。</small></div><button onClick={() => { setComfyDiagnostics((current) => ({ ...current, [activeComfyApiNode.id]: [] })); change((project) => ({ ...project, nodes: project.nodes.map((node) => node.id === activeComfyApiNode.id ? { ...node, validationErrors: withoutComfyValidationErrors(node.validationErrors) } : node) })); }}>清除记录</button></header>
            <div>{latestDiagnostics.map((diagnostic, index) => {
              const location = comfyDiagnosticLocation(diagnostic);
              const type = diagnostic.expectedType || diagnostic.actualType;
              return <article key={`${activeComfyApiNode.id}-${diagnostic.code || "diagnostic"}-${index}`} className={diagnostic.level}>
                <b>{comfyDiagnosticTitle(diagnostic)}</b>
                {location && <span>{location}</span>}
                {type && <em>期望 {diagnostic.expectedType || "—"} / 实际 {diagnostic.actualType || "—"}</em>}
                <p>{diagnostic.message}</p>
                {diagnostic.level !== "info" && <small>如何修复：{comfyDiagnosticRepair(diagnostic)}</small>}
              </article>;
            })}</div>
          </section>}
          <footer><span>{comfyConnected ? "● 本地 ComfyUI 已连接" : "○ 本地 ComfyUI 未连接"}</span><button onClick={() => void autoConnect()}>检测连接</button><button className="primary" onClick={() => void run(activeComfyApiNode.id)}>运行工作流</button></footer>
        </section>;
      })()}
      <WorkflowLibrary
        open={workflowLibraryOpen}
        onClose={() => setWorkflowLibraryOpen(false)}
        apiUrl={apiUrl}
        onAddToCanvas={(workflow, name, item) => {
          const packaged: ComfyCanvasWorkflow = {
            __ymComfyPackage: true,
            libraryId: item.id,
            content: workflow,
            parameters: item.parameters?.length ? item.parameters : scanComfyParameters(workflow),
            values: {},
            interface: item.interface,
          };
          addAtViewport("api", { name, workflow: packaged });
          setWorkflowLibraryOpen(false);
          setMessage(`已从工作流库添加：${name}`);
        }}
      />
      <MediaLibrary key={`media-library-${historyId}`}
        open={mediaLibraryOpen}
        onClose={() => setMediaLibraryOpen(false)}
        nodes={project.nodes.filter((node): node is NodeItem & { kind: Exclude<Kind, "annotation" | "annotationPointer"> } => node.kind !== "annotation" && node.kind !== "annotationPointer")}
        onDeleteNode={(id) => deleteCanvasNodes([id])}
        onRenameNode={(id, name) => change((p) => ({ ...p, nodes: p.nodes.map((n) => n.id === id ? { ...n, name } : n) }))}
        onAddNode={(kind, pos, extra) => {
          const id = newId();
          const [w, h] = nodeSize[kind];
          change((p) => ({ ...p, nodes: [...p.nodes, { id, kind, x: pos.x, y: pos.y, width: w, height: h, name: extra?.name as string || typeLabel[kind], src: extra?.src as string | undefined, text: extra?.text as string | undefined, storyboard: extra?.storyboard as any, fileName: extra?.fileName as string | undefined, localPath: extra?.localPath as string | undefined, mediaWidth: extra?.mediaWidth as number | undefined, mediaHeight: extra?.mediaHeight as number | undefined, createdAt: Date.now() } as NodeItem] }));
        }}
        onNavigateTo={navigateTo}
        viewportCenter={viewportCenter}
      />
      <DirectorMode
        key={`director-mode-${historyId}`}
        projectId={historyId}
        open={directorOpen}
        onClose={() => setDirectorOpen(false)}
        nodes={project.nodes.filter((node): node is NodeItem & { kind: Exclude<Kind, "annotation" | "annotationPointer"> } => node.kind !== "annotation" && node.kind !== "annotationPointer")}
        onImportFiles={(files) => {
          const center = viewportCenter();
          files.forEach((file, index) => addDroppedMedia(file, { x: center.x + index * 34, y: center.y + index * 34 }));
        }}
      />
      {groupNameInput && (
        <div className="grp-name-overlay" onPointerDown={() => setGroupNameInput(null)}>
          <div className="grp-name-box" onPointerDown={(e) => e.stopPropagation()}>
            <b>{groupNameInput === "new" ? "分组名称" : "重新命名分组"}</b>
            <input className="grp-name-input" placeholder="输入名称..." defaultValue={groupNameInput === "new" ? "" : (project.groups || []).find((g) => g.id === groupNameInput)?.name || ""} autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.target as HTMLInputElement).value.trim()) {
                  const nn = (e.target as HTMLInputElement).value.trim();
                  if (groupNameInput === "new") change((p) => { const sn = p.nodes.filter((x) => selected.includes(x.id)); const xs = sn.map((x) => x.x), ys = sn.map((x) => x.y), xe = sn.map((x) => x.x + x.width), ye = sn.map((x) => x.y + x.height); return { ...p, groups: [...(p.groups || []), { id: groupNewId(), name: nn, nodeIds: [...selected], bounds: { x: Math.min(...xs) - 12, y: Math.min(...ys) - 12, w: Math.max(...xe) - Math.min(...xs) + 24, h: Math.max(...ye) - Math.min(...ys) + 24 } }] }; });
                  else { const gid = groupNameInput; change((p) => ({ ...p, groups: (p.groups || []).map((g) => g.id === gid ? { ...g, name: nn } : g) })); }
                  setGroupNameInput(null);
                }
                if (e.key === "Escape") setGroupNameInput(null);
              }}
            />
          </div>
        </div>
      )}
      {promptLibraryTarget && (() => {
        const categories = ["全部", "正面提示词", "负面提示词", ...Array.from(new Set(promptLibraryEntries.map((entry) => entry.category).filter(Boolean)))];
        const visible = promptLibraryEntries.filter((entry) =>
          (promptLibraryFilter === "全部" || entry.category === promptLibraryFilter)
          && `${entry.text} ${entry.category}`.toLowerCase().includes(promptLibrarySearch.trim().toLowerCase()),
        );
        const addEntry = () => {
          const text = promptLibraryText.trim();
          if (!text) return;
          const category = promptLibraryCategory.trim() || "未分类";
          const existing = promptLibraryEntries.find((entry) => entry.text === text && entry.category === category);
          savePromptLibrary([existing || { id: newId(), text, category, createdAt: Date.now() }, ...promptLibraryEntries.filter((entry) => entry !== existing)]);
          setPromptLibraryText("");
          setPromptLibraryFilter(category);
        };
        return <div className="prompt-library-overlay" onPointerDown={(event) => { event.stopPropagation(); setPromptLibraryTarget(null); }}>
          <section className="prompt-library-dialog" onPointerDown={(event) => event.stopPropagation()}>
            <header><div><span>提示词库</span><b>收集、搜索并插入提示词</b><small>选择一条内容会写入当前 {promptLibraryTarget.kind === "video" ? "视频" : "创作"} 节点的提示词。</small></div><button title="关闭" onClick={() => setPromptLibraryTarget(null)}>×</button></header>
            <div className="prompt-library-compose">
              <textarea value={promptLibraryText} onChange={(event) => setPromptLibraryText(event.target.value)} placeholder="记录提示词：人物、画面、动作、镜头、风格或负面限制…" />
              <div><input list="prompt-library-categories" value={promptLibraryCategory} onChange={(event) => setPromptLibraryCategory(event.target.value)} placeholder="分类，例如：正面提示词" /><datalist id="prompt-library-categories"><option value="正面提示词"/><option value="负面提示词"/><option value="镜头语言"/><option value="人物设定"/><option value="场景氛围"/></datalist><button className="primary" disabled={!promptLibraryText.trim()} onClick={addEntry}>保存到词库</button></div>
            </div>
            <div className="prompt-library-toolbar"><input value={promptLibrarySearch} onChange={(event) => setPromptLibrarySearch(event.target.value)} placeholder="搜索提示词或分类…" /> <div>{categories.map((category) => <button key={category} className={promptLibraryFilter === category ? "active" : ""} onClick={() => setPromptLibraryFilter(category)}>{category}</button>)}</div></div>
            {promptLibraryFilter !== "全部" && <div className="prompt-library-rename"><span>当前分类：{promptLibraryFilter}</span><input value={promptLibraryCategory} onChange={(event) => setPromptLibraryCategory(event.target.value)} placeholder="输入新的分类名称"/><button onClick={() => { const renamed = promptLibraryCategory.trim(); if (!renamed || renamed === promptLibraryFilter) return; savePromptLibrary(promptLibraryEntries.map((entry) => entry.category === promptLibraryFilter ? { ...entry, category: renamed } : entry)); setPromptLibraryFilter(renamed); }}>重命名分类</button></div>}
            <div className="prompt-library-list">{visible.length ? visible.map((entry) => <article key={entry.id}><button className="prompt-library-insert" title="写入当前节点提示词" onClick={() => insertPromptLibraryEntry(entry)}><b>{entry.category}</b><span>{entry.text}</span></button><button title="删除此提示词" className="danger" onClick={() => savePromptLibrary(promptLibraryEntries.filter((item) => item.id !== entry.id))}>×</button></article>) : <p>没有找到提示词。可先在上方输入内容并选择分类保存。</p>}</div>
          </section>
        </div>;
      })()}
    </main>
  );
}
