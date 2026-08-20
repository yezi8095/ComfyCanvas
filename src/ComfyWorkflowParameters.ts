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
  /** Snapshot of /object_info taken when the workflow was scanned.  It is
   * informational only: execution always reads the current ComfyUI schema. */
  interface?: ComfyWorkflowInterface;
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

// The composer is intentionally quiet: only controls a creator normally needs
// before pressing Generate. Sampling / VAE tuning stays in the workflow library.
const basicInput = /^(text|prompt|positive|positive_prompt|negative|negative_prompt|width|height|frames|frame_count|num_frames|fps|duration|ckpt_name|checkpoint|model|model_name|unet_name)$/i;

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

export type ComfyMediaKind = "image" | "video" | "audio";
export type ComfyValueKind = ComfyMediaKind | "text" | "latent" | "unknown";

export type ComfySlot = {
  name: string;
  type: string;
  required?: boolean;
  linked?: boolean;
  options?: Record<string, unknown>;
  choices?: string[];
};

export type ComfyWorkflowInterface = {
  nodes: Record<string, {
    title: string;
    classType: string;
    /** True only when the live /object_info schema declares an output node. */
    outputNode: boolean;
    /** False means this node was not present in the latest /object_info response. */
    schemaKnown: boolean;
    inputs: ComfySlot[];
    outputs: ComfySlot[];
  }>;
  scannedAt: number;
};

export type ComfyWorkflowDiagnostic = {
  level: "error" | "warning" | "info";
  message: string;
  /** Stable identifier for UI badges / future localization. */
  code?: string;
  /** Exact node and slot that caused the diagnostic, when applicable. */
  nodeId?: string;
  input?: string;
  sourceNodeId?: string;
  sourceOutputIndex?: number;
  expectedType?: string;
  actualType?: string;
};

export type ComfyInputBinding = {
  kind: "text" | ComfyMediaKind;
  nodeId: string;
  input: string;
};

type ComfyApiNode = {
  class_type?: string;
  inputs?: Record<string, unknown>;
  _meta?: { title?: string };
};

type ComfyApiGraph = Record<string, ComfyApiNode>;

export type ComfyObjectInfo = Record<string, {
  input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> };
  output?: string[];
  output_name?: string[];
  /** Present in modern ComfyUI object_info for classes with OUTPUT_NODE = True. */
  output_node?: boolean;
  /** Tolerate custom servers that serialize the same flag in camelCase. */
  outputNode?: boolean;
  is_output_node?: boolean;
}>;

export type ComfyOutputTarget = {
  nodeId: string;
  classType: string;
  title: string;
  /** Always true: output targets only come from the current /object_info. */
  declaredBySchema: true;
  /** Media types exposed by the output node's live input/output contract. */
  mediaKinds: ComfyMediaKind[];
};

const linkedNode = (value: unknown): [string, number] | undefined =>
  Array.isArray(value) && value.length >= 2 && (typeof value[0] === "string" || typeof value[0] === "number") && typeof value[1] === "number"
    ? [String(value[0]), value[1]]
    : undefined;

const title = (node: ComfyApiNode) => String(node._meta?.title || node.class_type || "节点");

const valueKind = (type: unknown): ComfyValueKind => {
  const normalized = String(type || "").toUpperCase();
  if (normalized === "IMAGE" || normalized === "MASK") return "image";
  if (normalized === "VIDEO") return "video";
  if (normalized === "AUDIO") return "audio";
  if (normalized === "LATENT") return "latent";
  if (normalized === "STRING" || normalized === "TEXT") return "text";
  return "unknown";
};

const schemaType = (definition: unknown) => {
  if (!Array.isArray(definition)) return "*";
  // ComfyUI represents upload/file/model combo widgets as
  // [["choice-a", "choice-b"], { ...options }]. They are literal COMBO
  // values, not a connection type and not String(array).
  return Array.isArray(definition[0]) ? "COMBO" : String(definition[0] || "*");
};

