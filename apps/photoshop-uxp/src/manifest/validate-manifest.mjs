/**
 * Layer Manifest validation for the UXP shell.
 * Enforces frozen schema structure plus semantic checks without runtime
 * package coupling so the shell stays dependency-light.
 */

import {
  SCHEMA_VERSION,
  MEDIA_TYPES,
  ASSET_PURPOSES,
  BLEND_MODES,
  PASS_KINDS,
  ASSET_ID_RE,
  MANIFEST_ID_RE,
  JOB_ID_RE,
  ID_RE,
  DIGEST_RE,
  requireObject,
  rejectUnknownKeys,
  rejectSensitiveTree,
  requireString,
  requireEnum,
  requireNumber,
  requireBoolean,
  requireIsoDateTime,
  requireDigest,
  requireAssetId,
  requireJobId,
  requireManifestId,
  requireStableId,
  validateNormalizedCanvas,
  validateDimensions,
  rejectSparseArray,
} from "../client/contract-shapes.mjs";

const RASTER_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * @typedef {{ path: string, message: string }} ValidationIssue
 * @typedef {{ valid: boolean, errors: ValidationIssue[] }} ValidationResult
 */

/**
 * Validate a Layer Manifest for import readiness against frozen schema + semantics.
 * @param {unknown} manifest
 * @returns {ValidationResult}
 */
export function validateLayerManifest(manifest) {
  /** @type {ValidationIssue[]} */
  const errors = [];

  if (!requireObject(manifest, "#", errors)) {
    return { valid: false, errors };
  }

  const m = /** @type {Record<string, unknown>} */ (manifest);
  rejectSensitiveTree(m, "#", errors);
  rejectUnknownKeys(
    m,
    [
      "schemaVersion",
      "manifestId",
      "jobId",
      "createdAt",
      "canvas",
      "protectedSource",
      "groupName",
      "passes",
      "assets",
      "importHints",
    ],
    "#",
    errors,
  );

  if (m.schemaVersion !== SCHEMA_VERSION) {
    errors.push({
      path: "#/schemaVersion",
      message: "schemaVersion must be 1.0.0",
    });
  }
  requireManifestId(m.manifestId, "#/manifestId", errors);
  requireJobId(m.jobId, "#/jobId", errors);
  requireIsoDateTime(m.createdAt, "#/createdAt", errors);
  validateNormalizedCanvas(m.canvas, "#/canvas", errors);
  validateProtectedSource(m.protectedSource, errors);

  if (m.groupName !== undefined) {
    requireString(m.groupName, "#/groupName", errors, { min: 1, max: 128 });
  }

  /** @type {Map<string, Record<string, unknown>>} */
  const assetById = new Map();
  validateAssets(m.assets, assetById, errors);
  validatePasses(m.passes, assetById, errors);
  validateImportHints(m.importHints, errors);

  return { valid: errors.length === 0, errors };
}

/**
 * @param {unknown} protectedSource
 * @param {ValidationIssue[]} errors
 */
function validateProtectedSource(protectedSource, errors) {
  if (!requireObject(protectedSource, "#/protectedSource", errors)) return;
  const p = /** @type {Record<string, unknown>} */ (protectedSource);
  rejectUnknownKeys(
    p,
    ["layerStableId", "documentStableId", "immutable", "untouched"],
    "#/protectedSource",
    errors,
  );
  requireString(p.layerStableId, "#/protectedSource/layerStableId", errors, {
    min: 1,
    max: 128,
  });
  if (p.documentStableId !== undefined) {
    requireString(
      p.documentStableId,
      "#/protectedSource/documentStableId",
      errors,
      { min: 1, max: 128 },
    );
  }
  if (p.immutable !== true) {
    errors.push({
      path: "#/protectedSource/immutable",
      message: "protected source must remain immutable",
    });
  }
  if (p.untouched !== true) {
    errors.push({
      path: "#/protectedSource/untouched",
      message: "protected source must be marked untouched",
    });
  }
}

/**
 * @param {unknown} assets
 * @param {Map<string, Record<string, unknown>>} assetById
 * @param {ValidationIssue[]} errors
 */
