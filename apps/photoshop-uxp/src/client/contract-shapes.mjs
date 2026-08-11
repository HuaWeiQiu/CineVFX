/**
 * Runtime contract shape helpers for the UXP shell.
 * Mirrors frozen packages/contracts schemas without package coupling.
 */

export const SCHEMA_VERSION = "1.0.0";

export const MEDIA_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/json",
]);

export const ALPHA_MODES = Object.freeze([
  "none",
  "opaque",
  "straight",
  "premultiplied",
]);

export const ASSET_PURPOSES = Object.freeze([
  "proxy",
  "mask",
  "effect_reference",
  "guidance",
  "pass",
  "metadata",
]);

export const COLOR_SPACES = Object.freeze(["srgb", "display-p3", "adobe-rgb"]);

export const SOURCE_ROLES = Object.freeze([
  "user_proxy",
  "user_mask",
  "user_effect_reference",
  "generated_pass",
  "system_metadata",
]);

export const JOB_STATES = Object.freeze([
  "CREATED",
  "VALIDATING",
  "QUEUED",
  "PREPROCESSING",
  "RENDERING",
  "POSTPROCESSING",
  "EXPORTING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
]);

export const ACTIVE_JOB_STATES = Object.freeze([
  "CREATED",
  "VALIDATING",
  "QUEUED",
  "PREPROCESSING",
  "RENDERING",
  "POSTPROCESSING",
  "EXPORTING",
]);

export const BLEND_MODES = Object.freeze([
  "normal",
  "multiply",
  "screen",
  "overlay",
  "soft_light",
  "hard_light",
  "color_dodge",
  "color_burn",
  "darken",
  "lighten",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
  "linear_dodge",
  "linear_burn",
]);

export const PASS_KINDS = Object.freeze([
  "effect",
  "relight",
  "atmosphere",
  "grade",
  "bloom",
  "mask",
  "utility",
]);

export const PRIMITIVE_KINDS = Object.freeze([
  "curve",
  "particle",
  "volume",
  "sprite",
  "surface",
  "lens",
]);

export const REFERENCE_ROLES = Object.freeze([
  "effect",
  "style",
  "mask",
  "depth",
  "normal",
  "environment",
]);

export const FORBIDDEN_OPS = Object.freeze([
  "modify_pixels",
  "move",
  "transform",
  "resize",
  "replace",
  "warp",
  "delete",
]);

export const REQUIRED_FORBIDDEN_OPS = Object.freeze([
  "modify_pixels",
  "move",
  "transform",
  "resize",
  "replace",
]);

export const JOB_EVENT_TYPES = Object.freeze([
  "state_changed",
  "progress",
  "asset_ready",
  "manifest_ready",
  "cancel_accepted",
  "error",
]);

export const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
export const ASSET_ID_RE = /^asset_[a-z0-9_]{1,56}$/;
export const JOB_ID_RE = /^job_[a-z0-9_]{1,58}$/;
export const IDEMPOTENCY_KEY_RE = /^idem_[A-Za-z0-9_-]{8,128}$/;
export const MANIFEST_ID_RE = /^manifest_[a-z0-9_]{1,48}$/;
export const EVENT_ID_RE = /^evt_[a-z0-9_]{1,56}$/;
export const ID_RE = /^[a-z][a-z0-9_]{1,63}$/;
export const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
export const EFFECT_SPEC_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
export const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
export const PARAM_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const BENCH_ID_RE = /^bench_[a-z0-9_]{1,48}$/;

/** Fields that must never appear on outbound metadata requests. */
export const FORBIDDEN_REQUEST_KEYS = Object.freeze([
  "imageBytes",
  "bytes",
  "pixelData",
  "rawData",
  "contentBase64",
  "prompt",
  "password",
  "token",
  "authorization",
  "filePath",
  "localPath",
  "absolutePath",
  "path",
]);

/** Soft cap on serialized request JSON (metadata only). */
export const MAX_REQUEST_JSON_BYTES = 256 * 1024;

