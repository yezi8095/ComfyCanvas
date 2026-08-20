/**
 * Video capabilities exposed by the desktop adapters.
 *
 * This is deliberately narrower than a provider's marketing capability list:
 * an option belongs here only when App.tsx can submit it and the Rust adapter
 * can preserve every supplied input in the provider request.
 */
export type VideoGenerationMode = "text" | "image" | "firstLast" | "reference";

export type VideoInputLimit = {
  minimum: number;
  maximum: number;
};

export type VideoRequestContract =
  | "dashscope-video-synthesis"
  | "dashscope-first-last"
  | "kling-image-tail"
  | "seedance-content-roles"
  | "unsupported";

export interface VideoGenerationCapabilities {
  provider: string;
  model: string;
  protocol: "dashscope" | "kling" | "volcengine" | "unsupported";
  /** Modes that this desktop adapter can submit without dropping inputs. */
  modes: readonly VideoGenerationMode[];
  /** The current async task adapters return one video URL per request. */
  amounts: readonly number[];
  /** Maximum images for the provider's multi-reference mode; zero means unavailable. */
  referenceImageLimit: number;
  /** Modes for which the desktop adapter sends a provider-supported audio flag. */
  audioModes: readonly VideoGenerationMode[];
  /** Exact image-count requirements for each supported mode. */
  inputLimits: Readonly<Partial<Record<VideoGenerationMode, VideoInputLimit>>>;
  /** How a supported first/last-frame request is mapped on the wire. */
  firstLastContract?: VideoRequestContract;
}

const noImages: VideoInputLimit = { minimum: 0, maximum: 0 };
const oneImage: VideoInputLimit = { minimum: 1, maximum: 1 };
const twoImages: VideoInputLimit = { minimum: 2, maximum: 2 };

const capability = (
  provider: string,
  model: string,
  values: Omit<VideoGenerationCapabilities, "provider" | "model">,
): VideoGenerationCapabilities => ({ provider, model, ...values });

const inputLimits = (
  modes: readonly VideoGenerationMode[],
  referenceImageLimit = 0,
): VideoGenerationCapabilities["inputLimits"] => ({
  ...(modes.includes("text") ? { text: noImages } : {}),
  ...(modes.includes("image") ? { image: oneImage } : {}),
  ...(modes.includes("firstLast") ? { firstLast: twoImages } : {}),
  ...(modes.includes("reference") ? { reference: { minimum: 1, maximum: referenceImageLimit } } : {}),
});

const singleRequest = (
  provider: string,
  model: string,
  protocol: VideoGenerationCapabilities["protocol"],
  modes: readonly VideoGenerationMode[],
  referenceImageLimit = 0,
  firstLastContract?: VideoRequestContract,
  audioModes: readonly VideoGenerationMode[] = [],
) => capability(provider, model, {
  protocol,
  modes,
  amounts: [1],
  referenceImageLimit,
  audioModes,
  inputLimits: inputLimits(modes, referenceImageLimit),
  firstLastContract,
});

/**
 * Resolves capabilities for the provider/model pair that will actually be
 * sent to the desktop Rust command. Unknown combinations use a conservative
 * text-only fallback instead of advertising unimplemented inputs.
 */
