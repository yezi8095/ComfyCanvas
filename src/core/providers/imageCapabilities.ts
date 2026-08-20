export type ImageAspectRatio =
  | "1:1"
  | "2:3"
  | "3:2"
  | "3:4"
  | "4:3"
  | "4:5"
  | "5:4"
  | "7:4"
  | "4:7"
  | "9:16"
  | "16:9"
  | "21:9";

export type ImageResolution = "256" | "512" | "1024" | "1536" | "1792" | "2048" | "4096";
export type ImageQuality = "auto" | "low" | "medium" | "high" | "standard" | "hd";

export interface ImageRequestSize {
  /** Exact value accepted by the provider API. */
  apiValue: string;
  ratio: ImageAspectRatio;
  resolution: ImageResolution;
}

export interface ImageGenerationCapabilities {
  provider: string;
  model: string;
  protocol: "openai" | "gemini" | "manual";
  ratios: readonly ImageAspectRatio[];
  resolutions: readonly ImageResolution[];
  amounts: readonly number[];
  qualities: readonly ImageQuality[];
  requestSizes: readonly ImageRequestSize[];
  referenceImageLimit: number;
  /** Current desktop commands return one image; larger UI batches must repeat. */
  batchStrategy: "single" | "repeat";
}

const GEMINI_RATIOS: readonly ImageAspectRatio[] = [
  "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9",
];

const capability = (
  provider: string,
  model: string,
  values: Omit<ImageGenerationCapabilities, "provider" | "model">,
): ImageGenerationCapabilities => ({ provider, model, ...values });

/**
 * Returns only parameters that the current desktop adapter can actually send.
 * Unknown OpenAI-compatible models deliberately fall back to one square image;
 * arbitrary dimensions are not portable across compatible endpoints.
 */
export const imageCapabilitiesFor = (provider: string, model: string): ImageGenerationCapabilities => {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();

  if (normalizedProvider.includes("google") || normalizedModel.includes("gemini") || normalizedModel.includes("nano-banana")) {
    const supportsHighResolution = normalizedModel.includes("gemini-3") && !normalizedModel.includes("flash-lite");
    return capability(provider, model, {
      protocol: "gemini",
      ratios: GEMINI_RATIOS,
      resolutions: supportsHighResolution ? ["1024", "2048", "4096"] : ["1024"],
      amounts: [1],
      qualities: [],
      requestSizes: [],
      referenceImageLimit: 14,
      batchStrategy: "single",
    });
  }

  if (normalizedProvider.includes("midjourney") || normalizedModel.startsWith("v8")) {
    return capability(provider, model, {
      protocol: "manual",
      ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"],
      resolutions: [],
      amounts: [1],
      qualities: [],
      requestSizes: [],
      referenceImageLimit: 0,
      batchStrategy: "single",
    });
  }

  if (normalizedModel.includes("dall-e-3") || normalizedModel.includes("dall·e-3")) {
    return capability(provider, model, {
      protocol: "openai",
      ratios: ["1:1", "7:4", "4:7"],
      resolutions: ["1024", "1792"],
      amounts: [1],
      qualities: ["standard", "hd"],
      requestSizes: [
        { apiValue: "1024x1024", ratio: "1:1", resolution: "1024" },
        { apiValue: "1792x1024", ratio: "7:4", resolution: "1792" },
        { apiValue: "1024x1792", ratio: "4:7", resolution: "1792" },
      ],
      referenceImageLimit: 0,
      batchStrategy: "single",
    });
  }

  if (normalizedModel.includes("dall-e-2") || normalizedModel.includes("dall·e-2")) {
    return capability(provider, model, {
      protocol: "openai",
      ratios: ["1:1"],
      resolutions: ["256", "512", "1024"],
      amounts: [1],
      qualities: [],
      requestSizes: [
        { apiValue: "256x256", ratio: "1:1", resolution: "256" },
        { apiValue: "512x512", ratio: "1:1", resolution: "512" },
        { apiValue: "1024x1024", ratio: "1:1", resolution: "1024" },
      ],
      referenceImageLimit: 1,
      batchStrategy: "single",
    });
  }

  if (normalizedModel.includes("gpt-image")) {
    return capability(provider, model, {
      protocol: "openai",
      ratios: ["1:1", "3:2", "2:3"],
      resolutions: ["1024", "1536"],
      amounts: [1],
      qualities: ["auto", "low", "medium", "high"],
      requestSizes: [
        { apiValue: "1024x1024", ratio: "1:1", resolution: "1024" },
        { apiValue: "1536x1024", ratio: "3:2", resolution: "1536" },
        { apiValue: "1024x1536", ratio: "2:3", resolution: "1536" },
      ],
      referenceImageLimit: 1,
      batchStrategy: "single",
    });
  }

  return capability(provider, model, {
    protocol: "openai",
    ratios: ["1:1"],
    resolutions: ["1024"],
    amounts: [1],
    qualities: [],
    requestSizes: [{ apiValue: "1024x1024", ratio: "1:1", resolution: "1024" }],
    referenceImageLimit: 1,
    batchStrategy: "single",
  });
};

