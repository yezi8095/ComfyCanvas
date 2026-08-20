import { describe, expect, it } from "vitest";
import {
  normalizeStoryboardFramePlans,
  parseGeneratedStoryboard,
  storyboardGenerationSystemPrompt,
  type StoryboardFramePlan,
} from "./generation";

const frames: StoryboardFramePlan[] = [
  { id: "one", name: "开场", shotSize: "全景", camera: "缓慢推进", requirement: "雨夜天台" },
  { id: "two", name: "人物", shotSize: "近景", camera: "固定镜头", requirement: "主角抬头" },
];

describe("storyboard generation", () => {
  it("keeps at least one editable frame", () => {
    expect(normalizeStoryboardFramePlans([])).toHaveLength(1);
  });

  it("builds an exact-count visual-only instruction", () => {
    const prompt = storyboardGenerationSystemPrompt({ frames, ratio: "16:9", style: "电影写实", language: "简体中文" });
    expect(prompt).toContain("恰好 2 个画面");
    expect(prompt).toContain("雨夜天台");
    expect(prompt).toContain("不要扩写完整剧本");
  });

  it("parses JSON shots and limits unexpected extras", () => {
    const result = parseGeneratedStoryboard(JSON.stringify({ shots: [
      { shot: "1", visual: "雨夜天台全景", dialogue: "风声" },
      { shot: "2", visual: "主角抬头近景", dialogue: "" },
      { shot: "3", visual: "多余画面", dialogue: "" },
    ] }), frames);
    expect(result).toEqual([
      { shot: "1", visual: "雨夜天台全景", dialogue: "风声" },
      { shot: "2", visual: "主角抬头近景", dialogue: "" },
    ]);
  });

  it("keeps the requested frame count when a model returns too few shots", () => {
    const result = parseGeneratedStoryboard('{"shots":[{"visual":"只返回了一个画面"}]}', frames);
    expect(result).toHaveLength(2);
    expect(result[0].visual).toBe("只返回了一个画面");
    expect(result[1].visual).toContain("主角抬头");
  });
});
