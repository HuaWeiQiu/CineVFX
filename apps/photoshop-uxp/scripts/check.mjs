/**
 * Package-local structural check for the UXP development shell.
 * Does not require Photoshop or network access.
 */

import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";
import { bundleClassicEntry } from "./bundle-classic.mjs";
import { validateUxpManifest } from "./validate-uxp-manifest.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const requiredFiles = [
  "package.json",
  "manifest.json",
  "index.html",
  "index.js",
  "styles.css",
  "README.md",
  "src/public-api.mjs",
  "src/public-api.d.mts",
  "src/client/http-client.mjs",
  "src/client/http-client.d.mts",
  "src/client/contract-shapes.mjs",
  "src/task/task-state.mjs",
  "src/proxy/proxy-plan.mjs",
  "src/manifest/validate-manifest.mjs",
  "src/import/import-plan.mjs",
  "src/safety/network-boundary.mjs",
  "src/safety/data-snapshot.mjs",
  "src/effects/glow-plan.mjs",
  "src/effects/local-glow-service.mjs",
  "src/host/photoshop-glow-host.mjs",
  "src/log/redact.mjs",
  "src/ui/panel-controller.mjs",
  "src/ui/panel-workflow.mjs",
  "src/constants.mjs",
  "scripts/bundle-classic.mjs",
  "scripts/plugin-artifact.mjs",
  "scripts/validate-uxp-manifest.mjs",
  "tsconfig.types.json",
  "tests/types/public-api.ts",
];

for (const rel of requiredFiles) {
  await access(join(root, rel));
}

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (pkg.name !== "@cinevfx/photoshop-uxp") {
  throw new Error("package name must be @cinevfx/photoshop-uxp");
}
for (const script of ["check", "test", "build"]) {
  if (!pkg.scripts?.[script]) {
    throw new Error(`package.json missing scripts.${script}`);
  }
}
for (const exportPath of [".", "./client"]) {
  const conditions = Object.keys(pkg.exports?.[exportPath] ?? {});
  if (conditions[0] !== "types" || conditions[1] !== "import") {
    throw new Error(`package export ${exportPath} must order types before import`);
  }
}

const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const manifestErrors = validateUxpManifest(manifest);
if (manifestErrors.length > 0) {
  throw new Error(`manifest is outside the strict UXP v5 subset: ${JSON.stringify(manifestErrors)}`);
}
if (manifest.version !== pkg.version) {
  throw new Error("package.json and manifest.json versions must match");
}

const readme = await readFile(join(root, "README.md"), "utf8");
const requiredReadmeSnippets = [
  "UNVERIFIED",
  "Windows",
  "macOS",
  "manifestVersion",
  "Mock",
  "127.0.0.1:8787",
];
for (const snippet of requiredReadmeSnippets) {
  if (!readme.includes(snippet)) {
    throw new Error(`README.md must document ${snippet}`);
  }
}

const unverifiedClaims = [
  "proxy export",
  "executeAsModal",
  "placement",
  "source preservation",
  "Windows runtime",
  "one-click signed",
  "plugin ID",
  "marketplace",
  "runtime success",
];
const readmeLower = readme.toLowerCase();
for (const claim of unverifiedClaims) {
  if (!readmeLower.includes(claim.toLowerCase())) {
    throw new Error(`README.md must mark "${claim}" as documented/UNVERIFIED`);
  }
}

// Ensure no accidental external runtime dependency declarations.
if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  throw new Error("photoshop-uxp must not declare runtime dependencies");
}
if (
  JSON.stringify(pkg.devDependencies ?? {}) !==
  JSON.stringify({ typescript: "7.0.2" })
) {
  throw new Error("photoshop-uxp may declare only the pinned TypeScript check dependency");
}

// Smoke-import public API.
const api = await import(pathToFileURL(join(root, "src/public-api.mjs")).href);
for (const key of [
  "createCinevfxClient",
  "createTaskController",
  "planProxyExport",
  "validateLayerManifest",
  "planManifestImport",
  "createWriteScopeGuard",
  "planGlowEffect",
  "createLocalGlowService",
  "createPhotoshopGlowHost",
  "createPanelWorkflow",
  "MOCK_ENDPOINTS",
  "UNVERIFIED",
]) {
  if (!(key in api)) {
    throw new Error(`public API missing export ${key}`);
  }
}

