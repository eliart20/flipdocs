import type { CSSProperties } from "react";

export type PdfInput = string | URL | Blob | ArrayBuffer | Uint8Array;
export type ImageInput = string | URL | Blob;

export type FlipBookSource =
  | {
      type: "pdf";
      src: PdfInput;
      password?: string;
      workerUrl?: string;
      /** Read only requested byte ranges when the input supports it. Defaults to true. */
      lazy?: boolean;
      /** PDF byte-range request size. Defaults to 256 KiB. */
      rangeChunkSize?: number;
    }
  | {
      type: "images";
      pages: readonly ImageInput[];
    };

export type FlipDirection = "next" | "previous";

/** Page-relative grab coordinates used for a programmatically held turn. */
export interface FlipBookTurnPose {
  /** Horizontal grab point, where 0 is the spine and 1 is the loose edge. */
  grabX: number;
  /** Vertical grab point, where 0 is the bottom and 1 is the top. */
  grabY: number;
  /** Current vertical target for the grabbed paper, from bottom (0) to top (1). */
  targetY: number;
  /** Keeps the loose edge attached to the target as it is during a live drag. */
  pointerAttached?: boolean;
}

/**
 * Which way the book opens. "rtl" is a right-bound book (Hebrew, Arabic,
 * manga): the unread stack sits on the left and sheets turn left-to-right.
 * "auto" follows the PDF's ViewerPreferences /Direction, defaulting to "ltr".
 */
export type ReadingDirection = "ltr" | "rtl";

export interface FlipBookReadyEvent {
  pageCount: number;
  pageAspect: number;
  /** The direction the book actually opened with, after auto-detection. */
  readingDirection: ReadingDirection;
}

export interface FlipBookLoadProgressEvent {
  /** Distinct PDF bytes read so far. */
  loadedBytes: number;
  /** Total PDF size when it is known. */
  totalBytes?: number;
}

export interface FlipBookPageEvent {
  /** Zero-based active page on mobile; first visible page in desktop spreads. */
  pageIndex: number;
  pageCount: number;
}

export interface FlipBookHandle {
  next(): void;
  previous(): void;
  goToPage(pageIndex: number): void;
  /** Hold a sheet at any point from 0 (right) to 1 (left). */
  setFlipProgress(
    progress: number,
    direction?: FlipDirection,
    pose?: Partial<FlipBookTurnPose>,
  ): void;
  /** Show the exact loose-corner pose normally entered by pointer hover. */
  previewCorner(corner?: "top" | "bottom", direction?: FlipDirection): void;
  /** Return a held or previewed sheet to its starting spread without advancing. */
  resetFlip(): void;
  /** Complete whichever held/dragged sheet is active. */
  completeFlip(): void;
  /** Render immediately and return an origin-clean PNG data URL of the WebGL viewer. */
  capturePng(): string;
  zoomIn(): void;
  zoomOut(): void;
  setZoom(zoom: number): void;
  resetZoom(): void;
}

export interface FlipBookCurlSettings {
  /** Curl-cylinder radius as a fraction of page width. */
  radius: number;
  /** Maximum radius relative to pointer travel. Lower values make a tighter fold. */
  radiusLimit: number;
  /** How strongly vertical pointer movement pulls the paper, from 0 to 1. */
  verticalPull: number;
  /** Fraction of page width used to blend the curl into the fixed spine. */
  binding: number;
  /** Horizontal drag distance multiplier. */
  dragResistance: number;
  /** Progress required before a released page completes its turn. */
  snapThreshold: number;
  /** Carry release speed into the settle animation, so flicks land fast. */
  velocityFling: boolean;
  /** Damped free-edge flutter when a sheet lands, from 0 (off) to 1. */
  settleWobble: number;
  /** Extra stiffness applied to the cover sheet, from 0 (paper) to 1 (board). */
  coverStiffness: number;
  /**
   * Horizontal vertex resolution of the turning sheet, from 36 to 96.
   * Lower values cut per-frame CPU cost roughly linearly; 72 is the default
   * smoothness, 48 is a good low-end-device setting.
   */
  segments: number;
}

