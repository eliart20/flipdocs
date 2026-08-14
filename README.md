# Flipdocs

A fast React flipbook for PDFs and image sequences. Flipdocs uses Three.js directly for a segmented, two-sided paper curl and lazy-loads PDF.js only for PDF sources.

## Presentation features

All of these ship enabled by default (except the optional gutter overlay, sound, thumbnails, and links) and each one is a prop, so any can be turned off:

- `body` — the book as an object: fanned page-edge stacks that shift as you read, plus cover boards. Static unlit quads; zero idle cost.
- `render.spineBend` — real segmented resting-page geometry that rises gently into the binding and is lit by Three.js.
- `render.gutterShading` — optional extra artistic darkening near the binding; `0` by default because the physical bend supplies the normal lighting.
- `render.sheen` — a glossy-paper specular band that travels with the fold on the moving sheet. One shader uniform.
- `curl.velocityFling` — release speed carries into the settle animation, so a fast flick lands fast and a reverse flick cancels.
- `curl.settleWobble` — one damped flutter of the free edge as a sheet lands, scaled by release speed.
- `curl.coverStiffness` — the cover sheet bends wider and tracks the pointer less, like board stock.
- `riffle` — long `goToPage` jumps fan up to `maxSheets` quick turns instead of teleporting (desktop, motion-safe only).
- `zoom.toPointer` / `zoom.pan` — wheel zoom targets the cursor and drag pans while zoomed in.
- `mobile.doubleTapZoom` — double-tap toggles zoom toward the tapped point.
- `sound` — opt-in procedural page-turn swish (or your own clip via `sound.src`).
- `links` — opt-in clickable PDF link annotations: internal jumps ride the riffle, external URLs open in a new tab.
- `showFullscreen` — fullscreen toggle in the toolbar.
- `showThumbnails` — opt-in thumbnail strip; off by default because it must rasterize the pages it shows, which defeats lazy loading on huge PDFs.

Every animation still runs only while something moves: an idle book renders zero frames.

## Why it stays fast

- One deforming mesh exists during a page turn; the lightly bowed resting pages remain static.
- There is no continuous render loop. Idle books render zero frames.
- PDF parsing runs through the PDF.js worker.
- URL and local `File` PDFs use byte ranges by default; a 300 MB book is not copied wholesale into main memory.
- Only nearby pages are rasterized and retained in a bounded LRU GPU cache. Pages currently visible or mapped onto a turning sheet are pinned while speculative preloads remain evictable, so prefetching cannot dispose a live page. Forward pages are queued first, and an already-rendered texture remains visible while a sharper replacement is produced.
- Textures are capped by viewport size, pixel ratio, and `maxTextureHeight`.
- Image-only books never import the PDF parser.

## Install

```bash
npm install flipdocs three pdfjs-dist
```

React and React DOM are peer dependencies.

## React usage

```tsx
import { FlipBook } from "flipdocs";
import "flipdocs/style.css";

export function Reader() {
  return (
    <div style={{ height: 720 }}>
      <FlipBook source={{ type: "pdf", src: "/catalog.pdf" }} />
    </div>
  );
}
```

An image book uses the same component:

```tsx
<FlipBook
  source={{
    type: "images",
    pages: ["/pages/cover.webp", "/pages/1.webp", "/pages/2.webp"],
  }}
/>
```

## Lazy-loading large PDFs

Lazy loading is enabled by default. For a local file selected with an `<input>`, Flipdocs gives PDF.js a custom range transport backed by `Blob.slice()`. It reads only the cross-reference data and the page ranges PDF.js requests; it does not call `file.arrayBuffer()` for the whole book.

```tsx
const [file, setFile] = useState<File>();

<input
  type="file"
  accept="application/pdf"
  onChange={(event) => setFile(event.target.files?.[0])}
/>

{file && (
  <FlipBook
    source={{ type: "pdf", src: file, lazy: true }}
    preloadRadius={2}
    cacheSize={8}
    onLoadProgress={({ loadedBytes, totalBytes }) => {
      console.log(`Read ${loadedBytes} of ${totalBytes} bytes`);
    }}
  />
)}
```

For a PDF URL, the web server must support HTTP byte ranges: advertise `Accept-Ranges: bytes`, return `206 Partial Content` with a correct `Content-Range`, and send `Content-Length`. Flipdocs first performs a one-byte range probe, then supplies PDF.js with a strict range transport so startup never needs a speculative full-file GET. Cross-origin servers must expose `Content-Range` through CORS. If range requests are unavailable, PDF.js falls back to its normal streaming behavior.

```tsx
<FlipBook
  source={{
    type: "pdf",
    src: "/books/yearbook.pdf",
    lazy: true,
    rangeChunkSize: 256 * 1024,
  }}
/>
```

`ArrayBuffer` and `Uint8Array` inputs are already fully resident in memory, so they cannot be byte-range lazy. Set `lazy: false` only when you deliberately prefer progressive full-file streaming.

## Mid-flip control

```tsx
const book = useRef<FlipBookHandle>(null);

<FlipBook ref={book} source={source} />
<button onClick={() => book.current?.setFlipProgress(0.52, "next")}>
  Hold the curl
</button>
<button onClick={() => book.current?.completeFlip()}>Complete</button>
```

Readers can also drag either side, click to turn, or use the arrow/Page Up/Page Down keys.

## Mobile single-page focus

Below the mobile breakpoint, Flipdocs frames one active page at reading size while retaining the spine and a sliver of the opposite page. Moving within a spread slides the book beneath the viewport. Crossing a spread boundary combines that slide with the Three.js curl, so a right-page turn settles naturally on the next left page.

