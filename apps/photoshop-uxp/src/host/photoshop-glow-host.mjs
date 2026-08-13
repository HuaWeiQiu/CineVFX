/**
 * Minimal Photoshop DOM adapter for a non-destructive two-layer glow.
 * The Photoshop module is loaded lazily so importing this module in Node is safe.
 */

const HISTORY_SENTINEL = 0xffffffff;
const FORBIDDEN_SOURCE_OPERATIONS = Object.freeze([
  "modify_pixels",
  "move",
  "transform",
  "resize",
  "replace",
  "delete",
]);
const SOURCE_KEYS = Object.freeze([
  "id",
  "documentId",
  "parentId",
  "name",
  "kind",
  "visible",
  "opacity",
  "fillOpacity",
  "blendMode",
  "allLocked",
  "pixelsLocked",
  "positionLocked",
  "transparentPixelsLocked",
]);
const PIXEL_DIGEST_HEX = /^[a-f0-9]{64}$/;

export class GlowHostError extends Error {
  /**
   * @param {string} code
   * @param {string} stage
   */
  constructor(code, stage) {
    super(`CineVFX Photoshop host failure (${code}:${stage})`);
    this.name = "GlowHostError";
    this.code = code;
    this.stage = stage;
  }
}

/**
 * @param {{
 *   loadPhotoshop?: () => unknown,
 * }} [options]
 */
