import { describe, expect, it, vi } from "vitest";
import type { WebGLRenderer } from "three";
import { pageRasterHeight } from "../src/core/rasterSizing";
import { PageTextureCache } from "../src/core/PageTextureCache";
import type { PageSource, RenderedPage } from "../src/source/PageSource";

function surface(height: number): RenderedPage {
  return {
    image: {} as HTMLCanvasElement,
    width: Math.round(height * 0.7),
    height,
    dispose: vi.fn(),
  };
}

function makeCache(maxEntries = 4): PageTextureCache {
  const source: PageSource = {
    pageCount: 8,
    pageAspect: 0.7,
    async renderPage(_index, targetHeight) {
      return surface(targetHeight);
    },
    dispose: vi.fn(),
  };
  const renderer = {
    capabilities: { getMaxAnisotropy: () => 4 },
  } as unknown as WebGLRenderer;
  return new PageTextureCache(source, renderer, maxEntries);
}

describe("zoom-aware raster sizing", () => {
  it("multiplies zoom into the same formula as viewport and pixel ratio", () => {
    const base = pageRasterHeight({
      cssHeight: 800,
      devicePixelRatio: 2,
      maxPixelRatio: 2,
      resolutionScale: 1,
      zoom: 1,
      maxTextureHeight: 16384,
    });
    const zoomed = pageRasterHeight({
      cssHeight: 800,
      devicePixelRatio: 2,
      maxPixelRatio: 2,
      resolutionScale: 1,
      zoom: 3,
      maxTextureHeight: 16384,
    });
    expect(base).toBe(1600);
    expect(zoomed).toBe(4800);
  });

  it("clamps the zoom boost at the texture ceiling", () => {
    const zoomed = pageRasterHeight({
      cssHeight: 1600,
      devicePixelRatio: 2,
      maxPixelRatio: 2,
      resolutionScale: 1,
      zoom: 3,
      maxTextureHeight: 4096,
    });
    expect(zoomed).toBe(4096);
  });
});

describe("PageTextureCache.heightOf", () => {
  it("reports the rendered raster height and undefined for uncached pages", async () => {
    const cache = makeCache();
    await cache.get(0, 1200);
    expect(cache.heightOf(0)).toBe(1200);
    expect(cache.heightOf(1)).toBeUndefined();
    await cache.get(0, 2400);
    expect(cache.heightOf(0)).toBe(2400);
    cache.dispose();
  });

  it("does not promote an entry in the LRU order", async () => {
    const cache = makeCache(2);
    await cache.get(0, 600);
    await cache.get(1, 600);
    // A staleness check on page 0 must not save it from eviction.
    expect(cache.heightOf(0)).toBe(600);
    await cache.get(2, 600);
    expect(cache.has(0)).toBe(false);
    expect(cache.has(1)).toBe(true);
    expect(cache.has(2)).toBe(true);
    cache.dispose();
  });
});
