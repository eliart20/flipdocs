import { describe, expect, it, vi } from "vitest";
import {
  LoadedByteRanges,
  createBlobRangeTransport,
  createUrlRangeTransport,
} from "../src/source/pdfSource";

class TestRangeTransport {
  readonly requests: Array<{ begin: number; chunk: Uint8Array }> = [];

  constructor(
    readonly length: number,
    readonly initialData: Uint8Array | null,
    readonly progressiveDone: boolean,
    readonly contentDispositionFilename: string,
  ) {}

  onDataRange(begin: number, chunk: Uint8Array): void {
    this.requests.push({ begin, chunk });
  }
}

describe("LoadedByteRanges", () => {
  it("counts distinct bytes when PDF.js requests overlapping ranges", () => {
    const ranges = new LoadedByteRanges();
    expect(ranges.add(0, 100)).toBe(100);
    expect(ranges.add(50, 150)).toBe(150);
    expect(ranges.add(300, 340)).toBe(190);
    expect(ranges.add(140, 310)).toBe(340);
  });
});

describe("Blob PDF range transport", () => {
  it("reads only requested slices and reports unique loaded bytes", async () => {
    const source = new File(
      [new Uint8Array(Array.from({ length: 512 }, (_, index) => index % 251))],
      "large-book.pdf",
      { type: "application/pdf" },
    );
    const sliceSpy = vi.spyOn(source, "slice");
    const progress: Array<{ loadedBytes: number; totalBytes?: number }> = [];
    const pdfjs = {
      PDFDataRangeTransport: TestRangeTransport,
    } as never;
    const transport = createBlobRangeTransport(pdfjs, source, (event) => progress.push(event));

    transport.requestDataRange(64, 192);
    transport.requestDataRange(128, 256);
    await vi.waitFor(() => {
      expect((transport as unknown as TestRangeTransport).requests).toHaveLength(2);
    });

    expect(sliceSpy).toHaveBeenNthCalledWith(1, 64, 192);
    expect(sliceSpy).toHaveBeenNthCalledWith(2, 128, 256);
    expect(progress).toEqual([
      { loadedBytes: 0, totalBytes: 512 },
      { loadedBytes: 128, totalBytes: 512 },
      { loadedBytes: 192, totalBytes: 512 },
    ]);
    const requests = (transport as unknown as TestRangeTransport).requests;
    expect(requests[0].chunk).toHaveLength(128);
    expect(requests[1].chunk).toHaveLength(128);
  });
});

describe("URL PDF range transport", () => {
  it("probes one byte and then performs only explicit range requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(new Uint8Array([37]), {
        status: 206,
        headers: { "Content-Range": "bytes 0-0/4096" },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array(256), {
        status: 206,
        headers: { "Content-Range": "bytes 512-767/4096" },
      }));
    const progress: Array<{ loadedBytes: number; totalBytes?: number }> = [];
    const pdfjs = { PDFDataRangeTransport: TestRangeTransport } as never;
    const transport = await createUrlRangeTransport(
      pdfjs,
      "https://example.test/book.pdf",
      (event) => progress.push(event),
    );
    expect(transport).toBeDefined();
    transport!.requestDataRange(512, 768);
    await vi.waitFor(() => {
      expect((transport as unknown as TestRangeTransport).requests).toHaveLength(1);
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://example.test/book.pdf", {
      headers: { Range: "bytes=0-0" },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://example.test/book.pdf", {
      headers: { Range: "bytes=512-767" },
      signal: expect.any(AbortSignal),
    });
    expect(progress).toEqual([
      { loadedBytes: 1, totalBytes: 4096 },
      { loadedBytes: 257, totalBytes: 4096 },
    ]);
    fetchMock.mockRestore();
  });

  it("falls back when a server ignores byte ranges", async () => {
    const body = new ReadableStream({ start(controller) { controller.close(); } });
    const cancel = vi.spyOn(body, "cancel");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));
    const pdfjs = { PDFDataRangeTransport: TestRangeTransport } as never;
    await expect(createUrlRangeTransport(pdfjs, "https://example.test/book.pdf"))
      .resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
    fetchMock.mockRestore();
  });
});
