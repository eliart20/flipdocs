import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { FlipBookEngine } from "./core/FlipBookEngine";
import { createPageSource } from "./source/createPageSource";
import type {
  FlipBookBodySettings,
  FlipBookCornerSettings,
  FlipBookCurlSettings,
  FlipBookHandle,
  FlipBookLoadProgressEvent,
  FlipBookMobileSettings,
  FlipBookProps,
  FlipBookRenderSettings,
  FlipBookRiffleSettings,
  FlipBookSoundSettings,
  FlipBookZoomSettings,
  ReadingDirection,
} from "./types";
import "./flipbook.css";

const defaults = {
  animationDuration: 760,
  cacheSize: 6,
  preloadRadius: 2,
  maxPixelRatio: 2,
  maxTextureHeight: 4096,
  background: "#202226",
  pageColor: "#fffdf8",
};

const defaultCurl: FlipBookCurlSettings = {
  radius: 0.16,
  radiusLimit: 0.65,
  verticalPull: 0.65,
  binding: 0.14,
  dragResistance: 1,
  snapThreshold: 0.24,
  velocityFling: true,
  settleWobble: 0.55,
  coverStiffness: 0.4,
  segments: 72,
};

const defaultRender: FlipBookRenderSettings = {
  resolutionScale: 2,
  ambientLight: 0.88,
  directionalLight: 0.12,
  foldContrast: 0.06,
  // Keyed nearly overhead with a slight outside tilt, so a turning sheet
  // shades the spread close beneath it on BOTH sides of the fold instead of
  // throwing its whole shadow across to the opposite page.
  lightAngle: 38,
  lightElevation: 0.93,
  shadows: true,
  shadowOpacity: 0.3,
  shadowSoftness: 2.5,
  shadowResolution: 2048,
  sheen: 0.16,
  spineBend: 0.012,
  gutterShading: 0,
};

const defaultCorner: FlipBookCornerSettings = {
  enabled: true,
  size: 0.18,
  lift: 0.075,
  pull: 0.08,
};

const defaultZoom: FlipBookZoomSettings = {
  initial: 1,
  min: 0.75,
  max: 4,
  step: 0.25,
  wheel: true,
  toPointer: true,
  pan: true,
};

const defaultMobile: FlipBookMobileSettings = {
  enabled: true,
  breakpoint: 900,
  pagePeek: 0.08,
  doubleTapZoom: true,
};

const defaultBody: FlipBookBodySettings = {
  enabled: true,
  thickness: 0.055,
  coverColor: "#463527",
  overhang: 0.014,
};

const defaultRiffle: FlipBookRiffleSettings = {
  enabled: true,
  maxSheets: 3,
};

const defaultSound: FlipBookSoundSettings = {
  enabled: false,
  volume: 0.5,
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
}

