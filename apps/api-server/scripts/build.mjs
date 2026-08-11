import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(packageRoot, "dist");

async function main() {
  // Build is a local smoke compile: load entrypoints and write a small dist manifest.
  // No bundler and no network-fetched tools.
  const indexUrl = pathToFileURL(path.join(packageRoot, "src/index.mjs")).href;
  const mod = await import(indexUrl);
  const required = [
    "createMockApi",
    "createServer",
    "listen",
    "buildFixedLayerManifest",
    "redactForLog",
  ];
  for (const name of required) {
    if (typeof mod[name] !== "function") {
      throw new Error(`build failed: export ${name} is not a function`);
    }
  }

  // Instantiate service once to ensure contracts import resolves.
  const api = mod.createMockApi({
    autoAdvance: false,
    logSink: { info() {}, warn() {}, error() {}, log() {} },
  });
  if (!api || typeof api.createAsset !== "function") {
    throw new Error("build failed: createMockApi did not return a service");
  }

  await mkdir(distDir, { recursive: true });
  const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const manifest = {
    name: pkg.name,
    version: pkg.version,
    builtAt: new Date().toISOString(),
    entry: "src/index.mjs",
    endpoints: [
      "POST /v1/assets",
      "POST /v1/jobs",
      "GET /v1/jobs/{id}",
      "GET /v1/jobs/{id}/events",
      "POST /v1/jobs/{id}/cancel",
      "GET /v1/jobs/{id}/manifest",
    ],
    runtime: "node-builtins-only",
  };
  await writeFile(path.join(distDir, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await access(path.join(distDir, "build-manifest.json"));
  console.log("api-server build passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