export function createPhotoshopGlowHost(options) {
  const config = options === undefined ? null : options;
  if (config !== null && !isPlainRecord(config)) {
    throw new GlowHostError("invalid_options", "initialize");
  }
  const optionKeys = config === null ? [] : Object.keys(config);
  if (optionKeys.some((key) => key !== "loadPhotoshop")) {
    throw new GlowHostError("invalid_options", "initialize");
  }
  if (
    config?.loadPhotoshop !== undefined &&
    typeof config.loadPhotoshop !== "function"
  ) {
    throw new GlowHostError("invalid_options", "initialize");
  }

  const loadPhotoshop =
    config?.loadPhotoshop ?? (() => require("photoshop"));
  let hostModule;
  let sourceSnapshot = null;
  let publicContext = null;

  function host() {
    if (hostModule !== undefined) return hostModule;
    let candidate;
    try {
      candidate = loadPhotoshop();
    } catch {
      throw new GlowHostError("host_unavailable", "load_host");
    }
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !candidate.app ||
      !candidate.core ||
      !candidate.action ||
      !candidate.constants ||
      typeof candidate.core.executeAsModal !== "function" ||
      typeof candidate.action.batchPlay !== "function"
    ) {
      throw new GlowHostError("host_unavailable", "load_host");
    }
    hostModule = candidate;
    return hostModule;
  }

  function inspectActiveContext() {
    const ps = host();
    sourceSnapshot = null;
    publicContext = null;
    try {
      const inspected = inspectSelection(ps, "inspect");
      const nextSnapshot = captureSourceSnapshot(
        inspected.document,
        inspected.layer,
      );
      const sourceIdentity = deepFreeze({
        documentId: inspected.documentId,
        sourceLayerId: inspected.layerId,
      });
      const nextContext = deepFreeze({
        documentId: inspected.documentId,
        sourceLayerId: inspected.layerId,
        documentMode: "rgb",
        bitsPerChannel: inspected.bitsPerChannel,
        layerKind: inspected.kindLabel,
        visible: true,
        bounds: inspected.bounds,
        sourceSnapshot: sourceIdentity,
      });
      sourceSnapshot = nextSnapshot;
      publicContext = nextContext;
      return publicContext;
    } catch (error) {
      throw fixedError(error, "inspection_failed", "inspect");
    }
  }

  /**
   * @param {unknown} plan
   */
  async function applyGlow(plan) {
    const ps = host();
    if (!sourceSnapshot || !publicContext) {
      throw new GlowHostError("context_required", "preflight");
    }
    const stablePlan = normalizePlan(plan, publicContext);
    const protectedSnapshot = sourceSnapshot;
    let callbackEntered = false;

    try {
      return await ps.core.executeAsModal(
        async (executionContext) => {
          callbackEntered = true;
          let stage = "revalidate";
          let suspension = null;
          let historyOwned = false;
          let primaryError = null;

          try {
            // This must remain the first host operation in the callback. No write or
            // history suspension may occur before the exact selection is rechecked.
            const current = inspectSelection(ps, "revalidate");
            if (
              current.documentId !== protectedSnapshot.documentId ||
              current.layerId !== protectedSnapshot.id ||
              current.bitsPerChannel !== stablePlan.source.bitsPerChannel
            ) {
              throw new GlowHostError("selection_changed", "revalidate");
            }
            assertSourceUnchanged(
              protectedSnapshot,
              captureSourceSnapshot(current.document, current.layer),
              "revalidate",
            );
            const pixelsBefore = await readSourcePixelDigest(
              ps,
              protectedSnapshot.documentId,
              protectedSnapshot.id,
            );
            assertNotCancelled(executionContext, "revalidate");

            const beforeIds = collectLayerIds(current.document);
            stage = "suspend_history";
            suspension = await executionContext.hostControl.suspendHistory({
              documentID: protectedSnapshot.documentId,
              name: stablePlan.transaction.historyName,
            });
            if (isHistorySentinel(suspension)) {
              throw new GlowHostError(
                "history_owned_externally",
                "suspend_history",
              );
            }
            historyOwned = true;
            assertNotCancelled(executionContext, "suspend_history");

            const placement = requirePlacements(ps.constants);
            stage = "create_group";
            const group = await current.document.createLayerGroup({
              name: stablePlan.names.group,
            });
            assertHostLayer(group, "create_group");
            assertNotCancelled(executionContext, "create_group");
            await group.move(current.layer, placement.above);
            assertNotCancelled(executionContext, "create_group");

            stage = "create_edge";
            const edge = await current.layer.duplicate(
              group,
              placement.inside,
              stablePlan.names.edge,
            );
            assertHostLayer(edge, "create_edge");
            assertNotCancelled(executionContext, "create_edge");
            unlockDerivedLayer(edge);
            edge.name = stablePlan.names.edge;
            edge.fillOpacity = 0;
            const edgeResult = await ps.action.batchPlay(
              [outerGlowDescriptor(
                protectedSnapshot.documentId,
                edge.id,
                stablePlan,
              )],
              { continueOnError: false, immediateRedraw: false },
            );
            assertBatchPlayResult(edgeResult, 1, "edge_effect");
            assertNotCancelled(executionContext, "edge_effect");

            stage = "create_bloom";
            const bloom = await current.layer.duplicate(
              group,
              placement.inside,
              stablePlan.names.bloom,
            );
            assertHostLayer(bloom, "create_bloom");
            assertNotCancelled(executionContext, "create_bloom");
            unlockDerivedLayer(bloom);
            bloom.name = stablePlan.names.bloom;
            const bloomResult = await ps.action.batchPlay(
              [colorOverlayDescriptor(
                protectedSnapshot.documentId,
                bloom.id,
                stablePlan.settings.rgb,
              )],
              { continueOnError: false, immediateRedraw: false },
            );
            assertBatchPlayResult(bloomResult, 1, "bloom_overlay");
            assertNotCancelled(executionContext, "bloom_overlay");

            stage = "bloom_blur";
            if (typeof bloom.applyGaussianBlur !== "function") {
              throw new GlowHostError("unsupported_layer", "bloom_blur");
            }
            await bloom.applyGaussianBlur(stablePlan.settings.blur);
            assertNotCancelled(executionContext, "bloom_blur");
            bloom.blendMode = requireBlendMode(
              ps.constants,
              stablePlan.settings.blendMode,
            );
            bloom.opacity = stablePlan.settings.bloomOpacity;
            assertNotCancelled(executionContext, "bloom_blur");

            stage = "verify";
            const sourceAfter = findLayerById(
              current.document,
              protectedSnapshot.id,
            );
            if (!sourceAfter) {
              throw new GlowHostError("source_missing", "verify");
            }
            assertSourceUnchanged(
              protectedSnapshot,
              captureSourceSnapshot(current.document, sourceAfter),
              "verify",
            );
            const pixelsAfter = await readSourcePixelDigest(
              ps,
              protectedSnapshot.documentId,
              protectedSnapshot.id,
            );
            assertPixelDigestUnchanged(pixelsBefore, pixelsAfter, "verify");
            verifyCreatedGraph({
              document: current.document,
              source: sourceAfter,
              group,
              edge,
              bloom,
              beforeIds,
            });

            stage = "commit";
            await executionContext.hostControl.resumeHistory(suspension, true);
            historyOwned = false;
            return deepFreeze({
              committed: true,
              documentId: protectedSnapshot.documentId,
              sourceLayerId: protectedSnapshot.id,
              groupLayerId: group.id,
              edgeLayerId: edge.id,
              bloomLayerId: bloom.id,
            });
          } catch (error) {
            primaryError = executionContext?.isCancelled
              ? new GlowHostError("user_cancelled", stage)
              : fixedError(error, "host_operation_failed", stage);
            if (historyOwned) {
              try {
                await executionContext.hostControl.resumeHistory(
                  suspension,
                  false,
                );
                historyOwned = false;
              } catch {
                // Throw a fixed rollback code without exposing either host error.
                throw new GlowHostError("rollback_failed", "rollback");
              }
            }
            throw primaryError;
          }
        },
        { commandName: stablePlan.transaction.historyName, timeOut: 5000 },
      );
    } catch (error) {
      if (error instanceof GlowHostError) throw error;
      throw new GlowHostError(
        "modal_unavailable",
        callbackEntered ? "modal_callback" : "execute_as_modal",
      );
    }
  }

  return Object.freeze({
    inspectActiveContext,
    inspectSelectedLayer: inspectActiveContext,
    applyGlow,
  });
}

