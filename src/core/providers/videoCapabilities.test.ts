import { describe, expect, it } from "vitest";
import {
  normalizeVideoGenerationOptions,
  supportsVideoAudio,
  validateVideoGenerationInput,
  videoCapabilitiesFor,
  videoInputLimitForMode,
} from "./videoCapabilities";

describe("video provider capabilities", () => {
  it("does not advertise batches that the desktop task adapters do not return", () => {
    for (const [provider, model] of [
      ["阿里百炼·万相", "wan2.6-t2v"],
      ["可灵 Kling", "kling-v1-6"],
      ["豆包·火山方舟", "doubao-seedance-1-0-pro-250528"],
    ]) {
      expect(videoCapabilitiesFor(provider, model).amounts).toEqual([1]);
    }
  });

  it("maps first/last frame models to two required images and their contracts", () => {
    const wan = videoCapabilitiesFor("阿里百炼·万相", "wan2.2-kf2v-flash");
    expect(wan.modes).toEqual(["firstLast"]);
    expect(wan.firstLastContract).toBe("dashscope-first-last");
    expect(videoInputLimitForMode(wan, "firstLast")).toEqual({ minimum: 2, maximum: 2 });

    const kling = videoCapabilitiesFor("可灵 Kling", "kling-v1-6");
    expect(kling.modes).toContain("firstLast");
    expect(kling.firstLastContract).toBe("kling-image-tail");
    expect(supportsVideoAudio(kling, "firstLast")).toBe(false);

    expect(supportsVideoAudio(wan, "firstLast")).toBe(false);
  });

  it("only advertises multi-reference input for mapped Seedance models", () => {
    const pro = videoCapabilitiesFor("豆包·火山方舟", "doubao-seedance-1-0-pro-250528");
    expect(pro.modes).not.toContain("reference");
    expect(pro.referenceImageLimit).toBe(0);

    const proFast = videoCapabilitiesFor("豆包·火山方舟", "doubao-seedance-1-0-pro-fast");
    expect(proFast.modes).toEqual(["text"]);

    const lite = videoCapabilitiesFor("豆包·火山方舟", "doubao-seedance-1-0-lite-i2v");
    expect(lite.modes).toContain("reference");
    expect(lite.referenceImageLimit).toBe(4);

    const v2 = videoCapabilitiesFor("豆包·火山方舟", "doubao-seedance-2-0-260128");
    expect(v2.referenceImageLimit).toBe(9);
  });

  it("normalizes stale mode and batch values before a task is sent", () => {
    const capabilities = videoCapabilitiesFor("阿里百炼·万相", "wan2.6-t2v");
    expect(normalizeVideoGenerationOptions(capabilities, { mode: "reference", amount: 4 })).toEqual({
      mode: "text",
      amount: 1,
      changed: true,
    });
  });

  it("rejects malformed first/last-frame input instead of dropping a frame", () => {
    const capabilities = videoCapabilitiesFor("可灵 Kling", "kling-v1-6");
    expect(validateVideoGenerationInput(capabilities, { mode: "firstLast", amount: 1, imageCount: 1 }))
      .toContain("首尾帧需要恰好 2 张图片（当前 1 张）");
  });
});