function validateAssets(assets, assetById, errors) {
  if (!Array.isArray(assets) || assets.length === 0) {
    errors.push({ path: "#/assets", message: "assets must be a non-empty array" });
    return;
  }
  if (assets.length > 64) {
    errors.push({ path: "#/assets", message: "assets must have at most 64 items" });
  }

  rejectSparseArray(assets, "#/assets", errors);
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index];
    const path = `#/assets/${index}`;
    if (!requireObject(asset, path, errors)) continue;
    const a = /** @type {Record<string, unknown>} */ (asset);
    rejectUnknownKeys(
      a,
      ["assetId", "digest", "mediaType", "purpose", "verified", "dimensions"],
      path,
      errors,
    );

    if (requireAssetId(a.assetId, `${path}/assetId`, errors)) {
      const id = /** @type {string} */ (a.assetId);
      if (assetById.has(id)) {
        errors.push({
          path: `${path}/assetId`,
          message: `duplicate assetId ${id}`,
        });
      } else {
        assetById.set(id, a);
      }
    }
    requireDigest(a.digest, `${path}/digest`, errors);
    requireEnum(a.mediaType, `${path}/mediaType`, MEDIA_TYPES, errors);
    requireEnum(a.purpose, `${path}/purpose`, ASSET_PURPOSES, errors);
    if (a.verified !== true) {
      errors.push({
        path: `${path}/verified`,
        message: "asset must be verified",
      });
    }
    if (a.dimensions !== undefined) {
      validateDimensions(a.dimensions, `${path}/dimensions`, errors);
    }
  }
}

/**
 * @param {unknown} passes
 * @param {Map<string, Record<string, unknown>>} assetById
 * @param {ValidationIssue[]} errors
 */
function validatePasses(passes, assetById, errors) {
  if (!Array.isArray(passes) || passes.length === 0) {
    errors.push({
      path: "#/passes",
      message: "successful manifest requires editable passes",
    });
    return;
  }
  if (passes.length > 32) {
    errors.push({
      path: "#/passes",
      message: "passes must have at most 32 items",
    });
  }

  /** @type {Set<string>} */
  const passIds = new Set();

  rejectSparseArray(passes, "#/passes", errors);
  for (let index = 0; index < passes.length; index += 1) {
    const pass = passes[index];
    validatePass(pass, index, assetById, passIds, errors);
  }

  for (let expected = 0; expected < passes.length; expected += 1) {
    const pass = passes[expected];
    const order =
      pass && typeof pass === "object"
        ? /** @type {{ order?: unknown }} */ (pass).order
        : undefined;
    if (order !== expected) {
      errors.push({
        path: "#/passes",
        message: "pass order values must be contiguous starting at 0",
      });
      break;
    }
  }
}

/**
 * @param {unknown} pass
 * @param {number} index
 * @param {Map<string, Record<string, unknown>>} assetById
 * @param {Set<string>} passIds
 * @param {ValidationIssue[]} errors
 */
function validatePass(pass, index, assetById, passIds, errors) {
  const path = `#/passes/${index}`;
  if (!requireObject(pass, path, errors)) return;
  const p = /** @type {Record<string, unknown>} */ (pass);

  rejectUnknownKeys(
    p,
    [
      "id",
      "name",
      "order",
      "kind",
      "editable",
      "visible",
      "opacity",
      "blendMode",
      "asset",
      "mask",
      "adjustments",
    ],
    path,
    errors,
  );

  if (requireStableId(p.id, `${path}/id`, errors)) {
    const id = /** @type {string} */ (p.id);
    if (passIds.has(id)) {
      errors.push({ path: `${path}/id`, message: `duplicate pass id ${id}` });
    } else {
      passIds.add(id);
    }
  }
  requireString(p.name, `${path}/name`, errors, { min: 1, max: 128 });
  requireNumber(p.order, `${path}/order`, errors, {
    integer: true,
    min: 0,
    max: 31,
  });
  if (p.order !== index) {
    errors.push({
      path: `${path}/order`,
      message: `pass order must equal array index ${index}`,
    });
  }
  requireEnum(p.kind, `${path}/kind`, PASS_KINDS, errors);
  if (p.editable !== true) {
    errors.push({
      path: `${path}/editable`,
      message: "pass must be editable",
    });
  }
  requireBoolean(p.visible, `${path}/visible`, errors);
  requireNumber(p.opacity, `${path}/opacity`, errors, { min: 0, max: 1 });
  requireEnum(p.blendMode, `${path}/blendMode`, BLEND_MODES, errors);

  validateAssetRef(
    p.asset,
    `${path}/asset`,
    assetById,
    new Set(["pass"]),
    "pass",
    errors,
  );

  if (p.mask !== undefined) {
    if (!requireObject(p.mask, `${path}/mask`, errors)) {
      // done
    } else {
      const mask = /** @type {Record<string, unknown>} */ (p.mask);
      rejectUnknownKeys(
        mask,
        ["asset", "inverted", "density"],
        `${path}/mask`,
        errors,
      );
      validateAssetRef(
        mask.asset,
        `${path}/mask/asset`,
        assetById,
        new Set(["mask"]),
        "mask",
        errors,
      );
      if (mask.inverted !== undefined) {
        requireBoolean(mask.inverted, `${path}/mask/inverted`, errors);
      }
      if (mask.density !== undefined) {
        requireNumber(mask.density, `${path}/mask/density`, errors, {
          min: 0,
          max: 1,
        });
      }
    }
  }

  if (p.adjustments !== undefined) {
    validateAdjustments(p.adjustments, `${path}/adjustments`, errors);
  }
}

