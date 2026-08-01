export type ComfyParameter = {
  id: string;
  nodeId: string;
  input: string;
  nodeType: string;
  nodeTitle: string;
  label: string;
  value: string | number | boolean;
  kind: "text" | "number" | "boolean";
  enabled: boolean;
};

export type StoredComfyWorkflow = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  format: "workflow" | "api";
  content: unknown;
  apiContent?: unknown;
  parameters?: ComfyParameter[];
  createdAt: number;
  updatedAt: number;
};

export const COMFY_WORKFLOW_STORE = "ym-comfy-workflow-library-v1";

export const readComfyWorkflowLibrary = (): StoredComfyWorkflow[] => {
  try {
    const value = JSON.parse(localStorage.getItem(COMFY_WORKFLOW_STORE) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

export const apiGraph = (raw: unknown): Record<string, any> => {
  if (!raw || typeof raw !== "object") return {};
  const object = raw as Record<string, any>;
  return object.prompt && typeof object.prompt === "object" ? object.prompt : object;
};

const basicInput = /^(text|prompt|positive|positive_prompt|negative|negative_prompt|seed|noise_seed|steps|cfg|cfg_scale|sampler|sampler_name|scheduler|denoise|width|height|batch|batch_size|frames|frame_count|num_frames|fps|duration|strength)$/i;

export const isBasicComfyParameter = (parameter: Pick<ComfyParameter, "input" | "nodeTitle" | "nodeType">) => {
  if (basicInput.test(parameter.input)) return true;
  const context = `${parameter.nodeTitle} ${parameter.nodeType}`.toLowerCase();
  return parameter.input.toLowerCase() === "value" && /(prompt|提示词|尺寸|width|height|seed|steps|cfg|sampler|scheduler|denoise)/i.test(context);
};

export const comfyParameterHelp = (parameter: Pick<ComfyParameter, "input" | "nodeTitle">) => {
  const key = parameter.input.toLowerCase();
  const context = parameter.nodeTitle.toLowerCase();
  if (/negative/.test(key) || /negative|负面|反向/.test(context)) return "负面提示词：填写不希望画面中出现的内容，例如模糊、畸形、多余手指。";
  if (/text|prompt|positive/.test(key)) return "正向提示词：描述希望生成的主体、场景、动作、构图、光线与风格。";
  if (key === "width") return "输出宽度（像素）。数值越大越消耗显存，通常使用 64 的倍数。";
  if (key === "height") return "输出高度（像素）。数值越大越消耗显存，通常使用 64 的倍数。";
  if (/seed/.test(key)) return "随机种子：相同模型和参数下使用同一 Seed 可获得相近结果，-1 通常表示随机。";
  if (key === "steps") return "采样步数：越高通常细节越充分，但生成更慢；常用范围约 20–40。";
  if (/cfg/.test(key)) return "提示词引导强度：越高越服从提示词，过高可能导致画面生硬或失真。";
  if (/sampler/.test(key)) return "采样器：决定去噪方式和画面倾向，不确定时保留工作流默认值。";
  if (/scheduler/.test(key)) return "调度器：控制每一步的噪声变化节奏，通常与采样器搭配使用。";
  if (key === "denoise" || key === "strength") return "重绘强度：越低越保留参考图，越高变化越大。";
  if (/batch/.test(key)) return "一次生成的数量。数量越多，显存和等待时间越高。";
  if (/frames/.test(key)) return "视频总帧数。帧数越多视频越长，同时会增加显存与生成时间。";
  if (key === "fps") return "视频帧率：每秒显示的画面数量，常用 16、24 或 30。";
  if (key === "duration") return "生成视频的目标时长。实际支持范围由当前工作流决定。";
  return "该参数来自 ComfyUI 工作流。若不确定用途，请保留工作流默认值。";
};

const friendlyLabel = (input: string, nodeTitle: string) => {
  const key = input.toLowerCase();
  if (/negative/.test(key) || /negative|负面|反向/i.test(nodeTitle)) return "负面提示词";
  if (/^(text|prompt|positive|positive_prompt)$/.test(key)) return "正向提示词";
  const labels: Record<string, string> = { width: "宽度", height: "高度", seed: "随机种子", noise_seed: "随机种子", steps: "采样步数", cfg: "CFG 引导", cfg_scale: "CFG 引导", sampler: "采样器", sampler_name: "采样器", scheduler: "调度器", denoise: "重绘强度", strength: "重绘强度", batch: "生成数量", batch_size: "生成数量", frames: "视频帧数", frame_count: "视频帧数", num_frames: "视频帧数", fps: "视频帧率", duration: "视频时长" };
  return labels[key] || input;
};

export const scanComfyParameters = (raw: unknown): ComfyParameter[] => {
  const graph = apiGraph(raw);
  const result: ComfyParameter[] = [];
  Object.entries(graph).forEach(([nodeId, node]) => {
    if (!node || typeof node !== "object") return;
    Object.entries(node.inputs || {}).forEach(([input, value]) => {
      if (Array.isArray(value) || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")) return;
      const parameter: ComfyParameter = {
        id: `${nodeId}.${input}`,
        nodeId,
        input,
        nodeType: String(node.class_type || "Node"),
        nodeTitle: String(node._meta?.title || node.class_type || `节点 ${nodeId}`),
        label: friendlyLabel(input, String(node._meta?.title || node.class_type || "")),
        value,
        kind: typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "text",
        enabled: false,
      };
      parameter.enabled = isBasicComfyParameter(parameter);
      result.push(parameter);
    });
  });
  return result;
};

export const applyComfyParameters = (raw: unknown, parameters: ComfyParameter[], values: Record<string, string | number | boolean> = {}) => {
  const cloned = structuredClone(raw) as Record<string, any>;
  const graph = apiGraph(cloned);
  parameters.filter((parameter) => parameter.enabled).forEach((parameter) => {
    const node = graph[parameter.nodeId];
    if (node?.inputs && parameter.input in node.inputs) node.inputs[parameter.input] = values[parameter.id] ?? parameter.value;
  });
  return cloned;
};

export const injectComfyPrompt = (raw: unknown, prompt: string) => {
  if (!prompt.trim()) return raw;
  const cloned = structuredClone(raw) as Record<string, any>;
  const graph = apiGraph(cloned);
  const candidates: Array<{ score: number; node: any; key: string }> = [];
  Object.values(graph).forEach((node: any) => Object.entries(node?.inputs || {}).forEach(([key, value]) => {
    if (typeof value !== "string") return;
    const lower = key.toLowerCase();
    let score = 0;
    if (["positive", "positive_prompt", "prompt", "text"].includes(lower)) score += 10;
    if (/cliptextencode|prompt|text/.test(String(node.class_type || "").toLowerCase())) score += 4;
    if (/negative/.test(lower) || /negative/.test(String(node._meta?.title || "").toLowerCase())) score -= 12;
    if (score > 0) candidates.push({ score, node, key });
  }));
  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0]) candidates[0].node.inputs[candidates[0].key] = prompt;
  return cloned;
};