```tsx
<FlipBook
  source={source}
  mobile={{
    enabled: true,
    breakpoint: 900,
    pagePeek: 0.08,
  }}
/>
```

Mobile gestures deliberately have two paper behaviors:

- A gesture begun on the inner half always uses a consistent lower-corner flick animation, avoiding an implausible pinch near the binding.
- On the loose outer half, the page follows the first meaningful horizontal movement immediately. A short, fast release settles as a flick; a slower gesture remains exact direct manipulation.

The page count follows the active individual page in mobile focus mode. The demo exposes the focus toggle, breakpoint, and opposite-page peek under **View**.

## Paper physics

The curl follows the exact material point the reader grabs. Its fold axis is perpendicular to the live drag vector, the cylindrical bend preserves arc length, and the full spine edge is constrained to the book. Diagonal movement is limited by the material reach from the binding, and the attachment zone widens under extreme diagonal load instead of stretching into a narrow neck. Moving back toward the starting point unfolds the same sheet instead of starting a new animation.

```tsx
<FlipBook
  source={source}
  curl={{
    radius: 0.16,        // fraction of page width
    radiusLimit: 0.65,   // cap relative to pointer travel
    verticalPull: 0.65,  // follow vertical pointer movement
    binding: 0.14,       // fixed-spine transition width
    dragResistance: 1,
    snapThreshold: 0.24,
  }}
/>
```

The demo exposes all six values as live sliders. Press **Hold mid-flip**, then tune the sheet while it is suspended.

## Corner hover and grabbing

The upper and lower loose corners use the same constrained curl as a full drag. Hovering lifts the actual sheet, pressing it continues from that partial turn without a jump, and clicking completes it. Both left-page corners use the mirrored concave solve.

```tsx
<FlipBook
  source={source}
  corner={{
    enabled: true,
    size: 0.18, // corner hit area as a fraction of page width and height
    lift: 0.075,
    pull: 0.08,
  }}
/>
```

## Zoom

The built-in toolbar, mouse wheel/trackpad, `+`, `-`, and `0` keys control zoom. Zooming the camera does not stretch a permanently low-resolution PDF texture: Flipdocs requests a sharper visible-page raster after zoom settles, up to `maxTextureHeight`.

```tsx
const book = useRef<FlipBookHandle>(null);

<FlipBook
  ref={book}
  source={source}
  zoom={{ initial: 1, min: 0.75, max: 4, step: 0.25, wheel: true }}
/>

<button onClick={() => book.current?.zoomIn()}>Zoom in</button>
<button onClick={() => book.current?.resetZoom()}>100%</button>
```

## Performance controls

| Prop | Default | Purpose |
| --- | ---: | --- |
| `cacheSize` | `6` | Maximum decoded page textures retained on the GPU |
| `preloadRadius` | `2` | Pages kept warm around the visible spread, with the next two requested first |
| `maxPixelRatio` | `2` | Device-pixel-ratio cap for the WebGL canvas and page rasterization |
| `maxTextureHeight` | `4096` | Hard limit for PDF and downsampled image textures |
| `animationDuration` | `760` | Full page-turn duration in milliseconds |

## Renderer choice

Flipdocs currently uses Three.js `WebGLRenderer` directly. The scene has only a few draw calls and one deforming sheet, so WebGPU does not improve this workload's frame time or first paint. Three.js also currently requires custom `ShaderMaterial` code to be rewritten in TSL for `WebGPURenderer`, which remains experimental. The engine is isolated behind one class so a TSL/WebGPU backend can be added later without changing the React API.

For very large books, the defaults bound GPU memory independently of page count. For mobile-heavy deployments, try `maxPixelRatio={1.25}` and `maxTextureHeight={1536}`.

## PDF sharpness, lighting, and shadows

PDF pages stay raster-backed so they can bend in WebGL. `render.resolutionScale` supersamples each nearby page independently of screen pixel ratio; the default `2` is intentionally sharper than a one-pixel-per-screen-pixel render. Raising it improves small text but increases page-render time and GPU memory. The bounded texture cache still prevents memory use from growing with the book's page count.

```tsx
<FlipBook
  source={{ type: "pdf", src: "/books/yearbook.pdf" }}
  render={{
    resolutionScale: 2,
    ambientLight: 0.88,
    directionalLight: 0.12,
    foldContrast: 0.06,
    lightAngle: 38,
    lightElevation: 0.93,
    shadows: true,
    shadowOpacity: 0.24,
    shadowSoftness: 2.5,
    shadowResolution: 2048,
    spineBend: 0.012,
    gutterShading: 0,
  }}
/>
```

The moving paper uses a lightweight, two-sided translucent-paper lighting model plus one configurable native Three.js shadow map (2048px by default). Its brightness is normalized against the flat page, so starting a turn does not dim the print. Resting pages are shallow segmented meshes with physically lit normals; they receive the turning sheet's shadow directly instead of using a fixed screen-space spine stripe or transparent receiver. The shadow fades to zero at both flat endpoints, and its horizontal cast direction follows the deformed sheet so it stays beneath the same side instead of jumping across the spine. Scene-light energy is normalized for the physically based resting-page material so PDF and image textures retain their original brightness.

## Local demo

```bash
npm install
npm run dev
```

The demo starts with generated image pages and accepts a local PDF without uploading it anywhere. Development builds also list every PDF copied into `public/pdfs/` in the header dropdown; these fixtures are ignored by Git and excluded from the npm package.