function inspectSelection(ps, stage) {
  const document = ps.app.activeDocument;
  if (!document) throw new GlowHostError("no_active_document", stage);
  const documentId = positiveSafeInteger(document.id, "invalid_document", stage);
  const layers = document.activeLayers;
  if (!layers || !Number.isSafeInteger(layers.length) || layers.length < 0) {
    throw new GlowHostError("invalid_selection", stage);
  }
  if (layers.length === 0) {
    throw new GlowHostError("no_active_layer", stage);
  }
  if (layers.length !== 1) {
    throw new GlowHostError("multiple_active_layers", stage);
  }
  const layer = layers[0];
  assertHostLayer(layer, stage);
  const layerId = positiveSafeInteger(layer.id, "invalid_layer", stage);
  const constants = ps.constants;
  const rgbMode = constants?.DocumentMode?.RGB;
  if (rgbMode === undefined || document.mode !== rgbMode) {
    throw new GlowHostError("unsupported_document_mode", stage);
  }
  const eight = constants?.BitsPerChannelType?.EIGHT;
  const sixteen = constants?.BitsPerChannelType?.SIXTEEN;
  let bitsPerChannel;
  if (eight !== undefined && document.bitsPerChannel === eight) {
    bitsPerChannel = 8;
  } else if (sixteen !== undefined && document.bitsPerChannel === sixteen) {
    bitsPerChannel = 16;
  } else {
    throw new GlowHostError("unsupported_bit_depth", stage);
  }
  if (layer.visible !== true) {
    throw new GlowHostError("source_not_visible", stage);
  }
  const normal = constants?.LayerKind?.NORMAL;
  const smartObject = constants?.LayerKind?.SMARTOBJECT;
  let kindLabel;
  if (normal !== undefined && layer.kind === normal) {
    kindLabel = "pixel";
  } else if (smartObject !== undefined && layer.kind === smartObject) {
    kindLabel = "smartObject";
  } else {
    throw new GlowHostError("unsupported_layer_kind", stage);
  }

  return {
    document,
    layer,
    documentId,
    layerId,
    bitsPerChannel,
    kindLabel,
    bounds: readBounds(layer, stage),
  };
}

function normalizePlan(plan, expectedContext) {
  let stable;
  try {
    stable = cloneDataOnly(plan, 0, new Set());
  } catch {
    throw new GlowHostError("invalid_plan", "preflight");
  }
  if (!isPlainRecord(stable)) {
    throw new GlowHostError("invalid_plan", "preflight");
  }
  assertExactKeys(stable, [
    "kind",
    "recipeId",
    "source",
    "settings",
    "names",
    "transaction",
    "memory",
  ]);
  if (stable.kind !== "local_glow_plan" || stable.recipeId !== "soft_glow") {
    throw new GlowHostError("invalid_plan", "preflight");
  }
  validatePlanSource(stable.source);
  if (!sameContext(stable.source, expectedContext)) {
    throw new GlowHostError("context_mismatch", "preflight");
  }
  validatePlanSettings(stable.settings);
  validatePlanNames(stable.names);
  validatePlanTransaction(stable.transaction, stable.names);
  validatePlanMemory(stable.memory, stable.source);
  return deepFreeze(stable);
}

