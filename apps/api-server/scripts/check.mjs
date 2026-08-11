import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");

async function mustExist(relativePath) {
  const absolute = path.join(packageRoot, relativePath);
  await access(absolute);
  return absolute;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const requiredFiles = [
  "package.json",
  "README.md",
  "src/index.mjs",
  "src/http.mjs",
  "src/service.mjs",
  "src/lifecycle.mjs",
  "src/manifest-factory.mjs",
  "src/store.mjs",
  "src/redact.mjs",
  "src/errors.mjs",
  "src/util.mjs",
  "scripts/check.mjs",
  "scripts/build.mjs",
  "scripts/start.mjs",
];

const requiredScripts = ["check", "test", "build", "start"];

async function main() {
  const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert(pkg.name === "@cinevfx/api-server", "package name must be @cinevfx/api-server");
  assert(pkg.type === "module", "package must be ESM");
  assert(!pkg.dependencies && !pkg.devDependencies, "package must have no external dependencies");
  for (const script of requiredScripts) {
    assert(pkg.scripts?.[script], `missing script ${script}`);
  }

  for (const file of requiredFiles) {
    await mustExist(file);
  }

  // Ensure frozen contracts package is present for imports.
  const contractsPkg = path.join(repoRoot, "packages/contracts/package.json");
  await access(contractsPkg);

  // Syntax/load check of public entrypoints.
  const indexUrl = pathToFileURL(path.join(packageRoot, "src/index.mjs")).href;
  const mod = await import(indexUrl);
  for (const exportName of [
    "createMockApi",
    "createServer",
    "listen",
    "createStore",
    "createLogger",
    "redactForLog",
    "buildFixedLayerManifest",
    "HttpError",
  ]) {
    assert(typeof mod[exportName] === "function" || typeof mod[exportName] === "object", `missing export ${exportName}`);
  }

  // Confirm six endpoints are documented in README.
  const readme = await readFile(path.join(packageRoot, "README.md"), "utf8");
  for (const endpoint of [
    "POST /v1/assets",
    "POST /v1/jobs",
    "GET /v1/jobs/{id}",
    "GET /v1/jobs/{id}/events",
    "POST /v1/jobs/{id}/cancel",
    "GET /v1/jobs/{id}/manifest",
  ]) {
    assert(readme.includes(endpoint), `README must document ${endpoint}`);
  }

  // No accidental package-lock / node_modules dependency on network packages.
  const entries = await readdir(packageRoot);
  assert(!entries.includes("package-lock.json"), "package-lock.json is not allowed");

  // Source files must only import relative paths or node: built-ins.
  const srcDir = path.join(packageRoot, "src");
  const srcFiles = (await readdir(srcDir)).filter((name) => name.endsWith(".mjs"));
  for (const fileName of srcFiles) {
    const text = await readFile(path.join(srcDir, fileName), "utf8");
    const importMatches = text.matchAll(/from\s+["']([^"']+)["']/g);
    for (const match of importMatches) {
      const spec = match[1];
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      throw new Error(`${fileName} imports disallowed specifier ${spec}`);
    }
  }

  await access(path.join(repoRoot, "packages/contracts/src/index.mjs"));

  console.log("api-server check passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
