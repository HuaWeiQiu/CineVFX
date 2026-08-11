/**
 * Metadata-only proxy planning.
 * Real Photoshop proxy export / pixel readback is UNVERIFIED.
 */

import { FORBIDDEN_SOURCE_OPS, SCHEMA_VERSION } from "../constants.mjs";
import { cloneDataOnlyGraph } from "../safety/data-snapshot.mjs";

/**
 * @typedef {{
 *   layerStableId: string,
 *   documentStableId?: string,
 *   name?: string,
 *   bounds?: { x: number, y: number, width: number, height: number },
 * }} LayerRef
 */

/**
 * @typedef {{
 *   maxEdge?: number,
 *   colorSpace?: string,
 *   effectLabel?: string,
 *   effectLayer?: LayerRef,
 *   subjectMaskLayer?: LayerRef,
 *   guidanceAnchors?: Array<{ id: string, point: { x: number, y: number }, radius?: number }>,
 *   seed?: number,
 * }} ProxyPlanInput
 */

/**
 * Build a metadata-only proxy export plan. Does not read pixels or write files.
 * @param {LayerRef} protectedSource
 * @param {ProxyPlanInput} [input]
 */
const SUPPORTED_COLOR_SPACES = Object.freeze([
  "srgb",
  "display-p3",
  "adobe-rgb",
]);
const GUIDANCE_ID = /^[a-z][a-z0-9_]{1,63}$/;
const MAX_GUIDANCE_ANCHORS = 32;
const MAX_STABLE_ID_LENGTH = 128;
const MAX_LAYER_NAME_LENGTH = 256;
const MAX_SEED = 4294967295;