// ComfyUI puts many fields in the `required` schema group even though they
// already have a usable default (for example Ollama Options → stop: "").
// Such fields must be shown as editable, but must not prevent a workflow from
// running unless the node explicitly asks the caller to provide a value.
const schemaOptions = (definition: unknown): Record<string, unknown> => {
  if (!Array.isArray(definition)) return {};
  const options = definition[1];
  return options && typeof options === "object" && !Array.isArray(options)
    ? options as Record<string, unknown>
    : {};
};

const needsExplicitInput = (definition: unknown) => {
  const options = schemaOptions(definition);
  return options.forceInput === true || !Object.prototype.hasOwnProperty.call(options, "default");
};

/** Build the interface from ComfyUI's real /object_info schema, not node names. */
export const scanComfyWorkflowInterface = (rawGraph: unknown, objectInfo: ComfyObjectInfo = {}): ComfyWorkflowInterface => {
  const graph = apiGraph(rawGraph) as ComfyApiGraph;
  const nodes: ComfyWorkflowInterface["nodes"] = {};
  Object.entries(graph).forEach(([id, node]) => {
    const classType = String(node.class_type || "");
    const schema = objectInfo[classType];
    const schemaKnown = Boolean(schema);
    const inputGroups: Array<[Record<string, unknown>, boolean]> = [
      [schema?.input?.required || {}, true],
      [schema?.input?.optional || {}, false],
    ];
    const schemaInputs = inputGroups.flatMap(([group, requiredGroup]) => Object.entries(group).map(([name, definition]) => ({
      name,
      type: schemaType(definition),
      required: requiredGroup && needsExplicitInput(definition),
      linked: Boolean(linkedNode(node.inputs?.[name])),
      options: schemaOptions(definition),
      choices: Array.isArray(definition) && Array.isArray(definition[0])
        ? definition[0].map(String)
        : undefined,
    })));
    // API JSON can contain custom-node inputs that an older /object_info does not
    // know yet. Keep them visible, but never pretend their type is compatible.
    Object.keys(node.inputs || {}).forEach((name) => {
      if (!schemaInputs.some((input) => input.name === name)) schemaInputs.push({ name, type: "*", required: false, linked: Boolean(linkedNode(node.inputs?.[name])), options: {}, choices: undefined });
    });
    nodes[id] = {
      title: title(node),
      classType,
      outputNode: Boolean(schema?.output_node || schema?.outputNode || schema?.is_output_node),
      schemaKnown,
      inputs: schemaInputs,
      outputs: (schema?.output || []).map((type, index) => ({ name: schema.output_name?.[index] || String(type), type: String(type) })),
    };
  });
  return { nodes, scannedAt: Date.now() };
};

const compatible = (source: string, target: string) => source === "*" || target === "*" || source.toUpperCase() === target.toUpperCase();

const isMissingValue = (value: unknown) => value === undefined || value === null || value === "";

type PromptBindingDiscovery = {
  bindings: ComfyInputBinding[];
  diagnostic?: ComfyWorkflowDiagnostic;
};

const promptKeyScore = (key: string) => {
  const lower = key.toLowerCase();
  if (/negative|neg_prompt|反向|负面/.test(lower)) return -1000;
  if (["positive", "positive_prompt", "prompt"].includes(lower)) return 80;
  if (lower === "text") return 55;
  if (/^(positive|prompt|text)(_|$)/.test(lower)) return 40;
  return 0;
};

/**
 * Finds the positive STRING/TEXT slot from the live schema.  This deliberately
 * does not use node class names or saved interface snapshots.  A tied choice
 * across different nodes is reported instead of silently writing a prompt to
 * whichever object happened to be enumerated first.
 */
