import type { OnProgressParameters, PDFDataRangeTransport } from "pdfjs-dist";
import type { FlipBookLoadProgressEvent, PageLink, PdfInput } from "../types";
import type { PageSource, RenderedPage } from "./PageSource";

// Kept beside the built library by scripts/copy-pdf-worker.mjs. Using a
// runtime URL prevents library-mode bundlers from base64-inlining ~1.6 MB into
// image-only applications.
const workerFileName = "pdf.worker.min.mjs";

function packagedPdfWorkerUrl(): string {
  if (!import.meta.env.DEV) return new URL(workerFileName, import.meta.url).href;
  if (typeof window === "undefined") return new URL(workerFileName, import.meta.url).href;
  return new URL(`/${workerFileName}`, window.location.href).href;
}

const defaultRangeChunkSize = 256 * 1024;

interface PdfSourceOptions {
  password?: string;
  workerUrl?: string;
  lazy?: boolean;
  rangeChunkSize?: number;
  onLoadProgress?: (event: FlipBookLoadProgressEvent) => void;
}

export class LoadedByteRanges {
  private ranges: Array<[number, number]> = [];

  add(begin: number, end: number): number {
    if (end <= begin) return this.loaded;
    this.ranges.push([begin, end]);
    this.ranges.sort((left, right) => left[0] - right[0]);

    const merged: Array<[number, number]> = [];
    for (const range of this.ranges) {
      const previous = merged.at(-1);
      if (!previous || range[0] > previous[1]) merged.push([...range]);
      else previous[1] = Math.max(previous[1], range[1]);
    }
    this.ranges = merged;
    return this.loaded;
  }

  get loaded(): number {
    return this.ranges.reduce((total, [begin, end]) => total + end - begin, 0);
  }
}

function blobFileName(blob: Blob): string {
  const namedBlob = blob as Blob & { name?: unknown };
  return typeof namedBlob.name === "string" && namedBlob.name ? namedBlob.name : "document.pdf";
}

export function createBlobRangeTransport(
  pdfjs: typeof import("pdfjs-dist"),
  blob: Blob,
  onLoadProgress?: (event: FlipBookLoadProgressEvent) => void,
): PDFDataRangeTransport {
  class BlobRangeTransport extends pdfjs.PDFDataRangeTransport {
    private aborted = false;
    private readonly loadedRanges = new LoadedByteRanges();

    constructor() {
      // There is no progressive stream. PDF.js must explicitly request each
      // range, which keeps a multi-hundred-megabyte File out of main memory.
      super(blob.size, null, true, blobFileName(blob));
    }

    requestDataRange(begin: number, end: number): void {
      const boundedEnd = Math.min(blob.size, end);
      void blob.slice(begin, boundedEnd).arrayBuffer().then(
        (buffer) => {
          if (this.aborted) return;
          const chunk = new Uint8Array(buffer);
          const loadedBytes = this.loadedRanges.add(begin, begin + chunk.byteLength);
          onLoadProgress?.({ loadedBytes, totalBytes: blob.size });
          this.onDataRange(begin, chunk);
        },
        () => {
          if (!this.aborted) this.onDataRange(begin, new Uint8Array());
        },
      );
    }

    abort(): void {
      this.aborted = true;
    }
  }

  onLoadProgress?.({ loadedBytes: 0, totalBytes: blob.size });
  return new BlobRangeTransport();
}

function urlFileName(url: string): string {
  try {
    const base = typeof document === "undefined" ? "http://localhost/" : document.baseURI;
    const name = new URL(url, base).pathname.split("/").at(-1);
    return name ? decodeURIComponent(name) : "document.pdf";
  } catch {
    return "document.pdf";
  }
}