function sameContext(actual, expected) {
  if (!isPlainRecord(actual)) return false;
  const keys = [
    "documentId",
    "sourceLayerId",
    "documentMode",
    "bitsPerChannel",
    "layerKind",
    "visible",
    "bounds",
    "sourceSnapshot",
  ];
  for (const key of keys.slice(0, -2)) {
    if (actual[key] !== expected[key]) return false;
  }
  return (
    sameBounds(actual.bounds, expected.bounds) &&
    sameSourceIdentity(actual.sourceSnapshot, expected.sourceSnapshot)
  );
}

function validatePlanSource(value) {
  if (!isPlainRecord(value)) {
    throw new GlowHostError("invalid_plan", "preflight");
  }
  assertExactKeys(value, [
    "documentId",
    "sourceLayerId",
    "documentMode",
    "bitsPerChannel",
    "layerKind",
    "visible",
    "bounds",
    "sourceSnapshot",
    "immutable",
    "operationsForbidden",
  ]);
  if (
    !positiveIntegerValue(value.documentId) ||
    !positiveIntegerValue(value.sourceLayerId) ||
    value.documentMode !== "rgb" ||
    (value.bitsPerChannel !== 8 && value.bitsPerChannel !== 16) ||
    (value.layerKind !== "pixel" && value.layerKind !== "smartObject") ||
    value.visible !== true ||
    value.immutable !== true ||
    !validBounds(value.bounds) ||
    !sameStringArray(value.operationsForbidden, FORBIDDEN_SOURCE_OPERATIONS) ||
    !sameSourceIdentity(value.sourceSnapshot, {
      documentId: value.documentId,
      sourceLayerId: value.sourceLayerId,
    })
  ) {
    throw new GlowHostError("invalid_plan", "preflight");
  }
}

function validatePlanSettings(value) {
  if (!isPlainRecord(value)) {
    throw new GlowHostError("invalid_plan", "preflight");
  }
  assertExactKeys(value, [
    "color",
    "rgb",
    "intensity",
    "size",
    "blur",
    "blendMode",
    "outerOpacity",
    "bloomOpacity",
  ]);
  if (!/^#[0-9A-F]{6}$/.test(value.color) || !isPlainRecord(value.rgb)) {
    throw new GlowHostError("invalid_plan", "preflight");
  }
  assertExactKeys(value.rgb, ["red", "green", "blue"]);
  for (const key of ["red", "green", "blue"]) {
    if (!integerInRange(value.rgb[key], 0, 255)) {
      throw new GlowHostError("invalid_plan", "preflight");
    }
  }
  const parsedColor = {
    red: Number.parseInt(value.color.slice(1, 3), 16),
    green: Number.parseInt(value.color.slice(3, 5), 16),
    blue: Number.parseInt(value.color.slice(5, 7), 16),
  };
  if (
    !sameRgb(value.rgb, parsedColor) ||
    !numberInRange(value.intensity, 0, 100) ||
    !numberInRange(value.size, 1, 250) ||
    !numberInRange(value.blur, 0.1, 250) ||
    (value.blendMode !== "screen" && value.blendMode !== "linearDodge") ||
    value.outerOpacity !== value.intensity ||
    value.bloomOpacity !== Math.round(value.intensity * 0.65)
  ) {
    throw new GlowHostError("invalid_plan", "preflight");
  }
}

function validatePlanNames(value) {
  if (!isPlainRecord(value)) {
    throw new GlowHostError("invalid_plan", "preflight");
  }
  assertExactKeys(value, ["group", "edge", "bloom"]);
  for (const key of ["group", "edge", "bloom"]) {
    if (!validOutputName(value[key])) {
      throw new GlowHostError("invalid_plan", "preflight");
    }
  }
}

