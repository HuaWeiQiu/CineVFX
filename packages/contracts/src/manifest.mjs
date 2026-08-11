/**
 * Semantic checks that go beyond structural JSON Schema for LayerManifest.
 */

const RASTER_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

const PASS_ASSET_PURPOSES = new Set(["pass"]);
const MASK_ASSET_PURPOSES = new Set(["mask"]);

export function validateManifestSemantics(manifest) {
  const errors = [];

  if (!manifest || typeof manifest !== "object") {
    return { valid: false, errors: [{ path: "#", message: "manifest must be an object" }] };
  }

  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  const assetById = new Map();
  for (const [index, asset] of assets.entries()) {
    if (!asset || typeof asset !== "object") continue;
    if (assetById.has(asset.assetId)) {
      errors.push({
        path: `#/assets/${index}/assetId`,
        message: `duplicate assetId ${asset.assetId}`,
      });
    }
    assetById.set(asset.assetId, asset);
    if (asset.verified !== true) {
      errors.push({
        path: `#/assets/${index}/verified`,
        message: "asset must be verified",
      });
    }
  }

  const passes = Array.isArray(manifest.passes) ? manifest.passes : [];
  if (passes.length === 0) {
    errors.push({ path: "#/passes", message: "successful manifest requires editable passes" });
  }

  for (const [index, pass] of passes.entries()) {
    if (!pass || typeof pass !== "object") continue;
    if (pass.editable !== true) {
      errors.push({
        path: `#/passes/${index}/editable`,
        message: "pass must be editable",
      });
    }

    // Array order must match declared order fields and be contiguous from 0.
    if (pass.order !== index) {
      errors.push({
        path: `#/passes/${index}/order`,
        message: `pass order must equal array index ${index}`,
      });
    }

    const refs = [];
    if (pass.asset) {
      refs.push({
        ref: pass.asset,
        path: `#/passes/${index}/asset`,
        allowedPurposes: PASS_ASSET_PURPOSES,
        role: "pass",
      });
    }
    if (pass.mask?.asset) {
      refs.push({
        ref: pass.mask.asset,
        path: `#/passes/${index}/mask/asset`,
        allowedPurposes: MASK_ASSET_PURPOSES,
        role: "mask",
      });
    }

    for (const { ref, path: refPath, allowedPurposes, role } of refs) {
      const listed = assetById.get(ref.assetId);
      if (!listed) {
        errors.push({
          path: refPath,
          message: `asset ${ref.assetId} missing from manifest.assets`,
        });
        continue;
      }
      if (listed.digest !== ref.digest) {
        errors.push({
          path: refPath,
          message: `digest mismatch for ${ref.assetId}`,
        });
      }
      if (listed.verified !== true) {
        errors.push({
          path: refPath,
          message: `asset ${ref.assetId} is not verified`,
        });
      }
      if (!RASTER_MEDIA_TYPES.has(listed.mediaType)) {
        errors.push({
          path: refPath,
          message: `${role} asset ${ref.assetId} must be a raster media type`,
        });
      }
      if (!allowedPurposes.has(listed.purpose)) {
        errors.push({
          path: refPath,
          message: `${role} asset ${ref.assetId} purpose must be one of ${[...allowedPurposes].join(", ")}`,
        });
      }
    }
  }

  // Contiguous order values 0..n-1 (also enforced via index equality above).
  if (passes.length > 0) {
    const orders = passes.map((pass) => pass?.order);
    for (let expected = 0; expected < passes.length; expected += 1) {
      if (orders[expected] !== expected) {
        // already reported per-pass; keep a collection-level note once
        if (expected === 0 || orders[expected - 1] === expected - 1) {
          errors.push({
            path: "#/passes",
            message: "pass order values must be contiguous starting at 0",
          });
        }
        break;
      }
    }
  }

  if (manifest.protectedSource) {
    if (manifest.protectedSource.immutable !== true) {
      errors.push({
        path: "#/protectedSource/immutable",
        message: "protected source must remain immutable",
      });
    }
    if (manifest.protectedSource.untouched !== true) {
      errors.push({
        path: "#/protectedSource/untouched",
        message: "protected source must be marked untouched",
      });
    }
  }

  return { valid: errors.length === 0, errors };
}
