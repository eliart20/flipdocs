import { useEffect, useMemo, useRef, useState } from "react";
import {
  FlipBook,
  type FlipBookBodySettings,
  type FlipBookCornerSettings,
  type FlipBookCurlSettings,
  type FlipBookHandle,
  type FlipBookLoadProgressEvent,
  type FlipBookMobileSettings,
  type FlipBookRenderSettings,
  type FlipBookRiffleSettings,
  type FlipBookSoundSettings,
  type FlipBookSource,
  type FlipBookZoomSettings,
} from "../src";

const initialPhysics: FlipBookCurlSettings = {
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

const initialRendering: FlipBookRenderSettings = {
  resolutionScale: 2,
  ambientLight: 0.88,
  directionalLight: 0.12,
  foldContrast: 0.06,
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

const initialCorner: FlipBookCornerSettings = {
  enabled: true,
  size: 0.18,
  lift: 0.075,
  pull: 0.08,
};

const initialZoom: FlipBookZoomSettings = {
  initial: 1,
  min: 0.75,
  max: 4,
  step: 0.25,
  wheel: true,
  toPointer: true,
  pan: true,
};

const initialMobile: FlipBookMobileSettings = {
  enabled: true,
  breakpoint: 900,
  pagePeek: 0.08,
  doubleTapZoom: true,
};

const initialBody: FlipBookBodySettings = {
  enabled: true,
  thickness: 0.055,
  coverColor: "#463527",
  overhang: 0.014,
};

const initialRiffle: FlipBookRiffleSettings = {
  enabled: true,
  maxSheets: 3,
};

const initialSound: FlipBookSoundSettings = {
  enabled: false,
  volume: 0.5,
};

interface LocalPdfFixture {
  id: string;
  name: string;
  size: number;
  url: string;
}

function formatBytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 10 ? `${Math.round(megabytes)} MB` : `${megabytes.toFixed(1)} MB`;
}

function svgPage(index: number): string {
  const palettes = [
    ["#f3ead7", "#8f3f32"],
    ["#e9edf3", "#274764"],
    ["#eee9df", "#574634"],
    ["#e8efe7", "#365842"],
  ];
  const [paper, ink] = palettes[index % palettes.length];
  const page = index + 1;
  const isCover = index === 0;
  const lines = Array.from({ length: isCover ? 0 : 17 }, (_, line) => {
    const y = 260 + line * 36;
    const width = line % 5 === 4 ? 390 : 520;
    return `<rect x="90" y="${y}" width="${width}" height="7" rx="3.5" fill="${ink}" opacity="${0.16 + (line % 3) * 0.035}"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1040" viewBox="0 0 720 1040">
    <rect width="720" height="1040" fill="${paper}"/>
    <rect x="24" y="24" width="672" height="992" rx="4" fill="none" stroke="${ink}" stroke-opacity=".12"/>
    ${isCover ? `<circle cx="360" cy="300" r="124" fill="none" stroke="${ink}" stroke-width="2" opacity=".5"/><path d="M245 320 C295 160 425 160 475 320 C410 270 310 270 245 320Z" fill="${ink}" opacity=".85"/>` : ""}
    <text x="${isCover ? 360 : 90}" y="${isCover ? 520 : 135}" text-anchor="${isCover ? "middle" : "start"}" font-family="Georgia,serif" font-size="${isCover ? 72 : 34}" fill="${ink}">${isCover ? "FLIPDOCS" : `Chapter ${Math.ceil(page / 2)}`}</text>
    <text x="${isCover ? 360 : 90}" y="${isCover ? 574 : 194}" text-anchor="${isCover ? "middle" : "start"}" font-family="system-ui,sans-serif" font-size="${isCover ? 18 : 18}" letter-spacing="${isCover ? 6 : 1}" fill="${ink}" opacity=".72">${isCover ? "THE WEBGL READER" : `A fast, tactile page-turning experience — ${page}`}</text>
    ${lines}
    <text x="360" y="972" text-anchor="middle" font-family="Georgia,serif" font-size="16" fill="${ink}" opacity=".55">${page}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function App() {
  const book = useRef<FlipBookHandle>(null);
  const demoImages = useMemo(() => Array.from({ length: 14 }, (_, index) => svgPage(index)), []);
  const [source, setSource] = useState<FlipBookSource>({ type: "images", pages: demoImages });
  const [label, setLabel] = useState("Generated image pages");
  const [loadProgress, setLoadProgress] = useState<FlipBookLoadProgressEvent>();
  const [localPdfs, setLocalPdfs] = useState<LocalPdfFixture[]>([]);
  const [selectedLocalPdf, setSelectedLocalPdf] = useState("");
  const [physics, setPhysics] = useState<FlipBookCurlSettings>(initialPhysics);
  const [corner, setCorner] = useState<FlipBookCornerSettings>(initialCorner);
  const [rendering, setRendering] = useState<FlipBookRenderSettings>(initialRendering);
  const [zoom, setZoom] = useState<FlipBookZoomSettings>(initialZoom);
  const [mobile, setMobile] = useState<FlipBookMobileSettings>(initialMobile);
  const [bookBody, setBookBody] = useState<FlipBookBodySettings>(initialBody);
  const [riffle, setRiffle] = useState<FlipBookRiffleSettings>(initialRiffle);
  const [sound, setSound] = useState<FlipBookSoundSettings>(initialSound);
  const [links, setLinks] = useState(false);
  const [thumbnails, setThumbnails] = useState(false);
  const [direction, setDirection] = useState<"auto" | "ltr" | "rtl">("auto");
  const [settingsOpen, setSettingsOpen] = useState(() =>
    typeof window === "undefined" || !window.matchMedia(
      "(max-width: 760px), (max-width: 900px) and (orientation: landscape)",
    ).matches,
  );

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const controller = new AbortController();
    void fetch("/__flipdocs/pdfs", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Could not list local PDFs (${response.status}).`);
        return response.json() as Promise<LocalPdfFixture[]>;
      })
      .then(setLocalPdfs)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLocalPdfs([]);
      });
    return () => controller.abort();
  }, []);

  const tune = (key: keyof FlipBookCurlSettings, value: number) => {
    setPhysics((current) => ({ ...current, [key]: value }));
  };

  const tuneRendering = <Key extends keyof FlipBookRenderSettings>(
    key: Key,
    value: FlipBookRenderSettings[Key],
  ) => {
    setRendering((current) => ({ ...current, [key]: value }));
  };

  const tuneCorner = <Key extends keyof FlipBookCornerSettings>(
    key: Key,
    value: FlipBookCornerSettings[Key],
  ) => {
    setCorner((current) => ({ ...current, [key]: value }));
  };

  const tuneZoom = <Key extends keyof FlipBookZoomSettings>(
    key: Key,
    value: FlipBookZoomSettings[Key],
  ) => {
    setZoom((current) => ({ ...current, [key]: value }));
  };

  const tuneMobile = <Key extends keyof FlipBookMobileSettings>(
    key: Key,
    value: FlipBookMobileSettings[Key],
  ) => {
    setMobile((current) => ({ ...current, [key]: value }));
  };

  const openPdf = (file?: File) => {
    if (!file) return;
    setSelectedLocalPdf("");
    setLoadProgress(undefined);
    setSource({ type: "pdf", src: file, lazy: true });
    setLabel(file.name);
  };

  const openSamplePdf = () => {
    setSelectedLocalPdf("");
    setLoadProgress(undefined);
    setSource({
      type: "pdf",
      src: "https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf",
      lazy: true,
    });
    setLabel("PDF.js sample PDF");
  };

  const openLocalPdf = (id: string) => {
    const pdf = localPdfs.find((candidate) => candidate.id === id);
    if (!pdf) return;
    setSelectedLocalPdf(id);
    setLoadProgress(undefined);
    setSource({ type: "pdf", src: pdf.url, lazy: true });
    setLabel(`${pdf.name} · ${formatBytes(pdf.size)}`);
  };

  return (
    <main className="demo">
      <header className="demo__header">
        <a className="demo__brand" href="#viewer" aria-label="Flipdocs home">
          <span className="demo__mark">F</span>
          <span>flipdocs</span>
        </a>
        <div className="demo__actions">
          <span className="demo__source-status">
            <span className="demo__source">{label}</span>
            {loadProgress && (
              <span className="demo__source-progress" data-testid="pdf-load-progress">
                {formatBytes(loadProgress.loadedBytes)}{loadProgress.totalBytes ? ` / ${formatBytes(loadProgress.totalBytes)}` : ""} read
              </span>
            )}
          </span>
          {import.meta.env.DEV && (
            <select
              className="demo__pdf-picker"
              aria-label="Choose a local PDF"
              value={selectedLocalPdf}
              disabled={localPdfs.length === 0}
              onChange={(event) => openLocalPdf(event.currentTarget.value)}
            >
              <option value="">{localPdfs.length ? `Local PDFs (${localPdfs.length})` : "Loading local PDFs…"}</option>
              {localPdfs.map((pdf) => (
                <option key={pdf.id} value={pdf.id}>{pdf.name} · {formatBytes(pdf.size)}</option>
              ))}
            </select>
          )}
          <button className="demo__sample" type="button" onClick={openSamplePdf}>Try sample PDF</button>
          <label className="demo__upload">
            Open PDF
            <input data-testid="pdf-file-input" type="file" accept="application/pdf" onChange={(event) => openPdf(event.target.files?.[0])} />
          </label>
        </div>
      </header>

      <section className="demo__intro">
        <div>
          <p className="demo__eyebrow">React · Three.js · PDF.js</p>
          <h1>Paper motion,<br /><em>without the weight.</em></h1>
        </div>
        <div className="demo__copy">
          <p>A small React library for PDFs and image sequences. It renders only when something changes and keeps just the nearby pages on the GPU.</p>
          <div className="demo__buttons">
            <button onClick={() => book.current?.setFlipProgress(0.52, "next")}>Hold mid-flip</button>
            <button className="demo__button--quiet" onClick={() => book.current?.setFlipProgress(0.48, "previous")}>Hold previous</button>
            <button className="demo__button--quiet" onClick={() => book.current?.completeFlip()}>Complete</button>
          </div>
        </div>
      </section>

      <section className="demo__viewer" id="viewer">
        <FlipBook
          ref={book}
          source={source}
          curl={physics}
          corner={corner}
          render={rendering}
          zoom={zoom}
          mobile={mobile}
          body={bookBody}
          riffle={riffle}
          sound={sound}
          links={links}
          showThumbnails={thumbnails}
          direction={direction}
          ariaLabel="Flipdocs demonstration book"
          onLoadProgress={setLoadProgress}
        />
        <details
          className="demo__physics"
          open={settingsOpen}
          onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
        >
          <summary>Paper settings</summary>
          <h3>Motion</h3>
          <label>
            <span>Curl radius <output>{Math.round(physics.radius * 1000) / 10}%</output></span>
            <input type="range" min="0.015" max="0.25" step="0.005" value={physics.radius} onChange={(event) => tune("radius", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Curl limit <output>{Math.round(physics.radiusLimit * 100)}%</output></span>
            <input type="range" min="0.25" max="0.98" step="0.01" value={physics.radiusLimit} onChange={(event) => tune("radiusLimit", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Vertical tracking <output>{Math.round(physics.verticalPull * 100)}%</output></span>
            <input type="range" min="0" max="1" step="0.02" value={physics.verticalPull} onChange={(event) => tune("verticalPull", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Spine stiffness <output>{Math.round(physics.binding * 100)}%</output></span>
            <input type="range" min="0.02" max="0.35" step="0.01" value={physics.binding} onChange={(event) => tune("binding", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Drag resistance <output>{physics.dragResistance.toFixed(2)}×</output></span>
            <input type="range" min="0.4" max="2" step="0.05" value={physics.dragResistance} onChange={(event) => tune("dragResistance", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Release threshold <output>{Math.round(physics.snapThreshold * 100)}%</output></span>
            <input type="range" min="0.05" max="0.65" step="0.01" value={physics.snapThreshold} onChange={(event) => tune("snapThreshold", event.currentTarget.valueAsNumber)} />
          </label>
          <label className="demo__toggle">
            <span>Corner hover <output>{corner.enabled ? "On" : "Off"}</output></span>
            <input type="checkbox" checked={corner.enabled} onChange={(event) => tuneCorner("enabled", event.currentTarget.checked)} />
          </label>
          <label>
            <span>Corner hit area <output>{Math.round(corner.size * 100)}%</output></span>
            <input type="range" min="0.06" max="0.35" step="0.01" value={corner.size} disabled={!corner.enabled} onChange={(event) => tuneCorner("size", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Hover lift <output>{Math.round(corner.lift * 1000) / 10}%</output></span>
            <input type="range" min="0.015" max="0.22" step="0.005" value={corner.lift} disabled={!corner.enabled} onChange={(event) => tuneCorner("lift", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Corner pull <output>{Math.round(corner.pull * 100)}%</output></span>
            <input type="range" min="0" max="0.35" step="0.01" value={corner.pull} disabled={!corner.enabled} onChange={(event) => tuneCorner("pull", event.currentTarget.valueAsNumber)} />
          </label>
          <label className="demo__toggle">
            <span>Velocity fling <output>{physics.velocityFling ? "On" : "Off"}</output></span>
            <input type="checkbox" checked={physics.velocityFling} onChange={(event) => {
              const velocityFling = event.currentTarget.checked;
              setPhysics((current) => ({ ...current, velocityFling }));
            }} />
          </label>
          <label>
            <span>Settle wobble <output>{Math.round(physics.settleWobble * 100)}%</output></span>
            <input type="range" min="0" max="1" step="0.05" value={physics.settleWobble} onChange={(event) => tune("settleWobble", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Cover stiffness <output>{Math.round(physics.coverStiffness * 100)}%</output></span>
            <input type="range" min="0" max="1" step="0.05" value={physics.coverStiffness} onChange={(event) => tune("coverStiffness", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Sheet resolution <output>{physics.segments} segments</output></span>
            <input type="range" min="36" max="96" step="4" value={physics.segments} onChange={(event) => tune("segments", event.currentTarget.valueAsNumber)} />
          </label>
          <button type="button" onClick={() => { setPhysics(initialPhysics); setCorner(initialCorner); }}>Reset motion</button>
          <h3>Book &amp; extras</h3>
          <label className="demo__toggle">
            <span>Book body <output>{bookBody.enabled ? "On" : "Off"}</output></span>
            <input type="checkbox" checked={bookBody.enabled} onChange={(event) => {
              const enabled = event.currentTarget.checked;
              setBookBody((current) => ({ ...current, enabled }));
            }} />
          </label>
          <label>
            <span>Body thickness <output>{Math.round(bookBody.thickness * 1000) / 10}%</output></span>
            <input type="range" min="0.01" max="0.14" step="0.005" value={bookBody.thickness} disabled={!bookBody.enabled} onChange={(event) => {
              const thickness = event.currentTarget.valueAsNumber;
              setBookBody((current) => ({ ...current, thickness }));
            }} />
          </label>
          <label className="demo__toggle">
            <span>Riffle on jumps <output>{riffle.enabled ? "On" : "Off"}</output></span>
            <input type="checkbox" checked={riffle.enabled} onChange={(event) => {
              const enabled = event.currentTarget.checked;
              setRiffle((current) => ({ ...current, enabled }));
            }} />
          </label>
          <label className="demo__toggle">
            <span>Page-turn sound <output>{sound.enabled ? "On" : "Off"}</output></span>
            <input type="checkbox" checked={sound.enabled} onChange={(event) => {
              const enabled = event.currentTarget.checked;
              setSound((current) => ({ ...current, enabled }));
            }} />
          </label>
          <label className="demo__toggle">
            <span>PDF links <output>{links ? "On" : "Off"}</output></span>
            <input type="checkbox" checked={links} onChange={(event) => setLinks(event.currentTarget.checked)} />
          </label>
          <label className="demo__toggle">
            <span>Thumbnails <output>{thumbnails ? "On" : "Off"}</output></span>
            <input type="checkbox" checked={thumbnails} onChange={(event) => setThumbnails(event.currentTarget.checked)} />
          </label>
          <div className="demo__buttons">
            <button type="button" onClick={() => book.current?.goToPage(12)}>Riffle to page 13</button>
            <button className="demo__button--quiet" type="button" onClick={() => book.current?.goToPage(0)}>Back to cover</button>
          </div>
          <h3>PDF quality &amp; light</h3>
          <label>
            <span>Page resolution <output>{rendering.resolutionScale.toFixed(2)}×</output></span>
            <input type="range" min="0.75" max="3" step="0.05" value={rendering.resolutionScale} onChange={(event) => tuneRendering("resolutionScale", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Ambient light <output>{Math.round(rendering.ambientLight * 100)}%</output></span>
            <input type="range" min="0.35" max="1.1" step="0.01" value={rendering.ambientLight} onChange={(event) => tuneRendering("ambientLight", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Key light <output>{Math.round(rendering.directionalLight * 100)}%</output></span>
            <input type="range" min="0" max="0.65" step="0.01" value={rendering.directionalLight} onChange={(event) => tuneRendering("directionalLight", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Fold contrast <output>{Math.round(rendering.foldContrast * 100)}%</output></span>
            <input type="range" min="0" max="0.5" step="0.01" value={rendering.foldContrast} onChange={(event) => tuneRendering("foldContrast", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Light angle <output>{Math.round(rendering.lightAngle)}°</output></span>
            <input type="range" min="-180" max="180" step="1" value={rendering.lightAngle} onChange={(event) => tuneRendering("lightAngle", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Light height <output>{Math.round(rendering.lightElevation * 100)}%</output></span>
            <input type="range" min="0.15" max="1" step="0.01" value={rendering.lightElevation} onChange={(event) => tuneRendering("lightElevation", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Paper sheen <output>{Math.round(rendering.sheen * 100)}%</output></span>
            <input type="range" min="0" max="1" step="0.02" value={rendering.sheen} onChange={(event) => tuneRendering("sheen", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Resting page bend <output>{(rendering.spineBend * 100).toFixed(1)}%</output></span>
            <input type="range" min="0" max="0.06" step="0.002" value={rendering.spineBend} onChange={(event) => tuneRendering("spineBend", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Extra gutter shading <output>{Math.round(rendering.gutterShading * 100)}%</output></span>
            <input type="range" min="0" max="1" step="0.02" value={rendering.gutterShading} onChange={(event) => tuneRendering("gutterShading", event.currentTarget.valueAsNumber)} />
          </label>
          <label className="demo__toggle">
            <span>Cast shadow <output>{rendering.shadows ? "On" : "Off"}</output></span>
            <input type="checkbox" checked={rendering.shadows} onChange={(event) => tuneRendering("shadows", event.currentTarget.checked)} />
          </label>
          <label>
            <span>Shadow strength <output>{Math.round(rendering.shadowOpacity * 100)}%</output></span>
            <input type="range" min="0" max="0.55" step="0.01" value={rendering.shadowOpacity} disabled={!rendering.shadows} onChange={(event) => tuneRendering("shadowOpacity", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Shadow softness <output>{rendering.shadowSoftness.toFixed(1)}</output></span>
            <input type="range" min="0.5" max="7" step="0.25" value={rendering.shadowSoftness} disabled={!rendering.shadows} onChange={(event) => tuneRendering("shadowSoftness", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Shadow resolution <output>{rendering.shadowResolution}px</output></span>
            <select value={rendering.shadowResolution} disabled={!rendering.shadows} onChange={(event) => tuneRendering("shadowResolution", Number(event.currentTarget.value))}>
              <option value="512">512 · fastest</option>
              <option value="1024">1024</option>
              <option value="2048">2048 · default</option>
              <option value="4096">4096 · sharpest</option>
            </select>
          </label>
          <button type="button" onClick={() => setRendering(initialRendering)}>Reset rendering</button>
          <h3>View</h3>
          <label>
            <span>Reading direction <output>{direction}</output></span>
            <select value={direction} onChange={(event) => setDirection(event.currentTarget.value as "auto" | "ltr" | "rtl")}>
              <option value="auto">Auto (PDF preference)</option>
              <option value="ltr">Left to right</option>
              <option value="rtl">Right to left (Hebrew)</option>
            </select>
          </label>
          <label className="demo__toggle">
            <span>Mobile page focus <output>{mobile.enabled ? "On" : "Off"}</output></span>
            <input type="checkbox" checked={mobile.enabled} onChange={(event) => tuneMobile("enabled", event.currentTarget.checked)} />
          </label>
          <label>
            <span>Opposite-page peek <output>{Math.round(mobile.pagePeek * 100)}%</output></span>
            <input type="range" min="0.02" max="0.24" step="0.01" value={mobile.pagePeek} disabled={!mobile.enabled} onChange={(event) => tuneMobile("pagePeek", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Mobile breakpoint <output>{mobile.breakpoint}px</output></span>
            <input type="range" min="480" max="1200" step="20" value={mobile.breakpoint} disabled={!mobile.enabled} onChange={(event) => tuneMobile("breakpoint", event.currentTarget.valueAsNumber)} />
          </label>
          <label className="demo__toggle">
            <span>Wheel zoom <output>{zoom.wheel ? "On" : "Off"}</output></span>
            <input type="checkbox" checked={zoom.wheel} onChange={(event) => tuneZoom("wheel", event.currentTarget.checked)} />
          </label>
          <label>
            <span>Zoom step <output>{Math.round(zoom.step * 100)}%</output></span>
            <input type="range" min="0.05" max="0.75" step="0.05" value={zoom.step} onChange={(event) => tuneZoom("step", event.currentTarget.valueAsNumber)} />
          </label>
          <label>
            <span>Maximum zoom <output>{zoom.max.toFixed(1)}×</output></span>
            <input type="range" min="1" max="6" step="0.25" value={zoom.max} onChange={(event) => tuneZoom("max", event.currentTarget.valueAsNumber)} />
          </label>
          <button type="button" onClick={() => { setZoom(initialZoom); setMobile(initialMobile); book.current?.resetZoom(); }}>Reset view</button>
        </details>
        <p className="demo__hint demo__hint--desktop">Hover a corner · drag or click · wheel or + / − to zoom</p>
        <p className="demo__hint demo__hint--mobile">Flick inner half · drag outer half · swipe to move</p>
        <p className="demo__resize-hint">Resize viewer ↘</p>
      </section>

      <section className="demo__metrics" aria-label="Performance architecture">
        <article><strong>2</strong><span>runtime libraries<br />Three.js + PDF.js</span></article>
        <article><strong>1</strong><span>deforming mesh<br />only during a turn</span></article>
        <article><strong>0</strong><span>idle frames<br />rendered per second</span></article>
      </section>
    </main>
  );
}
