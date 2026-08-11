import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
const examplesDir = path.join(repoRoot, "packages/contracts/examples/valid");

export async function loadValidExample(name) {
  const text = await readFile(path.join(examplesDir, name), "utf8");
  return JSON.parse(text);
}

export function digest(hexChar, length = 64) {
  return `sha256:${hexChar.repeat(length)}`;
}

export function makeAsset({
  assetId,
  digest: assetDigest,
  purpose,
  width = 64,
  height = 64,
  mediaType = "image/png",
  alphaMode = "straight",
  byteLength = 1024,
  ttlSeconds = 3600,
  createdAt = "2026-08-12T10:00:00Z",
  colorSpace = "srgb",
  sourceRole,
} = {}) {
  const descriptor = {
    schemaVersion: "1.0.0",
    assetId,
    mediaType,
    dimensions: { width, height },
    digest: assetDigest,
    alphaMode,
    byteLength,
    ttlSeconds,
    purpose,
    createdAt,
    colorSpace,
  };
  if (sourceRole) descriptor.sourceRole = sourceRole;
  return descriptor;
}

export function makeJobRequest({
  idempotencyKey = "idem_test_request_0001",
  label = "arbitrary-effect-label",
  assets,
  protectedSource,
  options,
  seed = 1,
} = {}) {
  const inputAssets = assets ?? [
    {
      assetId: "asset_proxy_source_01",
      digest: digest("1"),
      purpose: "proxy",
    },
    {
      assetId: "asset_effect_ref_01",
      digest: digest("a"),
      purpose: "effect_reference",
    },
  ];

  const effectRef = inputAssets.find((a) => a.purpose === "effect_reference") ?? inputAssets[1];

  return {
    schemaVersion: "1.0.0",
    idempotencyKey,
    clientRequestId: "test_client_1",
    effectSpec: {
      schemaVersion: "1.0.0",
      effectSpecVersion: "1.0.0",
      seed,
      label,
      canvas: {
        width: 64,
        height: 64,
        colorSpace: "srgb",
        pixelAspectRatio: 1,
        normalized: true,
      },
      references: effectRef
        ? [
            {
              id: "effect_ref",
              assetId: effectRef.assetId,
              role: "effect",
              digest: effectRef.digest,
              weight: 1,
            },
          ]
        : [],
      guidance: {
        anchors: [{ id: "a1", point: { x: 0.5, y: 0.5 }, radius: 0.1 }],
        strength: 0.5,
      },
      primitives: [
        {
          id: "p1",
          kind: "sprite",
          enabled: true,
          params: { scale: 1 },
        },
      ],
    },
    inputAssets,
    protectedSource: protectedSource ?? {
      layerStableId: "ps_layer_stable_source_01",
      documentStableId: "ps_doc_stable_01",
      immutable: true,
      operationsForbidden: [
        "modify_pixels",
        "move",
        "transform",
        "resize",
        "replace",
      ],
    },
    options: options ?? { priority: "normal", dryRun: false, ttlSeconds: 1800 },
  };
}

export async function registerDefaultAssets(api) {
  const assets = [
    makeAsset({
      assetId: "asset_proxy_source_01",
      digest: digest("1"),
      purpose: "proxy",
      sourceRole: "user_proxy",
    }),
    makeAsset({
      assetId: "asset_effect_ref_01",
      digest: digest("a"),
      purpose: "effect_reference",
      sourceRole: "user_effect_reference",
      width: 32,
      height: 32,
    }),
    makeAsset({
      assetId: "asset_subject_mask_01",
      digest: digest("3"),
      purpose: "mask",
      sourceRole: "user_mask",
    }),
  ];
  for (const asset of assets) {
    await api.createAsset(asset);
  }
  return assets;
}

export function silentLogger() {
  const lines = [];
  const sink = {
    info(line) {
      lines.push(line);
    },
    warn(line) {
      lines.push(line);
    },
    error(line) {
      lines.push(line);
    },
    log(line) {
      lines.push(line);
    },
  };
  return { sink, lines };
}