const discoverLivePromptBindings = (rawGraph: unknown, objectInfo: ComfyObjectInfo): PromptBindingDiscovery => {
  const graph = apiGraph(rawGraph) as ComfyApiGraph;
  if (!objectInfo || !Object.keys(objectInfo).length) {
    return {
      bindings: [],
      diagnostic: {
        level: "error",
        code: "object-info-required",
        message: "未读取到 ComfyUI 的 /object_info，不能安全识别正向提示词 STRING/TEXT 插槽；已阻止提交，避免画布文字被静默丢弃。",
      },
    };
  }
  const iface = scanComfyWorkflowInterface(graph, objectInfo);
  const candidates: Array<{ nodeId: string; input: string; score: number }> = [];

  Object.entries(graph).forEach(([nodeId, node]) => {
    const scanned = iface.nodes[nodeId];
    if (!node || !scanned?.schemaKnown) return;
    scanned.inputs.forEach((slot) => {
      if (valueKind(slot.type) !== "text" || slot.linked) return;
      let score = promptKeyScore(slot.name);
      if (score <= 0) return;

      // A generic `text` input becomes unambiguous when the node's actual
      // output is connected to a live downstream positive/negative slot.
      Object.entries(graph).forEach(([targetNodeId, targetNode]) => {
        const targetInterface = iface.nodes[targetNodeId];
        Object.entries(targetNode.inputs || {}).forEach(([targetInput, value]) => {
          const link = linkedNode(value);
          if (!link || link[0] !== nodeId) return;
          const targetSlot = targetInterface?.inputs.find((item) => item.name === targetInput);
          const lower = targetSlot?.name.toLowerCase() || targetInput.toLowerCase();
          if (/negative|neg_prompt|反向|负面/.test(lower)) score -= 200;
          if (/positive|pos_prompt|正向/.test(lower)) score += 120;
        });
      });
      if (score > 0) candidates.push({ nodeId, input: slot.name, score });
    });
  });

  if (!candidates.length) {
    return {
      bindings: [],
      diagnostic: {
        level: "error",
        code: "prompt-slot-unbound",
        message: "当前 /object_info 没有确认可写入的正向 STRING/TEXT 插槽；已阻止提交，避免画布提示词没有进入工作流。",
      },
    };
  }

  const highestScore = Math.max(...candidates.map((candidate) => candidate.score));
  const best = candidates.filter((candidate) => candidate.score === highestScore);
  const nodeIds = new Set(best.map((candidate) => candidate.nodeId));
  if (nodeIds.size > 1) {
    return {
      bindings: [],
      diagnostic: {
        level: "error",
        code: "prompt-slot-ambiguous",
        message: `当前 /object_info 找到多个同等优先级的正向提示词槽（${best.map((candidate) => `#${candidate.nodeId}.${candidate.input}`).join("、")}）；已阻止提交，避免把文字写入错误分支。`,
      },
    };
  }
  // SDXL-style nodes can expose several equally valid text fields on the same
  // node (for example text_g/text_l). Those fields represent one live prompt
  // contract, so write the same prompt to all of them rather than dropping one.
  return { bindings: best.map((candidate) => ({ kind: "text", nodeId: candidate.nodeId, input: candidate.input })) };
};

const applyPromptBindings = (graph: ComfyApiGraph, bindings: ComfyInputBinding[], prompt: string) => {
  bindings.forEach((binding) => {
    const node = graph[binding.nodeId];
    if (!node) return;
    node.inputs ||= {};
    node.inputs[binding.input] = prompt;
  });
};

/** Exposed for API-workflow tools that need the same live prompt contract. */
export const discoverComfyPromptBindings = (rawGraph: unknown, objectInfo: ComfyObjectInfo = {}) =>
  discoverLivePromptBindings(rawGraph, objectInfo);

export const injectComfyPrompt = (raw: unknown, prompt: string, objectInfo: ComfyObjectInfo = {}) => {
  if (!prompt.trim()) return raw;
  const cloned = structuredClone(raw) as Record<string, any>;
  const graph = apiGraph(cloned) as ComfyApiGraph;
  const discovered = discoverLivePromptBindings(graph, objectInfo);
  if (discovered.bindings.length) applyPromptBindings(graph, discovered.bindings, prompt);
  return cloned;
};

const mediaSlot = (slot: ComfySlot) => {
  const kind = valueKind(slot.type);
  return kind === "image" || kind === "video" || kind === "audio";
};

