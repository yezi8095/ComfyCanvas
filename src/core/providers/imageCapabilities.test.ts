import { describe, expect, it } from "vitest";
import {
  imageCapabilitiesFor,
  imageRequestSizeFor,
  normalizeImageGenerationOptions,
  validateImageGenerationOptions,
} from "./imageCapabilities";

describe("image provider capabilities", () => {
  it("maps GPT Image landscape and portrait to exact API sizes", () => {
    const caps = imageCapabilitiesFor("OpenAI", "gpt-image-1");
    expect(imageRequestSizeFor(caps, "3:2", "1536")).toBe("1536x1024");
    expect(imageRequestSizeFor(caps, "2:3", "1536")).toBe("1024x1536");
    expect(caps.amounts).toEqual([1]);
  });

  it("does not advertise arbitrary GPT Image UI ratios", () => {
    const caps = imageCapabilitiesFor("OpenAI", "gpt-image-1-mini");
    expect(caps.ratios).not.toContain("16:9");
    expect(imageRequestSizeFor(caps, "16:9", "1536")).toBeUndefined();
  });

  it("keeps DALL-E 3 sizes and qualities model-specific", () => {
    const caps = imageCapabilitiesFor("OpenAI", "dall-e-3");
    expect(imageRequestSizeFor(caps, "7:4", "1792")).toBe("1792x1024");
    expect(caps.qualities).toEqual(["standard", "hd"]);
    expect(caps.referenceImageLimit).toBe(0);
  });

  it("supports the three square DALL-E 2 sizes", () => {
    const caps = imageCapabilitiesFor("OpenAI", "dall-e-2");
    expect(caps.requestSizes.map((size) => size.apiValue)).toEqual(["256x256", "512x512", "1024x1024"]);
    expect(caps.qualities).toEqual([]);
  });

  it("locks Gemini lite and 2.5 models to 1K", () => {
    expect(imageCapabilitiesFor("Google Nano Banana", "gemini-3.1-flash-lite-image").resolutions).toEqual(["1024"]);
    expect(imageCapabilitiesFor("Google Nano Banana", "gemini-2.5-flash-image").resolutions).toEqual(["1024"]);
  });

  it("allows Gemini 3 non-lite models to request 1K, 2K, or 4K", () => {
    const caps = imageCapabilitiesFor("Google Nano Banana", "gemini-3.1-flash-image");
    expect(caps.resolutions).toEqual(["1024", "2048", "4096"]);
    expect(caps.referenceImageLimit).toBe(14);
  });

  it("uses a conservative square fallback for unknown compatible models", () => {
    const caps = imageCapabilitiesFor("自定义平台", "new-image-model");
    expect(caps.ratios).toEqual(["1:1"]);
    expect(caps.requestSizes).toEqual([{ apiValue: "1024x1024", ratio: "1:1", resolution: "1024" }]);
  });

  it("reports unsupported amount and size combinations", () => {
    const caps = imageCapabilitiesFor("OpenAI", "gpt-image-1");
    const errors = validateImageGenerationOptions(caps, { ratio: "1:1", resolution: "1536", amount: 4, quality: "hd" });
    expect(errors).toHaveLength(3);
    expect(errors.join(" ")).toContain("4 张");
  });

  it("ignores a legacy quality value when the provider has no quality parameter", () => {
    const caps = imageCapabilitiesFor("阿里百炼·万相", "qwen-image-3.0-pro");
    expect(caps.qualities).toEqual([]);
    expect(validateImageGenerationOptions(caps, {
      ratio: "9:16",
      resolution: "1080x1920",
      amount: 1,
      quality: "low",
    })).toEqual([]);
  });

  it("normalizes stale UI options to a real provider request", () => {
    const caps = imageCapabilitiesFor("OpenAI", "gpt-image-1");
    expect(normalizeImageGenerationOptions(caps, {
      ratio: "16:9",
      resolution: "4096",
      amount: 4,
      quality: "hd",
    })).toEqual({
      ratio: "1:1",
      resolution: "1024",
      amount: 1,
      quality: "auto",
      changed: true,
    });
  });
});
