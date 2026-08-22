import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  directorAssetsForStorage,
  isSessionOnlyDirectorSource,
  readJson,
  writeJson,
} from "./core/director/persistence";
import { getPreviewFrame, getTimelineBounds } from "./core/director/layout";
import {
  DesktopMediaStoreUnavailableError,
  uploadWorkspaceAsset,
  type ManagedWorkspaceAsset,
} from "./core/assets/workspaceAssetClient";
import { cleanupUnattachedWorkspaceAsset } from "./core/assets/workspaceAssetLifecycle";

type Kind = "image" | "video" | "audio" | "text" | "storyboard" | "api" | "batch" | "aiText" | "aiImage" | "onlineVideo";
type Node = { id: string; kind: Kind; name: string; src?: string; localPath?: string; text?: string; mediaWidth?: number; mediaHeight?: number };
type TrackKind = "video" | "audio" | "text";
type TrackInfo = { id: string; kind: TrackKind; name: string; used?: boolean };
type Clip = { clipId: string; assetId: string; trackId: string; start: number; inPoint: number; duration: number };
/** `inPoint` is the source offset for a trimmed/split audio segment.  Keeping
 * it next to the visual clip offset is what lets the second half of a cut play
 * from the correct part of the original file instead of starting again. */
type AudioClip = { clipId: string; assetId: string; trackId: string; start: number; inPoint: number; duration: number };
type TextClip = { clipId: string; trackId: string; text: string; start: number; duration: number; x: number; y: number; fontSize: number };
type Data = {
  script: string;
  timeline: Clip[];
  audio: AudioClip[];
  textTrack: TextClip[];
  tracks: TrackInfo[];
  trackEnabled: Record<string, boolean>;
  videoMuted: boolean;
};
type DirectorAsset = {
  id: string;
  /** Stable id assigned by the managed desktop-media store.  It intentionally
   * remains separate from the shelf id so old browser-only imports can still
   * be read without pretending that they are durable. */
  assetId?: string;
  kind: "image" | "video" | "audio";
  name: string;
  source?: "canvas" | "external";
  src?: string;
  /** Absolute path returned only by the desktop media store.  It is resolved
   * to a WebView-safe URL at render time, never copied into localStorage. */
  localPath?: string;
  /** FileReader/blob sources are deliberately kept only in the live session. */
  sessionOnly?: boolean;
  groupId?: string;
  groupName?: string;
  mediaWidth?: number;
  mediaHeight?: number;
};
type Selection = { track: TrackKind; id: string };
type ContextMenu = Selection & { x: number; y: number };
type TimelineDragPreview = { selection: Selection; selections: Selection[]; trackId: string; start: number };
type ExportFormat = "mp4" | "mov";
type ExportResolution = "720p" | "1080p";
type LoadResult<T> = { value: T; warning?: string; readFailed?: boolean };

const LEGACY_STORE = "ym-director-editor-v2";
const STORE_VERSION = "ym-director-editor-v3";
const MIGRATION_KEY = "ym-director-editor-v3-migrated";
const storeKey = (projectId: string) => `${STORE_VERSION}:${projectId}`;
const ASSET_STORE_VERSION = "ym-director-assets-v1";
const assetStoreKey = (projectId: string) => `${ASSET_STORE_VERSION}:${projectId}`;
const PPS = 48;
const TIMELINE_LABEL_WIDTH = 52;
const MAX_TRACKS_PER_KIND = 5;
const MIN_CLIP_DURATION = 0.25;
const DEFAULT_CLIP_DURATION = 5;
const BASE_TRACKS: Array<TrackInfo & { id: "video-main" | "audio-main" | "text-main" }> = [
  { id: "video-main", kind: "video", name: "视频 1" },
  { id: "audio-main", kind: "audio", name: "音频 1" },
  { id: "text-main", kind: "text", name: "文本 1" },
];
const baseTrackId = (kind: TrackKind) => kind === "video" ? "video-main" : kind === "audio" ? "audio-main" : "text-main";
const trackLabel = (kind: TrackKind) => kind === "video" ? "视频" : kind === "audio" ? "音频" : "文本";

const id = () => globalThis.crypto?.randomUUID?.() || String(Date.now()) + "-" + Math.random();
/** Rust accepts a deliberately narrow asset identifier.  Unlike the generic
 * UI id fallback, this cannot accidentally include a decimal point. */
const managedAssetId = () => {
  const random = globalThis.crypto?.randomUUID?.().replace(/[^A-Za-z0-9_-]/g, "")
    || `${Date.now()}${Math.random().toString(36).slice(2)}`.replace(/[^A-Za-z0-9_-]/g, "");
  return `director_${random || Date.now()}`.slice(0, 128);
};
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const number = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
/** Canvas projects made before Director Mode stored a native localPath instead
 * of a WebView-safe `src`.  Resolve it lazily so those materials remain usable
 * in the director shelf, preview, and exporter. */
const sourceForNode = (node: Pick<Node, "src" | "localPath">) => {
  const raw = (node.src || node.localPath || "").trim();
  if (!raw) return "";

  // Newer nodes already hold a WebView-safe asset/data URL.  Older saved
  // projects, however, may have put a native Windows path directly in `src`
  // (rather than in `localPath`).  A <video>/<audio> tag cannot reliably open
  // that path in WebView2, so always normalize it here before the shelf,
  // timeline, preview and exporter consume the node.
  if (/^(?:https?:|data:|blob:|asset:|tauri:)/i.test(raw)) return raw;

  let nativePath = raw;
  if (/^file:/i.test(nativePath)) {
    try {
      nativePath = decodeURIComponent(new URL(nativePath).pathname)
        .replace(/^\/([A-Za-z]:[\\/])/, "$1");
    } catch {
      nativePath = nativePath.replace(/^file:\/\/{2,3}/i, "");
    }
  }
  if (/^[A-Za-z]:[\\/]/.test(nativePath) || nativePath.startsWith("\\\\")) {
    try { return convertFileSrc(nativePath); } catch { return nativePath; }
  }
  return raw;
};
const makeClip = (assetId: string, start = 0, trackId = "video-main"): Clip => ({ clipId: id(), assetId, trackId, start, inPoint: 0, duration: DEFAULT_CLIP_DURATION });
const selectionKey = (selection: Selection) => selection.track + ":" + selection.id;
const selectionFromKey = (value: string): Selection | null => {
  const separator = value.indexOf(":");
  if (separator < 1) return null;
  const track = value.slice(0, separator);
  if (track !== "video" && track !== "audio" && track !== "text") return null;
  return { track, id: value.slice(separator + 1) };
};

function nextFreeStart<T extends { clipId: string; start: number; duration: number }>(
  entries: T[],
  requestedStart: number,
  duration: number,
  ignoreId?: string,
) {
  let start = Math.max(0, requestedStart);
  const ordered = entries
    .filter((entry) => entry.clipId !== ignoreId)
    .slice()
    .sort((left, right) => left.start - right.start);
  for (const entry of ordered) {
    if (start + duration <= entry.start + .001) break;
    if (start < entry.start + entry.duration - .001) start = entry.start + entry.duration;
  }
  return Math.round(start * 100) / 100;
}

function packTimed<T extends { start: number; duration: number }>(entries: T[]) {
  let end = 0;
  return entries
    .slice()
    .sort((left, right) => left.start - right.start)
    .map((entry) => {
      const start = Math.max(entry.start, end);
      end = start + entry.duration;
      return Math.abs(start - entry.start) < .001 ? entry : { ...entry, start } as T;
    });
}

/** Keep clips sequential inside each individual track, while preserving the
 * intentional gaps a user has already created. */
function packByTrack<T extends { trackId: string; start: number; duration: number }>(entries: T[]) {
  const groups = new Map<string, T[]>();
  entries.forEach((entry) => groups.set(entry.trackId, [...(groups.get(entry.trackId) || []), entry]));
  return [...groups.values()].flatMap((group) => packTimed(group));
}

/**
 * Metadata can reveal that a source is longer/shorter than its temporary
 * placeholder duration.  Only clips after the resized clip are pushed, so a
 * deliberate gap remains a gap instead of the whole track being repacked.
 */
function resizeAndPushSuffix<T extends { clipId: string; trackId: string; start: number; duration: number }>(
  entries: T[],
  clipId: string,
  nextDuration: number,
) {
  const target = entries.find((entry) => entry.clipId === clipId);
  if (!target) return entries;
  const trackEntries = entries
    .filter((entry) => entry.trackId === target.trackId)
    .slice()
    .sort((left, right) => left.start - right.start || left.clipId.localeCompare(right.clipId));
  let end = 0;
  const adjusted = trackEntries.map((entry) => {
    const duration = entry.clipId === clipId ? nextDuration : entry.duration;
    const start = Math.max(entry.start, end);
    end = start + duration;
    return start === entry.start && duration === entry.duration ? entry : { ...entry, start, duration } as T;
  });
  return [...entries.filter((entry) => entry.trackId !== target.trackId), ...adjusted];
}

function normalizeClips(value: unknown): Clip[] {
  if (!Array.isArray(value)) return [];
  let following = 0;
  return value.flatMap((raw) => {
    if (typeof raw === "string") {
      const clip = makeClip(raw, following);
      following += clip.duration;
      return [clip];
    }
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const assetId = typeof item.assetId === "string" ? item.assetId : typeof item.id === "string" ? item.id : "";
    if (!assetId) return [];
    const duration = Math.max(MIN_CLIP_DURATION, number(item.duration, DEFAULT_CLIP_DURATION));
    const start = Math.max(0, number(item.start, following));
    following = Math.max(following, start + duration);
    return [{
      clipId: typeof item.clipId === "string" ? item.clipId : id(),
      assetId,
      trackId: typeof item.trackId === "string" ? item.trackId : "video-main",
      start,
      inPoint: Math.max(0, number(item.inPoint, number(item.trimIn, 0))),
      duration,
    }];
  });
}

function normalizeText(value: unknown): TextClip[] {
  if (!Array.isArray(value)) return [];
  let following = 0;
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) return [];
    const duration = Math.max(MIN_CLIP_DURATION, number(item.duration, 3));
    const start = Math.max(0, number(item.start, following));
    following = Math.max(following, start + duration);
    return [{
      clipId: typeof item.clipId === "string" ? item.clipId : id(),
      trackId: typeof item.trackId === "string" ? item.trackId : "text-main",
      text,
      start,
      duration,
      x: Math.max(0, Math.min(1, number(item.x, .5))),
      y: Math.max(0, Math.min(1, number(item.y, .84))),
      fontSize: Math.max(12, Math.min(96, number(item.fontSize, 22))),
    }];
  });
}

function normalizeAudio(value: unknown): AudioClip[] {
  if (!Array.isArray(value)) return [];
  let following = 0;
  return value.flatMap((raw) => {
    if (typeof raw === "string") {
      const made = { clipId: id(), assetId: raw, trackId: "audio-main", start: following, inPoint: 0, duration: 10 };
      following += made.duration;
      return [made];
    }
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const assetId = typeof item.assetId === "string" ? item.assetId : typeof item.id === "string" ? item.id : "";
    if (!assetId) return [];
    const duration = Math.max(MIN_CLIP_DURATION, number(item.duration, 10));
    const start = Math.max(0, number(item.start, following));
    following = Math.max(following, start + duration);
    return [{
      clipId: typeof item.clipId === "string" ? item.clipId : id(),
      assetId,
      trackId: typeof item.trackId === "string" ? item.trackId : "audio-main",
      start,
      inPoint: Math.max(0, number(item.inPoint, number(item.trimIn, 0))),
      duration,
    }];
  });
}

function normalizeTracks(value: unknown): TrackInfo[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>(BASE_TRACKS.map((track) => track.id));
  return value.flatMap((raw): TrackInfo[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : "";
    const kind = item.kind;
    if (!id || seen.has(id) || (kind !== "video" && kind !== "audio" && kind !== "text")) return [];
    seen.add(id);
    return [{
      id,
      kind,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : trackLabel(kind),
      used: item.used === true,
    }];
  });
}

function emptyData(): Data {
  return { script: "", timeline: [], audio: [], textTrack: [], tracks: [], trackEnabled: {}, videoMuted: false };
}

function read(projectId: string): LoadResult<Data> {
  try {
    const scoped = localStorage.getItem(storeKey(projectId));
    // 只迁移一次旧的全局粗剪预览内容，之后每个画布项目都拥有独立时间线。
    const legacy = scoped || localStorage.getItem(MIGRATION_KEY)
      ? null
      : localStorage.getItem(LEGACY_STORE);
    let warning: string | undefined;
    if (legacy) {
      try {
        localStorage.setItem(MIGRATION_KEY, "1");
      } catch {
        warning = "旧粗剪预览内容已读入，但无法写入迁移标记；请在清理浏览器存储空间后点击“重试保存”。";
      }
    }
    const parsed: unknown = JSON.parse(scoped || legacy || "{}");
    const stored = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    const timeline = packByTrack(normalizeClips(stored.timeline));
    const audio = packByTrack(normalizeAudio(stored.audio));
    const textTrack = packByTrack(normalizeText(stored.textTrack));
    return {
      value: {
        script: typeof stored.script === "string" ? stored.script : "",
        timeline,
        audio,
        textTrack,
        tracks: normalizeTracks(stored.tracks),
        trackEnabled: stored.trackEnabled && typeof stored.trackEnabled === "object" && !Array.isArray(stored.trackEnabled)
          ? stored.trackEnabled as Record<string, boolean>
          : {},
        videoMuted: stored.videoMuted === true,
      },
      warning,
    };
  } catch {
    return {
      value: emptyData(),
      readFailed: true,
      warning: "无法读取已保存的时间线。为避免覆盖原记录，已暂停自动保存；确认后可点击“重试保存”创建新的时间线。",
    };
  }
}

function readAssets(projectId: string): LoadResult<DirectorAsset[]> {
  try {
    const loaded = readJson<unknown>(localStorage, assetStoreKey(projectId), []);
    if (!loaded.ok) throw loaded.error;
    const parsed = loaded.value;
    if (!Array.isArray(parsed)) return { value: [] };
    const seen = new Set<string>();
    const assets = parsed.flatMap((raw): DirectorAsset[] => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const item = raw as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id : "";
      const name = typeof item.name === "string" ? item.name : "素材";
      const kind = item.kind;
      if (!id || seen.has(id) || (kind !== "image" && kind !== "video" && kind !== "audio")) return [];
      seen.add(id);
      const source = item.source === "external" ? "external" : "canvas";
      const src = typeof item.src === "string" ? item.src : undefined;
      const localPath = typeof item.localPath === "string" && item.localPath.trim()
        ? item.localPath
        : undefined;
      const assetId = typeof item.assetId === "string" && item.assetId.trim()
        ? item.assetId
        : id;
      return [{
        id,
        assetId,
        name,
        kind,
        source,
        src,
        localPath,
        // Old versions may contain a complete Data URL.  Keep it alive for
        // this open session, then write only its descriptor back to storage.
        // A desktop managed asset deliberately has no `src` in storage: its
        // durable localPath is converted to an asset URL when it is rendered.
        sessionOnly: source === "external" && (
          item.sessionOnly === true || (!localPath && (!src || isSessionOnlyDirectorSource(src)))
        ) ? true : undefined,
        groupId: typeof item.groupId === "string" ? item.groupId : undefined,
        groupName: typeof item.groupName === "string" ? item.groupName : undefined,
        mediaWidth: number(item.mediaWidth, 0) || undefined,
        mediaHeight: number(item.mediaHeight, 0) || undefined,
      }];
    });
    return { value: assets };
  } catch {
    return {
      value: [],
      readFailed: true,
      warning: "无法读取已保存的素材描述。为避免覆盖原记录，已暂停自动保存；确认后可点击“重试保存”。",
    };
  }
}

