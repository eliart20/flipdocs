export type MobileGestureIntent = "pending" | "flick" | "drag";

export interface MobileGestureSample {
  /** Grab distance from the spine, normalized to page width. */
  grabX: number;
  horizontalDistance: number;
  verticalDistance: number;
  elapsedMs: number;
}

/** Resolve a gesture that has stayed ambiguous until the hold threshold. */
export function mobileHeldGestureIntent(grabX: number): Exclude<MobileGestureIntent, "pending"> {
  return grabX < 0.5 ? "flick" : "drag";
}

/** Resolve gesture intent without coupling touch classification to Three.js. */
export function mobileGestureIntent(sample: MobileGestureSample): MobileGestureIntent {
  const horizontal = Math.abs(sample.horizontalDistance);
  const vertical = Math.abs(sample.verticalDistance);
  if (horizontal < 7 || horizontal < vertical * 0.8) return "pending";

  // Never directly deform a page from its inner half. A gesture begun there
  // receives the consistent loose-corner animation regardless of its speed.
  if (sample.grabX < 0.5) return "flick";

  // The loose half is direct manipulation from the first meaningful move.
  // Release velocity still makes a short, fast gesture settle as a flick, but
  // classification must not hold the paper back from the finger for 145 ms.
  return "drag";
}