/**
 * @typedef {{ path: string, message: string }} ShapeIssue
 * @typedef {{ valid: boolean, errors: ShapeIssue[] }} ShapeResult
 */

/**
 * @param {unknown} value
 * @param {string} path
 * @param {ShapeIssue[]} errors
 * @returns {value is Record<string, unknown>}
 */
export function requireObject(value, path, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push({ path, message: "must be an object" });
    return false;
  }
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    errors.push({ path, message: "must expose a safe object prototype" });
    return false;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    errors.push({ path, message: "must not inherit from a custom prototype" });
    return false;
  }
  return true;
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} allowed
 * @param {string} path
 * @param {ShapeIssue[]} errors
 */
export function rejectUnknownKeys(obj, allowed, path, errors) {
  const allow = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allow.has(key)) {
      errors.push({
        path: `${path}/${key}`,
        message: `unexpected property ${key}`,
      });
    }
    if (FORBIDDEN_REQUEST_KEYS.includes(key)) {
      errors.push({
        path: `${path}/${key}`,
        message: `forbidden sensitive field ${key}`,
      });
    }
  }
}

/**
 * JSON serializes array holes as null, so sparse metadata arrays are never a
 * valid representation of an omitted item.
 * @param {unknown[]} values
 * @param {string} path
 * @param {ShapeIssue[]} errors
 */
export function rejectSparseArray(values, path, errors) {
  for (let index = 0; index < values.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(values, index)) {
      errors.push({
        path: `${path}/${index}`,
        message: "array items must not be omitted",
      });
    }
  }
}

/**
 * Deep scan for forbidden sensitive keys anywhere in a payload tree.
 * @param {unknown} value
 * @param {string} path
 * @param {ShapeIssue[]} errors
 * @param {number} [depth]
 */
