/**
 * Package-local build: emit a dist summary for the UXP development shell.
 * Does not package a signed CCX or fetch remote assets.
 */

import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { bundleClassicEntry } from "./bundle-classic.mjs";
import { validateUxpManifest } from "./validate-uxp-manifest.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

await mkdir(dist, { recursive: true });

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const manifestErrors = validateUxpManifest(manifest);
if (manifestErrors.length > 0) {
  throw new Error(`invalid UXP manifest: ${JSON.stringify(manifestErrors)}`);
}

// Recreate the loadable surface so removed/renamed source files cannot survive.
const pluginDir = join(dist, "plugin");
await rm(pluginDir, { recursive: true, force: true });
await mkdir(pluginDir, { recursive: true });

for (const file of ["manifest.json", "styles.css"]) {
  await cp(join(root, file), join(pluginDir, file));
}

const sourceHtml = await readFile(join(root, "index.html"), "utf8");
const classicHtml = sourceHtml.replace(
  /<script\s+src="index\.js"\s+type="module"><\/script>/,
  '<script src="index.js"></script>',
);
if (classicHtml === sourceHtml || classicHtml.includes('type="module"')) {
  throw new Error("index.html must contain exactly one transformable module entry");
}
await writeFile(join(pluginDir, "index.html"), classicHtml, "utf8");

const classicBundle = await bundleClassicEntry({ rootDir: root, entry: "index.js" });
new Script(classicBundle, { filename: "dist/plugin/index.js" });
await writeFile(join(pluginDir, "index.js"), classicBundle, "utf8");

const summary = {
  package: pkg.name,
  version: pkg.version,
  builtAt: new Date().toISOString(),
  manifestVersion: manifest.manifestVersion,
  pluginId: manifest.id,
  host: manifest.host,
  entrypoints: manifest.entrypoints.map((e) => ({
    type: e.type,
    id: e.id,
  })),
  artifact: "uxp-dev-shell",
  signedInstall: false,
  marketplaceCompatible: false,
  unverified: [
    "photoshopProxyExport",
    "executeAsModalHistoryUndo",
    "layerPlacement",
    "sourcePreservationRuntime",
    "windowsRuntime",
    "oneClickSignedInstall",
    "realPluginId",
    "marketplaceCompatibility",
    "runtimeSuccess",
  ],
  notes: [
    "Development shell only. Not signed for one-click marketplace install.",
    "Load dist/plugin via UXP Developer Tool on macOS or Windows (runtime UNVERIFIED).",
  ],
};

await writeFile(
  join(dist, "build.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);


// Verify the sideload artifact is a minimal classic-script UXP surface.
const requiredPluginFiles = [
  "manifest.json",
  "index.html",
  "index.js",
  "styles.css",
];
const { access: accessFile } = await import("node:fs/promises");
for (const rel of requiredPluginFiles) {
  await accessFile(join(pluginDir, rel));
}

const pluginIndex = await readFile(join(pluginDir, "index.js"), "utf8");
if (!pluginIndex.includes("__require") || /^[ \t]*(?:import|export)\b/m.test(pluginIndex)) {
  throw new Error("dist/plugin/index.js must be a bundled classic script");
}
const pluginManifest = JSON.parse(
  await readFile(join(pluginDir, "manifest.json"), "utf8"),
);
if (pluginManifest.main !== "index.html") {
  throw new Error("dist/plugin manifest main must be index.html");
}
if (pluginManifest.manifestVersion !== 5) {
  throw new Error("dist/plugin must use UXP manifest v5");
}

const actualPluginFiles = await listRelativeFiles(pluginDir);
if (actualPluginFiles.join("\n") !== [...requiredPluginFiles].sort().join("\n")) {
  throw new Error(`dist/plugin contains stale or missing files: ${actualPluginFiles.join(", ")}`);
}

console.log(`build ok: wrote dist/build.json and dist/plugin/ (${pkg.name}@${pkg.version})`);

async function listRelativeFiles(directory, prefix = "") {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      output.push(...(await listRelativeFiles(join(directory, entry.name), relative)));
    } else if (entry.isFile()) {
      output.push(relative);
    }
  }
  return output.sort();
}
