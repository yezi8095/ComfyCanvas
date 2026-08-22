export const AUTOSAVE_MINUTES_STORE = "ym-offline-autosave-minutes-v1";
export const DEFAULT_AUTOSAVE_MINUTES = 10;
export const MIN_AUTOSAVE_MINUTES = 1;
export const MAX_AUTOSAVE_MINUTES = 1440;

export const normalizeAutosaveMinutes = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed)) return DEFAULT_AUTOSAVE_MINUTES;
  return Math.min(MAX_AUTOSAVE_MINUTES, Math.max(MIN_AUTOSAVE_MINUTES, Math.round(parsed)));
};