export function planProxyExport(protectedSource, input = {}) {
  let source;
  let options;
  try {
    source = /** @type {LayerRef} */ (cloneDataOnlyGraph(protectedSource));
  } catch (error) {
    throw new Error(
      `protectedSource must be stable metadata: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  try {
    options = /** @type {ProxyPlanInput} */ (cloneDataOnlyGraph(input));
  } catch (error) {
    throw new Error(
      `input must be stable metadata: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  assertLayerRef(source, "protectedSource");
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("input must be an object");
  }

  const maxEdge = options.maxEdge === undefined ? 1024 : options.maxEdge;
  if (
    !Number.isInteger(maxEdge) ||
    maxEdge < 64 ||
    maxEdge > 2048
  ) {
    throw new Error("maxEdge must be an integer in [64, 2048]");
  }

  const colorSpace = options.colorSpace === undefined ? "srgb" : options.colorSpace;
  if (
    typeof colorSpace !== "string" ||
    !SUPPORTED_COLOR_SPACES.includes(colorSpace)
  ) {
    throw new Error(
      `colorSpace must be one of ${SUPPORTED_COLOR_SPACES.join(", ")}`,
    );
  }

  if (options.effectLabel !== undefined && typeof options.effectLabel !== "string") {
    throw new Error("effectLabel must be a string");
  }
  const effectLabel =
    typeof options.effectLabel === "string" && options.effectLabel.trim()
      ? options.effectLabel.trim()
      : "effect";
  if (effectLabel.length > 128) {
    throw new Error("effectLabel must be at most 128 characters");
  }

  if (options.seed !== undefined) {
    if (
      !Number.isInteger(options.seed) ||
      options.seed < 0 ||
      options.seed > MAX_SEED
    ) {
      throw new Error("seed must be an integer in [0, 4294967295]");
    }
  }

  if (options.effectLayer !== undefined) {
    assertLayerRef(options.effectLayer, "effectLayer");
  }
  if (options.subjectMaskLayer !== undefined) {
    assertLayerRef(options.subjectMaskLayer, "subjectMaskLayer");
  }

  const bounds = source.bounds ?? {
    x: 0,
    y: 0,
    width: maxEdge,
    height: maxEdge,
  };
  assertFiniteBounds(bounds);

  const proxyDimensions = fitWithinMaxEdge(bounds, maxEdge);

  /** Planned asset metadata only — digests filled after real export (UNVERIFIED). */
  const plannedAssets = [
    {
      role: "proxy",
      purpose: "proxy",
      sourceRole: "user_proxy",
      fromLayerStableId: source.layerStableId,
      mediaType: "image/png",
      alphaMode: "straight",
      dimensions: proxyDimensions,
      /** Placeholder digest slot; real hash UNVERIFIED until export runs. */
      digestPending: true,
    },
  ];

  if (options.subjectMaskLayer?.layerStableId) {
    plannedAssets.push({
      role: "subject_mask",
      purpose: "mask",
      sourceRole: "user_mask",
      fromLayerStableId: options.subjectMaskLayer.layerStableId,
      mediaType: "image/png",
      alphaMode: "straight",
      dimensions: proxyDimensions,
      digestPending: true,
    });
  }

  if (options.effectLayer?.layerStableId) {
    plannedAssets.push({
      role: "effect_reference",
      purpose: "effect_reference",
      sourceRole: "user_effect_reference",
      fromLayerStableId: options.effectLayer.layerStableId,
      mediaType: "image/png",
      alphaMode: "straight",
      dimensions: proxyDimensions,
      digestPending: true,
    });
  }

  let anchors;
  if (options.guidanceAnchors === undefined) {
    anchors = [
      {
        id: "anchor_center",
        point: { x: 0.5, y: 0.5 },
        radius: 0.2,
      },
    ];
  } else {
    if (!Array.isArray(options.guidanceAnchors)) {
      throw new Error("guidanceAnchors must be an array");
    }
    if (options.guidanceAnchors.length > MAX_GUIDANCE_ANCHORS) {
      throw new Error(
        `guidanceAnchors must contain at most ${MAX_GUIDANCE_ANCHORS} items`,
      );
    }
    anchors = [];
    for (let index = 0; index < options.guidanceAnchors.length; index += 1) {
      anchors.push(normalizeAnchor(options.guidanceAnchors[index]));
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "proxy_export_plan",
    /** Real pixel export is UNVERIFIED in this shell. */
    execution: {
      status: "planned_only",
      verified: false,
      note: "UNVERIFIED: real Photoshop proxy export not executed",
    },
    protectedSource: {
      layerStableId: source.layerStableId,
      ...(source.documentStableId !== undefined
        ? { documentStableId: source.documentStableId }
        : {}),
      immutable: true,
      operationsForbidden: [...FORBIDDEN_SOURCE_OPS],
      /** Bounds are planning metadata only — not subject-preservation proof. */
      bounds,
      boundsAreNotPreservationProof: true,
    },
    canvas: {
      width: proxyDimensions.width,
      height: proxyDimensions.height,
      colorSpace,
      pixelAspectRatio: 1,
      normalized: true,
    },
    effectLabel,
    seed: options.seed ?? 42,
    guidance: {
      anchors,
      strength: 0.7,
      ...(options.subjectMaskLayer?.layerStableId
        ? { subjectMaskLayerStableId: options.subjectMaskLayer.layerStableId }
        : {}),
    },
    plannedAssets,
    /** Network registration of assets happens outside any modal write. */
    nextPhases: [
      { name: "network_wait", allowsNetwork: true, action: "register_assets" },
      { name: "network_wait", allowsNetwork: true, action: "create_job" },
    ],
  };
}


/**
 * @param {unknown} bounds
 */
function assertFiniteBounds(bounds) {
  if (!bounds || typeof bounds !== "object" || Array.isArray(bounds)) {
    throw new Error("bounds must be an object");
  }
  const b = /** @type {Record<string, unknown>} */ (bounds);
  for (const key of ["x", "y", "width", "height"]) {
    if (typeof b[key] !== "number" || !Number.isFinite(b[key])) {
      throw new Error(`bounds.${key} must be a finite number`);
    }
  }
  if (b.width <= 0 || b.height <= 0) {
    throw new Error("bounds width and height must be positive");
  }
}

/**
 * @param {unknown} layer
 * @param {string} label
 */
function assertLayerRef(layer, label) {
  if (!layer || typeof layer !== "object" || Array.isArray(layer)) {
    throw new Error(`${label} must be an object`);
  }
  const l = /** @type {Record<string, unknown>} */ (layer);
  if (
    typeof l.layerStableId !== "string" ||
    l.layerStableId.trim() === "" ||
    l.layerStableId.length > MAX_STABLE_ID_LENGTH
  ) {
    throw new Error(`${label}.layerStableId must be a non-empty string`);
  }
  if (
    l.documentStableId !== undefined &&
    (typeof l.documentStableId !== "string" ||
      l.documentStableId.trim() === "" ||
      l.documentStableId.length > MAX_STABLE_ID_LENGTH)
  ) {
    throw new Error(
      `${label}.documentStableId must be a non-empty string when provided`,
    );
  }
  if (
    l.name !== undefined &&
    (typeof l.name !== "string" || l.name.length > MAX_LAYER_NAME_LENGTH)
  ) {
    throw new Error(
      `${label}.name must be a string of at most ${MAX_LAYER_NAME_LENGTH} characters`,
    );
  }
  if (l.bounds !== undefined) {
    assertFiniteBounds(l.bounds);
  }
}

/**
 * @param {{ x: number, y: number, width: number, height: number }} bounds
 * @param {number} maxEdge
 */
function fitWithinMaxEdge(bounds, maxEdge) {
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  const edge = Math.max(width, height);
  if (edge <= maxEdge) {
    return { width, height };
  }
  const scale = maxEdge / edge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * @param {unknown} anchor
 */
function normalizeAnchor(anchor) {
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) {
    throw new Error("guidance anchor must be an object");
  }
  const a = /** @type {Record<string, unknown>} */ (anchor);
  const unknownKeys = Object.keys(a).filter(
    (key) => !["id", "point", "radius"].includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`guidance anchor has unsupported key: ${unknownKeys[0]}`);
  }
  if (typeof a.id !== "string" || !GUIDANCE_ID.test(a.id)) {
    throw new Error("guidance anchor id must match ^[a-z][a-z0-9_]{1,63}$");
  }
  if (!a.point || typeof a.point !== "object" || Array.isArray(a.point)) {
    throw new Error("guidance anchor point must be an object");
  }
  const point = /** @type {Record<string, unknown>} */ (a.point);
  const unknownPointKeys = Object.keys(point).filter(
    (key) => !["x", "y"].includes(key),
  );
  if (unknownPointKeys.length > 0) {
    throw new Error(
      `guidance anchor point has unsupported key: ${unknownPointKeys[0]}`,
    );
  }
  const { x, y } = point;
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    x < 0 ||
    x > 1 ||
    typeof y !== "number" ||
    !Number.isFinite(y) ||
    y < 0 ||
    y > 1
  ) {
    throw new Error("guidance anchor point coordinates must be numbers in [0, 1]");
  }
  if (
    a.radius !== undefined &&
    (typeof a.radius !== "number" ||
      !Number.isFinite(a.radius) ||
      a.radius < 0 ||
      a.radius > 1)
  ) {
    throw new Error("guidance anchor radius must be a number in [0, 1]");
  }
  return {
    id: a.id,
    point: { x, y },
    ...(a.radius === undefined ? {} : { radius: a.radius }),
  };
}