export const imageRequestSizeFor = (
  capabilities: ImageGenerationCapabilities,
  ratio: ImageAspectRatio,
  resolution: ImageResolution,
): string | undefined => {
  if (!capabilities.ratios.includes(ratio)) return undefined;
  return capabilities.requestSizes.find((size) => size.ratio === ratio && size.resolution === resolution)?.apiValue;
};

export const normalizeImageGenerationOptions = (
  capabilities: ImageGenerationCapabilities,
  options: { ratio?: string; resolution?: string; amount?: number; quality?: string },
) => {
  const requestedRatio = options.ratio as ImageAspectRatio;
  const ratio = capabilities.ratios.includes(requestedRatio)
    ? requestedRatio
    : capabilities.ratios[0];
  const exactResolutions = capabilities.requestSizes
    .filter((item) => item.ratio === ratio)
    .map((item) => item.resolution);
  const resolutions = [...new Set(exactResolutions.length ? exactResolutions : capabilities.resolutions)];
  const requestedResolution = options.resolution as ImageResolution;
  const resolution = resolutions.includes(requestedResolution)
    ? requestedResolution
    : resolutions[0];
  const requestedAmount = Number(options.amount || 1);
  const amount = capabilities.amounts.includes(requestedAmount)
    ? requestedAmount
    : capabilities.amounts[0];
  const requestedQuality = options.quality as ImageQuality;
  const quality = capabilities.qualities.includes(requestedQuality)
    ? requestedQuality
    : capabilities.qualities[0];
  return {
    ratio,
    resolution,
    amount,
    quality,
    changed:
      ratio !== options.ratio ||
      resolution !== options.resolution ||
      amount !== requestedAmount ||
      quality !== options.quality,
  };
};

export const validateImageGenerationOptions = (
  capabilities: ImageGenerationCapabilities,
  options: { ratio: ImageAspectRatio; resolution: ImageResolution; amount: number; quality?: ImageQuality },
): string[] => {
  const errors: string[] = [];
  if (!capabilities.ratios.includes(options.ratio)) errors.push(`当前模型不支持 ${options.ratio} 比例`);
  if (!capabilities.resolutions.includes(options.resolution)) errors.push(`当前模型不支持 ${options.resolution} 分辨率`);
  if (!capabilities.amounts.includes(options.amount)) errors.push(`当前适配器不支持一次生成 ${options.amount} 张`);
  if (options.quality && !capabilities.qualities.includes(options.quality)) errors.push(`当前模型不支持 ${options.quality} 质量`);
  if (capabilities.protocol === "openai" && capabilities.requestSizes.length && !imageRequestSizeFor(capabilities, options.ratio, options.resolution)) {
    errors.push("当前比例与分辨率组合没有对应的 API 尺寸");
  }
  return errors;
};
