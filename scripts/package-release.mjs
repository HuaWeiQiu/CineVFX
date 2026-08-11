/**
 * Build the deterministic, unsigned development-preview archive.
 *
 * This is a plain ZIP for manual UXP Developer Tool loading after extraction.
 * It is not a signed installer or a CCX package.
 */

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

import {
  createUxpPluginArtifact,
  UXP_PLUGIN_FILES,
} from "../apps/photoshop-uxp/scripts/plugin-artifact.mjs";
import { validateUxpManifest } from "../apps/photoshop-uxp/scripts/validate-uxp-manifest.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const rootPackage = JSON.parse(
  await readFile(join(projectRoot, "package.json"), "utf8"),
);

export const RELEASE_VERSION = rootPackage.version;
export const RELEASE_PLUGIN_ID = "com.cinevfx.dev.shell";
export const RELEASE_ARCHIVE =
  `cinevfx-photoshop-uxp-dev-preview-${RELEASE_VERSION}.zip`;
export const REQUIRED_PLUGIN_FILES = UXP_PLUGIN_FILES;

const ZIP_UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;
const ZIP_DOS_TIME = 0;
const ZIP_DOS_DATE = 0x0021; // 1980-01-01, the earliest DOS ZIP date.
const MAX_ZIP_ENTRY_BYTES = 0xffffffff;
const CRC32_TABLE = createCrc32Table();

/**
 * Package an already-built Photoshop UXP development preview.
 * @param {{ pluginDir?: string, outputDir?: string }} [options]
 */