/**
 * @param {unknown} adjustments
 * @param {string} path
 * @param {ValidationIssue[]} errors
 */
function validateAdjustments(adjustments, path, errors) {
  if (!requireObject(adjustments, path, errors)) return;
  const a = /** @type {Record<string, unknown>} */ (adjustments);
  rejectUnknownKeys(
    a,
    [
      "exposure",
      "contrast",
      "saturation",
      "temperature",
      "tint",
      "blurRadius",
    ],
    path,
    errors,
  );
  if (a.exposure !== undefined) {
    requireNumber(a.exposure, `${path}/exposure`, errors, { min: -5, max: 5 });
  }
  if (a.contrast !== undefined) {
    requireNumber(a.contrast, `${path}/contrast`, errors, { min: -1, max: 1 });
  }
  if (a.saturation !== undefined) {
    requireNumber(a.saturation, `${path}/saturation`, errors, {
      min: -1,
      max: 1,
    });
  }
  if (a.temperature !== undefined) {
    requireNumber(a.temperature, `${path}/temperature`, errors, {
      min: -1,
      max: 1,
    });
  }
  if (a.tint !== undefined) {
    requireNumber(a.tint, `${path}/tint`, errors, { min: -1, max: 1 });
  }
  if (a.blurRadius !== undefined) {
    requireNumber(a.blurRadius, `${path}/blurRadius`, errors, {
      min: 0,
      max: 64,
    });
  }
}

/**
 * @param {unknown} importHints
 * @param {ValidationIssue[]} errors
 */
function validateImportHints(importHints, errors) {
  if (importHints === undefined) return;
  if (!requireObject(importHints, "#/importHints", errors)) return;
  const hints = /** @type {Record<string, unknown>} */ (importHints);
  rejectUnknownKeys(
    hints,
    [
      "singleHistoryState",
      "placeAboveProtectedSource",
      "rollbackOnAnyFailure",
    ],
    "#/importHints",
    errors,
  );
  if (
    hints.singleHistoryState !== undefined &&
    hints.singleHistoryState !== true
  ) {
    errors.push({
      path: "#/importHints/singleHistoryState",
      message: "singleHistoryState must be true when present",
    });
  }
  if (
    hints.rollbackOnAnyFailure !== undefined &&
    hints.rollbackOnAnyFailure !== true
  ) {
    errors.push({
      path: "#/importHints/rollbackOnAnyFailure",
      message: "rollbackOnAnyFailure must be true when present",
    });
  }
  if (hints.placeAboveProtectedSource !== undefined) {
    requireBoolean(
      hints.placeAboveProtectedSource,
      "#/importHints/placeAboveProtectedSource",
      errors,
    );
  }
}

/**
 * @param {unknown} ref
 * @param {string} path
 * @param {Map<string, Record<string, unknown>>} assetById
 * @param {Set<string>} allowedPurposes
 * @param {string} role
 * @param {ValidationIssue[]} errors
 */
function validateAssetRef(ref, path, assetById, allowedPurposes, role, errors) {
  if (!requireObject(ref, path, errors)) return;
  const r = /** @type {Record<string, unknown>} */ (ref);
  rejectUnknownKeys(r, ["assetId", "digest"], path, errors);
  if (!requireAssetId(r.assetId, `${path}/assetId`, errors)) return;
  requireDigest(r.digest, `${path}/digest`, errors);

  const listed = assetById.get(/** @type {string} */ (r.assetId));
  if (!listed) {
    errors.push({
      path,
      message: `asset ${r.assetId} missing from manifest.assets`,
    });
    return;
  }
  if (listed.digest !== r.digest) {
    errors.push({
      path,
      message: `digest mismatch for ${r.assetId}`,
    });
  }
  if (listed.verified !== true) {
    errors.push({
      path,
      message: `asset ${r.assetId} is not verified`,
    });
  }
  if (!RASTER_MEDIA_TYPES.has(/** @type {string} */ (listed.mediaType))) {
    errors.push({
      path,
      message: `${role} asset ${r.assetId} must be a raster media type`,
    });
  }
  if (!allowedPurposes.has(/** @type {string} */ (listed.purpose))) {
    errors.push({
      path,
      message: `${role} asset ${r.assetId} purpose must be one of ${[...allowedPurposes].join(", ")}`,
    });
  }
}

// Re-export pattern constants used by tests / tooling.
export {
  DIGEST_RE,
  ASSET_ID_RE,
  MANIFEST_ID_RE,
  JOB_ID_RE,
  ID_RE,
  BLEND_MODES,
  PASS_KINDS,
};
