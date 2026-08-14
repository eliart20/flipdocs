export interface PageRasterSizing {
  cssHeight: number;
  devicePixelRatio: number;
  maxPixelRatio: number;
  resolutionScale: number;
  zoom: number;
  maxTextureHeight: number;
}

/** Calculate the page raster requested from PDF/image sources. */
export function pageRasterHeight(sizing: PageRasterSizing): number {
  const cssHeight = Math.max(480, sizing.cssHeight || 0);
  const pixelRatio = Math.min(
    Math.max(0.25, sizing.devicePixelRatio || 1),
    Math.max(0.25, sizing.maxPixelRatio),
  );
  return Math.max(1, Math.min(
    sizing.maxTextureHeight,
    Math.ceil(cssHeight * pixelRatio * sizing.resolutionScale * sizing.zoom),
  ));
}