export async function packageRelease(options = {}) {
  const uxpPackage = JSON.parse(
    await readFile(join(projectRoot, "apps/photoshop-uxp/package.json"), "utf8"),
  );
  assertReleaseVersionParity({
    rootVersion: RELEASE_VERSION,
    uxpPackageVersion: uxpPackage.version,
  });

  const pluginDir = resolve(
    options.pluginDir ?? join(projectRoot, "apps/photoshop-uxp/dist/plugin"),
  );
  const outputDir = resolve(
    options.outputDir ?? join(projectRoot, "dist/release"),
  );

  if (pluginDir === outputDir) {
    throw new Error("pluginDir and outputDir must be different directories");
  }

  const actualFiles = await listPluginFiles(pluginDir);
  const expectedFiles = [...REQUIRED_PLUGIN_FILES].sort();
  if (actualFiles.join("\n") !== expectedFiles.join("\n")) {
    throw new Error(
      `plugin directory must contain exactly ${expectedFiles.join(", ")}; ` +
        `found ${actualFiles.length === 0 ? "no files" : actualFiles.join(", ")}`,
    );
  }

  const entries = [];
  for (const name of expectedFiles) {
    entries.push({ name, data: await readFile(join(pluginDir, name)) });
  }
  validateBuiltPlugin(entries);
  const canonical = await createUxpPluginArtifact({
    rootDir: join(projectRoot, "apps/photoshop-uxp"),
  });
  assertCanonicalPlugin(entries, canonical.entries);

  const archive = createDeterministicZip(entries);
  const archiveSha256 = sha256(archive);
  const releaseManifest = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        releaseChannel: "dev-preview",
        version: RELEASE_VERSION,
        pluginId: RELEASE_PLUGIN_ID,
        manifestVersion: 5,
        photoshopRuntimeVerified: false,
        signed: false,
        installer: false,
        requiresLocalMockApi: true,
        artifact: {
          file: RELEASE_ARCHIVE,
          format: "zip",
          bytes: archive.length,
          sha256: archiveSha256,
        },
        files: entries.map(({ name, data }) => ({
          path: name,
          bytes: data.length,
          sha256: sha256(data),
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const checksums = Buffer.from(
    [
      `${archiveSha256}  ${RELEASE_ARCHIVE}`,
      `${sha256(releaseManifest)}  release-manifest.json`,
      "",
    ].join("\n"),
    "utf8",
  );

  await prepareOutputDirectory(outputDir);
  await replaceOutputFile(join(outputDir, RELEASE_ARCHIVE), archive);
  await replaceOutputFile(join(outputDir, "release-manifest.json"), releaseManifest);
  await replaceOutputFile(join(outputDir, "SHA256SUMS.txt"), checksums);

  return {
    archivePath: join(outputDir, RELEASE_ARCHIVE),
    checksumsPath: join(outputDir, "SHA256SUMS.txt"),
    manifestPath: join(outputDir, "release-manifest.json"),
    archiveSha256,
  };
}

/**
 * Create a deterministic ZIP using the portable Store method.
 * @param {Array<{ name: string, data: Uint8Array }>} inputEntries
 */
export function createDeterministicZip(inputEntries) {
  if (!Array.isArray(inputEntries) || inputEntries.length === 0) {
    throw new TypeError("ZIP entries must be a non-empty array");
  }
  if (inputEntries.length > 0xffff) {
    throw new RangeError("ZIP entry count exceeds the classic ZIP limit");
  }

  const seen = new Set();
  const entries = inputEntries.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new TypeError("each ZIP entry must be an object");
    }
    validateArchivePath(entry.name);
    if (seen.has(entry.name)) {
      throw new Error(`duplicate ZIP entry: ${entry.name}`);
    }
    seen.add(entry.name);
    if (!(entry.data instanceof Uint8Array)) {
      throw new TypeError(`ZIP entry data must be bytes: ${entry.name}`);
    }
    const data = Buffer.from(
      entry.data.buffer,
      entry.data.byteOffset,
      entry.data.byteLength,
    );
    if (data.length > MAX_ZIP_ENTRY_BYTES) {
      throw new RangeError(`ZIP entry is too large: ${entry.name}`);
    }
    return {
      name: entry.name,
      nameBytes: Buffer.from(entry.name, "utf8"),
      data,
      crc: crc32(data),
    };
  });

  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );

  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    if (entry.nameBytes.length > 0xffff) {
      throw new RangeError(`ZIP entry path is too long: ${entry.name}`);
    }
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(ZIP_VERSION, 4);
    localHeader.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    localHeader.writeUInt16LE(0, 8); // Store, no compression.
    localHeader.writeUInt16LE(ZIP_DOS_TIME, 10);
    localHeader.writeUInt16LE(ZIP_DOS_DATE, 12);
    localHeader.writeUInt32LE(entry.crc, 14);
    localHeader.writeUInt32LE(entry.data.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(entry.nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, entry.nameBytes, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(ZIP_VERSION, 4);
    centralHeader.writeUInt16LE(ZIP_VERSION, 6);
    centralHeader.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(ZIP_DOS_TIME, 12);
    centralHeader.writeUInt16LE(ZIP_DOS_DATE, 14);
    centralHeader.writeUInt32LE(entry.crc, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(entry.nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, entry.nameBytes);

    localOffset += localHeader.length + entry.nameBytes.length + entry.data.length;
    if (localOffset > MAX_ZIP_ENTRY_BYTES) {
      throw new RangeError("ZIP local data exceeds the classic ZIP limit");
    }
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (centralDirectory.length > MAX_ZIP_ENTRY_BYTES) {
    throw new RangeError("ZIP central directory exceeds the classic ZIP limit");
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

/** @param {string} name */
function validateArchivePath(name) {
  if (typeof name !== "string" || name.length === 0 || name.includes("\0")) {
    throw new TypeError("ZIP entry path must be a non-empty safe string");
  }
  if (
    isAbsolute(name) ||
    /^[A-Za-z]:/.test(name) ||
    name.includes("\\") ||
    name.includes(":") ||
    name.endsWith("/")
  ) {
    throw new Error(`unsafe ZIP entry path: ${name}`);
  }
  const segments = name.split("/");
  const windowsReservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        /[\u0001-\u001f\u007f]/.test(segment) ||
        /[. ]$/.test(segment) ||
        windowsReservedName.test(segment),
    )
  ) {
    throw new Error(`unsafe ZIP entry path: ${name}`);
  }
}

/** @param {string} pluginDir */
async function listPluginFiles(pluginDir) {
  let entries;
  try {
    entries = await readdir(pluginDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error("built plugin directory does not exist");
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      throw new Error(`plugin directory contains a non-regular entry: ${entry.name}`);
    }
    validateArchivePath(entry.name);
    files.push(entry.name);
  }
  return files.sort();
}

/**
 * @param {{ rootVersion: unknown, uxpPackageVersion: unknown, manifestVersion?: unknown }} versions
 */
export function assertReleaseVersionParity({
  rootVersion,
  uxpPackageVersion,
  manifestVersion = rootVersion,
}) {
  if (
    typeof rootVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(rootVersion) ||
    uxpPackageVersion !== rootVersion ||
    manifestVersion !== rootVersion
  ) {
    throw new Error(
      "root package, Photoshop UXP package, and manifest versions must match",
    );
  }
}

/** @param {Array<{ name: string, data: Buffer }>} entries */
function validateBuiltPlugin(entries) {
  const manifestEntry = entries.find(({ name }) => name === "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.data.toString("utf8"));
  } catch {
    throw new Error("built manifest.json must contain valid JSON");
  }
  const manifestErrors = validateUxpManifest(manifest);
  if (manifestErrors.length > 0) {
    throw new Error(
      `built manifest.json is outside the strict UXP v5 subset: ${JSON.stringify(manifestErrors)}`,
    );
  }
  if (
    manifest.id !== RELEASE_PLUGIN_ID ||
    manifest.main !== "index.html"
  ) {
    throw new Error(
      "built manifest identity must match the dev-preview release contract",
    );
  }
  assertReleaseVersionParity({
    rootVersion: RELEASE_VERSION,
    uxpPackageVersion: RELEASE_VERSION,
    manifestVersion: manifest.version,
  });

  const indexEntry = entries.find(({ name }) => name === "index.js");
  const indexSource = indexEntry.data.toString("utf8");
  try {
    new Script(indexSource, { filename: "dist/plugin/index.js" });
  } catch {
    throw new Error("built index.js must be a syntactically valid classic script");
  }
  if (
    !indexSource.includes("__require") ||
    /^[ \t]*(?:import|export)\b/m.test(indexSource)
  ) {
    throw new Error("built index.js must be a bundled classic script");
  }

  const htmlEntry = entries.find(({ name }) => name === "index.html");
  const html = htmlEntry.data.toString("utf8");
  const hrefs = [...html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map(
    (match) => match[1],
  );
  const sources = [...html.matchAll(/\bsrc\s*=\s*["']([^"']+)["']/gi)].map(
    (match) => match[1],
  );
  if (
    hrefs.length !== 1 ||
    hrefs[0] !== "styles.css" ||
    sources.length !== 1 ||
    sources[0] !== "index.js" ||
    !/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/i.test(html) ||
    !/<script\b[^>]*\bsrc\s*=\s*["']index\.js["'][^>]*><\/script>/i.test(html) ||
    /\btype\s*=\s*["']module["']/i.test(html)
  ) {
    throw new Error(
      "built index.html must load one local stylesheet and one classic index.js",
    );
  }
}

/**
 * @param {Array<{ name: string, data: Buffer }>} actual
 * @param {Array<{ name: string, data: Buffer }>} expected
 */
function assertCanonicalPlugin(actual, expected) {
  const expectedByName = new Map(
    expected.map((entry) => [entry.name, Buffer.from(entry.data)]),
  );
  for (const entry of actual) {
    const canonical = expectedByName.get(entry.name);
    if (!canonical || !Buffer.from(entry.data).equals(canonical)) {
      throw new Error(
        `built ${entry.name} does not match the canonical UXP source artifact`,
      );
    }
    expectedByName.delete(entry.name);
  }
  if (expectedByName.size > 0) {
    throw new Error("built plugin is missing a canonical UXP artifact file");
  }
}

/** @param {string} outputDir */
async function prepareOutputDirectory(outputDir) {
  const filesystemRoot = parse(outputDir).root;
  if (outputDir === filesystemRoot) {
    throw new Error("refusing to use a filesystem root as outputDir");
  }
  await mkdir(outputDir, { recursive: true });
  const allowed = new Set([
    RELEASE_ARCHIVE,
    "release-manifest.json",
    "SHA256SUMS.txt",
  ]);
  for (const entry of await readdir(outputDir, { withFileTypes: true })) {
    if (!allowed.has(entry.name) || !entry.isFile()) {
      throw new Error(`release directory contains an unexpected entry: ${entry.name}`);
    }
  }
}

/** @param {string} target @param {Uint8Array} data */
async function replaceOutputFile(target, data) {
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  await rm(temporary, { force: true });
  try {
    await writeFile(temporary, data, { flag: "wx" });
    // Windows does not consistently replace an existing destination on rename.
    await rm(target, { force: true });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** @param {Uint8Array} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function createCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

/** @param {Uint8Array} data */
function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await packageRelease();
    console.log(`release package: dist/release/${RELEASE_ARCHIVE}`);
    console.log(`sha256: ${result.archiveSha256}`);
  } catch {
    console.error("release packaging failed");
    process.exitCode = 1;
  }
}
