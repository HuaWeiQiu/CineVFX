import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateLayerManifest } from "../src/manifest/validate-manifest.mjs";
import { validManifest, digest } from "./fixtures.mjs";

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const contractsExamples = join(repoRoot, "packages", "contracts", "examples");

async function readJson(rel) {
  return JSON.parse(await readFile(join(contractsExamples, rel), "utf8"));
}

describe("validateLayerManifest", () => {
  it("accepts a valid editable ordered manifest with digest agreement", () => {
    const result = validateLayerManifest(validManifest());
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it("accepts the frozen valid contract fixture", async () => {
    const fixture = await readJson("valid/layer-manifest.succeeded.json");
    const result = validateLayerManifest(fixture);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it("rejects frozen invalid contract fixtures", async () => {
    const files = [
      "invalid/layer-manifest.digest-mismatch.json",
      "invalid/layer-manifest.empty-passes.json",
      "invalid/layer-manifest.incompatible-pass-media.json",
      "invalid/layer-manifest.non-editable-pass.json",
      "invalid/layer-manifest.reordered-passes.json",
      "invalid/layer-manifest.unverified-asset.json",
    ];
    for (const file of files) {
      const fixture = await readJson(file);
      const result = validateLayerManifest(fixture);
      assert.equal(result.valid, false, `expected invalid for ${file}`);
    }
  });

  it("rejects non-editable passes", () => {
    const manifest = validManifest();
    manifest.passes[0].editable = false;
    const result = validateLayerManifest(manifest);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.message.includes("editable")));
  });

  it("rejects reordered passes", () => {
    const manifest = validManifest();
    manifest.passes[0].order = 1;
    manifest.passes[1].order = 0;
    const result = validateLayerManifest(manifest);
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some(
        (e) =>
          e.message.includes("order") || e.message.includes("contiguous"),
      ),
    );
  });

  it("rejects digest mismatch between pass ref and assets list", () => {
    const manifest = validManifest();
    manifest.passes[0].asset.digest = digest("9");
    const result = validateLayerManifest(manifest);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.message.includes("digest mismatch")));
  });

  it("rejects unverified assets", () => {
    const manifest = validManifest();
    manifest.assets[0].verified = false;
    const result = validateLayerManifest(manifest);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.message.includes("verified")));
  });

  it("rejects mutable protected source", () => {
    const manifest = validManifest();
    manifest.protectedSource.immutable = false;
    manifest.protectedSource.untouched = false;
    const result = validateLayerManifest(manifest);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path.includes("immutable")));
  });

  it("rejects empty passes", () => {
    const manifest = validManifest();
    manifest.passes = [];
    const result = validateLayerManifest(manifest);
    assert.equal(result.valid, false);
  });

  it("rejects invalid timestamps", () => {
    const manifest = validManifest({ createdAt: "not-a-timestamp" });
    const result = validateLayerManifest(manifest);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path.includes("createdAt")));
  });

  it("rejects invalid canvas color spaces and pixel aspect ratios", () => {
    const badSpace = validManifest();
    badSpace.canvas.colorSpace = "rec2020";
    assert.equal(validateLayerManifest(badSpace).valid, false);

    const badPar = validManifest();
    badPar.canvas.pixelAspectRatio = 0;
    assert.equal(validateLayerManifest(badPar).valid, false);
  });

  it("rejects invalid blend modes", () => {
    const manifest = validManifest();
    manifest.passes[0].blendMode = "not_a_mode";
    const result = validateLayerManifest(manifest);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path.includes("blendMode")));
  });

  it("rejects unexpected properties including imageBytes", () => {
    const manifest = validManifest();
    manifest.imageBytes = "AAAA";
    const result = validateLayerManifest(manifest);
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some(
        (e) =>
          e.message.includes("imageBytes") ||
          e.message.includes("unexpected property"),
      ),
    );
  });

  it("rejects more than 32 passes", () => {
    const manifest = validManifest();
    const template = structuredClone(manifest.passes[0]);
    const passes = [];
    const assets = [];
    for (let i = 0; i < 33; i += 1) {
      const assetId = `asset_pass_extra_${String(i).padStart(2, "0")}`;
      const d = digest(String(i % 10));
      passes.push({
        ...structuredClone(template),
        id: `pass_extra_${String(i).padStart(2, "0")}`,
        order: i,
        asset: { assetId, digest: d },
        mask: undefined,
      });
      assets.push({
        assetId,
        digest: d,
        mediaType: "image/png",
        purpose: "pass",
        verified: true,
        dimensions: { width: 64, height: 64 },
      });
    }
    manifest.passes = passes;
    manifest.assets = assets;
    const result = validateLayerManifest(manifest);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.message.includes("32")));
  });

  it("rejects duplicate pass ids", () => {
    const manifest = validManifest();
    manifest.passes[1].id = manifest.passes[0].id;
    const result = validateLayerManifest(manifest);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.message.includes("duplicate pass")));
  });

  it("rejects asset dimensions that are not positive integers", () => {
    const manifest = validManifest();
    manifest.assets[0].dimensions = { width: 0, height: 10 };
    const result = validateLayerManifest(manifest);
    assert.equal(result.valid, false);
  });
});
