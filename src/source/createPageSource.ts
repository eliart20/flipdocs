import type { FlipBookLoadProgressEvent, FlipBookSource } from "../types";
import type { PageSource } from "./PageSource";
import { createImageSource } from "./imageSource";
import { createPdfSource } from "./pdfSource";

export function createPageSource(
  source: FlipBookSource,
  onLoadProgress?: (event: FlipBookLoadProgressEvent) => void,
): Promise<PageSource> {
  return source.type === "images"
    ? createImageSource(source.pages)
    : createPdfSource(source.src, {
        password: source.password,
        workerUrl: source.workerUrl,
        lazy: source.lazy,
        rangeChunkSize: source.rangeChunkSize,
        onLoadProgress,
      });
}
