import type { PageLink, ReadingDirection } from "../types";

export interface RenderedPage {
  image: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | HTMLImageElement;
  width: number;
  height: number;
  dispose(): void;
}

export interface PageSource {
  readonly pageCount: number;
  readonly pageAspect: number;
  /** The document's declared opening direction, when the format carries one. */
  readonly readingDirection?: ReadingDirection;
  renderPage(index: number, targetHeight: number): Promise<RenderedPage>;
  /** Clickable regions on a page, when the format carries them. */
  pageLinks?(index: number): Promise<PageLink[]>;
  dispose(): void;
}
