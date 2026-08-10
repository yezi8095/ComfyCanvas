import { useRef, useState } from "react";
import { comfyParameterHelp, isBasicComfyParameter, readComfyWorkflowLibrary } from "./ComfyWorkflowParameters";
import { cloudModelsFor, cloudPlatformsFor, defaultCloudModel, estimateCloudPoints, type CloudModelKind } from "./CloudModelCatalog";

export const AI_TEXT_PROVIDER_PRESETS = {
  OpenAI: {
    endpoint: "https://api.openai.com/v1",
    models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
    defaultModel: "gpt-4.1-mini",
    visionModel: "gpt-4.1-mini",
  },
  "阿里百炼·通义千问": {
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-plus", "qwen-max", "qwen-turbo"],
    defaultModel: "qwen-plus",
    visionModel: "qwen-vl-plus",
  },
  MiniMax: {
    endpoint: "https://api.minimax.chat/v1",
    models: ["MiniMax-Text-01"],
    defaultModel: "MiniMax-Text-01",
    visionModel: "MiniMax-VL-01",
  },
} as const;

export const AI_IMAGE_PROVIDER_PRESETS = {
  OpenAI: {
    models: ["gpt-image-1", "gpt-image-1-mini"],
    defaultModel: "gpt-image-1",
  },
  "Google Nano Banana": {
    models: ["gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-3-pro-image", "gemini-2.5-flash-image"],
    defaultModel: "gemini-3.1-flash-image",
  },
  "Midjourney（手动命令）": {
    models: ["V8.1"],
    defaultModel: "V8.1",
  },
} as const;

export type AiReferenceImage = {
  id: string;
  name: string;
  src: string;
  description?: string;
};

export type AiTextSettings = {
  source?: "comfy" | "byok" | "cloud";
  provider?: string;
  model?: string;
  prompt?: string;
  genre?: string;
  format?: string;
  length?: string;
  tone?: string;
  audience?: string;
  language?: string;
  creativity?: number;
  episodeCount?: number;
  episodeMinutes?: number;
  includeStoryboard?: boolean;
  includeCharacters?: boolean;
  references?: AiReferenceImage[];
  comfyWorkflowId?: string;
  comfyValues?: Record<string, string | number | boolean>;
};

export type AiImageSettings = {
  source?: "comfy" | "byok" | "cloud";
  provider?: string;
  model?: string;
  mode?: "text" | "image";
  prompt?: string;
  negativePrompt?: string;
  ratio?: string;
  resolution?: string;
  amount?: number;
  style?: string;
  seed?: number;
  guidance?: number;
  references?: AiReferenceImage[];
  comfyWorkflowId?: string;
  comfyValues?: Record<string, string | number | boolean>;
};

type AiNode = {
  id: string;
  kind: "aiText" | "aiImage";
  name: string;
  text?: string;
  src?: string;
  workflow?: unknown;
  status?: string;
};

export function AiGenerationNodeView({ node, onOpen }: { node: AiNode; onOpen: () => void }) {
  const isText = node.kind === "aiText";
  return <button className={`ai-generation-node ${isText ? "script" : "picture"}`} onClick={onOpen}>
    {node.src && !isText ? <img src={node.src} alt={node.name} /> : <div className="ai-generation-node-empty">
      <span>{isText ? "文" : "图"}</span>
      <b>{isText ? "AI 剧本生成" : "AI 图片生成"}</b>
      <small>{isText ? "输入创意，生成完整剧本" : "支持文生图与图生图"}</small>
    </div>}
    {node.status === "running" && <i className="ai-generation-running">生成中…</i>}
  </button>;
}

