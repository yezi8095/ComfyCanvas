export type CloudModelKind = "text" | "image" | "video";
export type CloudVideoMode = "text" | "image" | "firstLast" | "reference";

export type CloudModel = {
  id: string;
  label: string;
  platform: string;
  kind: CloudModelKind;
  inputRate: number;
  outputRate: number;
  recommended?: boolean;
  description?: string;
  videoModes?: CloudVideoMode[];
};

// 亿幕产品积分目录。积分是平台内部的预估换算，不等同于供应商货币报价；
// 真正提交任务时应由服务端按任务快照重新报价并结算。
export const CLOUD_MODELS: CloudModel[] = [
  { id: "qwen/qwen-plus", label: "通义千问 Plus", platform: "阿里百炼", kind: "text", inputRate: 1.2, outputRate: 3.2, recommended: true },
  { id: "qwen/qwen-max", label: "通义千问 Max", platform: "阿里百炼", kind: "text", inputRate: 2.4, outputRate: 5.2 },
  { id: "openai/gpt-4.1-mini", label: "GPT-4.1 mini", platform: "OpenAI", kind: "text", inputRate: 1.5, outputRate: 4, recommended: true },
  { id: "openai/gpt-4.1", label: "GPT-4.1", platform: "OpenAI", kind: "text", inputRate: 3.2, outputRate: 7 },
  { id: "minimax/minimax-text-01", label: "MiniMax Text 01", platform: "MiniMax", kind: "text", inputRate: 1.3, outputRate: 3.5, recommended: true },

  { id: "jimeng/seedream-4.5", label: "Seedream 4.5", platform: "即梦", kind: "image", inputRate: 2, outputRate: 18, recommended: true },
  { id: "jimeng/seedream-4.0", label: "Seedream 4.0", platform: "即梦", kind: "image", inputRate: 1.5, outputRate: 14 },
  { id: "wan/wan2.6-image", label: "万相 2.6 Image", platform: "阿里百炼", kind: "image", inputRate: 2, outputRate: 16, recommended: true },
  { id: "wan/wan2.6-image-edit", label: "万相 2.6 Image Edit", platform: "阿里百炼", kind: "image", inputRate: 3, outputRate: 20 },
  { id: "openai/gpt-image-1", label: "GPT Image 1", platform: "OpenAI", kind: "image", inputRate: 3, outputRate: 24, recommended: true },
  { id: "openai/gpt-image-1-mini", label: "GPT Image 1 mini", platform: "OpenAI", kind: "image", inputRate: 2, outputRate: 14 },

  { id: "jimeng/seedance-2.0", label: "Seedance 2.0", platform: "即梦", kind: "video", inputRate: 3, outputRate: 42, recommended: true, videoModes: ["text", "image", "reference"], description: "文生、图生与多参考创作；适合复杂动作和参考素材一致性" },
  { id: "jimeng/seedance-1.5-pro", label: "Seedance 1.5 Pro", platform: "即梦", kind: "video", inputRate: 2.5, outputRate: 34, videoModes: ["text", "image"], description: "文生与首帧图生；适合常规短视频和稳定运动" },
  { id: "wan/wan2.6-t2v", label: "万相 2.6 文生视频", platform: "阿里百炼", kind: "video", inputRate: 2.5, outputRate: 32, recommended: true, videoModes: ["text"], description: "只支持文生视频；直接根据提示词创建画面" },
  { id: "wan/wan2.6-i2v-flash", label: "万相 2.6 图生视频 Flash", platform: "阿里百炼", kind: "video", inputRate: 3, outputRate: 27, videoModes: ["image"], description: "只支持图生视频；让一张首帧图片动起来" },
  { id: "minimax/hailuo-2.3", label: "海螺 2.3", platform: "MiniMax", kind: "video", inputRate: 3, outputRate: 36, recommended: true, videoModes: ["text", "image"], description: "支持文生与图生；擅长人物动作、表情和运镜指令" },
  { id: "minimax/hailuo-02", label: "海螺 02", platform: "MiniMax", kind: "video", inputRate: 2.5, outputRate: 30, videoModes: ["text", "image", "firstLast"], description: "支持文生、图生和首尾帧；适合明确控制起止画面" },
];

export const CLOUD_VIDEO_MODE_LABELS: Record<CloudVideoMode, string> = {
  text: "文生视频", image: "图生视频", firstLast: "首尾帧", reference: "多参考",
};

export const supportsCloudVideoMode = (model: CloudModel | undefined, mode: CloudVideoMode) =>
  Boolean(model?.kind === "video" && model.videoModes?.includes(mode));

export const cloudModelsFor = (kind: CloudModelKind, platform?: string) =>
  CLOUD_MODELS.filter((model) => model.kind === kind && (!platform || model.platform === platform));

export const cloudPlatformsFor = (kind: CloudModelKind) =>
  [...new Set(cloudModelsFor(kind).map((model) => model.platform))];

export const defaultCloudModel = (kind: CloudModelKind, platform: string) => {
  const models = cloudModelsFor(kind, platform);
  return models.find((model) => model.recommended) || models[0];
};

export type CloudPointEstimate = { input: number; output: number; total: number; detail: string };

export function estimateCloudPoints(kind: CloudModelKind, modelId: string | undefined, options: {
  promptLength?: number;
  references?: number;
  amount?: number;
  resolution?: string;
  duration?: number;
  audio?: boolean;
  episodeCount?: number;
  episodeMinutes?: number;
}): CloudPointEstimate {
  const model = CLOUD_MODELS.find((item) => item.id === modelId && item.kind === kind) || cloudModelsFor(kind)[0];
  const promptUnits = Math.max(1, Math.ceil((options.promptLength || 0) / 500));
  const references = Math.max(0, options.references || 0);
  const amount = Math.max(1, options.amount || 1);
  const input = Math.ceil(promptUnits * model.inputRate + references * model.inputRate * 2);
  let output = 1;
  let detail = "按生成量预估";
  if (kind === "text") {
    const outputUnits = Math.max(1, (options.episodeCount || 1) * (options.episodeMinutes || 5) * 0.8);
    output = Math.ceil(outputUnits * model.outputRate);
    detail = `按 ${options.episodeCount || 1} 集 × ${options.episodeMinutes || 5} 分钟估算`;
  } else if (kind === "image") {
    const resolutionMultiplier: Record<string, number> = { "1024": 1, "2048": 1.8, "4096": 3.4, "1K": 1, "2K": 1.8, "4K": 3.4 };
    const multiplier = resolutionMultiplier[options.resolution || "1024"] || 1;
    output = Math.ceil(model.outputRate * multiplier * amount);
    detail = `${options.resolution || "1K"} × ${amount} 张`;
  } else {
    const qualityMultiplier: Record<string, number> = { "480P": 0.7, "720P": 1, "1080P": 1.75, "4K": 4 };
    const seconds = Math.max(1, options.duration || 5);
    const multiplier = qualityMultiplier[options.resolution || "720P"] || 1;
    output = Math.ceil(model.outputRate * seconds * multiplier * amount * (options.audio ? 1.15 : 1));
    detail = `${options.resolution || "720P"} · ${seconds} 秒 × ${amount}${options.audio ? " · 含音频" : ""}`;
  }
  return { input, output, total: input + output, detail };
}