export function rejectSensitiveTree(value, path, errors, depth = 0) {
  if (depth > 12 || value == null) return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (Object.prototype.hasOwnProperty.call(value, index)) {
        rejectSensitiveTree(
          value[index],
          `${path}/${index}`,
          errors,
          depth + 1,
        );
      }
    }
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, child] of Object.entries(
    /** @type {Record<string, unknown>} */ (value),
  )) {
    if (FORBIDDEN_REQUEST_KEYS.includes(key)) {
      errors.push({
        path: `${path}/${key}`,
        message: `forbidden sensitive field ${key}`,
      });
    }
    rejectSensitiveTree(child, `${path}/${key}`, errors, depth + 1);
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {ShapeIssue[]} errors
 * @param {{ min?: number, max?: number }} [opts]
 */
export function requireString(value, path, errors, opts = {}) {
  if (typeof value !== "string") {
    errors.push({ path, message: "must be a string" });
    return false;
  }
  if (opts.min !== undefined && value.length < opts.min) {
    errors.push({ path, message: `must be at least ${opts.min} characters` });
    return false;
  }
  if (opts.max !== undefined && value.length > opts.max) {
    errors.push({ path, message: `must be at most ${opts.max} characters` });
    return false;
  }
  return true;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {RegExp} re
 * @param {ShapeIssue[]} errors
 * @param {string} message
 */
export function requirePattern(value, path, re, errors, message) {
  if (typeof value !== "string" || !re.test(value)) {
    errors.push({ path, message });
    return false;
  }
  return true;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {readonly string[]} allowed
 * @param {ShapeIssue[]} errors
 */
export function requireEnum(value, path, allowed, errors) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    errors.push({
      path,
      message: `must be one of ${allowed.join(", ")}`,
    });
    return false;
  }
  return true;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {ShapeIssue[]} errors
 * @param {{ min?: number, max?: number, integer?: boolean, exclusiveMin?: number }} [opts]
 */
export function requireNumber(value, path, errors, opts = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push({ path, message: "must be a finite number" });
    return false;
  }
  if (opts.integer && !Number.isInteger(value)) {
    errors.push({ path, message: "must be an integer" });
    return false;
  }
  if (opts.min !== undefined && value < opts.min) {
    errors.push({ path, message: `must be >= ${opts.min}` });
    return false;
  }
  if (opts.exclusiveMin !== undefined && value <= opts.exclusiveMin) {
    errors.push({ path, message: `must be > ${opts.exclusiveMin}` });
    return false;
  }
  if (opts.max !== undefined && value > opts.max) {
    errors.push({ path, message: `must be <= ${opts.max}` });
    return false;
  }
  return true;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {ShapeIssue[]} errors
 */
export function requireBoolean(value, path, errors) {
  if (typeof value !== "boolean") {
    errors.push({ path, message: "must be a boolean" });
    return false;
  }
  return true;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {ShapeIssue[]} errors
 */
export function requireIsoDateTime(value, path, errors) {
  return requirePattern(
    value,
    path,
    ISO_DATETIME_RE,
    errors,
    "must be an ISO-8601 UTC timestamp",
  );
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {ShapeIssue[]} errors
 */
export function requireDigest(value, path, errors) {
  return requirePattern(
    value,
    path,
    DIGEST_RE,
    errors,
    "must be sha256:<64 lowercase hex>",
  );
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {ShapeIssue[]} errors
 */
export function requireAssetId(value, path, errors) {
  return requirePattern(
    value,
    path,
    ASSET_ID_RE,
    errors,
    "must match asset_* pattern",
  );
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {ShapeIssue[]} errors
 */
export function requireJobId(value, path, errors) {
  return requirePattern(
    value,
    path,
    JOB_ID_RE,
    errors,
    "must match job_* pattern",
  );
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {ShapeIssue[]} errors
 */
export function requireIdempotencyKey(value, path, errors) {
  return requirePattern(
    value,
    path,
    IDEMPOTENCY_KEY_RE,
    errors,
    "must match idem_* pattern",
  );
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {ShapeIssue[]} errors
 */
export function requireManifestId(value, path, errors) {
  return requirePattern(
    value,
    path,
    MANIFEST_ID_RE,
    errors,
    "must match manifest_* pattern",
  );
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {ShapeIssue[]} errors
 */
export function requireStableId(value, path, errors) {
  return requirePattern(
    value,
    path,
    ID_RE,
    errors,
    "must match lowercase id pattern",
  );
}

/**
 * @param {unknown} canvas
 * @param {string} path
 * @param {ShapeIssue[]} errors
 */
export function validateNormalizedCanvas(canvas, path, errors) {
  if (!requireObject(canvas, path, errors)) return;
  const c = /** @type {Record<string, unknown>} */ (canvas);
  rejectUnknownKeys(
    c,
    ["width", "height", "colorSpace", "pixelAspectRatio", "normalized"],
    path,
    errors,
  );
  requireNumber(c.width, `${path}/width`, errors, {
    integer: true,
    min: 1,
    max: 65536,
  });
  requireNumber(c.height, `${path}/height`, errors, {
    integer: true,
    min: 1,
    max: 65536,
  });
  requireEnum(c.colorSpace, `${path}/colorSpace`, COLOR_SPACES, errors);
  requireNumber(c.pixelAspectRatio, `${path}/pixelAspectRatio`, errors, {
    exclusiveMin: 0,
    max: 4,
  });
  if (c.normalized !== true) {
    errors.push({
      path: `${path}/normalized`,
      message: "normalized must be true",
    });
  }
}

/**
 * @param {unknown} dims
 * @param {string} path
 * @param {ShapeIssue[]} errors
 */
export function validateDimensions(dims, path, errors) {
  if (!requireObject(dims, path, errors)) return;
  const d = /** @type {Record<string, unknown>} */ (dims);
  rejectUnknownKeys(d, ["width", "height"], path, errors);
  requireNumber(d.width, `${path}/width`, errors, {
    integer: true,
    min: 1,
    max: 65536,
  });
  requireNumber(d.height, `${path}/height`, errors, {
    integer: true,
    min: 1,
    max: 65536,
  });
}

/**
 * @param {unknown} point
 * @param {string} path
 * @param {ShapeIssue[]} errors
 */
export function validateNormalizedPoint(point, path, errors) {
  if (!requireObject(point, path, errors)) return;
  const p = /** @type {Record<string, unknown>} */ (point);
  rejectUnknownKeys(p, ["x", "y"], path, errors);
  requireNumber(p.x, `${path}/x`, errors, { min: 0, max: 1 });
  requireNumber(p.y, `${path}/y`, errors, { min: 0, max: 1 });
}

/**
 * @param {unknown} descriptor
 * @returns {ShapeResult}
 */
export function validateAssetDescriptor(descriptor) {
  /** @type {ShapeIssue[]} */
  const errors = [];
  if (!requireObject(descriptor, "#", errors)) {
    return { valid: false, errors };
  }
  const d = /** @type {Record<string, unknown>} */ (descriptor);
  rejectSensitiveTree(d, "#", errors);
  rejectUnknownKeys(
    d,
    [
      "schemaVersion",
      "assetId",
      "mediaType",
      "dimensions",
      "digest",
      "alphaMode",
      "byteLength",
      "ttlSeconds",
      "purpose",
      "createdAt",
      "colorSpace",
      "expiresAt",
      "sourceRole",
    ],
    "#",
    errors,
  );

  if (d.schemaVersion !== SCHEMA_VERSION) {
    errors.push({
      path: "#/schemaVersion",
      message: "schemaVersion must be 1.0.0",
    });
  }
  requireAssetId(d.assetId, "#/assetId", errors);
  requireEnum(d.mediaType, "#/mediaType", MEDIA_TYPES, errors);
  validateDimensions(d.dimensions, "#/dimensions", errors);
  requireDigest(d.digest, "#/digest", errors);
  requireEnum(d.alphaMode, "#/alphaMode", ALPHA_MODES, errors);
  requireNumber(d.byteLength, "#/byteLength", errors, {
    integer: true,
    min: 1,
    max: 104857600,
  });
  requireNumber(d.ttlSeconds, "#/ttlSeconds", errors, {
    integer: true,
    min: 60,
    max: 604800,
  });
  requireEnum(d.purpose, "#/purpose", ASSET_PURPOSES, errors);
  requireIsoDateTime(d.createdAt, "#/createdAt", errors);
  if (d.colorSpace !== undefined) {
    requireEnum(d.colorSpace, "#/colorSpace", COLOR_SPACES, errors);
  }
  if (d.expiresAt !== undefined) {
    requireIsoDateTime(d.expiresAt, "#/expiresAt", errors);
  }
  if (d.sourceRole !== undefined) {
    requireEnum(d.sourceRole, "#/sourceRole", SOURCE_ROLES, errors);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * @param {unknown} effectSpec
 * @param {string} [path]
 * @param {ShapeIssue[]} [errorsOut]
 * @returns {ShapeResult}
 */
export function validateEffectSpec(
  effectSpec,
  path = "#/effectSpec",
  errorsOut,
) {
  /** @type {ShapeIssue[]} */
  const errors = errorsOut ?? [];
  if (!requireObject(effectSpec, path, errors)) {
    return { valid: false, errors };
  }
  const e = /** @type {Record<string, unknown>} */ (effectSpec);
  rejectUnknownKeys(
    e,
    [
      "schemaVersion",
      "effectSpecVersion",
      "seed",
      "label",
      "canvas",
      "references",
      "guidance",
      "primitives",
      "benchmark",
    ],
    path,
    errors,
  );

  if (e.schemaVersion !== SCHEMA_VERSION) {
    errors.push({
      path: `${path}/schemaVersion`,
      message: "schemaVersion must be 1.0.0",
    });
  }
  requirePattern(
    e.effectSpecVersion,
    `${path}/effectSpecVersion`,
    EFFECT_SPEC_VERSION_RE,
    errors,
    "must be a semantic version",
  );
  requireNumber(e.seed, `${path}/seed`, errors, {
    integer: true,
    min: 0,
    max: 4294967295,
  });
  if (e.label !== undefined) {
    requireString(e.label, `${path}/label`, errors, { min: 1, max: 128 });
  }
  validateNormalizedCanvas(e.canvas, `${path}/canvas`, errors);

  if (!Array.isArray(e.references) || e.references.length < 1) {
    errors.push({
      path: `${path}/references`,
      message: "references must be a non-empty array",
    });
  } else if (e.references.length > 16) {
    errors.push({
      path: `${path}/references`,
      message: "references must have at most 16 items",
    });
  } else {
    rejectSparseArray(e.references, `${path}/references`, errors);
    for (let i = 0; i < e.references.length; i += 1) {
      const ref = e.references[i];
      const rp = `${path}/references/${i}`;
      if (!requireObject(ref, rp, errors)) continue;
      const r = /** @type {Record<string, unknown>} */ (ref);
      rejectUnknownKeys(
        r,
        ["id", "assetId", "role", "digest", "weight"],
        rp,
        errors,
      );
      requireStableId(r.id, `${rp}/id`, errors);
      requireAssetId(r.assetId, `${rp}/assetId`, errors);
      requireEnum(r.role, `${rp}/role`, REFERENCE_ROLES, errors);
      if (r.digest !== undefined) requireDigest(r.digest, `${rp}/digest`, errors);
      if (r.weight !== undefined) {
        requireNumber(r.weight, `${rp}/weight`, errors, { min: 0, max: 1 });
      }
    }
  }

  if (!requireObject(e.guidance, `${path}/guidance`, errors)) {
    // skip
  } else {
    const g = /** @type {Record<string, unknown>} */ (e.guidance);
    rejectUnknownKeys(
      g,
      ["anchors", "strength", "subjectMaskAssetId", "notes"],
      `${path}/guidance`,
      errors,
    );
    if (!Array.isArray(g.anchors)) {
      errors.push({
        path: `${path}/guidance/anchors`,
        message: "anchors must be an array",
      });
    } else if (g.anchors.length > 32) {
      errors.push({
        path: `${path}/guidance/anchors`,
        message: "anchors must have at most 32 items",
      });
    } else {
      rejectSparseArray(g.anchors, `${path}/guidance/anchors`, errors);
      for (let i = 0; i < g.anchors.length; i += 1) {
        const anchor = g.anchors[i];
        const ap = `${path}/guidance/anchors/${i}`;
        if (!requireObject(anchor, ap, errors)) continue;
        const a = /** @type {Record<string, unknown>} */ (anchor);
        rejectUnknownKeys(a, ["id", "point", "radius"], ap, errors);
        requireStableId(a.id, `${ap}/id`, errors);
        validateNormalizedPoint(a.point, `${ap}/point`, errors);
        if (a.radius !== undefined) {
          requireNumber(a.radius, `${ap}/radius`, errors, { min: 0, max: 1 });
        }
      }
    }
    requireNumber(g.strength, `${path}/guidance/strength`, errors, {
      min: 0,
      max: 1,
    });
    if (g.subjectMaskAssetId !== undefined) {
      requireAssetId(
        g.subjectMaskAssetId,
        `${path}/guidance/subjectMaskAssetId`,
        errors,
      );
    }
    if (g.notes !== undefined) {
      requireString(g.notes, `${path}/guidance/notes`, errors, { max: 256 });
    }
  }

  if (!Array.isArray(e.primitives) || e.primitives.length < 1) {
    errors.push({
      path: `${path}/primitives`,
      message: "primitives must be a non-empty array",
    });
  } else if (e.primitives.length > 32) {
    errors.push({
      path: `${path}/primitives`,
      message: "primitives must have at most 32 items",
    });
  } else {
    rejectSparseArray(e.primitives, `${path}/primitives`, errors);
    for (let i = 0; i < e.primitives.length; i += 1) {
      const prim = e.primitives[i];
      const pp = `${path}/primitives/${i}`;
      if (!requireObject(prim, pp, errors)) continue;
      const p = /** @type {Record<string, unknown>} */ (prim);
      rejectUnknownKeys(p, ["id", "kind", "enabled", "params"], pp, errors);
      requireStableId(p.id, `${pp}/id`, errors);
      requireEnum(p.kind, `${pp}/kind`, PRIMITIVE_KINDS, errors);
      requireBoolean(p.enabled, `${pp}/enabled`, errors);
      if (!requireObject(p.params, `${pp}/params`, errors)) continue;
      const params = /** @type {Record<string, unknown>} */ (p.params);
      const keys = Object.keys(params);
      if (keys.length < 1 || keys.length > 32) {
        errors.push({
          path: `${pp}/params`,
          message: "params must have 1..32 properties",
        });
      }
      for (const [key, val] of Object.entries(params)) {
        if (!PARAM_NAME_RE.test(key)) {
          errors.push({
            path: `${pp}/params/${key}`,
            message: "invalid param name",
          });
        }
        const okType =
          typeof val === "number" ||
          typeof val === "boolean" ||
          (typeof val === "string" && val.length <= 64);
        if (!okType) {
          errors.push({
            path: `${pp}/params/${key}`,
            message: "param must be number, boolean, or short string",
          });
        }
      }
    }
  }

  if (e.benchmark !== undefined) {
    if (!requireObject(e.benchmark, `${path}/benchmark`, errors)) {
      // done
    } else {
      const b = /** @type {Record<string, unknown>} */ (e.benchmark);
      rejectUnknownKeys(b, ["fixtureId", "description"], `${path}/benchmark`, errors);
      if (b.fixtureId !== undefined) {
        requirePattern(
          b.fixtureId,
          `${path}/benchmark/fixtureId`,
          BENCH_ID_RE,
          errors,
          "must match bench_* pattern",
        );
      }
      if (b.description !== undefined) {
        requireString(b.description, `${path}/benchmark/description`, errors, {
          max: 256,
        });
      }
    }
  }

  if (!errorsOut) return { valid: errors.length === 0, errors };
  return { valid: errors.length === 0, errors };
}

/**
 * @param {unknown} jobRequest
 * @returns {ShapeResult}
 */
export function validateJobRequest(jobRequest) {
  /** @type {ShapeIssue[]} */
  const errors = [];
  if (!requireObject(jobRequest, "#", errors)) {
    return { valid: false, errors };
  }
  const j = /** @type {Record<string, unknown>} */ (jobRequest);
  rejectSensitiveTree(j, "#", errors);
  rejectUnknownKeys(
    j,
    [
      "schemaVersion",
      "idempotencyKey",
      "clientRequestId",
      "effectSpec",
      "inputAssets",
      "protectedSource",
      "options",
    ],
    "#",
    errors,
  );

  if (j.schemaVersion !== SCHEMA_VERSION) {
    errors.push({
      path: "#/schemaVersion",
      message: "schemaVersion must be 1.0.0",
    });
  }
  requireIdempotencyKey(j.idempotencyKey, "#/idempotencyKey", errors);
  if (j.clientRequestId !== undefined) {
    requireString(j.clientRequestId, "#/clientRequestId", errors, {
      min: 1,
      max: 128,
    });
  }
  validateEffectSpec(j.effectSpec, "#/effectSpec", errors);

  if (!Array.isArray(j.inputAssets) || j.inputAssets.length < 1) {
    errors.push({
      path: "#/inputAssets",
      message: "inputAssets must be a non-empty array",
    });
  } else if (j.inputAssets.length > 32) {
    errors.push({
      path: "#/inputAssets",
      message: "inputAssets must have at most 32 items",
    });
  } else {
    rejectSparseArray(j.inputAssets, "#/inputAssets", errors);
    for (let i = 0; i < j.inputAssets.length; i += 1) {
      const item = j.inputAssets[i];
      const ip = `#/inputAssets/${i}`;
      if (!requireObject(item, ip, errors)) continue;
      const a = /** @type {Record<string, unknown>} */ (item);
      rejectUnknownKeys(a, ["assetId", "digest", "purpose"], ip, errors);
      requireAssetId(a.assetId, `${ip}/assetId`, errors);
      requireDigest(a.digest, `${ip}/digest`, errors);
      requireEnum(a.purpose, `${ip}/purpose`, ASSET_PURPOSES, errors);
    }
  }

  if (!requireObject(j.protectedSource, "#/protectedSource", errors)) {
    // skip
  } else {
    const p = /** @type {Record<string, unknown>} */ (j.protectedSource);
    rejectUnknownKeys(
      p,
      ["layerStableId", "documentStableId", "immutable", "operationsForbidden"],
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
        message: "immutable must be true",
      });
    }
    if (!Array.isArray(p.operationsForbidden) || p.operationsForbidden.length < 5) {
      errors.push({
        path: "#/protectedSource/operationsForbidden",
        message: "operationsForbidden must include at least 5 entries",
      });
    } else {
      rejectSparseArray(
        p.operationsForbidden,
        "#/protectedSource/operationsForbidden",
        errors,
      );
      const seen = new Set();
      for (let i = 0; i < p.operationsForbidden.length; i += 1) {
        const op = p.operationsForbidden[i];
        if (typeof op !== "string" || !FORBIDDEN_OPS.includes(op)) {
          errors.push({
            path: `#/protectedSource/operationsForbidden/${i}`,
            message: "invalid forbidden operation",
          });
        } else if (seen.has(op)) {
          errors.push({
            path: `#/protectedSource/operationsForbidden/${i}`,
            message: "duplicate forbidden operation",
          });
        } else {
          seen.add(op);
        }
      }
      for (const required of REQUIRED_FORBIDDEN_OPS) {
        if (!seen.has(required)) {
          errors.push({
            path: "#/protectedSource/operationsForbidden",
            message: `must include ${required}`,
          });
        }
      }
    }
  }

  if (j.options !== undefined) {
    if (!requireObject(j.options, "#/options", errors)) {
      // done
    } else {
      const o = /** @type {Record<string, unknown>} */ (j.options);
      rejectUnknownKeys(
        o,
        ["priority", "dryRun", "ttlSeconds"],
        "#/options",
        errors,
      );
      if (o.priority !== undefined) {
        requireEnum(o.priority, "#/options/priority", ["normal", "low"], errors);
      }
      if (o.dryRun !== undefined) {
        requireBoolean(o.dryRun, "#/options/dryRun", errors);
      }
      if (o.ttlSeconds !== undefined) {
        requireNumber(o.ttlSeconds, "#/options/ttlSeconds", errors, {
          integer: true,
          min: 60,
          max: 86400,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}


/**
 * Semantic checks for JobRequest beyond structural shape.
 * Mirrors frozen packages/contracts JobRequest semantics without package coupling:
 * referenced assets must appear in inputAssets with matching digest/purpose,
 * duplicates are rejected, and a proxy input is required.
 *
 * @param {unknown} jobRequest
 * @returns {ShapeResult}
 */
export function validateJobRequestSemantics(jobRequest) {
  /** @type {ShapeIssue[]} */
  const errors = [];
  if (!jobRequest || typeof jobRequest !== "object" || Array.isArray(jobRequest)) {
    return {
      valid: false,
      errors: [{ path: "#", message: "job request must be an object" }],
    };
  }

  const request = /** @type {Record<string, unknown>} */ (jobRequest);
  const inputAssets = Array.isArray(request.inputAssets) ? request.inputAssets : [];
  /** @type {Map<string, { asset: Record<string, unknown>, index: number }>} */
  const byId = new Map();
  for (let index = 0; index < inputAssets.length; index += 1) {
    const raw = inputAssets[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const asset = /** @type {Record<string, unknown>} */ (raw);
    const assetId = asset.assetId;
    if (typeof assetId !== "string") continue;
    if (byId.has(assetId)) {
      errors.push({
        path: `#/inputAssets/${index}/assetId`,
        message: `duplicate input asset ${assetId}`,
      });
      continue;
    }
    byId.set(assetId, { asset, index });
  }

  const effectSpec = request.effectSpec;
  if (!effectSpec || typeof effectSpec !== "object" || Array.isArray(effectSpec)) {
    errors.push({
      path: "#/effectSpec",
      message: "effectSpec is required for semantic checks",
    });
    return { valid: false, errors };
  }

  const ROLE_TO_PURPOSE = Object.freeze({
    effect: "effect_reference",
    style: "effect_reference",
    mask: "mask",
    depth: "guidance",
    normal: "guidance",
    environment: "effect_reference",
  });

  /** @type {Map<string, { purpose: string, digest: string | undefined, path: string }>} */
  const required = new Map();
  const spec = /** @type {Record<string, unknown>} */ (effectSpec);
  const references = Array.isArray(spec.references) ? spec.references : [];
  for (let index = 0; index < references.length; index += 1) {
    const raw = references[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const ref = /** @type {Record<string, unknown>} */ (raw);
    if (typeof ref.assetId !== "string") continue;
    const role = typeof ref.role === "string" ? ref.role : "effect";
    const purpose =
      ROLE_TO_PURPOSE[/** @type {keyof typeof ROLE_TO_PURPOSE} */ (role)] ??
      "effect_reference";
    const existing = required.get(ref.assetId);
    if (existing && existing.purpose !== purpose) {
      errors.push({
        path: `#/effectSpec/references/${index}/assetId`,
        message: `asset ${ref.assetId} has conflicting required purposes`,
      });
    }
    required.set(ref.assetId, {
      purpose,
      digest: typeof ref.digest === "string" ? ref.digest : undefined,
      path: `#/effectSpec/references/${index}`,
    });
  }

  const guidance = spec.guidance;
  if (guidance && typeof guidance === "object" && !Array.isArray(guidance)) {
    const subjectMaskAssetId =
      /** @type {Record<string, unknown>} */ (guidance).subjectMaskAssetId;
    if (typeof subjectMaskAssetId === "string") {
      required.set(subjectMaskAssetId, {
        purpose: "mask",
        digest: undefined,
        path: "#/effectSpec/guidance/subjectMaskAssetId",
      });
    }
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

  let hasProxy = false;
  for (let index = 0; index < inputAssets.length; index += 1) {
    const asset = inputAssets[index];
    if (
      asset &&
      typeof asset === "object" &&
      !Array.isArray(asset) &&
      /** @type {Record<string, unknown>} */ (asset).purpose === "proxy"
    ) {
      hasProxy = true;
      break;
    }
  }
  if (!hasProxy) {
    errors.push({
      path: "#/inputAssets",
      message: "inputAssets must include a proxy asset",
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Full JobRequest validation: structural shape + frozen semantic rules.
 * @param {unknown} jobRequest
 * @returns {ShapeResult}
 */
export function validateJobRequestComplete(jobRequest) {
  const structural = validateJobRequest(jobRequest);
  if (!structural.valid) return structural;
  return validateJobRequestSemantics(jobRequest);
}

/**
 * @param {unknown} body
 * @param {number} [maxBytes]
 */
export function assertBoundedJsonBody(body, maxBytes = MAX_REQUEST_JSON_BYTES) {
  let json;
  try {
    json = JSON.stringify(body);
  } catch {
    throw new Error("request body is not JSON-serializable");
  }
  const bytes =
    typeof TextEncoder !== "undefined"
      ? new TextEncoder().encode(json).length
      : utf8ByteLength(json);
  if (bytes > maxBytes) {
    throw new Error(
      `request body exceeds ${maxBytes} bytes (got ${bytes}); metadata-only bound`,
    );
  }
  return json;
}

/**
 * Count UTF-8 bytes without depending on TextEncoder, which may be absent in
 * some Photoshop UXP runtimes.
 * @param {string} value
 */
export function utf8ByteLength(value) {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      length += 1;
    } else if (code < 0x800) {
      length += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        length += 4;
      } else {
        length += 3;
      }
    } else {
      length += 3;
    }
  }
  return length;
}