function timeLabel(value: number) {
  const safe = Math.max(0, value);
  return safe < 60 ? safe.toFixed(1) + "s" : Math.floor(safe / 60) + ":" + String(Math.floor(safe % 60)).padStart(2, "0");
}

function storageFailureMessage(label: string, stage: "serialize" | "write") {
  return stage === "serialize"
    ? `${label}无法序列化，尚未保存。请删减异常内容后重试。`
    : `${label}未保存：本机存储空间不足或不可用。请释放空间后点击“重试保存”。`;
}

export default function DirectorMode({
  projectId,
  open,
  onClose,
  nodes,
  onImportFiles,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  nodes: Node[];
  onImportFiles: (files: File[]) => void;
}) {
  const [initialStorage] = useState(() => {
    const timeline = read(projectId);
    const assets = readAssets(projectId);
    return { timeline, assets };
  });
  // `DirectorMode` can remain mounted while App switches projects.  Track the
  // project that owns the current state explicitly so the old timeline can
  // never be written into the newly opened project's storage key.
  const [dataProjectId, setDataProjectId] = useState(projectId);
  const [data, setData] = useState<Data>(initialStorage.timeline.value);
  const [directorAssets, setDirectorAssets] = useState<DirectorAsset[]>(initialStorage.assets.value);
  const [timelineSaveError, setTimelineSaveError] = useState<string | null>(null);
  const [assetSaveError, setAssetSaveError] = useState<string | null>(null);
  const [storageRecoveryNotice, setStorageRecoveryNotice] = useState<string | null>(() =>
    [initialStorage.timeline.warning, initialStorage.assets.warning].filter((notice): notice is string => Boolean(notice)).join(" ") || null,
  );
  const [storageRetry, setStorageRetry] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const [assetDragId, setAssetDragId] = useState<string | null>(null);
  const [assetPreview, setAssetPreview] = useState<Node | null>(null);
  const [assetHoverPreview, setAssetHoverPreview] = useState<{
    node: Node;
    x: number;
    y: number;
    toLeft: boolean;
  } | null>(null);
  // A purely visual guide for placing clips.  It follows the pointer and
  // deliberately stays separate from the actual (teal) playback head.
  const [timelineGuideX, setTimelineGuideX] = useState<number | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [textDialog, setTextDialog] = useState(false);
  const [newText, setNewText] = useState("");
  const [newTextDuration, setNewTextDuration] = useState(3);
  const [newTextTrackId, setNewTextTrackId] = useState("text-main");
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState("");
  const [exportDialog, setExportDialog] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("mp4");
  const [exportFps, setExportFps] = useState(30);
  const [exportResolution, setExportResolution] = useState<ExportResolution>("720p");
  const [exportDirectory, setExportDirectory] = useState(() => {
    try { return localStorage.getItem("ym-director-export-directory") || ""; } catch { return ""; }
  });
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [draggingTrack, setDraggingTrack] = useState<Selection | null>(null);
  const [dragPreview, setDragPreview] = useState<TimelineDragPreview | null>(null);
  const [snapping, setSnapping] = useState(false);
  const [trackChooser, setTrackChooser] = useState(false);
  const [trackMenu, setTrackMenu] = useState<{ trackId: string; x: number; y: number } | null>(null);
  // Metadata arrives asynchronously.  Keep it keyed to a clip so the measured
  // shape of the previous image can never briefly turn the next one into the
  // wrong preview frame.
  const [previewAspect, setPreviewAspect] = useState<{ clipId: string; value: number } | null>(null);
  const [assetGroupFilter, setAssetGroupFilter] = useState("all");
  const [assetImportMenu, setAssetImportMenu] = useState(false);

  const history = useRef<Data[]>([]);
  // A damaged record must not be overwritten merely by mounting Director Mode.
  // The signature changes after an intentional edit, or the user can force a
  // write with the visible retry button.
  const storedTimelineSignature = useRef<string | null>(initialStorage.timeline.readFailed ? JSON.stringify(initialStorage.timeline.value) : null);
  const storedAssetSignature = useRef<string | null>(initialStorage.assets.readFailed ? JSON.stringify(initialStorage.assets.value) : null);
  const assetPersistenceBlocked = useRef(initialStorage.assets.readFailed);
  const lastTimelineStorageRetry = useRef(0);
  const lastAssetStorageRetry = useRef(0);
  const previewRef = useRef<HTMLVideoElement>(null);
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const assetWasDragged = useRef(false);
  const assetDragRef = useRef<string | null>(null);
  // A shelf click inserts an asset; double click opens the full viewer.  Delay
  // the former briefly so a double click never accidentally inserts a clip.
  const assetClickTimer = useRef<number | null>(null);
  const rulerPointer = useRef<number | null>(null);
  const pan = useRef<{ pointerId: number; x: number; left: number; moved: boolean } | null>(null);
  const timelineGesture = useRef<{
    pointerId: number;
    selection: Selection;
    selections: Selection[];
    startX: number;
    start: number;
    grabOffset: number;
    trackId: string;
    moved: boolean;
  } | null>(null);
  const dragPreviewRef = useRef<TimelineDragPreview | null>(null);
  const previewTextGesture = useRef<{
    pointerId: number;
    clipId: string;
    kind: "move" | "resize";
    x: number;
    y: number;
    fontSize: number;
    before: Data;
    startX: number;
    startY: number;
    changed: boolean;
  } | null>(null);
  const currentDirectorProjectRef = useRef(projectId);

  // Rehydrate director-local state before paint when App changes projects.
  // The normal persistence effects below are gated by `dataProjectId`, which
  // prevents a render carrying the old state from overwriting the new project
  // during this transition.
  useLayoutEffect(() => {
    if (dataProjectId === projectId) return;
    const timeline = read(projectId);
    const assets = readAssets(projectId);
    currentDirectorProjectRef.current = projectId;
    storedTimelineSignature.current = timeline.readFailed ? JSON.stringify(timeline.value) : null;
    storedAssetSignature.current = assets.readFailed ? JSON.stringify(assets.value) : null;
    assetPersistenceBlocked.current = assets.readFailed;
    lastTimelineStorageRetry.current = 0;
    lastAssetStorageRetry.current = 0;
    history.current = [];
    setDataProjectId(projectId);
    setData(timeline.value);
    setDirectorAssets(assets.value);
    setTimelineSaveError(null);
    setAssetSaveError(null);
    setStorageRecoveryNotice(
      [timeline.warning, assets.warning].filter((notice): notice is string => Boolean(notice)).join(" ") || null,
    );
    setStorageRetry(0);
    setTime(0);
    setPlaying(false);
    setScrubbing(false);
    setSelected(null);
    setSelectedKeys([]);
    setMenu(null);
    setTrackMenu(null);
    setDragPreview(null);
    dragPreviewRef.current = null;
    timelineGesture.current = null;
    setAssetPreview(null);
    setAssetHoverPreview(null);
    setAssetGroupFilter("all");
  }, [dataProjectId, projectId]);

  const validNodes = useMemo(
    () => (Array.isArray(nodes) ? nodes.filter((node): node is Node => Boolean(node) && typeof node.id === "string" && Boolean(node.id)) : []),
    [nodes],
  );
  const nodeById = useMemo(() => {
    const result = new Map(validNodes.map((node) => [node.id, { ...node, src: sourceForNode(node) }]));
    directorAssets.forEach((asset) => {
      const src = sourceForNode(asset);
      if (asset.source !== "external" || !src || result.has(asset.id)) return;
      result.set(asset.id, {
        id: asset.id,
        kind: asset.kind,
        name: asset.name,
        src,
        mediaWidth: asset.mediaWidth,
        mediaHeight: asset.mediaHeight,
      });
    });
    return result;
  }, [validNodes, directorAssets]);
  const allTracks = useMemo(() => [...BASE_TRACKS, ...data.tracks], [data.tracks]);
  const trackById = useMemo(() => new Map(allTracks.map((track) => [track.id, track])), [allTracks]);
  const enabledTrack = (trackId: string) => data.trackEnabled[trackId] !== false;
  const tracksFor = (kind: TrackKind) => {
    const base = BASE_TRACKS.find((track) => track.kind === kind)!;
    const extra = data.tracks.filter((track) => track.kind === kind);
    return [base, ...extra];
  };
  const clips = data.timeline;
  const visibleTimeline = useMemo(() => {
    const result: Array<{ clip: Clip; node: Node; start: number; end: number }> = [];
    clips.forEach((clip) => {
      const node = nodeById.get(clip.assetId);
      const track = trackById.get(clip.trackId);
      if (!node || !track || track.kind !== "video" || (node.kind !== "image" && node.kind !== "video")) return;
      result.push({ clip, node, start: clip.start, end: clip.start + clip.duration });
    });
    return result.sort((left, right) => left.start - right.start || left.clip.clipId.localeCompare(right.clip.clipId));
  }, [clips, nodeById, trackById]);
  const media = useMemo(
    () => directorAssets.flatMap((asset): Array<Node & { directorGroup: string }> => {
      const node = nodeById.get(asset.id);
      return node && (node.kind === "image" || node.kind === "video" || node.kind === "audio") && Boolean(node.src)
        ? [{ ...node, directorGroup: asset.groupId || "canvas" }]
        : [];
    }),
    [directorAssets, nodeById],
  );
  const assetGroups = useMemo(() => {
    const groups = new Map<string, { id: string; name: string; count: number }>();
    directorAssets.forEach((asset) => {
      const groupId = asset.groupId || "canvas";
      const current = groups.get(groupId) || { id: groupId, name: asset.groupName || "画布素材", count: 0 };
      current.count += 1;
      groups.set(groupId, current);
    });
    return [...groups.values()];
  }, [directorAssets]);
  const shownMedia = assetGroupFilter === "all" ? media : media.filter((node) => node.directorGroup === assetGroupFilter);
  const sessionOnlyAssets = directorAssets.filter((asset) =>
    asset.source === "external" && (asset.sessionOnly || isSessionOnlyDirectorSource(asset.src)),
  );
  const unavailableSessionAssets = sessionOnlyAssets.filter((asset) => !asset.src);
  const sessionOnlyAssetIds = new Set(sessionOnlyAssets.map((asset) => asset.id));
  const unavailableAssetNames = unavailableSessionAssets.slice(0, 3).map((asset) => asset.name).join("、");
  const visualEnd = visibleTimeline.filter((item) => enabledTrack(item.clip.trackId)).reduce((last, item) => Math.max(last, item.end), 0);
  const audioEnd = data.audio.filter((clip) => enabledTrack(clip.trackId)).reduce((last, clip) => Math.max(last, clip.start + clip.duration), 0);
  const textEnd = data.textTrack.filter((clip) => enabledTrack(clip.trackId)).reduce((last, clip) => Math.max(last, clip.start + clip.duration), 0);
  // 成片的长度始终取三条轨道中最晚结束的内容：图片/视频、背景音频、文字。
  // 这样任意一条轨道延长后，时间线和播放终点都会同步延长；没有内容时才保留 5 秒空轨道。
  const sequenceEnd = Math.max(visualEnd, audioEnd, textEnd);
  // The first visible video row is the upper visual layer. Its layer index
  // must therefore be larger than the rows displayed below it.
  const videoTracks = tracksFor("video");
  const videoLayer = new Map(videoTracks.map((track, index) => [track.id, videoTracks.length - index - 1]));
  /** One source of truth for the picture at a timeline time.  Preview and
   * export both call this, so a visual upper track masks lower tracks the same
   * way everywhere. */
  const visualAt = (at: number) => visibleTimeline
    .filter((item) => enabledTrack(item.clip.trackId) && at >= item.start && at < item.end)
    .sort((left, right) => (videoLayer.get(left.clip.trackId) || 0) - (videoLayer.get(right.clip.trackId) || 0))
    .at(-1);
  const active = visualAt(time);
  const textTracks = tracksFor("text");
  const textLayer = new Map(textTracks.map((track, index) => [track.id, textTracks.length - index - 1]));
  const textsAt = (at: number) => data.textTrack
    .filter((clip) => enabledTrack(clip.trackId) && at >= clip.start && at < clip.start + clip.duration)
    .sort((left, right) => (textLayer.get(left.trackId) || 0) - (textLayer.get(right.trackId) || 0));
  const activeTexts = textsAt(time);
  const activeText = activeTexts.find((clip) => selected?.track === "text" && selected.id === clip.clipId) || activeTexts.at(-1);
  const selectedText = selected?.track === "text" ? data.textTrack.find((clip) => clip.clipId === selected.id) || null : null;
  // Intrinsic media metadata wins over stored dimensions.  Older canvas nodes
  // may carry a stale 16:9 size even when the actual source is portrait.
  const activeAspect = active
    ? (previewAspect?.clipId === active.clip.clipId ? previewAspect.value : null) ?? (active.node.mediaWidth && active.node.mediaHeight
      ? active.node.mediaWidth / active.node.mediaHeight
      : null)
    : null;
  const previewFrame = getPreviewFrame(activeAspect);
  const previewPortrait = previewFrame.portrait;
  // Keep portrait sources in a predictable 9:16 stage.  The source itself
  // still uses `contain`, so it is never cropped when its real ratio differs
  // slightly from 9:16.
  const previewStyle = previewFrame.aspectRatio
    ? {
      aspectRatio: previewFrame.aspectRatio,
    }
    : undefined;
  const dragPreviewDuration = dragPreview
    ? dragPreview.selection.track === "video"
      ? data.timeline.find((clip) => clip.clipId === dragPreview.selection.id)?.duration || DEFAULT_CLIP_DURATION
      : dragPreview.selection.track === "audio"
        ? data.audio.find((clip) => clip.clipId === dragPreview.selection.id)?.duration || DEFAULT_CLIP_DURATION
        : data.textTrack.find((clip) => clip.clipId === dragPreview.selection.id)?.duration || DEFAULT_CLIP_DURATION
    : 0;
  // Playback ends at `total`. The edit area itself follows an active drag and
  // keeps a generous tail after real material exists. An empty project is
  // intentionally limited to five seconds rather than looking like a 30s
  // blank sequence.
  const timelineBounds = getTimelineBounds(
    sequenceEnd,
    time,
    dragPreview ? dragPreview.start + dragPreviewDuration : 0,
  );
  const total = timelineBounds.total;
  const rulerEnd = timelineBounds.rulerEnd;
  const contentWidth = Math.max(720, Math.ceil(rulerEnd * PPS) + TIMELINE_LABEL_WIDTH + 80);

  const isSelected = (selection: Selection) => selectedKeys.includes(selectionKey(selection));
  const selectSegment = (selection: Selection, additive = false) => {
    const key = selectionKey(selection);
    if (!additive) {
      setSelected(selection);
      setSelectedKeys([key]);
      return;
    }
    if (selectedKeys.includes(key)) {
      const next = selectedKeys.filter((value) => value !== key);
      setSelected(selectionFromKey(next.at(-1) || ""));
      setSelectedKeys(next);
      return;
    }
    setSelected(selection);
    setSelectedKeys([...selectedKeys, key]);
  };

  const commit = (apply: (current: Data) => Data) => {
    setData((current) => {
      const next = apply(current);
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        history.current = [...history.current, clone(current)].slice(-5);
      }
      return next;
    });
  };

  const patchSelectedText = (patch: Partial<Pick<TextClip, "text" | "duration" | "x" | "y" | "fontSize">>) => {
    if (!selectedText) return;
    commit((current) => {
      const before = current.textTrack.find((clip) => clip.clipId === selectedText.clipId);
      if (!before) return current;
      const next = { ...before, ...patch };
      const resized = patch.duration === undefined
        ? current.textTrack.map((clip) => clip.clipId === selectedText.clipId ? next : clip)
        : resizeAndPushSuffix(current.textTrack, selectedText.clipId, next.duration);
      const textTrack = patch.duration === undefined
        ? resized
        : resized.map((clip) => clip.clipId === selectedText.clipId ? { ...clip, ...patch } : clip);
      return { ...current, textTrack };
    });
  };

  const reconcileVideoDuration = (clipId: string, sourceDuration: number) => {
    if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) return;
    setData((current) => {
      const target = current.timeline.find((clip) => clip.clipId === clipId);
      // A hand-trimmed/split clip owns its duration. Only replace the temporary
      // five-second default generated for a new, untouched source video.
      if (!target || target.inPoint > .001 || Math.abs(target.duration - DEFAULT_CLIP_DURATION) > .05) return current;
      const duration = Math.max(MIN_CLIP_DURATION, Math.round(sourceDuration * 100) / 100);
      if (Math.abs(target.duration - duration) <= .05) return current;
      return { ...current, timeline: resizeAndPushSuffix(current.timeline, clipId, duration) };
    });
  };

  const activeTrackIds = (current: Data) => new Set([
    ...current.timeline.map((clip) => clip.trackId),
    ...current.audio.map((clip) => clip.trackId),
    ...current.textTrack.map((clip) => clip.trackId),
  ]);

  const removeSpentEmptyTracks = (current: Data): Data => {
    const used = activeTrackIds(current);
    const tracks = current.tracks.filter((track) => !track.used || used.has(track.id));
    return tracks.length === current.tracks.length ? current : { ...current, tracks };
  };

  const addTrack = (kind: TrackKind) => {
    commit((current) => {
      // 每一种轨道包含基础轨道在内，最多保留五条，避免时间线无限挤压。
      if (current.tracks.filter((track) => track.kind === kind).length + 1 >= MAX_TRACKS_PER_KIND) return current;
      const nextNumber = current.tracks.filter((track) => track.kind === kind).length + 2;
      return {
        ...current,
        tracks: [...current.tracks, { id: `${kind}-${id()}`, kind, name: `${trackLabel(kind)} ${nextNumber}`, used: false }],
      };
    });
    setTrackChooser(false);
  };

  const toggleTrack = (trackId: string) => {
    commit((current) => ({
      ...current,
      trackEnabled: { ...current.trackEnabled, [trackId]: current.trackEnabled[trackId] === false },
    }));
  };

  const deleteTrack = (trackId: string) => {
    const track = data.tracks.find((item) => item.id === trackId);
    if (!track) return;
    commit((current) => ({
      ...current,
      timeline: current.timeline.filter((clip) => clip.trackId !== trackId),
      audio: current.audio.filter((clip) => clip.trackId !== trackId),
      textTrack: current.textTrack.filter((clip) => clip.trackId !== trackId),
      tracks: current.tracks.filter((item) => item.id !== trackId),
    }));
    setSelected(null);
    setSelectedKeys([]);
    setTrackMenu(null);
  };

  const deleteSelection = (selection = selected) => {
    if (!selection) return;
    const keys = new Set(
      (selectedKeys.length ? selectedKeys : [selectionKey(selection)])
        .map(selectionFromKey)
        .filter((item): item is Selection => Boolean(item))
        .map(selectionKey),
    );
    commit((current) => {
      return removeSpentEmptyTracks({
        ...current,
        timeline: current.timeline.filter((clip) => !keys.has(selectionKey({ track: "video", id: clip.clipId }))),
        audio: current.audio.filter((clip) => !keys.has(selectionKey({ track: "audio", id: clip.clipId }))),
        textTrack: current.textTrack.filter((clip) => !keys.has(selectionKey({ track: "text", id: clip.clipId }))),
      });
    });
    setSelected(null);
    setSelectedKeys([]);
    setMenu(null);
    setTrackMenu(null);
  };

  const undo = () => {
    const previous = history.current.pop();
    if (!previous) return;
    setData(previous);
    setSelected(null);
    setSelectedKeys([]);
    setMenu(null);
    setPlaying(false);
  };

  const togglePlayback = () => {
    if (time >= total - .001) {
      setTime(0);
      setPlaying(true);
      return;
    }
    setPlaying((current) => !current);
  };

  useEffect(() => {
    if (dataProjectId !== projectId) return;
    let signature: string;
    try {
      signature = JSON.stringify(data);
    } catch {
      setTimelineSaveError("时间线无法序列化，尚未保存。请删减异常内容后重试。");
      return;
    }
    if (signature === storedTimelineSignature.current && storageRetry === lastTimelineStorageRetry.current) return;
    lastTimelineStorageRetry.current = storageRetry;
    const result = writeJson(localStorage, storeKey(projectId), data);
    if (result.ok) {
      storedTimelineSignature.current = signature;
      setTimelineSaveError(null);
      return;
    }
    setTimelineSaveError(storageFailureMessage("时间线", result.stage));
  }, [dataProjectId, projectId, data, storageRetry]);

  useEffect(() => {
    if (dataProjectId !== projectId) return;
    const next = validNodes
      .filter((node): node is Node & { kind: "image" | "video" | "audio" } =>
      (node.kind === "image" || node.kind === "video" || node.kind === "audio") && Boolean(sourceForNode(node)),
      )
      .map(({ id, kind, name, mediaWidth, mediaHeight }): DirectorAsset => ({ id, kind, name, source: "canvas", src: undefined, groupId: "canvas", groupName: "画布素材", mediaWidth, mediaHeight }));
    setDirectorAssets((previous) => {
      const external = previous.filter((asset) => asset.source === "external");
      const merged = [...next, ...external];
      const unchanged = previous.length === merged.length && previous.every((asset, index) => {
        const current = merged[index];
        return asset.id === current.id && asset.kind === current.kind && asset.name === current.name
          && asset.source === current.source && asset.src === current.src && asset.groupId === current.groupId
          && asset.groupName === current.groupName && asset.mediaWidth === current.mediaWidth && asset.mediaHeight === current.mediaHeight;
      });
      return unchanged ? previous : merged;
    });
  }, [dataProjectId, projectId, validNodes]);

  useEffect(() => {
    if (dataProjectId !== projectId) return;
    const metadata = directorAssetsForStorage(directorAssets);
    let signature: string;
    try {
      signature = JSON.stringify(metadata);
    } catch {
      setAssetSaveError("素材描述无法序列化，尚未保存。请移除异常素材后重试。");
      return;
    }
    if (assetPersistenceBlocked.current && storageRetry === lastAssetStorageRetry.current) return;
    if (signature === storedAssetSignature.current && storageRetry === lastAssetStorageRetry.current) return;
    lastAssetStorageRetry.current = storageRetry;
    const result = writeJson(localStorage, assetStoreKey(projectId), metadata);
    if (result.ok) {
      storedAssetSignature.current = signature;
      assetPersistenceBlocked.current = false;
      setAssetSaveError(null);
      return;
    }
    setAssetSaveError(storageFailureMessage("素材描述", result.stage));
  }, [dataProjectId, projectId, directorAssets, storageRetry]);

  useEffect(() => {
    if (time > total) setTime(total);
  }, [time, total]);

  // Leaving Director Mode must release active media and animation work.  It
  // prevents an invisible director instance from continuing to consume video
  // decode/audio resources while the canvas is in use.
  useEffect(() => {
    if (open) return;
    setPlaying(false);
    setScrubbing(false);
    audioRefs.current.forEach((player) => player.pause());
    previewRef.current?.pause();
  }, [open]);

  useEffect(() => {
    // Reset while the next source loads.  `onLoadedMetadata` / `onLoad` then
    // supplies the real dimensions, which fixes old projects whose saved
    // mediaWidth/mediaHeight no longer match the actual portrait file.
    setPreviewAspect(null);
  }, [active?.clip.clipId]);

  useEffect(() => () => {
    if (assetClickTimer.current !== null) window.clearTimeout(assetClickTimer.current);
  }, []);

  useEffect(() => {
    if (!open || !playing || scrubbing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = Math.min(0.1, (now - last) / 1000);
      last = now;
      setTime((current) => {
        const next = current + delta;
        if (next >= total) {
          setPlaying(false);
          return total;
        }
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [open, playing, scrubbing, total]);

  // While playing, keep the playhead comfortably inside the scroll viewport.
  // Manual panning and clip dragging keep priority, so this does not fight the
  // user when they are editing.
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!playing || !viewport || pan.current || timelineGesture.current) return;
    const x = TIMELINE_LABEL_WIDTH + time * PPS;
    const leftEdge = viewport.scrollLeft + 72;
    const rightEdge = viewport.scrollLeft + viewport.clientWidth - 96;
    if (x >= leftEdge && x <= rightEdge) return;
    const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    viewport.scrollLeft = Math.max(0, Math.min(max, x - viewport.clientWidth * .48));
  }, [time, playing]);

  useEffect(() => {
    const video = previewRef.current;
    if (!video) return;
    if (!active || active.node.kind !== "video" || time >= sequenceEnd) {
      if (!video.paused) video.pause();
      return;
    }
    const localTime = Math.max(0, Math.min(active.clip.duration, time - active.start));
    const expected = active.clip.inPoint + localTime;
    const sync = () => {
      if (Math.abs(video.currentTime - expected) > 0.16) video.currentTime = expected;
      if (playing && video.paused) void video.play().catch(() => {});
      if (!playing && !video.paused) video.pause();
    };
    if (video.readyState >= 1) sync();
    else video.addEventListener("loadedmetadata", sync, { once: true });
  }, [active?.clip.clipId, active?.clip.inPoint, active?.clip.duration, active?.start, time, playing, sequenceEnd]);

  useEffect(() => {
    if (!open) {
      audioRefs.current.forEach((player) => player.pause());
      return;
    }
    data.audio.forEach((clip) => {
      const player = audioRefs.current.get(clip.clipId);
      if (!player) return;
      const localTime = time - clip.start;
      const inside = enabledTrack(clip.trackId) && time < sequenceEnd && localTime >= 0 && localTime < clip.duration;
      if (!inside) {
        if (!player.paused) player.pause();
        return;
      }
      const expected = Math.max(0, clip.inPoint + Math.min(clip.duration, localTime));
      if (Math.abs(player.currentTime - expected) > 0.18) player.currentTime = expected;
      if (playing && player.paused) void player.play().catch(() => {});
      if (!playing && !player.paused) player.pause();
    });
  }, [data.audio, time, playing, sequenceEnd, open]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (!open || target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type !== "range")) return;
      if (event.ctrlKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        togglePlayback();
        return;
      }
      if (!event.repeat && event.key.toLowerCase() === "e" && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        splitAtPlayhead();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && (selected || selectedKeys.length)) {
        event.preventDefault();
        deleteSelection();
        return;
      }
      if (!event.repeat && event.key.toLowerCase() === "q" && (selected || selectedKeys.length)) {
        event.preventDefault();
        deleteSelection();
      }
    };
    window.addEventListener("keydown", keyDown, true);
    return () => window.removeEventListener("keydown", keyDown, true);
  }, [open, selected, selectedKeys.length, time, total]);

  // The editor coordinate is intentionally not limited by `total`.  Applying
  // that playback limit while dragging was the reason the last clips could not
  // be moved farther right or placed after the current ending.
  const timelineSecondsAt = (clientX: number) => {
    // Use the moving content rectangle rather than a cached viewport origin.
    // It remains accurate after horizontal scrolling, zoom-like CSS changes,
    // or auto-scroll while the user is dragging the playhead.
    const content = contentRef.current;
    if (content) {
      const rect = content.getBoundingClientRect();
      return Math.max(0, (clientX - rect.left - TIMELINE_LABEL_WIDTH) / PPS);
    }
    const viewport = scrollRef.current;
    if (!viewport) return 0;
    const rect = viewport.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left + viewport.scrollLeft - TIMELINE_LABEL_WIDTH) / PPS);
  };

  const scrubSecondsAt = (clientX: number) => Math.min(total, timelineSecondsAt(clientX));

  const autoScrollTimeline = (clientX: number) => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const threshold = 52;
    const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    let next = viewport.scrollLeft;
    if (clientX > rect.right - threshold) {
      next += Math.max(7, (clientX - (rect.right - threshold)) * .35);
    } else if (clientX < rect.left + threshold) {
      next -= Math.max(7, ((rect.left + threshold) - clientX) * .35);
    }
    viewport.scrollLeft = Math.max(0, Math.min(max, next));
  };

  const clipIndexAt = (seconds: number) => {
    let cursor = 0;
    for (let index = 0; index < clips.length; index += 1) {
      const next = cursor + clips[index].duration;
      if (seconds < cursor + clips[index].duration / 2) return index;
      if (seconds < next) return index + 1;
      cursor = next;
    }
    return clips.length;
  };

  const canPlaceAsset = (assetId: string, track: TrackKind) => {
    const node = nodeById.get(assetId);
    if (!node) return false;
    return track === "video"
      ? node.kind === "image" || node.kind === "video"
      : track === "audio" && node.kind === "audio";
  };

  const markTrackUsed = (current: Data, trackId: string) => ({
    ...current,
    tracks: current.tracks.map((track) => track.id === trackId ? { ...track, used: true } : track),
  });

  const resolvedStart = (
    current: Data,
    kind: TrackKind,
    trackId: string,
    requestedStart: number,
    duration: number,
    ignoreId?: string,
  ) => {
    const clean = Math.max(0, Math.round(requestedStart * 100) / 100);
    if (!snapping) return clean;
    const source = kind === "video" ? current.timeline : kind === "audio" ? current.audio : current.textTrack;
    const edges = source
      .filter((clip) => clip.trackId === trackId && clip.clipId !== ignoreId)
      .flatMap((clip) => [clip.start, clip.start + clip.duration]);
    const closest = edges.reduce((best, edge) => Math.abs(edge - clean) < Math.abs(best - clean) ? edge : best, clean);
    return Math.abs(closest - clean) <= .28 ? Math.max(0, Math.round(closest * 100) / 100) : clean;
  };

  // Clips on one track are sequential.  When a clip is moved onto another one,
  // its first or second half chooses "before" or "after".  A real gap is used
  // when available; otherwise the following clips move forward to make room.
  const placeOnSequentialTrack = <T extends { clipId: string; start: number; duration: number },>(
    entries: T[],
    moving: T,
    requestedStart: number,
    options: { appendOnExactStart?: boolean } = {},
  ) => {
    const ordered = entries
      .filter((entry) => entry.clipId !== moving.clipId)
      .slice()
      .sort((left, right) => left.start - right.start || left.clipId.localeCompare(right.clipId));
    let requested = Math.max(0, Math.round(requestedStart * 100) / 100);
    if (!ordered.length) return [{ ...moving, start: requested }];

    const targetIndex = ordered.findIndex((entry) => requested >= entry.start && requested < entry.start + entry.duration);
    let index = ordered.findIndex((entry) => entry.start > requested);
    if (targetIndex >= 0) {
      const target = ordered[targetIndex];
      // Dragging a clip onto the first half inserts it before the target;
      // dragging onto the latter half puts it after.  Adding a *new* asset at
      // exactly the current playhead is the one deliberate exception: repeated
      // adds should line up after the existing item instead of continually
      // reversing their order.
      index = requested < target.start + target.duration / 2
        ? targetIndex
        : targetIndex + 1;
      if (options.appendOnExactStart && requested <= target.start + 0.001) index = targetIndex + 1;
    }
    if (index < 0) index = ordered.length;

    const previousEnd = index > 0 ? ordered[index - 1].start + ordered[index - 1].duration : 0;
    const next = ordered[index];
    const nextStart = next ? next.start : Number.POSITIVE_INFINITY;
    const fitsGap = nextStart - previousEnd >= moving.duration - 0.001;
    let start = fitsGap
      ? Math.max(previousEnd, Math.min(requested, nextStart - moving.duration))
      : previousEnd;

    if (fitsGap && snapping) {
      const candidates = [previousEnd, nextStart - moving.duration]
        .filter((candidate) => Number.isFinite(candidate) && candidate >= previousEnd - 0.001);
      const closest = candidates.reduce((best, candidate) => Math.abs(candidate - start) < Math.abs(best - start) ? candidate : best, start);
      if (Math.abs(closest - start) <= 0.28) start = closest;
    }

    start = Math.max(0, Math.round(start * 100) / 100);
    let cursor = start + moving.duration;
    const suffix = ordered.slice(index).map((entry) => {
      const nextStartForEntry = Math.max(entry.start, cursor);
      cursor = nextStartForEntry + entry.duration;
      return nextStartForEntry === entry.start ? entry : { ...entry, start: nextStartForEntry };
    });
    return [...ordered.slice(0, index), { ...moving, start }, ...suffix];
  };

  const moveBetweenSameKindTracks = <T extends { clipId: string; trackId: string; start: number; duration: number },>(
    entries: T[],
    moving: T,
    targetTrackId: string,
    requestedStart: number,
  ) => {
    const moved = { ...moving, trackId: targetTrackId };
    const targetEntries = entries.filter((entry) => entry.trackId === targetTrackId);
    const placed = placeOnSequentialTrack(targetEntries, moved, requestedStart);
    return [...entries.filter((entry) => entry.trackId !== targetTrackId && entry.clipId !== moving.clipId), ...placed];
  };

  /** Move Ctrl-selected clips as one timing block.  The block is inserted once
   * and only the suffix at the destination is pushed forward. */
  const moveGroupBetweenSameKindTracks = <T extends { clipId: string; trackId: string; start: number; duration: number },>(
    entries: T[],
    moving: T[],
    anchorId: string,
    targetTrackId: string,
    requestedAnchorStart: number,
  ) => {
    if (moving.length <= 1) {
      const single = moving[0];
      return single ? moveBetweenSameKindTracks(entries, single, targetTrackId, requestedAnchorStart) : entries;
    }
    const ordered = moving.slice().sort((left, right) => left.start - right.start || left.clipId.localeCompare(right.clipId));
    const anchor = ordered.find((entry) => entry.clipId === anchorId) || ordered[0];
    const firstStart = ordered[0].start;
    const groupDuration = Math.max(...ordered.map((entry) => entry.start + entry.duration)) - firstStart;
    const requestedStart = Math.max(0, requestedAnchorStart - (anchor.start - firstStart));
    const ids = new Set(ordered.map((entry) => entry.clipId));
    const markerId = "group-" + id();
    const marker = { ...anchor, clipId: markerId, trackId: targetTrackId, start: 0, duration: groupDuration };
    const targetEntries = entries.filter((entry) => entry.trackId === targetTrackId && !ids.has(entry.clipId));
    const layout = placeOnSequentialTrack(targetEntries, marker, requestedStart);
    const placedMarker = layout.find((entry) => entry.clipId === markerId) || marker;
    const placedGroup = ordered.map((entry) => ({ ...entry, trackId: targetTrackId, start: placedMarker.start + entry.start - firstStart }));
    const remaining = entries.filter((entry) => entry.trackId !== targetTrackId && !ids.has(entry.clipId));
    return [...remaining, ...layout.filter((entry) => entry.clipId !== markerId), ...placedGroup];
  };

  const insertAsset = (assetId: string, seconds?: number, intendedTrack?: "video" | "audio", requestedTrackId?: string) => {
    const node = nodeById.get(assetId);
    if (!node) return;
    if (intendedTrack && !canPlaceAsset(assetId, intendedTrack)) return;
    if (node.kind === "audio") {
      const duration = 10;
      const trackId = requestedTrackId || "audio-main";
      if (trackById.get(trackId)?.kind !== "audio") return;
      const made: AudioClip = {
        clipId: id(),
        assetId,
        trackId,
        start: 0,
        inPoint: 0,
        duration,
      };
      commit((current) => {
        const onTrack = current.audio.filter((clip) => clip.trackId === trackId);
        const placed = placeOnSequentialTrack(onTrack, made, seconds ?? time, { appendOnExactStart: true });
        return markTrackUsed({ ...current, audio: [...current.audio.filter((clip) => clip.trackId !== trackId), ...placed] }, trackId);
      });
      selectSegment({ track: "audio", id: made.clipId });
      return;
    }
    if (node.kind !== "image" && node.kind !== "video") return;
    const trackId = requestedTrackId || "video-main";
    if (trackById.get(trackId)?.kind !== "video") return;
    const made = makeClip(assetId, 0, trackId);
    commit((current) => {
      const onTrack = current.timeline.filter((clip) => clip.trackId === trackId);
      // Shelf click and drag/drop use the same playhead-relative insertion
      // policy. The previous visualEnd fallback made videos appear to ignore
      // the cursor while audio respected it.
      const placed = placeOnSequentialTrack(onTrack, made, seconds ?? time, { appendOnExactStart: true });
      return markTrackUsed({ ...current, timeline: [...current.timeline.filter((clip) => clip.trackId !== trackId), ...placed] }, trackId);
    });
    selectSegment({ track: "video", id: made.clipId });
  };

  const queueShelfInsert = (node: Node) => {
    if (assetClickTimer.current !== null) window.clearTimeout(assetClickTimer.current);
    const targetProjectId = currentDirectorProjectRef.current;
    assetClickTimer.current = window.setTimeout(() => {
      assetClickTimer.current = null;
      if (!assetWasDragged.current && currentDirectorProjectRef.current === targetProjectId) insertAsset(node.id, time);
    }, 180);
  };

  const openShelfPreview = (event: ReactMouseEvent, node: Node) => {
    event.preventDefault();
    event.stopPropagation();
    if (assetClickTimer.current !== null) {
      window.clearTimeout(assetClickTimer.current);
      assetClickTimer.current = null;
    }
    if (!assetWasDragged.current) setAssetPreview(node);
  };

  const reorderClip = (fromId: string, requestedIndex: number) => {
    commit((current) => {
      const from = current.timeline.findIndex((clip) => clip.clipId === fromId);
      if (from < 0) return current;
      const next = [...current.timeline];
      const [moved] = next.splice(from, 1);
      const destination = Math.max(0, Math.min(next.length, requestedIndex > from ? requestedIndex - 1 : requestedIndex));
      next.splice(destination, 0, moved);
      return { ...current, timeline: next };
    });
  };

  // 保留剪切数据处理，时间线边缘按钮已在界面中隐藏；这样旧项目的事件引用不会中断。
  const trim = (clipId: string, fromStart: boolean) => {
    const step = 0.25;
    commit((current) => ({
      ...current,
      timeline: current.timeline.map((clip) => {
        if (clip.clipId !== clipId || clip.duration <= MIN_CLIP_DURATION + step) return clip;
        return fromStart
          ? { ...clip, inPoint: clip.inPoint + step, duration: clip.duration - step }
          : { ...clip, duration: clip.duration - step };
      }),
    }));
  };

  const splitAtPlayhead = () => {
    const selectedVideo = selected?.track === "video"
      ? visibleTimeline.find((item) => item.clip.clipId === selected.id && time > item.start + 0.03 && time < item.end - 0.03)
      : undefined;
    // When a specific video clip is selected, never fall back to another
    // active clip. This makes E cut exactly the selected item or do nothing.
    const target = selected
      ? selected.track === "video" ? selectedVideo : undefined
      : active;
    if (target) {
      const leftDuration = Math.max(MIN_CLIP_DURATION, Math.round((time - target.start) * 100) / 100);
      const rightDuration = Math.max(MIN_CLIP_DURATION, Math.round((target.clip.duration - leftDuration) * 100) / 100);
      commit((current) => {
        const index = current.timeline.findIndex((clip) => clip.clipId === target.clip.clipId);
        if (index < 0) return current;
        const next = [...current.timeline];
        next.splice(
          index,
          1,
          { ...target.clip, duration: leftDuration },
          {
            ...target.clip,
            clipId: id(),
            start: target.start + leftDuration,
            inPoint: target.clip.inPoint + leftDuration,
            duration: rightDuration,
          },
        );
        return { ...current, timeline: next };
      });
      return;
    }
    const selectedAudio = selected?.track === "audio"
      ? data.audio.find((clip) => clip.clipId === selected.id && time > clip.start + 0.03 && time < clip.start + clip.duration - 0.03)
      : undefined;
    const audio = selectedAudio || (selected?.track ? undefined : data.audio.find((clip) => time > clip.start + 0.03 && time < clip.start + clip.duration - 0.03));
    if (audio) {
      const leftDuration = Math.max(MIN_CLIP_DURATION, Math.round((time - audio.start) * 100) / 100);
      const rightDuration = Math.max(MIN_CLIP_DURATION, Math.round((audio.duration - leftDuration) * 100) / 100);
      commit((current) => ({
        ...current,
        audio: current.audio.flatMap((clip) => clip.clipId !== audio.clipId
          ? [clip]
          : [
              { ...clip, duration: leftDuration },
              {
                ...clip,
                clipId: id(),
                start: clip.start + leftDuration,
                inPoint: clip.inPoint + leftDuration,
                duration: rightDuration,
              },
            ]),
      }));
      return;
    }
    const selectedText = selected?.track === "text"
      ? data.textTrack.find((clip) => clip.clipId === selected.id && time > clip.start + 0.03 && time < clip.start + clip.duration - 0.03)
      : undefined;
    const text = selectedText || (selected?.track ? undefined : data.textTrack.find((clip) => time > clip.start + 0.03 && time < clip.start + clip.duration - 0.03));
    if (!text) return;
    const leftDuration = Math.max(MIN_CLIP_DURATION, Math.round((time - text.start) * 100) / 100);
    const rightDuration = Math.max(MIN_CLIP_DURATION, Math.round((text.duration - leftDuration) * 100) / 100);
    commit((current) => ({
      ...current,
      textTrack: current.textTrack.flatMap((clip) => clip.clipId !== text.clipId
        ? [clip]
        : [
            { ...clip, duration: leftDuration },
            { ...clip, clipId: id(), start: clip.start + leftDuration, duration: rightDuration },
          ]),
    }));
  };

  const openTextDialog = (trackId: unknown = "text-main") => {
    const preferredTrackId = typeof trackId === "string" ? trackId : "text-main";
    setNewText("");
    setNewTextDuration(3);
    setNewTextTrackId(trackById.get(preferredTrackId)?.kind === "text" ? preferredTrackId : "text-main");
    setTextDialog(true);
  };

  const addText = () => {
    if (!newText.trim()) return;
    const made: TextClip = {
      clipId: id(),
      trackId: newTextTrackId,
      text: newText.trim(),
      start: 0,
      duration: Math.max(MIN_CLIP_DURATION, newTextDuration),
      x: .5,
      y: .84,
      fontSize: 22,
    };
    commit((current) => {
      const onTrack = current.textTrack.filter((clip) => clip.trackId === newTextTrackId);
      const placed = placeOnSequentialTrack(onTrack, made, time, { appendOnExactStart: true });
      return markTrackUsed({ ...current, textTrack: [...current.textTrack.filter((clip) => clip.trackId !== newTextTrackId), ...placed] }, newTextTrackId);
    });
    selectSegment({ track: "text", id: made.clipId });
    setTextDialog(false);
  };

  type ImportableDirectorKind = DirectorAsset["kind"];
  const kindForDirectorFile = (file: File): ImportableDirectorKind | null =>
    file.type.startsWith("image/") ? "image"
      : file.type.startsWith("video/") ? "video"
        : file.type.startsWith("audio/") ? "audio"
          : null;

  /** Read dimensions without retaining the source bytes.  This works with a
   * WebView `asset:` URL returned from the managed store and with the browser
   * Data URL fallback alike. */
  const readMediaDimensions = (kind: ImportableDirectorKind, src: string) => new Promise<Pick<DirectorAsset, "mediaWidth" | "mediaHeight">>((resolve) => {
    if (!src || kind === "audio") { resolve({}); return; }
    if (kind === "image") {
      const image = new Image();
      image.onload = () => resolve({ mediaWidth: image.naturalWidth || undefined, mediaHeight: image.naturalHeight || undefined });
      image.onerror = () => resolve({});
      image.src = src;
      return;
    }
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => resolve({ mediaWidth: video.videoWidth || undefined, mediaHeight: video.videoHeight || undefined });
    video.onerror = () => resolve({});
    video.src = src;
  });

  /** Browser/Vite preview mode cannot write into Tauri's managed store.  Keep
   * the former FileReader behaviour strictly as a live-session fallback; the
   * persistence layer strips the Data URL before any localStorage write. */
  const readSessionDirectorFile = (file: File, groupId: string, groupName: string) => new Promise<DirectorAsset | null>((resolve) => {
    const kind = kindForDirectorFile(file);
    if (!kind) { resolve(null); return; }
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const src = String(reader.result || "");
      if (!src) { resolve(null); return; }
      void readMediaDimensions(kind, src).then((dimensions) => resolve({
        id: id(), kind, name: file.name, source: "external", src, sessionOnly: true, groupId, groupName, ...dimensions,
      }));
    };
    reader.readAsDataURL(file);
  });

  /** Desktop imports are streamed directly into the app-managed project
   * directory.  Only a small descriptor (asset id + local path + metadata)
   * enters Director state, so large files never end up in localStorage. */
  const readManagedDirectorFile = async (file: File, targetProjectId: string, groupId: string, groupName: string): Promise<DirectorAsset | null> => {
    const kind = kindForDirectorFile(file);
    if (!kind) return null;
    const assetId = managedAssetId();
    const managed = await uploadWorkspaceAsset({
      projectId: targetProjectId,
      assetId,
      file,
      fileName: file.name,
      mimeType: file.type,
    });
    // A successful commit without a path cannot be rendered or recovered. Do
    // not turn it into a misleading persistent entry.
    if (!managed.localPath) {
      await cleanupUnattachedWorkspaceAsset(managed, [directorAssets]);
      throw new Error("桌面素材仓储没有返回本机文件路径；素材未加入粗剪预览");
    }
    const src = sourceForNode({ localPath: managed.localPath });
    if (!src) {
      await cleanupUnattachedWorkspaceAsset(managed, [directorAssets]);
      throw new Error("桌面素材仓储返回的文件路径无效；素材未加入粗剪预览");
    }
    const dimensions = await readMediaDimensions(kind, src);
    return {
      id: managed.assetId,
      assetId: managed.assetId,
      kind,
      name: managed.fileName || file.name,
      source: "external",
      localPath: managed.localPath,
      groupId,
      groupName,
      ...dimensions,
    };
  };

  const importFiles = async (files: FileList | File[], folder = false) => {
    const targetProjectId = currentDirectorProjectRef.current;
    const valid = Array.from(files).filter((file) => Boolean(kindForDirectorFile(file)));
    if (!valid.length) return;
    const firstPath = valid[0].webkitRelativePath || "";
    const folderName = folder && firstPath.includes("/") ? firstPath.split("/")[0] : "导入素材 " + new Date().toLocaleTimeString();
    const groupId = "import-" + id();
    const created: DirectorAsset[] = [];
    const failures: string[] = [];
    let browserSessionFallback = false;

    const cleanupCreatedBatch = async () => {
      const cleanupCandidates = created
        .filter((asset): asset is DirectorAsset & { assetId: string } => Boolean(asset.assetId))
        .map((asset): ManagedWorkspaceAsset => ({
          projectId: targetProjectId,
          assetId: asset.assetId,
          localPath: asset.localPath,
          fileName: asset.name,
          mimeType: "application/octet-stream",
          size: 0,
        }));
      await Promise.all(cleanupCandidates.map((asset) =>
        cleanupUnattachedWorkspaceAsset(asset, [directorAssets])));
    };

    for (const file of valid) {
      // Do not continue an old project's batch after a project switch.  The
      // managed file may already have been safely committed to the old project,
      // but its result must never be inserted into the new project's shelf.
      if (currentDirectorProjectRef.current !== targetProjectId) {
        await cleanupCreatedBatch();
        return;
      }
      if (browserSessionFallback) {
        const sessionAsset = await readSessionDirectorFile(file, groupId, folderName);
        if (sessionAsset) created.push(sessionAsset);
        else failures.push(file.name);
        continue;
      }

      try {
        const managed = await readManagedDirectorFile(file, targetProjectId, groupId, folderName);
        if (managed && currentDirectorProjectRef.current !== targetProjectId) {
          created.push(managed);
          await cleanupCreatedBatch();
          return;
        }
        if (managed) created.push(managed);
        else failures.push(file.name);
      } catch (error) {
        if (error instanceof DesktopMediaStoreUnavailableError) {
          browserSessionFallback = true;
          const sessionAsset = await readSessionDirectorFile(file, groupId, folderName);
          if (sessionAsset) created.push(sessionAsset);
          else failures.push(file.name);
          continue;
        }
        // A desktop write failure is deliberately not converted to a Data URL:
        // doing that would look saved even though the durable copy failed. The
        // original File remains untouched and the user can retry explicitly.
        failures.push(`${file.name}（${error instanceof Error ? error.message : "桌面素材仓储失败"}）`);
      }
    }

    if (currentDirectorProjectRef.current !== targetProjectId) {
      await cleanupCreatedBatch();
      return;
    }
    if (!created.length) {
      setStorageRecoveryNotice(
        browserSessionFallback
          ? "浏览器预览模式无法保存独立素材；文件未加入粗剪预览，请在桌面版重新导入。"
          : `素材未加入粗剪预览：${failures.slice(0, 2).join("；") || "文件无法读取"}。原始文件未被删除，可修复后重试。`,
      );
      return;
    }
    assetPersistenceBlocked.current = false;
    setDirectorAssets((previous) => [...previous, ...created]);
    setAssetGroupFilter(groupId);
    if (browserSessionFallback) {
      setStorageRecoveryNotice(
        `${created.length} 个素材已在浏览器预览模式导入，仅本次会话可用；关闭或刷新后请在桌面版重新导入。${
          failures.length ? ` ${failures.length} 个素材无法读取。` : ""
        }`,
      );
    } else if (failures.length) {
      setStorageRecoveryNotice(`${failures.length} 个素材未保存到桌面仓储，未加入粗剪预览；原始文件未被删除，可修复后重试。`);
    } else {
      setStorageRecoveryNotice(null);
    }
  };

  const chooseExportDirectory = async () => {
    try {
      const { open: chooseDirectory } = await import("@tauri-apps/plugin-dialog");
      const chosen = await chooseDirectory({
        title: "选择粗剪预览导出存放位置",
        directory: true,
        multiple: false,
        defaultPath: exportDirectory || undefined,
      });
      if (typeof chosen !== "string" || !chosen) return;
      setExportDirectory(chosen);
      try {
        localStorage.setItem("ym-director-export-directory", chosen);
      } catch {
        setExportStatus("已选择导出位置，但无法记住该位置；下次导出需要重新选择");
      }
    } catch {
      setExportStatus("无法打开存放位置选择窗口");
    }
  };

  const startRulerScrub = (event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    rulerPointer.current = event.pointerId;
    setPlaying(false);
    setScrubbing(true);
    setTime(scrubSecondsAt(event.clientX));
    setTimelineGuideX(TIMELINE_LABEL_WIDTH + scrubSecondsAt(event.clientX) * PPS);
  };
  const moveRulerScrub = (event: ReactPointerEvent<HTMLElement>) => {
    if (rulerPointer.current !== event.pointerId) return;
    setTime(scrubSecondsAt(event.clientX));
    setTimelineGuideX(TIMELINE_LABEL_WIDTH + scrubSecondsAt(event.clientX) * PPS);
    autoScrollTimeline(event.clientX);
  };
  const endRulerScrub = (event: ReactPointerEvent<HTMLElement>) => {
    if (rulerPointer.current !== event.pointerId) return;
    setTime(scrubSecondsAt(event.clientX));
    rulerPointer.current = null;
    setScrubbing(false);
    setTimelineGuideX(null);
  };

  const updateTimelineGuide = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, .timeline-clip, .timeline-text-clip, .director-audio-clip")) {
      setTimelineGuideX(null);
      return;
    }
    const seconds = scrubSecondsAt(event.clientX);
    setTimelineGuideX(TIMELINE_LABEL_WIDTH + seconds * PPS);
  };

  const startTimelinePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (
      event.button !== 0 ||
      target.closest(".timeline-clip, .timeline-text-clip, .director-audio-clip, .playhead-handle, .timeline-ruler, button")
    ) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pan.current = { pointerId: event.pointerId, x: event.clientX, left: event.currentTarget.scrollLeft, moved: false };
  };
  const moveTimelinePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = pan.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const offset = event.clientX - drag.x;
    if (Math.abs(offset) > 3) drag.moved = true;
    if (drag.moved) {
      const max = Math.max(0, event.currentTarget.scrollWidth - event.currentTarget.clientWidth);
      event.currentTarget.scrollLeft = Math.max(0, Math.min(max, drag.left - offset));
    }
  };
  const endTimelinePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = pan.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved) setTime(scrubSecondsAt(event.clientX));
    pan.current = null;
  };

  const dropOnTrack = (track: "video" | "audio", trackId: string, event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const asset = event.dataTransfer.getData("application/x-ym-asset") || assetDragRef.current || assetDragId;
    assetDragRef.current = null;
    setAssetDragId(null);
    if (asset && canPlaceAsset(asset, track)) insertAsset(asset, timelineSecondsAt(event.clientX), track, trackId);
    else if (event.dataTransfer.files.length) importFiles(event.dataTransfer.files);
  };

  const allowTrackDrop = (track: "video" | "audio", event: ReactDragEvent<HTMLDivElement>) => {
    const asset = event.dataTransfer.getData("application/x-ym-asset") || assetDragRef.current || assetDragId;
    if (!asset || !canPlaceAsset(asset, track)) {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const sameKindTrackAt = (event: ReactPointerEvent<HTMLElement>, kind: TrackKind) => {
    const source = document.elementFromPoint(event.clientX, event.clientY);
    const target = source instanceof Element ? source.closest<HTMLElement>("[data-timeline-track]") : null;
    return target?.dataset.trackKind === kind ? target.dataset.timelineTrack || null : null;
  };

  const beginTrackDrag = (event: ReactPointerEvent<HTMLElement>, selection: Selection) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    let start = 0;
    if (selection.track === "video") start = data.timeline.find((clip) => clip.clipId === selection.id)?.start || 0;
    if (selection.track === "audio") start = data.audio.find((clip) => clip.clipId === selection.id)?.start || 0;
    if (selection.track === "text") start = data.textTrack.find((clip) => clip.clipId === selection.id)?.start || 0;
    const key = selectionKey(selection);
    const selections = (selectedKeys.includes(key) ? selectedKeys : [key])
      .map(selectionFromKey)
      .filter((item): item is Selection => item !== null && item.track === selection.track);
    timelineGesture.current = {
      pointerId: event.pointerId,
      selection,
      selections: selections.length ? selections : [selection],
      startX: event.clientX,
      start,
      // Preserve the point within the clip that was grabbed. It makes a clip
      // follow the cursor naturally even after the viewport auto-scrolls.
      grabOffset: Math.max(0, timelineSecondsAt(event.clientX) - start),
      trackId: selection.track === "video"
        ? data.timeline.find((clip) => clip.clipId === selection.id)?.trackId || "video-main"
        : selection.track === "audio"
          ? data.audio.find((clip) => clip.clipId === selection.id)?.trackId || "audio-main"
          : data.textTrack.find((clip) => clip.clipId === selection.id)?.trackId || "text-main",
      moved: false,
    };
    if (!selectedKeys.includes(key) || (!event.ctrlKey && !event.metaKey)) selectSegment(selection, event.ctrlKey || event.metaKey);
    setMenu(null);
  };

  const moveTrackDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = timelineGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    autoScrollTimeline(event.clientX);
    const distance = event.clientX - gesture.startX;
    if (Math.abs(distance) > 3) gesture.moved = true;
    if (!gesture.moved) return;
    setDraggingTrack(gesture.selection);
    const targetTrackId = sameKindTrackAt(event, gesture.selection.track) || gesture.trackId;
    const preview: TimelineDragPreview = {
      selection: gesture.selection,
      selections: gesture.selections,
      trackId: targetTrackId,
      start: Math.max(0, timelineSecondsAt(event.clientX) - gesture.grabOffset),
    };
    dragPreviewRef.current = preview;
    setDragPreview(preview);
  };

  const finishTrackDrag = (pointerId?: number) => {
    const gesture = timelineGesture.current;
    if (!gesture || (pointerId !== undefined && gesture.pointerId !== pointerId)) return;
    const preview = dragPreviewRef.current;
    if (gesture.moved && preview) {
      // Commit exactly once. `placeOnSequentialTrack` then gets a stable
      // snapshot and can insert/shift its suffix without the jitter caused by
      // repeatedly re-packing the same track on every pointer move.
      commit((current) => {
        if (preview.selection.track === "video") {
          const moving = current.timeline.filter((clip) => preview.selections.some((item) => item.track === "video" && item.id === clip.clipId));
          if (!moving.length) return current;
          const anchor = moving.find((clip) => clip.clipId === preview.selection.id) || moving[0];
          const requested = resolvedStart(current, "video", preview.trackId, preview.start, anchor.duration, anchor.clipId);
          return markTrackUsed({ ...current, timeline: moveGroupBetweenSameKindTracks(current.timeline, moving, anchor.clipId, preview.trackId, requested) }, preview.trackId);
        }
        if (preview.selection.track === "audio") {
          const moving = current.audio.filter((clip) => preview.selections.some((item) => item.track === "audio" && item.id === clip.clipId));
          if (!moving.length) return current;
          const anchor = moving.find((clip) => clip.clipId === preview.selection.id) || moving[0];
          const requested = resolvedStart(current, "audio", preview.trackId, preview.start, anchor.duration, anchor.clipId);
          return markTrackUsed({ ...current, audio: moveGroupBetweenSameKindTracks(current.audio, moving, anchor.clipId, preview.trackId, requested) }, preview.trackId);
        }
        const moving = current.textTrack.filter((clip) => preview.selections.some((item) => item.track === "text" && item.id === clip.clipId));
        if (!moving.length) return current;
        const anchor = moving.find((clip) => clip.clipId === preview.selection.id) || moving[0];
        const requested = resolvedStart(current, "text", preview.trackId, preview.start, anchor.duration, anchor.clipId);
        return markTrackUsed({ ...current, textTrack: moveGroupBetweenSameKindTracks(current.textTrack, moving, anchor.clipId, preview.trackId, requested) }, preview.trackId);
      });
    }
    timelineGesture.current = null;
    dragPreviewRef.current = null;
    setDragPreview(null);
    setDraggingTrack(null);
  };

  const endTrackDrag = (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    finishTrackDrag(event.pointerId);
  };

  const beginPreviewTextGesture = (event: ReactPointerEvent<HTMLElement>, kind: "move" | "resize", targetText = activeText) => {
    if (!targetText || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    selectSegment({ track: "text", id: targetText.clipId }, event.ctrlKey || event.metaKey);
    event.currentTarget.setPointerCapture(event.pointerId);
    previewTextGesture.current = {
      pointerId: event.pointerId,
      clipId: targetText.clipId,
      kind,
      x: targetText.x,
      y: targetText.y,
      fontSize: targetText.fontSize,
      before: clone(data),
      startX: event.clientX,
      startY: event.clientY,
      changed: false,
    };
  };

  const movePreviewTextGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = previewTextGesture.current;
    const box = previewBoxRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !box) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (Math.abs(dx) + Math.abs(dy) > 2) gesture.changed = true;
    if (gesture.kind === "move") {
      const x = Math.max(.03, Math.min(.97, gesture.x + dx / box.clientWidth));
      const y = Math.max(.04, Math.min(.96, gesture.y + dy / box.clientHeight));
      setData((current) => ({
        ...current,
        textTrack: current.textTrack.map((clip) => clip.clipId === gesture.clipId ? { ...clip, x, y } : clip),
      }));
    } else {
      const fontSize = Math.max(12, Math.min(96, gesture.fontSize + (dx - dy) * .12));
      setData((current) => ({
        ...current,
        textTrack: current.textTrack.map((clip) => clip.clipId === gesture.clipId ? { ...clip, fontSize } : clip),
      }));
    }
  };

  const endPreviewTextGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = previewTextGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.changed) history.current = [...history.current, gesture.before].slice(-5);
    previewTextGesture.current = null;
  };

  const exportTimeline = async (settings: { format: ExportFormat; fps: number; resolution: ExportResolution; directory: string }) => {
    if (exporting) return;
    const exportableTimeline = visibleTimeline.filter((item) => enabledTrack(item.clip.trackId));
    if (!exportableTimeline.length) {
      setExportStatus("请先放入图片或视频素材");
      return;
    }
    if (!("MediaRecorder" in window)) {
      setExportStatus("当前系统不支持 WebM 导出");
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("ffmpeg_available");
    } catch {
      setExportStatus("未找到 FFmpeg；为避免生成损坏文件，未开始导出。");
      return;
    }
    let outputPath = "";
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const extension = settings.format;
      const filename = "亿幕粗剪预览-" + new Date().toISOString().slice(0, 10) + "." + extension;
      let defaultPath = filename;
      if (settings.directory) {
        const { join } = await import("@tauri-apps/api/path");
        defaultPath = await join(settings.directory, filename);
      }
      const selectedPath = await save({
        defaultPath,
        filters: [{ name: settings.format === "mp4" ? "MP4 视频" : "QuickTime MOV 视频", extensions: [extension] }],
      });
      if (!selectedPath) {
        setExportStatus("已取消导出");
        return;
      }
      outputPath = selectedPath;
    } catch (error) {
      setExportStatus("无法选择导出位置：" + String(error).replace(/^Error: /, ""));
      return;
    }
    setExporting(true);
    setExportStatus("正在准备导出…");
    const firstMedia = exportableTimeline[0]?.node;
    const aspect = firstMedia?.mediaWidth && firstMedia?.mediaHeight
      ? firstMedia.mediaWidth / firstMedia.mediaHeight
      : 16 / 9;
    const longEdge = settings.resolution === "1080p" ? 1920 : 1280;
    const portrait = aspect < 1;
    const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
    const width = portrait ? even(longEdge * aspect) : longEdge;
    const height = portrait ? longEdge : even(longEdge / aspect);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      setExporting(false);
      setExportStatus("无法创建导出画面");
      return;
    }

    const imageCache = new Map<string, HTMLImageElement>();
    const imageFor = async (src: string) => {
      const cached = imageCache.get(src);
      if (cached) return cached;
      const image = new Image();
      image.src = src;
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(Error("图片无法读取"));
      });
      imageCache.set(src, image);
      return image;
    };
    const waitFor = (element: HTMLMediaElement, eventName: "loadedmetadata" | "seeked") => new Promise<void>((resolve, reject) => {
      const done = () => {
        element.removeEventListener(eventName, done);
        element.removeEventListener("error", failed);
        resolve();
      };
      const failed = () => {
        element.removeEventListener(eventName, done);
        element.removeEventListener("error", failed);
        reject(Error("媒体无法读取"));
      };
      element.addEventListener(eventName, done, { once: true });
      element.addEventListener("error", failed, { once: true });
    });
    const seek = async (element: HTMLMediaElement, seconds: number) => {
      if (Math.abs(element.currentTime - seconds) < .08) return;
      const ready = waitFor(element, "seeked");
      element.currentTime = seconds;
      await ready;
    };
    const drawContained = (source: HTMLImageElement | HTMLVideoElement) => {
      const sourceWidth = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
      const sourceHeight = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
      context.fillStyle = "#050a0b";
      context.fillRect(0, 0, width, height);
      if (!sourceWidth || !sourceHeight) return;
      const scale = Math.min(width / sourceWidth, height / sourceHeight);
      const drawWidth = sourceWidth * scale;
      const drawHeight = sourceHeight * scale;
      context.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    };
    const drawText = (clip: TextClip) => {
      const fontSize = Math.max(24, clip.fontSize * 2.05);
      context.save();
      context.font = "700 " + fontSize + "px system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = "#ffffff";
      context.shadowColor = "#000000";
      context.shadowBlur = 8;
      const maxWidth = width * .82;
      const lines: string[] = [];
      let line = "";
      for (const character of clip.text) {
        const candidate = line + character;
        if (context.measureText(candidate).width > maxWidth && line) {
          lines.push(line);
          line = character;
        } else {
          line = candidate;
        }
      }
      if (line) lines.push(line);
      const lineHeight = fontSize * 1.25;
      const first = height * clip.y - (lines.length - 1) * lineHeight / 2;
      lines.forEach((value, index) => context.fillText(value, width * clip.x, first + index * lineHeight));
      context.restore();
    };

    let audioContext: AudioContext | null = null;
    const exportVideo = document.createElement("video");
    exportVideo.playsInline = true;
    exportVideo.preload = "auto";
    const exportAudio = new Map<string, HTMLAudioElement>();
    let destination: MediaStreamAudioDestinationNode | null = null;
    let videoSource: MediaElementAudioSourceNode | null = null;
    try {
      audioContext = new AudioContext();
      await audioContext.resume();
      destination = audioContext.createMediaStreamDestination();
      videoSource = audioContext.createMediaElementSource(exportVideo);
      if (!data.videoMuted) videoSource.connect(destination);
      data.audio.filter((clip) => enabledTrack(clip.trackId)).forEach((clip) => {
        const node = nodeById.get(clip.assetId);
        if (!node?.src) return;
        const player = new Audio(node.src);
        player.preload = "auto";
        const source = audioContext?.createMediaElementSource(player);
        source?.connect(destination as MediaStreamAudioDestinationNode);
        exportAudio.set(clip.clipId, player);
      });

      const videoStream = canvas.captureStream(settings.fps);
      const stream = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...(destination?.stream.getAudioTracks() || []),
      ]);
      const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
      const mimeType = candidates.find((value) => MediaRecorder.isTypeSupported(value));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };

      let activeSource = "";
      const syncExportAudio = async (currentTime: number) => {
        await Promise.all(data.audio.filter((clip) => enabledTrack(clip.trackId)).map(async (clip) => {
          const player = exportAudio.get(clip.clipId);
          if (!player) return;
          const local = currentTime - clip.start;
          if (local < 0 || local >= clip.duration) {
            if (!player.paused) player.pause();
            return;
          }
          const sourceTime = clip.inPoint + local;
          if (Math.abs(player.currentTime - sourceTime) > .22) {
            try { await seek(player, sourceTime); } catch { player.currentTime = sourceTime; }
          }
          if (player.paused) await player.play().catch(() => {});
        }));
      };

      const render = async (currentTime: number) => {
        const activeClip = visualAt(currentTime);
        if (!activeClip?.node.src) {
          exportVideo.pause();
          context.fillStyle = "#050a0b";
          context.fillRect(0, 0, width, height);
        } else if (activeClip.node.kind === "image") {
          drawContained(await imageFor(activeClip.node.src));
        } else {
          if (activeSource !== activeClip.node.src) {
            exportVideo.pause();
            exportVideo.src = activeClip.node.src;
            activeSource = activeClip.node.src;
            await waitFor(exportVideo, "loadedmetadata");
          }
          const mediaTime = activeClip.clip.inPoint + Math.max(0, currentTime - activeClip.start);
          await seek(exportVideo, mediaTime);
          if (exportVideo.paused) await exportVideo.play().catch(() => {});
          drawContained(exportVideo);
        }
        textsAt(currentTime).forEach(drawText);
      };

      const mediaBlob = await new Promise<Blob>((resolve, reject) => {
        const started = performance.now();
        let lastStatus = -1;
        recorder.onerror = () => reject(Error("录制器发生错误"));
        recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType || "video/webm" }));
        recorder.start(250);
        const frame = async () => {
          const currentTime = Math.min(total, (performance.now() - started) / 1000);
          try {
            await render(currentTime);
            await syncExportAudio(currentTime);
            const completed = Math.floor(currentTime);
            if (completed !== lastStatus) {
              lastStatus = completed;
              setExportStatus("正在导出 " + timeLabel(currentTime) + " / " + timeLabel(total));
            }
            if (currentTime >= total) {
              exportVideo.pause();
              exportAudio.forEach((player) => player.pause());
              recorder.stop();
            } else {
              requestAnimationFrame(() => { void frame(); });
            }
          } catch (error) {
            if (recorder.state !== "inactive") recorder.stop();
            reject(error instanceof Error ? error : Error("素材无法导出"));
          }
        };
        void frame();
      });

      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const path = outputPath;
        if (!path) throw Error("没有选择导出位置");
        {
          const tempPath = path + ".ym-export.webm";
          const source = new Uint8Array(await mediaBlob.arrayBuffer());
          // Keep every IPC message well below the WebView/Tauri message cap.
          // A 384 KiB binary block becomes about 512 KiB after Base64 encoding.
          const chunkSize = 384 * 1024;
          for (let offset = 0; offset < source.length; offset += chunkSize) {
            const bytes = source.subarray(offset, Math.min(source.length, offset + chunkSize));
            let binary = "";
            for (let index = 0; index < bytes.length; index += 0x8000) {
              binary += String.fromCharCode(...bytes.subarray(index, Math.min(bytes.length, index + 0x8000)));
            }
            await invoke("write_export_chunk", {
              path: tempPath,
              data: btoa(binary),
              append: offset > 0,
            });
            const percent = Math.min(100, Math.round((offset + bytes.length) / Math.max(1, source.length) * 100));
            setExportStatus("正在写入临时视频 " + percent + "%…");
          }
          setExportStatus("正在用 FFmpeg 合成 " + settings.format.toUpperCase() + "…");
          await invoke("transcode_webm", { inputPath: tempPath, outputPath: path, format: settings.format, fps: settings.fps });
          setExportStatus(settings.format.toUpperCase() + " 导出完成：" + path);
        }
      } catch (error) {
        setExportStatus(settings.format.toUpperCase() + " 保存失败：" + String(error).replace(/^Error: /, ""));
      }
    } catch (error) {
      setExportStatus("导出失败：" + String(error).replace(/^Error: /, ""));
    } finally {
      exportVideo.pause();
      exportVideo.removeAttribute("src");
      exportVideo.load();
      exportAudio.forEach((player) => { player.pause(); player.removeAttribute("src"); player.load(); });
      await audioContext?.close().catch(() => {});
      setExporting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="director-overlay" onPointerDown={onClose}>
      <section className="director-shell" onPointerDown={(event) => { event.stopPropagation(); setMenu(null); setTrackMenu(null); setTrackChooser(false); }}>
        <header className="director-head">
          <div>
            <span>剪辑工作区</span>
            <b>粗剪预览</b>
            <small>时间线剪辑 · 空格播放 · Ctrl+Z 撤销</small>
          </div>
          <div className="director-head-actions">
            {exportStatus && <small>{exportStatus}</small>}
            <button className="director-export" onClick={() => setExportDialog(true)} disabled={exporting}>
              {exporting ? "导出中…" : "导出"}
            </button>
            <button onClick={onClose}>退出粗剪预览</button>
          </div>
        </header>

        {(timelineSaveError || assetSaveError || storageRecoveryNotice || sessionOnlyAssets.length > 0) && (
          <section
            role="alert"
            aria-live="assertive"
            className="director-storage-notice"
            style={{ margin: "8px 14px 0", padding: "8px 10px", border: "1px solid #b7791f", borderRadius: 6, background: "#fff8e6", color: "#6b4100", fontSize: 12 }}
          >
            {timelineSaveError && <div><b>保存失败：</b>{timelineSaveError}</div>}
            {assetSaveError && <div><b>保存失败：</b>{assetSaveError}</div>}
            {storageRecoveryNotice && <div>{storageRecoveryNotice}</div>}
            {unavailableSessionAssets.length > 0 ? (
              <div>
                已恢复时间线，但 {unavailableSessionAssets.length} 个导入素材的文件内容未保存（{unavailableAssetNames}{unavailableSessionAssets.length > 3 ? " 等" : ""}）。请重新导入并重新放置相关片段。
                <button type="button" onClick={() => fileRef.current?.click()} style={{ marginLeft: 8 }}>重新导入素材</button>
              </div>
            ) : sessionOnlyAssets.length > 0 ? (
              <div>
                {sessionOnlyAssets.length} 个导入素材仅本次会话：文件内容不会写入本机存储，也不会标记为“已保存”；关闭或刷新后请重新导入。
              </div>
            ) : null}
            {(timelineSaveError || assetSaveError || storageRecoveryNotice) && (
              <button
                type="button"
                onClick={() => {
                  setStorageRecoveryNotice(null);
                  setStorageRetry((current) => current + 1);
                }}
                style={{ marginTop: 6 }}
              >
                重试保存
              </button>
            )}
          </section>
        )}

        <div className="director-main">
          <aside className="director-script">
            <b>脚本 / 剪辑笔记</b>
            <textarea
              value={data.script}
              onChange={(event) => commit((current) => ({ ...current, script: event.target.value }))}
              placeholder="输入剧本、台词、镜头说明或剪辑笔记…"
            />
            <section className="director-text-settings" aria-label="文字基础设置">
              <div>
                <b>基础设置</b>
                <small>{selectedText ? "正在编辑选中的文字" : "选中时间线的文字片段后可编辑"}</small>
              </div>
              {selectedText ? (
                <>
                  <label className="wide">
                    <span>文字</span>
                    <textarea
                      value={selectedText.text}
                      onChange={(event) => patchSelectedText({ text: event.target.value })}
                      placeholder="输入字幕或标题"
                    />
                  </label>
                  <div className="director-settings-grid">
                    <label><span>字号</span><input type="number" min="12" max="96" value={selectedText.fontSize} onChange={(event) => patchSelectedText({ fontSize: Math.max(12, Math.min(96, Number(event.target.value) || 12)) })} /></label>
                    <label><span>时长</span><input type="number" min=".25" max="120" step=".25" value={selectedText.duration} onChange={(event) => patchSelectedText({ duration: Math.max(MIN_CLIP_DURATION, Number(event.target.value) || MIN_CLIP_DURATION) })} /></label>
                    <label><span>水平位置</span><input type="range" min="0" max="100" value={Math.round(selectedText.x * 100)} onChange={(event) => patchSelectedText({ x: Number(event.target.value) / 100 })} /></label>
                    <label><span>垂直位置</span><input type="range" min="0" max="100" value={Math.round(selectedText.y * 100)} onChange={(event) => patchSelectedText({ y: Number(event.target.value) / 100 })} /></label>
                  </div>
                  <button type="button" className="director-text-reset" onClick={() => patchSelectedText({ x: .5, y: .84, fontSize: 22 })}>重置位置与字号</button>
                </>
              ) : (
                <p>可调整文字内容、字号、显示时长以及画面中的水平、垂直位置。</p>
              )}
            </section>
          </aside>

          <main className="director-stage">
            <div className={"director-preview " + (previewPortrait ? "is-portrait" : "")} style={previewStyle} ref={previewBoxRef}>
              {active?.node.kind === "video" ? (
                <video
                  key={active.clip.clipId}
                  ref={previewRef}
                  src={active.node.src}
                  playsInline
                  preload="auto"
                  muted={data.videoMuted}
                  onLoadedMetadata={(event) => {
                    const video = event.currentTarget;
                    if (video.videoWidth && video.videoHeight) {
                      setPreviewAspect({ clipId: active.clip.clipId, value: video.videoWidth / video.videoHeight });
                    }
                    reconcileVideoDuration(active.clip.clipId, video.duration);
                  }}
                />
              ) : active?.node.src ? (
                <img
                  key={active.clip.clipId}
                  src={active.node.src}
                  alt=""
                  onLoad={(event) => {
                    const image = event.currentTarget;
                    if (image.naturalWidth && image.naturalHeight) {
                      setPreviewAspect({ clipId: active.clip.clipId, value: image.naturalWidth / image.naturalHeight });
                    }
                  }}
                />
              ) : (
                <span className="director-empty-preview">从右侧素材库拖入图片或视频开始剪辑</span>
              )}
              {activeTexts.map((textClip) => {
                const textSelection: Selection = { track: "text", id: textClip.clipId };
                const textIsSelected = isSelected(textSelection);
                return (
                  <div
                    key={textClip.clipId}
                    className={"director-preview-text " + (textIsSelected ? "selected" : "")}
                    style={{
                      left: textClip.x * 100 + "%",
                      top: textClip.y * 100 + "%",
                      fontSize: textClip.fontSize,
                    }}
                    onPointerDown={(event) => beginPreviewTextGesture(event, "move", textClip)}
                    onPointerMove={movePreviewTextGesture}
                    onPointerUp={endPreviewTextGesture}
                    onPointerCancel={endPreviewTextGesture}
                  >
                    <span>{textClip.text}</span>
                    {textIsSelected && (
                      <button
                        className="preview-text-resize"
                        aria-label="调整文字大小"
                        onPointerDown={(event) => beginPreviewTextGesture(event, "resize", textClip)}
                        onPointerMove={movePreviewTextGesture}
                        onPointerUp={endPreviewTextGesture}
                        onPointerCancel={endPreviewTextGesture}
                      />
                    )}
                  </div>
                );
              })}
              <div className="director-preload" aria-hidden="true">
                {visibleTimeline.filter((item) => item.node.kind === "video").map((item) => (
                  <video key={item.clip.clipId} src={item.node.src} preload="auto" muted />
                ))}
              </div>
            </div>
            <div className="director-audio-players" aria-hidden="true">
              {data.audio.map((clip) => {
                const node = nodeById.get(clip.assetId);
                return node?.src ? (
                  <audio
                    key={clip.clipId}
                    ref={(element) => {
                      if (element) audioRefs.current.set(clip.clipId, element);
                      else audioRefs.current.delete(clip.clipId);
                    }}
                    src={node.src}
                    preload="metadata"
                    onLoadedMetadata={(event) => {
                      const duration = event.currentTarget.duration;
                      if (!Number.isFinite(duration) || duration <= 0) return;
                      setData((current) => {
                        const target = current.audio.find((item) => item.clipId === clip.clipId);
                        if (!target) return current;
                        const remaining = Math.max(MIN_CLIP_DURATION, duration - target.inPoint);
                        // A fresh insert starts with a ten-second placeholder.
                        // Split/trimmed clips own their length and must never
                        // jump back to the full source duration on metadata.
                        const untouched = target.inPoint < .001 && Math.abs(target.duration - 10) <= .05;
                        const nextDuration = untouched ? remaining : Math.min(target.duration, remaining);
                        if (Math.abs(target.duration - nextDuration) <= .05) return current;
                        // Preserve gaps and only push later clips on this track;
                        // repacking the whole track made manually moved audio
                        // appear to teleport whenever metadata was loaded.
                        const affected = resizeAndPushSuffix(current.audio, clip.clipId, nextDuration);
                        return {
                          ...current,
                          audio: affected,
                        };
                      });
                    }}
                  />
                ) : null;
              })}
            </div>

            <div className="editor-timeline">
              <div className="timeline-toolbar">
                <button className={snapping ? "timeline-snap active" : "timeline-snap"} onClick={() => setSnapping((current) => !current)} title="靠近片段边缘时自动吸附">
                  {snapping ? "吸附：开" : "吸附：关"}
                </button>
                <div className="timeline-track-add">
                  <button onClick={() => setTrackChooser((current) => !current)}>+ 轨道</button>
                  {trackChooser && (
                    <div className="timeline-track-chooser" onPointerDown={(event) => event.stopPropagation()}>
                      <button disabled={tracksFor("video").length >= MAX_TRACKS_PER_KIND} onClick={() => addTrack("video")}>视频轨道</button>
                      <button disabled={tracksFor("audio").length >= MAX_TRACKS_PER_KIND} onClick={() => addTrack("audio")}>音频轨道</button>
                      <button disabled={tracksFor("text").length >= MAX_TRACKS_PER_KIND} onClick={() => addTrack("text")}>文本轨道</button>
                    </div>
                  )}
                </div>
                <button
                  onClick={togglePlayback}
                  title={playing ? "暂停" : "播放"}
                >
                  {playing ? "暂停" : "播放"}
                </button>
                <button onClick={splitAtPlayhead} disabled={!visibleTimeline.length && !data.audio.length && !data.textTrack.length}>剪切</button>
                <button onClick={openTextDialog}>文本</button>
                <button onClick={() => setShortcutsOpen(true)}>快捷键</button>
                <small>{timeLabel(time)} / {timeLabel(total)} · 空格播放 · E 剪切 · Ctrl+Z 撤销（5 步）</small>
              </div>

              <div
                className="timeline-scroll"
                ref={scrollRef}
                onPointerDown={startTimelinePan}
                onPointerMove={(event) => { moveTimelinePan(event); updateTimelineGuide(event); }}
                onPointerUp={endTimelinePan}
                onPointerCancel={endTimelinePan}
                onLostPointerCapture={endTimelinePan}
                onPointerLeave={() => setTimelineGuideX(null)}
                onWheel={(event) => {
                  event.preventDefault();
                  if (event.ctrlKey) {
                    event.currentTarget.scrollLeft += event.deltaY || event.deltaX;
                  } else {
                    event.currentTarget.scrollTop += event.deltaY || event.deltaX;
                  }
                }}
              >
                <div className="timeline-content" ref={contentRef} style={{ width: contentWidth }}>
                  <div
                    className="timeline-ruler"
                    onPointerDown={startRulerScrub}
                    onPointerMove={moveRulerScrub}
                    onPointerUp={endRulerScrub}
                    onPointerCancel={endRulerScrub}
                    onLostPointerCapture={endRulerScrub}
                  >
                    {Array.from({ length: rulerEnd + 1 }).map((_, index) => (
                      <i key={index} style={{ left: index * PPS }}>{index}s</i>
                    ))}
                  </div>
                  <i className="editor-playhead" style={{ left: TIMELINE_LABEL_WIDTH + time * PPS }} />
                  {timelineGuideX !== null && <i className="timeline-hover-guide" style={{ left: timelineGuideX }} aria-hidden="true" />}
                  <button
                    className="playhead-handle"
                    style={{ left: TIMELINE_LABEL_WIDTH + time * PPS }}
                    aria-label="拖动播放头"
                    onPointerDown={startRulerScrub}
                    onPointerMove={moveRulerScrub}
                    onPointerUp={endRulerScrub}
                    onPointerCancel={endRulerScrub}
                    onLostPointerCapture={endRulerScrub}
                  />

                  <div className="timeline-rows">
                    {(["video", "audio", "text"] as TrackKind[]).flatMap((kind) => tracksFor(kind).map((track) => {
                      const custom = data.tracks.some((item) => item.id === track.id);
                      const activeTrack = enabledTrack(track.id);
                      const videoClips = kind === "video" ? visibleTimeline.filter((item) => item.clip.trackId === track.id) : [];
                      const audioClips = kind === "audio" ? data.audio.filter((clip) => clip.trackId === track.id) : [];
                      const textClips = kind === "text" ? data.textTrack.filter((clip) => clip.trackId === track.id) : [];
                      const hasContent = videoClips.length + audioClips.length + textClips.length > 0;
                      return (
                        <div className="timeline-row" key={track.id}>
                          <div className="track-label">
                            <span>{track.name}</span>
                            <button className={activeTrack ? "track-enabled" : "track-enabled off"} title={activeTrack ? "关闭轨道" : "打开轨道"} onClick={() => toggleTrack(track.id)}>{activeTrack ? "开" : "关"}</button>
                            {track.kind === "video" && track.id === "video-main" && (
                              <button className={data.videoMuted ? "video-audio-toggle muted" : "video-audio-toggle"} onClick={() => commit((current) => ({ ...current, videoMuted: !current.videoMuted }))} title={data.videoMuted ? "开启视频原声" : "关闭视频原声"}>{data.videoMuted ? "静" : "声"}</button>
                            )}
                          </div>
                          <div
                            className={`track ${track.kind}-track ${activeTrack ? "" : "track-closed"}`}
                            data-timeline-track={track.id}
                            data-track-kind={track.kind}
                            onDoubleClick={track.kind === "text" ? () => openTextDialog(track.id) : undefined}
                            onDragOver={track.kind === "text" ? undefined : (event) => allowTrackDrop(track.kind as "video" | "audio", event)}
                            onDrop={track.kind === "text" ? undefined : (event) => dropOnTrack(track.kind as "video" | "audio", track.id, event)}
                            onContextMenu={(event) => {
                              if (!custom || hasContent) return;
                              event.preventDefault(); event.stopPropagation();
                              setTrackMenu({ trackId: track.id, x: event.clientX, y: event.clientY });
                            }}
                          >
                            {kind === "video" && videoClips.map(({ node, clip }) => {
                              const clipSelection: Selection = { track: "video", id: clip.clipId };
                              return <div key={clip.clipId} className={`timeline-clip ${isSelected(clipSelection) ? "selected " : ""}${draggingTrack?.track === "video" && draggingTrack.id === clip.clipId ? "dragging" : ""}`} style={{ left: clip.start * PPS, width: Math.max(MIN_CLIP_DURATION * PPS, clip.duration * PPS) }} onPointerDown={(event) => beginTrackDrag(event, clipSelection)} onPointerMove={moveTrackDrag} onPointerUp={endTrackDrag} onPointerCancel={endTrackDrag} onLostPointerCapture={endTrackDrag} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); selectSegment(clipSelection, event.ctrlKey || event.metaKey || isSelected(clipSelection)); setMenu({ ...clipSelection, x: event.clientX, y: event.clientY }); }}>
                                {node.kind === "image" ? <img src={node.src} alt="" draggable={false} /> : <video src={node.src} muted preload="metadata" draggable={false} onLoadedMetadata={(event) => reconcileVideoDuration(clip.clipId, event.currentTarget.duration)} />}<span>{node.name} · {clip.duration.toFixed(1)}s</span>
                              </div>;
                            })}
                            {kind === "audio" && audioClips.map((clip) => {
                              const node = nodeById.get(clip.assetId); if (!node) return null;
                              const clipSelection: Selection = { track: "audio", id: clip.clipId };
                              return <div className={`director-audio-clip ${isSelected(clipSelection) ? "selected " : ""}${draggingTrack?.track === "audio" && draggingTrack.id === clip.clipId ? "dragging" : ""}`} key={clip.clipId} style={{ left: clip.start * PPS, width: Math.max(68, clip.duration * PPS) }} onPointerDown={(event) => beginTrackDrag(event, clipSelection)} onPointerMove={moveTrackDrag} onPointerUp={endTrackDrag} onPointerCancel={endTrackDrag} onLostPointerCapture={endTrackDrag} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); selectSegment(clipSelection, event.ctrlKey || event.metaKey || isSelected(clipSelection)); setMenu({ ...clipSelection, x: event.clientX, y: event.clientY }); }}><span>{node.name}</span></div>;
                            })}
                            {kind === "text" && textClips.map((clip) => {
                              const clipSelection: Selection = { track: "text", id: clip.clipId };
                              return <div className={`timeline-text-clip ${isSelected(clipSelection) ? "selected " : ""}${draggingTrack?.track === "text" && draggingTrack.id === clip.clipId ? "dragging" : ""}`} key={clip.clipId} style={{ left: clip.start * PPS, width: Math.max(MIN_CLIP_DURATION * PPS, clip.duration * PPS) }} onPointerDown={(event) => beginTrackDrag(event, clipSelection)} onPointerMove={moveTrackDrag} onPointerUp={endTrackDrag} onPointerCancel={endTrackDrag} onLostPointerCapture={endTrackDrag} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); selectSegment(clipSelection, event.ctrlKey || event.metaKey || isSelected(clipSelection)); setMenu({ ...clipSelection, x: event.clientX, y: event.clientY }); }}><span>{clip.text}</span></div>;
                            })}
                            {!hasContent && <small className="timeline-placeholder">{kind === "video" ? "拖入图片或视频" : kind === "audio" ? "拖入音频" : "文本轨道"}</small>}
                          </div>
                        </div>
                      );
                    }))}
                  </div>
                  {/*
                  <div className="track-label video-label">
                    <span>视频</span>
                    <button
                      className={data.videoMuted ? "video-audio-toggle muted" : "video-audio-toggle"}
                      onClick={() => commit((current) => ({ ...current, videoMuted: !current.videoMuted }))}
                      title={data.videoMuted ? "开启视频原声" : "关闭视频原声"}
                    >
                      {data.videoMuted ? "静" : "声"}
                    </button>
                  </div>
                  <div
                    className="track video-track"
                    onDragOver={(event) => allowTrackDrop("video", event)}
                    onDrop={(event) => dropOnTrack("video", event)}
                  >
                    {visibleTimeline.map(({ node, clip }) => (
                      <div
                        key={clip.clipId}
                        className={
                          "timeline-clip " +
                          (isSelected({ track: "video", id: clip.clipId }) ? "selected " : "") +
                          (draggingTrack?.track === "video" && draggingTrack.id === clip.clipId ? "dragging" : "")
                        }
                        style={{ width: Math.max(MIN_CLIP_DURATION * PPS, clip.duration * PPS) }}
                        onPointerDown={(event) => beginTrackDrag(event, { track: "video", id: clip.clipId })}
                        onPointerMove={moveTrackDrag}
                        onPointerUp={endTrackDrag}
                        onPointerCancel={endTrackDrag}
                        onLostPointerCapture={endTrackDrag}
                        onDragOver={(event) => allowTrackDrop("video", event)}
                        onDrop={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const asset = event.dataTransfer.getData("application/x-ym-asset") || assetDragRef.current;
                          assetDragRef.current = null;
                          setAssetDragId(null);
                          if (asset && canPlaceAsset(asset, "video")) insertAsset(asset, visibleTimeline.find((item) => item.clip.clipId === clip.clipId)?.start || 0, "video");
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          selectSegment({ track: "video", id: clip.clipId }, event.ctrlKey || event.metaKey || isSelected({ track: "video", id: clip.clipId }));
                          setMenu({ track: "video", id: clip.clipId, x: event.clientX, y: event.clientY });
                        }}
                      >
                        <button className="clip-edge left" onPointerDown={(event) => event.stopPropagation()} onClick={() => trim(clip.clipId, true)} aria-label="裁掉开头">‹</button>
                        {node.kind === "image" ? <img src={node.src} alt="" draggable={false} /> : <video src={node.src} muted draggable={false} />}
                        <span>{node.name} · {clip.duration.toFixed(1)}s</span>
                        <button className="clip-edge right" onPointerDown={(event) => event.stopPropagation()} onClick={() => trim(clip.clipId, false)} aria-label="裁掉结尾">›</button>
                      </div>
                    ))}
                    {!visibleTimeline.length && <small className="timeline-placeholder">拖入素材开始编排</small>}
                  </div>

                  <div className="track-label audio-label">音频</div>
                  <div
                    className="track audio-track"
                    onDragOver={(event) => allowTrackDrop("audio", event)}
                    onDrop={(event) => dropOnTrack("audio", event)}
                  >
                    {data.audio.map((clip) => {
                      const node = nodeById.get(clip.assetId);
                      if (!node) return null;
                      const selection: Selection = { track: "audio", id: clip.clipId };
                      return (
                        <div
                          className={
                            "director-audio-clip " +
                            (isSelected(selection) ? "selected " : "") +
                            (draggingTrack?.track === "audio" && draggingTrack.id === selection.id ? "dragging" : "")
                          }
                          key={clip.clipId}
                          style={{ left: clip.start * PPS, width: Math.max(68, clip.duration * PPS) }}
                          onPointerDown={(event) => beginTrackDrag(event, selection)}
                          onPointerMove={moveTrackDrag}
                          onPointerUp={endTrackDrag}
                          onPointerCancel={endTrackDrag}
                          onLostPointerCapture={endTrackDrag}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            selectSegment(selection, event.ctrlKey || event.metaKey || isSelected(selection));
                            setMenu({ ...selection, x: event.clientX, y: event.clientY });
                          }}
                        >
                          <span>{node.name}</span>
                        </div>
                      );
                    })}
                    {!data.audio.length && <small className="timeline-placeholder">拖入音频</small>}
                  </div>

                  <div className="track-label text-label">文本</div>
                  <div className="track text-track">
                    {data.textTrack.map((clip) => {
                      const selection: Selection = { track: "text", id: clip.clipId };
                      return (
                        <div
                          className={
                            "timeline-text-clip " +
                            (isSelected(selection) ? "selected " : "") +
                            (draggingTrack?.track === "text" && draggingTrack.id === clip.clipId ? "dragging" : "")
                          }
                          key={clip.clipId}
                          style={{ left: clip.start * PPS, width: Math.max(MIN_CLIP_DURATION * PPS, clip.duration * PPS) }}
                          onPointerDown={(event) => beginTrackDrag(event, selection)}
                          onPointerMove={moveTrackDrag}
                          onPointerUp={endTrackDrag}
                          onPointerCancel={endTrackDrag}
                          onLostPointerCapture={endTrackDrag}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            selectSegment(selection, event.ctrlKey || event.metaKey || isSelected(selection));
                            setMenu({ ...selection, x: event.clientX, y: event.clientY });
                          }}
                        >
                          <span>{clip.text}</span>
                        </div>
                      );
                    })}
                    {!data.textTrack.length && <small className="timeline-placeholder">点击“文本”添加分段字幕或标题</small>}
                  </div>
                  */}
                </div>
              </div>
            </div>
          </main>

          <aside className="director-assets">
            <div className="director-assets-head">
              <b>独立素材库</b>
              <div className="director-assets-import">
                <button onClick={() => setAssetImportMenu((current) => !current)}>导入</button>
                {assetImportMenu && <div className="director-assets-import-menu">
                  <button onClick={() => { setAssetImportMenu(false); fileRef.current?.click(); }}>导入文件</button>
                  <button onClick={() => {
                    setAssetImportMenu(false);
                    folderRef.current?.setAttribute("webkitdirectory", "");
                    folderRef.current?.setAttribute("directory", "");
                    folderRef.current?.click();
                  }}>导入文件夹</button>
                </div>}
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,video/*,audio/*"
              multiple
              onChange={(event) => {
                if (event.target.files) void importFiles(event.target.files);
                event.currentTarget.value = "";
              }}
            />
            <input
              ref={folderRef}
              type="file"
              accept="image/*,video/*,audio/*"
              multiple
              onChange={(event) => {
                if (event.target.files) void importFiles(event.target.files, true);
                event.currentTarget.value = "";
              }}
            />
            <div className="director-asset-groups">
              <button className={assetGroupFilter === "all" ? "active" : ""} onClick={() => setAssetGroupFilter("all")}>全部</button>
              {assetGroups.map((group) => <button key={group.id} className={assetGroupFilter === group.id ? "active" : ""} onClick={() => setAssetGroupFilter(group.id)}>{group.name} · {group.count}</button>)}
            </div>
            <div className="director-assets-list">
              {shownMedia.map((node) => (
                <div
                  key={node.id}
                  draggable
                  role="button"
                  tabIndex={0}
                  className={"director-asset " + node.kind}
                  onDragStart={(event) => {
                    assetWasDragged.current = true;
                    assetDragRef.current = node.id;
                    event.dataTransfer.effectAllowed = "copy";
                    event.dataTransfer.setData("application/x-ym-asset", node.id);
                    setAssetDragId(node.id);
                  }}
                  onDragEnd={() => {
                    assetDragRef.current = null;
                    setAssetDragId(null);
                    window.setTimeout(() => { assetWasDragged.current = false; }, 0);
                  }}
                  onClick={() => {
                    if (assetWasDragged.current) return;
                    queueShelfInsert(node);
                    setAssetDragId(null);
                  }}
                  onDoubleClick={(event) => openShelfPreview(event, node)}
                  onPointerEnter={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const toLeft = rect.right + 270 > window.innerWidth;
                    setAssetHoverPreview({
                      node,
                      x: toLeft ? rect.left - 10 : rect.right + 10,
                      y: Math.min(rect.top, window.innerHeight - 220),
                      toLeft,
                    });
                  }}
                  onPointerLeave={() => setAssetHoverPreview(null)}
                >
                  {node.kind === "image" ? (
                    <img src={node.src} alt={node.name} draggable={false} />
                  ) : node.kind === "video" ? (
                    <video src={node.src} muted playsInline preload="metadata" draggable={false} />
                  ) : (
                    <i className="director-asset-icon" aria-hidden="true">♫</i>
                  )}
                  <span>{node.name}{sessionOnlyAssetIds.has(node.id) ? " · 仅本次会话" : ""}</span>
                  <span hidden className="director-asset-hover-actions" onPointerDown={(event) => event.stopPropagation()}>
                    <button onClick={(event) => { event.stopPropagation(); setAssetPreview(node); }}>{node.kind === "video" ? "查看 / 播放" : node.kind === "audio" ? "试听" : "查看"}</button>
                  </span>
                </div>
              ))}
              {!shownMedia.length && <div className="director-assets-empty"><b>暂无素材</b><small>从画布添加或点击导入</small></div>}
            </div>
            <small className="director-assets-tip">仅提供参考内容<br />不属于任何剪辑软件。</small>
          </aside>
        </div>

        {trackMenu && (
          <div className="director-clip-menu director-track-menu" style={{ left: trackMenu.x, top: trackMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
            <small>自定义轨道</small>
            <button onClick={() => deleteTrack(trackMenu.trackId)}>删除轨道</button>
          </div>
        )}
        {menu && (
          <div className="director-clip-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
            <button onClick={() => deleteSelection(menu)}>删除片段</button>
          </div>
        )}
        {assetPreview && (
          <div className="director-asset-preview-backdrop" onPointerDown={() => setAssetPreview(null)}>
            <div className="director-asset-preview" onPointerDown={(event) => event.stopPropagation()}>
              <button className="director-asset-preview-close" onClick={() => setAssetPreview(null)}>×</button>
              <b>{assetPreview.name}</b>
              {assetPreview.kind === "video" ? <video src={assetPreview.src} controls autoPlay playsInline /> : assetPreview.kind === "audio" ? <audio src={assetPreview.src} controls autoPlay /> : <img src={assetPreview.src} alt={assetPreview.name} />}
            </div>
          </div>
        )}
        {assetHoverPreview && (
          <div
            className={"director-asset-hover-preview " + (assetHoverPreview.toLeft ? "to-left" : "")}
            style={{ left: assetHoverPreview.x, top: assetHoverPreview.y }}
            aria-hidden="true"
          >
            {assetHoverPreview.node.kind === "video" ? (
              <video src={assetHoverPreview.node.src} autoPlay muted loop playsInline />
            ) : assetHoverPreview.node.kind === "audio" ? (
              <div className="director-hover-audio">
                <i>♪</i>
                <span>{assetHoverPreview.node.name}</span>
                <audio
                  src={assetHoverPreview.node.src}
                  autoPlay
                  onCanPlay={(event) => { void event.currentTarget.play().catch(() => undefined); }}
                />
              </div>
            ) : (
              <img src={assetHoverPreview.node.src} alt="" />
            )}
          </div>
        )}
        {shortcutsOpen && (
          <div className="director-shortcuts-backdrop" onPointerDown={() => setShortcutsOpen(false)}>
            <section className="director-shortcuts-dialog" onPointerDown={(event) => event.stopPropagation()}>
              <div>
                <span>粗剪预览</span>
                <b>快捷键</b>
                <small>当前可用的时间线编辑操作</small>
              </div>
              <dl>
                <div><dt>空格</dt><dd>播放 / 暂停</dd></div>
                <div><dt>E</dt><dd>在播放头位置剪切片段</dd></div>
                <div><dt>Q / Delete</dt><dd>删除选中片段</dd></div>
                <div><dt>Ctrl + 点击</dt><dd>多选片段</dd></div>
                <div><dt>Ctrl + Z</dt><dd>撤销上一步（最多 5 步）</dd></div>
                <div><dt>拖动播放头</dt><dd>定位时间；拖动轨道空白区域可横向移动</dd></div>
              </dl>
              <footer><button type="button" onClick={() => setShortcutsOpen(false)}>知道了</button></footer>
            </section>
          </div>
        )}
        {exportDialog && (
          <div className="director-export-dialog-backdrop" onPointerDown={() => setExportDialog(false)}>
            <form
              className="director-export-dialog"
              onPointerDown={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault();
                setExportDialog(false);
                void exportTimeline({ format: exportFormat, fps: exportFps, resolution: exportResolution, directory: exportDirectory });
              }}
            >
              <div>
                <span>粗剪预览导出</span>
                <b>导出参数</b>
                <small>码率使用默认高质量设置；MP4 与 MOV 将由 FFmpeg 转码。</small>
              </div>
              <label>
                <span>文件格式</span>
                <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)}>
                  <option value="mp4">MP4（推荐）</option>
                  <option value="mov">MOV（QuickTime）</option>
                </select>
              </label>
              <label>
                <span>帧率</span>
                <select value={exportFps} onChange={(event) => setExportFps(Number(event.target.value))}>
                  <option value={24}>24 FPS</option>
                  <option value={30}>30 FPS（推荐）</option>
                  <option value={60}>60 FPS</option>
                </select>
              </label>
              <label>
                <span>分辨率</span>
                <select value={exportResolution} onChange={(event) => setExportResolution(event.target.value as ExportResolution)}>
                  <option value="720p">720P</option>
                  <option value="1080p">1080P</option>
                </select>
              </label>
              <label className="director-export-directory">
                <span>存放位置</span>
                <div>
                  <input value={exportDirectory || "未设置（导出时可再次选择）"} readOnly title={exportDirectory || "尚未设置导出位置"} />
                  <button type="button" onClick={() => void chooseExportDirectory()}>选择</button>
                </div>
              </label>
              <p>自动按第一个画面判断横屏或竖屏比例，并保留时间线中的字幕与音频。</p>
              <footer>
                <button type="button" onClick={() => setExportDialog(false)}>取消</button>
                <button className="primary" type="submit">开始导出</button>
              </footer>
            </form>
          </div>
        )}
        {textDialog && (
          <div className="director-text-dialog-backdrop" onPointerDown={() => setTextDialog(false)}>
            <form
              className="director-text-dialog"
              onPointerDown={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault();
                addText();
              }}
            >
              <div>
                <span>文本轨道</span>
                <b>添加文字片段</b>
                <small>默认从当前播放头开始，可在画面中拖动与缩放。</small>
              </div>
              <textarea
                autoFocus
                value={newText}
                onChange={(event) => setNewText(event.target.value)}
                placeholder="输入字幕、标题或画面提示词…"
              />
              <label>
                <span>时长（秒）</span>
                <input
                  type="number"
                  min=".25"
                  max="120"
                  step=".25"
                  value={newTextDuration}
                  onChange={(event) => setNewTextDuration(Number(event.target.value) || 3)}
                />
              </label>
              <footer>
                <button type="button" onClick={() => setTextDialog(false)}>取消</button>
                <button type="submit" className="primary" disabled={!newText.trim()}>添加到时间线</button>
              </footer>
            </form>
          </div>
        )}
      </section>
    </div>
  );
}
