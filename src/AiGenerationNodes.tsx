import { startTransition, useEffect, useRef, useState, type RefObject } from "react";
import { comfyParameterHelp, isBasicComfyParameter, readComfyWorkflowLibrary } from "./ComfyWorkflowParameters";
import { cloudModelsFor, cloudPlatformsFor, defaultCloudModel, estimateCloudPoints, type CloudModelKind } from "./CloudModelCatalog";
import { imageCapabilitiesFor, type ImageAspectRatio, type ImageQuality, type ImageResolution } from "./core/providers/imageCapabilities";
import { createStoryboardFramePlan, normalizeStoryboardFramePlans, type StoryboardFramePlan } from "./core/storyboard/generation";

export const AI_TEXT_PROVIDER_PRESETS = {
  OpenAI: {
    endpoint: "https://api.openai.com/v1",
    models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
    defaultModel: "gpt-4.1-mini",
    visionModel: "gpt-4.1-mini",
  },
  "阿里百炼·通义千问": {
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-plus", "qwen-max", "qwen-turbo"],
    defaultModel: "qwen-plus",
    visionModel: "qwen-vl-plus",
  },
  MiniMax: {
    endpoint: "https://api.minimax.chat/v1",
    models: ["MiniMax-Text-01"],
    defaultModel: "MiniMax-Text-01",
    visionModel: "MiniMax-VL-01",
  },
  "Ollama（本地）": {
    endpoint: "http://127.0.0.1:11434",
    models: [],
    defaultModel: "",
    visionModel: "",
  },
} as const;

export const AI_IMAGE_PROVIDER_PRESETS = {
  OpenAI: {
    models: ["gpt-image-1", "gpt-image-1-mini"],
    defaultModel: "gpt-image-1",
  },
  "Google Nano Banana": {
    models: ["gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-3-pro-image", "gemini-2.5-flash-image"],
    defaultModel: "gemini-3.1-flash-image",
  },
  "Pollinations（免费测试）": {
    models: ["flux"],
    defaultModel: "flux",
  },
  "Midjourney（手动命令）": {
    models: ["V8.1"],
    defaultModel: "V8.1",
  },
} as const;

export type AiReferenceImage = {
  id: string;
  name: string;
  src: string;
  /**
   * Optional filesystem-backed asset location. `src` remains the displayable
   * URL/data URL used by the UI, while the host can use this durable path when
   * it persists references outside the canvas JSON.
   */
  localPath?: string;
  description?: string;
};

export type AiTextSettings = {
  source?: "comfy" | "byok" | "cloud";
  provider?: string;
  model?: string;
  prompt?: string;
  genre?: string;
  format?: string;
  length?: string;
  tone?: string;
  audience?: string;
  language?: string;
  creativity?: number;
  episodeCount?: number;
  episodeMinutes?: number;
  includeStoryboard?: boolean;
  includeCharacters?: boolean;
  outputMode?: "script" | "storyboardFrames";
  storyboardRatio?: string;
  storyboardStyle?: string;
  storyboardFrames?: StoryboardFramePlan[];
  references?: AiReferenceImage[];
  comfyWorkflowId?: string;
  comfyValues?: Record<string, string | number | boolean>;
};

export type AiImageSettings = {
  source?: "comfy" | "byok" | "cloud";
  provider?: string;
  model?: string;
  mode?: "text" | "image";
  prompt?: string;
  negativePrompt?: string;
  ratio?: string;
  resolution?: string;
  amount?: number;
  quality?: string;
  style?: string;
  seed?: number;
  guidance?: number;
  references?: AiReferenceImage[];
  comfyWorkflowId?: string;
  comfyValues?: Record<string, string | number | boolean>;
};

export type AiProviderOption = {
  name: string;
  models: string[];
  defaultModel: string;
};

type ComposerAsyncSession = {
  nodeId: string;
  active: boolean;
};

