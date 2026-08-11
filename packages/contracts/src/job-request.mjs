/**
 * Semantic checks for JobRequest beyond structural JSON Schema.
 * Every EffectSpec-referenced asset must appear exactly once in inputAssets
 * with matching digest and a compatible purpose.
 */

const ROLE_TO_PURPOSE = Object.freeze({
  effect: "effect_reference",
  style: "effect_reference",
  mask: "mask",
  depth: "guidance",
  normal: "guidance",
  environment: "effect_reference",
});

function purposeForRole(role) {
  return ROLE_TO_PURPOSE[role] ?? "effect_reference";
}

export function validateJobRequestSemantics(request) {
  const errors = [];

  if (!request || typeof request !== "object") {
    return { valid: false, errors: [{ path: "#", message: "job request must be an object" }] };
  }

  const inputAssets = Array.isArray(request.inputAssets) ? request.inputAssets : [];
  const byId = new Map();
  for (const [index, asset] of inputAssets.entries()) {
    if (!asset || typeof asset !== "object") continue;
    if (byId.has(asset.assetId)) {
      errors.push({
        path: `#/inputAssets/${index}/assetId`,
        message: `duplicate input asset ${asset.assetId}`,
      });
      continue;
    }
    byId.set(asset.assetId, { asset, index });
  }

  const effectSpec = request.effectSpec;
  if (!effectSpec || typeof effectSpec !== "object") {
    errors.push({ path: "#/effectSpec", message: "effectSpec is required for semantic checks" });
    return { valid: false, errors };
  }

  const required = new Map();

  const references = Array.isArray(effectSpec.references) ? effectSpec.references : [];
  for (const [index, ref] of references.entries()) {
    if (!ref || typeof ref !== "object" || !ref.assetId) continue;
    const purpose = purposeForRole(ref.role);
    const existing = required.get(ref.assetId);
    if (existing && existing.purpose !== purpose) {
      errors.push({
        path: `#/effectSpec/references/${index}/assetId`,
        message: `asset ${ref.assetId} has conflicting required purposes`,
      });
    }
    required.set(ref.assetId, {
      purpose,
      digest: ref.digest,
      path: `#/effectSpec/references/${index}`,
    });
  }

  const subjectMaskAssetId = effectSpec.guidance?.subjectMaskAssetId;
  if (subjectMaskAssetId) {
    required.set(subjectMaskAssetId, {
      purpose: "mask",
      digest: undefined,
      path: "#/effectSpec/guidance/subjectMaskAssetId",
    });
  }

  for (const [assetId, need] of required.entries()) {
    const found = byId.get(assetId);
    if (!found) {
      errors.push({
        path: need.path,
        message: `referenced asset ${assetId} missing from inputAssets`,
      });
      continue;
    }
    if (found.asset.purpose !== need.purpose) {
      errors.push({
        path: `#/inputAssets/${found.index}/purpose`,
        message: `asset ${assetId} purpose must be ${need.purpose}`,
      });
    }
    if (need.digest && found.asset.digest !== need.digest) {
      errors.push({
        path: `#/inputAssets/${found.index}/digest`,
        message: `asset ${assetId} digest must match EffectSpec reference`,
      });
    }
  }

  // At least one proxy is expected for Mock vertical-slice jobs.
  if (!inputAssets.some((asset) => asset?.purpose === "proxy")) {
    errors.push({
      path: "#/inputAssets",
      message: "inputAssets must include a proxy asset",
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Header/body idempotency key equality for createJob.
 * Canonical key is the request body field; the Idempotency-Key header must match.
 */
export function validateIdempotencyKeyPair(bodyKey, headerKey) {
  if (typeof bodyKey !== "string" || bodyKey.length === 0) {
    return {
      valid: false,
      errors: [{ path: "#/idempotencyKey", message: "body idempotencyKey is required" }],
    };
  }
  if (typeof headerKey !== "string" || headerKey.length === 0) {
    return {
      valid: false,
      errors: [{ path: "header/Idempotency-Key", message: "Idempotency-Key header is required" }],
    };
  }
  if (bodyKey !== headerKey) {
    return {
      valid: false,
      errors: [
        {
          path: "header/Idempotency-Key",
          message: "Idempotency-Key header must equal body idempotencyKey",
        },
      ],
    };
  }
  return { valid: true, errors: [] };
}
