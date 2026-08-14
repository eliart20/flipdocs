import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const localPdfDirectory = resolve(__dirname, "public/pdfs");
const localPdfs = existsSync(localPdfDirectory)
  ? readdirSync(localPdfDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map((entry) => {
      const filePath = resolve(localPdfDirectory, entry.name);
      return { id: entry.name, name: entry.name, filePath, size: statSync(filePath).size };
    })
    .sort((left, right) => left.name.localeCompare(right.name))
  : [];
const pdfById = new Map(localPdfs.map((pdf) => [pdf.id, pdf]));
const yearbook = pdfById.get("Bais Yaakov Pomona - Final Yearbook combined.pdf");

function localPdfRangeFixture() {
  let requestCount = 0;
  let requestedBytes = 0;
  let completedBytes = 0;
  let ranges: Array<{ start: number; end: number }> = [];

  return {
    name: "flipdocs-yearbook-range-fixture",
    configureServer(server: { middlewares: { use(handler: Function): void } }) {
      server.middlewares.use((request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, next: () => void) => {
        const requestUrl = new URL(request.url ?? "/", "http://localhost");
        if (requestUrl.pathname === "/__flipdocs/pdfs") {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify(localPdfs.map((pdf) => ({
            id: pdf.id,
            name: pdf.name,
            size: pdf.size,
            url: `/__flipdocs/pdf?id=${encodeURIComponent(pdf.id)}`,
          }))));
          return;
        }
        if (requestUrl.pathname === "/__flipdocs/yearbook-stats") {
          if (requestUrl.searchParams.get("reset") === "1") {
            requestCount = 0;
            requestedBytes = 0;
            completedBytes = 0;
            ranges = [];
          }
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({
            requestCount,
            requestedBytes,
            completedBytes,
            ranges,
            totalBytes: yearbook?.size ?? 0,
          }));
          return;
        }
        const pdf = requestUrl.pathname === "/yearbook.pdf"
          ? yearbook
          : requestUrl.pathname === "/__flipdocs/pdf"
            ? pdfById.get(requestUrl.searchParams.get("id") ?? "")
            : undefined;
        if (!pdf) {
          if (requestUrl.pathname === "/yearbook.pdf" || requestUrl.pathname === "/__flipdocs/pdf") {
            response.statusCode = 404;
            response.end("PDF fixture not found");
            return;
          }
          next();
          return;
        }

        // Stat per request: fixtures can be edited (e.g. re-stamped metadata)
        // while the server runs, and a stale size breaks byte-range clients.
        const totalBytes = statSync(pdf.filePath).size;
        const match = /^bytes=(\d+)-(\d*)$/i.exec(request.headers.range ?? "");
        const start = match ? Number(match[1]) : 0;
        const requestedEnd = match?.[2] ? Number(match[2]) : totalBytes - 1;
        const end = Math.min(totalBytes - 1, Math.max(start, requestedEnd));
        const length = end - start + 1;
        const trackYearbook = pdf === yearbook && request.method !== "HEAD";
        if (trackYearbook) {
          requestCount += 1;
          requestedBytes += length;
          ranges.push({ start, end });
        }

        response.statusCode = match ? 206 : 200;
        response.setHeader("Accept-Ranges", "bytes");
        response.setHeader("Content-Length", String(length));
        response.setHeader("Content-Type", "application/pdf");
        response.setHeader("Cache-Control", "no-store");
        if (match) response.setHeader("Content-Range", `bytes ${start}-${end}/${totalBytes}`);
        if (request.method === "HEAD") {
          response.end();
          return;
        }

        let streamedBytes = 0;
        const stream = createReadStream(pdf.filePath, { start, end });
        stream.on("data", (chunk) => { streamedBytes += chunk.length; });
        response.on("finish", () => {
          if (trackYearbook) completedBytes += streamedBytes;
        });
        stream.on("error", (error) => {
          if (!response.headersSent) response.statusCode = 500;
          response.end(error.message);
        });
        stream.pipe(response);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localPdfRangeFixture()],
  build: {
    // The demo's local PDF fixtures are intentionally not part of the npm
    // library package. The worker is copied explicitly after the build.
    copyPublicDir: false,
    // Keep PDF.js's worker out of the core library. Image books should never
    // download or parse the PDF runtime.
    assetsInlineLimit: 0,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: "flipdocs",
    },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime", "three", "pdfjs-dist"],
      output: {
        assetFileNames: (asset) =>
          asset.name?.endsWith(".css") ? "flipdocs.css" : "assets/[name]-[hash][extname]",
      },
    },
    sourcemap: true,
    target: "es2022",
  },
});
