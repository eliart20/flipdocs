const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export interface PointerAttachmentInput {
  clientX: number;
  initialSpineClientX: number;
  initialSpineWorldX: number;
  pagePixelWidth: number;
  pageWorldWidth: number;
  edgeWorldAtStart: number;
  edgeWorldAtEnd: number;
}

/**
 * Invert the complete world-space loose-edge path, including any simultaneous
 * book/focus translation. Solving only against the spine captured on pointer
 * down makes the sheet miss the finger whenever the book slides during a turn.
 */
export function attachedProgressForPointer({
  clientX,
  initialSpineClientX,
  initialSpineWorldX,
  pagePixelWidth,
  pageWorldWidth,
  edgeWorldAtStart,
  edgeWorldAtEnd,
}: PointerAttachmentInput): number {
  const worldPerPixel = pageWorldWidth / Math.max(1, pagePixelWidth);
  const cursorWorldX = initialSpineWorldX +
    (clientX - initialSpineClientX) * worldPerPixel;
  const edgeTravel = edgeWorldAtEnd - edgeWorldAtStart;
  if (Math.abs(edgeTravel) < 0.000001) return 0;
  return clamp01((cursorWorldX - edgeWorldAtStart) / edgeTravel);
}
