import type { ImageInput } from "../types";
import type { PageSource, RenderedPage } from "./PageSource";

type DecodedImage = ImageBitmap | HTMLImageElement;

async function decode(input: ImageInput): Promise<DecodedImage> {
  let blob: Blob | undefined;
  if (input instanceof Blob) {
    blob = input;
  } else if (typeof createImageBitmap === "function") {
    const response = await fetch(input.toString());
    if (!response.ok) throw new Error(`Image request failed: ${response.status}`);
    blob = await response.blob();
  }

  if (blob && typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob, {
        imageOrientation: "from-image",
        premultiplyAlpha: "default",
        colorSpaceConversion: "default",
      });
    } catch {
      // Some Chromium builds reject SVG blobs here even though <img> can
      // decode them. Falling through preserves broad image-format support.
    }
  }

  const image = new Image();
  image.crossOrigin = "anonymous";
  image.decoding = "async";
  image.src = input instanceof Blob ? URL.createObjectURL(input) : input.toString();
  try {
    await image.decode();
  } finally {
    if (input instanceof Blob) URL.revokeObjectURL(image.src);
  }
  return image;
}

function sizeOf(image: DecodedImage): { width: number; height: number } {
  return image instanceof ImageBitmap
    ? { width: image.width, height: image.height }
    : { width: image.naturalWidth, height: image.naturalHeight };
}

async function downsample(image: DecodedImage, targetHeight: number): Promise<RenderedPage> {
  const original = sizeOf(image);
  const height = Math.max(1, Math.min(original.height, Math.round(targetHeight)));
  const width = Math.max(1, Math.round((original.width / original.height) * height));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("A 2D canvas is required to decode book pages.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
  if (image instanceof ImageBitmap) image.close();

  if (typeof createImageBitmap === "function") {
    // ImageBitmap ignores Texture.flipY in WebGL. Normalize the orientation
    // here so image and PDF pages follow the exact same GPU upload path.
    const bitmap = await createImageBitmap(canvas, { imageOrientation: "flipY" });
    canvas.width = 1;
    canvas.height = 1;
    return { image: bitmap, width, height, dispose: () => bitmap.close() };
  }

  return {
    image: canvas,
    width,
    height,
    dispose: () => {
      canvas.width = 1;
      canvas.height = 1;
    },
  };
}

export async function createImageSource(pages: readonly ImageInput[]): Promise<PageSource> {
  if (pages.length === 0) throw new Error("An image flipbook needs at least one page.");
  const first = await decode(pages[0]);
  const dimensions = sizeOf(first);
  let firstPage: DecodedImage | undefined = first;

  return {
    pageCount: pages.length,
    pageAspect: dimensions.width / dimensions.height,
    async renderPage(index, targetHeight) {
      if (index < 0 || index >= pages.length) throw new RangeError(`Page ${index} is out of range.`);
      const image = index === 0 && firstPage ? firstPage : await decode(pages[index]);
      if (index === 0) firstPage = undefined;
      return downsample(image, targetHeight);
    },
    dispose() {
      if (firstPage instanceof ImageBitmap) firstPage.close();
      firstPage = undefined;
    },
  };
}
