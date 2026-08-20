import { describe, expect, it } from "vitest";
import {
  EDIT_TAIL_SECONDS,
  EMPTY_TIMELINE_DURATION_SECONDS,
  getPreviewFrame,
  getTimelineBounds,
} from "./layout";

describe("Director Mode layout rules", () => {
  it("keeps an empty timeline playable and draggable only through five seconds", () => {
    expect(getTimelineBounds(0, 120, 80)).toEqual({
      total: EMPTY_TIMELINE_DURATION_SECONDS,
      tail: 0,
      rulerEnd: EMPTY_TIMELINE_DURATION_SECONDS,
    });
  });

  it("keeps edit tail only after real media exists", () => {
    expect(getTimelineBounds(12.2, 3, 0)).toEqual({
      total: 12.2,
      tail: EDIT_TAIL_SECONDS,
      rulerEnd: 43,
    });
  });

  it("uses a 9:16 frame for portrait sources while preserving contain behavior", () => {
    expect(getPreviewFrame(9 / 16)).toEqual({ portrait: true, aspectRatio: "9 / 16", objectFit: "contain" });
    expect(getPreviewFrame(4 / 5)).toEqual({ portrait: true, aspectRatio: "9 / 16", objectFit: "contain" });
    expect(getPreviewFrame(16 / 9)).toEqual({ portrait: false, objectFit: "contain" });
  });
});
