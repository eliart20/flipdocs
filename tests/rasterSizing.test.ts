import { describe, expect, it } from "vitest";
import { pageRasterHeight } from "../src/core/rasterSizing";

describe("pageRasterHeight", () => {
  it("supersamples a phone page at device scale", () => {
    expect(pageRasterHeight({
      cssHeight: 623,
      devicePixelRatio: 2,
      maxPixelRatio: 2,
      resolutionScale: 2,
      zoom: 1,
      maxTextureHeight: 4096,
    })).toBe(2492);
  });

  it("requests a sharper raster after zoom and honors the GPU cap", () => {
    expect(pageRasterHeight({
      cssHeight: 623,
      devicePixelRatio: 2,
      maxPixelRatio: 2,
      resolutionScale: 2,
      zoom: 2,
      maxTextureHeight: 4096,
    })).toBe(4096);
  });

  it("supports a lower-memory mobile deployment profile", () => {
    expect(pageRasterHeight({
      cssHeight: 800,
      devicePixelRatio: 3,
      maxPixelRatio: 1.25,
      resolutionScale: 2,
      zoom: 1,
      maxTextureHeight: 1536,
    })).toBe(1536);
  });
});