function BufferedAiPrompt({
  inputRef,
  value,
  onCommit,
  onDraft,
  placeholder,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onCommit: (value: string) => void;
  onDraft: (value: string, caret: number) => void;
  placeholder: string;
}) {
  const timerRef = useRef<number | null>(null);
  const idleRef = useRef<number | null>(null);
  const committed = useRef(value);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  useEffect(() => {
    committed.current = value;
    const field = inputRef.current;
    if (field && document.activeElement !== field && field.value !== value) field.value = value;
  }, [inputRef, value]);
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
    const next = inputRef.current?.value ?? committed.current;
    if (next === committed.current) return;
    committed.current = next;
    commitRef.current(next);
  };
  const queueCommit = () => {
    cancelScheduledCommit();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const commitWhenIdle = () => {
        idleRef.current = null;
        const next = inputRef.current?.value ?? committed.current;
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
  useEffect(() => () => flush(), []);
  return <textarea
    ref={inputRef}
    className="ai-console-prompt"
    autoFocus
    defaultValue={value}
    onInput={(event) => {
      const field = event.currentTarget;
      onDraft(field.value, field.selectionStart ?? field.value.length);
      queueCommit();
    }}
    onBlur={flush}
    placeholder={placeholder}
  />;
}

type AiNode = {
  id: string;
  kind: "aiText" | "aiImage" | "text" | "image";
  name: string;
  text?: string;
  src?: string;
  workflow?: unknown;
  status?: string;
};

export function AiGenerationNodeView({ node, onOpen }: { node: AiNode; onOpen: () => void }) {
  const isText = node.kind === "aiText" || node.kind === "text";
  const isStoryboardFrames = isText && (node.workflow as AiTextSettings | undefined)?.outputMode === "storyboardFrames";
  return <button className={`ai-generation-node ${isText ? "script" : "picture"}`} onClick={onOpen}>
    {node.src && !isText ? <img src={node.src} alt={node.name} /> : <div className="ai-generation-node-empty">
      <span>{isText ? "文" : "图"}</span>
      <b>{isText ? isStoryboardFrames ? "AI 分镜画面" : "AI 剧本生成" : "AI 图片生成"}</b>
      <small>{isText ? isStoryboardFrames ? "生成一个或多个可编辑画面" : "输入创意，生成完整剧本" : "支持文生图与图生图"}</small>
    </div>}
    {node.status === "running" && <i className="ai-generation-running">生成中…</i>}
  </button>;
}

export function AiGenerationComposer({
  node,
  referenceImages,
  linkedTextInputs = [],
  onUpdate,
  onGenerate,
  onClose,
  onOpenWorkflowLibrary,
  canvasImages,
  onDescribeImage,
  onImportReference,
  onRemoveReference,
  providerOptions,
  onOpenApiConfiguration,
  onOpenPromptLibrary,
}: {
  node: AiNode;
  referenceImages: Array<{ id: string; name: string; src: string }>;
  /** Text/storyboard content connected into this node and merged at submit. */
  linkedTextInputs?: string[];
  canvasImages: AiReferenceImage[];
  onUpdate: (patch: Record<string, unknown>) => void;
  onGenerate: () => void;
  onClose: () => void;
  onOpenWorkflowLibrary: () => void;
  onDescribeImage: (image: AiReferenceImage) => Promise<string>;
  /**
   * Optional host-owned reference importer. When supplied, the composer does
   * not create a Data URL itself; the host can persist the file and return a
   * reference whose `src` is safe for immediate preview and whose `localPath`
   * points at the durable asset. Rejecting the promise leaves the node intact.
   */
  onImportReference?: (file: File) => Promise<AiReferenceImage>;
  /** Removes both a stored reference and any canvas link that supplies it. */
  onRemoveReference?: (reference: AiReferenceImage) => void;
  providerOptions?: AiProviderOption[];
  /** Opens the host-owned API settings for this node capability. */
  onOpenApiConfiguration?: () => void;
  /** Opens the host-owned prompt collection and inserts into this node. */
  onOpenPromptLibrary?: () => void;
}) {
  const [parametersOpen, setParametersOpen] = useState(false);
  const [sourceSettingsOpen, setSourceSettingsOpen] = useState(false);
  const [canvasPickerOpen, setCanvasPickerOpen] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [describing, setDescribing] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [recognitionError, setRecognitionError] = useState<string | null>(null);
  const [referenceImportStatus, setReferenceImportStatus] = useState<string | null>(null);
  const [recognition, setRecognition] = useState<{
    image: AiReferenceImage;
    index: number;
    content: string;
  } | null>(null);
  const localImageRef = useRef<HTMLInputElement>(null);
  // A composer can remain mounted while the selected canvas node changes. Capture
  // the session that started an async operation so a late FileReader/vision result
  // cannot update the newly selected node.
  const asyncSessionRef = useRef<ComposerAsyncSession>({ nodeId: node.id, active: true });
  if (asyncSessionRef.current.nodeId !== node.id) {
    asyncSessionRef.current = { nodeId: node.id, active: true };
  }
  useEffect(() => {
    asyncSessionRef.current.active = true;
    return () => {
      asyncSessionRef.current.active = false;
    };
  }, []);
  useEffect(() => {
    // Local async UI belongs to the node that opened the composer, not the node
    // selected after it. The callback guards below handle the same transition.
    setCanvasPickerOpen(false);
    setMentionOpen(false);
    setDescribing(false);
    setRecognition(null);
    setRecognitionError(null);
    setReferenceImportStatus(null);
  }, [node.id]);
  const isCurrentAsyncSession = (session: ComposerAsyncSession) => (
    session.active && asyncSessionRef.current === session
  );
  const isText = node.kind === "aiText" || node.kind === "text";
  const storedText = (node.workflow || {}) as AiTextSettings;
  const text = {
    source: "byok", model: "gpt-4.1-mini", prompt: "",
    genre: "剧情短片", format: "标准影视剧本", length: "中篇", tone: "电影感",
    audience: "大众", language: "简体中文", creativity: 0.8, episodeCount: 1,
    episodeMinutes: 5, includeStoryboard: true, includeCharacters: true, outputMode: "script",
    storyboardRatio: "16:9", storyboardStyle: "电影写实",
    ...storedText,
    storyboardFrames: normalizeStoryboardFramePlans(storedText.storyboardFrames),
    provider: storedText.provider === "OpenAI 兼容" ? "OpenAI" : storedText.provider || "OpenAI",
  };
  const storedImage = (node.workflow || {}) as AiImageSettings;
  const image = {
    source: "byok", provider: "OpenAI", model: "gpt-image-1",
    mode: referenceImages.length || storedImage.references?.length ? "image" : "text", prompt: "", negativePrompt: "",
    ratio: "1:1", resolution: "1024", amount: 1, quality: "low", style: "电影写实", seed: -1, guidance: 7,
    ...storedImage,
  };
  const imageCapabilities = imageCapabilitiesFor(image.provider, image.model);
  // Keep the composer universal. Provider/model capabilities are shown as a
  // status hint and checked before a request, rather than shrinking the whole
  // editor to two options whenever a model has an incomplete profile.
  const imageRatios: readonly ImageAspectRatio[] = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "7:4", "4:7", "9:16", "16:9", "21:9"];
  const universalImageSizes: Record<ImageAspectRatio, readonly string[]> = {
    "1:1": ["512x512", "768x768", "1024x1024", "1536x1536", "2048x2048"],
    "2:3": ["512x768", "768x1152", "1024x1536", "1365x2048"], "3:2": ["768x512", "1152x768", "1536x1024", "2048x1365"],
    "3:4": ["576x768", "768x1024", "960x1280", "1536x2048"], "4:3": ["768x576", "1024x768", "1280x960", "2048x1536"],
    "4:5": ["640x800", "768x960", "1024x1280", "1638x2048"], "5:4": ["800x640", "960x768", "1280x1024", "2048x1638"],
    "7:4": ["896x512", "1120x640", "1400x800", "1792x1024"], "4:7": ["512x896", "640x1120", "800x1400", "1024x1792"],
    "9:16": ["512x896", "576x1024", "720x1280", "864x1536", "1080x1920", "1152x2048"], "16:9": ["896x512", "1024x576", "1280x720", "1536x864", "1920x1080", "2048x1152"],
    "21:9": ["896x384", "1344x576", "1792x768", "2048x878"],
  };
  const resolutionsForRatio = (ratio: string) => {
    return universalImageSizes[ratio as ImageAspectRatio] || universalImageSizes["1:1"];
  };
  const imageResolutionLabel = (resolution: string) => {
    if (/^\d{2,5}x\d{2,5}$/i.test(resolution)) return resolution.replace("x", " × ");
    const value = Number(resolution);
    return Number.isFinite(value) && value >= 1024 ? `${Math.round(value / 1024)}K` : Number.isFinite(value) ? `${resolution}px` : resolution;
  };
  const imageResolutions = resolutionsForRatio(image.ratio);
  const normalizeImageSelection = (provider: string, model: string, patch: Record<string, unknown> = {}) => {
    const requestedRatio = String(patch.ratio ?? image.ratio) as ImageAspectRatio;
    const ratio = imageRatios.includes(requestedRatio) ? requestedRatio : imageRatios[0];
    const resolutions = resolutionsForRatio(ratio);
    const requestedResolution = String(patch.resolution ?? image.resolution) as ImageResolution;
    const resolution = resolutions.includes(requestedResolution) ? requestedResolution : resolutions[0];
    const requestedAmount = Number(patch.amount ?? image.amount);
    const amount = Number.isFinite(requestedAmount) ? Math.min(5, Math.max(1, Math.trunc(requestedAmount))) : 1;
    const quality = String(patch.quality ?? image.quality ?? "") as ImageQuality;
    return { ...patch, provider, model, ratio, resolution, amount, quality };
  };
  const config = isText ? text : image;
  const isStoryboardFrames = isText && text.outputMode === "storyboardFrames";
  const availableProviders = providerOptions !== undefined ? providerOptions : isText
    ? Object.entries(AI_TEXT_PROVIDER_PRESETS).map(([name, preset]) => ({ name, models: [...preset.models], defaultModel: preset.defaultModel }))
    : Object.entries(AI_IMAGE_PROVIDER_PRESETS).map(([name, preset]) => ({ name, models: [...preset.models], defaultModel: preset.defaultModel }));
  const selectedProvider = availableProviders.find((item) => item.name === config.provider) || availableProviders[0];
  const availableModels = selectedProvider?.models || [];
  // A local ComfyUI source is not an API configuration.  Keep the button
  // honest: it reports configuration only when this node type has a saved API.
  const hasSavedApiProvider = availableProviders.some((item) => item.name === config.provider);
  const hasUsableProvider = config.source === "comfy" || hasSavedApiProvider;
  const update = (patch: Record<string, unknown>, session = asyncSessionRef.current) => {
    if (!isCurrentAsyncSession(session)) return;
    onUpdate({ ...config, ...patch });
  };
  const updateStoryboardFrame = (index: number, patch: Partial<StoryboardFramePlan>) => {
    const frames = text.storyboardFrames.map((frame, frameIndex) => frameIndex === index ? { ...frame, ...patch } : frame);
    update({ storyboardFrames: frames });
  };
  const addStoryboardFrame = () => {
    if (text.storyboardFrames.length >= 24) return;
    update({ storyboardFrames: [...text.storyboardFrames, createStoryboardFramePlan(text.storyboardFrames.length)] });
  };
  const removeStoryboardFrame = (index: number) => {
    if (text.storyboardFrames.length <= 1) return;
    update({ storyboardFrames: text.storyboardFrames.filter((_, frameIndex) => frameIndex !== index) });
  };
  const cloudKind: CloudModelKind = isText ? "text" : "image";
  const cloudPlatforms = cloudPlatformsFor(cloudKind);
  const cloudPlatform = cloudPlatforms.includes(config.provider || "") ? config.provider! : cloudPlatforms[0];
  const cloudModels = cloudModelsFor(cloudKind, cloudPlatform);
  const cloudModel = cloudModels.find((model) => model.id === config.model) || defaultCloudModel(cloudKind, cloudPlatform);
  const textReferences = [
    ...(text.references || []),
    ...referenceImages.filter((item) => !(text.references || []).some((reference) => reference.id === item.id)),
  ];
  const imageReferences = [
    ...(image.references || []),
    ...referenceImages.filter((item) => !(image.references || []).some((reference) => reference.id === item.id)),
  ];
  const insertImageMention = (index: number) => {
    const textarea = promptRef.current;
    const value = textarea?.value ?? image.prompt;
    const selectionStart = textarea?.selectionStart ?? value.length;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;
    const beforeSelection = value.slice(0, selectionStart);
    const partialMention = beforeSelection.match(/@[^\s，。；、,.!?]*$/);
    const replaceStart = partialMention ? selectionStart - partialMention[0].length : selectionStart;
    const leadingSpace = !partialMention && replaceStart > 0 && !/\s/.test(value[replaceStart - 1]) ? " " : "";
    const suffix = value.slice(selectionEnd);
    const trailingSpace = suffix && /^\s/.test(suffix) ? "" : " ";
    const inserted = `${leadingSpace}@图片${index + 1}${trailingSpace}`;
    const prompt = `${value.slice(0, replaceStart)}${inserted}${suffix}`;
    const nextCaret = replaceStart + inserted.length;
    update({ prompt, mode: "image" });
    if (textarea) textarea.value = prompt;
    setMentionOpen(false);
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };
  const cloudEstimate = config.source === "cloud" ? estimateCloudPoints(cloudKind, cloudModel?.id, isText ? {
    promptLength: text.prompt.length,
    references: textReferences.length,
    episodeCount: isStoryboardFrames ? text.storyboardFrames.length : text.episodeCount,
    episodeMinutes: text.episodeMinutes,
  } : {
    promptLength: image.prompt.length,
    references: imageReferences.length,
    amount: image.amount,
    resolution: image.resolution,
  }) : null;
  const attachTextReference = (image: AiReferenceImage, session = asyncSessionRef.current) => {
    if (!isCurrentAsyncSession(session)) return;
    setCanvasPickerOpen(false);
    if (textReferences.some((item) => item.id === image.id)) return;
    update({ references: [...textReferences, image] }, session);
  };
  const importTextReference = (file?: File) => {
    if (!file) return;
    const session = asyncSessionRef.current;
    setReferenceImportStatus(null);
    if (onImportReference) {
      setReferenceImportStatus("正在保存参考图片…");
      void onImportReference(file).then((reference) => {
        if (!isCurrentAsyncSession(session)) return;
        if (!reference || !reference.id || !reference.name || !reference.src) {
          setReferenceImportStatus("参考图片导入失败：存储服务没有返回可预览图片。");
          return;
        }
        attachTextReference(reference, session);
        if (isCurrentAsyncSession(session)) setReferenceImportStatus(null);
      }).catch((error) => {
        if (!isCurrentAsyncSession(session)) return;
        const detail = String(error).replace(/^Error: /, "").trim();
        setReferenceImportStatus(`参考图片导入失败：${detail || "请重试。"}`);
      });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (!isCurrentAsyncSession(session)) return;
      const src = String(reader.result || "");
      if (!src) {
        setReferenceImportStatus("参考图片读取失败，请重试。");
        return;
      }
      attachTextReference({
        id: `local-${Date.now()}-${file.name}`,
        name: file.name,
        src,
      }, session);
    };
    reader.onerror = () => {
      if (isCurrentAsyncSession(session)) setReferenceImportStatus("参考图片读取失败，请重试。");
    };
    reader.readAsDataURL(file);
  };
  const recognizeMentionedImage = async (reference: AiReferenceImage, index: number) => {
    const session = asyncSessionRef.current;
    if (describing || !isCurrentAsyncSession(session)) return;
    setRecognitionError(null);
    setDescribing(true);
    try {
      const description = await onDescribeImage(reference);
      if (!isCurrentAsyncSession(session)) return;
      setRecognition({ image: reference, index, content: description.trim() });
      setMentionOpen(false);
    } catch (error) {
      if (!isCurrentAsyncSession(session)) return;
      setRecognitionError(String(error).replace(/^Error:\s*/, ""));
      setMentionOpen(true);
    } finally {
      if (isCurrentAsyncSession(session)) setDescribing(false);
    }
  };
  const attachImageReference = (reference: AiReferenceImage, session = asyncSessionRef.current) => {
    if (!isCurrentAsyncSession(session)) return;
    const references = imageReferences.some((item) => item.id === reference.id)
      ? imageReferences
      : [...imageReferences, reference];
    update({ references, mode: "image" }, session);
    setCanvasPickerOpen(false);
  };
  const importImageReference = (file?: File) => {
    if (!file) return;
    const session = asyncSessionRef.current;
    setReferenceImportStatus(null);
    if (onImportReference) {
      setReferenceImportStatus("正在保存参考图片…");
      void onImportReference(file).then((reference) => {
        if (!isCurrentAsyncSession(session)) return;
        if (!reference || !reference.id || !reference.name || !reference.src) {
          setReferenceImportStatus("参考图片导入失败：存储服务没有返回可预览图片。");
          return;
        }
        attachImageReference(reference, session);
        if (isCurrentAsyncSession(session)) setReferenceImportStatus(null);
      }).catch((error) => {
        if (!isCurrentAsyncSession(session)) return;
        const detail = String(error).replace(/^Error: /, "").trim();
        setReferenceImportStatus(`参考图片导入失败：${detail || "请重试。"}`);
      });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (!isCurrentAsyncSession(session)) return;
      const src = String(reader.result || "");
      if (!src) {
        setReferenceImportStatus("参考图片读取失败，请重试。");
        return;
      }
      attachImageReference({
        id: `local-${Date.now()}-${file.name}`,
        name: file.name,
        src,
      }, session);
    };
    reader.onerror = () => {
      if (isCurrentAsyncSession(session)) setReferenceImportStatus("参考图片读取失败，请重试。");
    };
    reader.readAsDataURL(file);
  };
  const sourceLabel = config.source === "comfy" ? "本地 ComfyUI" : "已保存 API 配置";
  const comfyWorkflows = readComfyWorkflowLibrary().filter((item) => item.apiContent || item.format === "api");
  const selectedComfyWorkflow = comfyWorkflows.find((item) => item.id === config.comfyWorkflowId)
    || (comfyWorkflows.length === 1 ? comfyWorkflows[0] : undefined);
  const comfyParameters = (selectedComfyWorkflow?.parameters || []).filter((parameter) => parameter.enabled && isBasicComfyParameter(parameter));
  const comfyValues = config.comfyValues || {};
  const summary = isText
    ? config.source === "comfy" ? `${selectedComfyWorkflow?.name || "选择工作流"} · ${comfyParameters.length}项参数` : isStoryboardFrames ? `分镜画面 · ${text.storyboardFrames.length}个 · ${text.storyboardRatio} · ${text.storyboardStyle}` : `${text.genre} · ${text.format} · ${text.episodeCount}集×${text.episodeMinutes}分钟`
    : config.source === "comfy" ? `${selectedComfyWorkflow?.name || "选择工作流"} · ${comfyParameters.length}项参数` : `${image.ratio} · ${image.resolution || "模型默认"} · ${image.amount}张 · ${image.style}`;

  return <section className={`ai-composer ai-console ${isText ? "script" : "picture"} ${promptExpanded ? "prompt-expanded" : ""}`} onPointerDown={(event) => event.stopPropagation()}>
    <button className="ai-console-close" title="关闭" onClick={onClose}>×</button>

    <div className="ai-console-tools online-reference-dock">
      {(isText ? textReferences : imageReferences).length > 0 && <div className="online-reference-stack" title="鼠标移入展开全部参考素材">
        {(isText ? textReferences : imageReferences).slice(0, 6).map((item, index) => <div className="online-reference-stack-card" key={item.id} title={`@图片${index + 1} · ${item.name}`}>
          <img src={item.src} alt={item.name} />
          <span className="online-reference-label">图片{index + 1}</span>
          <button title="移除参考图" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => {
            event.stopPropagation();
            if (onRemoveReference) {
              onRemoveReference(item);
              return;
            }
            const references = (isText ? textReferences : imageReferences).filter((reference) => reference.id !== item.id);
            update({ references, ...(!isText && references.length === 0 ? { mode: "text" } : {}) });
          }}>×</button>
        </div>)}
      </div>}
      <div className="online-reference-adders ai-reference-adders">
        <button className="online-reference-add canvas" title="从画布已有图片添加参考" onClick={() => setCanvasPickerOpen(!canvasPickerOpen)}><strong>＋</strong><small>画布生成</small></button>
        <button className="online-reference-add computer" title="从电脑添加参考图片" onClick={() => localImageRef.current?.click()}><strong>＋</strong><small>电脑文件</small></button>
        {canvasPickerOpen && <div className="ai-text-canvas-picker">
          <b>{isText ? "选择画布图片" : "选择画布参考图"}</b>
          <small>{isText ? "只添加为参考图；选择 @图片 时才会识别" : "添加后自动切换为图生图"}</small>
          {canvasImages.length ? <div>{canvasImages.slice(0, 18).map((item) =>
            <button key={item.id} title={item.name} onClick={() => isText ? attachTextReference(item) : attachImageReference(item)}>
              <img src={item.src} alt={item.name} /><span>{item.name}</span>
            </button>,
          )}</div> : <em>画布中还没有图片</em>}
        </div>}
      </div>
      <input ref={localImageRef} type="file" accept="image/*" hidden onChange={(event) => {
        if (isText) importTextReference(event.target.files?.[0]);
        else importImageReference(event.target.files?.[0]);
        event.currentTarget.value = "";
      }} />
      {(describing || referenceImportStatus) && <small className="ai-reference-status">{describing ? "正在识别所选图片…" : referenceImportStatus}</small>}
      <div className="online-reference-actions ai-reference-actions">
        <button className="online-prompt-library-trigger online-prompt-library-trigger-inline" onClick={onOpenPromptLibrary}>提示词库</button>
        {(isText ? textReferences : imageReferences).length > 0 && <button type="button" className="online-at-reference-trigger" onClick={() => setMentionOpen((open) => !open)}>@图片</button>}
      </div>
    </div>

    {linkedTextInputs.length > 0 && <div className="online-linked-input-note" title="这些内容来自连到当前节点的文本或分镜节点，会在提交时自动合并进提示词。">已连接 {linkedTextInputs.length} 条文本输入 · 生成时自动带入</div>}

    <BufferedAiPrompt
      inputRef={promptRef}
      value={config.prompt}
      onCommit={(value) => update({ prompt: value })}
      onDraft={(value, caret) => {
        const references = isText ? textReferences : imageReferences;
        if (references.length) {
          const match = value.slice(0, caret).match(/@[^\s，。；、,.!?]*$/);
          if (match) {
            setMentionOpen(true);
          } else setMentionOpen(false);
        }
      }}
      placeholder={isText
        ? isStoryboardFrames
          ? "输入故事、场景或创意，只生成一个或多个分镜画面参数……"
          : "输入一句话创意、人物关系或故事梗概，生成完整影视剧本……"
        : image.mode === "image"
          ? "描述如何基于参考图片进行创作，输入 @ 可引用上方图片……"
          : "描述想生成的画面、主体、环境、构图、光线与视觉风格……"}
    />

    {mentionOpen && (isText ? textReferences : imageReferences).length > 0 && <div className="ai-mention-menu">
      <b>{isText ? "选择要识别的图片" : "选择要引用的图片"}</b>
      <small>{isText ? (describing ? "正在调用当前视觉模型，请稍候…" : "选择后才会调用视觉模型") : "选择后会在光标位置插入对应的图片编号"}</small>
      {isText && recognitionError && <small className="ai-mention-error" role="alert">{recognitionError}</small>}
      <div>{(isText ? textReferences : imageReferences).map((item, index) => <button type="button" key={item.id} disabled={isText && describing} onClick={() => isText ? void recognizeMentionedImage(item, index) : insertImageMention(index)}>
        <img src={item.src} alt={item.name} /><span>@图片{index + 1}<small>{item.name}</small></span>
      </button>)}</div>
    </div>}

    {isText && recognition && <div className="ai-recognition-panel">
      <header>
        <img src={recognition.image.src} alt={recognition.image.name} />
        <div><b>@图片{recognition.index + 1} 识别结果</b><small>纯文本内容，可直接选择任意位置复制</small></div>
        <button onClick={() => setRecognition(null)}>×</button>
      </header>
      <textarea className="ai-recognition-plain" readOnly value={recognition.content} spellCheck={false} />
    </div>}

    {!isText && image.negativePrompt && <input className="ai-console-negative" value={image.negativePrompt} onChange={(event) => update({ negativePrompt: event.target.value })} placeholder="反向提示词" />}

    <div className="ai-consolebar">
      {config.source === "comfy" && <select aria-label="生成来源" value="comfy" onChange={(event) => {
        const source = event.target.value as "comfy" | "byok";
        if (source === "byok" && !hasSavedApiProvider) onOpenApiConfiguration?.();
        update({ source });
      }}>
        <option value="comfy">本地 ComfyUI</option>
        <option value="byok">使用已保存配置</option>
      </select>}
      {config.source === "comfy" ? <select className="ai-comfy-workflow-select" aria-label="ComfyUI 工作流" value={config.comfyWorkflowId || (comfyWorkflows.length === 1 ? comfyWorkflows[0].id : "")} onChange={(event) => update({ comfyWorkflowId: event.target.value, comfyValues: {} })}>
        <option value="">选择工作流</option>{comfyWorkflows.map((workflow) => <option value={workflow.id} key={workflow.id}>{workflow.name}</option>)}
      </select> : availableProviders.length ? <select aria-label="生成平台" value={hasSavedApiProvider ? config.provider : ""} onChange={(event) => {
        const provider = event.target.value;
        if (isText) {
          const preset = availableProviders.find((item) => item.name === provider);
          update({ provider, model: preset?.defaultModel ?? "" });
        } else {
          const preset = availableProviders.find((item) => item.name === provider);
          const model = preset?.defaultModel || image.model;
          update(normalizeImageSelection(provider, model));
        }
      }}>
        {!hasSavedApiProvider && <option value="">选择{isText ? "文本" : "图片"}平台</option>}
        {availableProviders.map((provider) => <option key={provider.name}>{provider.name}</option>)}
      </select> : <select aria-label="生成平台" disabled value=""><option>暂无{isText ? "文本" : "图片"}平台</option></select>}
      {isText && config.source === "byok" && availableModels.length > 0 && <select aria-label="剧本模型" value={hasSavedApiProvider ? text.model : ""} onChange={(event) => update({ model: event.target.value })}>
        {!hasSavedApiProvider && <option value="">选择模型</option>}
        {availableModels.map((model) => <option key={model}>{model}</option>)}
      </select>}
      {!isText && config.source === "byok" && hasSavedApiProvider && availableModels.length > 0 && <select aria-label="图片模型" value={availableModels.includes(image.model) ? image.model : availableModels[0]} onChange={(event) => {
        const model = event.target.value;
        update(normalizeImageSelection(image.provider, model));
      }}>
        {availableModels.map((model) => <option key={model}>{model}</option>)}
      </select>}
      {!isText && <select aria-label="图片生成模式" value={image.mode} onChange={(event) => update({ mode: event.target.value })}>
        <option value="text">文生图</option><option value="image">图生图</option>
      </select>}
      <button className="ai-console-summary" onClick={() => setParametersOpen(!parametersOpen)}>▭ {summary}⌄</button>
      {config.source === "comfy" && <button className="ai-console-icon" title="选择工作流" onClick={onOpenWorkflowLibrary}>↗</button>}
      <button className="ai-console-icon" title="提示词优化">✧</button>
      <button className="ai-console-icon" title="翻译提示词">文</button>
      {!isText && <div className="ai-source-settings"><button className="ai-console-icon" title="生成设置" aria-label="生成设置" onClick={() => setSourceSettingsOpen(!sourceSettingsOpen)}>☷</button>{sourceSettingsOpen && <div className="ai-source-settings-popover"><b>生成设置</b><small>切换本地 ComfyUI 或已保存的图片 API 配置。</small><button className={config.source === "comfy" ? "active" : ""} onClick={() => { update({ source: "comfy" }); setSourceSettingsOpen(false); }}>本地 ComfyUI</button><button className={config.source === "byok" ? "active" : ""} onClick={() => { if (!hasSavedApiProvider) onOpenApiConfiguration?.(); update({ source: "byok" }); setSourceSettingsOpen(false); }}>已保存 API 配置</button></div>}</div>}
      <button className={`ai-console-icon ai-prompt-expand-icon ${promptExpanded ? "active" : ""}`} title={promptExpanded ? "收起编辑框" : "放大编辑框"} aria-label={promptExpanded ? "收起编辑框" : "放大编辑框"} onClick={() => setPromptExpanded(!promptExpanded)}>⛶</button>
      <button className="ai-generate-button" disabled={node.status === "running" || (hasUsableProvider && !config.prompt.trim() && !linkedTextInputs.some((text) => text.trim()))} onClick={() => {
        if (!hasUsableProvider) {
          onOpenApiConfiguration?.();
          return;
        }
        onGenerate();
      }}>
        {node.status === "running" ? "生成中…" : isText ? isStoryboardFrames ? "生成分镜 ↵" : "生成剧本 ↵" : "生成图片 ↵"}
      </button>
    </div>

    {parametersOpen && <div className="ai-console-parameters">
      <div className="ai-parameter-heading"><div><b>{config.source === "comfy" ? "ComfyUI 工作流参数" : isText ? isStoryboardFrames ? "分镜画面参数" : "剧本生成参数" : "图片生成参数"}</b><small>{config.source === "comfy" ? "参数来自工作流库；只修改本次节点副本" : isStoryboardFrames ? "只生成画面描述；可添加多个画面" : "完整参数保留在这里，确认后自动收起"}</small></div><button onClick={() => setParametersOpen(false)}>完成</button></div>
      {config.source === "comfy" ? <>
        <label className="wide">工作流<select value={config.comfyWorkflowId || ""} onChange={(event) => update({ comfyWorkflowId: event.target.value, comfyValues: {} })}><option value="">请选择</option>{comfyWorkflows.map((workflow) => <option value={workflow.id} key={workflow.id}>{workflow.name}</option>)}</select></label>
        {selectedComfyWorkflow && !comfyParameters.length && <div className="ai-comfy-empty wide">这个工作流还没有发布参数。请进入工作流库，选择该工作流并点击“扫描参数”。</div>}
        {comfyParameters.map((parameter) => <label title={comfyParameterHelp(parameter)} className={parameter.kind === "text" && String(parameter.value).length > 60 ? "wide" : ""} key={parameter.id}>{parameter.label} <i className="comfy-help">?</i><small>{parameter.nodeTitle} · {parameter.input}</small>{parameter.kind === "boolean"
          ? <select value={String(comfyValues[parameter.id] ?? parameter.value)} onChange={(event) => update({ comfyValues: { ...comfyValues, [parameter.id]: event.target.value === "true" } })}><option value="true">开启</option><option value="false">关闭</option></select>
          : <input type={parameter.kind === "number" ? "number" : "text"} value={String(comfyValues[parameter.id] ?? parameter.value)} onChange={(event) => update({ comfyValues: { ...comfyValues, [parameter.id]: parameter.kind === "number" ? Number(event.target.value) : event.target.value } })} />}</label>)}
      </> : <><label className="wide">模型{config.source === "cloud"
        ? <select value={cloudModel?.id || ""} onChange={(event) => update({ model: event.target.value })}>
            {cloudModels.map((model) => <option value={model.id} key={model.id}>{model.label} · {model.platform}</option>)}
          </select>
        : isText ? <select value={text.model} onChange={(event) => update({ model: event.target.value })}>
            {availableModels.map((model) =>
              <option key={model}>{model}</option>,
            )}
          </select>
        : <select value={image.model} onChange={(event) => {
            const model = event.target.value;
            update(normalizeImageSelection(image.provider, model));
          }}>
            {availableModels.map((model) => <option key={model}>{model}</option>)}
          </select>}</label>
      {isText ? <>
        <label>生成内容<select value={text.outputMode} onChange={(event) => update({ outputMode: event.target.value })}><option value="script">完整剧本</option><option value="storyboardFrames">分镜头画面</option></select></label>
        {isStoryboardFrames ? <>
          <label>画面比例<select value={text.storyboardRatio} onChange={(event) => update({ storyboardRatio: event.target.value })}><option>16:9</option><option>9:16</option><option>1:1</option><option>4:3</option><option>3:4</option><option>21:9</option></select></label>
          <label>视觉风格<select value={text.storyboardStyle} onChange={(event) => update({ storyboardStyle: event.target.value })}><option>电影写实</option><option>商业广告</option><option>日系动画</option><option>概念设计</option><option>纪录片</option><option>水彩插画</option></select></label>
          <label>输出语言<select value={text.language} onChange={(event) => update({ language: event.target.value })}><option>简体中文</option><option>繁体中文</option><option>英文</option></select></label>
          <div className="ai-storyboard-frame-list wide">
            <header><div><b>画面列表</b><small>当前 {text.storyboardFrames.length} 个，最多 24 个</small></div><button type="button" disabled={text.storyboardFrames.length >= 24} onClick={addStoryboardFrame}>＋ 添加画面</button></header>
            {text.storyboardFrames.map((frame, index) => <article key={frame.id}>
              <div className="ai-storyboard-frame-heading"><strong>画面 {index + 1}</strong><button type="button" disabled={text.storyboardFrames.length <= 1} onClick={() => removeStoryboardFrame(index)}>删除</button></div>
              <label>名称<input value={frame.name} onChange={(event) => updateStoryboardFrame(index, { name: event.target.value })} placeholder={`画面 ${index + 1}`} /></label>
              <label>景别<select value={frame.shotSize} onChange={(event) => updateStoryboardFrame(index, { shotSize: event.target.value })}><option>大远景</option><option>远景</option><option>全景</option><option>中景</option><option>近景</option><option>特写</option><option>大特写</option></select></label>
              <label>运镜<select value={frame.camera} onChange={(event) => updateStoryboardFrame(index, { camera: event.target.value })}><option>固定镜头</option><option>缓慢推进</option><option>缓慢拉远</option><option>横向摇摄</option><option>跟拍</option><option>环绕</option><option>手持</option><option>俯拍</option><option>航拍</option></select></label>
              <label className="wide">画面要求<input value={frame.requirement} onChange={(event) => updateStoryboardFrame(index, { requirement: event.target.value })} placeholder="人物动作、场景、构图、光线或必须出现的元素" /></label>
            </article>)}
          </div>
          <label className="ai-range wide">创意强度 <b>{text.creativity}</b><input type="range" min="0.1" max="1.5" step="0.1" value={text.creativity} onChange={(event) => update({ creativity: Number(event.target.value) })} /></label>
        </> : <>
        <label>题材<select value={text.genre} onChange={(event) => update({ genre: event.target.value })}><option>剧情短片</option><option>电影长片</option><option>短剧</option><option>广告片</option><option>纪录片</option><option>动画</option></select></label>
        <label>输出格式<select value={text.format} onChange={(event) => update({ format: event.target.value })}><option>标准影视剧本</option><option>分场剧本</option><option>文学剧本</option><option>短剧脚本</option></select></label>
        <label>篇幅<select value={text.length} onChange={(event) => update({ length: event.target.value })}><option>短篇</option><option>中篇</option><option>长篇</option></select></label>
        <label>风格<select value={text.tone} onChange={(event) => update({ tone: event.target.value })}><option>电影感</option><option>现实主义</option><option>轻喜剧</option><option>悬疑紧张</option><option>温暖治愈</option></select></label>
        <label>目标受众<select value={text.audience} onChange={(event) => update({ audience: event.target.value })}><option>大众</option><option>青少年</option><option>儿童</option><option>成年观众</option></select></label>
        <label>输出语言<select value={text.language} onChange={(event) => update({ language: event.target.value })}><option>简体中文</option><option>繁体中文</option><option>英文</option></select></label>
        <label>集数<input type="number" min="1" max="100" value={text.episodeCount} onChange={(event) => update({ episodeCount: Number(event.target.value) })} /></label>
        <label>每集分钟<input type="number" min="1" max="120" value={text.episodeMinutes} onChange={(event) => update({ episodeMinutes: Number(event.target.value) })} /></label>
        <label className="ai-range wide">创意强度 <b>{text.creativity}</b><input type="range" min="0.1" max="1.5" step="0.1" value={text.creativity} onChange={(event) => update({ creativity: Number(event.target.value) })} /></label>
        <label className="ai-check"><input type="checkbox" checked={text.includeCharacters} onChange={(event) => update({ includeCharacters: event.target.checked })} />附人物小传</label>
        <label className="ai-check"><input type="checkbox" checked={text.includeStoryboard} onChange={(event) => update({ includeStoryboard: event.target.checked })} />附分镜建议</label>
        </>}
      </> : <>
        <label title="通用比例；提交前会提示当前模型的已确认能力">画面比例<select value={image.ratio} onChange={(event) => update(normalizeImageSelection(image.provider, image.model, { ratio: event.target.value }))}>{imageRatios.map((ratio) => <option value={ratio} key={ratio}>{ratio}</option>)}</select></label>
        {imageResolutions.length > 0 && <label title="比例改变时会跟随切换一组实际宽高">分辨率<select value={image.resolution} onChange={(event) => update(normalizeImageSelection(image.provider, image.model, { resolution: event.target.value }))}>{imageResolutions.map((resolution) => <option value={resolution} key={resolution}>{imageResolutionLabel(resolution)}</option>)}</select></label>}
        <label title="通用批量数量；不支持的模型会在生成状态中明确提示">生成数量<select value={image.amount} onChange={(event) => update({ amount: Number(event.target.value) })}>{[1,2,3,4,5].map((amount) => <option value={amount} key={amount}>{amount} 张</option>)}</select></label>
        {imageCapabilities.qualities.length > 0 && <label>生成质量<select value={image.quality || imageCapabilities.qualities[0]} onChange={(event) => update({ quality: event.target.value })}>{imageCapabilities.qualities.map((quality) => <option value={quality} key={quality}>{quality}</option>)}</select></label>}
        <label>视觉风格<select value={image.style} onChange={(event) => update({ style: event.target.value })}><option>电影写实</option><option>商业摄影</option><option>概念设计</option><option>日系动画</option><option>水彩插画</option><option>3D 渲染</option></select></label>
        <label>随机种子<input type="number" value={image.seed} onChange={(event) => update({ seed: Number(event.target.value) })} /></label>
        <label className="wide">反向提示词<input value={image.negativePrompt} onChange={(event) => update({ negativePrompt: event.target.value })} placeholder="模糊、畸形、低质量……" /></label>
        <label className="ai-range wide">提示词强度 <b>{image.guidance}</b><input type="range" min="1" max="20" step="0.5" value={image.guidance} onChange={(event) => update({ guidance: Number(event.target.value) })} /></label>
      </>}</>}
      <div className="ai-parameter-source wide"><span className={`ai-source-dot ${config.source}`} />{sourceLabel}<small>{isText ? "参数会保存到当前节点" : `已确认：${imageCapabilities.ratios.join(" / ")}；尺寸档 ${imageCapabilities.resolutions.join(" / ")}；单任务 ${imageCapabilities.amounts.join("、")} 张。其他通用组合将由平台返回是否支持。`}</small></div>
    </div>}
  </section>;
}