function validatePlanTransaction(value, names) {
  if (!isPlainRecord(value)) {
    throw new GlowHostError("invalid_plan", "preflight");
  }
  assertExactKeys(value, [
    "mode",
    "historyName",
    "rollbackOnAnyFailure",
    "noPartialGroup",
    "allowsNetwork",
  ]);
  if (
    value.mode !== "single_history_state" ||
    value.historyName !== names.group ||
    value.rollbackOnAnyFailure !== true ||
    value.noPartialGroup !== true ||
    value.allowsNetwork !== false
  ) {
    throw new GlowHostError("invalid_plan", "preflight");
  }
}

function validatePlanMemory(value, source) {
  if (!isPlainRecord(value)) {
    throw new GlowHostError("invalid_plan", "preflight");
  }
  assertExactKeys(value, [
    "pixelWidth",
    "pixelHeight",
    "pixelCount",
    "estimatedPeakBytes",
    "hardLimitBytes",
    "surfaces",
    "componentsPerPixel",
    "bytesPerComponent",
    "calculatedWith",
  ]);
  const width = Math.ceil(source.bounds.width);
  const height = Math.ceil(source.bounds.height);
  const pixelCount = width * height;
  const bytesPerComponent = source.bitsPerChannel / 8;
  const estimatedPeakBytes = pixelCount * 4 * bytesPerComponent * 6;
  if (
    value.pixelWidth !== width ||
    value.pixelHeight !== height ||
    value.pixelCount !== pixelCount ||
    value.estimatedPeakBytes !== estimatedPeakBytes ||
    pixelCount > 100_000_000 ||
    estimatedPeakBytes > 1_073_741_824 ||
    value.hardLimitBytes !== 1_073_741_824 ||
    value.surfaces !== 6 ||
    value.componentsPerPixel !== 4 ||
    value.bytesPerComponent !== bytesPerComponent ||
    value.calculatedWith !== "bigint"
  ) {
    throw new GlowHostError("invalid_plan", "preflight");
  }
}

function captureSourceSnapshot(document, layer) {
  const parent = layer.parent;
  return deepFreeze({
    id: positiveSafeInteger(layer.id, "invalid_layer", "snapshot"),
    documentId: positiveSafeInteger(document.id, "invalid_document", "snapshot"),
    parentId:
      parent && Number.isSafeInteger(parent.id) && parent.id > 0
        ? parent.id
        : null,
    name: boundedName(layer.name),
    kind: layer.kind,
    visible: layer.visible,
    opacity: finiteNumber(layer.opacity, "invalid_source", "snapshot"),
    fillOpacity: finiteNumber(layer.fillOpacity, "invalid_source", "snapshot"),
    blendMode: captureBlendMode(layer),
    allLocked: booleanValue(layer.allLocked, "invalid_source", "snapshot"),
    pixelsLocked: booleanValue(layer.pixelsLocked, "invalid_source", "snapshot"),
    positionLocked: booleanValue(
      layer.positionLocked,
      "invalid_source",
      "snapshot",
    ),
    transparentPixelsLocked: booleanValue(
      layer.transparentPixelsLocked,
      "invalid_source",
      "snapshot",
    ),
    bounds: readBounds(layer, "snapshot"),
  });
}

function assertSourceUnchanged(before, after, stage) {
  for (const key of SOURCE_KEYS) {
    if (before[key] !== after[key]) {
      throw new GlowHostError("source_changed", stage);
    }
  }
  if (!sameBounds(before.bounds, after.bounds)) {
    throw new GlowHostError("source_changed", stage);
  }
}

function captureBlendMode(layer) {
  return layer.blendMode === undefined ? null : layer.blendMode;
}

function resolveGetPixels(ps) {
  const imaging = ps?.imaging;
  if (!imaging || typeof imaging !== "object") return null;
  if (typeof imaging.getPixels !== "function") return null;
  return imaging.getPixels.bind(imaging);
}

/**
 * Read-only source-layer pixel digest. Missing Imaging API stays unverified
 * and never invents a SHA-256 value. imageData is disposed before return.
 */
