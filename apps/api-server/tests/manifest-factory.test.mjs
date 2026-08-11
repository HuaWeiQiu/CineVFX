import assert from "node:assert/strict";
import test from "node:test";
import {
  validateDocument,
  validateManifestSemantics,
} from "../../../packages/contracts/src/index.mjs";
import { buildFixedLayerManifest } from "../src/manifest-factory.mjs";

test("fixed manifest is schema-valid with editable passes and digest agreement", async () => {
  const manifest = buildFixedLayerManifest({
    jobId: "job_mock_0001",
    manifestId: "manifest_mock_0001",
    canvas: {
      width: 128,
      height: 96,
      colorSpace: "srgb",
      pixelAspectRatio: 1,
      normalized: true,
    },
    protectedSource: {
      layerStableId: "ps_layer_stable_source_01",
      documentStableId: "ps_doc_stable_01",
      immutable: true,
    },
    createdAt: "2026-08-12T10:00:18Z",
    jobSuffix: "mock_0001",
  });

  const schema = await validateDocument("LayerManifest", manifest);
  assert.equal(schema.valid, true, JSON.stringify(schema.errors, null, 2));
  const semantic = validateManifestSemantics(manifest);
  assert.equal(semantic.valid, true, JSON.stringify(semantic.errors, null, 2));

  assert.ok(manifest.passes.length >= 1);
  for (const [index, pass] of manifest.passes.entries()) {
    assert.equal(pass.order, index);
    assert.equal(pass.editable, true);
    const asset = manifest.assets.find((item) => item.assetId === pass.asset.assetId);
    assert.ok(asset, `missing asset for ${pass.id}`);
    assert.equal(asset.digest, pass.asset.digest);
    assert.equal(asset.verified, true);
    assert.equal(asset.purpose, "pass");
  }
  assert.equal(manifest.protectedSource.untouched, true);
  assert.equal(manifest.importHints.singleHistoryState, true);
  assert.equal(manifest.importHints.rollbackOnAnyFailure, true);
});
