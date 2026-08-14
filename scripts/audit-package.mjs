import { execFileSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
const packedOutput = npmCli
  ? execFileSync(
      process.execPath,
      [npmCli, "pack", "--dry-run", "--json"],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    )
  : execFileSync(
      "npm",
      ["pack", "--dry-run", "--json"],
      { cwd: new URL("..", import.meta.url), encoding: "utf8", shell: process.platform === "win32" },
    );
const packed = JSON.parse(packedOutput);
const manifest = packed[0];
if (!manifest) throw new Error("npm did not return a package manifest.");

const files = new Map(manifest.files.map((file) => [file.path, file]));
const required = [
  "dist/flipdocs.js",
  "dist/flipdocs.css",
  "dist/index.d.ts",
  "dist/pdf.worker.min.mjs",
  "README.md",
  "LICENSE",
];
for (const path of required) {
  if (!files.has(path)) throw new Error(`Package is missing ${path}.`);
}

const forbidden = [...files.keys()].filter((path) =>
  path.startsWith("public/") || path.includes("/pdfs/") || path.endsWith(".pdf"),
);
if (forbidden.length > 0) {
  throw new Error(`Development fixtures leaked into the package: ${forbidden.join(", ")}`);
}

const coreBytes = files.get("dist/flipdocs.js").size;
if (coreBytes > 160_000) {
  throw new Error(`Core ESM bundle grew to ${coreBytes} bytes (limit: 160000).`);
}
if (manifest.size > 650_000) {
  throw new Error(`Packed library grew to ${manifest.size} bytes (limit: 650000).`);
}

console.log(JSON.stringify({
  package: manifest.id,
  packedBytes: manifest.size,
  unpackedBytes: manifest.unpackedSize,
  coreBytes,
  entries: manifest.entryCount,
}, null, 2));
