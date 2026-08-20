/**
 * Small, framework-free layout decisions used by Director Mode.
 *
 * Keeping these rules outside the React component makes the two important
 * editing guarantees testable: an empty timeline has a short, honest end and
 * portrait sources get a 9:16 frame without being stretched into it.
 */

export const EMPTY_TIMELINE_DURATION_SECONDS = 5;
export const EDIT_TAIL_SECONDS = 30;

export type TimelineBounds = {
  /** The playable duration. Empty projects deliberately stop at five seconds. */
  total: number;
  /** The last second shown in the ruler (may include a tail after real media). */
  rulerEnd: number;
  /** Extra editor room is only useful after material has been placed. */
  tail: number;
};

export function getTimelineBounds(
  sequenceEnd: number,
  currentTime = 0,
  draggingEnd = 0,
): TimelineBounds {
  const hasMaterial = Number.isFinite(sequenceEnd) && sequenceEnd > 0;
  const total = hasMaterial ? sequenceEnd : EMPTY_TIMELINE_DURATION_SECONDS;
  const tail = hasMaterial ? EDIT_TAIL_SECONDS : 0;
  const editableEnd = hasMaterial
    ? Math.max(total, Math.max(0, currentTime), Math.max(0, draggingEnd))
    : total;

  return {
    total,
    tail,
    rulerEnd: Math.ceil(editableEnd + tail),
  };
}

export type PreviewFrame = {
  portrait: boolean;
  /** The stage frame, not the source ratio. The actual media is always contain. */
  aspectRatio?: "9 / 16";
  objectFit: "contain";
};

/**
 * Portrait source material lives in a predictable 9:16 composition frame.
 * The source is rendered with `contain`, so a 4:5 or 3:4 photo keeps every
 * pixel instead of being stretched or cropped to imitate 9:16.
 */
export function getPreviewFrame(sourceAspect: number | null | undefined): PreviewFrame {
  const portrait = typeof sourceAspect === "number" && Number.isFinite(sourceAspect) && sourceAspect > 0 && sourceAspect < 1;
  return portrait
    ? { portrait: true, aspectRatio: "9 / 16", objectFit: "contain" }
    : { portrait: false, objectFit: "contain" };
}
