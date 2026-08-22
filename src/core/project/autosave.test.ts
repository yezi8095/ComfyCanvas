import { describe, expect, it } from "vitest";

import {
  DEFAULT_AUTOSAVE_MINUTES,
  MAX_AUTOSAVE_MINUTES,
  MIN_AUTOSAVE_MINUTES,
  normalizeAutosaveMinutes,
} from "./autosave";

describe("normalizeAutosaveMinutes", () => {
  it("keeps a user-selected whole-minute interval", () => {
    expect(normalizeAutosaveMinutes("25")).toBe(25);
  });

  it("rounds and clamps the interval to the supported range", () => {
    expect(normalizeAutosaveMinutes("3.6")).toBe(4);
    expect(normalizeAutosaveMinutes(0)).toBe(MIN_AUTOSAVE_MINUTES);
    expect(normalizeAutosaveMinutes(2000)).toBe(MAX_AUTOSAVE_MINUTES);
  });

  it("falls back to the default when the saved value is invalid", () => {
    expect(normalizeAutosaveMinutes("not-a-number")).toBe(DEFAULT_AUTOSAVE_MINUTES);
  });
});
