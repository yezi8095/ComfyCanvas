import { useMemo, useState, useEffect, useRef } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";

type Kind = "image" | "video" | "audio" | "text" | "storyboard" | "batch" | "aiText" | "aiImage" | "onlineVideo";

interface MediaGroupData {
  id: string;
  name: string;
}

interface MediaLibraryProps {
  open: boolean;
  onClose: () => void;
  nodes: Array<{
    id: string;
    kind: Kind | "api";
    x: number;
    y: number;
    width: number;
    height: number;
    name: string;
    src?: string;
    text?: string;
    storyboard?: Array<{ shot: string; visual: string; dialogue: string; imageId?: string }>;
    fileName?: string;
    localPath?: string;
    createdAt?: number;
  }>;
  onDeleteNode: (id: string) => void;
  onRenameNode: (id: string, name: string) => void;
  onAddNode: (kind: Kind, pos: { x: number; y: number }, extra?: Record<string, unknown>) => void;
  onNavigateTo: (x: number, y: number) => void;
  viewportCenter: () => { x: number; y: number };
}

type LibraryNode = MediaLibraryProps["nodes"][number];
type PreviewItem = { kind: Kind; src: string; name: string; nodeId: string };
type LibraryContextMenu = { x: number; y: number; nodeId: string; isNew?: "group" | "content" };

/**
 * Canvas nodes created by older projects can contain only `localPath`.
 * A WebView cannot load a native Windows path directly, so translate it to
 * Tauri's `asset://` URL before handing it to <img>, <video> or <audio>.
 */
const resolveMediaSrc = (node: LibraryNode) => {
  const raw = (node.src || node.localPath || "").trim();
  if (!raw) return "";
  if (/^(?:https?:|data:|blob:|asset:|tauri:)/i.test(raw)) return raw;
  let local = raw;
  if (/^file:/i.test(local)) {
    try {
      local = decodeURIComponent(new URL(local).pathname).replace(/^\/([a-z]:[\\/])/i, "$1");
    } catch {
      local = local.replace(/^file:\/\/{2,3}/i, "");
    }
  }
  if (/^[a-z]:[\\/]/i.test(local) || local.startsWith("\\\\")) {
    try {
      return convertFileSrc(local);
    } catch {
      return local;
    }
  }
  return local;
};

/*
 * v4 deliberately starts with a clean group list.  Previous versions used
 * "整理" to persist automatic type groups (图片 / 视频 / 音频 …), which made
 * them reappear after users had removed them from the sidebar.
 */
const STORE = "ym-media-library-v4";

function loadState() {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return { groups: [], assigns: {} as Record<string, string> };
    const p = JSON.parse(raw);
    return {
      groups: Array.isArray(p.groups) ? p.groups : [],
      assigns: (typeof p.assigns === "object" && p.assigns) ? p.assigns : {},
    };
  } catch {
    return { groups: [], assigns: {} };
  }
}

let gid = Date.now();
const newGroupId = () => "g-" + gid++ + "-" + Math.random().toString(36).slice(2, 6);

const tabs = [
  { id: "all", label: "全部" },
  { id: "text", label: "文本" },
  { id: "storyboard", label: "脚本/分镜" },
  { id: "image", label: "图片" },
  { id: "video", label: "视频" },
  { id: "audio", label: "音频" },
] as const;

const typeLabel: Record<string, string> = { image: "图片", video: "视频", audio: "音频", text: "文本", storyboard: "脚本/分镜" };

