import {
  AmbientLight,
  CanvasTexture,
  Color,
  DataTexture,
  DirectionalLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PCFShadowMap,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
  WebGLRenderer,
} from "three";
import type {
  FlipBookBodySettings,
  FlipBookCornerSettings,
  FlipBookCurlSettings,
  FlipBookMobileSettings,
  FlipBookRenderSettings,
  FlipBookRiffleSettings,
  FlipBookSoundSettings,
  FlipBookZoomSettings,
  FlipDirection,
  PageLink,
  ReadingDirection,
} from "../types";
import type { PageSource } from "../source/PageSource";
import { PageCurlGeometry, type PageCurlInteraction } from "./PageCurlGeometry";
import { PageTextureCache } from "./PageTextureCache";
import { attachedProgressForPointer } from "./pointerAttachment";
import { createRestingPageGeometry } from "./restingPageGeometry";
import {
  addFoldShading,
  createCurlMaterial,
  lightVector,
  type CurlMaterial,
  type FoldShadingUniforms,
} from "./pageMaterial";
import {
  mobileGestureIntent,
  mobileHeldGestureIntent,
} from "./mobileGesture";
import { pageRasterHeight } from "./rasterSizing";
import { BookBody } from "./bookBody";
import { PageTurnSound } from "./sound";

interface EngineOptions {
  animationDuration: number;
  cacheSize: number;
  preloadRadius: number;
  maxPixelRatio: number;
  maxTextureHeight: number;
  pageColor: string;
  interactive: boolean;
  startPage: number;
  curl: FlipBookCurlSettings;
  corner: FlipBookCornerSettings;
  render: FlipBookRenderSettings;
  zoom: FlipBookZoomSettings;
  mobile: FlipBookMobileSettings;
  body: FlipBookBodySettings;
  riffle: FlipBookRiffleSettings;
  sound: FlipBookSoundSettings;
  links: boolean;
  readingDirection: ReadingDirection;
  onPageChange(pageIndex: number): void;
  onNavigationChange(canPrevious: boolean, canNext: boolean): void;
  onZoomChange(zoom: number): void;
  onError(error: Error): void;
}

interface FlipState {
  direction: FlipDirection;
  front: number;
  back: number;
  underLeft: number | null;
  underRight: number | null;
}

interface PointerLayout {
  rect: DOMRect;
  worldLeft: number;
  worldTop: number;
  worldWidth: number;
  worldHeight: number;
  pageTop: number;
  pagePixelHeight: number;
  pagePixelWidth: number;
  bookLeftX: number;
  bookRightX: number;
  spineX: number;
}

type PageSide = "left" | "right";
type MobileDragAction =
  | "pending"
  | "swipe"
  | "focus-left"
  | "focus-right"
  | "flip-next"
  | "flip-previous";

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Sheet mesh resolution: vertical segments track horizontal at the 72:64 ratio. */
function curlSegmentCounts(segments: number): [number, number] {
  const x = Math.max(36, Math.min(96, Math.round(segments)));
  return [x, Math.max(24, Math.round((x * 64) / 72))];
}

const easeInOut = (value: number) =>
  value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
const easeOut = (value: number) => 1 - Math.pow(1 - value, 3);

/**
 * The resting-spread gutter: pages of an open book darken toward the binding.
 * One shared horizontal gradient, drawn dark at the spine (right edge), with a
 * faint relief highlight just before the falloff so the paper reads as bowed.
 */
function createGutterTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 2;
  const context = canvas.getContext("2d");
  if (context) {
    const shade = context.createLinearGradient(0, 0, canvas.width, 0);
    shade.addColorStop(0, "rgba(0, 0, 0, 0)");
    shade.addColorStop(0.45, "rgba(0, 0, 0, 0.02)");
    shade.addColorStop(0.78, "rgba(0, 0, 0, 0.14)");
    shade.addColorStop(1, "rgba(0, 0, 0, 0.52)");
    context.fillStyle = shade;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const relief = context.createLinearGradient(0, 0, canvas.width, 0);
    relief.addColorStop(0.52, "rgba(255, 255, 255, 0)");
    relief.addColorStop(0.62, "rgba(255, 255, 255, 0.055)");
    relief.addColorStop(0.72, "rgba(255, 255, 255, 0)");
    context.fillStyle = relief;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export class FlipBookEngine {
  readonly canvas: HTMLCanvasElement;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-2, 2, 1.5, -1.5, 0.01, 20);
  private readonly renderer: WebGLRenderer;
  private readonly placeholder: DataTexture;
  private readonly leftMaterial: MeshStandardMaterial;
  private readonly rightMaterial: MeshStandardMaterial;
  private leftMesh: Mesh<PlaneGeometry, MeshStandardMaterial>;
  private rightMesh: Mesh<PlaneGeometry, MeshStandardMaterial>;
  private curlGeometry: PageCurlGeometry;
  private readonly curlMaterial: CurlMaterial;
  private readonly curlMesh: Mesh<PageCurlGeometry, CurlMaterial>;
  private readonly ambientLight: AmbientLight;
  private readonly shadowLight: DirectionalLight;
  private readonly resizeObserver: ResizeObserver;
  private source?: PageSource;
  private cache?: PageTextureCache;
  private pageWidth = 1;
  private pageHeight = 1.4;
  private currentPage = 0;
  private activeSide: PageSide = "right";
  private bookOffset = -0.5;
  private mobileFocusPosition = 1;
  private mobileMode = false;
  private flip?: FlipState;
  private progress = 0;
  private frame = 0;
  private sourceGeneration = 0;
  private animationGeneration = 0;
  private resizeTextureTimer = 0;
  private lastRasterHeight = 0;
  private renderCount = 0;
  private interaction: PageCurlInteraction = { grabX: 1, grabY: 0.78, targetY: 0.52 };
  private curl: FlipBookCurlSettings;
  private corner: FlipBookCornerSettings;
  private renderSettings: FlipBookRenderSettings;
  private zoomSettings: FlipBookZoomSettings;
  private mobileSettings: FlipBookMobileSettings;
  private riffleSettings: FlipBookRiffleSettings;
  private linksEnabled: boolean;
  /**
   * +1 for a left-bound book, -1 for a right-bound (RTL) book. Every spatial
   * mapping multiplies through this; page-index logic never changes.
   */
  private flow: 1 | -1 = 1;
  private zoomLevel = 1;
  private panX = 0;
  private panY = 0;
  private baseFrustum = { left: -2, right: 2, top: 1.5, bottom: -1.5 };
  private readonly body: BookBody;
  private readonly turnSound: PageTurnSound;
  private readonly gutterTexture: CanvasTexture;
  private readonly leftGutter: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly rightGutter: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly leftFoldShading: FoldShadingUniforms;
  private readonly rightFoldShading: FoldShadingUniforms;
  private readonly reducedMotion: boolean;
  private readonly linkMap = new Map<number, PageLink[]>();
  private riffling = false;
  private activeAnimationCancel?: () => void;
  private tapTimer = 0;
  private lastTap?: { time: number; x: number; y: number };
  private pendingLink?: { id: number; x: number; y: number; link: PageLink };
  private panPointer?: { id: number; x: number; y: number; panX: number; panY: number };
  private hoverPreview?: {
    direction: FlipDirection;
    cornerY: 0 | 1;
    leftMap: Texture;
    rightMap: Texture;
    leftVisible: boolean;
    rightVisible: boolean;
  };
  private pointer?: {
    id: number;
    x: number;
    y: number;
    moved: boolean;
    direction: FlipDirection;
    travel: number;
    pageTop: number;
    pagePixelHeight: number;
    pagePixelWidth: number;
    spineX: number;
    spineWorldX: number;
    lastX: number;
    lastTime: number;
    /** Smoothed horizontal pointer speed in pixels per millisecond. */
    velocity: number;
    /** Attached progress at grab time; release thresholds measure from here. */
    initialAttach: number;
  };
  private mobilePointer?: {
    id: number;
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    startedAt: number;
    intentTimer: number;
    moved: boolean;
    action: MobileDragAction;
    progress: number;
    /** Turned amount when the direct drag attached; thresholds measure from here. */
    baseline: number;
    targetY: number;
    startFocus: number;
    pageTop: number;
    pagePixelHeight: number;
    pagePixelWidth: number;
    spineX: number;
    spineWorldX: number;
    centerX: number;
    travel: number;
    grabX: number;
    grabY: number;
  };

  constructor(
    private readonly host: HTMLElement,
    private readonly options: EngineOptions,
  ) {
    this.curl = { ...options.curl };
    this.curlGeometry = new PageCurlGeometry(...curlSegmentCounts(this.curl.segments));
    this.corner = { ...options.corner };
    this.renderSettings = { ...options.render };
    this.zoomSettings = { ...options.zoom };
    this.mobileSettings = { ...options.mobile };
    this.riffleSettings = { ...options.riffle };
    this.linksEnabled = options.links;
    this.flow = options.readingDirection === "rtl" ? -1 : 1;
    this.turnSound = new PageTurnSound(options.sound);
    this.reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.zoomLevel = Math.max(
      this.zoomSettings.min,
      Math.min(this.zoomSettings.max, this.zoomSettings.initial),
    );
    this.camera.zoom = this.zoomLevel;
    this.renderer = new WebGLRenderer({
      alpha: true,
      antialias: window.devicePixelRatio <= 1.5,
      powerPreference: "high-performance",
      stencil: false,
      preserveDrawingBuffer: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, options.maxPixelRatio));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.shadowMap.enabled = this.renderSettings.shadows;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.canvas = this.renderer.domElement;
    this.canvas.className = "flipdocs__canvas";
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "application");
    host.appendChild(this.canvas);

    this.placeholder = new DataTexture(new Uint8Array([248, 247, 243, 255]), 1, 1, RGBAFormat, UnsignedByteType);
    this.placeholder.colorSpace = SRGBColorSpace;
    this.placeholder.needsUpdate = true;
    this.leftMaterial = new MeshStandardMaterial({ map: this.placeholder, roughness: 1, metalness: 0 });
    this.rightMaterial = new MeshStandardMaterial({ map: this.placeholder, roughness: 1, metalness: 0 });
    this.leftFoldShading = addFoldShading(this.leftMaterial);
    this.rightFoldShading = addFoldShading(this.rightMaterial);
    this.leftMesh = new Mesh(
      createRestingPageGeometry(this.pageWidth, this.pageHeight, "left", this.renderSettings.spineBend),
      this.leftMaterial,
    );
    this.rightMesh = new Mesh(
      createRestingPageGeometry(this.pageWidth, this.pageHeight, "right", this.renderSettings.spineBend),
      this.rightMaterial,
    );
    for (const page of [this.leftMesh, this.rightMesh]) {
      page.castShadow = true;
      page.receiveShadow = true;
    }
    this.curlMaterial = createCurlMaterial(
      this.placeholder,
      this.placeholder,
      options.pageColor,
      this.renderSettings,
    );
    this.curlMesh = new Mesh(this.curlGeometry, this.curlMaterial);
    this.curlMesh.castShadow = true;
    this.curlMesh.visible = false;
    this.ambientLight = new AmbientLight(0xffffff, this.renderSettings.ambientLight);
    this.shadowLight = new DirectionalLight(0xffffff, 1);
    this.shadowLight.castShadow = true;
    const initialShadowSize = Math.min(
      this.renderSettings.shadowResolution,
      this.renderer.capabilities.maxTextureSize,
    );
    this.shadowLight.shadow.mapSize.set(initialShadowSize, initialShadowSize);
    // The bowed resting sheets receive the curl shadow directly. Keep the
    // bias tiny so the low-flying contact edge survives without introducing
    // visible acne across the mostly flat page surface.
    this.shadowLight.shadow.bias = -0.0001;
    this.shadowLight.shadow.normalBias = 0.0015;
    this.shadowLight.shadow.camera.near = 0.1;
    this.shadowLight.shadow.camera.far = 20;
    this.body = new BookBody(options.body, options.pageColor);
    this.gutterTexture = createGutterTexture();
    const gutterMaterial = new MeshBasicMaterial({
      map: this.gutterTexture,
      transparent: true,
      depthWrite: false,
      opacity: this.renderSettings.gutterShading * 0.5,
    });
    this.leftGutter = new Mesh(new PlaneGeometry(1, 1), gutterMaterial);
    this.rightGutter = new Mesh(new PlaneGeometry(1, 1), gutterMaterial.clone() as MeshBasicMaterial);
    this.leftGutter.renderOrder = 1;
    this.rightGutter.renderOrder = 1;
    this.rightGutter.scale.x = -1;
    this.scene.background = null;
    this.scene.add(
      this.leftMesh,
      this.rightMesh,
      this.leftGutter,
      this.rightGutter,
      this.curlMesh,
      this.body.group,
      this.ambientLight,
      this.shadowLight,
      this.shadowLight.target,
    );
    this.camera.position.set(0, 0.03, 6);
    this.camera.lookAt(0, 0, 0);
    this.layoutMeshes();
    this.applyLighting();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.bindInput();
  }

  async setSource(source: PageSource): Promise<void> {
    const generation = ++this.sourceGeneration;
    if (this.mobilePointer) {
      window.clearTimeout(this.mobilePointer.intentTimer);
    }
    this.mobilePointer = undefined;
    this.pointer = undefined;
    this.cache?.dispose();
    this.source?.dispose();
    this.source = source;
    this.linkMap.clear();
    this.riffling = false;
    this.pendingLink = undefined;
    this.cache = new PageTextureCache(source, this.renderer, Math.max(4, this.options.cacheSize));
    this.lastRasterHeight = 0;
    this.pageHeight = 2;
    this.pageWidth = this.pageHeight * source.pageAspect;
    const requestedPage = Math.max(
      0,
      Math.min(source.pageCount - 1, Math.floor(this.options.startPage)),
    );
    this.currentPage = this.normalizePage(requestedPage);
    this.activeSide = requestedPage > 0 && requestedPage % 2 === 1 ? "left" : "right";
    this.mobileFocusPosition = this.activeSide === "left" ? 0 : 1;
    this.hoverPreview = undefined;
    this.canvas.classList.remove("flipdocs__canvas--corner");
    this.flip = undefined;
    this.progress = 0;
    this.rebuildMeshes();
    await this.showStablePages(generation);
    if (generation === this.sourceGeneration) this.emitPageState();
  }

  get pageIndex(): number {
    return this.visiblePageIndex();
  }

  /**
   * Rasterize one page as a small JPEG data URL for thumbnail strips. This
   * bypasses the GPU cache entirely and forces the page bytes to load, which
   * is why thumbnails are opt-in for lazy PDF sources.
   */
  async renderThumbnail(index: number, height = 90): Promise<string> {
    const source = this.source;
    if (!source) throw new Error("The flipbook has no loaded source.");
    const page = await source.renderPage(index, height);
    const canvas = document.createElement("canvas");
    canvas.width = page.width;
    canvas.height = page.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("A 2D canvas is required for thumbnails.");
    if (page.image instanceof ImageBitmap) {
      // Sources pre-flip bitmaps for the GPU upload path; undo that here.
      context.translate(0, page.height);
      context.scale(1, -1);
    }
    context.drawImage(page.image as CanvasImageSource, 0, 0);
    page.dispose();
    return canvas.toDataURL("image/jpeg", 0.72);
  }

  next(): void {
    if (!this.source) return;
    if (this.mobileMode && this.currentPage > 0 && this.activeSide === "left") {
      if (this.currentPage + 1 < this.source.pageCount) this.animateMobileFocus(1);
      return;
    }
    if (!this.canFlip("next")) return;
    this.claimHoverPreview("next");
    if (!this.flip) {
      this.interaction = { grabX: 1, grabY: 0, targetY: 0.28 };
      this.prepareFlip("next");
    }
    if (this.flip?.direction === "next") this.animateTo(1);
  }

  previous(): void {
    if (!this.source) return;
    if (this.mobileMode && this.currentPage > 0 && this.activeSide === "right") {
      this.animateMobileFocus(0);
      return;
    }
    if (!this.canFlip("previous")) return;
    this.claimHoverPreview("previous");
    if (!this.flip) {
      this.interaction = { grabX: 1, grabY: 0, targetY: 0.28 };
      this.prepareFlip("previous");
    }
    if (this.flip?.direction === "previous") this.animateTo(0);
  }

  goToPage(index: number): void {
    if (!this.source) return;
    const requestedPage = Math.max(0, Math.min(this.source.pageCount - 1, Math.floor(index)));
    const target = this.normalizePage(requestedPage);
    if (
      this.riffleSettings.enabled &&
      !this.mobileMode &&
      !this.reducedMotion &&
      !this.riffling &&
      !this.pointer &&
      !this.mobilePointer &&
      target !== this.currentPage
    ) {
      this.abandonHoverPreview();
      if (!this.flip) {
        void this.riffleTo(target, requestedPage);
        return;
      }
    }
    this.jumpToPage(requestedPage);
  }

  private jumpToPage(requestedPage: number): void {
    this.abandonHoverPreview();
    this.cancelAnimation();
    this.flip = undefined;
    this.curlMesh.visible = false;
    this.currentPage = this.normalizePage(requestedPage);
    this.activeSide = requestedPage > 0 && requestedPage % 2 === 1 ? "left" : "right";
    this.mobileFocusPosition = this.activeSide === "left" ? 0 : 1;
    void this.showStablePages(this.sourceGeneration);
    this.emitPageState();
  }

  /** Fan up to `maxSheets` quick turns instead of teleporting on long jumps. */
  private async riffleTo(target: number, requestedPage: number): Promise<void> {
    if (!this.source) return;
    const sourceGeneration = this.sourceGeneration;
    const direction: FlipDirection = target > this.currentPage ? "next" : "previous";
    const spreads = Math.max(1, Math.ceil(Math.abs(target - this.currentPage) / 2));
    const sheets = Math.min(this.riffleSettings.maxSheets, spreads);
    this.riffling = true;
    try {
      for (let sheet = 0; sheet < sheets; sheet += 1) {
        if (this.sourceGeneration !== sourceGeneration || this.flip) return;
        const last = sheet === sheets - 1;
        if (last) {
          // Pre-position so completing this sheet lands exactly on the target.
          this.currentPage = direction === "next"
            ? (target <= 1 ? 0 : target - 2)
            : (target === 0 ? 1 : target + 2);
          this.activeSide = direction === "next" ? "right" : "left";
        }
        if (!this.canFlip(direction)) break;
        this.interaction = { grabX: 1, grabY: 0.1, targetY: 0.34 };
        this.prepareFlip(direction);
        if (!this.flip) break;
        const settled = await new Promise<boolean>((resolve) => {
          this.animateTo(direction === "next" ? 1 : 0, {
            durationScale: last ? 0.6 : 0.34,
            settle: last,
            onSettled: () => resolve(true),
            onCancelled: () => resolve(false),
          });
        });
        if (!settled) return;
      }
    } finally {
      this.riffling = false;
    }
    if (this.sourceGeneration === sourceGeneration && !this.flip && this.currentPage !== target) {
      this.jumpToPage(requestedPage);
    }
  }

  setFlipProgress(progress: number, direction: FlipDirection = "next"): void {
    if (!this.source || !this.canFlip(direction)) return;
    this.claimHoverPreview(direction);
    this.cancelAnimation();
    if (!this.flip || this.flip.direction !== direction) {
      this.interaction = { grabX: 1, grabY: 0.78, targetY: 0.5 };
      this.prepareFlip(direction);
    }
    this.setProgress(clamp01(progress));
  }

  completeFlip(): void {
    if (!this.flip) return;
    this.claimHoverPreview(this.flip.direction);
    this.animateTo(this.flip.direction === "next" ? 1 : 0);
  }

  setCurlSettings(settings: Partial<FlipBookCurlSettings>): void {
    this.curl = {
      radius: Math.max(0.015, Math.min(0.3, settings.radius ?? this.curl.radius)),
      radiusLimit: Math.max(0.25, Math.min(0.98, settings.radiusLimit ?? this.curl.radiusLimit)),
      verticalPull: clamp01(settings.verticalPull ?? this.curl.verticalPull),
      binding: Math.max(0.02, Math.min(0.35, settings.binding ?? this.curl.binding)),
      dragResistance: Math.max(0.4, Math.min(2.5, settings.dragResistance ?? this.curl.dragResistance)),
      snapThreshold: Math.max(0.05, Math.min(0.75, settings.snapThreshold ?? this.curl.snapThreshold)),
      velocityFling: settings.velocityFling ?? this.curl.velocityFling,
      settleWobble: clamp01(settings.settleWobble ?? this.curl.settleWobble),
      coverStiffness: clamp01(settings.coverStiffness ?? this.curl.coverStiffness),
      segments: Math.max(36, Math.min(96, Math.round(settings.segments ?? this.curl.segments))),
    };
    this.applyCurlSegments();
    if (this.flip) this.setProgress(this.progress);
  }

  /** Swaps in a sheet mesh at the configured resolution when it changes. */
  private applyCurlSegments(): void {
    const [xSegments] = curlSegmentCounts(this.curl.segments);
    if (this.curlGeometry.segmentCountX === xSegments) return;
    const replacement = new PageCurlGeometry(...curlSegmentCounts(this.curl.segments));
    this.curlGeometry.dispose();
    this.curlGeometry = replacement;
    this.curlMesh.geometry = replacement;
    const previousTurn = this.flip?.direction === "previous";
    this.curlGeometry.update(
      this.pageWidth,
      this.pageHeight,
      this.flip ? (previousTurn ? 1 - this.progress : this.progress) : 0,
      this.interaction,
      this.effectiveCurl(),
      previousTurn !== (this.flow === -1),
      this.renderSettings.spineBend,
    );
    this.render();
  }

  setBodySettings(settings: Partial<FlipBookBodySettings>): void {
    this.body.setSettings({
      enabled: settings.enabled ?? this.options.body.enabled,
      thickness: Math.max(0.01, Math.min(0.14, settings.thickness ?? this.options.body.thickness)),
      coverColor: settings.coverColor ?? this.options.body.coverColor,
      overhang: Math.max(0, Math.min(0.05, settings.overhang ?? this.options.body.overhang)),
    });
    this.updateBodyState();
    this.render();
  }

  setRiffleSettings(settings: Partial<FlipBookRiffleSettings>): void {
    this.riffleSettings = {
      enabled: settings.enabled ?? this.riffleSettings.enabled,
      maxSheets: Math.max(1, Math.min(6, Math.round(settings.maxSheets ?? this.riffleSettings.maxSheets))),
    };
  }

  setSoundSettings(settings: Partial<FlipBookSoundSettings>): void {
    this.turnSound.setSettings({
      enabled: settings.enabled ?? this.options.sound.enabled,
      src: settings.src ?? this.options.sound.src,
      volume: clamp01(settings.volume ?? this.options.sound.volume),
    });
  }

  setLinksEnabled(enabled: boolean): void {
    this.linksEnabled = enabled;
    if (!enabled) this.linkMap.clear();
    else void this.loadVisibleLinks();
  }

  setReadingDirection(direction: ReadingDirection): void {
    const flow = direction === "rtl" ? -1 : 1;
    this.canvas.dataset.readingDirection = direction;
    if (flow === this.flow) return;
    this.flow = flow;
    this.abandonHoverPreview();
    this.cancelAnimation();
    this.flip = undefined;
    this.curlMesh.visible = false;
    this.rebuildRestingPageGeometry();
    this.updateBodyState();
    this.positionBook(this.restingBookOffset());
    if (this.source) void this.showStablePages(this.sourceGeneration);
    this.render();
  }

  setCornerSettings(settings: Partial<FlipBookCornerSettings>): void {
    this.corner = {
      enabled: settings.enabled ?? this.corner.enabled,
      size: Math.max(0.06, Math.min(0.35, settings.size ?? this.corner.size)),
      lift: Math.max(0.015, Math.min(0.22, settings.lift ?? this.corner.lift)),
      pull: Math.max(0, Math.min(0.35, settings.pull ?? this.corner.pull)),
    };
    if (!this.corner.enabled) this.abandonHoverPreview();
    else if (this.hoverPreview) this.showCornerPreview(
      this.hoverPreview.direction,
      this.hoverPreview.cornerY,
    );
  }

  setZoomSettings(settings: Partial<FlipBookZoomSettings>): void {
    const previousInitial = this.zoomSettings.initial;
    const minimum = Math.max(0.25, Math.min(2, settings.min ?? this.zoomSettings.min));
    const maximum = Math.max(minimum, Math.min(8, settings.max ?? this.zoomSettings.max));
    this.zoomSettings = {
      initial: Math.max(minimum, Math.min(maximum, settings.initial ?? this.zoomSettings.initial)),
      min: minimum,
      max: maximum,
      step: Math.max(0.05, Math.min(1, settings.step ?? this.zoomSettings.step)),
      wheel: settings.wheel ?? this.zoomSettings.wheel,
      toPointer: settings.toPointer ?? this.zoomSettings.toPointer,
      pan: settings.pan ?? this.zoomSettings.pan,
    };
    const initialChanged =
      settings.initial !== undefined &&
      Math.abs(this.zoomSettings.initial - previousInitial) > 0.0001;
    this.setZoom(initialChanged ? this.zoomSettings.initial : this.zoomLevel);
  }

  setMobileSettings(settings: Partial<FlipBookMobileSettings>): void {
    this.mobileSettings = {
      enabled: settings.enabled ?? this.mobileSettings.enabled,
      breakpoint: Math.max(
        320,
        Math.min(1800, settings.breakpoint ?? this.mobileSettings.breakpoint),
      ),
      pagePeek: Math.max(0.02, Math.min(0.24, settings.pagePeek ?? this.mobileSettings.pagePeek)),
      doubleTapZoom: settings.doubleTapZoom ?? this.mobileSettings.doubleTapZoom,
    };
    this.resize();
  }

  zoomIn(): void {
    this.setZoom(this.zoomLevel + this.zoomSettings.step);
  }

  zoomOut(): void {
    this.setZoom(this.zoomLevel - this.zoomSettings.step);
  }

  resetZoom(): void {
    this.setZoom(this.zoomSettings.initial);
  }

  setZoom(value: number, focus?: { clientX: number; clientY: number }): void {
    if (!Number.isFinite(value)) return;
    const next = Math.max(this.zoomSettings.min, Math.min(this.zoomSettings.max, value));
    if (Math.abs(next - this.zoomLevel) < 0.0001) return;

    if (focus && this.zoomSettings.toPointer) {
      // Keep the world point under the pointer stationary through the zoom.
      const rect = this.canvas.getBoundingClientRect();
      const baseWidth = this.baseFrustum.right - this.baseFrustum.left;
      const baseHeight = this.baseFrustum.top - this.baseFrustum.bottom;
      const fractionX = clamp01((focus.clientX - rect.left) / Math.max(1, rect.width));
      const fractionY = clamp01((focus.clientY - rect.top) / Math.max(1, rect.height));
      const worldX = this.panX - baseWidth / (2 * this.zoomLevel) + fractionX * (baseWidth / this.zoomLevel);
      const worldY = this.panY + baseHeight / (2 * this.zoomLevel) - fractionY * (baseHeight / this.zoomLevel);
      this.panX = worldX + baseWidth / (2 * next) - fractionX * (baseWidth / next);
      this.panY = worldY - baseHeight / (2 * next) + fractionY * (baseHeight / next);
    }

    this.zoomLevel = next;
    this.camera.zoom = next;
    this.applyFrustum();
    this.scheduleSharperTextures();
    this.options.onZoomChange(next);
  }

  /** Re-apply the stored frustum with the current pan, clamped to the page area. */
  private applyFrustum(): void {
    const baseWidth = this.baseFrustum.right - this.baseFrustum.left;
    const baseHeight = this.baseFrustum.top - this.baseFrustum.bottom;
    const boundX = Math.max(0, (baseWidth - baseWidth / this.zoomLevel) / 2);
    const boundY = Math.max(0, (baseHeight - baseHeight / this.zoomLevel) / 2);
    this.panX = Math.max(-boundX, Math.min(boundX, this.zoomLevel <= 1.001 ? 0 : this.panX));
    this.panY = Math.max(-boundY, Math.min(boundY, this.zoomLevel <= 1.001 ? 0 : this.panY));
    this.camera.left = this.baseFrustum.left + this.panX;
    this.camera.right = this.baseFrustum.right + this.panX;
    this.camera.top = this.baseFrustum.top + this.panY;
    this.camera.bottom = this.baseFrustum.bottom + this.panY;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  setRenderSettings(settings: Partial<FlipBookRenderSettings>): void {
    const previousResolution = this.renderSettings.resolutionScale;
    const previousSpineBend = this.renderSettings.spineBend;
    this.renderSettings = {
      resolutionScale: Math.max(0.75, Math.min(3, settings.resolutionScale ?? this.renderSettings.resolutionScale)),
      ambientLight: Math.max(0.2, Math.min(1.2, settings.ambientLight ?? this.renderSettings.ambientLight)),
      directionalLight: Math.max(0, Math.min(1, settings.directionalLight ?? this.renderSettings.directionalLight)),
      foldContrast: Math.max(0, Math.min(0.65, settings.foldContrast ?? this.renderSettings.foldContrast)),
      lightAngle: Math.max(-180, Math.min(180, settings.lightAngle ?? this.renderSettings.lightAngle)),
      lightElevation: Math.max(0.1, Math.min(1, settings.lightElevation ?? this.renderSettings.lightElevation)),
      shadows: settings.shadows ?? this.renderSettings.shadows,
      shadowOpacity: Math.max(0, Math.min(0.7, settings.shadowOpacity ?? this.renderSettings.shadowOpacity)),
      shadowSoftness: Math.max(0.25, Math.min(8, settings.shadowSoftness ?? this.renderSettings.shadowSoftness)),
      shadowResolution: Math.max(
        256,
        Math.min(
          this.renderer.capabilities.maxTextureSize,
          Math.round(settings.shadowResolution ?? this.renderSettings.shadowResolution),
        ),
      ),
      sheen: clamp01(settings.sheen ?? this.renderSettings.sheen),
      spineBend: Math.max(0, Math.min(0.08, settings.spineBend ?? this.renderSettings.spineBend)),
      gutterShading: clamp01(settings.gutterShading ?? this.renderSettings.gutterShading),
    };
    if (Math.abs(previousSpineBend - this.renderSettings.spineBend) > 0.0001) {
      this.rebuildRestingPageGeometry();
    }
    this.applyLighting();

    if (
      this.source &&
      Math.abs(previousResolution - this.renderSettings.resolutionScale) > 0.001
    ) {
      const generation = ++this.sourceGeneration;
      this.lastRasterHeight = 0;
      // Keep the existing GPU maps visible while sharper replacements render.
      // Recreating the cache here disposed the sheet being tuned mid-flip and
      // could expose a black page until PDF.js finished the new raster.
      if (this.flip) void this.loadFlipTextures(this.flip, generation);
      else void this.showStablePages(generation);
      return;
    }
    if (this.flip) this.setProgress(this.progress);
    else this.render();
  }

  private applyLighting(): void {
    const light = lightVector(this.renderSettings);
    this.curlMaterial.uniforms.ambientLight.value = this.renderSettings.ambientLight;
    this.curlMaterial.uniforms.directionalLight.value = this.renderSettings.directionalLight;
    this.curlMaterial.uniforms.foldContrast.value = this.renderSettings.foldContrast;
    this.curlMaterial.uniforms.lightDirection.value.copy(light);
    this.curlMaterial.uniforms.sheen.value = this.renderSettings.sheen;
    this.leftGutter.material.opacity = this.renderSettings.gutterShading * 0.5;
    this.rightGutter.material.opacity = this.renderSettings.gutterShading * 0.5;
    this.updateGutterVisibility();

    // MeshStandardMaterial applies the Lambert 1/PI term. Scale scene lights
    // by PI so a flat resting page retains the source texture's brightness;
    // the public controls continue to use intuitive 0..1 contributions.
    this.ambientLight.intensity = this.renderSettings.ambientLight * Math.PI;
    this.shadowLight.intensity = this.renderSettings.directionalLight * Math.PI;
    this.updateShadowLightPosition(light);
    this.shadowLight.visible = this.renderSettings.shadows || this.renderSettings.directionalLight > 0.001;
    this.shadowLight.castShadow = this.renderSettings.shadows;
    this.shadowLight.shadow.radius = this.renderSettings.shadowSoftness;
    const shadowExtent = Math.hypot(this.pageWidth, this.pageHeight * 0.5) * 1.22;
    const shadowCamera = this.shadowLight.shadow.camera;
    shadowCamera.left = -shadowExtent;
    shadowCamera.right = shadowExtent;
    shadowCamera.top = shadowExtent;
    shadowCamera.bottom = -shadowExtent;
    shadowCamera.updateProjectionMatrix();
    const shadowSize = this.renderSettings.shadowResolution;
    if (
      this.shadowLight.shadow.mapSize.x !== shadowSize ||
      this.shadowLight.shadow.mapSize.y !== shadowSize
    ) {
      this.shadowLight.shadow.map?.dispose();
      this.shadowLight.shadow.map = null;
      this.shadowLight.shadow.mapSize.set(shadowSize, shadowSize);
    }
    this.renderer.shadowMap.enabled = this.renderSettings.shadows;
    this.renderer.shadowMap.needsUpdate = true;
    this.updateShadowOpacity();
  }

  private updateShadowOpacity(): void {
    const envelope = Math.sqrt(Math.max(0, Math.sin(Math.PI * this.progress)));
    this.shadowLight.shadow.intensity = this.renderSettings.shadowOpacity * envelope;
  }

  /**
   * Keep the cast shadow under the half of the spread occupied by the moving
   * sheet. A fixed world-space light throws a right-page curl across the
   * spine whenever the light happens to sit on the page's outside. Mirroring
   * the horizontal light component from the live deformed geometry makes the
   * light come from the spine side and sends the shadow back beneath the
   * paper. The Y slant and elevation remain controlled by the public light
   * settings.
   */
  private updateShadowLightPosition(light = lightVector(this.renderSettings)): void {
    const lightDistance = Math.max(6, this.pageWidth * 3.5);
    let shadowX = light.x;
    if (this.flip && this.curlMesh.visible) {
      const positions = this.curlGeometry.getAttribute("position");
      const transitionWidth = Math.max(0.0001, this.pageWidth * 0.18);
      let sideBalance = 0;
      let samples = 0;
      // The geometry already contains thousands of vertices. A uniform set
      // of roughly 160 samples follows the sheet centroid closely without
      // adding another full-mesh walk to every pointer frame.
      const stride = Math.max(1, Math.floor(positions.count / 160));
      for (let index = 0; index < positions.count; index += stride) {
        sideBalance += Math.max(-1, Math.min(1, positions.getX(index) / transitionWidth));
        samples += 1;
      }
      sideBalance /= Math.max(1, samples);
      const horizontal = Math.hypot(light.x, light.y);
      const horizontalX = Math.max(Math.abs(light.x), horizontal * 0.35);
      shadowX = -sideBalance * horizontalX;
    }
    const shadowDirection = this.shadowLight.position.set(shadowX, light.y, light.z).normalize();
    this.shadowLight.position.set(
      this.bookOffset + shadowDirection.x * lightDistance,
      shadowDirection.y * lightDistance,
      shadowDirection.z * lightDistance,
    );
  }

  private visiblePageIndex(): number {
    if (!this.mobileMode || this.currentPage === 0 || !this.source) return this.currentPage;
    return this.activeSide === "left"
      ? this.currentPage
      : Math.min(this.currentPage + 1, this.source.pageCount - 1);
  }

  private canNavigateNext(): boolean {
    if (!this.source) return false;
    if (!this.mobileMode) return this.canFlip("next");
    if (this.currentPage > 0 && this.activeSide === "left") {
      return this.currentPage + 1 < this.source.pageCount;
    }
    return this.canFlip("next");
  }

  private canNavigatePrevious(): boolean {
    if (!this.source) return false;
    if (!this.mobileMode) return this.canFlip("previous");
    if (this.currentPage > 0 && this.activeSide === "right") return true;
    return this.canFlip("previous");
  }

  private emitPageState(): void {
    const visiblePage = this.visiblePageIndex();
    this.canvas.dataset.activePage = String(visiblePage);
    this.updateBodyState();
    void this.loadVisibleLinks();
    this.options.onPageChange(visiblePage);
    this.options.onNavigationChange(this.canNavigatePrevious(), this.canNavigateNext());
  }

  private mobileFocusOffset(position: number): number {
    const center = this.pageWidth * (1 - this.mobileSettings.pagePeek) * 0.5;
    return this.flow * center * (1 - 2 * clamp01(position));
  }

  private coverOffset(): number {
    return -this.flow * this.pageWidth * 0.5;
  }

  private restingBookOffset(): number {
    if (this.currentPage === 0) return this.coverOffset();
    if (!this.mobileMode) return 0;
    return this.mobileFocusOffset(this.mobileFocusPosition);
  }

  private flippingBookOffset(): number {
    return this.flippingBookOffsetAt(this.progress);
  }

  private flippingBookOffsetAt(progress: number): number {
    if (!this.flip) return this.restingBookOffset();
    const resolvedProgress = clamp01(progress);
    if (!this.mobileMode) {
      const isCoverTransition =
        (this.flip.direction === "next" && this.currentPage === 0) ||
        (this.flip.direction === "previous" && this.currentPage === 1);
      return isCoverTransition ? this.coverOffset() * (1 - resolvedProgress) : 0;
    }

    const completion = this.flip.direction === "next" ? resolvedProgress : 1 - resolvedProgress;
    const from = this.currentPage === 0
      ? this.coverOffset()
      : this.mobileFocusOffset(this.activeSide === "left" ? 0 : 1);
    const to = this.flip.direction === "next"
      ? this.mobileFocusOffset(0)
      : this.currentPage === 1
        ? this.coverOffset()
        : this.mobileFocusOffset(1);
    return from + (to - from) * completion;
  }

  private normalizePage(index: number): number {
    if (!this.source) return 0;
    const clamped = Math.max(0, Math.min(this.source.pageCount - 1, Math.floor(index)));
    return clamped === 0 ? 0 : clamped % 2 === 0 ? clamped - 1 : clamped;
  }

  private canFlip(direction: FlipDirection): boolean {
    if (!this.source) return false;
    if (direction === "previous") return this.currentPage > 0;
    const rightPage = this.currentPage === 0 ? 0 : this.currentPage + 1;
    return rightPage + 1 < this.source.pageCount;
  }

  private prepareFlip(direction: FlipDirection): void {
    if (!this.source || !this.canFlip(direction)) return;
    this.cancelAnimation();
    if (direction === "next") {
      const front = this.currentPage === 0 ? 0 : this.currentPage + 1;
      this.flip = {
        direction,
        front,
        back: front + 1,
        underLeft: this.currentPage === 0 ? null : this.currentPage,
        underRight: front + 2 < this.source.pageCount ? front + 2 : null,
      };
      this.progress = 0;
    } else {
      this.flip = {
        direction,
        front: this.currentPage - 1,
        back: this.currentPage,
        underLeft: this.currentPage === 1 ? null : this.currentPage - 2,
        underRight: this.currentPage + 1 < this.source.pageCount ? this.currentPage + 1 : null,
      };
      this.progress = 1;
    }
    this.cache?.setPinned([
      this.flip.front,
      this.flip.back,
      ...(this.flip.underLeft === null ? [] : [this.flip.underLeft]),
      ...(this.flip.underRight === null ? [] : [this.flip.underRight]),
    ]);
    this.primeFlipTextures(this.flip);
    this.curlMesh.visible = true;
    this.setProgress(this.progress);
    void this.loadFlipTextures(this.flip, this.sourceGeneration);
  }

  private primeFlipTextures(flip: FlipState): void {
    const cached = (index: number | null) =>
      index === null ? undefined : this.cache?.peek(index);
    this.curlMaterial.uniforms.frontMap.value = cached(flip.front) ?? this.placeholder;
    this.curlMaterial.uniforms.backMap.value = cached(flip.back) ?? this.placeholder;
    this.setStaticMap(
      this.leftMesh,
      this.leftMaterial,
      cached(flip.underLeft) ?? this.placeholder,
      flip.underLeft !== null,
    );
    this.setStaticMap(
      this.rightMesh,
      this.rightMaterial,
      cached(flip.underRight) ?? this.placeholder,
      flip.underRight !== null,
    );
  }

  private async loadFlipTextures(flip: FlipState, generation: number): Promise<void> {
    if (!this.cache) return;
    try {
      const target = this.textureHeight();
      this.lastRasterHeight = Math.max(this.lastRasterHeight, target);
      const apply = async (index: number, install: (texture: Texture) => void) => {
        const texture = await this.cache!.get(index, target);
        if (generation !== this.sourceGeneration || this.flip !== flip) return;
        install(texture);
        this.render();
      };
      const requests = [
        apply(flip.front, (texture) => { this.curlMaterial.uniforms.frontMap.value = texture; }),
        apply(flip.back, (texture) => { this.curlMaterial.uniforms.backMap.value = texture; }),
      ];
      if (flip.underLeft !== null) {
        requests.push(apply(flip.underLeft, (texture) => {
          this.setStaticMap(this.leftMesh, this.leftMaterial, texture, true);
        }));
      }
      if (flip.underRight !== null) {
        requests.push(apply(flip.underRight, (texture) => {
          this.setStaticMap(this.rightMesh, this.rightMaterial, texture, true);
        }));
      }
      await Promise.all(requests);
      if (generation !== this.sourceGeneration || this.flip !== flip) return;
      this.prefetchAround(Math.min(flip.back + 1, (this.source?.pageCount ?? 1) - 1));
    } catch (error) {
      if (generation !== this.sourceGeneration || this.flip !== flip) return;
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private setProgress(value: number): void {
    this.progress = clamp01(value);
    this.updateShadowOpacity();
    const previousTurn = this.flip?.direction === "previous";
    this.curlGeometry.update(
      this.pageWidth,
      this.pageHeight,
      previousTurn ? 1 - this.progress : this.progress,
      this.interaction,
      this.effectiveCurl(),
      // A forward turn in an RTL book is the mirror image of an LTR one.
      previousTurn !== (this.flow === -1),
      this.renderSettings.spineBend,
    );
    this.positionBook(this.flippingBookOffset());
    this.updateShadowLightPosition();
    this.updateFoldShading(previousTurn ? 1 - this.progress : this.progress);
    this.render();
  }

  /**
   * Drives the fold-adjacent occlusion band on the resting pages. The band
   * lives on the origin side of the fold — the page the sheet is leaving —
   * where the cast shadow cannot reach because nothing hangs above it.
   */
  private updateFoldShading(rawProgress: number): void {
    const fold = this.curlGeometry.fold;
    const visible =
      this.renderSettings.shadows && this.curlMesh.visible && Boolean(this.flip) && fold.active;
    const strength = visible
      ? this.renderSettings.shadowOpacity * 1.35 * Math.pow(Math.sin(Math.PI * rawProgress), 0.5)
      : 0;
    const band = Math.max(0.22, fold.radius * 4.5);
    for (const shading of [this.leftFoldShading, this.rightFoldShading]) {
      shading.uFoldStrength.value = strength;
      if (!visible) continue;
      shading.uFoldPoint.value.set(this.bookOffset + fold.axisX, fold.axisY);
      shading.uFoldNormal.value.set(fold.normalX, fold.normalY);
      shading.uFoldBand.value = band;
    }
  }

  /** Cover stock bends wider and tracks the pointer less than interior paper. */
  private effectiveCurl(): FlipBookCurlSettings {
    const stiffness = this.curl.coverStiffness;
    if (stiffness <= 0.001 || this.flip?.front !== 0) return this.curl;
    return {
      ...this.curl,
      radius: Math.min(0.3, this.curl.radius * (1 + 1.6 * stiffness)),
      radiusLimit: Math.min(0.98, this.curl.radiusLimit * (1 + 0.35 * stiffness)),
      verticalPull: this.curl.verticalPull * (1 - 0.7 * stiffness),
      binding: Math.min(0.35, this.curl.binding * (1 + 0.8 * stiffness)),
    };
  }

  private animateTo(
    target: number,
    options: {
      /** Release speed in progress units per millisecond, for velocity flings. */
      initialSpeed?: number;
      durationScale?: number;
      /** Allows suppressing the settle wobble, e.g. for riffled sheets. */
      settle?: boolean;
      onSettled?: () => void;
      /** Fired when a newer animation or source supersedes this one. */
      onCancelled?: () => void;
    } = {},
  ): void {
    if (!this.flip) return;
    const flip = this.flip;
    const from = this.progress;
    const distance = Math.abs(target - from);
    if (distance < 0.001) {
      this.finishAnimation(flip, target);
      options.onSettled?.();
      return;
    }
    let resolved = false;
    const settleOnce = () => {
      if (resolved) return;
      resolved = true;
      if (this.activeAnimationCancel === cancelOnce) this.activeAnimationCancel = undefined;
      options.onSettled?.();
    };
    const cancelOnce = () => {
      if (resolved) return;
      resolved = true;
      if (this.activeAnimationCancel === cancelOnce) this.activeAnimationCancel = undefined;
      options.onCancelled?.();
    };
    this.activeAnimationCancel = cancelOnce;
    const generation = ++this.animationGeneration;
    const startedAt = performance.now();
    let previousFrameAt = startedAt;
    let frameCount = 0;
    let maximumFrameGap = 0;
    const baseDuration = Math.max(140, this.options.animationDuration * distance);
    const flung = options.initialSpeed !== undefined && options.initialSpeed > 0.0001;
    const duration = (flung
      ? Math.max(110, Math.min(baseDuration, distance / (options.initialSpeed ?? 1)))
      : baseDuration) * (options.durationScale ?? 1);
    const ease = flung ? easeOut : easeInOut;
    const completed = flip.direction === "next" ? target === 1 : target === 0;
    if (completed && distance > 0.15) this.turnSound.play(duration);
    const settleWobble =
      (options.settle ?? true) && completed && !this.reducedMotion && !this.mobileMode
        ? this.curl.settleWobble
        : 0;

    const finish = (now: number) => {
      this.canvas.dataset.animationFrames = String(frameCount);
      this.canvas.dataset.animationDuration = (now - startedAt).toFixed(1);
      this.canvas.dataset.animationMaxFrameGap = maximumFrameGap.toFixed(1);
      this.finishAnimation(flip, target);
      settleOnce();
    };

    // The landing flutter: one damped bounce of the free edge back off the
    // spread, scaled by release speed so hard flicks land more audibly.
    const runWobble = (wobbleStart: number) => {
      const amplitude =
        settleWobble * 0.028 * (1 + Math.min(1.6, (options.initialSpeed ?? 0) * 220));
      const wobbleDuration = 230;
      const wobbleTick = (now: number) => {
        if (generation !== this.animationGeneration || this.flip !== flip) {
          cancelOnce();
          return;
        }
        const at = clamp01((now - wobbleStart) / wobbleDuration);
        const lift = amplitude * Math.sin(Math.PI * 2 * at) * Math.pow(1 - at, 1.5);
        this.setProgress(target === 1 ? 1 - Math.max(0, lift) : Math.max(0, lift));
        if (at < 1) this.frame = requestAnimationFrame(wobbleTick);
        else finish(now);
      };
      this.frame = requestAnimationFrame(wobbleTick);
    };

    const tick = (now: number) => {
      if (generation !== this.animationGeneration || this.flip !== flip) {
        cancelOnce();
        return;
      }
      frameCount += 1;
      maximumFrameGap = Math.max(maximumFrameGap, now - previousFrameAt);
      previousFrameAt = now;
      const elapsed = clamp01((now - startedAt) / duration);
      this.setProgress(from + (target - from) * ease(elapsed));
      if (elapsed < 1) this.frame = requestAnimationFrame(tick);
      else if (settleWobble > 0.001) runWobble(now);
      else finish(now);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private setMobileFocusPosition(value: number): void {
    this.mobileFocusPosition = clamp01(value);
    this.positionBook(this.restingBookOffset());
    this.render();
  }

  private animateMobileFocus(target: 0 | 1): void {
    if (!this.mobileMode || !this.source || this.flip) return;
    this.cancelAnimation();
    const from = this.mobileFocusPosition;
    const distance = Math.abs(target - from);
    const complete = () => {
      this.frame = 0;
      this.setMobileFocusPosition(target);
      const nextSide: PageSide = target === 0 ? "left" : "right";
      const changed = nextSide !== this.activeSide;
      this.activeSide = nextSide;
      if (changed) this.emitPageState();
      else this.options.onNavigationChange(this.canNavigatePrevious(), this.canNavigateNext());
      this.scheduleSharperTextures();
    };
    if (distance < 0.001) {
      complete();
      return;
    }
    const generation = ++this.animationGeneration;
    const startedAt = performance.now();
    const duration = Math.max(120, this.options.animationDuration * 0.28 * distance);
    const tick = (now: number) => {
      if (generation !== this.animationGeneration || this.flip) return;
      const elapsed = clamp01((now - startedAt) / duration);
      this.setMobileFocusPosition(from + (target - from) * easeInOut(elapsed));
      if (elapsed < 1) this.frame = requestAnimationFrame(tick);
      else complete();
    };
    this.frame = requestAnimationFrame(tick);
  }

  private finishAnimation(flip: FlipState, target: number): void {
    const completed = flip.direction === "next" ? target === 1 : target === 0;
    if (completed) {
      this.currentPage = flip.direction === "next"
        ? this.currentPage === 0 ? 1 : this.currentPage + 2
        : this.currentPage === 1 ? 0 : this.currentPage - 2;
      this.activeSide = flip.direction === "next" ? "left" : "right";
      this.mobileFocusPosition = this.activeSide === "left" ? 0 : 1;
    }
    this.hoverPreview = undefined;
    this.canvas.classList.remove("flipdocs__canvas--corner");
    this.flip = undefined;
    this.interaction = { grabX: 1, grabY: 0.78, targetY: 0.52 };
    this.curlMesh.visible = false;
    void this.showStablePages(this.sourceGeneration);
    if (completed) this.emitPageState();
  }

  private async showStablePages(generation: number): Promise<void> {
    if (!this.source || !this.cache) return;
    const left = this.currentPage === 0 ? null : this.currentPage;
    const right = this.currentPage === 0 ? 0 : this.currentPage + 1 < this.source.pageCount ? this.currentPage + 1 : null;
    this.cache.setPinned([
      ...(left === null ? [] : [left]),
      ...(right === null ? [] : [right]),
    ]);
    this.curlMesh.visible = false;
    this.updateFoldShading(0);
    this.positionBook(this.restingBookOffset());
    // Keep the best GPU-ready texture visible while a larger raster replaces
    // it. A genuinely uncached page still appears as paper, never as a hole.
    this.setStaticMap(
      this.leftMesh,
      this.leftMaterial,
      (left === null ? undefined : this.cache.peek(left)) ?? this.placeholder,
      left !== null,
    );
    this.setStaticMap(
      this.rightMesh,
      this.rightMaterial,
      (right === null ? undefined : this.cache.peek(right)) ?? this.placeholder,
      right !== null,
    );
    this.render();

    try {
      const target = this.textureHeight();
      this.lastRasterHeight = Math.max(this.lastRasterHeight, target);
      const install = async (
        index: number | null,
        mesh: Mesh<PlaneGeometry, MeshStandardMaterial>,
        material: MeshStandardMaterial,
      ) => {
        if (index === null) return;
        const texture = await this.cache!.get(index, target);
        if (generation !== this.sourceGeneration || this.flip) return;
        this.setStaticMap(mesh, material, texture, true);
        this.render();
      };
      await Promise.all([
        install(left, this.leftMesh, this.leftMaterial),
        install(right, this.rightMesh, this.rightMaterial),
      ]);
      if (generation !== this.sourceGeneration || this.flip) return;
      this.prefetchAround(right ?? left ?? 0);
    } catch (error) {
      if (generation !== this.sourceGeneration || this.flip) return;
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private setStaticMap(
    mesh: Mesh<PlaneGeometry, MeshStandardMaterial>,
    material: MeshStandardMaterial,
    texture: Texture,
    visible: boolean,
  ): void {
    material.map = texture;
    material.needsUpdate = true;
    mesh.visible = visible;
  }

  private prefetchAround(center: number): void {
    if (!this.cache || !this.source) return;
    const indices: number[] = [];
    // Forward pages go first so the next sheet and its destination are ready
    // before backward history consumes any render slots.
    for (let offset = 1; offset <= this.options.preloadRadius; offset += 1) {
      const forward = center + offset;
      if (forward < this.source.pageCount) indices.push(forward);
    }
    for (let offset = 1; offset <= this.options.preloadRadius; offset += 1) {
      const backward = center - offset;
      if (backward >= 0) indices.push(backward);
    }
    this.cache.prefetch(indices, this.textureHeight());
  }

  private textureHeight(): number {
    const target = pageRasterHeight({
      cssHeight: this.host.clientHeight || 720,
      devicePixelRatio: window.devicePixelRatio || 1,
      maxPixelRatio: this.options.maxPixelRatio,
      resolutionScale: this.renderSettings.resolutionScale,
      zoom: this.zoomLevel,
      maxTextureHeight: this.options.maxTextureHeight,
    });
    this.canvas.dataset.rasterHeight = String(target);
    return target;
  }

  private rebuildMeshes(): void {
    this.rebuildRestingPageGeometry();
    this.curlGeometry.update(
      this.pageWidth,
      this.pageHeight,
      0,
      undefined,
      undefined,
      false,
      this.renderSettings.spineBend,
    );
    this.updateBodyState();
    this.layoutMeshes();
    this.applyLighting();
    this.resize();
  }

  private rebuildRestingPageGeometry(): void {
    this.leftMesh.geometry.dispose();
    this.rightMesh.geometry.dispose();
    const leftSide = this.flow === 1 ? "left" : "right";
    const rightSide = this.flow === 1 ? "right" : "left";
    this.leftMesh.geometry = createRestingPageGeometry(
      this.pageWidth,
      this.pageHeight,
      leftSide,
      this.renderSettings.spineBend,
    );
    this.rightMesh.geometry = createRestingPageGeometry(
      this.pageWidth,
      this.pageHeight,
      rightSide,
      this.renderSettings.spineBend,
    );
  }

  private layoutMeshes(): void {
    const gutterWidth = this.pageWidth * 0.26;
    this.leftMesh.position.set(-this.pageWidth / 2, 0, 0);
    this.rightMesh.position.set(this.pageWidth / 2, 0, 0);
    this.leftMesh.renderOrder = 0;
    this.rightMesh.renderOrder = 0;
    this.leftGutter.scale.set(gutterWidth, this.pageHeight, 1);
    this.rightGutter.scale.set(-gutterWidth, this.pageHeight, 1);
    this.leftGutter.position.set(-gutterWidth / 2, 0, 0.003);
    this.rightGutter.position.set(gutterWidth / 2, 0, 0.003);
    this.leftGutter.renderOrder = 1;
    this.rightGutter.renderOrder = 1;
    // A tiny layer separation prevents z-fighting. The curl geometry itself
    // carries the same binding bow as the resting sheet, so this can remain a
    // true paper-thickness gap instead of making the page float over the book.
    const paperLayerGap = Math.max(
      0.0015,
      Math.min(this.pageWidth, this.pageHeight) * 0.002,
    );
    this.curlMesh.position.set(0, 0, paperLayerGap);
    this.curlMesh.renderOrder = 2;
  }

  private positionBook(offset: number): void {
    this.bookOffset = offset;
    // In an RTL book the "left" mesh (the lower page index) sits visually on
    // the right; mirroring positions is all the spread layout needs.
    this.leftMesh.position.x = this.flow * (-this.pageWidth / 2) + offset;
    this.rightMesh.position.x = this.flow * (this.pageWidth / 2) + offset;
    // The gutter overlays are oriented dark-toward-the-spine and stay on
    // their visual sides; only their visibility follows the page meshes.
    this.leftGutter.position.x = -this.pageWidth * 0.13 + offset;
    this.rightGutter.position.x = this.pageWidth * 0.13 + offset;
    this.curlMesh.position.x = offset;
    this.body.group.position.x = offset;
    this.shadowLight.target.position.x = offset;
    this.updateGutterVisibility();
  }

  /** Gutter shading needs a facing page and an actual spread to make sense. */
  private updateGutterVisibility(): void {
    const strength = this.renderSettings.gutterShading;
    const spread = !this.mobileMode && strength > 0.001;
    const visualLeftMesh = this.flow === 1 ? this.leftMesh : this.rightMesh;
    const visualRightMesh = this.flow === 1 ? this.rightMesh : this.leftMesh;
    const facingPages = spread && visualLeftMesh.visible && visualRightMesh.visible;
    this.leftGutter.visible = facingPages;
    this.rightGutter.visible = facingPages;
  }

  private updateBodyState(): void {
    const pageCount = this.source?.pageCount ?? 0;
    const readFraction = pageCount > 1 && this.currentPage > 0
      ? this.currentPage / pageCount
      : 0;
    const unreadSheets = pageCount - (this.currentPage === 0 ? 1 : this.currentPage + 2);
    const unreadFraction = pageCount > 1 ? Math.max(0, unreadSheets / pageCount) : 0;
    const readVisible = this.currentPage > 0;
    const unreadVisible = this.currentPage === 0 || this.currentPage + 1 < pageCount;
    // The read pile sits left in an LTR book and right in an RTL book.
    const rtl = this.flow === -1;
    this.body.update({
      pageWidth: this.pageWidth,
      pageHeight: this.pageHeight,
      leftFraction: rtl ? unreadFraction : readFraction,
      rightFraction: rtl ? readFraction : unreadFraction,
      leftVisible: rtl ? unreadVisible : readVisible,
      rightVisible: rtl ? readVisible : unreadVisible,
      mobileMode: this.mobileMode,
    });
  }

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    const nextMobileMode = this.mobileSettings.enabled && width <= this.mobileSettings.breakpoint;
    const modeChanged = nextMobileMode !== this.mobileMode;
    this.mobileMode = nextMobileMode;
    this.host.classList.toggle("flipdocs__stage--mobile-focus", this.mobileMode);
    this.canvas.dataset.layout = this.mobileMode ? "mobile-single" : "desktop-spread";
    if (modeChanged) {
      this.mobileFocusPosition = this.activeSide === "left" ? 0 : 1;
      this.pointer = undefined;
      if (this.mobilePointer) {
        window.clearTimeout(this.mobilePointer.intentTimer);
      }
      this.mobilePointer = undefined;
    }
    this.renderer.setSize(width, height, false);
    const sceneWidth = this.mobileMode
      ? this.pageWidth * (1 + this.mobileSettings.pagePeek * 2)
      : this.pageWidth * 2.12;
    const sceneHeight = this.pageHeight * (this.mobileMode ? 1.04 : 1.1);
    const aspect = width / height;
    const bookAspect = sceneWidth / sceneHeight;
    if (aspect >= bookAspect) {
      const top = sceneHeight / 2;
      const right = (sceneHeight * aspect) / 2;
      this.baseFrustum = { left: -right, right, top, bottom: -top };
    } else {
      const right = sceneWidth / 2;
      const top = sceneWidth / aspect / 2;
      this.baseFrustum = { left: -right, right, top, bottom: -top };
    }
    this.applyFrustum();
    this.updateBodyState();
    this.positionBook(this.flip ? this.flippingBookOffset() : this.restingBookOffset());
    this.render();
    if (modeChanged && this.source) this.emitPageState();
    this.scheduleSharperTextures();
  }

  private scheduleSharperTextures(): void {
    if (!this.source || this.flip) return;
    const requestedHeight = this.textureHeight();
    if (requestedHeight <= this.lastRasterHeight * 1.12) return;
    window.clearTimeout(this.resizeTextureTimer);
    this.resizeTextureTimer = window.setTimeout(() => {
      if (!this.source || this.flip) return;
      const refreshedHeight = this.textureHeight();
      if (refreshedHeight <= this.lastRasterHeight * 1.12) return;
      const generation = ++this.sourceGeneration;
      void this.showStablePages(generation);
    }, 180);
  }

  private render(): void {
    this.renderCount += 1;
    this.canvas.dataset.renderCount = String(this.renderCount);
    this.renderer.render(this.scene, this.camera);
  }

  private pointerLayout(): PointerLayout {
    const rect = this.canvas.getBoundingClientRect();
    const cameraCenterX = (this.camera.left + this.camera.right) * 0.5;
    const cameraCenterY = (this.camera.top + this.camera.bottom) * 0.5;
    const worldWidth = (this.camera.right - this.camera.left) / this.camera.zoom;
    const worldHeight = (this.camera.top - this.camera.bottom) / this.camera.zoom;
    const worldLeft = cameraCenterX - worldWidth * 0.5;
    const worldTop = cameraCenterY + worldHeight * 0.5;
    const worldToClientX = (worldX: number) =>
      rect.left + ((worldX - worldLeft) / worldWidth) * rect.width;
    const pageTop = rect.top + ((worldTop - this.pageHeight * 0.5) / worldHeight) * rect.height;
    const pagePixelHeight = (this.pageHeight / worldHeight) * rect.height;
    const pagePixelWidth = (this.pageWidth / worldWidth) * rect.width;
    // A resting spread spans a page to each side of the spine; the lone cover
    // spans exactly one page width on whichever side the book opens from.
    const cover = this.currentPage === 0;
    const bookLeftWorld = cover && this.flow === 1
      ? this.bookOffset
      : this.bookOffset - this.pageWidth;
    const bookRightWorld = cover && this.flow === -1
      ? this.bookOffset
      : this.bookOffset + this.pageWidth;
    return {
      rect,
      worldLeft,
      worldTop,
      worldWidth,
      worldHeight,
      pageTop,
      pagePixelHeight,
      pagePixelWidth,
      bookLeftX: worldToClientX(bookLeftWorld),
      bookRightX: worldToClientX(bookRightWorld),
      spineX: worldToClientX(this.bookOffset),
    };
  }

  private async loadVisibleLinks(): Promise<void> {
    const source = this.source;
    if (!this.linksEnabled || !source?.pageLinks) return;
    const generation = this.sourceGeneration;
    const left = this.currentPage === 0 ? null : this.currentPage;
    const right = this.currentPage === 0
      ? 0
      : this.currentPage + 1 < source.pageCount ? this.currentPage + 1 : null;
    for (const index of [left, right]) {
      if (index === null || this.linkMap.has(index)) continue;
      try {
        const links = await source.pageLinks(index);
        if (generation !== this.sourceGeneration || this.source !== source) return;
        this.linkMap.set(index, links);
      } catch {
        // A page without readable annotations simply is not clickable.
      }
    }
  }

  private linkAt(clientX: number, clientY: number, layout?: PointerLayout): PageLink | undefined {
    if (!this.linksEnabled || !this.source || this.linkMap.size === 0) return undefined;
    const resolved = layout ?? this.pointerLayout();
    const v = (clientY - resolved.pageTop) / resolved.pagePixelHeight;
    if (v < 0 || v > 1) return undefined;
    const higherIndex = this.currentPage === 0
      ? 0
      : this.currentPage + 1 < this.source.pageCount ? this.currentPage + 1 : null;
    const lowerIndex = this.currentPage > 0 ? this.currentPage : null;
    let pageIndex: number | null = null;
    let u = 0;
    if (clientX >= resolved.spineX && clientX <= resolved.bookRightX) {
      // Right of the spine: the later page in LTR, the earlier page in RTL.
      pageIndex = this.flow === 1 ? higherIndex : (this.currentPage === 0 ? 0 : lowerIndex);
      u = (clientX - resolved.spineX) / resolved.pagePixelWidth;
    } else if (clientX >= resolved.bookLeftX && clientX < resolved.spineX) {
      pageIndex = this.flow === 1 ? lowerIndex : higherIndex;
      u = (clientX - resolved.bookLeftX) / resolved.pagePixelWidth;
    }
    if (pageIndex === null) return undefined;
    const links = this.linkMap.get(pageIndex);
    return links?.find(
      (link) => u >= link.left && u <= link.right && v >= link.top && v <= link.bottom,
    );
  }

  private activateLink(link: PageLink): void {
    if (typeof link.destPage === "number") {
      this.goToPage(link.destPage);
      return;
    }
    if (link.url) window.open(link.url, "_blank", "noopener,noreferrer");
  }

  private hitTestCorner(event: PointerEvent): { direction: FlipDirection; cornerY: 0 | 1 } | undefined {
    if (
      !this.corner.enabled ||
      !this.source ||
      this.pointer ||
      (this.flip && !this.hoverPreview)
    ) return undefined;
    const layout = this.pointerLayout();
    const y = event.clientY - layout.pageTop;
    if (y < -5 || y > layout.pagePixelHeight + 5) return undefined;
    const cornerHeight = layout.pagePixelHeight * this.corner.size;
    const distanceFromTop = Math.max(0, y);
    const distanceFromBottom = Math.max(0, layout.pagePixelHeight - y);
    if (Math.min(distanceFromTop, distanceFromBottom) > cornerHeight) return undefined;
    const cornerY: 0 | 1 = distanceFromTop <= distanceFromBottom ? 1 : 0;
    const cornerWidth = layout.pagePixelWidth * this.corner.size;
    // The forward corner is the unread side's outer edge: right in an LTR
    // book, left in an RTL one. The back corner is the opposite edge.
    const forwardAtRight = this.flow === 1;
    const nearRight =
      event.clientX >= layout.bookRightX - cornerWidth && event.clientX <= layout.bookRightX + 6;
    const nearLeft =
      event.clientX >= layout.bookLeftX - 6 && event.clientX <= layout.bookLeftX + cornerWidth;
    if (this.canFlip("next") && (forwardAtRight ? nearRight : nearLeft)) {
      return { direction: "next", cornerY };
    }
    if (this.canFlip("previous") && (forwardAtRight ? nearLeft : nearRight)) {
      return { direction: "previous", cornerY };
    }
    return undefined;
  }

  private showCornerPreview(direction: FlipDirection, cornerY: 0 | 1): void {
    if (
      !this.corner.enabled ||
      this.pointer ||
      !this.source ||
      !this.canFlip(direction) ||
      (this.flip && !this.hoverPreview)
    ) return;
    const targetY = cornerY === 1 ? 1 - this.corner.pull : this.corner.pull;
    if (this.hoverPreview?.direction === direction && this.hoverPreview.cornerY === cornerY) {
      this.interaction = { grabX: 1, grabY: cornerY, targetY };
      this.setProgress(direction === "next" ? this.corner.lift : 1 - this.corner.lift);
      return;
    }

    this.abandonHoverPreview();
    const preview = {
      direction,
      cornerY,
      leftMap: this.leftMaterial.map ?? this.placeholder,
      rightMap: this.rightMaterial.map ?? this.placeholder,
      leftVisible: this.leftMesh.visible,
      rightVisible: this.rightMesh.visible,
    };
    this.interaction = { grabX: 1, grabY: cornerY, targetY };
    this.prepareFlip(direction);
    if (!this.flip || this.flip.direction !== direction) return;
    this.hoverPreview = preview;
    this.canvas.classList.add("flipdocs__canvas--corner");
    this.setProgress(direction === "next" ? this.corner.lift : 1 - this.corner.lift);
  }

  private claimHoverPreview(direction: FlipDirection): void {
    if (!this.hoverPreview) return;
    if (this.hoverPreview.direction !== direction) {
      this.abandonHoverPreview();
      return;
    }
    this.hoverPreview = undefined;
    this.canvas.classList.remove("flipdocs__canvas--corner");
  }

  private abandonHoverPreview(): void {
    const preview = this.hoverPreview;
    if (!preview) return;
    this.hoverPreview = undefined;
    this.canvas.classList.remove("flipdocs__canvas--corner");
    this.cancelAnimation();
    this.flip = undefined;
    this.progress = 0;
    this.interaction = { grabX: 1, grabY: 0.78, targetY: 0.52 };
    this.curlMesh.visible = false;
    this.updateFoldShading(0);
    this.positionBook(this.restingBookOffset());
    this.cache?.setPinned([
      ...(this.currentPage === 0 ? [] : [this.currentPage]),
      ...(this.currentPage === 0
        ? [0]
        : this.source && this.currentPage + 1 < this.source.pageCount
          ? [this.currentPage + 1]
          : []),
    ]);
    this.setStaticMap(this.leftMesh, this.leftMaterial, preview.leftMap, preview.leftVisible);
    this.setStaticMap(this.rightMesh, this.rightMaterial, preview.rightMap, preview.rightVisible);
    this.render();
  }

  private bindInput(): void {
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("keydown", this.onKeyDown);
  }

  private mobileActionForDelta(deltaX: number): MobileDragAction {
    // Forward always drags the sheet toward the read pile: leftward in an
    // LTR book, rightward in an RTL one. Flow-normalize once, up front.
    const forwardDelta = deltaX * this.flow;
    if (forwardDelta < 0) {
      if (this.currentPage > 0 && this.activeSide === "left") {
        return this.source && this.currentPage + 1 < this.source.pageCount
          ? "focus-right"
          : "pending";
      }
      return this.canFlip("next") ? "flip-next" : "pending";
    }
    if (this.currentPage > 0 && this.activeSide === "right") return "focus-left";
    return this.canFlip("previous") ? "flip-previous" : "pending";
  }

  private beginMobileDirectDrag(
    pointer: NonNullable<FlipBookEngine["mobilePointer"]>,
    clientX: number,
  ): void {
    if (pointer.action !== "pending") return;
    pointer.action = this.mobileActionForDelta(clientX - pointer.x);
    if (pointer.action === "pending") return;
    pointer.targetY = pointer.grabY;
    this.canvas.dataset.dragPickup = "attached";
    this.canvas.dataset.lastGesture = pointer.action.startsWith("focus-")
      ? "focus-drag"
      : "paper-drag";
    if (pointer.action === "flip-next" || pointer.action === "flip-previous") {
      const direction: FlipDirection = pointer.action === "flip-next" ? "next" : "previous";
      // Fold from the loose edge regardless of where the finger rests; an
      // interior grab origin folds the outer strip over in a single frame.
      this.interaction = {
        grabX: 1,
        grabY: pointer.grabY,
        targetY: pointer.grabY,
        pointerAttached: true,
      };
      this.prepareFlip(direction);
      const attached = this.fingerAttachedProgress(clientX, pointer);
      pointer.baseline = clamp01(pointer.action === "flip-previous" ? 1 - attached : attached);
    }
  }

  private updateMobileDirectDrag(
    pointer: NonNullable<FlipBookEngine["mobilePointer"]>,
    clientX: number,
    clientY: number,
  ): void {
    if (pointer.action === "flip-next" || pointer.action === "flip-previous") {
      // Direct paper drags attach the sheet's edge to the finger.
      const attached = this.fingerAttachedProgress(clientX, pointer);
      pointer.progress = clamp01(pointer.action === "flip-previous" ? 1 - attached : attached);
    } else {
      const horizontalDistance = Math.abs(clientX - pointer.x);
      pointer.progress = clamp01(horizontalDistance / pointer.travel);
    }
    pointer.targetY = clamp01(
      1 - (clientY - pointer.pageTop) / pointer.pagePixelHeight,
    );
    this.applyMobileDirectProgress(pointer, pointer.progress, pointer.targetY);
  }

  private applyMobileDirectProgress(
    pointer: NonNullable<FlipBookEngine["mobilePointer"]>,
    progress: number,
    targetY: number,
  ): void {
    this.interaction.targetY = targetY;
    if (pointer.action === "focus-right") {
      this.setMobileFocusPosition(
        pointer.startFocus + (1 - pointer.startFocus) * progress,
      );
    } else if (pointer.action === "focus-left") {
      this.setMobileFocusPosition(pointer.startFocus * (1 - progress));
    } else if (pointer.action === "flip-next" && this.flip?.direction === "next") {
      this.setProgress(progress);
    } else if (pointer.action === "flip-previous" && this.flip?.direction === "previous") {
      this.setProgress(1 - progress);
    }
  }

  private onMobilePointerDown(event: PointerEvent): void {
    if (!this.source || this.flip || this.mobilePointer) return;
    if (this.hoverPreview) this.abandonHoverPreview();
    if (this.frame) {
      this.cancelAnimation();
      this.activeSide = this.mobileFocusPosition < 0.5 ? "left" : "right";
      this.mobileFocusPosition = this.activeSide === "left" ? 0 : 1;
      this.positionBook(this.restingBookOffset());
    }
    const layout = this.pointerLayout();
    if (event.clientY < layout.pageTop || event.clientY > layout.pageTop + layout.pagePixelHeight) {
      return;
    }
    // The focused mesh's visual span: the "right" mesh (higher page index)
    // sits right of the spine in an LTR book and left of it in an RTL book.
    const rightMeshFocused = this.currentPage === 0 || this.activeSide === "right";
    const rightMeshVisuallyRight = this.flow === 1;
    const activeLeft = rightMeshFocused === rightMeshVisuallyRight
      ? layout.spineX
      : layout.bookLeftX;
    const activeRight = rightMeshFocused === rightMeshVisuallyRight
      ? layout.bookRightX
      : layout.spineX;
    if (event.clientX < activeLeft - 12 || event.clientX > activeRight + 12) return;

    const grabY = clamp01(1 - (event.clientY - layout.pageTop) / layout.pagePixelHeight);
    const pointer: NonNullable<FlipBookEngine["mobilePointer"]> = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      startedAt: performance.now(),
      intentTimer: 0,
      moved: false,
      action: "pending",
      progress: 0,
      baseline: 0,
      targetY: grabY,
      startFocus: this.mobileFocusPosition,
      pageTop: layout.pageTop,
      pagePixelHeight: layout.pagePixelHeight,
      pagePixelWidth: layout.pagePixelWidth,
      spineX: layout.spineX,
      spineWorldX: this.bookOffset,
      centerX: layout.rect.left + layout.rect.width * 0.5,
      travel: Math.max(120, layout.rect.width * this.curl.dragResistance),
      grabX: clamp01(Math.abs(event.clientX - layout.spineX) / layout.pagePixelWidth),
      grabY,
    };
    this.canvas.dataset.lastGrabX = pointer.grabX.toFixed(3);
    this.canvas.dataset.lastGrabHalf = pointer.grabX < 0.5 ? "inner" : "outer";
    pointer.intentTimer = window.setTimeout(() => {
      const active = this.mobilePointer;
      if (!active || active.id !== pointer.id || active.action !== "pending" || !active.moved) return;
      if (mobileHeldGestureIntent(active.grabX) === "flick") {
        active.action = "swipe";
        this.canvas.dataset.lastGesture = "flick";
        return;
      }
      this.beginMobileDirectDrag(active, active.lastX);
      this.updateMobileDirectDrag(active, active.lastX, active.lastY);
    }, 150);
    this.mobilePointer = pointer;
    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);
  }

  private onMobilePointerMove(event: PointerEvent): void {
    const pointer = this.mobilePointer;
    if (!pointer || event.pointerId !== pointer.id) return;
    const deltaX = event.clientX - pointer.x;
    const deltaY = event.clientY - pointer.y;
    const horizontalDistance = Math.abs(deltaX);
    const elapsed = Math.max(1, performance.now() - pointer.startedAt);
    pointer.lastX = event.clientX;
    pointer.lastY = event.clientY;
    if (Math.hypot(deltaX, deltaY) > 4) pointer.moved = true;

    if (pointer.action === "pending") {
      const intent = mobileGestureIntent({
        grabX: pointer.grabX,
        horizontalDistance,
        verticalDistance: deltaY,
        elapsedMs: elapsed,
      });
      if (intent === "flick") {
        pointer.action = "swipe";
        window.clearTimeout(pointer.intentTimer);
        this.canvas.dataset.lastGesture = "flick";
      } else if (intent === "drag") {
        window.clearTimeout(pointer.intentTimer);
        this.beginMobileDirectDrag(pointer, event.clientX);
      }
    }

    if (pointer.action === "pending" || pointer.action === "swipe") return;
    this.updateMobileDirectDrag(pointer, event.clientX, event.clientY);
    event.preventDefault();
  }

  private onMobilePointerUp(event: PointerEvent): void {
    const pointer = this.mobilePointer;
    if (!pointer || event.pointerId !== pointer.id) return;
    this.mobilePointer = undefined;
    window.clearTimeout(pointer.intentTimer);
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }

    const deltaX = event.clientX - pointer.x;
    const deltaY = event.clientY - pointer.y;
    const cancelled = event.type === "pointercancel";
    if (pointer.action === "pending" || pointer.action === "swipe") {
      const swipeDistance = Math.min(64, Math.max(28, pointer.travel * 0.08));
      if (
        !cancelled &&
        Math.abs(deltaX) >= swipeDistance &&
        Math.abs(deltaX) > Math.abs(deltaY) * 0.85
      ) {
        this.interaction = {
          grabX: 1,
          grabY: 0,
          targetY: 0.28,
        };
        if (deltaX * this.flow < 0) this.next();
        else this.previous();
      } else if (!cancelled && !pointer.moved) {
        this.handleMobileTap(pointer.x, pointer.y, event.clientX, event.clientY);
      }
      return;
    }

    const elapsed = Math.max(1, performance.now() - pointer.startedAt);
    const releaseVelocity = Math.abs(deltaX) / elapsed;
    // Finger-attached drags begin partway turned; measure the advance from
    // the attach baseline so a grab-and-release does not complete the turn.
    const advance =
      (pointer.progress - pointer.baseline) / Math.max(0.05, 1 - pointer.baseline);
    const complete = !cancelled && (
      advance > this.curl.snapThreshold ||
      (advance > 0.08 && releaseVelocity > 0.55)
    );
    if (pointer.action === "focus-right") {
      this.animateMobileFocus(complete ? 1 : 0);
    } else if (pointer.action === "focus-left") {
      this.animateMobileFocus(complete ? 0 : 1);
    } else if (pointer.action === "flip-next" && this.flip?.direction === "next") {
      this.animateTo(complete ? 1 : 0);
    } else if (pointer.action === "flip-previous" && this.flip?.direction === "previous") {
      this.animateTo(complete ? 0 : 1);
    }
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (!this.options.interactive || !this.source || this.riffling) return;
    // Zoomed in, drag pans the view; page turns stay on keys and toolbar.
    if (this.zoomSettings.pan && this.zoomLevel > 1.05 && !this.flip) {
      this.panPointer = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        panX: this.panX,
        panY: this.panY,
      };
      event.preventDefault();
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (this.mobileMode) {
      this.onMobilePointerDown(event);
      return;
    }
    const layout = this.pointerLayout();
    const link = this.linkAt(event.clientX, event.clientY, layout);
    if (link && !this.flip) {
      this.pendingLink = { id: event.pointerId, x: event.clientX, y: event.clientY, link };
      event.preventDefault();
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (
      event.clientY < layout.pageTop ||
      event.clientY > layout.pageTop + layout.pagePixelHeight ||
      event.clientX < layout.bookLeftX ||
      event.clientX > layout.bookRightX
    ) return;

    // The unread stack sits opposite the read pile: pressing on it turns
    // forward. The cover always turns forward regardless of side.
    const onForwardSide = this.flow * (event.clientX - layout.spineX) >= 0;
    const direction: FlipDirection =
      this.currentPage === 0 || onForwardSide ? "next" : "previous";
    if (!this.canFlip(direction)) return;
    const continuedPreview = this.hoverPreview?.direction === direction;
    if (this.hoverPreview) this.claimHoverPreview(direction);
    if (this.flip && !continuedPreview) return;

    const pointerY = clamp01(1 - (event.clientY - layout.pageTop) / layout.pagePixelHeight);
    // The sheet always folds from its loose edge. Anchoring the curl at an
    // interior grab point would mirror everything beyond the crease flat on
    // the very first frame — a visible jump when grabbing mid-page.
    this.interaction = {
      grabX: 1,
      grabY: pointerY,
      targetY: pointerY,
      pointerAttached: true,
    };
    if (!this.flip) this.prepareFlip(direction);
    if (!this.flip || this.flip.direction !== direction) return;
    this.setProgress(this.progress);
    const pointer: NonNullable<FlipBookEngine["pointer"]> = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      direction,
      // The sheet's edge attaches to the finger, so the full turn spans a
      // page-width mirror. Travel only normalizes fling velocity now.
      travel: 2 * layout.pagePixelWidth * this.curl.dragResistance,
      pageTop: layout.pageTop,
      pagePixelHeight: layout.pagePixelHeight,
      pagePixelWidth: layout.pagePixelWidth,
      spineX: layout.spineX,
      spineWorldX: this.bookOffset,
      lastX: event.clientX,
      lastTime: performance.now(),
      velocity: 0,
      initialAttach: this.progress,
    };
    pointer.initialAttach = this.fingerAttachedProgress(event.clientX, pointer);
    this.pointer = pointer;
    this.canvas.dataset.dragPickup = "attached";
    this.setProgress(pointer.initialAttach);
    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);
  };

  /** The progress that places the turning sheet's loose edge at the finger. */
  private fingerAttachedProgress(
    clientX: number,
    pointer: { spineX: number; spineWorldX: number; pagePixelWidth: number },
  ): number {
    const originX = Math.max(this.pageWidth * 0.02, this.interaction.grabX * this.pageWidth);
    const edgeWorldAt = (progress: number) =>
      this.flippingBookOffsetAt(progress) + this.flow * originX * (1 - 2 * progress);
    return attachedProgressForPointer({
      clientX,
      initialSpineClientX: pointer.spineX,
      initialSpineWorldX: pointer.spineWorldX,
      pagePixelWidth: pointer.pagePixelWidth,
      pageWorldWidth: this.pageWidth,
      edgeWorldAtStart: edgeWorldAt(0),
      edgeWorldAtEnd: edgeWorldAt(1),
    });
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (this.panPointer) {
      if (event.pointerId !== this.panPointer.id) return;
      const worldPerPixel =
        (this.baseFrustum.right - this.baseFrustum.left) /
        (this.zoomLevel * Math.max(1, this.canvas.clientWidth));
      this.panX = this.panPointer.panX - (event.clientX - this.panPointer.x) * worldPerPixel;
      this.panY = this.panPointer.panY + (event.clientY - this.panPointer.y) * worldPerPixel;
      this.applyFrustum();
      return;
    }
    if (this.pendingLink) {
      if (
        event.pointerId === this.pendingLink.id &&
        Math.hypot(event.clientX - this.pendingLink.x, event.clientY - this.pendingLink.y) > 6
      ) {
        this.pendingLink = undefined;
      }
      return;
    }
    if (this.mobilePointer) {
      this.onMobilePointerMove(event);
      return;
    }
    if (this.mobileMode) return;
    if (!this.pointer) {
      const corner = this.hitTestCorner(event);
      if (corner) {
        this.canvas.style.cursor = "";
        this.showCornerPreview(corner.direction, corner.cornerY);
        return;
      }
      this.abandonHoverPreview();
      this.canvas.style.cursor =
        this.linksEnabled && !this.flip && this.linkAt(event.clientX, event.clientY)
          ? "pointer"
          : "";
      return;
    }
    if (event.pointerId !== this.pointer.id || !this.flip) return;
    const delta = event.clientX - this.pointer.x;
    if (Math.hypot(delta, event.clientY - this.pointer.y) > 3) this.pointer.moved = true;
    const now = performance.now();
    const frameDelta = event.clientX - this.pointer.lastX;
    const frameTime = Math.max(1, now - this.pointer.lastTime);
    this.pointer.velocity = this.pointer.velocity * 0.6 + (frameDelta / frameTime) * 0.4;
    this.pointer.lastX = event.clientX;
    this.pointer.lastTime = now;
    this.interaction.targetY = clamp01(
      1 - (event.clientY - this.pointer.pageTop) / this.pointer.pagePixelHeight,
    );
    this.setProgress(this.fingerAttachedProgress(event.clientX, this.pointer));
  };

  /** A confirmed single tap navigates; a quick second tap toggles zoom. */
  private handleMobileTap(downX: number, downY: number, upX: number, upY: number): void {
    const link = this.linkAt(upX, upY);
    if (link) {
      this.activateLink(link);
      this.lastTap = undefined;
      return;
    }
    const navigate = () => {
      const center = this.canvas.getBoundingClientRect().left + this.canvas.clientWidth * 0.5;
      // Tapping the unread side advances: right half LTR, left half RTL.
      if (this.flow * (downX - center) >= 0) this.next();
      else this.previous();
    };
    if (!this.mobileSettings.doubleTapZoom) {
      navigate();
      return;
    }
    const now = performance.now();
    const previous = this.lastTap;
    this.lastTap = { time: now, x: upX, y: upY };
    if (previous && now - previous.time < 320 && Math.hypot(upX - previous.x, upY - previous.y) < 44) {
      window.clearTimeout(this.tapTimer);
      this.tapTimer = 0;
      this.lastTap = undefined;
      const zoomedIn = this.zoomLevel > 1.01;
      this.setZoom(
        zoomedIn ? this.zoomSettings.initial : Math.min(2.2, this.zoomSettings.max),
        { clientX: upX, clientY: upY },
      );
      return;
    }
    // Wait one double-tap window before turning the page, so a second tap can
    // still become a zoom. The delay only exists when doubleTapZoom is on.
    window.clearTimeout(this.tapTimer);
    this.tapTimer = window.setTimeout(() => {
      this.tapTimer = 0;
      navigate();
    }, 300);
  }

  private onPointerUp = (event: PointerEvent): void => {
    if (this.panPointer) {
      if (event.pointerId !== this.panPointer.id) return;
      this.panPointer = undefined;
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      return;
    }
    if (this.pendingLink) {
      if (event.pointerId !== this.pendingLink.id) return;
      const pending = this.pendingLink;
      this.pendingLink = undefined;
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      if (event.type !== "pointercancel") this.activateLink(pending.link);
      return;
    }
    if (this.mobilePointer) {
      this.onMobilePointerUp(event);
      return;
    }
    if (!this.pointer || event.pointerId !== this.pointer.id || !this.flip) return;
    const pointer = this.pointer;
    this.pointer = undefined;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (!pointer.moved) {
      this.animateTo(pointer.direction === "next" ? 1 : 0);
      return;
    }
    // Dragging left moves progress forward, so progress speed is -velocity.
    const progressVelocity = -pointer.velocity / pointer.travel;
    const fling = this.curl.velocityFling ? progressVelocity : 0;
    const threshold = this.curl.snapThreshold;
    // The finger-attached sheet starts partway turned, so measure how far the
    // drag advanced from its attach point rather than absolute progress.
    const advance = pointer.direction === "next"
      ? (this.progress - pointer.initialAttach) / Math.max(0.05, 1 - pointer.initialAttach)
      : (pointer.initialAttach - this.progress) / Math.max(0.05, pointer.initialAttach);
    let complete = advance > threshold;
    if (this.curl.velocityFling && Math.abs(fling) > 0.0012) {
      // A decisive flick wins over position: fast toward completion completes,
      // fast back toward the start cancels, matching real paper.
      complete = pointer.direction === "next" ? fling > 0 : fling < 0;
    }
    const target = complete
      ? (pointer.direction === "next" ? 1 : 0)
      : pointer.direction === "next" ? 0 : 1;
    const towardTarget = Math.sign(target - this.progress);
    const initialSpeed =
      this.curl.velocityFling && Math.sign(fling) === towardTarget && towardTarget !== 0
        ? Math.abs(fling)
        : undefined;
    this.animateTo(target, { initialSpeed });
  };

  private onPointerLeave = (): void => {
    if (!this.pointer && !this.mobilePointer) this.abandonHoverPreview();
  };

  private onWheel = (event: WheelEvent): void => {
    if (!this.options.interactive || !this.zoomSettings.wheel || Math.abs(event.deltaY) < 0.01) return;
    event.preventDefault();
    const scale = Math.exp(-event.deltaY * 0.0015);
    this.setZoom(this.zoomLevel * scale, { clientX: event.clientX, clientY: event.clientY });
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      // Arrows are spatial: they move toward the pressed side, which maps to
      // the opposite logical direction in an RTL book.
      event.preventDefault();
      const forward = (event.key === "ArrowRight") === (this.flow === 1);
      if (forward) this.next();
      else this.previous();
    } else if (event.key === "PageDown") {
      event.preventDefault();
      this.next();
    } else if (event.key === "PageUp") {
      event.preventDefault();
      this.previous();
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      this.zoomIn();
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      this.zoomOut();
    } else if (event.key === "0") {
      event.preventDefault();
      this.resetZoom();
    }
  };

  private cancelAnimation(): void {
    this.animationGeneration += 1;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    const cancel = this.activeAnimationCancel;
    this.activeAnimationCancel = undefined;
    cancel?.();
  }

  destroy(): void {
    this.cancelAnimation();
    if (this.mobilePointer) {
      window.clearTimeout(this.mobilePointer.intentTimer);
    }
    window.clearTimeout(this.resizeTextureTimer);
    window.clearTimeout(this.tapTimer);
    this.sourceGeneration += 1;
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("keydown", this.onKeyDown);
    this.cache?.dispose();
    this.source?.dispose();
    this.leftMesh.geometry.dispose();
    this.rightMesh.geometry.dispose();
    this.curlGeometry.dispose();
    this.leftGutter.geometry.dispose();
    this.rightGutter.geometry.dispose();
    this.leftGutter.material.dispose();
    this.rightGutter.material.dispose();
    this.gutterTexture.dispose();
    this.body.dispose();
    this.turnSound.dispose();
    this.leftMaterial.dispose();
    this.rightMaterial.dispose();
    this.curlMaterial.dispose();
    this.shadowLight.shadow.dispose();
    this.placeholder.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
