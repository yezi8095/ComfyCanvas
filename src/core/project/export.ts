/**
 * Project JSON is a portability artifact, not a credential vault.  A few
 * legacy nodes stored provider credentials inside `workflow`, so merely
 * exporting the canvas could leak an API key when it is shared or committed.
 *
 * This helper is intentionally framework-free and works on unknown nested
 * values.  It removes values by key name rather than trying to identify a
 * particular provider/node shape, so new adapters inherit the same safety
 * boundary by default.  Endpoint, provider and model fields remain intact.
 */
// `token` is intentionally included as well.  Custom Comfy/API workflow
// exports often use that short field name rather than an OpenAI-style
// `accessToken`; project files are portable artifacts and must not become a
// credentials backup by accident.
const credentialKey = /^(?:api[_-]?key|access[_-]?key|access[_-]?token|api[_-]?secret|secret[_-]?key|secret|token|authorization|password|bearer[_-]?token|refresh[_-]?token|client[_-]?secret)$/i;

export interface RedactedProjectExport<T> {
  value: T;
  /** Dot/bracket paths of keys that were removed, for transparent UI feedback. */
  redactedPaths: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Returns a deep, JSON-safe copy without credentials; the original is never changed. */
export const redactProjectSecrets = <T>(input: T): RedactedProjectExport<T> => {
  const redactedPaths: string[] = [];
  const visit = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((entry, index) => visit(entry, `${path}[${index}]`));
    if (!isRecord(value)) return value;
    const copy: Record<string, unknown> = {};
    Object.entries(value).forEach(([key, entry]) => {
      const entryPath = path ? `${path}.${key}` : key;
      if (credentialKey.test(key)) {
        redactedPaths.push(entryPath);
        return;
      }
      copy[key] = visit(entry, entryPath);
    });
    return copy;
  };
  return { value: visit(input, "") as T, redactedPaths };
};
