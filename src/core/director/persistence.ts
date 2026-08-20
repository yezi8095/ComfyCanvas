/** Small, testable boundary around browser storage used by Director Mode.
 *
 * Director assets may contain FileReader Data URLs.  They are intentionally
 * never written to localStorage: the browser quota is too small for media and
 * a failed write would otherwise make the UI claim a file was saved when it
 * was not.  The caller keeps those sources in memory for the current session
 * and persists only the metadata needed to explain/recover the timeline.
 */
export interface JsonStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type StorageReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; value: T; error: unknown };

export type StorageWriteResult =
  | { ok: true }
  | { ok: false; stage: "serialize" | "write"; error: unknown };

export type DirectorAssetStorageShape = {
  source?: "canvas" | "external";
  /** Stable descriptor fields for a desktop-managed import.  They are small
   * enough for metadata storage and deliberately never contain file bytes. */
  assetId?: string;
  localPath?: string;
  src?: string;
  sessionOnly?: boolean;
};

/** Data and blob URLs only exist in the active WebView session. */
export const isSessionOnlyDirectorSource = (source: unknown) =>
  typeof source === "string" && /^(?:data:|blob:)/i.test(source);

/**
 * Keep the small asset descriptor in localStorage but leave FileReader media
 * in memory.  A durable URL/path is retained unchanged.
 */
export const directorAssetsForStorage = <T extends DirectorAssetStorageShape>(assets: T[]): T[] =>
  assets.map((asset) => {
    if (!isSessionOnlyDirectorSource(asset.src)) return asset;
    const { src: _source, ...metadata } = asset;
    return { ...metadata, sessionOnly: true } as T;
  });

export const readJson = <T>(storage: JsonStorage, key: string, fallback: T): StorageReadResult<T> => {
  try {
    const raw = storage.getItem(key);
    return { ok: true, value: raw ? JSON.parse(raw) as T : fallback };
  } catch (error) {
    return { ok: false, value: fallback, error };
  }
};

/** Never make storage failures implicit: consumers can render a recovery UI. */
export const writeJson = (storage: Pick<JsonStorage, "setItem">, key: string, value: unknown): StorageWriteResult => {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    return { ok: false, stage: "serialize", error };
  }

  try {
    storage.setItem(key, serialized);
    return { ok: true };
  } catch (error) {
    return { ok: false, stage: "write", error };
  }
};