const mediaContractKinds = (nodeId: string, iface: ComfyWorkflowInterface) => {
  const node = iface.nodes[nodeId];
  if (!node) return [] as ComfyMediaKind[];
  return [...new Set([...node.inputs, ...node.outputs]
    .map((slot) => valueKind(slot.type))
    .filter((kind): kind is ComfyMediaKind => kind === "image" || kind === "video" || kind === "audio"))];
};

/**
 * Finds only output nodes that can actually return media to the canvas.
 *
 * Both conditions must come from the current `/object_info`: the
 * `output_node` declaration and at least one IMAGE/VIDEO/AUDIO input or
 * output. We intentionally do not fall back to class names, even for familiar
 * saver names, because a changed custom node can otherwise send an unrelated
 * VAE/preview branch back to the canvas.
 */
export const discoverComfyOutputTargets = (rawGraph: unknown, objectInfo: ComfyObjectInfo = {}) => {
  const graph = apiGraph(rawGraph) as ComfyApiGraph;
  const iface = scanComfyWorkflowInterface(graph, objectInfo);
  const targets: ComfyOutputTarget[] = [];
  const diagnostics: ComfyWorkflowDiagnostic[] = [];

  Object.entries(graph).forEach(([nodeId, node]) => {
    const scanned = iface.nodes[nodeId];
    const declaredBySchema = Boolean(scanned?.outputNode);
    const mediaKinds = mediaContractKinds(nodeId, iface);
    if (declaredBySchema && mediaKinds.length) {
      targets.push({
        nodeId,
        classType: String(node.class_type || ""),
        title: scanned?.title || title(node),
        declaredBySchema: true,
        mediaKinds,
      });
      return;
    }
    if (declaredBySchema && !mediaKinds.length) {
      diagnostics.push({
        level: "warning",
        code: "output-node-without-media-contract",
        nodeId,
        message: `节点“${scanned?.title || title(node)}”被 ComfyUI 标记为输出节点，但当前 /object_info 没有暴露图片、视频或音频插槽；不会把它误当成画布媒体结果。`,
      });
    }
  });

  if (!targets.length) {
    diagnostics.push({
      level: "error",
      code: "missing-media-output",
      message: "工作流没有可回流到画布的真实媒体输出节点。请连接会把文件写入 ComfyUI output 目录的图片、视频或音频保存节点，并确认该节点在当前 /object_info 中声明为 output_node。仅用于临时查看的 Preview 节点不会作为最终画布素材。",
    });
  }
  return { interface: iface, targets, diagnostics };
};

/** Exact media groups returned by ComfyUI's `/history` contract. */
export type ComfyHistoryOutputFile = {
  filename: string;
  subfolder?: string;
  type?: string;
  fullpath?: string;
};

export type ComfyHistoryOutputs = Record<string, {
  images?: ComfyHistoryOutputFile[];
  /** ComfyUI places animated/video-combine results in this historical group. */
  gifs?: ComfyHistoryOutputFile[];
  videos?: ComfyHistoryOutputFile[];
  audio?: ComfyHistoryOutputFile[];
}>;

export type ComfyHistoryMedia = {
  outputNodeId: string;
  kind: ComfyMediaKind;
  file: ComfyHistoryOutputFile;
};

export type ComfyHistoryMediaDiscard = ComfyHistoryMedia & {
  reason: "intermediate-file" | "unverified-file" | "video-companion" | "duplicate-file";
};

export type ComfyHistoryMediaSelection = {
  media: ComfyHistoryMedia[];
  discarded: ComfyHistoryMediaDiscard[];
};

const mediaKindForHistoryFile = (fallback: ComfyMediaKind, file: ComfyHistoryOutputFile): ComfyMediaKind => {
  // Most Comfy nodes use the documented history groups. Some third-party
  // video savers (including MiniMax variants) however place MP4 files inside
  // `images`. Keep the verified output-node boundary, but correct that known
  // payload inconsistency before the canvas chooses an <img> or <video> tag.
  const filename = file.filename.toLowerCase().split("?")[0];
  if (/\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(filename)) return "video";
  if (/\.(wav|mp3|ogg|m4a|aac|flac)$/i.test(filename)) return "audio";
  return fallback;
};