export const FlipBook = forwardRef<FlipBookHandle, FlipBookProps>(function FlipBook(
  {
    source,
    className,
    style,
    ariaLabel = "Interactive flipbook",
    showControls = true,
    showFullscreen = true,
    showThumbnails = false,
    links = false,
    direction = "auto",
    startPage = 0,
    animationDuration = defaults.animationDuration,
    cacheSize = defaults.cacheSize,
    preloadRadius = defaults.preloadRadius,
    maxPixelRatio = defaults.maxPixelRatio,
    maxTextureHeight = defaults.maxTextureHeight,
    background = defaults.background,
    pageColor = defaults.pageColor,
    interactive = true,
    curl,
    corner,
    render,
    zoom,
    mobile,
    body,
    riffle,
    sound,
    onLoadProgress,
    onReady,
    onPageChange,
    onZoomChange,
    onError,
  },
  forwardedRef,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const engineRef = useRef<FlipBookEngine | undefined>(undefined);
  const callbacks = useRef({ onLoadProgress, onReady, onPageChange, onZoomChange, onError });
  const pageCountRef = useRef(0);
  callbacks.current = { onLoadProgress, onReady, onPageChange, onZoomChange, onError };
  const [pageCount, setPageCount] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [canPrevious, setCanPrevious] = useState(false);
  const [canNext, setCanNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadProgress, setLoadProgress] = useState<FlipBookLoadProgressEvent>();
  const [error, setError] = useState<string>();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [resolvedDirection, setResolvedDirection] = useState<ReadingDirection>(
    direction === "rtl" ? "rtl" : "ltr",
  );
  const sourceDirectionRef = useRef<ReadingDirection>("ltr");
  const directionRef = useRef(direction);
  directionRef.current = direction;
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({});
  const thumbnailQueue = useRef<{ pending: number[]; requested: Set<number>; running: boolean }>({
    pending: [],
    requested: new Set(),
    running: false,
  });
  const [zoomLevel, setZoomLevel] = useState(() => Math.max(
    zoom?.min ?? defaultZoom.min,
    Math.min(zoom?.max ?? defaultZoom.max, zoom?.initial ?? defaultZoom.initial),
  ));

  useImperativeHandle(forwardedRef, () => ({
    next: () => engineRef.current?.next(),
    previous: () => engineRef.current?.previous(),
    goToPage: (page) => engineRef.current?.goToPage(page),
    setFlipProgress: (progress, direction, pose) => (
      engineRef.current?.setFlipProgress(progress, direction, pose)
    ),
    previewCorner: (corner, direction) => engineRef.current?.previewCorner(corner, direction),
    resetFlip: () => engineRef.current?.resetFlip(),
    completeFlip: () => engineRef.current?.completeFlip(),
    capturePng: () => engineRef.current?.capturePng() ?? "",
    zoomIn: () => engineRef.current?.zoomIn(),
    zoomOut: () => engineRef.current?.zoomOut(),
    setZoom: (value) => engineRef.current?.setZoom(value),
    resetZoom: () => engineRef.current?.resetZoom(),
  }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const engine = new FlipBookEngine(host, {
      animationDuration,
      cacheSize,
      preloadRadius,
      maxPixelRatio,
      maxTextureHeight,
      pageColor,
      interactive,
      startPage,
      curl: { ...defaultCurl, ...curl },
      corner: { ...defaultCorner, ...corner },
      render: { ...defaultRender, ...render },
      zoom: { ...defaultZoom, ...zoom },
      mobile: { ...defaultMobile, ...mobile },
      body: { ...defaultBody, ...body },
      riffle: { ...defaultRiffle, ...riffle },
      sound: { ...defaultSound, ...sound },
      links,
      readingDirection: direction === "rtl" ? "rtl" : "ltr",
      onPageChange: (index) => {
        setPageIndex(index);
        callbacks.current.onPageChange?.({ pageIndex: index, pageCount: pageCountRef.current });
      },
      onNavigationChange: (previous, next) => {
        setCanPrevious(previous);
        setCanNext(next);
      },
      onError: (reason) => {
        setError(reason.message);
        callbacks.current.onError?.(reason);
      },
      onZoomChange: (value) => {
        setZoomLevel(value);
        callbacks.current.onZoomChange?.(value);
      },
    });
    engine.canvas.setAttribute("aria-label", ariaLabel);
    engineRef.current = engine;
    return () => {
      engineRef.current = undefined;
      engine.destroy();
    };
    // Engine-level performance options are intentionally immutable after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.setCurlSettings({ ...defaultCurl, ...curl });
  }, [
    curl?.radius,
    curl?.radiusLimit,
    curl?.verticalPull,
    curl?.binding,
    curl?.dragResistance,
    curl?.snapThreshold,
    curl?.velocityFling,
    curl?.settleWobble,
    curl?.coverStiffness,
    curl?.segments,
  ]);

  useEffect(() => {
    engineRef.current?.setCornerSettings({ ...defaultCorner, ...corner });
  }, [corner?.enabled, corner?.size, corner?.lift, corner?.pull]);

  useEffect(() => {
    engineRef.current?.setRenderSettings({ ...defaultRender, ...render });
  }, [
    render?.resolutionScale,
    render?.ambientLight,
    render?.directionalLight,
    render?.foldContrast,
    render?.lightAngle,
    render?.lightElevation,
    render?.shadows,
    render?.shadowOpacity,
    render?.shadowSoftness,
    render?.shadowResolution,
    render?.sheen,
    render?.spineBend,
    render?.gutterShading,
  ]);

  useEffect(() => {
    engineRef.current?.setZoomSettings({ ...defaultZoom, ...zoom });
  }, [zoom?.initial, zoom?.min, zoom?.max, zoom?.step, zoom?.wheel, zoom?.toPointer, zoom?.pan]);

  useEffect(() => {
    engineRef.current?.setMobileSettings({ ...defaultMobile, ...mobile });
  }, [mobile?.enabled, mobile?.breakpoint, mobile?.pagePeek, mobile?.doubleTapZoom]);

  useEffect(() => {
    engineRef.current?.setBodySettings({ ...defaultBody, ...body });
  }, [body?.enabled, body?.thickness, body?.coverColor, body?.overhang]);

  useEffect(() => {
    engineRef.current?.setRiffleSettings({ ...defaultRiffle, ...riffle });
  }, [riffle?.enabled, riffle?.maxSheets]);

  useEffect(() => {
    engineRef.current?.setSoundSettings({ ...defaultSound, ...sound });
  }, [sound?.enabled, sound?.src, sound?.volume]);

  useEffect(() => {
    engineRef.current?.setLinksEnabled(links);
  }, [links]);

  useEffect(() => {
    const resolved = direction === "auto" ? sourceDirectionRef.current : direction;
    setResolvedDirection(resolved);
    engineRef.current?.setReadingDirection(resolved);
  }, [direction]);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void sectionRef.current?.requestFullscreen().catch(() => undefined);
  }, []);

  const requestThumbnail = useCallback((index: number) => {
    const queue = thumbnailQueue.current;
    if (queue.requested.has(index)) return;
    queue.requested.add(index);
    queue.pending.push(index);
    if (queue.running) return;
    queue.running = true;
    const drain = async () => {
      while (queue.pending.length > 0) {
        const next = queue.pending.shift()!;
        try {
          const url = await engineRef.current?.renderThumbnail(next, 90);
          if (url) setThumbnails((current) => ({ ...current, [next]: url }));
        } catch {
          queue.requested.delete(next);
        }
      }
      queue.running = false;
    };
    void drain();
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadProgress(undefined);
    setError(undefined);
    pageCountRef.current = 0;
    setPageCount(0);
    setPageIndex(0);
    setCanPrevious(false);
    setCanNext(false);
    setThumbnails({});
    thumbnailQueue.current = { pending: [], requested: new Set(), running: false };
    void createPageSource(source, (progress) => {
      if (!active) return;
      setLoadProgress(progress);
      callbacks.current.onLoadProgress?.(progress);
    })
      .then(async (pageSource) => {
        if (!active || !engineRef.current) {
          pageSource.dispose();
          return;
        }
        sourceDirectionRef.current = pageSource.readingDirection ?? "ltr";
        const configuredDirection = directionRef.current;
        const resolved = configuredDirection === "auto" ? sourceDirectionRef.current : configuredDirection;
        setResolvedDirection(resolved);
        engineRef.current.setReadingDirection(resolved);
        pageCountRef.current = pageSource.pageCount;
        setPageCount(pageSource.pageCount);
        await engineRef.current.setSource(pageSource);
        if (!active) return;
        setPageIndex(engineRef.current.pageIndex);
        setLoading(false);
        callbacks.current.onReady?.({
          pageCount: pageSource.pageCount,
          pageAspect: pageSource.pageAspect,
          readingDirection: resolved,
        });
      })
      .catch((reason: unknown) => {
        if (!active) return;
        const failure = reason instanceof Error ? reason : new Error(String(reason));
        setLoading(false);
        setError(failure.message);
        callbacks.current.onError?.(failure);
      });
    return () => {
      active = false;
    };
  }, [source]);

  const rootStyle = {
    "--flipdocs-background": background,
    ...style,
  } as CSSProperties;

  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const strip = stripRef.current;
    if (!showThumbnails || !strip || pageCount === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const page = Number((entry.target as HTMLElement).dataset.page);
          if (Number.isInteger(page)) requestThumbnail(page);
        }
      },
      { root: strip, rootMargin: "0px 240px" },
    );
    for (const child of strip.children) observer.observe(child);
    return () => observer.disconnect();
  }, [showThumbnails, pageCount, requestThumbnail]);

  useEffect(() => {
    if (!showThumbnails) return;
    stripRef.current
      ?.querySelector(`[data-page="${pageIndex}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [showThumbnails, pageIndex]);

  return (
    <section ref={sectionRef} className={`flipdocs${className ? ` ${className}` : ""}`} style={rootStyle}>
      <div className="flipdocs__stage" ref={hostRef} />
      {showControls && (
        <div className="flipdocs__controls" role="toolbar" aria-label="Flipbook controls">
          {/* Chevrons are spatial: in an RTL book the left arrow advances. */}
          <button
            type="button"
            onClick={() => (resolvedDirection === "rtl" ? engineRef.current?.next() : engineRef.current?.previous())}
            disabled={resolvedDirection === "rtl" ? !canNext : !canPrevious}
            aria-label={resolvedDirection === "rtl" ? "Next page" : "Previous page"}
          >
            <span aria-hidden="true">‹</span>
          </button>
          <span className="flipdocs__page-count" aria-live="polite">
            {pageCount ? `${pageIndex + 1} / ${pageCount}` : "— / —"}
          </span>
          <button
            type="button"
            onClick={() => (resolvedDirection === "rtl" ? engineRef.current?.previous() : engineRef.current?.next())}
            disabled={resolvedDirection === "rtl" ? !canPrevious : !canNext}
            aria-label={resolvedDirection === "rtl" ? "Previous page" : "Next page"}
          >
            <span aria-hidden="true">›</span>
          </button>
          <span className="flipdocs__control-divider" aria-hidden="true" />
          <button
            type="button"
            onClick={() => engineRef.current?.zoomOut()}
            disabled={zoomLevel <= (zoom?.min ?? defaultZoom.min) + 0.001}
            aria-label="Zoom out"
          >
            <span aria-hidden="true">−</span>
          </button>
          <button
            className="flipdocs__zoom-value"
            type="button"
            onClick={() => engineRef.current?.resetZoom()}
            aria-label={`Reset zoom, currently ${Math.round(zoomLevel * 100)} percent`}
            title="Reset zoom"
          >
            {Math.round(zoomLevel * 100)}%
          </button>
          <button
            type="button"
            onClick={() => engineRef.current?.zoomIn()}
            disabled={zoomLevel >= (zoom?.max ?? defaultZoom.max) - 0.001}
            aria-label="Zoom in"
          >
            <span aria-hidden="true">+</span>
          </button>
          {showFullscreen && (
            <>
              <span className="flipdocs__control-divider" aria-hidden="true" />
              <button
                type="button"
                onClick={toggleFullscreen}
                aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              >
                <span aria-hidden="true" className="flipdocs__fullscreen-glyph">
                  {isFullscreen ? "⤡" : "⤢"}
                </span>
              </button>
            </>
          )}
        </div>
      )}
      {showThumbnails && pageCount > 0 && (
        <div
          className="flipdocs__thumbnails"
          ref={stripRef}
          role="listbox"
          aria-label="Page thumbnails"
          dir={resolvedDirection === "rtl" ? "rtl" : undefined}
        >
          {Array.from({ length: pageCount }, (_, index) => (
            <button
              key={index}
              type="button"
              data-page={index}
              role="option"
              aria-selected={index === pageIndex}
              className={`flipdocs__thumbnail${index === pageIndex ? " flipdocs__thumbnail--active" : ""}`}
              onClick={() => engineRef.current?.goToPage(index)}
              aria-label={`Go to page ${index + 1}`}
            >
              {thumbnails[index]
                ? <img src={thumbnails[index]} alt="" draggable={false} />
                : <span>{index + 1}</span>}
            </button>
          ))}
        </div>
      )}
      {loading && (
        <div className="flipdocs__message">
          <span className="flipdocs__spinner" />
          <span>
            Loading pages
            {loadProgress && ` · ${formatBytes(loadProgress.loadedBytes)}${loadProgress.totalBytes ? ` / ${formatBytes(loadProgress.totalBytes)}` : ""}`}
            …
          </span>
        </div>
      )}
      {error && <div className="flipdocs__message flipdocs__message--error">{error}</div>}
    </section>
  );
});