export async function createUrlRangeTransport(
  pdfjs: typeof import("pdfjs-dist"),
  url: string,
  onLoadProgress?: (event: FlipBookLoadProgressEvent) => void,
): Promise<PDFDataRangeTransport | undefined> {
  let probe: Response;
  try {
    probe = await fetch(url, { headers: { Range: "bytes=0-0" } });
  } catch {
    return undefined;
  }
  const contentRange = probe.headers.get("Content-Range");
  const match = /^bytes\s+0-0\/(\d+)$/i.exec(contentRange ?? "");
  if (probe.status !== 206 || !match) {
    await probe.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const totalBytes = Number(match[1]);
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 1) {
    await probe.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const initialData = new Uint8Array(await probe.arrayBuffer());
  if (initialData.byteLength !== 1) return undefined;

  class UrlRangeTransport extends pdfjs.PDFDataRangeTransport {
    private aborted = false;
    private readonly controllers = new Set<AbortController>();
    private readonly loadedRanges = new LoadedByteRanges();

    constructor() {
      super(totalBytes, initialData, true, urlFileName(url));
      this.loadedRanges.add(0, initialData.byteLength);
    }

    requestDataRange(begin: number, end: number): void {
      const boundedEnd = Math.min(totalBytes, end);
      const controller = new AbortController();
      this.controllers.add(controller);
      void fetch(url, {
        headers: { Range: `bytes=${begin}-${boundedEnd - 1}` },
        signal: controller.signal,
      }).then(async (response) => {
        if (response.status !== 206) throw new Error(`Expected PDF range response, received ${response.status}.`);
        const expectedLength = boundedEnd - begin;
        const expectedContentRange = `bytes ${begin}-${boundedEnd - 1}/${totalBytes}`;
        if (response.headers.get("Content-Range") !== expectedContentRange) {
          throw new Error("The PDF server returned an invalid Content-Range header.");
        }
        const chunk = new Uint8Array(await response.arrayBuffer());
        if (chunk.byteLength !== expectedLength) {
          throw new Error("The PDF server returned an incomplete byte range.");
        }
        if (this.aborted) return;
        const loadedBytes = this.loadedRanges.add(begin, begin + chunk.byteLength);
        onLoadProgress?.({ loadedBytes, totalBytes });
        this.onDataRange(begin, chunk);
      }).catch(() => {
        if (!this.aborted) this.onDataRange(begin, new Uint8Array());
      }).finally(() => this.controllers.delete(controller));
    }

    abort(): void {
      this.aborted = true;
      for (const controller of this.controllers) controller.abort();
      this.controllers.clear();
    }
  }

  onLoadProgress?.({ loadedBytes: 1, totalBytes });
  return new UrlRangeTransport();
}

async function pdfData(input: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof Blob) return new Uint8Array(await input.arrayBuffer());
  return new Uint8Array(input);
}

