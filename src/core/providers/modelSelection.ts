/**
 * Selects only from model ids already verified for the requested capability.
 * A provider-wide default is merely a preference; it must never bypass the
 * capability filter (for example a text default entering a video node).
 */
export const chooseCompatibleModel = (
  compatibleModelIds: readonly string[],
  ...preferredModelIds: Array<string | undefined>
) => preferredModelIds.find((id): id is string => Boolean(id && compatibleModelIds.includes(id)))
  || compatibleModelIds[0]
  || "";