const historyFileLocation = (file: ComfyHistoryOutputFile) => String(file.type || "").trim().toLowerCase();

const historyFileIdentity = (file: ComfyHistoryOutputFile) => [
  String(file.subfolder || "").replace(/\\/g, "/").toLowerCase(),
  file.filename.toLowerCase().split("?")[0],
  historyFileLocation(file),
].join("\u0000");

/**
 * Selects final canvas assets from the exact `/history` nodes chosen by the
 * caller. ComfyUI marks PreviewImage and unsaved VHS previews as `type: temp`;
 * those files are useful inside ComfyUI but are not durable workflow results.
 *
 * A verified live-schema target may omit `type`, so that legacy payload remains
 * accepted. Compatibility fallback is intentionally stricter and can require
 * an explicit `type: output` before an otherwise unknown custom node is allowed
 * to create a canvas asset.
 */
export const selectComfyHistoryMedia = (
  outputs: ComfyHistoryOutputs | undefined,
  outputTargets: readonly string[],
  options: { requireExplicitOutputType?: boolean } = {},
): ComfyHistoryMediaSelection => {
  if (!outputs || !outputTargets.length) return { media: [], discarded: [] };
  const media: ComfyHistoryMedia[] = [];
  const discarded: ComfyHistoryMediaDiscard[] = [];
  const seen = new Set<string>();
  [...new Set(outputTargets)].forEach((outputNodeId) => {
    const output = outputs[outputNodeId];
    if (!output) return;
    const candidates: ComfyHistoryMedia[] = [];
    (output.images || []).forEach((file) => candidates.push({ outputNodeId, kind: mediaKindForHistoryFile("image", file), file }));
    // `/history` uses `gifs` for animated image/video-combine artifacts. In
    // the canvas they need the playable video card rather than a still image.
    (output.gifs || []).forEach((file) => candidates.push({ outputNodeId, kind: mediaKindForHistoryFile("video", file), file }));
    (output.videos || []).forEach((file) => candidates.push({ outputNodeId, kind: mediaKindForHistoryFile("video", file), file }));
    (output.audio || []).forEach((file) => candidates.push({ outputNodeId, kind: mediaKindForHistoryFile("audio", file), file }));

    const durable = candidates.filter((candidate) => {
      const location = historyFileLocation(candidate.file);
      if (["temp", "temporary", "preview", "input"].includes(location)) {
        discarded.push({ ...candidate, reason: "intermediate-file" });
        return false;
      }
      if (options.requireExplicitOutputType && location !== "output") {
        discarded.push({ ...candidate, reason: "unverified-file" });
        return false;
      }
      return true;
    });

    // A video-combine saver can report its thumbnail or source audio beside the
    // muxed MP4. They are artifacts of the same output operation, not separate
    // final assets. An independent SaveAudio node still has its own node id and
    // therefore remains eligible for a canvas audio card.
    const hasFinalVideo = durable.some((candidate) => candidate.kind === "video");
    durable.forEach((candidate) => {
      if (hasFinalVideo && candidate.kind !== "video") {
        discarded.push({ ...candidate, reason: "video-companion" });
        return;
      }
      const identity = historyFileIdentity(candidate.file);
      if (seen.has(identity)) {
        discarded.push({ ...candidate, reason: "duplicate-file" });
        return;
      }
      seen.add(identity);
      media.push(candidate);
    });
  });
  return { media, discarded };
};

/** Backward-compatible convenience wrapper used by tests and library callers. */
export const collectComfyHistoryMedia = (
  outputs: ComfyHistoryOutputs | undefined,
  outputTargets: readonly string[],
): ComfyHistoryMedia[] => selectComfyHistoryMedia(outputs, outputTargets).media;