export async function createPdfSource(
  src: PdfInput,
  {
    password,
    workerUrl,
    lazy = true,
    rangeChunkSize = defaultRangeChunkSize,
    onLoadProgress,
  }: PdfSourceOptions = {},
): Promise<PageSource> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl ?? packagedPdfWorkerUrl();

  const chunkSize = Number.isFinite(rangeChunkSize) && rangeChunkSize > 0
    ? Math.floor(rangeChunkSize)
    : defaultRangeChunkSize;
  const isUrl = typeof src === "string" || src instanceof URL;
  const isBlob = src instanceof Blob;
  let nativeUrlStream = false;
  let parameters: Parameters<typeof pdfjs.getDocument>[0];

  if (isUrl) {
    const url = src.toString();
    const range = lazy
      ? await createUrlRangeTransport(pdfjs, url, onLoadProgress)
      : undefined;
    if (range) {
      parameters = {
        url,
        docBaseUrl: url,
        range,
        password,
        rangeChunkSize: chunkSize,
        disableStream: true,
        disableAutoFetch: true,
      };
    } else {
      nativeUrlStream = true;
      // A server that cannot satisfy strict byte ranges cannot be lazy. Fall
      // back to PDF.js's normal progressive stream instead of disabling both
      // streaming and auto-fetch with no range transport to feed the parser.
      parameters = {
        url,
        password,
        rangeChunkSize: chunkSize,
        disableStream: false,
        disableAutoFetch: false,
      };
    }
  } else if (isBlob && lazy) {
    parameters = {
      range: createBlobRangeTransport(pdfjs, src, onLoadProgress),
      password,
      rangeChunkSize: chunkSize,
      disableStream: true,
      disableAutoFetch: true,
    };
  } else {
    const data = await pdfData(src);
    onLoadProgress?.({ loadedBytes: data.byteLength, totalBytes: data.byteLength });
    parameters = { data, password };
  }

  const loadingTask = pdfjs.getDocument(parameters);
  if (nativeUrlStream && onLoadProgress) {
    loadingTask.onProgress = ({ loaded, total }: OnProgressParameters) => {
      const totalBytes = Number.isFinite(total) && total > 0 ? total : undefined;
      onLoadProgress({
        loadedBytes: totalBytes ? Math.min(loaded, totalBytes) : loaded,
        totalBytes,
      });
    };
  }
  const documentProxy = await loadingTask.promise;
  const first = await documentProxy.getPage(1);
  const firstViewport = first.getViewport({ scale: 1 });
  first.cleanup();
  const viewerPreferences = await documentProxy.getViewerPreferences().catch(() => null) as
    | { Direction?: string }
    | null;
  const readingDirection = viewerPreferences?.Direction === "R2L" ? "rtl" as const : "ltr" as const;

  const safeUrl = (candidate: unknown): string | undefined => {
    if (typeof candidate !== "string") return undefined;
    try {
      const parsed = new URL(candidate, "https://invalid.example/");
      return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? candidate : undefined;
    } catch {
      return undefined;
    }
  };

  const linkCache = new Map<number, PageLink[]>();

  return {
    pageCount: documentProxy.numPages,
    pageAspect: firstViewport.width / firstViewport.height,
    readingDirection,
    async renderPage(index, targetHeight): Promise<RenderedPage> {
      if (index < 0 || index >= documentProxy.numPages) {
        throw new RangeError(`Page ${index} is out of range.`);
      }
      const page = await documentProxy.getPage(index + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.max(0.1, targetHeight / base.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("A 2D canvas is required to render PDF pages.");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      try {
        await page.render({ canvas, canvasContext: context, viewport, background: "#ffffff" }).promise;
      } finally {
        page.cleanup();
      }

      if (typeof createImageBitmap === "function") {
        const bitmap = await createImageBitmap(canvas, { imageOrientation: "flipY" });
        const width = canvas.width;
        const height = canvas.height;
        canvas.width = 1;
        canvas.height = 1;
        return { image: bitmap, width, height, dispose: () => bitmap.close() };
      }

      return {
        image: canvas,
        width: canvas.width,
        height: canvas.height,
        dispose: () => {
          canvas.width = 1;
          canvas.height = 1;
        },
      };
    },
    async pageLinks(index): Promise<PageLink[]> {
      if (index < 0 || index >= documentProxy.numPages) return [];
      const cached = linkCache.get(index);
      if (cached) return cached;

      const page = await documentProxy.getPage(index + 1);
      const viewport = page.getViewport({ scale: 1 });
      const annotations = await page.getAnnotations({ intent: "display" });
      const links: PageLink[] = [];
      for (const annotation of annotations) {
        if (annotation.subtype !== "Link" || !Array.isArray(annotation.rect)) continue;
        const [x1, y1] = viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]);
        const [x2, y2] = viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]);
        const region = {
          left: Math.min(x1, x2) / viewport.width,
          right: Math.max(x1, x2) / viewport.width,
          top: Math.min(y1, y2) / viewport.height,
          bottom: Math.max(y1, y2) / viewport.height,
        };
        const url = safeUrl(annotation.url ?? annotation.unsafeUrl);
        if (url) {
          links.push({ ...region, url });
          continue;
        }
        let destination: unknown = annotation.dest;
        if (typeof destination === "string") {
          destination = await documentProxy.getDestination(destination).catch(() => null);
        }
        if (Array.isArray(destination) && destination[0] != null && typeof destination[0] === "object") {
          const destPage = await documentProxy
            .getPageIndex(destination[0] as Parameters<typeof documentProxy.getPageIndex>[0])
            .catch(() => undefined);
          if (typeof destPage === "number") links.push({ ...region, destPage });
        }
      }
      page.cleanup();
      linkCache.set(index, links);
      return links;
    },
    dispose() {
      void loadingTask.destroy();
    },
  };
}