export function AiGenerationComposer({
  node,
  referenceImages,
  onUpdate,
  onGenerate,
  onClose,
  onOpenWorkflowLibrary,
  canvasImages,
  onDescribeImage,
}: {
  node: AiNode;
  referenceImages: Array<{ id: string; name: string; src: string }>;
  canvasImages: AiReferenceImage[];
  onUpdate: (patch: Record<string, unknown>) => void;
  onGenerate: () => void;
  onClose: () => void;
  onOpenWorkflowLibrary: () => void;
  onDescribeImage: (image: AiReferenceImage) => Promise<string>;
}) {
  const [parametersOpen, setParametersOpen] = useState(false);
  const [canvasPickerOpen, setCanvasPickerOpen] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [recognition, setRecognition] = useState<{
    image: AiReferenceImage;
    index: number;
    content: string;
  } | null>(null);
  const localImageRef = useRef<HTMLInputElement>(null);
  const isText = node.kind === "aiText";
  const storedText = (node.workflow || {}) as AiTextSettings;
  const text = {
    source: "byok", model: "gpt-4.1-mini", prompt: "",
    genre: "剧情短片", format: "标准影视剧本", length: "中篇", tone: "电影感",
    audience: "大众", language: "简体中文", creativity: 0.8, episodeCount: 1,
    episodeMinutes: 5, includeStoryboard: true, includeCharacters: true,
    ...storedText,
    provider: storedText.provider === "OpenAI 兼容" ? "OpenAI" : storedText.provider || "OpenAI",
  };
  const storedImage = (node.workflow || {}) as AiImageSettings;
  const image = {
    source: "byok", provider: "OpenAI", model: "gpt-image-1",
    mode: referenceImages.length || storedImage.references?.length ? "image" : "text", prompt: "", negativePrompt: "",
    ratio: "16:9", resolution: "1024", amount: 1, style: "电影写实", seed: -1, guidance: 7,
    ...storedImage,
  };
  const imageSupportsHighResolution = !/gemini-3\.1-flash-lite-image|gemini-2\.5-flash-image/i.test(image.model);
  const config = isText ? text : image;
  const update = (patch: Record<string, unknown>) => onUpdate({ ...config, ...patch });
  const cloudKind: CloudModelKind = isText ? "text" : "image";
  const cloudPlatforms = cloudPlatformsFor(cloudKind);
  const cloudPlatform = cloudPlatforms.includes(config.provider || "") ? config.provider! : cloudPlatforms[0];
  const cloudModels = cloudModelsFor(cloudKind, cloudPlatform);
  const cloudModel = cloudModels.find((model) => model.id === config.model) || defaultCloudModel(cloudKind, cloudPlatform);
  const textReferences = [
    ...(text.references || []),
    ...referenceImages.filter((item) => !(text.references || []).some((reference) => reference.id === item.id)),
  ];
  const imageReferences = [
    ...(image.references || []),
    ...referenceImages.filter((item) => !(image.references || []).some((reference) => reference.id === item.id)),
  ];
  const cloudEstimate = config.source === "cloud" ? estimateCloudPoints(cloudKind, cloudModel?.id, isText ? {
    promptLength: text.prompt.length,
    references: textReferences.length,
    episodeCount: text.episodeCount,
    episodeMinutes: text.episodeMinutes,
  } : {
    promptLength: image.prompt.length,
    references: imageReferences.length,
    amount: image.amount,
    resolution: image.resolution,
  }) : null;
  const attachTextReference = (image: AiReferenceImage) => {
    setCanvasPickerOpen(false);
    if (textReferences.some((item) => item.id === image.id)) return;
    update({ references: [...textReferences, image] });
  };
  const importTextReference = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => attachTextReference({
      id: `local-${Date.now()}-${file.name}`,
      name: file.name,
      src: String(reader.result || ""),
    });
    reader.readAsDataURL(file);
  };
  const recognizeMentionedImage = async (reference: AiReferenceImage, index: number) => {
    if (describing) return;
    setMentionOpen(false);
    setDescribing(true);
    try {
      const description = await onDescribeImage(reference);
      setRecognition({ image: reference, index, content: description.trim() });
    } catch {
      // The host displays API/configuration errors.
    } finally {
      setDescribing(false);
    }
  };
  const attachImageReference = (reference: AiReferenceImage) => {
    const references = imageReferences.some((item) => item.id === reference.id)
      ? imageReferences
      : [...imageReferences, reference];
    update({ references, mode: "image" });
    setCanvasPickerOpen(false);
  };
  const importImageReference = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => attachImageReference({
      id: `local-${Date.now()}-${file.name}`,
      name: file.name,
      src: String(reader.result || ""),
    });
    reader.readAsDataURL(file);
  };
  const sourceLabel = config.source === "comfy" ? "本地 ComfyUI" : config.source === "cloud" ? "亿幕云端积分" : "自带 API Key";
  const comfyWorkflows = readComfyWorkflowLibrary().filter((item) => item.apiContent || item.format === "api");
  const selectedComfyWorkflow = comfyWorkflows.find((item) => item.id === config.comfyWorkflowId);
  const comfyParameters = (selectedComfyWorkflow?.parameters || []).filter((parameter) => parameter.enabled && isBasicComfyParameter(parameter));
  const comfyValues = config.comfyValues || {};
  const summary = isText
    ? config.source === "comfy" ? `${selectedComfyWorkflow?.name || "选择工作流"} · ${comfyParameters.length}项参数` : `${text.genre} · ${text.format} · ${text.episodeCount}集×${text.episodeMinutes}分钟`
    : config.source === "comfy" ? `${selectedComfyWorkflow?.name || "选择工作流"} · ${comfyParameters.length}项参数` : `${image.ratio} · ${image.resolution === "1024" ? "1K" : image.resolution === "2048" ? "2K" : "4K"} · ${image.amount}张 · ${image.style}`;

  return <section className={`ai-composer ai-console ${isText ? "script" : "picture"} ${promptExpanded ? "prompt-expanded" : ""}`} onPointerDown={(event) => event.stopPropagation()}>
    <button className="ai-console-close" title="关闭" onClick={onClose}>×</button>

    <div className="ai-console-tools online-reference-dock">
      {(isText ? textReferences : imageReferences).length > 0 && <div className="online-reference-stack" title="鼠标移入展开全部参考素材">
        {(isText ? textReferences : imageReferences).slice(0, 6).map((item, index) => <div className="online-reference-stack-card" key={item.id} title={`@图片${index + 1} · ${item.name}`}>
          <img src={item.src} alt={item.name} />
          <span className="online-reference-label">图片{index + 1}</span>
          <button title="移除参考图" onClick={() => {
            const references = (isText ? textReferences : imageReferences).filter((reference) => reference.id !== item.id);
            update({ references, ...(!isText && references.length === 0 ? { mode: "text" } : {}) });
          }}>×</button>
        </div>)}
      </div>}
      <div className="online-reference-adders ai-reference-adders">
        <button className="online-reference-add canvas" title="从画布已有图片添加参考" onClick={() => setCanvasPickerOpen(!canvasPickerOpen)}><strong>＋</strong><small>画布生成</small></button>
        <button className="online-reference-add computer" title="从电脑添加参考图片" onClick={() => localImageRef.current?.click()}><strong>＋</strong><small>电脑文件</small></button>
        {canvasPickerOpen && <div className="ai-text-canvas-picker">
          <b>{isText ? "选择画布图片" : "选择画布参考图"}</b>
          <small>{isText ? "只添加为参考图；选择 @图片 时才会识别" : "添加后自动切换为图生图"}</small>
          {canvasImages.length ? <div>{canvasImages.slice(0, 18).map((item) =>
            <button key={item.id} title={item.name} onClick={() => isText ? attachTextReference(item) : attachImageReference(item)}>
              <img src={item.src} alt={item.name} /><span>{item.name}</span>
            </button>,
          )}</div> : <em>画布中还没有图片</em>}
        </div>}
      </div>
      <input ref={localImageRef} type="file" accept="image/*" hidden onChange={(event) => {
        if (isText) importTextReference(event.target.files?.[0]);
        else importImageReference(event.target.files?.[0]);
        event.currentTarget.value = "";
      }} />
      {describing && <small className="ai-reference-status">正在识别所选图片…</small>}
      <div className="online-reference-actions ai-reference-actions">
        <button className="online-prompt-library-trigger online-prompt-library-trigger-inline">提示词库</button>
        {(isText ? textReferences : imageReferences).length > 0 && <button className="online-at-reference-trigger" onClick={() => {
          if (isText) {
            setMentionOpen(!mentionOpen);
          } else {
            update({ prompt: `${image.prompt}${image.prompt ? " " : ""}@图片1 ` });
          }
        }}>@图片</button>}
      </div>
    </div>

    <textarea
      className="ai-console-prompt"
      autoFocus
      value={config.prompt}
      onChange={(event) => {
        const value = event.target.value;
        const caret = event.currentTarget.selectionStart ?? value.length;
        update({ prompt: value });
        if (isText && textReferences.length) {
          const match = value.slice(0, caret).match(/@[^\s，。；、,.!?]*$/);
          if (match) {
            setMentionOpen(true);
          } else setMentionOpen(false);
        }
      }}
      placeholder={isText
        ? "输入一句话创意、人物关系或故事梗概，生成完整影视剧本……"
        : image.mode === "image"
          ? "描述如何基于参考图片进行创作，输入 @ 可引用上方图片……"
          : "描述想生成的画面、主体、环境、构图、光线与视觉风格……"}
    />

    {isText && mentionOpen && textReferences.length > 0 && <div className="ai-mention-menu">
      <b>选择要识别的图片</b>
      <small>选择后才会调用视觉模型</small>
      <div>{textReferences.map((item, index) => <button key={item.id} onClick={() => void recognizeMentionedImage(item, index)}>
        <img src={item.src} alt={item.name} /><span>@图片{index + 1}<small>{item.name}</small></span>
      </button>)}</div>
    </div>}

    {isText && recognition && <div className="ai-recognition-panel">
      <header>
        <img src={recognition.image.src} alt={recognition.image.name} />
        <div><b>@图片{recognition.index + 1} 识别结果</b><small>纯文本内容，可直接选择任意位置复制</small></div>
        <button onClick={() => setRecognition(null)}>×</button>
      </header>
      <textarea className="ai-recognition-plain" readOnly value={recognition.content} spellCheck={false} />
    </div>}

    {!isText && image.negativePrompt && <input className="ai-console-negative" value={image.negativePrompt} onChange={(event) => update({ negativePrompt: event.target.value })} placeholder="反向提示词" />}

    <div className="ai-consolebar">
      <select aria-label="生成来源" value={config.source} onChange={(event) => {
        const source = event.target.value;
        if (source === "cloud") {
          const platform = cloudPlatforms[0];
          update({ source, provider: platform, model: defaultCloudModel(cloudKind, platform)?.id });
        } else update({ source });
      }}>
        <option value="comfy">本地 ComfyUI</option>
        <option value="byok">自带 API Key</option>
        <option value="cloud">亿幕云端积分</option>
      </select>
      {config.source === "comfy" ? <select className="ai-comfy-workflow-select" aria-label="ComfyUI 工作流" value={config.comfyWorkflowId || ""} onChange={(event) => update({ comfyWorkflowId: event.target.value, comfyValues: {} })}>
        <option value="">选择工作流</option>{comfyWorkflows.map((workflow) => <option value={workflow.id} key={workflow.id}>{workflow.name}</option>)}
      </select> : config.source === "cloud" ? <><select aria-label="云端平台" value={cloudPlatform} onChange={(event) => {
        const provider = event.target.value;
        update({ provider, model: defaultCloudModel(cloudKind, provider)?.id });
      }}>{cloudPlatforms.map((platform) => <option key={platform}>{platform}</option>)}</select>
      <select aria-label="云端模型" value={cloudModel?.id || ""} onChange={(event) => update({ model: event.target.value })}>
        {cloudModels.map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}
      </select></> : <select aria-label="生成平台" value={config.provider} onChange={(event) => {
        const provider = event.target.value;
        if (isText) {
          const preset = AI_TEXT_PROVIDER_PRESETS[provider as keyof typeof AI_TEXT_PROVIDER_PRESETS];
          update({ provider, model: preset?.defaultModel || text.model });
        } else {
          const preset = AI_IMAGE_PROVIDER_PRESETS[provider as keyof typeof AI_IMAGE_PROVIDER_PRESETS];
          const model = preset?.defaultModel || image.model;
          update({ provider, model, ...(/gemini-3\.1-flash-lite-image|gemini-2\.5-flash-image/i.test(model) ? { resolution: "1024" } : {}) });
        }
      }}>
        {isText ? <><option>OpenAI</option><option>阿里百炼·通义千问</option><option>MiniMax</option></>
          : <><option>OpenAI</option><option>Google Nano Banana</option><option>Midjourney（手动命令）</option></>}
      </select>}
      {!isText && config.source === "byok" && <select aria-label="图片模型" value={image.model} onChange={(event) => {
        const model = event.target.value;
        update({ model, ...(/gemini-3\.1-flash-lite-image|gemini-2\.5-flash-image/i.test(model) ? { resolution: "1024" } : {}) });
      }}>
        {(AI_IMAGE_PROVIDER_PRESETS[image.provider as keyof typeof AI_IMAGE_PROVIDER_PRESETS]?.models || [image.model]).map((model) => <option key={model}>{model}</option>)}
      </select>}
      {!isText && <select aria-label="图片生成模式" value={image.mode} onChange={(event) => update({ mode: event.target.value })}>
        <option value="text">文生图</option><option value="image">图生图</option>
      </select>}
      <button className="ai-console-summary" onClick={() => setParametersOpen(!parametersOpen)}>▭ {summary}⌄</button>
      {config.source === "comfy" && <button className="ai-console-icon" title="选择工作流" onClick={onOpenWorkflowLibrary}>↗</button>}
      <button className="ai-console-icon" title="提示词优化">✧</button>
      <button className="ai-console-icon" title="翻译提示词">文</button>
      <button className={`ai-console-icon ai-prompt-expand-icon ${promptExpanded ? "active" : ""}`} title={promptExpanded ? "收起编辑框" : "放大编辑框"} aria-label={promptExpanded ? "收起编辑框" : "放大编辑框"} onClick={() => setPromptExpanded(!promptExpanded)}>⛶</button>
      {cloudEstimate && <div className="cloud-points-estimate" title={`${cloudEstimate.detail}；最终以服务端结算为准`}>
        <small>输入 {cloudEstimate.input} + 输出 {cloudEstimate.output}</small><b>预计 {cloudEstimate.total} 积分</b>
      </div>}
      <button className="ai-generate-button" disabled={!config.prompt.trim() || node.status === "running"} onClick={onGenerate}>
        {node.status === "running" ? "生成中…" : isText ? "生成剧本 ↵" : "生成图片 ↵"}
      </button>
    </div>

    {parametersOpen && <div className="ai-console-parameters">
      <div className="ai-parameter-heading"><div><b>{config.source === "comfy" ? "ComfyUI 工作流参数" : isText ? "剧本生成参数" : "图片生成参数"}</b><small>{config.source === "comfy" ? "参数来自工作流库；只修改本次节点副本" : "完整参数保留在这里，确认后自动收起"}</small></div><button onClick={() => setParametersOpen(false)}>完成</button></div>
      {config.source === "comfy" ? <>
        <label className="wide">工作流<select value={config.comfyWorkflowId || ""} onChange={(event) => update({ comfyWorkflowId: event.target.value, comfyValues: {} })}><option value="">请选择</option>{comfyWorkflows.map((workflow) => <option value={workflow.id} key={workflow.id}>{workflow.name}</option>)}</select></label>
        {selectedComfyWorkflow && !comfyParameters.length && <div className="ai-comfy-empty wide">这个工作流还没有发布参数。请进入工作流库，选择该工作流并点击“扫描参数”。</div>}
        {comfyParameters.map((parameter) => <label title={comfyParameterHelp(parameter)} className={parameter.kind === "text" && String(parameter.value).length > 60 ? "wide" : ""} key={parameter.id}>{parameter.label} <i className="comfy-help">?</i><small>{parameter.nodeTitle} · {parameter.input}</small>{parameter.kind === "boolean"
          ? <select value={String(comfyValues[parameter.id] ?? parameter.value)} onChange={(event) => update({ comfyValues: { ...comfyValues, [parameter.id]: event.target.value === "true" } })}><option value="true">开启</option><option value="false">关闭</option></select>
          : <input type={parameter.kind === "number" ? "number" : "text"} value={String(comfyValues[parameter.id] ?? parameter.value)} onChange={(event) => update({ comfyValues: { ...comfyValues, [parameter.id]: parameter.kind === "number" ? Number(event.target.value) : event.target.value } })} />}</label>)}
      </> : <><label className="wide">模型{config.source === "cloud"
        ? <select value={cloudModel?.id || ""} onChange={(event) => update({ model: event.target.value })}>
            {cloudModels.map((model) => <option value={model.id} key={model.id}>{model.label} · {model.platform}</option>)}
          </select>
        : isText ? <select value={text.model} onChange={(event) => update({ model: event.target.value })}>
            {(AI_TEXT_PROVIDER_PRESETS[text.provider as keyof typeof AI_TEXT_PROVIDER_PRESETS]?.models || [text.model]).map((model) =>
              <option key={model}>{model}</option>,
            )}
          </select>
        : <select value={image.model} onChange={(event) => {
            const model = event.target.value;
            update({ model, ...(/gemini-3\.1-flash-lite-image|gemini-2\.5-flash-image/i.test(model) ? { resolution: "1024" } : {}) });
          }}>
            {(AI_IMAGE_PROVIDER_PRESETS[image.provider as keyof typeof AI_IMAGE_PROVIDER_PRESETS]?.models || [image.model]).map((model) => <option key={model}>{model}</option>)}
          </select>}</label>
      {isText ? <>
        <label>题材<select value={text.genre} onChange={(event) => update({ genre: event.target.value })}><option>剧情短片</option><option>电影长片</option><option>短剧</option><option>广告片</option><option>纪录片</option><option>动画</option></select></label>
        <label>输出格式<select value={text.format} onChange={(event) => update({ format: event.target.value })}><option>标准影视剧本</option><option>分场剧本</option><option>文学剧本</option><option>短剧脚本</option></select></label>
        <label>篇幅<select value={text.length} onChange={(event) => update({ length: event.target.value })}><option>短篇</option><option>中篇</option><option>长篇</option></select></label>
        <label>风格<select value={text.tone} onChange={(event) => update({ tone: event.target.value })}><option>电影感</option><option>现实主义</option><option>轻喜剧</option><option>悬疑紧张</option><option>温暖治愈</option></select></label>
        <label>目标受众<select value={text.audience} onChange={(event) => update({ audience: event.target.value })}><option>大众</option><option>青少年</option><option>儿童</option><option>成年观众</option></select></label>
        <label>输出语言<select value={text.language} onChange={(event) => update({ language: event.target.value })}><option>简体中文</option><option>繁体中文</option><option>英文</option></select></label>
        <label>集数<input type="number" min="1" max="100" value={text.episodeCount} onChange={(event) => update({ episodeCount: Number(event.target.value) })} /></label>
        <label>每集分钟<input type="number" min="1" max="120" value={text.episodeMinutes} onChange={(event) => update({ episodeMinutes: Number(event.target.value) })} /></label>
        <label className="ai-range wide">创意强度 <b>{text.creativity}</b><input type="range" min="0.1" max="1.5" step="0.1" value={text.creativity} onChange={(event) => update({ creativity: Number(event.target.value) })} /></label>
        <label className="ai-check"><input type="checkbox" checked={text.includeCharacters} onChange={(event) => update({ includeCharacters: event.target.checked })} />附人物小传</label>
        <label className="ai-check"><input type="checkbox" checked={text.includeStoryboard} onChange={(event) => update({ includeStoryboard: event.target.checked })} />附分镜建议</label>
      </> : <>
        <label>画面比例<select value={image.ratio} onChange={(event) => update({ ratio: event.target.value })}><option>16:9</option><option>9:16</option><option>1:1</option><option>4:3</option><option>3:4</option></select></label>
        <label title={imageSupportsHighResolution ? "当前模型支持高分辨率输出" : "当前模型仅支持 1K，已自动锁定"}>分辨率<select value={image.resolution} disabled={!imageSupportsHighResolution} onChange={(event) => update({ resolution: event.target.value })}><option value="1024">1K</option><option value="2048">2K</option><option value="4096">4K</option></select></label>
        <label>生成数量<select value={image.amount} onChange={(event) => update({ amount: Number(event.target.value) })}><option value="1">1 张</option><option value="2">2 张</option><option value="4">4 张</option></select></label>
        <label>视觉风格<select value={image.style} onChange={(event) => update({ style: event.target.value })}><option>电影写实</option><option>商业摄影</option><option>概念设计</option><option>日系动画</option><option>水彩插画</option><option>3D 渲染</option></select></label>
        <label>随机种子<input type="number" value={image.seed} onChange={(event) => update({ seed: Number(event.target.value) })} /></label>
        <label className="wide">反向提示词<input value={image.negativePrompt} onChange={(event) => update({ negativePrompt: event.target.value })} placeholder="模糊、畸形、低质量……" /></label>
        <label className="ai-range wide">提示词强度 <b>{image.guidance}</b><input type="range" min="1" max="20" step="0.5" value={image.guidance} onChange={(event) => update({ guidance: Number(event.target.value) })} /></label>
      </>}</>}
      <div className="ai-parameter-source wide"><span className={`ai-source-dot ${config.source}`} />{sourceLabel}<small>参数会保存到当前节点</small></div>
    </div>}
  </section>;
}
