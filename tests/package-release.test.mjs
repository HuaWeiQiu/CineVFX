import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { createUxpPluginArtifact } from "../apps/photoshop-uxp/scripts/plugin-artifact.mjs";
import {
  assertReleaseVersionParity,
  createDeterministicZip,
  packageRelease,
  RELEASE_ARCHIVE,
  REQUIRED_PLUGIN_FILES,
} from "../scripts/package-release.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("development-preview release packaging", () => {
  it("writes a valid deterministic Store ZIP, checksums, and release manifest", async () => {
    const root = await createFixture();
    const pluginDir = join(root, "plugin");
    const outputDir = join(root, "release");

    await packageRelease({ pluginDir, outputDir });
    const firstArchive = await readFile(join(outputDir, RELEASE_ARCHIVE));
    const parsed = parseZip(firstArchive);
    assert.deepEqual([...parsed.keys()], [...REQUIRED_PLUGIN_FILES].sort());
    for (const name of REQUIRED_PLUGIN_FILES) {
      assert.deepEqual(parsed.get(name), await readFile(join(pluginDir, name)));
    }

    const releaseManifestBytes = await readFile(
      join(outputDir, "release-manifest.json"),
    );
    const releaseManifest = JSON.parse(releaseManifestBytes);
    assert.deepEqual(
      {
        releaseChannel: releaseManifest.releaseChannel,
        version: releaseManifest.version,
        pluginId: releaseManifest.pluginId,
        manifestVersion: releaseManifest.manifestVersion,
        photoshopRuntimeVerified: releaseManifest.photoshopRuntimeVerified,
        signed: releaseManifest.signed,
        installer: releaseManifest.installer,
        requiresLocalMockApi: releaseManifest.requiresLocalMockApi,
      },
      {
        releaseChannel: "dev-preview",
        version: "0.1.0",
        pluginId: "com.cinevfx.dev.shell",
        manifestVersion: 5,
        photoshopRuntimeVerified: false,
        signed: false,
        installer: false,
        requiresLocalMockApi: true,
      },
    );
    assert.equal(releaseManifest.artifact.format, "zip");
    assert.equal(releaseManifest.artifact.file, RELEASE_ARCHIVE);
    assert.equal(releaseManifest.artifact.bytes, firstArchive.length);
    assert.equal(releaseManifest.artifact.sha256, sha256(firstArchive));
    assert.equal(/ccx/i.test(releaseManifestBytes.toString("utf8")), false);

    const checksumLines = (await readFile(join(outputDir, "SHA256SUMS.txt"), "utf8"))
      .trim()
      .split("\n");
    assert.deepEqual(checksumLines, [
      `${sha256(firstArchive)}  ${RELEASE_ARCHIVE}`,
      `${sha256(releaseManifestBytes)}  release-manifest.json`,
    ]);
    assert.deepEqual((await readdir(outputDir)).sort(), [
      "SHA256SUMS.txt",
      RELEASE_ARCHIVE,
      "release-manifest.json",
    ].sort());

    for (const name of REQUIRED_PLUGIN_FILES) {
      await utimes(join(pluginDir, name), new Date(1_700_000_000_000), new Date());
    }
    await packageRelease({ pluginDir, outputDir });
    assert.deepEqual(await readFile(join(outputDir, RELEASE_ARCHIVE)), firstArchive);
    assert.deepEqual(
      await readFile(join(outputDir, "release-manifest.json")),
      releaseManifestBytes,
    );

    const lfSource = await createSourceFixture("\n");
    const crlfSource = await createSourceFixture("\r\n");
    const lfArtifact = await createUxpPluginArtifact({ rootDir: lfSource });
    const crlfArtifact = await createUxpPluginArtifact({ rootDir: crlfSource });
    assert.deepEqual(crlfArtifact.entries, lfArtifact.entries);
    for (const entry of lfArtifact.entries) {
      assert.equal(entry.data.includes(0x0d), false);
    }
  });

  it("rejects missing, extra, and non-regular plugin entries", async () => {
    const missing = await createFixture({ omit: "styles.css" });
    await assert.rejects(
      packageRelease({ pluginDir: join(missing, "plugin"), outputDir: join(missing, "out") }),
      /must contain exactly/,
    );

    const extra = await createFixture();
    await writeFile(join(extra, "plugin", "stale.js"), "stale", "utf8");
    await assert.rejects(
      packageRelease({ pluginDir: join(extra, "plugin"), outputDir: join(extra, "out") }),
      /must contain exactly/,
    );

    const nested = await createFixture();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(nested, "plugin", "nested"));
    await assert.rejects(
      packageRelease({ pluginDir: join(nested, "plugin"), outputDir: join(nested, "out") }),
      /non-regular entry/,
    );
  });

  it("rejects stale identity and unloadable plugin surfaces before writing", async () => {
    const root = await createFixture();
    const pluginDir = join(root, "plugin");
    await writeFile(
      join(pluginDir, "manifest.json"),
      JSON.stringify(validManifest({ id: "com.example.foreign" })),
      "utf8",
    );
    const outputDir = join(root, "release");
    await assert.rejects(
      packageRelease({ pluginDir, outputDir }),
      /manifest identity/,
    );
    await assert.rejects(readdir(outputDir), { code: "ENOENT" });

    assert.throws(
      () =>
        assertReleaseVersionParity({
          rootVersion: "0.1.0",
          uxpPackageVersion: "0.1.1",
          manifestVersion: "0.1.0",
        }),
      /versions must match/,
    );

    const incomplete = await createFixture();
    await writeFile(
      join(incomplete, "plugin", "manifest.json"),
      JSON.stringify({
        manifestVersion: 5,
        id: "com.cinevfx.dev.shell",
        name: "CineVFX Dev Shell",
        version: "0.1.0",
        main: "index.html",
      }),
      "utf8",
    );
    await assert.rejects(
      packageRelease({
        pluginDir: join(incomplete, "plugin"),
        outputDir: join(incomplete, "out"),
      }),
      /strict UXP v5 subset/,
    );

    const invalidPermission = await createFixture();
    const manifest = validManifest();
    manifest.requiredPermissions.network.domains.push("https://example.com");
    await writeFile(
      join(invalidPermission, "plugin", "manifest.json"),
      JSON.stringify(manifest),
      "utf8",
    );
    await assert.rejects(
      packageRelease({
        pluginDir: join(invalidPermission, "plugin"),
        outputDir: join(invalidPermission, "out"),
      }),
      /strict UXP v5 subset/,
    );

    const syntaxError = await createFixture();
    await writeFile(join(syntaxError, "plugin", "index.js"), "(() => {", "utf8");
    await assert.rejects(
      packageRelease({
        pluginDir: join(syntaxError, "plugin"),
        outputDir: join(syntaxError, "out"),
      }),
      /syntactically valid classic script/,
    );

    const unbundled = await createFixture();
    await writeFile(
      join(unbundled, "plugin", "index.js"),
      "(() => { globalThis.loaded = true; })();\n",
      "utf8",
    );
    await assert.rejects(
      packageRelease({
        pluginDir: join(unbundled, "plugin"),
        outputDir: join(unbundled, "out"),
      }),
      /bundled classic script/,
    );

    const fakeBundle = await createFixture();
    await writeFile(
      join(fakeBundle, "plugin", "index.js"),
      "/* __require */\n",
      "utf8",
    );
    await assert.rejects(
      packageRelease({
        pluginDir: join(fakeBundle, "plugin"),
        outputDir: join(fakeBundle, "out"),
      }),
      /canonical UXP source artifact/,
    );

    const moduleHtml = await createFixture();
    await writeFile(
      join(moduleHtml, "plugin", "index.html"),
      '<!doctype html><link rel="stylesheet" href="styles.css"><script src="index.js" type="module"></script>\n',
      "utf8",
    );
    await assert.rejects(
      packageRelease({
        pluginDir: join(moduleHtml, "plugin"),
        outputDir: join(moduleHtml, "out"),
      }),
      /one local stylesheet and one classic index\.js/,
    );

    const missingStyles = await createFixture();
    await writeFile(
      join(missingStyles, "plugin", "index.html"),
      '<!doctype html><script src="index.js"></script>\n',
      "utf8",
    );
    await assert.rejects(
      packageRelease({
        pluginDir: join(missingStyles, "plugin"),
        outputDir: join(missingStyles, "out"),
      }),
      /one local stylesheet and one classic index\.js/,
    );
  });

  it("rejects unsafe and duplicate ZIP entry paths", () => {
    const unsafe = [
      "",
      "../escape",
      "a/../escape",
      "/absolute",
      "C:/windows",
      "file:stream",
      "folder\\windows",
      "folder//file",
      "folder/./file",
      "folder/trailing. ",
      "NUL.txt",
      "directory/",
      "nul\0byte",
    ];
    for (const name of unsafe) {
      assert.throws(() => createDeterministicZip([{ name, data: Buffer.alloc(0) }]), /path/);
    }
    assert.throws(
      () =>
        createDeterministicZip([
          { name: "same.txt", data: Buffer.from("first") },
          { name: "same.txt", data: Buffer.from("second") },
        ]),
      /duplicate ZIP entry/,
    );
  });
});