const diagnoseLinkedInput = (
  graph: ComfyApiGraph,
  iface: ComfyWorkflowInterface,
  nodeId: string,
  node: ComfyApiNode,
  input: ComfySlot,
  value: unknown,
): ComfyWorkflowDiagnostic[] => {
  const link = linkedNode(value);
  if (!link) return [];
  const source = graph[link[0]];
  if (!source) {
    return [{
      level: "error",
      code: "source-node-missing",
      nodeId,
      input: input.name,
      sourceNodeId: link[0],
      sourceOutputIndex: link[1],
      expectedType: input.type,
      message: `连线错误：节点“${title(node)}”的“${input.name}”(${input.type}) 指向不存在的源节点“${link[0]}”。请重新连接该插槽。`,
    }];
  }
  const sourceInterface = iface.nodes[link[0]];
  if (!sourceInterface?.schemaKnown) {
    return [{
      level: "warning",
      code: "source-schema-unavailable",
      nodeId,
      input: input.name,
      sourceNodeId: link[0],
      sourceOutputIndex: link[1],
      expectedType: input.type,
      message: `无法从当前 /object_info 验证“${sourceInterface?.title || title(source)}”输出槽 #${link[1]} 的类型；请刷新 ComfyUI 节点信息后再检查“${title(node)}”的“${input.name}”。`,
    }];
  }
  const sourceSlot = sourceInterface.outputs[link[1]];
  if (!sourceSlot) {
    return [{
      level: "error",
      code: "source-output-missing",
      nodeId,
      input: input.name,
      sourceNodeId: link[0],
      sourceOutputIndex: link[1],
      expectedType: input.type,
      message: `连线错误：节点“${sourceInterface.title}”没有输出槽 #${link[1]}，不能连接到“${title(node)}”的“${input.name}”(${input.type})。`,
    }];
  }
  if (!iface.nodes[nodeId]?.schemaKnown) {
    return [{
      level: "warning",
      code: "target-schema-unavailable",
      nodeId,
      input: input.name,
      sourceNodeId: link[0],
      sourceOutputIndex: link[1],
      actualType: sourceSlot.type,
      message: `无法从当前 /object_info 验证“${title(node)}”的“${input.name}”是否接受 ${sourceSlot.type}；请刷新节点信息后再检查。`,
    }];
  }
  if (!compatible(sourceSlot.type, input.type)) {
    return [{
      level: "error",
      code: "slot-type-mismatch",
      nodeId,
      input: input.name,
      sourceNodeId: link[0],
      sourceOutputIndex: link[1],
      expectedType: input.type,
      actualType: sourceSlot.type,
      message: `连线错误：节点“${sourceInterface.title}”输出 ${sourceSlot.type}，不能接到“${title(node)}”的“${input.name}”(${input.type})；请改接同类型插槽。`,
    }];
  }
  return [];
};

const validateOutputInputs = (
  graph: ComfyApiGraph,
  iface: ComfyWorkflowInterface,
  targets: ComfyOutputTarget[],
): ComfyWorkflowDiagnostic[] => {
  const diagnostics: ComfyWorkflowDiagnostic[] = [];
  targets.forEach((target) => {
    const node = graph[target.nodeId];
    const scanned = iface.nodes[target.nodeId];
    if (!node || !scanned) return;
    if (!scanned.schemaKnown) {
      diagnostics.push({
        level: "warning",
        code: "output-schema-unavailable",
        nodeId: target.nodeId,
        message: `输出节点“${target.title}”未出现在当前 /object_info 中；画布会保留它作为真实输出，但无法自动验证其媒体输入。`,
      });
      return;
    }
    scanned.inputs.filter(mediaSlot).forEach((input) => {
      const value = node.inputs?.[input.name];
      if (input.required && isMissingValue(value)) {
        diagnostics.push({
          level: "error",
          code: "output-media-input-missing",
          nodeId: target.nodeId,
          input: input.name,
          expectedType: input.type,
          message: `输出节点“${target.title}”缺少媒体输入“${input.name}”(${input.type})，因此没有可回流的结果。请把同类型生成分支连接到这个插槽。`,
        });
      }
    });
  });
  return diagnostics;
};

