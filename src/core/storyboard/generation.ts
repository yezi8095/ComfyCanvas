export type StoryboardFramePlan = {
  id: string;
  name: string;
  shotSize: string;
  camera: string;
  requirement: string;
};

export type GeneratedStoryboardRow = {
  shot: string;
  visual: string;
  dialogue: string;
};

export const createStoryboardFramePlan = (index: number): StoryboardFramePlan => ({
  id: `frame-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
  name: `画面 ${index + 1}`,
  shotSize: "中景",
  camera: "固定镜头",
  requirement: "",
});

export const normalizeStoryboardFramePlans = (
  frames: StoryboardFramePlan[] | undefined,
): StoryboardFramePlan[] => {
  const source = Array.isArray(frames) && frames.length
    ? frames.slice(0, 24)
    : [createStoryboardFramePlan(0)];
  return source.map((frame, index) => ({
    id: String(frame?.id || `frame-${index + 1}`),
    name: String(frame?.name || `画面 ${index + 1}`),
    shotSize: String(frame?.shotSize || "中景"),
    camera: String(frame?.camera || "固定镜头"),
    requirement: String(frame?.requirement || ""),
  }));
};

export const storyboardGenerationSystemPrompt = ({
  frames,
  ratio,
  style,
  language,
}: {
  frames: StoryboardFramePlan[];
  ratio: string;
  style: string;
  language: string;
}) => {
  const normalized = normalizeStoryboardFramePlans(frames);
  const frameRequirements = normalized.map((frame, index) => [
    `${index + 1}. ${frame.name}`,
    `景别：${frame.shotSize}`,
    `运镜：${frame.camera}`,
    frame.requirement.trim() ? `额外要求：${frame.requirement.trim()}` : "",
  ].filter(Boolean).join("；")).join("\n");
  return [
    "你是一名专业影视分镜设计师。根据用户提供的故事、场景或创意，只设计分镜画面，不要扩写完整剧本。",
    `必须生成恰好 ${normalized.length} 个画面，画幅为 ${ratio || "16:9"}，整体视觉风格为 ${style || "电影写实"}，使用${language || "简体中文"}。`,
    "每个画面都要明确主体、环境、构图、光线、人物动作、景别和运镜，可直接作为后续图片或视频生成提示词。",
    "只输出合法 JSON，不要 Markdown 代码块、说明文字或省略号。格式必须为：",
    '{"shots":[{"shot":"1","visual":"完整画面描述","dialogue":"可选台词、旁白或音效；没有则留空"}]}',
    "逐画面参数：",
    frameRequirements,
  ].join("\n");
};

const recordValue = (value: unknown, keys: string[]) => {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" || typeof candidate === "number") {
      const text = String(candidate).trim();
      if (text) return text;
    }
  }
  return "";
};

const rowsFromJson = (value: unknown): GeneratedStoryboardRow[] => {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const list = Array.isArray(value)
    ? value
    : Array.isArray(record?.shots)
      ? record.shots
      : Array.isArray(record?.frames)
        ? record.frames
        : Array.isArray(record?.storyboard)
          ? record.storyboard
          : [];
  return list.map((item, index) => ({
    shot: recordValue(item, ["shot", "number", "index", "镜头", "画面"]) || String(index + 1),
    visual: recordValue(item, ["visual", "description", "prompt", "frame", "画面描述", "画面"]),
    dialogue: recordValue(item, ["dialogue", "audio", "sound", "台词", "音效"]),
  })).filter((row) => row.visual);
};

const completePlannedRows = (
  rows: GeneratedStoryboardRow[],
  plans: StoryboardFramePlan[],
) => plans.map((frame, index) => rows[index] || ({
  shot: String(index + 1),
  visual: [frame.name, frame.shotSize, frame.camera, frame.requirement].filter(Boolean).join("；"),
  dialogue: "",
}));

const jsonCandidates = (source: string) => {
  const candidates: string[] = [];
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  const firstObject = source.indexOf("{");
  const lastObject = source.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) candidates.push(source.slice(firstObject, lastObject + 1));
  const firstArray = source.indexOf("[");
  const lastArray = source.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) candidates.push(source.slice(firstArray, lastArray + 1));
  candidates.push(source);
  return [...new Set(candidates)];
};

export const parseGeneratedStoryboard = (
  source: string,
  plannedFrames: StoryboardFramePlan[],
): GeneratedStoryboardRow[] => {
  const plans = normalizeStoryboardFramePlans(plannedFrames);
  for (const candidate of jsonCandidates(source.trim())) {
    try {
      const parsed = rowsFromJson(JSON.parse(candidate));
      if (parsed.length) return completePlannedRows(parsed.slice(0, plans.length), plans);
    } catch {
      // Some compatible models ignore JSON-only instructions. Fall back to a
      // readable block parser below instead of discarding a useful response.
    }
  }
  const blocks = source
    .split(/\n\s*(?=(?:#+\s*)?(?:镜头|画面)\s*\d+)/)
    .map((block) => block.replace(/^#+\s*/, "").trim())
    .filter(Boolean);
  const parsed = blocks.map((block, index) => ({
    shot: block.match(/(?:镜头|画面)\s*(\d+)/)?.[1] || String(index + 1),
    visual: block
      .replace(/^(?:镜头|画面)\s*\d+\s*[:：、.-]?\s*/, "")
      .replace(/(?:台词|对白|音效)\s*[:：][\s\S]*$/i, "")
      .trim(),
    dialogue: block.match(/(?:台词|对白|音效)\s*[:：]\s*([\s\S]*)$/i)?.[1]?.trim() || "",
  })).filter((row) => row.visual);
  if (parsed.length) return completePlannedRows(parsed.slice(0, plans.length), plans);
  return completePlannedRows([], plans);
};
