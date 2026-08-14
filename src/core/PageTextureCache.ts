import {
  LinearFilter,
  SRGBColorSpace,
  Texture,
  type WebGLRenderer,
} from "three";
import type { PageSource, RenderedPage } from "../source/PageSource";

interface CacheEntry {
  texture: Texture;
  surface: RenderedPage;
  targetHeight: number;
}

interface PendingEntry {
  targetHeight: number;
  promise: Promise<Texture>;
}

export class PageTextureCache {
  private readonly entries = new Map<number, CacheEntry>();
  private readonly pending = new Map<number, PendingEntry>();
  private readonly pinned = new Set<number>();
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly source: PageSource,
    private readonly renderer: WebGLRenderer,
    private readonly maxEntries: number,
  ) {}

  has(index: number): boolean {
    return this.entries.has(index);
  }

  /** Return the best texture already on the GPU without waiting for a rerender. */
  peek(index: number): Texture | undefined {
    const cached = this.entries.get(index);
    if (!cached) return undefined;
    this.touch(index, cached);
    return cached.texture;
  }

  /** The raster height a page's cached texture was rendered at, if any. */
  heightOf(index: number): number | undefined {
    return this.entries.get(index)?.targetHeight;
  }

  async get(index: number, targetHeight: number): Promise<Texture> {
    if (this.disposed) {
      const error = new Error("The page texture cache has been disposed.");
      error.name = "AbortError";
      throw error;
    }
    if (index < 0 || index >= this.source.pageCount) throw new RangeError(`Page ${index} is out of range.`);
    const cached = this.entries.get(index);
    if (cached && cached.targetHeight >= targetHeight * 0.8) {
      this.touch(index, cached);
      return cached.texture;
    }
    const active = this.pending.get(index);
    if (active) {
      if (active.targetHeight >= targetHeight * 0.8) return active.promise;
      return active.promise.then(() => this.get(index, targetHeight));
    }

    const request = this.load(index, targetHeight, this.generation);
    this.pending.set(index, { targetHeight, promise: request });
    try {
      return await request;
    } finally {
      if (this.pending.get(index)?.promise === request) this.pending.delete(index);
    }
  }

  prefetch(indices: readonly number[], targetHeight: number): void {
    for (const index of indices) {
      if (index >= 0 && index < this.source.pageCount && !this.entries.has(index)) {
        void this.get(index, targetHeight).catch(() => undefined);
      }
    }
  }

  /**
   * Keep textures currently mapped onto the book alive while speculative
   * preloads fill the rest of the LRU. Pinned entries may temporarily exceed
   * the configured bound only when the active turn itself needs that many
   * surfaces; unpinned pages remain strictly bounded.
   */
  setPinned(indices: readonly number[]): void {
    this.pinned.clear();
    for (const index of indices) {
      if (index >= 0 && index < this.source.pageCount) this.pinned.add(index);
    }
    this.prune();
  }

  private async load(index: number, targetHeight: number, generation: number): Promise<Texture> {
    const surface = await this.source.renderPage(index, targetHeight);
    if (this.disposed || generation !== this.generation) {
      surface.dispose();
      const error = new Error("The page texture request was cancelled.");
      error.name = "AbortError";
      throw error;
    }
    const texture = new Texture(surface.image);
    texture.colorSpace = SRGBColorSpace;
    texture.flipY = false;
    texture.generateMipmaps = false;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;

    const previous = this.entries.get(index);
    if (previous) this.disposeEntry(previous);
    const entry = { texture, surface, targetHeight };
    this.entries.set(index, entry);
    this.prune();
    return texture;
  }

  private touch(index: number, entry: CacheEntry): void {
    this.entries.delete(index);
    this.entries.set(index, entry);
  }

  private prune(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = Array.from(this.entries.entries())
        .find(([index]) => !this.pinned.has(index));
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.disposeEntry(oldest[1]);
    }
  }

  private disposeEntry(entry: CacheEntry): void {
    entry.texture.dispose();
    entry.surface.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
    this.pending.clear();
    this.pinned.clear();
  }
}