async function readSourcePixelDigest(ps, documentId, layerId) {
  const getPixels = resolveGetPixels(ps);
  if (!getPixels) {
    return { verified: false, digest: null };
  }

  let imageData = null;
  try {
    let result;
    try {
      result = await getPixels({
        documentID: documentId,
        layerID: layerId,
      });
    } catch (error) {
      imageData = extractImageData(error);
      return { verified: false, digest: null };
    }
    imageData = extractImageData(result);
    if (!imageData || typeof imageData.getData !== "function") {
      return { verified: false, digest: null };
    }
    const data = await imageData.getData({ chunky: true });
    const digest = await sha256Hex(data);
    if (!PIXEL_DIGEST_HEX.test(digest ?? "")) {
      return { verified: false, digest: null };
    }
    return { verified: true, digest };
  } catch {
    return { verified: false, digest: null };
  } finally {
    await disposeImageData(imageData);
  }
}

function assertPixelDigestUnchanged(before, after, stage) {
  if (!before.verified || !after.verified) return;
  if (before.digest !== after.digest) {
    throw new GlowHostError("source_changed", stage);
  }
}

function extractImageData(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.dispose === "function") return value;
  const nested = value.imageData;
  if (nested && typeof nested === "object") return nested;
  return null;
}

async function disposeImageData(imageData) {
  if (!imageData || typeof imageData.dispose !== "function") return;
  try {
    await imageData.dispose();
  } catch {
    // Dispose failures must not leak image bytes or host text.
  }
}

async function sha256Hex(data) {
  const bytes = toUint8Array(data);
  if (!bytes) return null;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== "function") return null;
  try {
    return hexFromBuffer(await subtle.digest("SHA-256", bytes));
  } catch {
    return null;
  }
}

function toUint8Array(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

function hexFromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let index = 0; index < bytes.length; index += 1) {
    hex += bytes[index].toString(16).padStart(2, "0");
  }
  return hex;
}

function readBounds(layer, stage) {
  const bounds = layer.boundsNoEffects ?? layer.bounds;
  if (!bounds || typeof bounds !== "object") {
    throw new GlowHostError("invalid_layer_bounds", stage);
  }
  const left = finiteNumber(bounds.left, "invalid_layer_bounds", stage);
  const top = finiteNumber(bounds.top, "invalid_layer_bounds", stage);
  const right = finiteNumber(bounds.right, "invalid_layer_bounds", stage);
  const bottom = finiteNumber(bounds.bottom, "invalid_layer_bounds", stage);
  const width = right - left;
  const height = bottom - top;
  if (!(width > 0) || !(height > 0)) {
    throw new GlowHostError("invalid_layer_bounds", stage);
  }
  return deepFreeze({ x: left, y: top, width, height });
}

function outerGlowDescriptor(documentId, layerId, plan) {
  return {
    _obj: "set",
    _target: [
      { _ref: "property", _property: "layerEffects" },
      { _ref: "layer", _id: layerId },
      { _ref: "document", _id: documentId },
    ],
    to: {
      _obj: "layerEffects",
      scale: { _unit: "percentUnit", _value: 100 },
      outerGlow: {
        _obj: "outerGlow",
        enabled: true,
        present: true,
        showInDialog: true,
        mode: {
          _enum: "blendMode",
          _value: plan.settings.blendMode,
        },
        color: rgbDescriptor(plan.settings.rgb),
        opacity: {
          _unit: "percentUnit",
          _value: plan.settings.outerOpacity,
        },
        glowTechnique: { _enum: "matteTechnique", _value: "softerMatte" },
        chokeMatte: { _unit: "pixelsUnit", _value: 0 },
        blur: { _unit: "pixelsUnit", _value: plan.settings.size },
        noise: { _unit: "percentUnit", _value: 0 },
        inputRange: { _unit: "percentUnit", _value: 50 },
        antiAlias: false,
      },
    },
    _options: { dialogOptions: "silent" },
  };
}

function colorOverlayDescriptor(documentId, layerId, color) {
  return {
    _obj: "set",
    _target: [
      { _ref: "property", _property: "layerEffects" },
      { _ref: "layer", _id: layerId },
      { _ref: "document", _id: documentId },
    ],
    to: {
      _obj: "layerEffects",
      scale: { _unit: "percentUnit", _value: 100 },
      solidFill: {
        _obj: "solidFill",
        enabled: true,
        present: true,
        showInDialog: true,
        mode: { _enum: "blendMode", _value: "normal" },
        color: rgbDescriptor(color),
        opacity: { _unit: "percentUnit", _value: 100 },
      },
    },
    _options: { dialogOptions: "silent" },
  };
}

function rgbDescriptor(color) {
  return {
    _obj: "RGBColor",
    red: color.red,
    grain: color.green,
    blue: color.blue,
  };
}