/**
 * Validates the exact graph that is about to be queued.  It scans current
 * `/object_info` every time, so no stale node IDs or saved interface snapshots
 * participate in the decision.
 */
export const validateComfyWorkflow = (rawGraph: unknown, objectInfo: ComfyObjectInfo = {}) => {
  const graph = apiGraph(rawGraph) as ComfyApiGraph;
  const discovered = discoverComfyOutputTargets(graph, objectInfo);
  const iface = discovered.interface;
  const diagnostics: ComfyWorkflowDiagnostic[] = [...discovered.diagnostics];
  Object.entries(graph).forEach(([nodeId, node]) => {
    const scanned = iface.nodes[nodeId];
    if (!scanned?.schemaKnown) {
      diagnostics.push({
        level: "warning",
        code: "node-schema-unavailable",
        nodeId,
        message: `节点“${title(node)}”未在当前 /object_info 中找到；已保留原始工作流，但其插槽类型无法自动校验。`,
      });
    }
    for (const input of scanned?.inputs || []) {
      const value = node.inputs?.[input.name];
      if (input.required && isMissingValue(value)) {
        diagnostics.push({
          level: "error",
          code: "required-input-missing",
          nodeId,
          input: input.name,
          expectedType: input.type,
          message: `节点“${title(node)}”缺少必需输入“${input.name}”（${input.type}），请连接或填写该插槽。`,
        });
      }
      diagnostics.push(...diagnoseLinkedInput(graph, iface, nodeId, node, input, value));
    }
  });
  diagnostics.push(...validateOutputInputs(graph, iface, discovered.targets));
  return { interface: iface, diagnostics, outputTargets: discovered.targets.map((target) => target.nodeId) };
};

/**
 * Determines which existing *real* output nodes should be partially executed.
 * It deliberately does not fabricate VAE/Audio/Preview branches: an
 * unconnected output has no trustworthy way to identify a matching generation
 * branch, so `validateComfyWorkflow` reports the exact missing slot instead.
 */
export const prepareComfyVisualOutput = (rawGraph: unknown, objectInfo: ComfyObjectInfo = {}) => {
  const graph = structuredClone(apiGraph(rawGraph)) as ComfyApiGraph;
  const discovered = discoverComfyOutputTargets(graph, objectInfo);
  const diagnostics = discovered.diagnostics.filter((diagnostic) => diagnostic.code !== "missing-media-output");
  return {
    graph,
    diagnostics,
    interface: discovered.interface,
    outputTargets: discovered.targets.map((target) => target.nodeId),
  };
};

