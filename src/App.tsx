import {
  ChangeEvent,
  PointerEvent,
  WheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import MediaLibrary from "./MediaLibrary";
import DirectorMode from "./DirectorMode";
import CloudPointsCenter from "./CloudPointsCenter";
import { AI_TEXT_PROVIDER_PRESETS, AiGenerationComposer, AiGenerationNodeView, type AiImageSettings, type AiReferenceImage, type AiTextSettings } from "./AiGenerationNodes";
import WorkflowLibrary from "./WorkflowLibrary";
import { applyComfyParameters, comfyParameterHelp, injectComfyPrompt, isBasicComfyParameter, readComfyWorkflowLibrary, scanComfyParameters, type ComfyParameter } from "./ComfyWorkflowParameters";
import { CLOUD_VIDEO_MODE_LABELS, cloudModelsFor, cloudPlatformsFor, defaultCloudModel, estimateCloudPoints, supportsCloudVideoMode, type CloudVideoMode } from "./CloudModelCatalog";
type Kind = "image" | "video" | "audio" | "text" | "storyboard" | "api" | "batch" | "aiText" | "aiImage" | "onlineVideo";
type GenerationSource = "comfy" | "byok" | "cloud";
type ComfyCanvasWorkflow = {
  __ymComfyPackage: true;
  libraryId?: string;
  content: unknown;
  parameters: ComfyParameter[];
  values: Record<string, string | number | boolean>;
};
const isComfyCanvasWorkflow = (value: unknown): value is ComfyCanvasWorkflow => Boolean(value && typeof value === "object" && (value as Record<string, unknown>).__ymComfyPackage === true);
type OnlineVideoSettings = {
  source?: GenerationSource;
  provider?: string;
  model?: string;
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
  source: "external" | "generated";
};
type DetectedProviderModel = { id: string; kind: "text" | "image" | "video" | "unknown"; modes?: CloudVideoMode[]; purpose: string };
type OnlineProviderConfig = { endpoint: string; apiKey: string; apiSecret?: string; model: string; custom?: boolean; detectedModels?: DetectedProviderModel[] };
type OnlineProviderConfigs = Record<string, OnlineProviderConfig>;
type CloudSettings = { endpoint: string; accessToken: string; accountLabel: string };
type StoryboardRow = {
  shot: string;
  visual: string;
  dialogue: string;
  imageId?: string;
};
type NodeItem = {
  id: string;
  kind: Kind;
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
  text?: string;
  storyboard?: StoryboardRow[];
  src?: string;
  fileName?: string;
  localPath?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  workflow?: unknown;
  onlineProvider?: string;
  status?: string;
  createdAt?: number;
};
type Link = { id: string; from: string; to: string };
type NodeGroup = { id: string; name: string; nodeIds: string[]; bounds: { x: number; y: number; w: number; h: number }; };
type Project = {
  nodes: NodeItem[];
  links: Link[];
  view: { x: number; y: number; zoom: number };
  groups?: NodeGroup[];
};
type HistoryProject = { id: string; name: string; updatedAt: number; project: Project };
const STORE = "comfy-canvas-offline-v1";
const HISTORY_STORE = "ym-project-history-v1";
const ONLINE_PROVIDER_STORE = "ym-online-provider-configs-v1";
const CLOUD_STORE = "ym-cloud-account-v1";
const generationSourceLabel: Record<GenerationSource, string> = {
  comfy: "本地 ComfyUI",
  byok: "自带 API Key",
  cloud: "亿幕云端积分",
};
const ONLINE_PROVIDER_DEFAULTS: Record<string, Omit<OnlineProviderConfig, "apiKey">> = {
  "阿里百炼·万相": { endpoint: "https://dashscope.aliyuncs.com/api/v1", model: "wan2.6-t2v" },
  "可灵 Kling": {
    endpoint: "https://api.klingai.com",
    model: "kling-v1-6",
    detectedModels: [
      { id: "kling-v1-6", kind: "video", modes: ["text", "image"], purpose: "视频 · 文生视频 / 图生视频" },
    ],
  },
  "豆包·火山方舟": {
    endpoint: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seedance-1-0-pro-250528",
    detectedModels: [
      { id: "doubao-seedance-1-0-pro-250528", kind: "video", modes: ["text", "image", "reference"], purpose: "视频 · 文生视频 / 图生视频 / 多图参考" },
    ],
  },
  "腾讯混元": { endpoint: "https://hunyuan.tencentcloudapi.com", model: "HunyuanVideo" },
  "MiniMax Hailuo": { endpoint: "https://api.minimaxi.com", model: "video-01" },
  "fal.ai": { endpoint: "https://fal.run", model: "fal-ai/wan-i2v" },
  "Replicate": { endpoint: "https://api.replicate.com/v1", model: "wan-video/wan-2.1-i2v-480p" },
  "Hugging Face": { endpoint: "https://router.huggingface.co/hf-inference", model: "Wan-AI/Wan2.1-I2V-14B-480P" },
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
  if (/seedream|gpt-image|image[-_.]?\d|flux|stable[-_.]?diffusion|sdxl|wan.*image/.test(value)) return { id, kind: "image", purpose: "图片生成 / 图片编辑" };
  if (/gpt|qwen|claude|deepseek|gemini|minimax[-_.]?m|llama|mistral|chat|text/.test(value)) return { id, kind: "text", purpose: "文本、对话或剧本生成" };
  return { id, kind: "unknown", purpose: "用途待确认，不会自动用于生成" };
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
};
const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
};
const onlineVideoSizeForRatio = (ratio?: string): [number, number] => {
  const [rawWidth, rawHeight] = (ratio || "16:9").split(":").map(Number);
  if (!(rawWidth > 0 && rawHeight > 0)) return nodeSize.onlineVideo;
  const scale = Math.min(460 / rawWidth, 380 / rawHeight);
  return [Math.round(rawWidth * scale), Math.round(rawHeight * scale)];
};
const mediaKindFromName = (name?: string): Extract<Kind, "image" | "video" | "audio"> | null => {
  const value = (name || "").toLowerCase();
  if (/\.(mp3|wav|m4a|aac|flac|ogg|opus|wma)$/i.test(value)) return "audio";
  if (/\.(mp4|mov|mkv|avi|webm|m4v|wmv)$/i.test(value)) return "video";
  if (/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(value)) return "image";
  return null;
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
  return {
    view: { x: 190, y: 130, zoom: 1 },
    links: [],
    nodes: [
      {
        id: newId(),
        kind: "text",
        x: 110,
        y: 100,
        width: 270,
        height: 175,
        name: "剧本提示词",
        text: "在这里输入你的故事、提示词或备注。\n拖动节点圆点可以连接到 API 工作流。",
      },
      {
        id: newId(),
        kind: "api",
        x: 510,
        y: 150,
        width: 116,
        height: 58,
        name: "导入工作流",
        status: "idle",
      },
    ],
  };
}
function load(): Project {
  try {
    const p = JSON.parse(localStorage.getItem(STORE) || "");
    return p?.nodes ? safeProject(p) : starter();
  } catch {
    return starter();
  }
}
function safeProject(p: Project): Project {
  const legacyVideoOutputs: NodeItem[] = [];
  const migratedNodes = p.nodes.map((node) => {
    if (node.kind !== "onlineVideo" || !node.src) {
      return node.kind === "onlineVideo" && node.width > 400
        ? { ...node, width: 360, height: 240, name: node.name === "可选节点" ? "AI 视频生成" : node.name }
        : node;
    }
    const outputId = `video-output-${node.id}`;
    legacyVideoOutputs.push({
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
    const { src: _src, fileName: _fileName, localPath: _localPath, mediaWidth: _mediaWidth, mediaHeight: _mediaHeight, createdAt: _createdAt, ...generator } = node;
    return { ...generator, x: node.x, y: node.y + node.height + 70, width: 360, height: 240, name: "AI 视频生成", status: "done" };
  });
  const legacyLinks = legacyVideoOutputs
    .filter((output) => !(p.links || []).some((link) => link.to === output.id))
    .map((output) => ({ id: newId(), from: output.id.replace(/^video-output-/, ""), to: output.id }));
  return {
    ...p,
    nodes: [...migratedNodes, ...legacyVideoOutputs],
    links: [...(p.links || []), ...legacyLinks],
  };
}
function loadHistory(): HistoryProject[] {
  try {
    const records = JSON.parse(localStorage.getItem(HISTORY_STORE) || "[]");
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}
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
  onMetadata,
}: {
  src: string;
  onMetadata: (width: number, height: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
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
  const fullscreen = () => videoRef.current?.requestFullscreen?.().catch(() => {});
  return (
    <div className="canvas-video-player" onClick={toggle} title="点击播放或暂停">
      <video
        ref={videoRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          setDuration(video.duration);
          onMetadata(video.videoWidth, video.videoHeight);
        }}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onEnded={() => setCurrent(duration)}
      />
      <div className="canvas-video-tools" onClick={(event) => event.stopPropagation()}>
        <div className="canvas-video-actions">
          <button title="放大播放" onClick={fullscreen}>⛶</button>
          <button
            title={muted ? "打开声音" : "静音"}
            onClick={() => {
              const video = videoRef.current;
              if (!video) return;
              video.muted = !video.muted;
              setMuted(video.muted);
            }}
          >
            {muted ? "🔇" : "🔊"}
          </button>
        </div>
        <time>{format(current)} / {format(duration)}</time>
      </div>
    </div>
  );
}
export default function App() {
  const [introEnabled, setIntroEnabled] = useState(
    () => localStorage.getItem("ym-intro-enabled") !== "false",
  );
  const [intro, setIntro] = useState<"animating" | "ready" | "off">(
    () => (localStorage.getItem("ym-intro-enabled") === "false" ? "off" : "animating"),
  );
  const [project, setProject] = useState<Project>(load);
  const [historyId, setHistoryId] = useState(() => localStorage.getItem("ym-active-project") || newId());
  const [historyProjects, setHistoryProjects] = useState<HistoryProject[]>(loadHistory);
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
  const [activeOnlineVideo, setActiveOnlineVideo] = useState<string | null>(null);
  const [onlinePopover, setOnlinePopover] = useState<{
    nodeId: string;
    kind: "reference" | "effect" | "character" | "camera" | "promptLibrary" | "settings" | "params";
  } | null>(null);
  const [atReferenceMenu, setAtReferenceMenu] = useState<{
    nodeId: string;
    start: number;
    end: number;
  } | null>(null);
  const [promptLibraryText, setPromptLibraryText] = useState("");
  const [promptLibraryEntries, setPromptLibraryEntries] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("yimu-prompt-library") || "[]");
      return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 48) : [];
    } catch {
      return [];
    }
  });
  const [activeStoryboard, setActiveStoryboard] = useState<string | null>(null);
  const [storyboardPaste, setStoryboardPaste] = useState("");
  const [previewImage, setPreviewImage] = useState<NodeItem | null>(null);
  const [dropTextTarget, setDropTextTarget] = useState<string | null>(null);
  const [mediaPickerText, setMediaPickerText] = useState<string | null>(null);
  const [recentOpen, setRecentOpen] = useState(false);
  const [recent, setRecent] = useState<NodeItem[]>([]);
  const [message, setMessage] = useState("已离线保存");
  const [settings, setSettings] = useState(false);
  const [preferences, setPreferences] = useState(false);
  const [onlineApiOpen, setOnlineApiOpen] = useState(false);
  const [cloudPointsOpen, setCloudPointsOpen] = useState(false);
  const [onlineConfigTab, setOnlineConfigTab] = useState<"byok" | "cloud">("byok");
  const [onlineConfigProvider, setOnlineConfigProvider] = useState("阿里百炼·万相");
  const [customProviderName, setCustomProviderName] = useState("");
  const [addingCustomProvider, setAddingCustomProvider] = useState(false);
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [onlineProviderConfigs, setOnlineProviderConfigs] = useState<OnlineProviderConfigs>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(ONLINE_PROVIDER_STORE) || "{}") as OnlineProviderConfigs;
      return stored && typeof stored === "object" ? stored : {};
    } catch { return {}; }
  });
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
  const [theme, setTheme] = useState(() => localStorage.getItem("ym-theme") || "mint");
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

  const selectedOnlineProvider = onlineProviderConfigs[onlineConfigProvider]
    ? { ...ONLINE_PROVIDER_DEFAULTS[onlineConfigProvider], ...onlineProviderConfigs[onlineConfigProvider] }
    : { ...ONLINE_PROVIDER_DEFAULTS[onlineConfigProvider], apiKey: "" };
  const onlineProviderNames = [...new Set([...Object.keys(ONLINE_PROVIDER_DEFAULTS), ...Object.keys(onlineProviderConfigs)])];
  const updateOnlineProviderConfig = (patch: Partial<OnlineProviderConfig>) => {
    setOnlineProviderConfigs((current) => {
      const base = current[onlineConfigProvider]
        ? { ...ONLINE_PROVIDER_DEFAULTS[onlineConfigProvider], ...current[onlineConfigProvider] }
        : { ...ONLINE_PROVIDER_DEFAULTS[onlineConfigProvider], apiKey: "" };
      return { ...current, [onlineConfigProvider]: { ...base, ...patch } };
    });
  };
  const openOnlineConfiguration = (tab: "byok" | "cloud", provider?: string) => {
    if (provider && onlineProviderNames.includes(provider)) setOnlineConfigProvider(provider);
    setOnlineConfigTab(tab);
    setOnlineApiOpen(true);
  };
  const addCustomProvider = () => {
    const name = customProviderName.trim();
    if (!name) { setMessage("请填写平台名称"); return; }
    setOnlineProviderConfigs((current) => ({ ...current, [name]: current[name] || { endpoint: "", apiKey: "", model: "", custom: true, detectedModels: [] } }));
    setOnlineConfigProvider(name);
    setCustomProviderName("");
    setAddingCustomProvider(false);
  };
  const discoverProviderModels = async () => {
    if (!selectedOnlineProvider.endpoint?.trim()) { setMessage("请先填写接口地址"); return; }
    setDiscoveringModels(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const ids = await invoke<string[]>("discover_api_models", { endpoint: selectedOnlineProvider.endpoint, apiKey: selectedOnlineProvider.apiKey || "" });
      const detectedModels = ids.map(classifyProviderModel);
      const preferred = detectedModels.find((model) => model.kind === "video") || detectedModels.find((model) => model.kind !== "unknown");
      updateOnlineProviderConfig({ detectedModels, model: preferred?.id || selectedOnlineProvider.model });
      setMessage(`已识别 ${ids.length} 个模型：文本 ${detectedModels.filter((item) => item.kind === "text").length}、图片 ${detectedModels.filter((item) => item.kind === "image").length}、视频 ${detectedModels.filter((item) => item.kind === "video").length}`);
    } catch (error) {
      setMessage(`模型识别失败：${String(error).replace(/^Error: /, "")}`);
    } finally { setDiscoveringModels(false); }
  };
  const cloudConfigured = Boolean(cloudSettings.endpoint.trim() && cloudSettings.accessToken.trim());

  // 有些 Windows 文件选择器会把音频 MIME 标成 video/*。用扩展名校正旧项目和新导入，
  // 让 MP3 永远进入音频节点、素材库和导演台音轨。
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
      return changed ? { ...current, nodes } : current;
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
  } | null>(null);
  const marquee = useRef<{ x: number; y: number } | null>(null);
  const lineMarquee = useRef<{ x: number; y: number } | null>(null);
  const pendingChange = useRef<((project: Project) => Project) | null>(null);
  const frame = useRef<number | null>(null);
  const undoHistory = useRef<Project[]>([]);
  const cancelledRuns = useRef(new Set<string>());
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
  const fileRef = useRef<HTMLInputElement>(null);
  const onlineReferenceRef = useRef<HTMLInputElement>(null);
  const textMediaRef = useRef<HTMLInputElement>(null);
  const apiRef = useRef<HTMLInputElement>(null);
  const pendingKind = useRef<Kind>("image");
  const [mediaTarget, setMediaTarget] = useState<string | null>(null);
  const [externalTextTarget, setExternalTextTarget] = useState<string | null>(
    null,
  );
  const [apiPoint, setApiPoint] = useState<{ x: number; y: number } | null>(
    null,
  );
  const pastePoint = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(safeProject(project)));
      setMessage("已离线保存");
    } catch {
      setMessage("媒体较大：请用“导出项目”完整保存");
    }
  }, [project]);
  useEffect(() => {
    if (intro !== "animating") return;
    try {
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) {
        const audio = new AudioContextClass();
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(392, audio.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(784, audio.currentTime + 0.34);
        gain.gain.setValueAtTime(0.0001, audio.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.055, audio.currentTime + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.48);
        oscillator.connect(gain).connect(audio.destination);
        oscillator.start();
        oscillator.stop(audio.currentTime + 0.5);
        oscillator.onended = () => audio.close();
      }
    } catch {}
    const timer = window.setTimeout(() => setIntro("ready"), 1450);
    return () => window.clearTimeout(timer);
  }, [intro]);
  useEffect(() => {
    localStorage.setItem("comfy-bridge", apiUrl);
  }, [apiUrl]);
  useEffect(() => {
    localStorage.setItem("ym-intro-enabled", String(introEnabled));
  }, [introEnabled]);
  useEffect(() => {
    localStorage.setItem("ym-default-save-dir", defaultSaveDir);
  }, [defaultSaveDir]);
  useEffect(() => {
    localStorage.setItem("ym-theme", theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem(ONLINE_PROVIDER_STORE, JSON.stringify(onlineProviderConfigs));
  }, [onlineProviderConfigs]);
  useEffect(() => {
    localStorage.setItem(CLOUD_STORE, JSON.stringify(cloudSettings));
  }, [cloudSettings]);
  useEffect(() => {
    localStorage.setItem("ym-active-project", historyId);
    setHistoryProjects((current) => {
      const record: HistoryProject = {
        id: historyId,
        name: `项目 ${new Date().toLocaleDateString("zh-CN")}`,
        updatedAt: Date.now(),
        project: safeProject(project),
      };
      return [record, ...current.filter((item) => item.id !== historyId)].slice(0, 12);
    });
  }, [project, historyId]);
  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_STORE, JSON.stringify(historyProjects));
    } catch {
      // 历史中的大媒体无法写入本地时，当前项目仍可继续使用和导出。
    }
  }, [historyProjects]);
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
    () => project.nodes.find((node) => node.id === activeOnlineVideo && node.kind === "onlineVideo") || null,
    [project.nodes, activeOnlineVideo],
  );
  const activeAiNodeItem = useMemo(
    () => project.nodes.find((node) => node.id === activeAiNode && (node.kind === "aiText" || node.kind === "aiImage")) || null,
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
      }
      return next;
    });
  const undo = () => {
    const previous = undoHistory.current.pop();
    if (!previous) return;
    setProject(previous);
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
      if (next) setProject(next);
    });
  };
  const world = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left - project.view.x) / project.view.zoom,
      y: (clientY - rect.top - project.view.y) / project.view.zoom,
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
    change((p) => ({
      ...p,
      nodes: [...p.nodes, item],
      links: [...p.links, link.side === "out"
        ? { id: newId(), from: link.from, to: item.id }
        : { id: newId(), from: item.id, to: link.from }],
    }));
    setSelected([item.id]);
    setLinkAddMenu(null);
  };
  const openFile = (kind: Kind, nodeId: string) => {
    pendingKind.current = kind;
    setMediaTarget(nodeId);
    fileRef.current?.click();
  };
  const importOnlineReference = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const targetId = activeOnlineVideo;
    event.target.value = "";
    if (!file || !targetId) return;
    const kind = mediaKind(file);
    if (kind !== "image" && kind !== "video") {
      setMessage("参考内容仅支持图片或视频文件。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const reference: OnlineReference = { id: newId(), name: file.name, kind, src: String(reader.result), source: "external" };
      change((current) => ({
        ...current,
        nodes: current.nodes.map((node) => {
          if (node.id !== targetId) return node;
          const config = (node.workflow || {}) as OnlineVideoSettings;
          return { ...node, workflow: { ...config, references: [...(config.references || []), reference] } };
        }),
      }));
      setMessage(`已添加外部参考：“${file.name}”。`);
    };
    reader.readAsDataURL(file);
  };
  const importMedia = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f || !mediaTarget) return;
    const target = mediaTarget;
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      const finish = () => {
        setMessage("媒体已放入节点，导出项目时会一并保存");
        setMediaTarget(null);
      };
      const apply = (mediaWidth: number, mediaHeight: number) => {
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
                  src,
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
      if (pendingKind.current === "image") {
        const image = new Image();
        image.onload = () => apply(image.naturalWidth, image.naturalHeight);
        image.src = src;
      } else if (pendingKind.current === "video") {
        const video = document.createElement("video");
        video.onloadedmetadata = () =>
          apply(video.videoWidth, video.videoHeight);
        video.src = src;
      } else {
        change((p) => ({
          ...p,
          nodes: p.nodes.map((n) =>
            n.id === target ? { ...n, name: f.name, fileName: f.name, src } : n,
          ),
        }));
        finish();
      }
    };
    reader.readAsDataURL(f);
    e.target.value = "";
  };
  const importApi = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const rect = canvasRef.current?.getBoundingClientRect();
        const fallback = rect
          ? {
              x: (rect.width / 2 - project.view.x) / project.view.zoom,
              y: (rect.height / 2 - project.view.y) / project.view.zoom,
            }
          : { x: 410, y: 270 };
        add("api", apiPoint || fallback, {
          name: f.name.replace(/\.json$/i, ""),
          workflow: JSON.parse(String(reader.result)),
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
  const readDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
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
  const addDroppedMedia = async (
    file: File,
    at: { x: number; y: number },
    textTarget?: string,
  ) => {
    const kind = mediaKind(file);
    if (!kind) return;
    const src = await readDataUrl(file);
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
      name: file.name,
      fileName: file.name,
      src,
      mediaWidth,
      mediaHeight,
      status: "idle",
      createdAt: Date.now(),
    };
    change((current) => ({
      ...current,
      nodes: [...current.nodes, item],
      links: textTarget
        ? [...current.links, { id: newId(), from: item.id, to: textTarget }]
        : current.links,
    }));
    if (textTarget) setMessage("已导入素材并连接到文本节点");
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
  const addDroppedApi = (file: File, at: { x: number; y: number }) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        add("api", at, {
          name: file.name.replace(/\.json$/i, ""),
          workflow: JSON.parse(String(reader.result)),
          status: "idle",
        });
        setMessage("API 工作流已拖入画布");
      } catch {
        setMessage("这个 JSON 不是可读取的 ComfyUI API 工作流");
      }
    };
    reader.readAsText(file);
  };
  const openDroppedProject = (file: File, at: { x: number; y: number }) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (Array.isArray(data.nodes)) {
          setProject({
            nodes: data.nodes,
            links: data.links || [],
            view: data.view || { x: 190, y: 130, zoom: 1 },
          });
          setHistoryId(newId());
          setSelected([]);
          setRecent([]);
          setMessage("历史项目已从画布拖入并打开");
          return;
        }
      } catch {
        // 不是项目文件时，按 ComfyUI API 工作流继续导入。
      }
      addDroppedApi(file, at);
    };
    reader.readAsText(file);
  };
  const linkMediaToText = (sourceId: string, textId: string) => {
    change((current) => ({
      ...current,
      links: current.links.some(
        (link) => link.from === sourceId && link.to === textId,
      )
        ? current.links
        : [...current.links, { id: newId(), from: sourceId, to: textId }],
    }));
    setMessage("素材已作为参考连接到文本节点");
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
      return {
        ...current,
        nodes: current.nodes.map((item) =>
          item.id === nodeId
            ? { ...item, storyboard: rows, text: storyboardText(rows) }
            : item,
        ),
        links:
          imageId &&
          !current.links.some(
            (link) => link.from === imageId && link.to === nodeId,
          )
            ? [...current.links, { id: newId(), from: imageId, to: nodeId }]
            : current.links,
      };
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
  const canvasDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const isGrp = !!(e.target as HTMLElement).closest(".node-group");
    if (!isGrp && (e.target as HTMLElement).closest(".node,.menu,.topbar,.toolbar")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (isGrp) { setMenu(null); return; }
    e.currentTarget.setPointerCapture(e.pointerId);
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
  const canvasMove = (e: PointerEvent<HTMLDivElement>) => {
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
      frameChange((p) => ({
        ...p,
        view: {
          ...p.view,
          x: d.origin.x + e.clientX - d.startX,
          y: d.origin.y + e.clientY - d.startY,
        },
      }));
    }
    if (moving.current) {
      const d = moving.current;
      const dx = (e.clientX - d.startX) / project.view.zoom,
        dy = (e.clientY - d.startY) / project.view.zoom;
      frameChange((p) => ({
        ...p,
        nodes: p.nodes.map((n) =>
          d.nodes[n.id]
            ? (() => { let nx = d.nodes[n.id].x + dx; let ny = d.nodes[n.id].y + dy; if (d.groupBounds) { nx = Math.max(d.groupBounds.minX, Math.min(d.groupBounds.maxX - n.width, nx)); ny = Math.max(d.groupBounds.minY, Math.min(d.groupBounds.maxY - n.height, ny)); } return { ...n, x: nx, y: ny }; })()
            : n,
        )
      }));
    }
    if (linking.current) {
      const p = world(e.clientX, e.clientY);
      setDraftLink({ from: linking.current.from, x: p.x, y: p.y, side: linking.current.side });
    }
  };
  const canvasUp = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    if (lineMarquee.current && lineSelectionBox) {
      const box = lineSelectionBox;
      const intersects = (minX: number, minY: number, maxX: number, maxY: number) =>
        minX < box.x + box.width && maxX > box.x && minY < box.y + box.height && maxY > box.y;
      setSelectedLinks(project.links.filter((link) => {
        const a = project.nodes.find((node) => node.id === link.from);
        const b = project.nodes.find((node) => node.id === link.to);
        if (!a || !b) return false;
        const x1 = a.x + a.width, y1 = a.y + a.height / 2;
        const x2 = b.x, y2 = b.y + b.height / 2;
        const bend = Math.max(42, Math.abs(x2 - x1) * .38);
        return intersects(Math.min(x1, x2, x1 + bend, x2 - bend), Math.min(y1, y2), Math.max(x1, x2, x1 + bend, x2 - bend), Math.max(y1, y2));
      }).map((link) => link.id));
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
      marquee.current = null;
      setSelectionBox(null);
    }
    const mediaMove = moving.current;
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
        change((current) => ({
          ...current,
          nodes: current.nodes.map((node) =>
            node.id === sourceId && original
              ? { ...node, x: original.x, y: original.y }
              : node,
          ),
          links: current.links.some(
            (link) => link.from === sourceId && link.to === textTarget.id,
          )
            ? current.links
            : [
                ...current.links,
                { id: newId(), from: sourceId, to: textTarget.id },
              ],
        }));
        setMessage("素材已作为参考连接到文本节点");
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
  change((p) => ({ ...p, groups: (p.groups || []).map((g) => g.id === mediaMove?.isGroupDrag ? { ...g, bounds: { x: g.bounds.x + dx2, y: g.bounds.y + dy2, w: g.bounds.w, h: g.bounds.h } } : g) }));
}
setPanning(false);
    drag.current = null;
    moving.current = null;
    linking.current = null;
    setDraftLink(null);
  };
  const nodeDown = (e: PointerEvent, n: NodeItem) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelectedLinks([]);
    const next = e.ctrlKey
      ? selected.includes(n.id)
        ? selected.filter((id) => id !== n.id)
        : [...selected, n.id]
      : selected.includes(n.id)
        ? selected
        : [n.id];
    setSelected(next);
    let grpBounds: any = undefined;
    const ng = (project.groups || []).find((g) => g.nodeIds.includes(n.id));
    if (ng) { const b = ng.bounds || (() => { const gns = project.nodes.filter((x) => ng.nodeIds.includes(x.id)); const xs2 = gns.map((x) => x.x), ys2 = gns.map((x) => x.y), xe2 = gns.map((x) => x.x + x.width), ye2 = gns.map((x) => x.y + x.height); return { x: Math.min(...xs2) - 12, y: Math.min(...ys2) - 12, w: Math.max(...xe2) - Math.min(...xs2) + 24, h: Math.max(...ye2) - Math.min(...ys2) + 24 }; })(); grpBounds = { minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h }; }
    const movingNodes = Object.fromEntries(
      project.nodes
        .filter((x) => next.includes(x.id))
        .map((x) => [x.id, { x: x.x, y: x.y }]),
    );
    moving.current = {
      startX: e.clientX,
      startY: e.clientY,
      nodes: movingNodes,
      sourceId: n.kind === "image" || n.kind === "video" ? n.id : undefined,
      groupBounds: grpBounds,
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
  const deleteSelected = () => {
    change((p) => ({
      ...p,
      nodes: p.nodes.filter((n) => !selected.includes(n.id)),
      links: p.links.filter(
        (l) => !selected.includes(l.from) && !selected.includes(l.to),
      ),
    }));
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
    change((p) => ({ ...p, view: { x: 190, y: 130, zoom: 1 } }));
  const newProject = () => {
    if (!window.confirm("将开始一个新的空白项目。当前画布会被替换，建议先导出项目。是否继续？")) return;
    change(() => ({ nodes: [], links: [], view: { x: 190, y: 130, zoom: 1 } }));
    setSelected([]);
    setRecent([]);
    setActiveText(null);
    setActiveStoryboard(null);
    setMediaLibraryOpen(false);
    setDirectorOpen(false);
    setHistoryId(newId());
    setMessage("已新建项目");
  };
  const exportProject = async () => {
    const canvasProject = safeProject(project);
    const readStoredJson = (key: string, fallback: unknown) => {
      try { return JSON.parse(localStorage.getItem(key) || "") as unknown; } catch { return fallback; }
    };
    const content = JSON.stringify({
      ...canvasProject,
      __ymProjectPackage: 1,
      director: readStoredJson(`ym-director-editor-v3:${historyId}`, null),
      directorAssets: readStoredJson(`ym-director-assets-v1:${historyId}`, []),
    }, null, 2);
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
      setMessage("项目已保存到本机");
    } catch {
      const blob = new Blob([content], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `离线画布项目-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      setMessage("项目文件已导出");
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
  const openHistoryProject = (item: HistoryProject) => {
    setProject(item.project);
    setHistoryId(item.id);
    setSelected([]);
    setRecent([]);
    setPreferences(false);
    setMessage("历史项目已打开");
  };
  const deleteHistoryProject = (id: string) => {
    setHistoryProjects((items) => items.filter((item) => item.id !== id));
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
    const r = new FileReader();
    r.onload = () => {
      try {
        const p = JSON.parse(String(r.result));
        if (!Array.isArray(p.nodes)) throw Error();
        const nextProjectId = newId();
        if (p.__ymProjectPackage === 1) {
          if (p.director && typeof p.director === "object") {
            localStorage.setItem(`ym-director-editor-v3:${nextProjectId}`, JSON.stringify(p.director));
          }
          if (Array.isArray(p.directorAssets)) {
            localStorage.setItem(`ym-director-assets-v1:${nextProjectId}`, JSON.stringify(p.directorAssets));
          }
        }
        setProject({
          nodes: p.nodes,
          links: p.links || [],
          view: p.view || { x: 190, y: 130, zoom: 1 },
        });
        setHistoryId(nextProjectId);
        setSelected([]);
        setMessage(p.__ymProjectPackage === 1 ? "完整项目已打开，导演台时间线与素材已恢复" : "旧版项目已打开（缺失的本地媒体需重新放入）");
      } catch {
        setMessage("项目文件格式不正确");
      }
    };
    r.readAsText(f);
    e.target.value = "";
  };
  const autoConnect = async (silent = false) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{
        connected: boolean;
        endpoint: string;
        detail: string;
      }>("find_comfyui");
      if (result.connected) {
        setApiUrl(result.endpoint);
        setComfyConnected(true);
        if (!silent) setMessage(result.detail);
      } else {
        setComfyConnected(false);
        if (!silent) setMessage(result.detail);
      }
    } catch {
      setComfyConnected(false);
      if (!silent) setMessage("自动连接组件没有启动，请使用新版桌面程序");
    }
  };
  useEffect(() => {
    if (!comfyConnected) return;
    const timer = window.setInterval(() => autoConnect(true), 8000);
    return () => window.clearInterval(timer);
  }, [comfyConnected]);
  const prepareLinkedWorkflow = async (apiId: string, rawWorkflow: unknown) => {
    const { invoke } = await import("@tauri-apps/api/core");
    const seen = new Set<string>();
    const sources: NodeItem[] = [];
    const visit = (target: string) =>
      project.links
        .filter((link) => link.to === target)
        .forEach((link) => {
          if (seen.has(link.from)) return;
          seen.add(link.from);
          const source = project.nodes.find((node) => node.id === link.from);
          if (!source) return;
          sources.push(source);
          visit(source.id);
        });
    visit(apiId);
    const text = sources
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
    const graph = workflow;
    const isLiteral = (value: unknown) =>
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean";
    if (text) {
      let changed = false;
      Object.values(graph).forEach((node) => {
        if (!node.inputs) return;
        Object.entries(node.inputs).forEach(([key, value]) => {
          const lower = key.toLowerCase();
          if (
            isLiteral(value) &&
            [
              "text",
              "prompt",
              "value",
              "string",
              "positive",
              "positive_prompt",
            ].includes(lower)
          ) {
            node.inputs![key] = text;
            changed = true;
          }
        });
      });
      if (!changed)
        setMessage("已连接文字，但工作流没有可自动替换的提示词字段");
    }
    const byKind = (kind: Kind) =>
      uploaded.filter((item) => item.kind === kind).map((item) => item.name);
    let imageIndex = 0,
      videoIndex = 0,
      audioIndex = 0;
    Object.values(graph).forEach((node) => {
      if (!node.inputs) return;
      Object.entries(node.inputs).forEach(([key, value]) => {
        if (!isLiteral(value)) return;
        const lower = key.toLowerCase();
        const loadImage =
          /loadimage|image/.test(node.class_type || "") &&
          ["image", "input", "path", "file"].includes(lower);
        if (
          (loadImage ||
            [
              "image",
              "reference_image",
              "reference_image_1",
              "reference_image_2",
              "reference_image_3",
            ].includes(lower)) &&
          byKind("image")[imageIndex]
        )
          node.inputs![key] =
            byKind("image")[imageIndex++ % byKind("image").length];
        if (
          ["video", "video_path", "input_video"].includes(lower) &&
          byKind("video")[videoIndex]
        )
          node.inputs![key] =
            byKind("video")[videoIndex++ % byKind("video").length];
        if (
          ["audio", "audio_path", "input_audio"].includes(lower) &&
          byKind("audio")[audioIndex]
        )
          node.inputs![key] =
            byKind("audio")[audioIndex++ % byKind("audio").length];
      });
    });
    return {
      workflow,
      summary:
        `${text ? "文字" : ""}${uploaded.length ? `${text ? " + " : ""}${uploaded.map((item) => typeLabel[item.kind]).join("、")}` : ""}` ||
        "工作流原始参数",
    };
  };
  const stopRun = async (id: string) => {
    // ComfyUI 的 /interrupt 是全局中断接口。重复点击会连续发送全局中断，
    // 让同一任务一直处于“正在运行 / 正在中断”的死循环。
    if (cancelledRuns.current.has(id)) {
      setMessage("停止请求已发送，正在等待 ComfyUI 结束当前任务…");
      return;
    }
    cancelledRuns.current.add(id);
    const item = project.nodes.find((node) => node.id === id);
    change((p) => ({ ...p, nodes: p.nodes.map((node) => node.id === id ? { ...node, status: "stopping" } : node) }));
    if (item?.workflow && !item.onlineProvider) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("interrupt_comfyui", { endpoint: apiUrl });
      } catch (error) {
        addLog(`停止 ComfyUI：${String(error).replace(/^Error: /, "")}`);
      }
    }
    setMessage("已向 ComfyUI 发送一次停止请求，正在等待任务退出…");
    window.setTimeout(() => {
      if (!cancelledRuns.current.has(id)) return;
      cancelledRuns.current.delete(id);
      change((p) => ({ ...p, nodes: p.nodes.map((node) => node.id === id && node.status === "stopping" ? { ...node, status: "idle" } : node) }));
      setMessage("停止请求已完成；如 ComfyUI 仍显示任务，请在 ComfyUI 中仅点击一次红色 X。 ");
    }, 5000);
  };
  const run = async (id: string, replaceTargetId?: string, workflowOverride?: unknown) => {
    cancelledRuns.current.delete(id);
    const item = project.nodes.find((n) => n.id === id);
    if (!item) {
      setMessage("运行失败：画布中没有找到目标节点");
      return;
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
      const visit = (target: string) => project.links.filter((link) => link.to === target).forEach((link) => {
        if (seen.has(link.from)) return;
        seen.add(link.from);
        const source = project.nodes.find((node) => node.id === link.from);
        if (!source) return;
        if (source.kind === "text") text.push(source.text || "");
        if (source.kind === "storyboard") text.push(storyboardText(source.storyboard));
        visit(source.id);
      });
      visit(id);
      const prompt = text.filter(Boolean).join("\n\n");
      if (!prompt) { setMessage("请先连接一个文本/提示词节点到 OpenAI API"); return; }
      change((p) => ({ ...p, nodes: p.nodes.map((n) => n.id === id ? { ...n, status: "running" } : n) }));
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        setMessage("OpenAI 正在生成图片…");
        const src = await invoke<string>("generate_openai_image", { endpoint: previous.endpoint, apiKey: previous.apiKey, prompt, model: previous.model });
        if (cancelledRuns.current.has(id)) return;
        const targets = project.links.filter((link) => link.from === id).map((link) => link.to);
        const outputId = replaceTargetId || targets.map((target) => project.nodes.find((node) => node.id === target)).find((node) => node?.kind === "image")?.id;
        change((p) => ({ ...p, nodes: p.nodes.map((n) => n.id === id ? { ...n, status: "done" } : n.id === outputId ? { ...n, src, name: `OpenAI-${previous.model}.png`, fileName: `OpenAI-${previous.model}.png` } : n) }));
        setMessage("OpenAI 图片已生成并传入连接的图片节点");
      } catch (error) {
        addLog(`OpenAI：${String(error).replace(/^Error: /, "")}`);
        change((p) => ({ ...p, nodes: p.nodes.map((n) => n.id === id ? { ...n, status: "error" } : n) }));
        setMessage(`OpenAI 生成失败：${String(error).replace(/^Error: /, "")}`);
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
    change((p) => ({
      ...p,
      nodes: p.nodes.map((n) =>
        n.id === id ? { ...n, status: "running" } : n,
      ),
    }));
    try {
      const { invoke, convertFileSrc } = await import("@tauri-apps/api/core");
      const prepared = await prepareLinkedWorkflow(id, runnableWorkflow);
      setMessage(`正在把已连接的 ${prepared.summary} 传入 ComfyUI…`);
      const queued = await invoke<{ prompt_id?: string }>("queue_comfyui", {
        endpoint: apiUrl,
        workflow: prepared.workflow,
      });
      const promptId = queued.prompt_id;
      if (!promptId) throw Error("ComfyUI 没有返回任务编号");
      setMessage("ComfyUI 正在生成，画布会在任务完成后自动接收结果；再次点击节点中央按钮可停止任务");
      type OutputFile = {
        filename: string;
        subfolder?: string;
        type?: string;
        fullpath?: string;
      };
      type HistoryItem = {
        status?: { status_str?: string };
        outputs?: Record<
          string,
          { images?: OutputFile[]; gifs?: OutputFile[]; videos?: OutputFile[]; audio?: OutputFile[] }
        >;
      };
      let history: Record<string, HistoryItem> | undefined;
      // 视频和大图工作流常常超过 3 分钟；保持轮询 15 分钟，避免 ComfyUI
      // 仍在运行时画布先把任务误判为超时。
      for (let count = 0; count < 900; count++) {
        if (cancelledRuns.current.has(id)) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (cancelledRuns.current.has(id)) return;
        history = await invoke("get_comfy_history", {
          endpoint: apiUrl,
          promptId,
        });
        if (history?.[promptId]) break;
      }
      const result = history?.[promptId];
      if (!result) throw Error("生成等待超时");
      if (result.status?.status_str && result.status.status_str !== "success")
        throw Error(`ComfyUI 返回：${result.status.status_str}`);
      const outputs = result.outputs;
      if (!outputs) throw Error("ComfyUI 未返回生成文件");
      const generated: NodeItem[] = [];
      Object.values(outputs).forEach((output) =>
        [...(output.images || []), ...(output.gifs || []), ...(output.videos || []), ...(output.audio || [])].forEach((file) => {
          const lower = file.filename.toLowerCase();
          const kind: Kind = /\.(mp4|webm|mov|avi)$/i.test(lower)
            ? "video"
            : /\.(mp3|wav|m4a|aac|flac)$/i.test(lower)
              ? "audio"
              : "image";
          const src = file.fullpath
            ? convertFileSrc(file.fullpath)
            : `${apiUrl.replace(/\/$/, "")}/view?filename=${encodeURIComponent(file.filename)}&subfolder=${encodeURIComponent(file.subfolder || "")}&type=${encodeURIComponent(file.type || "output")}`;
          const [width, height] = nodeSize[kind];
          generated.push({
            id: newId(),
            kind,
            x: item.x + item.width + 110,
            y: item.y + generated.length * (height + 50),
            width,
            height,
            name: file.filename,
            src,
            localPath: file.fullpath,
            createdAt: Date.now(),
          });
        }),
      );
      const replacement = replaceTargetId
        ? generated.find((node) => node.kind === project.nodes.find((node) => node.id === replaceTargetId)?.kind) || generated[0]
        : undefined;
      const appended = replacement ? generated.filter((node) => node.id !== replacement.id) : generated;
      setRecent((items) => [...generated, ...items]);
      setRecentOpen(true);
      change((p) => ({
        ...p,
        nodes: [
          ...p.nodes.map((node) =>
            node.id === id ? { ...node, status: "done" }
              : node.id === replaceTargetId && replacement
                ? { ...node, src: replacement.src, localPath: replacement.localPath, name: replacement.name, fileName: replacement.name }
                : node,
          ),
          ...appended,
        ],
        links: [
          ...p.links,
          ...appended.map((node) => ({ id: newId(), from: id, to: node.id })),
        ],
      }));
      setMessage(
        replacement
          ? "生成成功：已替换当前媒体"
          : generated.length
          ? `生成成功：${generated.length} 个结果已显示并连接到画布`
          : "生成成功，但没有可预览文件",
      );
    } catch (error) {
      change((p) => ({
        ...p,
        nodes: p.nodes.map((n) =>
          n.id === id ? { ...n, status: "error" } : n,
        ),
      }));
      setMessage(`生成失败：${String(error).replace(/^Error: /, "")}`);
    }
  };
  const getAiTextProviderConnection = (settings: AiTextSettings) => {
    const provider = (settings.provider === "OpenAI 兼容" ? "OpenAI" : settings.provider || "OpenAI") as keyof typeof AI_TEXT_PROVIDER_PRESETS;
    const preset = AI_TEXT_PROVIDER_PRESETS[provider] || AI_TEXT_PROVIDER_PRESETS.OpenAI;
    if (provider === "阿里百炼·通义千问") {
      return { provider, endpoint: preset.endpoint, apiKey: onlineProviderConfigs["阿里百炼·万相"]?.apiKey || "", model: settings.model || preset.defaultModel, visionModel: preset.visionModel };
    }
    if (provider === "MiniMax") {
      return { provider, endpoint: preset.endpoint, apiKey: onlineProviderConfigs["MiniMax Hailuo"]?.apiKey || "", model: settings.model || preset.defaultModel, visionModel: preset.visionModel };
    }
    return { provider: "OpenAI" as const, endpoint: openAiConfig.endpoint || preset.endpoint, apiKey: openAiConfig.apiKey || "", model: settings.model || preset.defaultModel, visionModel: preset.visionModel };
  };
  const requestAiTextProviderConfiguration = (provider: string) => {
    if (provider === "阿里百炼·通义千问") {
      openOnlineConfiguration("byok", "阿里百炼·万相");
      setMessage("请保存阿里百炼 API Key；文本和图片理解会自动使用通义千问兼容接口。");
    } else if (provider === "MiniMax") {
      openOnlineConfiguration("byok", "MiniMax Hailuo");
      setMessage("请保存 MiniMax API Key；文本和视觉模型会自动匹配。");
    } else {
      configureOpenAi();
      setMessage("请填写 OpenAI API Key；接口和模型会自动匹配。");
    }
  };
  const describeAiTextImage = async (node: NodeItem, image: AiReferenceImage) => {
    const settings = (node.workflow || {}) as AiTextSettings;
    const connection = getAiTextProviderConnection(settings);
    if (!connection.apiKey) {
      requestAiTextProviderConfiguration(connection.provider);
      throw new Error(`请先配置 ${connection.provider} API Key`);
    }
    const { invoke } = await import("@tauri-apps/api/core");
    setMessage(`正在使用 ${connection.provider} 识别“${image.name}”中的人物与场景…`);
    try {
      let imageData = image.src;
      if (!imageData.startsWith("data:")) {
        const blob = await fetch(imageData).then((response) => {
          if (!response.ok) throw new Error(`无法读取图片：HTTP ${response.status}`);
          return response.blob();
        });
        imageData = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
          reader.readAsDataURL(blob);
        });
      }
      const description = await invoke<string>("describe_openai_image", {
        endpoint: connection.endpoint,
        apiKey: connection.apiKey,
        model: connection.visionModel,
        imageData,
      });
      setMessage(`已识别“${image.name}”，人物与场景信息已写入文本框。`);
      return description.trim();
    } catch (error) {
      const detail = String(error).replace(/^Error: /, "");
      setMessage(`图片识别失败：${detail}`);
      throw error;
    }
  };
  const generateAiNode = async (node: NodeItem) => {
    const settings = (node.workflow || {}) as AiTextSettings & AiImageSettings;
    const upstreamNodes = project.links
      .filter((link) => link.to === node.id)
      .map((link) => project.nodes.find((item) => item.id === link.from))
      .filter((item): item is NodeItem => Boolean(item));
    const upstreamText = upstreamNodes
      .map((item) => item.kind === "text" ? item.text || "" : item.kind === "storyboard" ? storyboardText(item.storyboard) : "")
      .filter((text) => text.trim());
    const effectivePrompt = [settings.prompt || "", ...upstreamText].filter((text) => text.trim()).join("\n\n");
    const upstreamImages = upstreamNodes
      .filter((item): item is NodeItem & { src: string } => item.kind === "image" && Boolean(item.src))
      .map((item) => ({ id: item.id, name: item.name, src: item.src }));
    if (settings.source === "cloud") {
      setMessage("亿幕云端模型服务尚未部署；当前可先使用自带密钥验证生成节点。");
      openOnlineConfiguration("cloud");
      return;
    }
    if (settings.source === "comfy") {
      const localSettings = settings as (AiTextSettings & AiImageSettings) & { comfyWorkflowId?: string; comfyValues?: Record<string, string | number | boolean> };
      const workflow = readComfyWorkflowLibrary().find((item) => item.id === localSettings.comfyWorkflowId);
      if (!workflow) {
        setMessage("请先选择一个已扫描参数的 ComfyUI 工作流。");
        setWorkflowLibraryOpen(true);
        return;
      }
      const apiContent = workflow.apiContent || (workflow.format === "api" ? workflow.content : undefined);
      if (!apiContent) {
        setMessage("这个 Workflow JSON 还没有转换成 API 格式，请在工作流库点击“扫描参数”。");
        setWorkflowLibraryOpen(true);
        return;
      }
      const configured = applyComfyParameters(apiContent, workflow.parameters || [], localSettings.comfyValues || {});
      const runnable = injectComfyPrompt(configured, effectivePrompt);
      setMessage(`正在使用本地工作流“${workflow.name}”运行 ${workflow.parameters?.filter((parameter) => parameter.enabled).length || 0} 项参数…`);
      await run(node.id, undefined, runnable);
      return;
    }
    const textConnection = node.kind === "aiText" ? getAiTextProviderConnection(settings as AiTextSettings) : null;
    if (node.kind === "aiText" && !textConnection?.apiKey) {
      requestAiTextProviderConfiguration(textConnection?.provider || "OpenAI");
      return;
    }
    if (node.kind === "aiImage" && (!openAiConfig.endpoint || !openAiConfig.apiKey)) {
      configureOpenAi();
      setMessage("请先填写 OpenAI 兼容接口地址和 API Key。");
      return;
    }
    change((current) => ({ ...current, nodes: current.nodes.map((item) => item.id === node.id ? { ...item, status: "running" } : item) }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (node.kind === "aiText") {
        const textSettings = settings as AiTextSettings;
        const systemPrompt = [
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
        const result = await invoke<string>("generate_openai_text", {
          endpoint: textConnection!.endpoint,
          apiKey: textConnection!.apiKey,
          prompt: effectivePrompt,
          model: textConnection!.model,
          systemPrompt,
          temperature: textSettings.creativity || 0.8,
        });
        const output: NodeItem = { id: newId(), kind: "text", x: node.x + node.width + 90, y: node.y, width: 420, height: 320, name: "AI 完整剧本", text: result, status: "done", createdAt: Date.now() };
        change((current) => ({ ...current, nodes: [...current.nodes.map((item) => item.id === node.id ? { ...item, status: "done" } : item), output], links: [...current.links, { id: newId(), from: node.id, to: output.id }] }));
        setMessage("完整剧本已生成并连接到画布");
      } else {
        const imageSettings = settings as AiImageSettings;
        const fullPrompt = [effectivePrompt, `视觉风格：${imageSettings.style || "电影写实"}`, imageSettings.negativePrompt ? `避免：${imageSettings.negativePrompt}` : ""].filter(Boolean).join("\n");
        const references = [...upstreamImages, ...(imageSettings.references || []).filter((reference) => !upstreamImages.some((item) => item.id === reference.id))];
        const reference = references[0];
        let referenceData = reference?.src || "";
        if (referenceData && !referenceData.startsWith("data:")) {
          const blob = await fetch(referenceData).then((response) => {
            if (!response.ok) throw new Error(`无法读取参考图：HTTP ${response.status}`);
            return response.blob();
          });
          referenceData = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => reject(reader.error || new Error("参考图读取失败"));
            reader.readAsDataURL(blob);
          });
        }
        const src = referenceData
          ? await invoke<string>("generate_openai_image_edit", {
              endpoint: openAiConfig.endpoint,
              apiKey: openAiConfig.apiKey,
              prompt: fullPrompt,
              model: imageSettings.model || "gpt-image-1",
              imageData: referenceData,
            })
          : await invoke<string>("generate_openai_image", {
              endpoint: openAiConfig.endpoint,
              apiKey: openAiConfig.apiKey,
              prompt: fullPrompt,
              model: imageSettings.model || "gpt-image-1",
            });
        const [width, height] = nodeSize.image;
        const output: NodeItem = { id: newId(), kind: "image", x: node.x + node.width + 90, y: node.y, width, height, name: `AI图片-${Date.now()}.png`, fileName: `AI图片-${Date.now()}.png`, src, status: "done", createdAt: Date.now() };
        change((current) => ({ ...current, nodes: [...current.nodes.map((item) => item.id === node.id ? { ...item, status: "done", src } : item), output], links: [...current.links, { id: newId(), from: node.id, to: output.id }] }));
        setMessage(`图片已生成并连接到画布${upstreamText.length ? `；已合并 ${upstreamText.length} 个文本输入` : ""}${reference ? `；已使用参考图“${reference.name}”` : ""}`);
      }
    } catch (error) {
      change((current) => ({ ...current, nodes: current.nodes.map((item) => item.id === node.id ? { ...item, status: "error" } : item) }));
      setMessage(`AI 生成失败：${String(error).replace(/^Error: /, "")}`);
    }
  };
  const resize = (e: PointerEvent, id: string) => {
    e.stopPropagation();
    const n = project.nodes.find((x) => x.id === id)!;
    const sx = e.clientX,
      sy = e.clientY,
      w = n.width,
      h = n.height;
    const preserveMediaRatio =
      (n.kind === "image" || n.kind === "video") &&
      n.mediaWidth &&
      n.mediaHeight;
    const move = (ev: globalThis.PointerEvent) =>
      frameChange((p) => ({
        ...p,
        nodes: p.nodes.map((x) => {
          if (x.id !== id) return x;
          const width = Math.max(170, w + (ev.clientX - sx) / p.view.zoom);
          return preserveMediaRatio
            ? {
                ...x,
                width,
                height: Math.max(
                  90,
                  Math.round((width * n.mediaHeight!) / n.mediaWidth!) + 29,
                ),
              }
            : {
                ...x,
                width,
                height: Math.max(90, h + (ev.clientY - sy) / p.view.zoom),
              };
        }),
      }));
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };
  const curve = (x1: number, y1: number, x2: number, y2: number) =>
    `M ${x1} ${y1} C ${x1 + Math.max(42, Math.abs(x2 - x1) * 0.38)} ${y1}, ${x2 - Math.max(42, Math.abs(x2 - x1) * 0.38)} ${y2}, ${x2} ${y2}`;
  const curveFromLeft = (x1: number, y1: number, x2: number, y2: number) =>
    `M ${x1} ${y1} C ${x1 - Math.max(42, Math.abs(x2 - x1) * 0.38)} ${y1}, ${x2 + Math.max(42, Math.abs(x2 - x1) * 0.38)} ${y2}, ${x2} ${y2}`;
  const svgLinks = project.links.map((l) => {
    const a = project.nodes.find((n) => n.id === l.from),
      b = project.nodes.find((n) => n.id === l.to);
    if (!a || !b) return null;
    const x1 = a.x + a.width,
      y1 = a.y + a.height / 2,
      x2 = b.x,
      y2 = b.y + b.height / 2;
    const active = selected.includes(l.from) || selected.includes(l.to);
    const selectedWire = selectedLinks.includes(l.id);
    return (
      <path
        className={(active ? "active " : "") + (selectedWire ? "selected-wire" : "")}
        key={l.id}
        d={curve(x1, y1, x2, y2)}
      />
    );
  });
  const draftPath =
    draftLink && project.nodes.find((n) => n.id === draftLink.from);
  const portWorldSize = 14 / Math.min(1, project.view.zoom);
  const portStyle = {
    width: portWorldSize,
    height: portWorldSize,
    top: `calc(50% - ${portWorldSize / 2}px)`,
  };
  return (
<main className={`app theme-${theme}`} onContextMenu={(e) => e.preventDefault()}>
      {intro !== "off" && (
        <section className={`intro-screen ${intro}`}>
          <div className="intro-orbit" />
          <div className="intro-core">
            <i>✦</i>
            <small>亿幕画布</small>
            <button
              disabled={intro !== "ready"}
              onClick={() => setIntro("off")}
            >
              亿幕
            </button>
          </div>
          <p>{intro === "animating" ? "正在展开创作空间" : "创造新奇迹"}</p>
        </section>
      )}
      <header className="topbar">
        <div className="brand">
          <i className={`connection-dot ${comfyConnected ? "connected" : "disconnected"}`} />
          <b>亿幕画布</b>
          <span>{message}</span>
        </div>
        <div className="top-actions">
          <button onClick={newProject}>新建项目</button>
          <button onClick={openMediaLibrary} title="素材库" className="media-lib-btn"><span className="media-lib-grid-icon"><span></span><span></span><span></span><span></span></span></button>
          <div className="top-more" onPointerDown={(e) => e.stopPropagation()}>
            <button aria-label="更多项目操作" onClick={() => setTopMenuOpen(!topMenuOpen)}>•••</button>
            {topMenuOpen && (
              <div className="top-menu">
                <button onClick={() => { exportProject(); setTopMenuOpen(false); }}>导出项目</button>
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
          <label className="setting-row">
            <span>重新打开程序时显示开场</span>
            <input
              type="checkbox"
              checked={introEnabled}
              onChange={(e) => {
                setIntroEnabled(e.target.checked);
                if (!e.target.checked) setIntro("off");
              }}
            />
          </label>
          <small>关闭后，下一次打开亿幕画布将直接进入上次项目。</small>
          <label>默认项目保存位置</label>
          <div className="setting-path">
            <input value={defaultSaveDir} onChange={(e) => setDefaultSaveDir(e.target.value)} />
            <button onClick={chooseDefaultSaveDir}>更改</button>
          </div>
          <label>个性化色调</label>
          <div className="theme-options">
            <button className={theme === "mint" ? "active" : ""} onClick={() => setTheme("mint")}>青绿</button>
            <button className={theme === "blue" ? "active" : ""} onClick={() => setTheme("blue")}>蓝色</button>
            <button className={theme === "purple" ? "active" : ""} onClick={() => setTheme("purple")}>紫色</button>
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
          <section className="online-provider-dialog" onPointerDown={(event) => event.stopPropagation()}>
            <header>
              <div><span>生成来源</span><b>在线服务配置</b><small>自带密钥仅保存在本机；亿幕云端需要独立服务器与账户系统。</small></div>
              <button className="dialog-close" title="关闭" onClick={() => setOnlineApiOpen(false)}>×</button>
            </header>
            <nav className="online-provider-tabs" aria-label="在线服务来源">
              <button className={onlineConfigTab === "byok" ? "active" : ""} onClick={() => setOnlineConfigTab("byok")}>自带密钥</button>
              <button className={onlineConfigTab === "cloud" ? "active" : ""} onClick={() => setOnlineConfigTab("cloud")}>亿幕云端积分</button>
            </nav>
            {onlineConfigTab === "byok" ? <>
              <label>平台
                <span className="provider-select-row"><select value={onlineConfigProvider} onChange={(event) => setOnlineConfigProvider(event.target.value)}>
                  {onlineProviderNames.map((provider) => <option key={provider}>{provider}{onlineProviderConfigs[provider]?.custom ? " · 自定义" : ""}</option>)}
                </select><button type="button" onClick={() => setAddingCustomProvider(!addingCustomProvider)}>＋ 添加平台</button></span>
              </label>
              {addingCustomProvider && <div className="custom-provider-add"><input autoFocus value={customProviderName} onChange={(event) => setCustomProviderName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addCustomProvider()} placeholder="平台名称，例如：我的 OpenAI 兼容服务" /><button onClick={addCustomProvider}>创建</button></div>}
              <label>接口地址
                <input value={selectedOnlineProvider.endpoint} onChange={(event) => updateOnlineProviderConfig({ endpoint: event.target.value })} />
              </label>
              <label>{onlineConfigProvider === "可灵 Kling" ? "Access Key" : "API 密钥"}
                <input type="password" value={selectedOnlineProvider.apiKey} onChange={(event) => updateOnlineProviderConfig({ apiKey: event.target.value })} placeholder={onlineConfigProvider === "可灵 Kling" ? "粘贴可灵 Access Key" : "粘贴平台 API Key"} />
              </label>
              {onlineConfigProvider === "可灵 Kling" && <label>Secret Key
                <input type="password" value={selectedOnlineProvider.apiSecret || ""} onChange={(event) => updateOnlineProviderConfig({ apiSecret: event.target.value })} placeholder="粘贴可灵 Secret Key（只保存在本机）" />
              </label>}
              {onlineConfigProvider === "可灵 Kling" || onlineConfigProvider === "豆包·火山方舟"
                ? <div className="provider-model-discovery"><small>该平台使用专用视频协议，已内置模型用途识别；也可在下面填写控制台实际开通的模型 ID。</small></div>
                : <div className="provider-model-discovery"><button disabled={discoveringModels || !selectedOnlineProvider.endpoint?.trim()} onClick={() => void discoverProviderModels()}>{discoveringModels ? "正在读取模型…" : "自动读取并识别模型"}</button><small>适用于提供 OpenAI 兼容 `/models` 接口的平台；密钥只在本机请求时使用。</small></div>}
              <label>默认模型
                <input list="online-provider-model-options" value={selectedOnlineProvider.model} onChange={(event) => updateOnlineProviderConfig({ model: event.target.value })} placeholder="填写控制台中的模型 ID" />
                {selectedOnlineProvider.detectedModels?.length ? <datalist id="online-provider-model-options">{selectedOnlineProvider.detectedModels.map((model) => <option value={model.id} key={model.id}>{model.purpose}</option>)}</datalist> : null}
              </label>
              {selectedOnlineProvider.detectedModels?.length ? <div className="detected-model-summary">{(["text", "image", "video", "unknown"] as const).map((kind) => { const count = selectedOnlineProvider.detectedModels!.filter((model) => model.kind === kind).length; return count ? <span className={kind} key={kind}>{kind === "text" ? "文本" : kind === "image" ? "图片" : kind === "video" ? "视频" : "待确认"} {count}</span> : null; })}<small>系统只在对应类型节点展示已确认模型；“待确认”模型不会自动调用。</small></div> : null}
              <small className="online-provider-note">保存后，AI 节点会按识别到的模型类型和能力自动筛选。不同平台的生成提交协议仍可能不同；只有完成协议适配的平台才会真正发起任务。</small>
              <footer>
                <button className="primary" onClick={() => { const next = { ...onlineProviderConfigs, [onlineConfigProvider]: selectedOnlineProvider as OnlineProviderConfig }; setOnlineProviderConfigs(next); localStorage.setItem(ONLINE_PROVIDER_STORE, JSON.stringify(next)); setMessage(`${onlineConfigProvider} 的自带密钥配置已保存到本机`); setOnlineApiOpen(false); }}>保存本机配置</button>
              </footer>
            </> : <>
              <div className={`cloud-config-status ${cloudConfigured ? "configured" : ""}`}>
                {cloudConfigured ? "云端地址与登录令牌已保存，等待服务器验证" : "未配置云端服务"}
              </div>
              <label>服务地址
                <input value={cloudSettings.endpoint} onChange={(event) => setCloudSettings((value) => ({ ...value, endpoint: event.target.value }))} placeholder="https://api.yimu.example" />
              </label>
              <label>登录令牌
                <input type="password" value={cloudSettings.accessToken} onChange={(event) => setCloudSettings((value) => ({ ...value, accessToken: event.target.value }))} placeholder="登录后由亿幕云端签发" />
              </label>
              <label>账户备注
                <input value={cloudSettings.accountLabel} onChange={(event) => setCloudSettings((value) => ({ ...value, accountLabel: event.target.value }))} placeholder="例如：湫的云端账户" />
              </label>
              <small className="online-provider-note">积分、支付、余额和任务队列必须由亿幕云端服务器返回。当前未部署服务器时，应用不会展示伪余额、扣费或提交任务。</small>
              <footer>
                <button onClick={() => { setOnlineApiOpen(false); setCloudPointsOpen(true); }}>查看积分中心演示</button>
                <button className="primary" onClick={() => { localStorage.setItem(CLOUD_STORE, JSON.stringify(cloudSettings)); if (!cloudConfigured) { setMessage("请填写云端服务地址和登录令牌"); return; } setMessage("亿幕云端配置已保存，等待服务器验证"); setOnlineApiOpen(false); }}>保存云端配置</button>
              </footer>
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
      <aside className={`studio-sidebar ${studioOpen ? "open" : ""}`}>
        <div className="sidebar-title">
          <span className="brand-mark">✦</span>
          <div>
            <b>创作工作台</b>
            <small>本地项目 · 自动保存</small>
          </div>
          <button className="director-mode-button" onClick={openDirectorMode} title="打开导演台">导演模式</button>
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
          <p>03　模型生成</p>
          <button
            className="side-action ai-text"
            onClick={() => addAtViewport("aiText", {
              name: "AI 剧本生成",
              workflow: {
                source: "byok", provider: "OpenAI", model: "gpt-4.1-mini",
                genre: "剧情短片", format: "标准影视剧本", length: "中篇",
                tone: "电影感", audience: "大众", language: "简体中文",
                creativity: 0.8, episodeCount: 1, episodeMinutes: 5,
                includeStoryboard: true, includeCharacters: true,
              } satisfies AiTextSettings,
            })}
          >
            <b>文</b>
            <span>
              AI 剧本生成<small>一句创意扩写完整剧本</small>
            </span>
          </button>
          <button
            className="side-action ai-image"
            onClick={() => addAtViewport("aiImage", {
              name: "AI 图片生成",
              workflow: {
                source: "byok", provider: "OpenAI", model: "gpt-image-1",
                mode: "text", ratio: "16:9", resolution: "1024",
                amount: 1, style: "电影写实", seed: -1, guidance: 7,
              } satisfies AiImageSettings,
            })}
          >
            <b>图</b>
            <span>
              AI 图片生成<small>文生图与多图参考</small>
            </span>
          </button>
          <button
            className="side-action online-video"
            onClick={() => addAtViewport("onlineVideo", {
              name: "AI 视频生成",
              workflow: {
                source: "byok",
                provider: "未选择平台",
                mode: "text",
                ratio: "16:9",
                quality: "720P",
                duration: 5,
                amount: 1,
                audio: true,
              } satisfies OnlineVideoSettings,
            })}
          >
            <b>✦</b>
            <span>
              AI 视频生成<small>文生、图生、首尾帧视频</small>
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
              onClick={() => openOnlineConfiguration("byok")}
            >
              <b>◌</b>
              <span>
                在线服务配置<small>自带密钥与亿幕云端</small>
              </span>
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
        style={{ cursor: panning ? "grabbing" : "grab" }}
        onWheel={wheel}
        onPointerDown={canvasDown}
        onPointerMove={canvasMove}
        onPointerUp={canvasUp}
        onContextMenu={canvasMenu}
        onDragOver={(event) => event.preventDefault()}
        onDrop={canvasDrop}
      >
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
              {(project.groups || []).map((g) => {
                const gn = g.nodeIds.map((id) => project.nodes.find((n) => n.id === id)).filter((n): n is NodeItem => !!n);
                if (gn.length < 2) return null;
                const minX = g.bounds.x;
                const minY = g.bounds.y;
                const maxX = g.bounds.x + g.bounds.w;
                const maxY = g.bounds.y + g.bounds.h;
                const gnds = Object.fromEntries(project.nodes.filter((x) => g.nodeIds.includes(x.id)).map((x) => [x.id, { x: x.x, y: x.y }]));
                return <div key={g.id} className="node-group" style={{ position: "absolute", left: minX, top: minY, width: maxX - minX, height: maxY - minY }} onPointerDown={(e) => { if (e.button !== 0) return; moving.current = { startX: e.clientX, startY: e.clientY, nodes: gnds, isGroupDrag: g.id, startBounds: { x: g.bounds.x, y: g.bounds.y, w: g.bounds.w, h: g.bounds.h } } as any; }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, node: "__group_" + g.id }); }}><span className="node-group-name" title="双击重新命名" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => { e.stopPropagation(); setGroupNameInput(g.id); }}>{g.name}</span></div>;
              })}
          {project.nodes.map((n) => (
            <article
              key={n.id}
              data-node-id={n.id}
              className={`node ${n.kind} status-${n.status || "idle"} ${selected.includes(n.id) ? "selected" : ""} ${dropTextTarget === n.id ? "drop-target" : ""}`}
              style={{ left: n.x, top: n.y, width: n.width, height: n.height }}
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
              {n.kind !== "api" && (
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
                    change((p) => ({
                      ...p,
                      links: [
                        ...p.links.filter(
                          (l) => !(l.from === (side === "out" ? from : n.id) && l.to === (side === "out" ? n.id : from)),
                        ),
                        side === "out" ? { id: newId(), from, to: n.id } : { id: newId(), from: n.id, to: from },
                      ],
                    }));
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
                  change((p) => ({
                    ...p,
                    links: [...p.links.filter((link) => !(link.from === from && link.to === to)), { id: newId(), from, to }],
                  }));
                  linking.current = null;
                  setDraftLink(null);
                }}
              />
              {n.kind === "image" &&
                (n.src ? (
                  <img
                    draggable={false}
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
                  <div className="empty">
                    <button
                      style={{
                        border: "1px solid #536466",
                        background: "#293235",
                        color: "#dce8e7",
                        padding: "9px 14px",
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => openFile("image", n.id)}
                    >
                      ＋ 添加图片
                    </button>
                  </div>
                ))}
              {n.kind === "video" &&
                (n.src ? (
                  <VideoCanvas
                    src={n.src}
                    onMetadata={(width, height) =>
                      recordMediaSize(
                        n.id,
                        width,
                        height,
                      )
                    }
                  />
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
                      onClick={() => openFile("video", n.id)}
                    >
                      ＋ 添加视频
                    </button>
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
                      <small>支持文生、图生与首尾帧视频</small>
                    </div>
                  </button>
                  <div className="online-video-body" onPointerDown={(event) => event.stopPropagation()}>
                  <div className="online-video-topline">
                    <span className="online-video-signal" />
                    <select value={config.provider} onChange={(event) => {
                      const provider = event.target.value;
                      const saved = onlineProviderConfigs[provider];
                      const defaults = ONLINE_PROVIDER_DEFAULTS[provider];
                      const providerConfig = saved ? { ...defaults, ...saved } : defaults;
                      const model = (providerConfig?.detectedModels || []).find((item) => item.kind === "video");
                      update({ provider, model: providerConfig?.model, ...(model?.modes?.length ? { mode: model.modes[0] } : {}) });
                    }}>
                      <option>未选择平台</option>
                      {onlineProviderNames.map((provider) => <option key={provider}>{provider}</option>)}
                    </select>
                    <select value={config.mode} onChange={(event) => update({ mode: event.target.value as OnlineVideoSettings["mode"] })}>
                      {Object.entries(modeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                    </select>
                  </div>
                  <textarea value={config.prompt || ""} onChange={(event) => update({ prompt: event.target.value })} placeholder="描述你想要生成的视频画面；可连接文本、图片或首尾帧作为参考…" />
                  <div className="online-video-tools">
                    <button title="提示词优化" onClick={() => setMessage("提示词优化会在接入模型后启用")}>✧ 优化</button>
                    <button title="翻译提示词" onClick={() => setMessage("提示词翻译会在接入模型后启用")}>文A 翻译</button>
                    <label>比例<select value={config.ratio} onChange={(event) => update({ ratio: event.target.value })}>{["Auto", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].map((item) => <option key={item}>{item}</option>)}</select></label>
                    <label>清晰度<select value={config.quality} onChange={(event) => update({ quality: event.target.value })}>{["480P", "720P", "1080P"].map((item) => <option key={item}>{item}</option>)}</select></label>
                    <label>时长<select value={config.duration} onChange={(event) => update({ duration: Number(event.target.value) })}>{[5, 6, 8, 10].map((item) => <option value={item} key={item}>{item} 秒</option>)}</select></label>
                    <label>数量<select value={config.amount} onChange={(event) => update({ amount: Number(event.target.value) })}>{[1, 2, 4].map((item) => <option value={item} key={item}>{item} 个</option>)}</select></label>
                    <button className={config.audio ? "active" : ""} onClick={() => update({ audio: !config.audio })}>🔊 音频</button>
                  </div>
                  <div className="online-video-footer">
                    <small>{modeLabels[config.mode || "text"]} · {config.ratio} · {config.quality} · {config.duration}s · {config.amount}个</small>
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
                      setActiveText(n.id);
                    }}
                  >
                    {n.text || "点击输入文本"}
                  </button>
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
              {n.kind === "api" && (
                <>
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
                </>
              )}
              {n.kind !== "api" && n.kind !== "audio" && (
                <span
                  className="resize"
                  onPointerDown={(e) => resize(e, n.id)}
                />
              )}
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
        const savedByokProvider = onlineProviderConfigs[config.provider || ""];
        const defaultByokProvider = ONLINE_PROVIDER_DEFAULTS[config.provider || ""];
        const activeByokProvider = savedByokProvider
          ? { ...defaultByokProvider, ...savedByokProvider }
          : defaultByokProvider ? { ...defaultByokProvider, apiKey: "" } : undefined;
        const detectedByokModels = (activeByokProvider?.detectedModels || []).filter((model) => model.kind === "video");
        const customByokModel = activeByokProvider?.model && !detectedByokModels.some((model) => model.id === activeByokProvider.model)
          ? { ...classifyProviderModel(activeByokProvider.model), modes: detectedByokModels[0]?.modes || classifyProviderModel(activeByokProvider.model).modes }
          : undefined;
        const byokModels = customByokModel ? [customByokModel, ...detectedByokModels] : detectedByokModels;
        const byokModel = byokModels.find((model) => model.id === config.model) || byokModels[0];
        const cloudEstimate = config.source === "cloud" ? estimateCloudPoints("video", cloudModel?.id, {
          promptLength: (config.prompt || "").length + linkedTextInputs.join("\n").length,
          references: references.length,
          amount: config.amount,
          resolution: config.quality,
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
          if (!exists) change((p) => ({ ...p, links: [...p.links, { id: newId(), from: media.id, to: activeOnlineVideoNode.id }] }));
          if (!(config.references || []).some((item) => item.id === media.id)) {
            update({ references: [...(config.references || []), { id: media.id, name: media.name, kind: media.kind as "image" | "video", src: media.src || "", source: "generated" }] });
          }
          setOnlinePopover(null);
          setMessage(`已将“${media.name}”作为视频参考连接。`);
        };
        const removeReference = (reference: OnlineReference) => {
          update({ references: (config.references || []).filter((item) => item.id !== reference.id) });
          change((p) => ({ ...p, links: p.links.filter((link) => !(link.from === reference.id && link.to === activeOnlineVideoNode.id)) }));
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
          const providerConfig = onlineProviderConfigs[config.provider || ""];
          if (!prompt) { setMessage("请先输入提示词，再进行优化或翻译。"); return; }
          if (config.provider !== "阿里百炼·万相" || !providerConfig?.apiKey) {
            openOnlineConfiguration("byok", "阿里百炼·万相");
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
            update({ prompt: result.trim() });
            setMessage(action === "translate" ? "提示词已翻译为英文。" : "提示词已优化，可直接生成。" );
          } catch (error) {
            const detail = String(error).replace(/^Error: /, "");
            addLog(`提示词${action === "translate" ? "翻译" : "优化"}：${detail}`);
            setMessage(`提示词${action === "translate" ? "翻译" : "优化"}失败：${detail}`);
          }
        };
        const nodeElement = document.querySelector<HTMLElement>(`article[data-node-id="${activeOnlineVideoNode.id}"]`);
        const nodeRect = nodeElement?.getBoundingClientRect();
        const panelWidth = Math.min(760, Math.max(520, window.innerWidth - 24));
        const nodeCenter = nodeRect ? nodeRect.left + nodeRect.width / 2 : panelWidth / 2;
        const panelLeft = Math.max(12, Math.min(nodeCenter - panelWidth / 2, window.innerWidth - panelWidth - 12));
        const panelTop = Math.max(12, (nodeRect?.bottom || 12) + 8);
        const source: GenerationSource = config.source || "byok";
        const comfyLibraryItems = readComfyWorkflowLibrary().filter((item) => item.apiContent || item.format === "api");
        const selectedComfyItem = comfyLibraryItems.find((item) => item.id === config.comfyWorkflowId);
        const publishedComfyParameters = (selectedComfyItem?.parameters || []).filter((parameter) => parameter.enabled && isBasicComfyParameter(parameter));
        const generateOnlineVideo = async () => {
          const prompt = [config.prompt || "", ...linkedTextInputs].filter((text) => text.trim()).join("\n\n").trim();
          if (!prompt) {
            setMessage(`请先写入视频提示词；也可以把文本或参考素材连接到${generationSourceLabel[source]}节点。`);
            return;
          }
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
            const apiContent = selectedComfyItem.apiContent || (selectedComfyItem.format === "api" ? selectedComfyItem.content : undefined);
            if (!apiContent) {
              setWorkflowLibraryOpen(true);
              setMessage("该工作流还没有 API 数据，请在工作流库中点击“扫描参数”。");
              return;
            }
            const configured = applyComfyParameters(apiContent, selectedComfyItem.parameters || [], config.comfyValues || {});
            const runnable = injectComfyPrompt(configured, prompt);
            setMessage(`正在运行本地视频工作流“${selectedComfyItem.name}”…`);
            await run(activeOnlineVideoNode.id, undefined, runnable);
            return;
          }
          if (source === "byok") {
            if (config.provider === "未选择平台") {
              openOnlineConfiguration("byok");
              setMessage("请先选择平台并保存自带 API Key。 ");
              return;
            }
            const savedProviderConfig = onlineProviderConfigs[config.provider || ""];
            const defaultProviderConfig = ONLINE_PROVIDER_DEFAULTS[config.provider || ""];
            const providerConfig = savedProviderConfig ? { ...defaultProviderConfig, ...savedProviderConfig } : undefined;
            if (!providerConfig?.endpoint || !providerConfig.apiKey || !providerConfig.model) {
              openOnlineConfiguration("byok", config.provider);
              setMessage(`请先完成“${config.provider}”的接口地址、密钥和模型配置。`);
              return;
            }
            if (config.provider === "可灵 Kling" && !providerConfig.apiSecret?.trim()) {
              openOnlineConfiguration("byok", config.provider);
              setMessage("可灵官方接口需要同时填写 Access Key 和 Secret Key。");
              return;
            }
            if (!["阿里百炼·万相", "可灵 Kling", "豆包·火山方舟"].includes(config.provider || "")) {
              setMessage(`“${config.provider}”还没有专用视频协议适配，请使用万相、可灵或豆包。`);
              return;
            }
            const mentionedReference = Array.from(prompt.matchAll(/@图片(\d+)/g))
              .map((match) => references[Number(match[1]) - 1])
              .find((item): item is OnlineReference => Boolean(item?.src && item.kind === "image"));
            const selectedImageReference = mentionedReference || references.find((item) => item.kind === "image" && Boolean(item.src));
            const imageModel = (model: string) => {
              if (!selectedImageReference || /i2v/i.test(model)) return model;
              if (/^wan2\.6/i.test(model)) return "wan2.6-i2v-flash";
              if (/^wan2\.5/i.test(model)) return "wan2.5-i2v-preview";
              if (/^wan2\.2/i.test(model)) return "wan2.2-i2v-plus";
              if (/^wanx?2\.1/i.test(model)) return "wanx2.1-i2v-turbo";
              return model;
            };
            const configuredModel = config.model || providerConfig.model;
            const requestModel = config.provider === "阿里百炼·万相" ? imageModel(configuredModel) : configuredModel;
            const selectedImageReferences = config.mode === "reference"
              ? references.filter((item) => item.kind === "image" && Boolean(item.src))
              : config.mode === "text" ? [] : selectedImageReference ? [selectedImageReference] : [];
            if (config.mode !== "text" && selectedImageReferences.length === 0) {
              setMessage(`“${CLOUD_VIDEO_MODE_LABELS[(config.mode || "text") as CloudVideoMode]}”需要先添加或连接图片参考。`);
              return;
            }
            const providerShortName = config.provider === "可灵 Kling" ? "可灵" : config.provider === "豆包·火山方舟" ? "豆包" : "万相";
            change((p) => ({ ...p, nodes: p.nodes.map((node) => node.id === activeOnlineVideoNode.id ? { ...node, status: "running" } : node) }));
            try {
              const { invoke } = await import("@tauri-apps/api/core");
              setMessage(selectedImageReferences.length
                ? `${providerShortName}正在使用 ${selectedImageReferences.length} 张参考图生成视频${linkedTextInputs.length ? `，并合并 ${linkedTextInputs.length} 个文本输入` : ""}…`
                : `${providerShortName}正在提交“${requestModel}”文生视频任务${linkedTextInputs.length ? `，已合并 ${linkedTextInputs.length} 个文本输入` : ""}。`);
              const result = await invoke<{ task_id: string; request_id?: string; video_url: string }>("generate_provider_video", {
                provider: config.provider,
                endpoint: providerConfig.endpoint,
                apiKey: providerConfig.apiKey,
                apiSecret: providerConfig.apiSecret || null,
                model: requestModel,
                prompt,
                mode: config.mode || "text",
                ratio: config.ratio || "16:9",
                quality: config.quality || "720P",
                duration: config.duration || 5,
                audio: config.audio !== false,
                imageUrls: selectedImageReferences.map((item) => item.src),
              });
              const [generatedWidth, generatedHeight] = onlineVideoSizeForRatio(config.ratio);
              const generated: NodeItem = {
                id: newId(), kind: "video", x: activeOnlineVideoNode.x + activeOnlineVideoNode.width + 80, y: activeOnlineVideoNode.y,
                width: generatedWidth, height: generatedHeight + 29, name: `${providerShortName}-${result.task_id}.mp4`, fileName: `${providerShortName}-${result.task_id}.mp4`, src: result.video_url, createdAt: Date.now(),
              };
              setRecent((items) => [generated, ...items]);
              setRecentOpen(true);
              change((p) => ({
                ...p,
                nodes: [
                  ...p.nodes.map((node) => node.id === activeOnlineVideoNode.id ? { ...node, status: "done" } : node),
                  generated,
                ],
                links: [...p.links, { id: newId(), from: activeOnlineVideoNode.id, to: generated.id }],
              }));
              setMessage(`${providerShortName}视频生成成功，已创建独立视频素材节点并连接到 AI 视频节点。`);
            } catch (error) {
              const detail = String(error).replace(/^Error: /, "");
              addLog(`${config.provider}：${detail}`);
              change((p) => ({ ...p, nodes: p.nodes.map((node) => node.id === activeOnlineVideoNode.id ? { ...node, status: "error" } : node) }));
              setMessage(`${providerShortName}生成失败：${detail}`);
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
          <button className="online-video-console-close" title="关闭" onClick={() => setActiveOnlineVideo(null)}>×</button>
          <div className="online-reference-dock" aria-label="参考素材">
            {references.length > 0 && <div className="online-reference-stack" title="鼠标移入展开全部参考素材">
              {references.slice(0, 6).map((item, index) => <div className="online-reference-stack-card" key={item.id} title={`@图片${index + 1} · ${item.name}`}>
                {item.kind === "video" ? <video src={item.src} muted playsInline /> : <img src={item.src} alt={item.name} />}
                <span className="online-reference-label">图片{index + 1}</span>
                <button aria-label={`移除 ${item.name}`} title="移除参考" onClick={() => removeReference(item)}>×</button>
              </div>)}
            </div>}
            <div className="online-reference-adders">
              <button className="online-reference-add canvas" title="从画布生成内容添加参考" aria-label="从画布生成内容添加参考" onClick={() => setOnlinePopover({ nodeId: activeOnlineVideoNode.id, kind: "reference" })}><strong>＋</strong><small>画布生成</small></button>
              <button className="online-reference-add computer" title="从电脑选择图片或视频参考" aria-label="从电脑选择图片或视频参考" onClick={() => onlineReferenceRef.current?.click()}><strong>＋</strong><small>电脑文件</small></button>
            </div>
            <div className="online-reference-actions">
              <button className="online-prompt-library-trigger online-prompt-library-trigger-inline" title="提示词库：动作、运镜、效果" onClick={() => setOnlinePopover(popover === "promptLibrary" ? null : { nodeId: activeOnlineVideoNode.id, kind: "promptLibrary" })}>提示词库</button>
              {references.length > 0 && <button className="online-at-reference-trigger" title="在提示词中引用上方参考图" onClick={() => setAtReferenceMenu({ nodeId: activeOnlineVideoNode.id, start: (config.prompt || "").length, end: (config.prompt || "").length })}>@图片</button>}
            </div>
          </div>
          {activeAtReference && references.length > 0 && <div className="online-at-reference-menu" onPointerDown={(event) => event.stopPropagation()}>
            <small>引用上方参考图</small>
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
            {popover === "promptLibrary" && <><b>提示词库</b><small>这里会保存你常用的动作、运镜和效果；点击关键词即可写入当前提示词。</small><div className="online-prompt-library-input"><input value={promptLibraryText} onChange={(event) => setPromptLibraryText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && promptLibraryText.trim()) { const entry = promptLibraryText.trim(); setPromptLibraryEntries((items) => { const next = [entry, ...items.filter((item) => item !== entry)].slice(0, 48); localStorage.setItem("yimu-prompt-library", JSON.stringify(next)); return next; }); setPromptLibraryText(""); } }} placeholder="保存常用提示词，如：镜头缓慢推进" /><button disabled={!promptLibraryText.trim()} onClick={() => { const entry = promptLibraryText.trim(); setPromptLibraryEntries((items) => { const next = [entry, ...items.filter((item) => item !== entry)].slice(0, 48); localStorage.setItem("yimu-prompt-library", JSON.stringify(next)); return next; }); setPromptLibraryText(""); }}>保存</button></div>{promptLibraryEntries.length > 0 && <div className="online-prompt-library online-prompt-library-saved"><div><strong>我的词库</strong>{promptLibraryEntries.map((item) => <span key={item}><button title="点击写入提示词" onClick={() => { appendPrompt(item); setOnlinePopover(null); }}>{item}</button><button className="online-prompt-delete" title="从词库删除" aria-label={`删除 ${item}`} onClick={() => setPromptLibraryEntries((items) => { const next = items.filter((saved) => saved !== item); localStorage.setItem("yimu-prompt-library", JSON.stringify(next)); return next; })}>×</button></span>)}</div></div>}<div className="online-prompt-library">{[
              ["动作", ["缓慢转身", "抬手凝望", "向前行走", "回眸微笑"]],
              ["运镜", ["镜头缓慢推进", "镜头缓慢拉远", "从左向右平移", "环绕主体运镜"]],
              ["效果", ["电影级光影", "慢动作", "粒子飞散", "胶片质感"]],
            ].map(([title, tokens]) => <div key={title as string}><strong>{title as string}</strong>{(tokens as string[]).map((item) => <button key={item} onClick={() => { appendPrompt(item); setOnlinePopover(null); }}>{item}</button>)}</div>)}</div></>}
          </div>}
          <textarea className="online-video-prompt" autoFocus value={config.prompt || ""} onChange={(event) => {
            const value = event.target.value;
            const caret = event.currentTarget.selectionStart ?? value.length;
            const match = value.slice(0, caret).match(/@[^\s，。；、,.!?]*$/);
            update({ prompt: value });
            if (match && references.length > 0) setAtReferenceMenu({ nodeId: activeOnlineVideoNode.id, start: caret - match[0].length, end: caret });
            else setAtReferenceMenu(null);
          }} onKeyDown={(event) => { if (event.key === "Escape") { setAtReferenceMenu(null); } else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); generateOnlineVideo(); } }} placeholder="描述你想要生成的画面内容，输入 @ 可引用上方图片" />
          <div className="online-video-consolebar">
            {source === "byok" && <select aria-label="平台" value={config.provider} onChange={(event) => {
              const provider = event.target.value;
              const saved = onlineProviderConfigs[provider];
              const defaults = ONLINE_PROVIDER_DEFAULTS[provider];
              const providerConfig = saved ? { ...defaults, ...saved } : defaults;
              const models = (providerConfig?.detectedModels || []).filter((model) => model.kind === "video");
              const model = models.find((item) => item.modes?.includes(cloudMode)) || models[0];
              const selectedModel = providerConfig?.model && !models.some((item) => item.id === providerConfig.model)
                ? { ...classifyProviderModel(providerConfig.model), modes: models[0]?.modes }
                : model;
              update({ provider, ...(selectedModel ? { model: selectedModel.id, mode: selectedModel.modes?.includes(cloudMode) ? cloudMode : selectedModel.modes?.[0] || cloudMode } : {}) });
            }}><option>未选择平台</option>{onlineProviderNames.map((provider) => <option key={provider}>{provider}</option>)}</select>}
            {source === "byok" && byokModels.length > 0 && <select className="cloud-video-model-select" aria-label="自带密钥视频模型" title={byokModel?.purpose} value={byokModel?.id || ""} onChange={(event) => {
              const model = byokModels.find((item) => item.id === event.target.value);
              update({ model: event.target.value, mode: model?.modes?.length && !model.modes.includes(cloudMode) ? model.modes[0] : cloudMode });
            }}>{byokModels.map((model) => <option value={model.id} key={model.id}>{model.id}｜{model.purpose}</option>)}</select>}
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
            <select aria-label="视频生成模式" value={config.mode} onChange={(event) => {
              const mode = event.target.value as CloudVideoMode;
              if (source === "byok" && byokModels.length) {
                if (byokModel?.modes?.includes(mode)) { update({ mode }); return; }
                const compatible = byokModels.find((model) => model.modes?.includes(mode));
                if (compatible) { update({ mode, model: compatible.id }); setMessage(`已自动切换到支持“${CLOUD_VIDEO_MODE_LABELS[mode]}”的 ${compatible.id}。`); }
                else setMessage(`该平台已识别的视频模型不支持“${CLOUD_VIDEO_MODE_LABELS[mode]}”。`);
                return;
              }
              if (source !== "cloud" || supportsCloudVideoMode(cloudModel, mode)) { update({ mode }); return; }
              const samePlatformModel = cloudModels.find((model) => supportsCloudVideoMode(model, mode));
              const compatibleModel = samePlatformModel || cloudModelsFor("video").find((model) => supportsCloudVideoMode(model, mode));
              update({ mode, provider: compatibleModel?.platform || cloudPlatform, model: compatibleModel?.id || cloudModel?.id });
              setMessage(compatibleModel ? `已自动切换到支持“${CLOUD_VIDEO_MODE_LABELS[mode]}”的 ${compatibleModel.label}。` : `当前云端模型暂不支持“${CLOUD_VIDEO_MODE_LABELS[mode]}”。`);
            }}>{Object.entries(modes).map(([value, label]) => <option value={value} key={value}>{label}{source === "cloud" && !supportsCloudVideoMode(cloudModel, value as CloudVideoMode) ? "（将自动换模型）" : ""}</option>)}</select>
            <div className="online-video-menu-anchor">
              <button className="online-video-params-trigger" title="视频参数" aria-label="视频参数" onClick={() => setOnlinePopover(popover === "params" ? null : { nodeId: activeOnlineVideoNode.id, kind: "params" })}>▭ {source === "comfy" ? `${selectedComfyItem?.name || "选择工作流"} · ${publishedComfyParameters.length}项参数` : `${config.ratio} · ${config.quality} · ${config.duration}s · ${config.amount}个 · ${config.audio ? "🔊" : "🔇"}`}⌄</button>
              {popover === "params" && <div className="online-video-floating-popover online-video-params-popover">
                <b>{source === "comfy" ? "ComfyUI 工作流参数" : "视频参数"}</b><small>{source === "comfy" ? "参数来自工作流库，只修改当前节点的运行副本。" : "比例、清晰度、时长、音频与生成数量。"}</small>
                {source === "comfy" ? <div className="online-comfy-parameter-list">
                  {!selectedComfyItem && <small>请先从下方选择一个工作流。</small>}
                  {selectedComfyItem && !publishedComfyParameters.length && <button onClick={() => setWorkflowLibraryOpen(true)}>到工作流库扫描参数</button>}
                  {publishedComfyParameters.map((parameter) => <label title={comfyParameterHelp(parameter)} key={parameter.id}><span>{parameter.label} <i className="comfy-help">?</i><small>{parameter.nodeTitle} · {parameter.input}</small></span>{parameter.kind === "boolean"
                    ? <select value={String(config.comfyValues?.[parameter.id] ?? parameter.value)} onChange={(event) => update({ comfyValues: { ...(config.comfyValues || {}), [parameter.id]: event.target.value === "true" } })}><option value="true">开启</option><option value="false">关闭</option></select>
                    : <input type={parameter.kind === "number" ? "number" : "text"} value={String(config.comfyValues?.[parameter.id] ?? parameter.value)} onChange={(event) => update({ comfyValues: { ...(config.comfyValues || {}), [parameter.id]: parameter.kind === "number" ? Number(event.target.value) : event.target.value } })} />}</label>)}
                </div> : <>
                <div className="online-param-section online-param-wide"><strong>比例</strong><div className="online-param-options online-param-ratios">{["Auto", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"].map((item) => <button className={config.ratio === item ? "active" : ""} key={item} onClick={() => update({ ratio: item })}>{item}</button>)}</div></div>
                <div className="online-param-section"><strong>清晰度</strong><div className="online-param-options">{["480P", "720P", "1080P", "4K"].map((item) => <button className={config.quality === item ? "active" : ""} key={item} onClick={() => update({ quality: item })}>{item}</button>)}</div></div>
                <div className="online-param-section"><strong>视频时长</strong><label className="online-duration-control"><input type="range" min="5" max="10" step="1" value={config.duration} onChange={(event) => update({ duration: Number(event.target.value) })} /><output>{config.duration} 秒</output></label></div>
                <div className="online-param-section"><strong>生成音频</strong><div className="online-param-options two"><button className={config.audio ? "active" : ""} onClick={() => update({ audio: true })}>开启</button><button className={!config.audio ? "active" : ""} onClick={() => update({ audio: false })}>关闭</button></div></div>
                <div className="online-param-section"><strong>生成数量</strong><div className="online-param-options three">{[1, 2, 4].map((item) => <button className={config.amount === item ? "active" : ""} key={item} onClick={() => update({ amount: item })}>{item}个</button>)}</div></div>
                </>}
              </div>}
            </div>
            <button className="online-video-icon-button" title="提示词优化" aria-label="提示词优化" onClick={() => void rewritePrompt("optimize")}>✧</button><button className="online-video-icon-button" title="翻译提示词为英文" aria-label="翻译提示词为英文" onClick={() => void rewritePrompt("translate")}>文</button><div className="online-video-menu-anchor"><button className="online-video-icon-button" title="生成来源设置" aria-label="生成来源设置" onClick={() => setOnlinePopover(popover === "settings" ? null : { nodeId: activeOnlineVideoNode.id, kind: "settings" })}>☷</button>{popover === "settings" && <div className="online-video-floating-popover online-video-source-popover"><b>生成设置</b><small>选择生成来源；密钥和云端的配置可在对应来源下继续设置。</small><div className="online-settings-sources"><button className={source === "comfy" ? "active" : ""} onClick={() => { update({ source: "comfy" }); setOnlinePopover(null); }}>本地 ComfyUI</button><button className={source === "byok" ? "active" : ""} onClick={() => { update({ source: "byok" }); setOnlinePopover(null); }}>自带密钥</button><button className={source === "cloud" ? "active" : ""} onClick={() => { const platform = cloudPlatforms[0]; update({ source: "cloud", provider: platform, model: defaultCloudModel("video", platform)?.id }); setOnlinePopover(null); }}>亿幕云端积分</button></div></div>}</div>
            {cloudEstimate && <div className="cloud-points-estimate" title={`${cloudEstimate.detail}；最终以服务端结算为准`}><small>输入 {cloudEstimate.input} + 输出 {cloudEstimate.output}</small><b>预计 {cloudEstimate.total} 积分</b></div>}
            <button className="online-video-generate" title="生成视频（Enter）" onClick={generateOnlineVideo}>生成 <span>↵</span></button>
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
          <textarea
            autoFocus
            value={activeTextNode.text || ""}
            onChange={(event) =>
              change((current) => ({
                ...current,
                nodes: current.nodes.map((node) =>
                  node.id === activeTextNode.id
                    ? { ...node, text: event.target.value }
                    : node,
                ),
              }))
            }
            placeholder="输入剧本、提示词、镜头说明或对白……"
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
                        { name: x.name, src: x.src },
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
              <div className="menu-submenu">
                <button className="menu-submenu-trigger">
                  <span>网络节点</span>
                  <span aria-hidden="true">›</span>
                </button>
                <div className="menu-submenu-panel">
                  <button
                    onClick={() => {
                      add("aiText", pastePoint.current || viewportCenter(), { name: "AI 剧本生成", workflow: { source: "byok", provider: "OpenAI", model: "gpt-4.1-mini", genre: "剧情短片", format: "标准影视剧本", length: "中篇", tone: "电影感", audience: "大众", language: "简体中文", creativity: 0.8, episodeCount: 1, episodeMinutes: 5, includeStoryboard: true, includeCharacters: true } satisfies AiTextSettings });
                      setMenu(null);
                    }}
                  >
                    AI 剧本生成
                  </button>
                  <button
                    onClick={() => {
                      add("aiImage", pastePoint.current || viewportCenter(), { name: "AI 图片生成", workflow: { source: "byok", provider: "OpenAI", model: "gpt-image-1", mode: "text", ratio: "16:9", resolution: "1024", amount: 1, style: "电影写实", seed: -1, guidance: 7 } satisfies AiImageSettings });
                      setMenu(null);
                    }}
                  >
                    AI 图片生成
                  </button>
                  <button
                    onClick={() => {
                      add("onlineVideo", pastePoint.current || viewportCenter(), { name: "AI 视频生成", workflow: { source: "byok", provider: "未选择平台", mode: "text", ratio: "16:9", quality: "720P", duration: 5, amount: 1, audio: true } satisfies OnlineVideoSettings });
                      setMenu(null);
                    }}
                  >
                    AI 视频生成
                  </button>
                </div>
              </div>
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
          node={activeAiNodeItem as NodeItem & { kind: "aiText" | "aiImage" }}
          referenceImages={activeAiReferences}
          canvasImages={canvasAiImages}
          onUpdate={(workflow) => change((current) => ({
            ...current,
            nodes: current.nodes.map((node) => node.id === activeAiNodeItem.id ? { ...node, workflow } : node),
          }))}
          onGenerate={() => void generateAiNode(activeAiNodeItem)}
          onClose={() => setActiveAiNode(null)}
          onOpenWorkflowLibrary={() => setWorkflowLibraryOpen(true)}
          onDescribeImage={(image) => describeAiTextImage(activeAiNodeItem, image)}
        />
      )}
      {activeComfyApiNode && isComfyCanvasWorkflow(activeComfyApiNode.workflow) && (() => {
        const workflow = activeComfyApiNode.workflow;
        const visibleParameters = workflow.parameters.filter((parameter) => parameter.enabled && isBasicComfyParameter(parameter));
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
          };
          addAtViewport("api", { name, workflow: packaged });
          setWorkflowLibraryOpen(false);
          setMessage(`已从工作流库添加：${name}`);
        }}
      />
      <MediaLibrary key={`media-library-${historyId}`}
        open={mediaLibraryOpen}
        onClose={() => setMediaLibraryOpen(false)}
        nodes={project.nodes}
        onDeleteNode={(id) => change((p) => ({ ...p, nodes: p.nodes.filter((n) => n.id !== id), links: p.links.filter((l) => l.from !== id && l.to !== id) }))}
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
        nodes={project.nodes}
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
    </main>
  );
}