function assertBatchPlayResult(result, expectedLength, stage) {
  if (!Array.isArray(result) || result.length !== expectedLength) {
    throw new GlowHostError("batchplay_failed", stage);
  }
  for (let index = 0; index < result.length; index += 1) {
    const item = result[index];
    if (!item || typeof item !== "object") {
      throw new GlowHostError("batchplay_failed", stage);
    }
    const objectName =
      typeof item._obj === "string" ? item._obj.toLowerCase() : "";
    if (objectName === "error") {
      if (item.result === -128) {
        throw new GlowHostError("user_cancelled", stage);
      }
      throw new GlowHostError("batchplay_failed", stage);
    }
    if (
      Object.prototype.hasOwnProperty.call(item, "result") &&
      item.result !== 0
    ) {
      throw new GlowHostError("batchplay_failed", stage);
    }
  }
}

function unlockDerivedLayer(layer) {
  for (const key of [
    "allLocked",
    "pixelsLocked",
    "positionLocked",
    "transparentPixelsLocked",
  ]) {
    if (typeof layer[key] === "boolean" && layer[key]) layer[key] = false;
  }
}

function verifyCreatedGraph({ document, source, group, edge, bloom, beforeIds }) {
  const ids = [group.id, edge.id, bloom.id];
  if (
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(ids).size !== ids.length ||
    ids.includes(source.id)
  ) {
    throw new GlowHostError("invalid_created_graph", "verify");
  }
  const groupLocation = findLayerLocation(document, group.id);
  const sourceLocation = findLayerLocation(document, source.id);
  const edgeLocation = findLayerLocation(document, edge.id);
  const bloomLocation = findLayerLocation(document, bloom.id);
  if (
    !groupLocation ||
    !sourceLocation ||
    !edgeLocation ||
    !bloomLocation ||
    groupLocation.parentId !== sourceLocation.parentId ||
    groupLocation.index + 1 !== sourceLocation.index ||
    edgeLocation.parentId !== group.id ||
    bloomLocation.parentId !== group.id
  ) {
    throw new GlowHostError("invalid_created_graph", "verify");
  }
  const afterIds = collectLayerIds(document);
  const additions = [];
  for (const id of afterIds) {
    if (!beforeIds.has(id)) additions.push(id);
  }
  if (
    additions.length !== 3 ||
    ids.some((id) => !additions.includes(id)) ||
    !beforeIds.has(source.id)
  ) {
    throw new GlowHostError("invalid_created_graph", "verify");
  }
}

function collectLayerIds(document) {
  const ids = new Set();
  walkLayers(document.layers, (layer) => {
    const id = positiveSafeInteger(layer.id, "invalid_layer_tree", "verify");
    if (ids.has(id)) {
      throw new GlowHostError("invalid_layer_tree", "verify");
    }
    ids.add(id);
  });
  return ids;
}

function findLayerById(document, id) {
  let found = null;
  walkLayers(document.layers, (layer) => {
    if (layer.id === id) found = layer;
  });
  return found;
}

function findLayerLocation(document, id) {
  let found = null;
  function visit(collection, parentId) {
    assertDenseCollection(collection, "invalid_layer_tree", "verify");
    for (let index = 0; index < collection.length; index += 1) {
      const layer = collection[index];
      if (layer.id === id) found = { parentId, index };
      if (layer.layers && typeof layer.layers.length === "number") {
        visit(layer.layers, layer.id);
      }
    }
  }
  visit(document.layers, null);
  return found;
}

function walkLayers(collection, visitor) {
  assertDenseCollection(collection, "invalid_layer_tree", "verify");
  for (let index = 0; index < collection.length; index += 1) {
    const layer = collection[index];
    visitor(layer);
    if (layer.layers && typeof layer.layers.length === "number") {
      walkLayers(layer.layers, visitor);
    }
  }
}

function assertDenseCollection(collection, code, stage) {
  if (
    !collection ||
    !Number.isSafeInteger(collection.length) ||
    collection.length < 0
  ) {
    throw new GlowHostError(code, stage);
  }
  for (let index = 0; index < collection.length; index += 1) {
    if (!collection[index] || typeof collection[index] !== "object") {
      throw new GlowHostError(code, stage);
    }
  }
}