async function createFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "cinevfx-release-test-"));
  temporaryDirectories.push(root);
  const pluginDir = join(root, "plugin");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(pluginDir);
  const { entries } = await canonicalPluginArtifact();
  for (const { name, data } of entries) {
    if (name !== options.omit) {
      await writeFile(join(pluginDir, name), data);
    }
  }
  return root;
}

let canonicalArtifactPromise;
function canonicalPluginArtifact() {
  canonicalArtifactPromise ??= createUxpPluginArtifact({
    rootDir: join(import.meta.dirname, "../apps/photoshop-uxp"),
  });
  return canonicalArtifactPromise;
}

async function createSourceFixture(lineEnding) {
  const root = await mkdtemp(join(tmpdir(), "cinevfx-source-test-"));
  temporaryDirectories.push(root);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "src"));
  const files = {
    "index.html": '<!doctype html>\n<link rel="stylesheet" href="styles.css">\n<script src="index.js" type="module"></script>\n',
    "index.js": 'import { value } from "./src/value.mjs";\nglobalThis.__test = value;\n',
    "manifest.json": `${JSON.stringify(validManifest(), null, 2)}\n`,
    "src/value.mjs": "export const value = 1;\n",
    "styles.css": ":root { color: #ddd; }\n",
  };
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(
      join(root, name),
      contents.replace(/\n/g, lineEnding),
      "utf8",
    );
  }
  return root;
}

