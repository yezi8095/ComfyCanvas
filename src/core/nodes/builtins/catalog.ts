import type { PortDataKind } from "../../graph/types";
import type { CanvasNodeKind, NodeDefinition } from "../types";

/**
 * Built-in node contracts are deliberately UI and provider agnostic.  Canvas
 * rendering, ComfyUI node ids and cloud model names must never leak in here.
 */
export const BUILTIN_NODE_DEFINITIONS = {
  text: {
    type: "text",
    version: 1,
    label: "文本 / 提示词",
    description: "输入提示词、旁白或普通文本，并把文本传给下游节点。",
    inputs: [
      {
        id: "context",
        label: "补充文本",
        kind: "text",
        direction: "input",
        multiple: true,
        description: "接收上游文本并作为当前内容的补充上下文。",
      },
      {
        id: "references",
        label: "图片参考",
        kind: "image",
        direction: "input",
        multiple: true,
        description: "作为人物、场景或风格参考；仅在支持视觉理解的下游流程中使用。",
      },
    ],
    outputs: [{ id: "text", label: "文本", kind: "text", direction: "output" }],
    basicControls: [{ id: "text", label: "正文", type: "textarea", defaultValue: "" }],
    advancedControls: [],
  },
  storyboard: {
    type: "storyboard",
    version: 1,
    label: "脚本 / 分镜",
    description: "整理镜头、画面、台词与参考图，并输出结构化分镜文本。",
    inputs: [
      { id: "script", label: "脚本文本", kind: "text", direction: "input" },
      {
        id: "references",
        label: "参考图片",
        kind: "image",
        direction: "input",
        multiple: true,
      },
    ],
    outputs: [{ id: "storyboard", label: "分镜文本", kind: "text", direction: "output" }],
    basicControls: [],
    advancedControls: [],
  },
  image: {
    type: "image",
    version: 1,
    label: "图片",
    description: "图片素材或图片生成结果。",
    inputs: [
      { id: "prompt", label: "生成提示词", kind: "text", direction: "input", multiple: true, description: "文本会自动作为图片生成提示词。" },
      { id: "references", label: "参考图片", kind: "image", direction: "input", multiple: true },
      { id: "source", label: "图片结果", kind: "image", direction: "input" },
    ],
    outputs: [{ id: "image", label: "图片", kind: "image", direction: "output" }],
    basicControls: [{ id: "asset", label: "图片", type: "asset" }],
    advancedControls: [],
  },
  video: {
    type: "video",
    version: 1,
    label: "视频",
    description: "视频素材或视频生成结果。",
    inputs: [
      { id: "prompt", label: "生成提示词", kind: "text", direction: "input", multiple: true, description: "文本会自动作为文生视频提示词。" },
      { id: "firstFrame", label: "首帧", kind: "image", direction: "input", description: "图生视频或首尾帧模式的首张图片。" },
      { id: "lastFrame", label: "尾帧", kind: "image", direction: "input", description: "首尾帧模式的结束图片。" },
      { id: "references", label: "参考图片", kind: "image", direction: "input", multiple: true, description: "图片会自动作为图生视频参考。" },
      { id: "source", label: "视频结果", kind: "video", direction: "input" },
    ],
    outputs: [{ id: "video", label: "视频", kind: "video", direction: "output" }],
    basicControls: [{ id: "asset", label: "视频", type: "asset" }],
    advancedControls: [],
  },
  audio: {
    type: "audio",
    version: 1,
    label: "音频",
    description: "音频素材或音频生成结果。",
    inputs: [{ id: "source", label: "音频结果", kind: "audio", direction: "input" }],
    outputs: [{ id: "audio", label: "音频", kind: "audio", direction: "output" }],
    basicControls: [{ id: "asset", label: "音频", type: "asset" }],
    advancedControls: [],
  },
  aiText: {
    type: "aiText",
    version: 1,
    label: "AI 剧本生成",
    description: "使用文本和图片参考生成剧本或其他长文本。",
    inputs: [
      { id: "prompt", label: "创作要求", kind: "text", direction: "input" },
      {
        id: "context",
        label: "文本上下文",
        kind: "text",
        direction: "input",
        multiple: true,
      },
      {
        id: "references",
        label: "图片参考",
        kind: "image",
        direction: "input",
        multiple: true,
        description: "人物、场景或风格参考；由支持视觉理解的模型读取。",
      },
    ],
    outputs: [{ id: "text", label: "生成文本", kind: "text", direction: "output" }],
    basicControls: [{ id: "prompt", label: "创作要求", type: "textarea", defaultValue: "" }],
    advancedControls: [],
  },
  aiImage: {
    type: "aiImage",
    version: 1,
    label: "AI 图片生成",
    description: "根据提示词和可选参考图生成图片。",
    inputs: [
      { id: "prompt", label: "提示词", kind: "text", direction: "input" },
      {
        id: "references",
        label: "参考图片",
        kind: "image",
        direction: "input",
        multiple: true,
      },
    ],
    outputs: [{ id: "image", label: "生成图片", kind: "image", direction: "output" }],
    basicControls: [
      { id: "prompt", label: "提示词", type: "textarea", defaultValue: "" },
      { id: "aspectRatio", label: "画面比例", type: "select", defaultValue: "16:9" },
    ],
    advancedControls: [],
  },
  onlineVideo: {
    type: "onlineVideo",
    version: 1,
    label: "AI 视频生成",
    description: "支持文生视频、首帧、首尾帧和多图参考视频。",
    inputs: [
      { id: "prompt", label: "提示词", kind: "text", direction: "input" },
      { id: "firstFrame", label: "首帧", kind: "image", direction: "input" },
      { id: "lastFrame", label: "尾帧", kind: "image", direction: "input" },
      {
        id: "references",
        label: "参考图片",
        kind: "image",
        direction: "input",
        multiple: true,
      },
    ],
    outputs: [{ id: "video", label: "生成视频", kind: "video", direction: "output" }],
    basicControls: [
      { id: "prompt", label: "提示词", type: "textarea", defaultValue: "" },
      { id: "duration", label: "时长", type: "number", defaultValue: 5 },
      { id: "aspectRatio", label: "画面比例", type: "select", defaultValue: "16:9" },
    ],
    advancedControls: [],
  },
  api: {
    type: "api",
    version: 1,
    label: "API 工作流",
    description: "承载外部或 ComfyUI 工作流；具体类型由导入的工作流接口进一步收窄。",
    inputs: [
      { id: "input", label: "工作流输入", kind: "any", direction: "input", multiple: true },
    ],
    outputs: [
      { id: "output", label: "工作流输出", kind: "any", direction: "output", multiple: true },
    ],
    basicControls: [],
    advancedControls: [],
  },
  batch: {
    type: "batch",
    version: 1,
    label: "批量收集",
    description: "收集多个兼容输入，并将批次传给下游。",
    inputs: [{ id: "items", label: "批次输入", kind: "any", direction: "input", multiple: true }],
    outputs: [{ id: "items", label: "批次输出", kind: "any", direction: "output", multiple: true }],
    basicControls: [],
    advancedControls: [],
  },
} as const satisfies Partial<Record<CanvasNodeKind, NodeDefinition>>;