function requirePlacements(constants) {
  const above = constants?.ElementPlacement?.PLACEBEFORE;
  const inside = constants?.ElementPlacement?.PLACEINSIDE;
  if (above === undefined || inside === undefined) {
    throw new GlowHostError("host_unavailable", "create_group");
  }
  return { above, inside };
}

function requireBlendMode(constants, requested) {
  const blendMode =
    requested === "screen"
      ? constants?.BlendMode?.SCREEN
      : constants?.BlendMode?.LINEARDODGE;
  if (blendMode === undefined) {
    throw new GlowHostError("host_unavailable", "bloom_blur");
  }
  return blendMode;
}

function assertNotCancelled(executionContext, stage) {
  if (executionContext?.isCancelled) {
    throw new GlowHostError("user_cancelled", stage);
  }
}

function isHistorySentinel(value) {
  return (
    value === HISTORY_SENTINEL ||
    value?.id === HISTORY_SENTINEL ||
    value?.suspensionID === HISTORY_SENTINEL
  );
}

function assertHostLayer(layer, stage) {
  if (
    !layer ||
    typeof layer !== "object" ||
    !Number.isSafeInteger(layer.id) ||
    layer.id <= 0
  ) {
    throw new GlowHostError("invalid_layer", stage);
  }
}

function positiveSafeInteger(value, code, stage) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GlowHostError(code, stage);
  }
  return value;
}

function finiteNumber(value, code, stage) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GlowHostError(code, stage);
  }
  return value;
}

function booleanValue(value, code, stage) {
  if (typeof value !== "boolean") {
    throw new GlowHostError(code, stage);
  }
  return value;
}

function boundedName(value) {
  if (typeof value !== "string" || value.length > 256) {
    throw new GlowHostError("invalid_source", "snapshot");
  }
  return value;
}

function sameBounds(left, right) {
  return (
    isPlainRecord(left) &&
    isPlainRecord(right) &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function fixedError(error, code, stage) {
  return error instanceof GlowHostError
    ? error
    : new GlowHostError(code, stage);
}

function assertExactKeys(object, allowed) {
  const allowedSet = new Set(allowed);
  const keys = Object.keys(object);
  if (
    keys.length !== allowed.length ||
    keys.some((key) => !allowedSet.has(key)) ||
    allowed.some((key) => !Object.prototype.hasOwnProperty.call(object, key))
  ) {
    throw new GlowHostError("invalid_plan", "preflight");
  }
}

function positiveIntegerValue(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function numberInRange(value, minimum, maximum) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function integerInRange(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function validBounds(value) {
  return (
    isPlainRecord(value) &&
    Object.keys(value).length === 4 &&
    ["x", "y", "width", "height"].every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    ) &&
    numberInRange(value.x, -Number.MAX_VALUE, Number.MAX_VALUE) &&
    numberInRange(value.y, -Number.MAX_VALUE, Number.MAX_VALUE) &&
    numberInRange(value.width, Number.MIN_VALUE, Number.MAX_VALUE) &&
    numberInRange(value.height, Number.MIN_VALUE, Number.MAX_VALUE)
  );
}

function sameSourceIdentity(actual, expected) {
  return (
    isPlainRecord(actual) &&
    Object.keys(actual).length === 2 &&
    actual.documentId === expected.documentId &&
    actual.sourceLayerId === expected.sourceLayerId
  );
}

function sameStringArray(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) return false;
  }
  return true;
}

function sameRgb(actual, expected) {
  return (
    actual.red === expected.red &&
    actual.green === expected.green &&
    actual.blue === expected.blue
  );
}

function validOutputName(value) {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 96
  );
}

function cloneDataOnly(value, depth, seen) {
  if (depth > 12) throw new TypeError("depth");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("number");
    return value;
  }
  if (typeof value !== "object" || seen.has(value)) {
    throw new TypeError("value");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw new TypeError("prototype");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) throw new TypeError("array");
        out[index] = cloneDataOnly(descriptor.value, depth + 1, seen);
      }
      return out;
    }
    const out = Object.create(null);
    for (const key of Object.keys(value)) {
      if (key === "__proto__") throw new TypeError("key");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new TypeError("accessor");
      Object.defineProperty(out, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: cloneDataOnly(descriptor.value, depth + 1, seen),
      });
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}
