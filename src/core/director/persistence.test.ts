import { describe, expect, it } from "vitest";

import {
  directorAssetsForStorage,
  isSessionOnlyDirectorSource,
  readJson,
  writeJson,
  type JsonStorage,
} from "./persistence";

class MemoryStorage implements JsonStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("director persistence", () => {
  it("separates FileReader/blob sources from the persisted asset metadata", () => {
    const assets = [
      { id: "image", source: "external" as const, src: "data:image/png;base64," + "x".repeat(50_000) },
      { id: "audio", source: "external" as const, src: "blob:https://app/clip" },
      { id: "remote", source: "external" as const, src: "https://cdn.example.test/clip.mp4" },
      { id: "managed", source: "external" as const, assetId: "director_asset-1", localPath: "D:\\ComfyCanvas\\projects\\p1\\assets\\asset.png" },
      { id: "canvas", source: "canvas" as const },
    ];

    const stored = directorAssetsForStorage(assets);

    expect(stored[0]).toEqual({ id: "image", source: "external", sessionOnly: true });
    expect(stored[1]).toEqual({ id: "audio", source: "external", sessionOnly: true });
    expect(stored[2]).toEqual(assets[2]);
    expect(stored[3]).toEqual(assets[3]);
    expect(stored[4]).toEqual(assets[4]);
    expect(JSON.stringify(stored)).not.toContain("base64");
    expect(assets[0].src).toMatch(/^data:/);
  });

  it("identifies only non-durable browser media sources as session-only", () => {
    expect(isSessionOnlyDirectorSource("data:video/mp4;base64,AAAA")).toBe(true);
    expect(isSessionOnlyDirectorSource("blob:https://app/1")).toBe(true);
    expect(isSessionOnlyDirectorSource("https://example.test/video.mp4")).toBe(false);
    expect(isSessionOnlyDirectorSource("C:\\media\\clip.mp4")).toBe(false);
  });

  it("reports a quota/storage write error instead of swallowing it", () => {
    const storage: JsonStorage = {
      getItem: () => null,
      setItem: () => { throw new DOMException("quota full", "QuotaExceededError"); },
    };

    const result = writeJson(storage, "director", { timeline: [] });

    expect(result).toMatchObject({ ok: false, stage: "write" });
  });

  it("returns a recoverable fallback when stored JSON is corrupt", () => {
    const storage = new MemoryStorage();
    storage.setItem("director", "{");

    const result = readJson(storage, "director", { timeline: [] });

    expect(result.ok).toBe(false);
    expect(result.value).toEqual({ timeline: [] });
  });
});
