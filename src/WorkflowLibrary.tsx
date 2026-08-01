import { ChangeEvent, useMemo, useRef, useState } from "react";
import { COMFY_WORKFLOW_STORE, readComfyWorkflowLibrary, scanComfyParameters, type StoredComfyWorkflow } from "./ComfyWorkflowParameters";

const detectFormat = (value: unknown): "workflow" | "api" | null => {
  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.nodes) && Array.isArray(object.links)) return "workflow";
  const prompt = object.prompt && typeof object.prompt === "object" ? object.prompt as Record<string, unknown> : object;
  return Object.values(prompt).some((node) => node && typeof node === "object" && typeof (node as Record<string, unknown>).class_type === "string") ? "api" : null;
};

const downloadJson = (name: string, content: unknown) => {
  const blob = new Blob([JSON.stringify(content, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const workflowToApi = (raw: unknown, objectInfo: Record<string, any>) => {
  const workflow = raw as { nodes?: any[]; links?: any[] };
  const links = new Map<number, any>((workflow.links || []).map((link) => [Number(link[0]), link]));
  const result: Record<string, unknown> = {};
  for (const node of workflow.nodes || []) {
    const inputs: Record<string, unknown> = {};
    for (const input of node.inputs || []) {
      if (input.link == null) continue;
      const link = links.get(Number(input.link));
      if (link) inputs[input.name] = [String(link[1]), Number(link[2])];
    }
    const schema = objectInfo[node.type]?.input || {};
    const widgetEntries = [...Object.entries(schema.required || {}), ...Object.entries(schema.optional || {})]
      .filter(([name, definition]: [string, any]) => !inputs[name] && !(definition?.[1]?.forceInput));
    const widgets = Array.isArray(node.widgets_values) ? [...node.widgets_values] : [];
    let widgetIndex = 0;
    for (const [name, definition] of widgetEntries as Array<[string, any]>) {
      if (widgetIndex >= widgets.length) break;
      let value = widgets[widgetIndex++];
      const expected = definition?.[0];
      if ((expected === "INT" || expected === "FLOAT") && typeof widgets[widgetIndex] === "string" && ["fixed", "increment", "decrement", "randomize"].includes(widgets[widgetIndex])) widgetIndex++;
      if (value !== undefined) inputs[name] = value;
    }
    result[String(node.id)] = { inputs, class_type: node.type, _meta: { title: node.title || node.type } };
  }
  return result;
};

const apiToWorkflow = (raw: unknown, objectInfo: Record<string, any>) => {
  const object = raw as Record<string, any>;
  const prompt = object.prompt && typeof object.prompt === "object" ? object.prompt : object;
  const ids = Object.keys(prompt);
  const linkRows: any[] = [];
  let linkId = 1;
  const nodes = ids.map((id, index) => {
    const item = prompt[id];
    const schema = objectInfo[item.class_type] || {};
    const inputs: any[] = [];
    const widgets: unknown[] = [];
    for (const [name, value] of Object.entries(item.inputs || {})) {
      if (Array.isArray(value) && value.length === 2 && ids.includes(String(value[0]))) {
        const currentLink = linkId++;
        inputs.push({ name, type: "*", link: currentLink });
        linkRows.push([currentLink, Number(value[0]), Number(value[1]), Number(id), inputs.length - 1, "*"]);
      } else {
        widgets.push(value);
      }
    }
    return {
      id: Number(id), type: item.class_type, pos: [80 + (index % 4) * 280, 80 + Math.floor(index / 4) * 210],
      size: [220, 120], flags: {}, order: index, mode: 0, inputs,
      outputs: (schema.output || []).map((type: string, slot: number) => ({ name: schema.output_name?.[slot] || type, type, links: linkRows.filter((link) => link[1] === Number(id) && link[2] === slot).map((link) => link[0]) })),
      properties: { "Node name for S&R": item.class_type }, widgets_values: widgets,
    };
  });
  for (const link of linkRows) {
    const origin = nodes.find((node) => node.id === Number(link[1]));
    const output = origin?.outputs?.[Number(link[2])];
    if (output && !output.links.includes(link[0])) output.links.push(link[0]);
  }
  return { last_node_id: Math.max(0, ...ids.map(Number)), last_link_id: linkId - 1, nodes, links: linkRows, groups: [], config: {}, extra: {}, version: 0.4 };
};

export default function WorkflowLibrary({
  open,
  onClose,
  apiUrl,
  onAddToCanvas,
}: {
  open: boolean;
  onClose: () => void;
  apiUrl: string;
  onAddToCanvas: (workflow: unknown, name: string, item: StoredComfyWorkflow) => void;
}) {
  const [items, setItems] = useState<StoredComfyWorkflow[]>(readComfyWorkflowLibrary);
  const [search, setSearch] = useState("");
  const [format, setFormat] = useState<"all" | "workflow" | "api">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState("支持 ComfyUI Workflow JSON 与 API Prompt JSON");
  const fileRef = useRef<HTMLInputElement>(null);
  const visible = useMemo(() => items.filter((item) => (format === "all" || item.format === format) && `${item.name} ${item.tags.join(" ")}`.toLowerCase().includes(search.toLowerCase())), [items, search, format]);
  if (!open) return null;

  const saveItems = (next: StoredComfyWorkflow[]) => {
    setItems(next);
    localStorage.setItem(COMFY_WORKFLOW_STORE, JSON.stringify(next));
  };
  const importFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    const additions: StoredComfyWorkflow[] = [];
    for (const file of files) {
      try {
        const content = JSON.parse(await file.text());
        const detected = detectFormat(content);
        if (!detected) throw new Error("无法识别格式");
        additions.push({
          id: crypto.randomUUID(), name: file.name.replace(/\.json$/i, ""), description: "",
          tags: detected === "api" ? ["API"] : ["Workflow"], format: detected,
          content, createdAt: Date.now(), updatedAt: Date.now(),
        });
      } catch (error) {
        setMessage(`${file.name} 导入失败：${String(error)}`);
      }
    }
    if (additions.length) {
      saveItems([...additions, ...items]);
      setSelected(additions[0].id);
      setMessage(`已导入 ${additions.length} 个工作流`);
    }
    event.target.value = "";
  };
  const getObjectInfo = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<Record<string, any>>("get_comfy_object_info", { endpoint: apiUrl });
    } catch {
      setMessage("未读取到 ComfyUI 节点定义；仍会导出结构，但自定义节点参数可能需要在 ComfyUI 中检查。");
      return {};
    }
  };
  const exportAs = async (item: StoredComfyWorkflow, target: "workflow" | "api") => {
    const info = item.format === target ? {} : await getObjectInfo();
    const content = item.format === target ? item.content : target === "api" ? workflowToApi(item.content, info) : apiToWorkflow(item.content, info);
    downloadJson(`${item.name}.${target === "api" ? "api" : "workflow"}.json`, content);
    setMessage(`已导出 ${target === "api" ? "API Prompt" : "Workflow"} JSON`);
  };

  const scanParameters = async (item: StoredComfyWorkflow) => {
    const apiContent = item.format === "api" ? item.content : workflowToApi(item.content, await getObjectInfo());
    const scanned = scanComfyParameters(apiContent);
    const previous = new Map((item.parameters || []).map((parameter) => [parameter.id, parameter]));
    const parameters = scanned.map((parameter) => previous.has(parameter.id) ? { ...parameter, ...previous.get(parameter.id), value: parameter.value } : parameter);
    saveItems(items.map((candidate) => candidate.id === item.id ? { ...candidate, apiContent, parameters, updatedAt: Date.now() } : candidate));
    setMessage(`已扫描 ${scanned.length} 个输入，默认发布 ${parameters.filter((parameter) => parameter.enabled).length} 个常用参数`);
  };
  const updateParameter = (workflowId: string, parameterId: string, patch: Record<string, unknown>) => {
    saveItems(items.map((item) => item.id === workflowId ? {
      ...item,
      parameters: (item.parameters || []).map((parameter) => parameter.id === parameterId ? { ...parameter, ...patch } : parameter),
      updatedAt: Date.now(),
    } : item));
  };

  const current = items.find((item) => item.id === selected) || visible[0];
  return <div className="workflow-library-backdrop" onPointerDown={onClose}>
    <section className="workflow-library" onPointerDown={(event) => event.stopPropagation()}>
      <header>
        <div><span>COMFYUI</span><b>工作流库</b><small>{message}</small></div>
        <button onClick={onClose}>×</button>
      </header>
      <div className="workflow-library-toolbar">
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称或标签" />
        <select value={format} onChange={(event) => setFormat(event.target.value as typeof format)}><option value="all">全部格式</option><option value="workflow">Workflow</option><option value="api">API Prompt</option></select>
        <button className="primary" onClick={() => fileRef.current?.click()}>＋ 导入 JSON</button>
        <input ref={fileRef} hidden multiple type="file" accept=".json,application/json" onChange={importFiles} />
      </div>
      <div className="workflow-library-body">
        <aside>
          <div className="workflow-library-count">已保存 {items.length} · 当前 {visible.length}</div>
          {visible.length ? visible.map((item) => <button className={current?.id === item.id ? "active" : ""} key={item.id} onClick={() => setSelected(item.id)}>
            <span>{item.format === "api" ? "API" : "WF"}</span><div><b>{item.name}</b><small>{item.format === "api" ? "API Prompt JSON" : "ComfyUI Workflow JSON"}</small></div>
          </button>) : <div className="workflow-library-empty">还没有工作流<br /><small>从 ComfyUI 导出 JSON 后导入这里</small></div>}
        </aside>
        <main>
          {current ? <>
            <div className="workflow-detail-title"><span>{current.format === "api" ? "API" : "WORKFLOW"}</span><div><input value={current.name} onChange={(event) => saveItems(items.map((item) => item.id === current.id ? { ...item, name: event.target.value, updatedAt: Date.now() } : item))} /><small>更新于 {new Date(current.updatedAt).toLocaleString("zh-CN")}</small></div></div>
            <label>说明<textarea value={current.description} onChange={(event) => saveItems(items.map((item) => item.id === current.id ? { ...item, description: event.target.value, updatedAt: Date.now() } : item))} placeholder="记录用途、模型和推荐参数…" /></label>
            <label>标签<input value={current.tags.join("，")} onChange={(event) => saveItems(items.map((item) => item.id === current.id ? { ...item, tags: event.target.value.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean), updatedAt: Date.now() } : item))} placeholder="例如：文生图，FLUX，写实" /></label>
            <div className="workflow-json-summary"><b>结构检查</b><span>{current.format === "workflow" ? `${(current.content as any)?.nodes?.length || 0} 个节点 · ${(current.content as any)?.links?.length || 0} 条连接` : `${Object.keys((current.content as any)?.prompt || current.content || {}).length} 个 API 节点`}</span><small>导出另一种格式时会使用当前 ComfyUI 的 `/object_info` 补全节点定义。</small></div>
            <section className="workflow-parameter-editor">
              <header><div><b>生成参数</b><small>勾选后会显示在 AI 生成面板中；运行时只修改工作流副本</small></div><button onClick={() => void scanParameters(current)}>{current.parameters?.length ? "重新扫描" : "扫描参数"}</button></header>
              {current.parameters?.length ? <div className="workflow-parameter-list">{current.parameters.map((parameter) => <article className={parameter.enabled ? "enabled" : ""} key={parameter.id}>
                <input type="checkbox" checked={parameter.enabled} onChange={(event) => updateParameter(current.id, parameter.id, { enabled: event.target.checked })} />
                <div><input className="workflow-parameter-label" value={parameter.label} onChange={(event) => updateParameter(current.id, parameter.id, { label: event.target.value })} /><small>{parameter.nodeTitle} · {parameter.input}</small></div>
                {parameter.kind === "boolean"
                  ? <select value={String(parameter.value)} onChange={(event) => updateParameter(current.id, parameter.id, { value: event.target.value === "true" })}><option value="true">开启</option><option value="false">关闭</option></select>
                  : <input type={parameter.kind === "number" ? "number" : "text"} value={String(parameter.value)} onChange={(event) => updateParameter(current.id, parameter.id, { value: parameter.kind === "number" ? Number(event.target.value) : event.target.value })} />}
              </article>)}</div> : <div className="workflow-parameter-empty">点击“扫描参数”，自动读取 Seed、Steps、CFG、尺寸、采样器、模型、提示词及自定义节点输入。</div>}
            </section>
            <div className="workflow-library-actions">
              <button className="primary" onClick={() => onAddToCanvas(current.apiContent || current.content, current.name, current)}>添加到画布</button>
              <button onClick={() => exportAs(current, "workflow")}>导出 Workflow</button>
              <button onClick={() => exportAs(current, "api")}>导出 API</button>
              <button className="danger" onClick={() => { saveItems(items.filter((item) => item.id !== current.id)); setSelected(null); }}>删除</button>
            </div>
          </> : <div className="workflow-detail-empty"><b>把常用工作流集中放在这里</b><span>支持 ComfyUI 菜单导出的 Workflow JSON，以及“保存（API格式）”得到的 API Prompt JSON。</span></div>}
        </main>
      </div>
    </section>
  </div>;
}