function validManifest(overrides = {}) {
  return {
    manifestVersion: 5,
    id: "com.cinevfx.dev.shell",
    name: "CineVFX Dev Shell",
    version: "0.1.0",
    main: "index.html",
    host: {
      app: "PS",
      minVersion: "27.0.0",
      data: { apiVersion: 2 },
    },
    entrypoints: [
      {
        type: "panel",
        id: "cinevfx.panel",
        label: { default: "CineVFX" },
        minimumSize: { width: 240, height: 320 },
        maximumSize: { width: 2000, height: 2000 },
        preferredDockedSize: { width: 280, height: 480 },
        preferredFloatingSize: { width: 300, height: 520 },
      },
    ],
    requiredPermissions: {
      network: {
        domains: [
          "https://localhost:8787",
          "https://127.0.0.1:8787",
          "http://127.0.0.1:8787",
          "http://localhost:8787",
        ],
      },
    },
    ...overrides,
  };
}

function parseZip(archive) {
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
  assert.equal(archive.readUInt16LE(archive.length - 2), 0);
  const entryCount = archive.readUInt16LE(archive.length - 12);
  const centralSize = archive.readUInt32LE(archive.length - 10);
  const centralOffset = archive.readUInt32LE(archive.length - 6);
  assert.equal(centralOffset + centralSize, archive.length - 22);

  const files = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    assert.equal(archive.readUInt16LE(cursor + 8), 0x0800);
    assert.equal(archive.readUInt16LE(cursor + 10), 0);
    assert.equal(archive.readUInt16LE(cursor + 12), 0);
    assert.equal(archive.readUInt16LE(cursor + 14), 0x0021);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    assert.equal(compressedSize, uncompressedSize);

    assert.equal(archive.readUInt32LE(localOffset), 0x04034b50);
    assert.equal(archive.readUInt16LE(localOffset + 6), 0x0800);
    assert.equal(archive.readUInt16LE(localOffset + 8), 0);
    assert.equal(archive.readUInt32LE(localOffset + 14), expectedCrc);
    assert.equal(archive.readUInt32LE(localOffset + 18), compressedSize);
    assert.equal(archive.readUInt32LE(localOffset + 22), uncompressedSize);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    assert.equal(
      archive.subarray(localNameStart, localNameStart + localNameLength).toString("utf8"),
      name,
    );
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const data = archive.subarray(dataStart, dataStart + compressedSize);
    assert.equal(crc32(data), expectedCrc);
    files.set(name, Buffer.from(data));

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, centralOffset + centralSize);
  assert.equal(files.size, entryCount);
  return files;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}
