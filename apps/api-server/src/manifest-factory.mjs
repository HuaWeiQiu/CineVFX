/**
 * Fixed generic validated editable Layer Manifest factory.
 * Digests are deterministic and agree between pass refs and assets list.
 * Pass content is metadata-only; no image bytes are produced.
 */

import { cloneJson, formatIsoUtc, padCounter } from "./util.mjs";

const PASS_TEMPLATES = Object.freeze([
  {
    id: "pass_effect",
    name: "Effect",
    kind: "effect",
    opacity: 1,
    blendMode: "screen",
    digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    maskDigest: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
    adjustments: { exposure: 0.1, saturation: 0.05 },
  },
  {
    id: "pass_relight",
    name: "Relight",
    kind: "relight",
    opacity: 0.65,
    blendMode: "soft_light",
    digest: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
    adjustments: { temperature: 0.08, contrast: 0.05 },
  },
  {
    id: "pass_atmosphere",
    name: "Atmosphere",
    kind: "atmosphere",
    opacity: 0.4,
    blendMode: "screen",
    digest: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
  },
  {
    id: "pass_grade",
    name: "Grade",
    kind: "grade",
    opacity: 0.35,
    blendMode: "color",
    digest: "sha256:7777777777777777777777777777777777777777777777777777777777777777",
    adjustments: { tint: -0.02, contrast: 0.03 },
  },
  {
    id: "pass_bloom",
    name: "Bloom",
    kind: "bloom",
    opacity: 0.5,
    blendMode: "linear_dodge",
    digest: "sha256:8888888888888888888888888888888888888888888888888888888888888888",
    adjustments: { blurRadius: 4.5 },
  },
]);

function assetIdFor(jobSuffix, role) {
  return `asset_${jobSuffix}_${role}`;
}

/**
 * Build a fixed generic Layer Manifest for a succeeded job.
 * @param {object} params
 * @param {string} params.jobId
 * @param {string} params.manifestId
 * @param {object} params.canvas
 * @param {object} params.protectedSource
 * @param {string} [params.createdAt]
 * @param {string} [params.jobSuffix] short id fragment for pass asset ids
 */
export function buildFixedLayerManifest({
  jobId,
  manifestId,
  canvas,
  protectedSource,
  createdAt = formatIsoUtc(),
  jobSuffix = "mock",
}) {
  const passes = [];
  const assets = [];

  for (const [index, template] of PASS_TEMPLATES.entries()) {
    const passAssetId = assetIdFor(jobSuffix, template.id.replace(/^pass_/, "pass_"));
    // Keep ids short and pattern-safe: asset_[a-z0-9_]{1,56}
    const safePassId = `asset_pass_${jobSuffix}_${template.kind}`.slice(0, 62);
    const pass = {
      id: template.id,
      name: template.name,
      order: index,
      kind: template.kind,
      editable: true,
      visible: true,
      opacity: template.opacity,
      blendMode: template.blendMode,
      asset: {
        assetId: safePassId,
        digest: template.digest,
      },
    };
    if (template.adjustments) {
      pass.adjustments = cloneJson(template.adjustments);
    }
    if (template.maskDigest) {
      const maskId = `asset_pass_${jobSuffix}_${template.kind}_mask`.slice(0, 62);
      pass.mask = {
        asset: {
          assetId: maskId,
          digest: template.maskDigest,
        },
        inverted: false,
        density: 1,
      };
      assets.push({
        assetId: maskId,
        digest: template.maskDigest,
        mediaType: "image/png",
        purpose: "mask",
        verified: true,
        dimensions: {
          width: canvas.width,
          height: canvas.height,
        },
      });
    }
    passes.push(pass);
    assets.push({
      assetId: safePassId,
      digest: template.digest,
      mediaType: "image/png",
      purpose: "pass",
      verified: true,
      dimensions: {
        width: canvas.width,
        height: canvas.height,
      },
    });
  }

  const protectedSourceOut = {
    layerStableId: protectedSource.layerStableId,
    immutable: true,
    untouched: true,
  };
  if (protectedSource.documentStableId) {
    protectedSourceOut.documentStableId = protectedSource.documentStableId;
  }

  return {
    schemaVersion: "1.0.0",
    manifestId,
    jobId,
    createdAt,
    canvas: cloneJson(canvas),
    protectedSource: protectedSourceOut,
    groupName: "CineVFX Passes",
    passes,
    assets,
    importHints: {
      singleHistoryState: true,
      placeAboveProtectedSource: true,
      rollbackOnAnyFailure: true,
    },
  };
}

export { PASS_TEMPLATES, padCounter };
