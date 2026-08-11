import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Script } from "node:vm";

import { bundleClassicEntry } from "./bundle-classic.mjs";
import { validateUxpManifest } from "./validate-uxp-manifest.mjs";

export const UXP_PLUGIN_FILES = Object.freeze([
  "index.html",
  "index.js",
  "manifest.json",
  "styles.css",
]);

/**
 * Build the canonical four-file UXP development artifact in memory.
 * Both package-local build and repository release packaging use this function,
 * so a stale or substituted dist tree cannot become a release.
 * @param {{ rootDir: string }} options
 */
export async function createUxpPluginArtifact({ rootDir }) {
  if (typeof rootDir !== "string" || rootDir.length === 0) {
    throw new TypeError("rootDir must be a non-empty string");
  }

  const manifestBytes = await readFile(join(rootDir, "manifest.json"));
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("manifest.json must contain valid JSON");
  }
  const manifestErrors = validateUxpManifest(manifest);
  if (manifestErrors.length > 0) {
    throw new Error(`invalid UXP manifest: ${JSON.stringify(manifestErrors)}`);
  }

  const canonicalManifest = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const sourceHtml = normalizeText(
    await readFile(join(rootDir, "index.html"), "utf8"),
  );
  const moduleEntry = /<script\s+src="index\.js"\s+type="module"><\/script>/g;
  const moduleEntries = sourceHtml.match(moduleEntry) ?? [];
  if (moduleEntries.length !== 1) {
    throw new Error("index.html must contain exactly one transformable module entry");
  }
  const classicHtml = sourceHtml.replace(
    moduleEntry,
    '<script src="index.js"></script>',
  );
  if (/\btype\s*=\s*["']module["']/i.test(classicHtml)) {
    throw new Error("built index.html must not retain a module entry");
  }

  const classicBundle = normalizeText(
    await bundleClassicEntry({ rootDir, entry: "index.js" }),
  );
  new Script(classicBundle, { filename: "dist/plugin/index.js" });
  if (
    !classicBundle.includes("__require") ||
    /^[ \t]*(?:import|export)\b/m.test(classicBundle)
  ) {
    throw new Error("generated index.js must be a bundled classic script");
  }

  const entries = [
    { name: "index.html", data: Buffer.from(classicHtml, "utf8") },
    { name: "index.js", data: Buffer.from(classicBundle, "utf8") },
    { name: "manifest.json", data: canonicalManifest },
    {
      name: "styles.css",
      data: Buffer.from(
        normalizeText(await readFile(join(rootDir, "styles.css"), "utf8")),
        "utf8",
      ),
    },
  ];
  return { entries, manifest };
}

/** @param {string} value */
function normalizeText(value) {
  return value.replace(/\r\n?/g, "\n");
}