export type BuiltinNodeKind = keyof typeof BUILTIN_NODE_DEFINITIONS;

export const getBuiltinNodeDefinition = (kind: CanvasNodeKind): NodeDefinition | undefined =>
  BUILTIN_NODE_DEFINITIONS[kind as BuiltinNodeKind];

export const listBuiltinNodeDefinitions = (): NodeDefinition[] =>
  Object.values(BUILTIN_NODE_DEFINITIONS);

/**
 * Old projects only stored node ids on links. These preferences make the
 * common legacy cases deterministic without guessing from localized labels.
 */
const LEGACY_INPUT_PREFERENCES: Partial<
  Record<CanvasNodeKind, Partial<Record<PortDataKind, string>>>
> = {
  text: { text: "context", image: "references" },
  storyboard: { text: "script", image: "references" },
  image: { text: "prompt", image: "references" },
  video: { text: "prompt", image: "firstFrame", video: "source" },
  audio: { audio: "source" },
  aiText: { text: "prompt", image: "references" },
  aiImage: { text: "prompt", image: "references" },
  onlineVideo: { text: "prompt", image: "firstFrame" },
  api: { any: "input" },
  batch: { any: "items" },
};

export const getLegacyPreferredInputPort = (
  targetKind: CanvasNodeKind,
  sourceKind: PortDataKind,
): string | undefined => {
  const preferences = LEGACY_INPUT_PREFERENCES[targetKind];
  return preferences?.[sourceKind] ?? preferences?.any;
};