/** Applies canvas inputs only to compatible literal ComfyUI fields. */
export const bindCanvasInputsToComfyWorkflow = (
  rawGraph: unknown,
  input: { text?: string; image?: string[]; video?: string[]; audio?: string[] },
  objectInfo: ComfyObjectInfo = {},
) => {
  const graph = structuredClone(apiGraph(rawGraph)) as ComfyApiGraph;
  const iface = scanComfyWorkflowInterface(graph, objectInfo);
  const bindings: ComfyInputBinding[] = [];
  const diagnostics: ComfyWorkflowDiagnostic[] = [];
  const mediaIndexes: Record<ComfyMediaKind, number> = { image: 0, video: 0, audio: 0 };
  const media = {
    image: input.image || [],
    video: input.video || [],
    audio: input.audio || [],
  };

  // Upload names only go into a live schema slot that explicitly advertises an
  // upload capability. This handles standard LoadImage's `image_upload` COMBO
  // and custom loaders without ever using a node name or blindly writing a
  // model/file COMBO that merely happens to be a string.
  (Object.entries(graph)).forEach(([nodeId, node]) => {
    const scanned = iface.nodes[nodeId];
    if (!scanned?.schemaKnown) return;
    (["image", "video", "audio"] as ComfyMediaKind[]).forEach((kind) => {
      if (!media[kind].length) return;
      const outputKinds = new Set(scanned.outputs.map((slot) => valueKind(slot.type)));
      const outputContractMatches = outputKinds.has(kind)
        || (kind === "video" && outputKinds.has("image") && outputKinds.has("audio"));
      const uploadScore = (slot: ComfySlot) => {
        const options = slot.options || {};
        if (options[`${kind}_upload`] === true) return 300;
        if (Object.entries(options).some(([key, value]) => value === true && key.toLowerCase().includes("upload")) && outputContractMatches) return 200;
        return 0;
      };
      const pathSlots = scanned.inputs
        .filter((slot) => !slot.linked && (slot.type === "COMBO" || valueKind(slot.type) === "text"))
        .filter((slot) => uploadScore(slot) > 0);
      const highestScore = Math.max(-1, ...pathSlots.map(uploadScore));
      const bestSlots = highestScore > 0 ? pathSlots.filter((slot) => uploadScore(slot) === highestScore) : [];
      if (bestSlots.length > 1) {
        diagnostics.push({
          level: "error",
          code: "media-loader-ambiguous",
          nodeId,
          message: `节点“${title(node)}”有多个可能接收${kind === "image" ? "图片" : kind === "video" ? "视频" : "音频"}文件名的插槽（${bestSlots.map((slot) => slot.name).join("、")}）；为避免写错参数，未自动选择。请在 ComfyUI 工作流中保留唯一上传字段或提供 upload 标记。`,
        });
        return;
      }
      const pathSlot = bestSlots[0];
      if (!pathSlot) return;
      node.inputs ||= {};
      node.inputs![pathSlot.name] = media[kind][mediaIndexes[kind]++ % media[kind].length];
      bindings.push({ kind, nodeId, input: pathSlot.name });
      diagnostics.push({
        level: "info",
        code: "media-bound",
        nodeId,
        input: pathSlot.name,
        message: `已将${kind === "image" ? "图片" : kind === "video" ? "视频" : "音频"}素材写入节点“${title(node)}”的“${pathSlot.name}”插槽。`,
      });
    });
  });

  if (input.text?.trim()) {
    const promptBindings = discoverLivePromptBindings(graph, objectInfo);
    if (promptBindings.bindings.length) {
      applyPromptBindings(graph, promptBindings.bindings, input.text);
      bindings.push(...promptBindings.bindings);
      diagnostics.push({
        level: "info",
        code: "text-bound",
        nodeId: promptBindings.bindings[0]?.nodeId,
        input: promptBindings.bindings.map((binding) => binding.input).join("、"),
        message: `已按当前 /object_info 将画布文字写入正向提示词 STRING/TEXT 插槽（${promptBindings.bindings.map((binding) => `#${binding.nodeId}.${binding.input}`).join("、")}）；负面提示词保持不变。`,
      });
    } else if (promptBindings.diagnostic) {
      diagnostics.push(promptBindings.diagnostic);
    }
  }

  (["image", "video", "audio"] as ComfyMediaKind[]).forEach((kind) => {
    if (media[kind].length && !bindings.some((binding) => binding.kind === kind)) {
      diagnostics.push({
        level: "error",
        code: "media-loader-unbound",
        expectedType: kind.toUpperCase(),
        message: `已连接${kind === "image" ? "图片" : kind === "video" ? "视频" : "音频"}素材，但当前 /object_info 没有确认带 upload 标记且类型匹配的加载槽；已阻止提交，避免把文件名写进错误参数。`,
      });
    }
  });

  // Keep structural diagnostics beside the binding result for callers that use
  // this helper without the App-level prepare → validate pipeline.  The main
  // app already renders `validateComfyWorkflow` once at submit time, so this is
  // intentionally separate rather than duplicated into `diagnostics`.
  const validation = validateComfyWorkflow(graph, objectInfo);
  return {
    graph,
    bindings,
    diagnostics,
    interface: validation.interface,
    validationDiagnostics: validation.diagnostics,
  };
};
