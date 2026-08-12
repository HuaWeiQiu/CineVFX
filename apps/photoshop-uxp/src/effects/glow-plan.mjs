/**
 * Pure planning for the first local, non-destructive glow effect.
 * This module does not import Photoshop or perform document writes.
 */

import { cloneDataOnlyGraph } from "../safety/data-snapshot.mjs";

const CONTEXT_KEYS = Object.freeze([
  "documentId",
  "sourceLayerId",
  "documentMode",
  "bitsPerChannel",
  "layerKind",
  "visible",
  "bounds",
  "sourceSnapshot",
]);
const SETTINGS_KEYS = Object.freeze([
  "recipeId",
  "color",
  "intensity",
  "size",
  "blur",
  "blendMode",
]);
const BOUNDS_KEYS = Object.freeze(["x", "y", "width", "height"]);
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const MAX_PIXEL_COUNT = 100_000_000n;
const MAX_ESTIMATED_PEAK_BYTES = 1_073_741_824n;
const RGBA_COMPONENTS = 4n;
const PEAK_SURFACE_FACTOR = 6n;

export class GlowPlanError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`CineVFX glow plan rejected (${code})`);
    this.name = "GlowPlanError";
    this.code = code;
  }
}

/**
 * @typedef {{
 *   documentId: number,
 *   sourceLayerId: number,
 *   documentMode: "rgb",
 *   bitsPerChannel: 8 | 16,
 *   layerKind: "pixel" | "smartObject",
 *   visible: true,
 *   bounds: { x: number, y: number, width: number, height: number },
 *   sourceSnapshot: Record<string, unknown>,
 * }} GlowContext
 */

/**
 * @typedef {{
 *   recipeId?: "soft_glow",
 *   color: string,
 *   intensity: number,
 *   size: number,
 *   blur: number,
 *   blendMode: "screen" | "linearDodge",
 * }} GlowSettings
 */

/**
 * Build a frozen, data-only plan for host execution.
 * @param {unknown} context
 * @param {unknown} settings
 */
export function planGlowEffect(context, settings) {
  const stableContext = snapshotInput(context, "context");
  const stableSettings = snapshotInput(settings, "settings");
  assertPlainRecord(stableContext, "context");
  assertPlainRecord(stableSettings, "settings");
  assertExactKeys(stableContext, CONTEXT_KEYS, CONTEXT_KEYS, "context");
  assertExactKeys(
    stableSettings,
    SETTINGS_KEYS,
    SETTINGS_KEYS.filter((key) => key !== "recipeId"),
    "settings",
  );

  const ctx = /** @type {Record<string, unknown>} */ (stableContext);
  const opts = /** @type {Record<string, unknown>} */ (stableSettings);
  validateContext(ctx);
  validateSettings(opts);

  const bounds = /** @type {{ x: number, y: number, width: number, height: number }} */ (
    ctx.bounds
  );
  const memory = estimateMemory(bounds, /** @type {8 | 16} */ (ctx.bitsPerChannel));
  const rgb = parseRgb(/** @type {string} */ (opts.color));
  const intensity = /** @type {number} */ (opts.intensity);

  const plan = {
    kind: "local_glow_plan",
    recipeId: opts.recipeId ?? "soft_glow",
    source: {
      documentId: ctx.documentId,
      sourceLayerId: ctx.sourceLayerId,
      documentMode: ctx.documentMode,
      bitsPerChannel: ctx.bitsPerChannel,
      layerKind: ctx.layerKind,
      visible: true,
      bounds: { ...bounds },
      sourceSnapshot: ctx.sourceSnapshot,
      immutable: true,
      operationsForbidden: [
        "modify_pixels",
        "move",
        "transform",
        "resize",
        "replace",
        "delete",
      ],
    },
    settings: {
      color: /** @type {string} */ (opts.color).toUpperCase(),
      rgb,
      intensity,
      size: opts.size,
      blur: opts.blur,
      blendMode: opts.blendMode,
      outerOpacity: intensity,
      bloomOpacity: Math.round(intensity * 0.65),
    },
    names: {
      group: "CineVFX 发光",
      edge: "发光边缘",
      bloom: "柔光扩散",
    },
    transaction: {
      mode: "single_history_state",
      historyName: "CineVFX 发光",
      rollbackOnAnyFailure: true,
      noPartialGroup: true,
      allowsNetwork: false,
    },
    memory,
  };

  return deepFreeze(plan);
}

