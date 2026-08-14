import { describe, expect, it, vi } from "vitest";
import type { WebGLRenderer } from "three";
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

describe("PageTextureCache", () => {
  it("follows an in-flight small render with a requested sharper render", async () => {
    let releaseFirst!: () => void;
    const firstRender = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const requestedHeights: number[] = [];
    const source: PageSource = {
      pageCount: 1,
      pageAspect: 0.7,
      async renderPage(_index, targetHeight) {
        requestedHeights.push(targetHeight);
        if (requestedHeights.length === 1) await firstRender;
        return surface(targetHeight);
      },
      dispose: vi.fn(),
    };
    const renderer = {
      capabilities: { getMaxAnisotropy: () => 4 },
    } as unknown as WebGLRenderer;
    const cache = new PageTextureCache(source, renderer, 4);

    const small = cache.get(0, 600);
    const sharp = cache.get(0, 1800);
    expect(requestedHeights).toEqual([600]);

    releaseFirst();
    await Promise.all([small, sharp]);
    expect(requestedHeights).toEqual([600, 1800]);
    cache.dispose();
  });

  it("keeps a strict LRU bound and disposes the oldest GPU surface", async () => {
    const surfaces: RenderedPage[] = [];
    const source: PageSource = {
      pageCount: 4,
      pageAspect: 0.7,
      async renderPage(_index, targetHeight) {
        const rendered = surface(targetHeight);
        surfaces.push(rendered);
        return rendered;
      },
      dispose: vi.fn(),
    };
    const renderer = {
      capabilities: { getMaxAnisotropy: () => 4 },
    } as unknown as WebGLRenderer;
    const cache = new PageTextureCache(source, renderer, 2);

    await cache.get(0, 600);
    await cache.get(1, 600);
    await cache.get(0, 600); // page 0 is now the most recently used entry
    await cache.get(2, 600);

    expect(cache.has(0)).toBe(true);
    expect(cache.has(1)).toBe(false);
    expect(cache.has(2)).toBe(true);
    expect(surfaces[0].dispose).not.toHaveBeenCalled();
    expect(surfaces[1].dispose).toHaveBeenCalledOnce();
    cache.dispose();
    expect(surfaces[0].dispose).toHaveBeenCalledOnce();
    expect(surfaces[2].dispose).toHaveBeenCalledOnce();
  });

  it("keeps the last GPU texture available while a sharper replacement renders", async () => {
    let releaseSharp!: () => void;
    const sharpRender = new Promise<void>((resolve) => { releaseSharp = resolve; });
    let calls = 0;
    const source: PageSource = {
      pageCount: 1,
      pageAspect: 0.7,
      async renderPage(_index, targetHeight) {
        calls += 1;
        if (calls === 2) await sharpRender;
        return surface(targetHeight);
      },
      dispose: vi.fn(),
    };
    const renderer = {
      capabilities: { getMaxAnisotropy: () => 4 },
    } as unknown as WebGLRenderer;
    const cache = new PageTextureCache(source, renderer, 2);

    const initial = await cache.get(0, 600);
    const sharper = cache.get(0, 1800);
    expect(cache.peek(0)).toBe(initial);

    releaseSharp();
    const replacement = await sharper;
    expect(cache.peek(0)).toBe(replacement);
    cache.dispose();
  });

  it("never evicts a texture that is still pinned onto a visible page", async () => {
    const surfaces: RenderedPage[] = [];
    const source: PageSource = {
      pageCount: 4,
      pageAspect: 0.7,
      async renderPage(_index, targetHeight) {
        const rendered = surface(targetHeight);
        surfaces.push(rendered);
        return rendered;
      },
      dispose: vi.fn(),
    };
    const renderer = {
      capabilities: { getMaxAnisotropy: () => 4 },
    } as unknown as WebGLRenderer;
    const cache = new PageTextureCache(source, renderer, 2);

    await cache.get(0, 600);
    await cache.get(1, 600);
    cache.setPinned([0]);
    await cache.get(2, 600);

    expect(cache.has(0)).toBe(true);
    expect(cache.has(1)).toBe(false);
    expect(cache.has(2)).toBe(true);
    expect(surfaces[0].dispose).not.toHaveBeenCalled();
    expect(surfaces[1].dispose).toHaveBeenCalledOnce();
    cache.dispose();
  });

  it("disposes an in-flight surface instead of installing it after cache disposal", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const rendered = surface(600);
    const source: PageSource = {
      pageCount: 1,
      pageAspect: 0.7,
      async renderPage() {
        await waiting;
        return rendered;
      },
      dispose: vi.fn(),
    };
    const renderer = {
      capabilities: { getMaxAnisotropy: () => 4 },
    } as unknown as WebGLRenderer;
    const cache = new PageTextureCache(source, renderer, 2);

    const request = cache.get(0, 600);
    cache.dispose();
    release();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(rendered.dispose).toHaveBeenCalledOnce();
    expect(cache.has(0)).toBe(false);
  });
});