export default function MediaLibrary({ open, onClose, nodes, onDeleteNode, onRenameNode, onAddNode, onNavigateTo, viewportCenter }: MediaLibraryProps) {
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const [selGroup, setSelGroup] = useState("all");
  const [groups, setGroups] = useState<MediaGroupData[]>(() => loadState().groups);
  const [assigns, setAssigns] = useState<Record<string, string>>(() => loadState().assigns);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [renameGid, setRenameGid] = useState<string | null>(null);
  const [renameGtext, setRenameGtext] = useState("");
  const [menuGid, setMenuGid] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [newGroupInput, setNewGroupInput] = useState(false);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewItem | null>(null);
  const [previewZoom, setPreviewZoom] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<LibraryContextMenu | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [organized, setOrganized] = useState(false);
  const [portraits, setPortraits] = useState<Record<string, boolean>>({});
  const menuDismissTimer = useRef<number | null>(null);

  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify({ groups, assigns })); } catch { }
  }, [groups, assigns]);
  const library = useMemo(() => {
    return nodes.filter((n) => {
      if (["image", "video", "audio"].includes(n.kind)) return !!(n.src || n.localPath);
      if (n.kind === "text") return !!n.text;
      if (n.kind === "storyboard") return !!(n.storyboard && n.storyboard.length > 0);
      return false;
    });
  }, [nodes]);

  const filtered = useMemo(() => {
    let list = library;
    if (tab !== "all") list = list.filter((n) => n.kind === tab);
    if (selGroup === "__ungrouped") list = list.filter((n) => !assigns[n.id]);
    else if (selGroup !== "all") list = list.filter((n) => assigns[n.id] === selGroup);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((n) => n.name.toLowerCase().includes(q) || (n.fileName || "").toLowerCase().includes(q));
    }
    const kindOrder: Record<string, number> = { image: 0, video: 1, audio: 2, text: 3, storyboard: 4 };
    return [...list].sort((a, b) => {
      if (organized && kindOrder[a.kind] !== kindOrder[b.kind]) return kindOrder[a.kind] - kindOrder[b.kind];
      const at = a.createdAt || Number(String(a.id).split("-")[0]) || 0;
      const bt = b.createdAt || Number(String(b.id).split("-")[0]) || 0;
      return bt - at;
    });
  }, [library, tab, selGroup, assigns, search, organized]);

  const delGroup = (id: string) => {
    if (id === "default") return;
    setGroups((p) => p.filter((g) => g.id !== id));
    setAssigns((p) => { const n = { ...p }; for (const k of Object.keys(n)) { if (n[k] === id) delete n[k]; } return n; });
    if (selGroup === id) setSelGroup("all");
  };

  const moveToGroup = (id: string, gid: string) => setAssigns((p) => {
    const next = { ...p };
    if (gid === "__ungrouped") delete next[id];
    else next[id] = gid;
    return next;
  });
  const organize = () => {
    // "整理" only changes the visual ordering.  It must never manufacture
    // persistent type groups, otherwise the left column becomes cluttered
    // again on the next launch.
    setTab("all");
    setSelGroup("all");
    setOrganized(true);
    setCtxMenu(null);
  };


  const handleRename = (id: string, name: string) => {
    setPreview(null);
    setEditId(id);
    setEditName(name);
  };
  const commitRename = () => {
    if (editId && editName.trim()) onRenameNode(editId, editName.trim());
    setEditId(null);
    setEditName("");
  };
  const commitGroupRename = () => {
    if (renameGid && renameGtext.trim()) {
      setGroups((current) => current.map((group) => group.id === renameGid ? { ...group, name: renameGtext.trim() } : group));
    }
    setRenameGid(null);
    setRenameGtext("");
  };
  const beginGroupRename = (id: string, name: string) => {
    setCtxMenu(null);
    setMenuGid(null);
    setRenameGid(id);
    setRenameGtext(name);
  };
  const createGroup = (name: string) => {
    const clean = name.trim();
    if (!clean) return;
    const group = { id: newGroupId(), name: clean };
    setGroups((current) => [...current, group]);
    setSelGroup(group.id);
    setNewGroupInput(false);
  };
  const notePortrait = (id: string, width: number, height: number) => {
    const isPortrait = height > width * 1.08;
    setPortraits((current) => current[id] === isPortrait ? current : { ...current, [id]: isPortrait });
  };
  const handlePreview = (node: LibraryNode) => {
    const src = resolveMediaSrc(node);
    if (!src || !["image", "video", "audio"].includes(node.kind)) return;
    setPreviewZoom(false);
    setPlaying(node.kind === "audio" ? node.id : null);
    setPreview({ kind: node.kind as Kind, src, name: node.name, nodeId: node.id });
  };
  const closePreview = () => {
    setPlaying(null);
    setPreviewZoom(false);
    setPreview(null);
  };
  const closeLibrary = () => {
    if (menuDismissTimer.current) window.clearTimeout(menuDismissTimer.current);
    setPlaying(null);
    setPreview(null);
    setPreviewZoom(false);
    setCtxMenu(null);
    setMenuGid(null);
    onClose();
  };
  const openContextMenu = (x: number, y: number, next: Omit<LibraryContextMenu, "x" | "y">) => {
    const menuWidth = next.isNew === "content" ? 180 : 210;
    const menuHeight = next.isNew ? 250 : 270;
    setMenuGid(null);
    setCtxMenu({
      ...next,
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8)),
    });
  };
  const refreshLibrary = () => {
    setSearch("");
    setTab("all");
    setSelGroup("all");
    setOrganized(false);
    setPlaying(null);
    setPreview(null);
    setCtxMenu(null);
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (preview) closePreview();
        else closeLibrary();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, preview]);

  const placeOnCanvas = (node: typeof library[number]) => {
    const c = viewportCenter();
    onAddNode(node.kind as Kind, { x: c.x - 150, y: c.y - 110 }, { name: node.name, src: resolveMediaSrc(node), text: node.text, storyboard: node.storyboard, fileName: node.fileName, localPath: node.localPath });
    onNavigateTo(c.x - 150, c.y - 110);
    onClose();
  };

  const groupCount = (gid: string) => library.filter((n) => assigns[n.id] === gid).length;

  if (!open) return null;

  return (
    <div
      className="media-lib-overlay"
      /*
       * Do not use a blanket PointerDown handler here.  In the Windows WebView
       * it can race the click generated for controls inside the dialog, which
       * makes every button/input look visible but inert.  Only an actual click
       * on the dark backdrop closes the library; the panel owns its controls.
       */
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeLibrary();
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        className="media-lib-panel"
        onPointerDown={(event) => {
          event.stopPropagation();
          // A normal left click away from a context menu dismisses it.  Do not
          // preventDefault here: inputs and buttons inside the dialog must
          // keep their native click/focus behavior in the Windows WebView.
          const target = event.target as HTMLElement;
          if (!target.closest(".media-lib-ctxmenu, .media-lib-grp-menu")) {
            setCtxMenu(null);
            setMenuGid(null);
          }
        }}
      >
        <div className="media-lib-head">
          <div className="media-lib-title">
            <b>素材库</b>
            <small>{library.length} 项</small>
          </div>
          <button
            className="media-lib-exit"
            type="button"
            aria-label="关闭素材库"
            onPointerDown={(event) => {
              // Close on pointer-down instead of waiting for a synthetic click:
              // the director canvas also listens for pointer events and older
              // Windows WebViews may otherwise swallow this button's click.
              event.preventDefault();
              event.stopPropagation();
              closeLibrary();
            }}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); closeLibrary(); }}
          >退出</button>
        </div>

          <div className="media-lib-body">
          <aside className="media-lib-sidebar">
            <div className="media-lib-sbar-title">
              <span>分组</span>
              <button className="media-lib-add-grp" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => { setCtxMenu(null); setNewGroupInput(true); }} title="新建分组">＋</button>
            </div>
            {newGroupInput && (
              <div className="media-lib-new-grp">
                <input className="media-lib-rename-inp" placeholder="输入分组名称..." autoFocus
                  onBlur={() => setNewGroupInput(false)}
                  onPointerDown={(event) => event.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") createGroup((e.target as HTMLInputElement).value);
                    if (e.key === "Escape") setNewGroupInput(false);
                  }}
                />
              </div>
            )}
            <div
              className="media-lib-glist"
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenuGid(null);
                openContextMenu(e.clientX, e.clientY, { nodeId: "", isNew: "group" });
              }}
            >
              <div
                className={"media-lib-grp" + (selGroup === "all" ? " active" : "") + (dragOver === "all" ? " drag-over" : "")}
                onClick={() => setSelGroup("all")}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {}}
              >
                <span className="media-lib-grp-name">全部</span>
                <span className="media-lib-grp-cnt">{library.length}</span>
              </div>
              {groups.map((g) => (
                <div key={g.id} className={"media-lib-grp-row" + (selGroup === g.id ? " active" : "")}>
                  <div
                    className={"media-lib-grp" + (selGroup === g.id ? " active" : "") + (dragOver === g.id ? " drag-over" : "")}
                    onClick={() => setSelGroup(g.id)}
                    onDoubleClick={(event) => { event.stopPropagation(); beginGroupRename(g.id, g.name); }}
                    onDragEnter={(e) => { e.preventDefault(); setDragOver(g.id); }}
                    onDragLeave={() => setDragOver(null)}
                    onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain"); if (id) moveToGroup(id, g.id); setDragOver(null); }}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxMenu(null); setMenuGid(menuGid === g.id ? null : g.id); }}
                  >
                    {renameGid === g.id ? (
                      <input className="media-lib-rename-inp" value={renameGtext} onChange={(e) => setRenameGtext(e.target.value)} onBlur={commitGroupRename} onKeyDown={(e) => { if (e.key === "Enter") commitGroupRename(); if (e.key === "Escape") { setRenameGid(null); setRenameGtext(""); } }} autoFocus onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} />
                    ) : (
                      <>
                        <span className="media-lib-grp-name">{g.name}</span>
                        <span className="media-lib-grp-cnt">{groupCount(g.id)}</span>
                        <button
                          className="media-lib-grp-edit"
                          title="重命名分组"
                          type="button"
                          onClick={(e) => { e.stopPropagation(); beginGroupRename(g.id, g.name); }}
                        >✎</button>
                      </>
                    )}
                  </div>
                  {menuGid === g.id && g.id !== "default" && (
                    <div className="media-lib-grp-menu" onPointerDown={(e) => e.stopPropagation()}>
                      <button type="button" onClick={() => { beginGroupRename(g.id, g.name); setMenuGid(null); }}>重命名</button>
                      <button type="button" className="danger" onClick={() => { delGroup(g.id); setMenuGid(null); }}>删除</button>
                    </div>
                  )}
                </div>
              ))}
              <div className="media-lib-group-space" aria-label="分组管理空白区域" />
            </div>
            <div className="media-lib-credit">右键空白区域可添加或删除分组</div>
          </aside>

          <div className="media-lib-main">
            <div className="media-lib-toolbar">
              <div className="media-lib-tabs">
                {tabs.map((t) => (
                  <button key={t.id} type="button" className={"media-lib-tab" + (tab === t.id ? " active" : "")} onClick={() => setTab(t.id)}>{t.label}</button>
                ))}
              </div>
              <div className="media-lib-srch">
                <input type="text" placeholder="搜索名称…" value={search} onPointerDown={(event) => event.stopPropagation()} onChange={(e) => setSearch(e.target.value)} />
                {search && <button type="button" className="media-lib-srch-clr" onClick={() => setSearch("")}>✕</button>}
              </div>
          <button type="button" className="media-lib-org-btn" onClick={organize} title="按类型自动分类整理">⇶ 整理</button>
            </div>
            {filtered.length === 0 ? (
              <div className="media-lib-empty">
                {search ? "没有匹配的素材" : "画布中还没有" + (tab === "all" ? "素材" : tabs.find((t) => t.id === tab)?.label || "素材")}
              </div>
            ) : (
              <div
                className="media-lib-grid"
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const card = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
                  const nodeId = card?.dataset.nodeId;
                  openContextMenu(event.clientX, event.clientY, nodeId ? { nodeId } : { nodeId: "", isNew: "content" });
                }}
              >
                {filtered.map((node, index) => {
                  const gname = assigns[node.id] ? groups.find((g) => g.id === assigns[node.id])?.name || "未分组" : "未分组";
                  const previous = filtered[index - 1];
                  const typeBreak = organized && (!previous || previous.kind !== node.kind);
                  const mediaSrc = resolveMediaSrc(node);
                  return (
                    <div key={node.id} className="media-lib-type-section">
                    {typeBreak && <div className="media-lib-type-heading">{typeLabel[node.kind]}</div>}
                    <div
                      className={"media-lib-card" + (editId === node.id ? " editing" : "")}
                      data-node-id={node.id}
                      onClick={() => handlePreview(node)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        openContextMenu(event.clientX, event.clientY, { nodeId: node.id });
                      }}
                    >
                      <div
                        className={"media-lib-card-thumb" + (portraits[node.id] ? " portrait" : "")}
                        draggable={true}
                        onDragStart={(e) => { e.dataTransfer.setData("text/plain", node.id); e.dataTransfer.effectAllowed = "move"; }}
                        onDragEnd={() => setDragOver(null)}
                      >
                        {node.kind === "image" ? (
                          <img src={mediaSrc} alt={node.name} draggable={false} onLoad={(event) => notePortrait(node.id, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} />
                        ) : node.kind === "video" ? (
                          <video src={mediaSrc} preload="metadata" muted playsInline onLoadedMetadata={(event) => notePortrait(node.id, event.currentTarget.videoWidth, event.currentTarget.videoHeight)} />
                        ) : node.kind === "audio" ? (
                          <div className={"media-lib-card-audio" + (playing === node.id ? " playing" : "")}>
                            <div className="media-lib-audio-bars">{Array.from({ length: 12 }).map((_, i) => (<i key={i} style={{ height: 5 + Math.abs(Math.sin(i * 0.7)) * 12 + "px" }} />))}</div>
                          </div>
                        ) : node.kind === "text" ? (
                          <div className="media-lib-card-text">{(node.text || "").slice(0, 80)}{(node.text || "").length > 80 ? "…" : ""}</div>
                        ) : (
                          <div className="media-lib-card-sb">{(node.storyboard || []).length} 个镜头</div>
                        )}
                        <span className={"media-lib-card-badge " + node.kind}>{typeLabel[node.kind]}</span>
                      </div>
                      <div className="media-lib-card-info">
                        {editId === node.id ? (
                          <input className="media-lib-rename-inp" value={editName} onChange={(e) => setEditName(e.target.value)} onBlur={commitRename} onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") { setEditId(null); setEditName(""); } }} autoFocus onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} />
                        ) : (
                          <span className="media-lib-card-name" title="点击重命名" onClick={(event) => { event.stopPropagation(); handleRename(node.id, node.name); }}>{node.name}</span>
                        )}
                        <span className="media-lib-card-grp">{gname}</span>
                      </div>
                      <div className="media-lib-card-actions">
                        <button type="button" className="media-lib-act" title="放到画布" onClick={(event) => { event.stopPropagation(); placeOnCanvas(node); }}>＋</button>
                        {editId !== node.id && <button type="button" className="media-lib-act" title="重命名" onClick={(event) => { event.stopPropagation(); handleRename(node.id, node.name); }}>✎</button>}
                        <button type="button" className="media-lib-act danger" title="删除" onClick={(event) => { event.stopPropagation(); setConfirmDel(node.id); }}>🗑</button>
                      </div>
                    </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <>
        {preview && (
          <div className="media-lib-preview-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) closePreview(); }}>
            <div className={"media-lib-preview-box" + (previewZoom ? " zoomed" : "")} onPointerDown={(event) => event.stopPropagation()}>
              <button type="button" className="media-lib-preview-close" onClick={closePreview} aria-label="关闭预览">×</button>
              <div className="media-lib-preview-title">{preview.name}</div>
              {preview.kind === "video" ? (
                <video src={preview.src} controls autoPlay playsInline />
              ) : preview.kind === "audio" ? (
                <div className="media-lib-preview-audio">
                  <div className="media-lib-preview-audio-name">♫ {preview.name}</div>
                  <audio
                    src={preview.src}
                    controls
                    autoPlay
                    onPlay={() => setPlaying(preview.nodeId)}
                    onPause={() => setPlaying(null)}
                    onEnded={() => setPlaying(null)}
                  />
                </div>
              ) : (
                <img src={preview.src} alt={preview.name} onClick={() => setPreviewZoom((value) => !value)} title="点击放大或还原" />
              )}
              {preview.kind === "image" && <small className="media-lib-preview-tip">点击画面可放大 / 还原</small>}
            </div>
          </div>
        )}
        {ctxMenu && (
          <div className="media-lib-ctxmenu" onPointerDown={(e) => e.stopPropagation()} style={{ position: "fixed", left: ctxMenu.x, top: ctxMenu.y, zIndex: 1200 }}>
            {ctxMenu.isNew === "group" ? (
              <>
                <div className="media-lib-ctx-title">分组管理</div>
                <button type="button" className="media-lib-ctx-item" onClick={() => { setNewGroupInput(true); setCtxMenu(null); }}>添加分组</button>
                {groups.length > 0 && <>
                  <div className="media-lib-ctx-sep" />
                  <div className="media-lib-ctx-title">删除分组</div>
                  {groups.map((g) => (
                    <button type="button" key={g.id} className="media-lib-ctx-item danger" onClick={() => { delGroup(g.id); setCtxMenu(null); }}>删除：{g.name}</button>
                  ))}
                </>}
              </>
            ) : ctxMenu.isNew === "content" ? (
              <>
                <div className="media-lib-ctx-title">添加素材</div>
                <button type="button" className="media-lib-ctx-item" onClick={() => { const c = viewportCenter(); onAddNode("image" as Kind, { x: c.x - 150, y: c.y - 110 }); setCtxMenu(null); onClose(); }}>添加图片</button>
                <button type="button" className="media-lib-ctx-item" onClick={() => { const c = viewportCenter(); onAddNode("video" as Kind, { x: c.x - 160, y: c.y - 110 }); setCtxMenu(null); onClose(); }}>添加视频</button>
                <button type="button" className="media-lib-ctx-item" onClick={() => { const c = viewportCenter(); onAddNode("audio" as Kind, { x: c.x - 110, y: c.y - 41 }); setCtxMenu(null); onClose(); }}>添加音频</button>
                <button type="button" className="media-lib-ctx-item" onClick={() => { const c = viewportCenter(); onAddNode("text" as Kind, { x: c.x - 135, y: c.y - 87 }); setCtxMenu(null); onClose(); }}>添加文本</button>
                <button type="button" className="media-lib-ctx-item" onClick={() => { const c = viewportCenter(); onAddNode("storyboard" as Kind, { x: c.x - 190, y: c.y - 115 }); setCtxMenu(null); onClose(); }}>添加脚本/分镜</button>
                <div className="media-lib-ctx-sep" />
                <button type="button" className="media-lib-ctx-item" onClick={refreshLibrary}>刷新素材库</button>
              </>
            ) : (
              <>
                <div className="media-lib-ctx-title">素材操作</div>
                <button type="button" className="media-lib-ctx-item" onClick={() => { const node = library.find((item) => item.id === ctxMenu.nodeId); if (node) handleRename(node.id, node.name); setCtxMenu(null); }}>重命名</button>
                <button type="button" className="media-lib-ctx-item danger" onClick={() => { setConfirmDel(ctxMenu.nodeId); setCtxMenu(null); }}>删除选定内容</button>
                <div className="media-lib-ctx-sep" />
                <div className="media-lib-ctx-title">移动分组</div>
                {groups.map((g) => (
                  <button type="button" key={g.id} className="media-lib-ctx-item" onClick={() => { moveToGroup(ctxMenu.nodeId, g.id); setCtxMenu(null); }}>{g.name}</button>
                ))}
                <button type="button" className="media-lib-ctx-item" onClick={() => { moveToGroup(ctxMenu.nodeId, "__ungrouped"); setCtxMenu(null); }}>取消分组</button>
              </>
            )}
          </div>
        )}
        </>
        {confirmDel && (
          <div className="media-lib-confirm-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) setConfirmDel(null); }}>
            <div className="media-lib-confirm-box" onPointerDown={(event) => event.stopPropagation()}>
              <b>确认删除</b>
              <p>同时从画布和素材库中移除，确定？</p>
              <div className="media-lib-confirm-actions">
                <button type="button" onClick={() => setConfirmDel(null)}>取消</button>
                <button type="button" className="danger" onClick={() => { onDeleteNode(confirmDel); setAssigns((p) => { const n = { ...p }; delete n[confirmDel]; return n; }); setConfirmDel(null); }}>删除</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