export const videoCapabilitiesFor = (provider: string, model: string): VideoGenerationCapabilities => {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();

  if (normalizedProvider.includes("阿里百炼") || normalizedProvider.includes("万相")) {
    if (/kf2v|first[-_.]?last/.test(normalizedModel)) {
      return singleRequest(provider, model, "dashscope", ["firstLast"], 0, "dashscope-first-last");
    }
    if (/i2v|image[-_.]?to[-_.]?video/.test(normalizedModel)) {
      return singleRequest(provider, model, "dashscope", ["image"], 0, undefined, ["image"]);
    }
    return singleRequest(provider, model, "dashscope", ["text"], 0, undefined, ["text"]);
  }

  if (normalizedProvider.includes("可灵") || normalizedProvider.includes("kling")) {
    // The configured default, kling-v1-6, accepts `image` plus `image_tail`.
    // Other model IDs stay on the safe text/image contract until specifically
    // added here with a verified provider schema.
    const supportsFirstLast = /(?:^|[-_.])kling[-_.]?v1[-_.]?6(?:[-_.]|$)/.test(normalizedModel)
      || normalizedModel.includes("kling-v1-6");
    return singleRequest(
      provider,
      model,
      "kling",
      supportsFirstLast ? ["text", "image", "firstLast"] : ["text", "image"],
      0,
      supportsFirstLast ? "kling-image-tail" : undefined,
    );
  }

  if (normalizedProvider.includes("豆包") || normalizedProvider.includes("火山") || normalizedProvider.includes("volc")) {
    // Seedance 2 supports multi-modal reference input. Keep the older model
    // profiles explicit: their contracts are not interchangeable.
    if (/seedance[-_.]?2[-_.]?0/.test(normalizedModel)) {
      return singleRequest(provider, model, "volcengine", ["text", "image", "firstLast", "reference"], 9, "seedance-content-roles");
    }
    if (/seedance[-_.]?1[-_.]?0[-_.]?lite[-_.]?i2v/.test(normalizedModel)) {
      return singleRequest(provider, model, "volcengine", ["image", "firstLast", "reference"], 4, "seedance-content-roles");
    }
    // `pro-fast` is a different provider contract. Do not infer its
    // first/last-frame support from the Pro model family.
    const isSeedancePro = /seedance[-_.]?(?:1[-_.]?0|1[-_.]?5)[-_.]?pro/.test(normalizedModel)
      && !/pro[-_.]?fast/.test(normalizedModel);
    if (isSeedancePro) {
      return singleRequest(provider, model, "volcengine", ["text", "image", "firstLast"], 0, "seedance-content-roles");
    }
    return singleRequest(provider, model, "volcengine", ["text"], 0);
  }

  return singleRequest(provider, model, "unsupported", ["text"], 0, "unsupported");
};

export const videoInputLimitForMode = (
  capabilities: VideoGenerationCapabilities,
  mode: VideoGenerationMode,
): VideoInputLimit => capabilities.inputLimits[mode] || noImages;

export const supportsVideoAudio = (
  capabilities: VideoGenerationCapabilities,
  mode: VideoGenerationMode,
) => capabilities.audioModes.includes(mode);

export const normalizeVideoGenerationOptions = (
  capabilities: VideoGenerationCapabilities,
  options: { mode?: string; amount?: number },
) => {
  const requestedMode = options.mode as VideoGenerationMode;
  const mode = capabilities.modes.includes(requestedMode)
    ? requestedMode
    : capabilities.modes[0];
  const requestedAmount = Number.isFinite(Number(options.amount))
    ? Math.max(1, Math.trunc(Number(options.amount)))
    : 1;
  const amount = capabilities.amounts.includes(requestedAmount)
    ? requestedAmount
    : capabilities.amounts[0];
  return {
    mode,
    amount,
    changed: mode !== options.mode || amount !== requestedAmount,
  };
};

export const validateVideoGenerationInput = (
  capabilities: VideoGenerationCapabilities,
  options: { mode: VideoGenerationMode; amount: number; imageCount: number },
): string[] => {
  const errors: string[] = [];
  if (!capabilities.modes.includes(options.mode)) {
    errors.push(`当前模型不支持${videoModeLabel(options.mode)}`);
    return errors;
  }
  if (!capabilities.amounts.includes(options.amount)) {
    errors.push(`当前桌面适配器一次只能生成 ${capabilities.amounts.join("、")} 个视频`);
  }
  const limit = videoInputLimitForMode(capabilities, options.mode);
  if (options.imageCount < limit.minimum || options.imageCount > limit.maximum) {
    if (options.mode === "firstLast") {
      errors.push(`首尾帧需要恰好 2 张图片（当前 ${options.imageCount} 张）`);
    } else if (limit.maximum === 0) {
      errors.push(`${videoModeLabel(options.mode)}不接受图片输入`);
    } else if (limit.minimum === limit.maximum) {
      errors.push(`${videoModeLabel(options.mode)}需要恰好 ${limit.maximum} 张图片（当前 ${options.imageCount} 张）`);
    } else {
      errors.push(`${videoModeLabel(options.mode)}需要 ${limit.minimum}-${limit.maximum} 张图片（当前 ${options.imageCount} 张）`);
    }
  }
  return errors;
};

export const videoModeLabel = (mode: VideoGenerationMode) => ({
  text: "文生视频",
  image: "图生视频",
  firstLast: "首尾帧视频",
  reference: "多参考视频",
})[mode];