export interface FlipBookRenderSettings {
  /** Page-texture supersampling, independent of device pixel ratio. */
  resolutionScale: number;
  /** Minimum light applied to the moving sheet. */
  ambientLight: number;
  /** Directional-light contribution on the moving sheet. */
  directionalLight: number;
  /** Extra shading where the paper turns away from the camera. */
  foldContrast: number;
  /** Direction of the key light around the page, in degrees. */
  lightAngle: number;
  /** Height of the key light above the page, from 0 to 1. */
  lightElevation: number;
  /** Enables the moving sheet's cast shadow. */
  shadows: boolean;
  /** Maximum cast-shadow opacity. */
  shadowOpacity: number;
  /** Cast-shadow filter radius. */
  shadowSoftness: number;
  /** Width and height of the moving-sheet shadow map. */
  shadowResolution: number;
  /** Glossy-paper specular band on the moving sheet, from 0 (matte) to 1. */
  sheen: number;
  /** Physical resting-page rise into the binding, as a fraction of page size. */
  spineBend: number;
  /** Optional artistic gutter overlay, from 0 (native lighting only) to 1. */
  gutterShading: number;
}

export interface FlipBookBodySettings {
  /** Renders the book as an object: stacked page edges and cover boards. */
  enabled: boolean;
  /** Full-book edge-stack width as a fraction of page width. */
  thickness: number;
  /** Cover board color. */
  coverColor: string;
  /** How far cover boards extend past the page block, as a page-width fraction. */
  overhang: number;
}

export interface FlipBookRiffleSettings {
  /** Animates quick intermediate page turns on long jumps. */
  enabled: boolean;
  /** Maximum sheets animated for one jump; the rest are skipped silently. */
  maxSheets: number;
}

export interface FlipBookSoundSettings {
  /** Plays a soft page-turn swish when a sheet is released. */
  enabled: boolean;
  /** Optional custom audio clip URL. A procedural swish is used when omitted. */
  src?: string;
  /** Playback volume from 0 to 1. */
  volume: number;
}

/** A clickable region on a page, in page-relative units with a top-left origin. */
export interface PageLink {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Zero-based destination page for internal links. */
  destPage?: number;
  /** Destination URL for external links. */
  url?: string;
}

export interface FlipBookCornerSettings {
  /** Enables the loose-corner preview and corner click behavior. */
  enabled: boolean;
  /** Width and height of the corner hit area as a fraction of the page. */
  size: number;
  /** Partial turn shown while a corner is hovered, from 0 to 1. */
  lift: number;
  /** How far the hovered corner pulls toward the page center. */
  pull: number;
}

export interface FlipBookZoomSettings {
  /** Zoom used when the viewer first mounts or is reset. */
  initial: number;
  min: number;
  max: number;
  /** Amount used by toolbar and keyboard zoom controls. */
  step: number;
  /** Enables mouse-wheel and trackpad zoom over the pages. */
  wheel: boolean;
  /** Zooms toward the pointer instead of the book center. */
  toPointer: boolean;
  /** Drag pans the view while zoomed in; page turns use corners and keys. */
  pan: boolean;
}

export interface FlipBookMobileSettings {
  /** Enables single-page focus below `breakpoint`. */
  enabled: boolean;
  /** Viewer width at which single-page focus turns on. */
  breakpoint: number;
  /** Fraction of a page kept visible across the spine. */
  pagePeek: number;
  /** Double-tap toggles zoom toward the tapped point. */
  doubleTapZoom: boolean;
}

export interface FlipBookProps {
  source: FlipBookSource;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  showControls?: boolean;
  /** Adds a fullscreen toggle to the toolbar. */
  showFullscreen?: boolean;
  /**
   * Shows a thumbnail strip. Off by default because it must rasterize every
   * page it shows, which defeats lazy loading on very large PDFs.
   */
  showThumbnails?: boolean;
  /** Makes PDF link annotations clickable: internal jumps and external URLs. */
  links?: boolean;
  /**
   * Book opening direction. "auto" (default) follows the PDF's declared
   * /Direction viewer preference and falls back to left-to-right.
   */
  direction?: ReadingDirection | "auto";
  startPage?: number;
  animationDuration?: number;
  cacheSize?: number;
  preloadRadius?: number;
  maxPixelRatio?: number;
  maxTextureHeight?: number;
  background?: string;
  pageColor?: string;
  interactive?: boolean;
  curl?: Partial<FlipBookCurlSettings>;
  corner?: Partial<FlipBookCornerSettings>;
  render?: Partial<FlipBookRenderSettings>;
  zoom?: Partial<FlipBookZoomSettings>;
  mobile?: Partial<FlipBookMobileSettings>;
  body?: Partial<FlipBookBodySettings>;
  riffle?: Partial<FlipBookRiffleSettings>;
  sound?: Partial<FlipBookSoundSettings>;
  onLoadProgress?: (event: FlipBookLoadProgressEvent) => void;
  onReady?: (event: FlipBookReadyEvent) => void;
  onPageChange?: (event: FlipBookPageEvent) => void;
  onZoomChange?: (zoom: number) => void;
  onError?: (error: Error) => void;
}
