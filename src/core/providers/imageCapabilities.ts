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

/** A provider may use a named tier or a precise WxH output size. */
export type ImageResolution = string;
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

// Qwen-Image is called through DashScope's native multimodal endpoint.  It
// accepts a size string rather than OpenAI's fixed request-size list, so the
// UI must not fall back to the generic one-square-image compatibility profile.
const QWEN_IMAGE_RATIOS: readonly ImageAspectRatio[] = [
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

  if (normalizedProvider.includes("阿里百炼") || normalizedProvider.includes("万相") || normalizedModel.startsWith("qwen-image")) {
    // Qwen Image accepts literal WxH sizes. The picker shows the exact value
    // submitted to DashScope for the selected aspect ratio.
    const dimensions: Record<ImageAspectRatio, readonly string[]> = {
      "1:1": ["1024x1024", "2048x2048"],
      "2:3": ["1024x1536", "1365x2048"], "3:2": ["1536x1024", "2048x1365"],
      "3:4": ["768x1024", "1536x2048"], "4:3": ["1024x768", "2048x1536"],
      "4:5": ["819x1024", "1638x2048"], "5:4": ["1024x819", "2048x1638"],
      "7:4": ["1792x1024", "2048x1170"], "4:7": ["1024x1792", "1170x2048"],
      "9:16": ["576x1024", "1152x2048"], "16:9": ["1024x576", "2048x1152"],
      "21:9": ["1792x768", "2048x878"],
    };
    const requestSizes = QWEN_IMAGE_RATIOS.flatMap((ratio) => dimensions[ratio].map((size) => ({ apiValue: size, ratio, resolution: size })));
    return capability(provider, model, {
      protocol: "openai",
      ratios: QWEN_IMAGE_RATIOS,
      resolutions: ["1024x1024"],
      // DashScope accepts at most 6 images in one request. The desktop
      // client may split a larger batch into multiple real requests.
      amounts: [1, 2, 3, 4, 5],
      qualities: [],
      requestSizes,
      referenceImageLimit: 3,
      batchStrategy: "repeat",
    });
  }

  if (normalizedProvider.includes("pollinations") || normalizedModel === "flux") {
    const ratios: readonly ImageAspectRatio[] = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"];
    // The endpoint accepts literal WxH dimensions.  Keep them explicit in
    // the node instead of misleadingly labelling a 720×1280 image as "1K".
    const dimensions: Record<ImageAspectRatio, readonly string[]> = {
      "1:1": ["1024x1024", "768x768", "512x512"],
      "2:3": ["1024x1536", "768x1152", "512x768"],
      "3:2": ["1536x1024", "1152x768", "768x512"],
      "3:4": ["960x1280", "768x1024", "576x768"],
      "4:3": ["1280x960", "1024x768", "768x576"],
      "4:5": ["1024x1280", "768x960", "640x800"],
      "5:4": ["1280x1024", "960x768", "800x640"],
      "7:4": ["1400x800", "1120x640", "896x512"],
      "4:7": ["800x1400", "640x1120", "512x896"],
      "9:16": ["720x1280", "576x1024", "432x768"],
      "16:9": ["1280x720", "1024x576", "768x432"],
      "21:9": ["1792x768", "1344x576", "896x384"],
    };
    const requestSizes = ratios.flatMap((ratio) => dimensions[ratio].map((size) => ({ apiValue: size, ratio, resolution: size })));
    return capability(provider, model, {
      protocol: "openai",
      ratios,
      resolutions: ["1024x1024"],
      amounts: [1],
      qualities: [],
      requestSizes,
      referenceImageLimit: 0,
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
  if (capabilities.ratios.includes(ratio)) {
    const configured = capabilities.requestSizes.find((size) => size.ratio === ratio && size.resolution === resolution)?.apiValue;
    if (configured) return configured;
  }
  // The universal editor can submit a literal size to providers that accept
  // WxH. For fixed-size APIs this is deliberately left to the provider
  // response rather than silently changing the user's selection.
  return /^\d{2,5}x\d{2,5}$/i.test(resolution) ? resolution : undefined;
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
  const exactResolutions = capabilities.requestSizes
    .filter((size) => size.ratio === options.ratio)
    .map((size) => size.resolution);
  // OpenAI presets list resolution tiers globally and report a separate
  // unsupported-combination error.  Literal WxH providers (Pollinations)
  // instead have an actual size list for each ratio.
  const hasLiteralSizes = capabilities.requestSizes.some((size) => /^\d{2,5}x\d{2,5}$/i.test(size.resolution));
  const supportedResolutions = hasLiteralSizes && exactResolutions.length ? exactResolutions : capabilities.resolutions;
  const qwenLiteralSize = capabilities.model.trim().toLowerCase().startsWith("qwen-image")
    && /^(\d{2,5})x(\d{2,5})$/i.test(options.resolution)
    && (() => {
      const [, widthText, heightText] = options.resolution.match(/^(\d{2,5})x(\d{2,5})$/i)!;
      const width = Number(widthText);
      const height = Number(heightText);
      return width >= 256 && height >= 256 && width <= 2048 && height <= 2048 && width * height >= 512 * 512 && width * height <= 2048 * 2048;
    })();
  if (!qwenLiteralSize && !supportedResolutions.includes(options.resolution)) errors.push(`当前模型不支持 ${options.resolution} 分辨率`);
  if (!capabilities.amounts.includes(options.amount)) errors.push(`当前适配器不支持一次生成 ${options.amount} 张`);
  // An empty quality list means this provider does not expose a quality
  // parameter at all. Older nodes may still carry the former default `low`;
  // that inert legacy value must not block providers such as Qwen Image.
  if (capabilities.qualities.length > 0 && options.quality && !capabilities.qualities.includes(options.quality)) errors.push(`当前模型不支持 ${options.quality} 质量`);
  if (capabilities.protocol === "openai" && capabilities.requestSizes.length && !imageRequestSizeFor(capabilities, options.ratio, options.resolution)) {
    errors.push("当前比例与分辨率组合没有对应的 API 尺寸");
  }
  return errors;
};