/** @param {Record<string, unknown>} context */
function validateContext(context) {
  for (const key of ["documentId", "sourceLayerId"]) {
    const value = context[key];
    if (!Number.isSafeInteger(value) || /** @type {number} */ (value) <= 0) {
      throw new Error(`context.${key} must be a positive safe integer`);
    }
  }
  if (context.documentMode !== "rgb") {
    throw new Error("context.documentMode must be rgb");
  }
  if (context.bitsPerChannel !== 8 && context.bitsPerChannel !== 16) {
    throw new Error("context.bitsPerChannel must be 8 or 16");
  }
  if (context.layerKind !== "pixel" && context.layerKind !== "smartObject") {
    throw new Error("context.layerKind must be pixel or smartObject");
  }
  if (context.visible !== true) {
    throw new Error("context.visible must be true");
  }
  assertPlainRecord(context.bounds, "context.bounds");
  assertExactKeys(context.bounds, BOUNDS_KEYS, BOUNDS_KEYS, "context.bounds");
  const bounds = /** @type {Record<string, unknown>} */ (context.bounds);
  for (const key of BOUNDS_KEYS) {
    if (typeof bounds[key] !== "number" || !Number.isFinite(bounds[key])) {
      throw new Error(`context.bounds.${key} must be a finite number`);
    }
  }
  if (
    /** @type {number} */ (bounds.width) <= 0 ||
    /** @type {number} */ (bounds.height) <= 0
  ) {
    throw new Error("context.bounds width and height must be positive");
  }
  assertPlainRecord(context.sourceSnapshot, "context.sourceSnapshot");
  assertExactKeys(
    context.sourceSnapshot,
    ["documentId", "sourceLayerId"],
    ["documentId", "sourceLayerId"],
    "context.sourceSnapshot",
  );
  const sourceSnapshot = /** @type {Record<string, unknown>} */ (
    context.sourceSnapshot
  );
  if (
    sourceSnapshot.documentId !== context.documentId ||
    sourceSnapshot.sourceLayerId !== context.sourceLayerId
  ) {
    throw new Error("context.sourceSnapshot must match the protected source");
  }
}

/** @param {Record<string, unknown>} settings */
function validateSettings(settings) {
  if (settings.recipeId !== undefined && settings.recipeId !== "soft_glow") {
    throw new Error("settings.recipeId must be soft_glow when provided");
  }
  if (typeof settings.color !== "string" || !HEX_COLOR.test(settings.color)) {
    throw new Error("settings.color must be a #RRGGBB hex color");
  }
  assertNumberRange(settings.intensity, 0, 100, "settings.intensity");
  assertNumberRange(settings.size, 1, 250, "settings.size");
  assertNumberRange(settings.blur, 0.1, 250, "settings.blur");
  if (settings.blendMode !== "screen" && settings.blendMode !== "linearDodge") {
    throw new Error("settings.blendMode must be screen or linearDodge");
  }
}

/**
 * @param {{ width: number, height: number }} bounds
 * @param {8 | 16} bitsPerChannel
 */
function estimateMemory(bounds, bitsPerChannel) {
  const pixelWidth = BigInt(Math.ceil(bounds.width));
  const pixelHeight = BigInt(Math.ceil(bounds.height));
  const pixelCount = pixelWidth * pixelHeight;
  if (pixelCount > MAX_PIXEL_COUNT) {
    throw new GlowPlanError("memory_limit_exceeded");
  }
  const bytesPerComponent = BigInt(bitsPerChannel / 8);
  const estimatedPeakBytes =
    pixelCount * RGBA_COMPONENTS * bytesPerComponent * PEAK_SURFACE_FACTOR;
  if (estimatedPeakBytes > MAX_ESTIMATED_PEAK_BYTES) {
    throw new GlowPlanError("memory_limit_exceeded");
  }
  const safePixelCount = Number(pixelCount);
  const safeEstimatedPeakBytes = Number(estimatedPeakBytes);
  if (
    !Number.isSafeInteger(safePixelCount) ||
    !Number.isSafeInteger(safeEstimatedPeakBytes)
  ) {
    throw new Error("glow memory estimate is not safely representable");
  }
  return {
    pixelWidth: Number(pixelWidth),
    pixelHeight: Number(pixelHeight),
    pixelCount: safePixelCount,
    estimatedPeakBytes: safeEstimatedPeakBytes,
    hardLimitBytes: Number(MAX_ESTIMATED_PEAK_BYTES),
    surfaces: Number(PEAK_SURFACE_FACTOR),
    componentsPerPixel: Number(RGBA_COMPONENTS),
    bytesPerComponent: Number(bytesPerComponent),
    calculatedWith: "bigint",
  };
}

/** @param {string} color */
function parseRgb(color) {
  return {
    red: Number.parseInt(color.slice(1, 3), 16),
    green: Number.parseInt(color.slice(3, 5), 16),
    blue: Number.parseInt(color.slice(5, 7), 16),
  };
}

/** @param {unknown} value @param {number} min @param {number} max @param {string} path */
function assertNumberRange(value, min, max, path) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${path} must be a finite number in [${min}, ${max}]`);
  }
}

/** @param {unknown} value @param {string} path */
function assertPlainRecord(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {readonly string[]} required
 * @param {string} path
 */
function assertExactKeys(value, allowed, required, path) {
  const record = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error(`${path}.${key} is not allowed`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`${path}.${key} is required`);
    }
  }
}

/** @param {unknown} value @param {string} label */
function snapshotInput(value, label) {
  try {
    return cloneDataOnlyGraph(value);
  } catch (error) {
    throw new Error(
      `${label} must be stable data-only metadata: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) {
    deepFreeze(/** @type {Record<string, unknown>} */ (value)[key]);
  }
  return Object.freeze(value);
}