// Fast structural declaration checks; package check follows with real tsc noEmit.
const declarationFiles = [
  "src/public-api.d.mts",
  "src/client/http-client.d.mts",
];
for (const rel of declarationFiles) {
  await access(join(root, rel));
}
const clientDts = await readFile(join(root, "src/client/http-client.d.mts"), "utf8");
const publicDts = await readFile(join(root, "src/public-api.d.mts"), "utf8");
for (const token of [
  "export type MediaType",
  "export type AlphaMode",
  "export type ColorSpace",
  "export type BlendMode",
  "export type ForbiddenSourceOp",
  "export type JobStatus =",
  "export type JobEvent =",
  "export interface EffectSpec",
  "export interface LayerManifest",
  "operationsForbidden: ForbiddenSourceOp[]",
]) {
  if (!clientDts.includes(token)) {
    throw new Error(`http-client.d.mts missing declaration parity token: ${token}`);
  }
}

const declarationSpecifiers = [
  ...publicDts.matchAll(/\bfrom\s+["']([^"']+)["']/g),
].map((match) => match[1]);
if (declarationSpecifiers.length === 0) {
  throw new Error("public-api.d.mts must reference the client declaration surface");
}
for (const specifier of declarationSpecifiers) {
  if (!specifier.endsWith(".mjs")) {
    throw new Error(`public-api.d.mts must use explicit ESM specifiers: ${specifier}`);
  }
  const runtimePath = join(root, "src", specifier);
  const declarationPath = runtimePath.replace(/\.mjs$/, ".d.mts");
  await access(runtimePath);
  await access(declarationPath);
}
for (const forbidden of [
  'from "./task/',
  'from "./proxy/',
  'from "./manifest/',
  'from "./import/',
  'from "./safety/',
  'from "./log/',
  'from "./ui/',
]) {
  if (publicDts.includes(forbidden)) {
    throw new Error(`public-api.d.mts contains an unresolved declaration edge: ${forbidden}`);
  }
}

if (!Array.isArray(api.MOCK_ENDPOINTS) || api.MOCK_ENDPOINTS.length !== 6) {
  throw new Error("MOCK_ENDPOINTS must list all six frozen endpoints");
}


// Verify the source entry graph can become a classic UXP script without dependencies.
const indexJs = await readFile(join(root, "index.js"), "utf8");
for (const forbidden of ["http://", "https://", "node_modules"]) {
  if (indexJs.includes(forbidden)) {
    throw new Error(`index.js must not reference ${forbidden}`);
  }
}
if (!indexJs.includes("./src/public-api.mjs") && !indexJs.includes("./src/")) {
  throw new Error("index.js must import local src modules");
}
const classicBundle = await bundleClassicEntry({ rootDir: root, entry: "index.js" });
new Script(classicBundle, { filename: "cinevfx-uxp-bundle.js" });
if (!classicBundle.includes("__require")) {
  throw new Error("classic UXP bundle must contain the local module runtime");
}

const html = await readFile(join(root, "index.html"), "utf8");
if (!html.includes('href="styles.css"') || !html.includes('src="index.js"')) {
  throw new Error("index.html must load local styles.css and index.js");
}
if (
  !html.includes("btn-create-glow") ||
  !html.includes("btn-refresh-layer") ||
  !html.includes("btn-submit") ||
  !html.includes("btn-cancel") ||
  !html.includes("btn-import")
) {
  throw new Error("index.html must declare primary panel action buttons");
}

const styles = await readFile(join(root, "styles.css"), "utf8");
if (!styles.includes("@media") || !styles.includes("display: flex")) {
  throw new Error("styles.css must support compact responsive layout");
}
if (/display:\s*grid|grid-template|\bgap\s*:/.test(styles)) {
  throw new Error("styles.css must stay within the UXP-supported flex layout subset");
}
for (const variable of ["--uxp-host-background-color", "--uxp-host-text-color"]) {
  if (!styles.includes(variable)) {
    throw new Error(`styles.css must use Photoshop theme variable ${variable}`);
  }
}

console.log(
  `check ok: ${requiredFiles.length} files, strict manifest v${manifest.manifestVersion}, classic bundle parsed, public API loaded`,
);
