/**
 * Public typed HTTP client for the six frozen Mock API endpoints.
 * Metadata-only: validates contract shapes, rejects sensitive fields,
 * and bounds request sizes before network dispatch.
 */

import { ALLOWED_API_ORIGINS, DEFAULT_BASE_URL } from "../constants.mjs";
import { redactString, redactValue } from "../log/redact.mjs";
import { validateLayerManifest } from "../manifest/validate-manifest.mjs";
import { cloneDataOnlyGraph } from "../safety/data-snapshot.mjs";
import {
  validateAssetDescriptor,
  validateJobRequestComplete,
  assertBoundedJsonBody,
  utf8ByteLength,
  requireJobId as shapeRequireJobId,
  SCHEMA_VERSION,
  JOB_STATES,
  ACTIVE_JOB_STATES,
  JOB_EVENT_TYPES,
  IDEMPOTENCY_KEY_RE,
  JOB_ID_RE,
  ASSET_ID_RE,
  DIGEST_RE,
  MANIFEST_ID_RE,
  ISO_DATETIME_RE,
  ERROR_CODE_RE,
} from "./contract-shapes.mjs";

/** Default per-request network timeout (ms). Cancel/AbortSignal can end sooner. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const FROZEN_EVENT_ID_RE = /^evt_[a-z0-9_]{1,58}$/;

/**
 * @typedef {import('./http-client.d.mts').CinevfxHttpClient} CinevfxHttpClient
 * @typedef {import('./http-client.d.mts').CreateClientOptions} CreateClientOptions
 * @typedef {import('./http-client.d.mts').AssetDescriptor} AssetDescriptor
 * @typedef {import('./http-client.d.mts').JobRequest} JobRequest
 * @typedef {import('./http-client.d.mts').JobStatus} JobStatus
 * @typedef {import('./http-client.d.mts').JobEventsResponse} JobEventsResponse
 * @typedef {import('./http-client.d.mts').LayerManifest} LayerManifest
 * @typedef {import('./http-client.d.mts').IdempotencyKey} IdempotencyKey
 * @typedef {import('./http-client.d.mts').JobId} JobId
 */

export class CinevfxApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status: number, body?: unknown, code?: string }} detail
   */
  constructor(message, detail) {
    super(message);
    this.name = "CinevfxApiError";
    this.status = detail.status;
    this.body = detail.body;
    this.code = detail.code;
  }
}

/**
 * @param {CreateClientOptions} [options]
 * @returns {CinevfxHttpClient}
 */
export function createCinevfxClient(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl is required (provide a fetch polyfill in tests)");
  }
  const onBeforeNetwork = options.onBeforeNetwork ?? (() => {});
  const defaultTimeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.floor(options.timeoutMs))
      : DEFAULT_REQUEST_TIMEOUT_MS;
  const configuredResponseLimit =
    /** @type {{ maxResponseBytes?: unknown }} */ (options).maxResponseBytes;
  const maxResponseBytes = normalizeResponseLimit(configuredResponseLimit);

  /**
   * @param {string} method
   * @param {string} path
   * @param {{
   *   body?: unknown,
   *   headers?: Record<string, string>,
   *   okStatuses?: number[],
   *   signal?: AbortSignal,
   *   timeoutMs?: number,
  * }} [init]
  */
  async function request(method, path, init = {}) {
    const url = `${baseUrl}${path}`;
    /** @type {Record<string, string>} */
    const headers = {
      Accept: "application/json",
      ...(init.headers ?? {}),
    };
    /** @type {RequestInit} */
    const requestInit = { method, headers };
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      // Size-bound serialization happens before dispatch.
      requestInit.body = assertBoundedJsonBody(init.body);
    }

    const timeoutMs =
      typeof init.timeoutMs === "number" && Number.isFinite(init.timeoutMs)
        ? Math.max(1, Math.floor(init.timeoutMs))
        : defaultTimeoutMs;
    const { signal, cleanup } = combineAbortSignals(init.signal, timeoutMs);
    if (signal) {
      requestInit.signal = signal;
    }
    if (signal?.aborted) {
      cleanup();
      throw abortApiError(signal);
    }

    let response;
    try {
      onBeforeNetwork();
      if (signal?.aborted) throw abortApiError(signal);
      response = await fetchImpl(url, requestInit);
    } catch (err) {
      cleanup();
      if (isAbortError(err) || signal?.aborted) {
        const reason = signal?.reason;
        const timedOut =
          reason === "timeout" ||
          (reason &&
            typeof reason === "object" &&
            /** @type {{ name?: string }} */ (reason).name === "TimeoutError");
        throw new CinevfxApiError(
          timedOut ? "request timed out" : "request aborted",
          {
            status: 0,
            code: timedOut ? "timeout" : "aborted",
          },
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new CinevfxApiError(
        `network error: ${redactBoundedText(message, 480)}`,
        {
        status: 0,
        code: "network_error",
        },
      );
    }

    let text;
    try {
      text = await readResponseTextBounded(response, maxResponseBytes);
    } catch (err) {
      cleanup();
      if (signal?.aborted) {
        throw abortApiError(signal);
      }
      if (isAbortError(err)) {
        throw new CinevfxApiError("request aborted", {
          status: 0,
          code: "aborted",
        });
      }
      if (err instanceof ResponseTooLargeError) {
        throw new CinevfxApiError("response body exceeds configured limit", {
          status: response.status,
          code: "response_too_large",
        });
      }
      throw new CinevfxApiError("failed to read response body", {
        status: response.status,
        code: "response_read_error",
      });
    } finally {
      cleanup();
    }

    const okStatuses = init.okStatuses ?? [200];
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (okStatuses.includes(response.status)) {
          throw new CinevfxApiError("successful response is not valid JSON", {
            status: response.status,
            code: "invalid_response_json",
          });
        }
        parsed = { raw: text.slice(0, 200) };
      }
    }

    if (!okStatuses.includes(response.status)) {
      const errors = [];
      validateErrorObject(parsed, "#", errors);
      const safeBody = redactValue(parsed);
      if (errors.length > 0) {
        throw new CinevfxApiError("invalid error response", {
          status: response.status,
          body: { errors: errors.slice(0, 32), response: safeBody },
          code: "invalid_response",
        });
      }
      const remote = /** @type {{ code: string, message: string }} */ (parsed);
      throw new CinevfxApiError(redactBoundedText(remote.message, 512), {
        status: response.status,
        body: safeBody,
        code: remote.code,
      });
    }

    return { status: response.status, body: parsed };
  }

  return {
    baseUrl,

    /**
     * POST /v1/assets
    * @param {AssetDescriptor} descriptor
    */
    async createAsset(descriptor, assetOptions = {}) {
      const options = snapshotCallOptions(assetOptions, ["signal", "timeoutMs"]);
      const stableDescriptor = /** @type {AssetDescriptor} */ (
        snapshotRequestMetadata(
          descriptor,
          "invalid_asset_descriptor",
          "asset descriptor",
        )
      );
      const validation = validateAssetDescriptor(stableDescriptor);
      if (!validation.valid) {
        throw new CinevfxApiError(
          `invalid asset descriptor: ${validation.errors[0]?.message ?? "shape"}`,
          {
            status: 400,
            code: "invalid_asset_descriptor",
            body: { errors: validation.errors },
          },
        );
      }
      const response = await request("POST", "/v1/assets", {
        body: stableDescriptor,
        okStatuses: [201],
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      assertValidAssetResponse(
        response.body,
        stableDescriptor,
        response.status,
      );
      return /** @type {AssetDescriptor} */ (response.body);
    },

    /**
     * POST /v1/jobs
     * @param {JobRequest} jobRequest
     * @param {{ idempotencyKey?: IdempotencyKey, signal?: AbortSignal, timeoutMs?: number }} [jobOptions]
     */
    async createJob(jobRequest, jobOptions = {}) {
      if (!jobRequest || typeof jobRequest !== "object" || Array.isArray(jobRequest)) {
        throw new CinevfxApiError("job request must be an object", {
          status: 400,
          code: "invalid_job_request",
        });
      }

      const options = snapshotCallOptions(jobOptions, [
        "idempotencyKey",
        "signal",
        "timeoutMs",
      ]);
      const headerKey = options.idempotencyKey;
      const stableJobRequest = /** @type {JobRequest} */ (
        snapshotRequestMetadata(
          jobRequest,
          "invalid_job_request",
          "job request",
        )
      );
      const bodyKey =
        /** @type {{ idempotencyKey?: unknown }} */ (stableJobRequest)
          .idempotencyKey;

      if (headerKey !== undefined) {
        if (typeof headerKey !== "string" || !IDEMPOTENCY_KEY_RE.test(headerKey)) {
          throw new CinevfxApiError("idempotencyKey is invalid", {
            status: 400,
            code: "invalid_idempotency_key",
          });
        }
        if (bodyKey !== undefined && bodyKey !== headerKey) {
          throw new CinevfxApiError(
            "Idempotency-Key header must equal body idempotencyKey",
            { status: 400, code: "idempotency_mismatch" },
          );
        }
      }

      /** @type {Record<string, unknown>} */
      const normalized = {
        .../** @type {Record<string, unknown>} */ (stableJobRequest),
      };
      if (headerKey && !normalized.idempotencyKey) {
        normalized.idempotencyKey = headerKey;
      }

      if (
        typeof normalized.idempotencyKey !== "string" ||
        !IDEMPOTENCY_KEY_RE.test(normalized.idempotencyKey)
      ) {
        throw new CinevfxApiError("idempotencyKey is required", {
          status: 400,
          code: "missing_idempotency_key",
        });
      }

      const validation = validateJobRequestComplete(normalized);
      if (!validation.valid) {
        throw new CinevfxApiError(
          `invalid job request: ${validation.errors[0]?.message ?? "shape"}`,
          {
            status: 400,
            code: "invalid_job_request",
            body: { errors: validation.errors },
          },
        );
      }

      const key = /** @type {string} */ (normalized.idempotencyKey);
      const response = await request("POST", "/v1/jobs", {
        body: normalized,
        headers: { "Idempotency-Key": key },
        okStatuses: [200, 201],
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      assertValidJobStatusResponse(response.body, response.status, {
        idempotencyKey: key,
      });
      return {
        ...response,
        body: redactJobStatusText(response.body),
      };
    },

    /**
     * GET /v1/jobs/{id}
     * @param {JobId} jobId
     * @param {{ signal?: AbortSignal, timeoutMs?: number, expectedIdempotencyKey?: string }} [callOptions]
     */
    async getJob(jobId, callOptions = {}) {
      assertJobId(jobId);
      const options = snapshotCallOptions(callOptions, [
        "signal",
        "timeoutMs",
        "expectedIdempotencyKey",
      ]);
      assertExpectedIdempotencyKey(options.expectedIdempotencyKey);
      const { body } = await request(
        "GET",
        `/v1/jobs/${encodeURIComponent(jobId)}`,
        { signal: options.signal, timeoutMs: options.timeoutMs },
      );
      assertValidJobStatusResponse(body, 200, {
        jobId,
        idempotencyKey: options.expectedIdempotencyKey,
      });
      return /** @type {JobStatus} */ (redactJobStatusText(body));
    },

    /**
     * GET /v1/jobs/{id}/events
     * @param {JobId} jobId
     * @param {{ afterSequence?: number }} [eventOptions]
     */
    async listJobEvents(jobId, eventOptions = {}) {
      assertJobId(jobId);
      const options = snapshotCallOptions(eventOptions, [
        "afterSequence",
        "signal",
        "timeoutMs",
      ]);
      const after = options.afterSequence === undefined ? -1 : options.afterSequence;
      if (!Number.isInteger(after) || after < -1) {
        throw new CinevfxApiError(
          "afterSequence must be an integer greater than or equal to -1",
          { status: 400, code: "invalid_after_sequence" },
        );
      }
      const qs = `?afterSequence=${encodeURIComponent(String(after))}`;
      const { body } = await request(
        "GET",
        `/v1/jobs/${encodeURIComponent(jobId)}/events${qs}`,
        { signal: options.signal, timeoutMs: options.timeoutMs },
      );
      assertValidJobEventsResponse(body, jobId, after, 200);
      return /** @type {JobEventsResponse} */ (redactJobEventsText(body));
    },

    /**
     * POST /v1/jobs/{id}/cancel
     * @param {JobId} jobId
     * @param {{ signal?: AbortSignal, timeoutMs?: number, expectedIdempotencyKey?: string }} [callOptions]
     */
    async cancelJob(jobId, callOptions = {}) {
      assertJobId(jobId);
      const options = snapshotCallOptions(callOptions, [
        "signal",
        "timeoutMs",
        "expectedIdempotencyKey",
      ]);
      assertExpectedIdempotencyKey(options.expectedIdempotencyKey);
      const { body } = await request(
        "POST",
        `/v1/jobs/${encodeURIComponent(jobId)}/cancel`,
        {
          okStatuses: [200],
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        },
      );
      assertValidJobStatusResponse(body, 200, {
        jobId,
        idempotencyKey: options.expectedIdempotencyKey,
      });
      return /** @type {JobStatus} */ (redactJobStatusText(body));
    },

    /**
     * GET /v1/jobs/{id}/manifest
     * @param {JobId} jobId
     */
    async getManifest(jobId, callOptions = {}) {
      assertJobId(jobId);
      const options = snapshotCallOptions(callOptions, ["signal", "timeoutMs"]);
      const { body } = await request(
        "GET",
        `/v1/jobs/${encodeURIComponent(jobId)}/manifest`,
        { signal: options.signal, timeoutMs: options.timeoutMs },
      );
      assertValidManifestResponse(body, jobId, 200);
      return /** @type {LayerManifest} */ (body);
    },
  };
}

class ResponseTooLargeError extends Error {}

/**
 * @param {unknown} configured
 */
function normalizeResponseLimit(configured) {
  if (configured === undefined) return DEFAULT_MAX_RESPONSE_BYTES;
  if (
    typeof configured !== "number" ||
    !Number.isFinite(configured) ||
    configured < 1
  ) {
    throw new Error("maxResponseBytes must be a positive finite number");
  }
  return Math.floor(configured);
}

/**
 * Enforce a response byte limit without calling unbounded response.json().
 * Streaming responses are stopped as soon as the limit is crossed;
 * UXP-compatible non-streaming responses are checked after text decoding.
 * @param {Response | { body?: unknown, headers?: unknown, text: () => Promise<string> }} response
 * @param {number} maxBytes
 */
async function readResponseTextBounded(response, maxBytes) {
  const contentLengthText =
    response.headers &&
    typeof /** @type {{ get?: unknown }} */ (response.headers).get === "function"
      ? /** @type {{ get: (name: string) => string | null }} */ (response.headers).get(
          "content-length",
        )
      : null;
  if (contentLengthText !== null) {
    const contentLength = Number(contentLengthText);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new ResponseTooLargeError();
    }
  }

  const body = /** @type {{ getReader?: () => ReadableStreamDefaultReader<Uint8Array> } | null | undefined} */ (
    response.body
  );
  if (body && typeof body.getReader === "function" && typeof TextDecoder !== "undefined") {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parts = [];
    let byteLength = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) {
          throw new Error("response stream produced a non-byte chunk");
        }
        byteLength += value.byteLength;
        if (byteLength > maxBytes) {
          try {
            await reader.cancel("response too large");
          } catch {
            // The size error remains authoritative if cancellation itself fails.
          }
          throw new ResponseTooLargeError();
        }
        parts.push(decoder.decode(value, { stream: true }));
      }
      parts.push(decoder.decode());
      return parts.join("");
    } finally {
      reader.releaseLock?.();
    }
  }

  const text = await response.text();
  if (utf8ByteLength(text) > maxBytes) {
    throw new ResponseTooLargeError();
  }
  return text;
}

/** @param {unknown} value */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} value
 * @param {string[]} allowed
 * @param {string[]} required
 * @param {string} path
 * @param {{ path: string, message: string }[]} errors
 */
function validateObjectKeys(value, allowed, required, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push({ path: `${path}/${key}`, message: "unknown field" });
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      errors.push({ path: `${path}/${key}`, message: "field is required" });
    }
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {{ path: string, message: string }[]} errors
 * @param {{ min?: number, max?: number, pattern?: RegExp, allowEmpty?: boolean }} [options]
 */
function validateString(value, path, errors, options = {}) {
  if (typeof value !== "string") {
    errors.push({ path, message: "must be a string" });
    return;
  }
  if (options.allowEmpty !== true && value.length === 0) {
    errors.push({ path, message: "must not be empty" });
  }
  if (options.min !== undefined && value.length < options.min) {
    errors.push({ path, message: `must have at least ${options.min} characters` });
  }
  if (options.max !== undefined && value.length > options.max) {
    errors.push({ path, message: `must have at most ${options.max} characters` });
  }
  if (options.pattern && !options.pattern.test(value)) {
    errors.push({ path, message: "has invalid format" });
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {{ path: string, message: string }[]} errors
 */
function validateTimestamp(value, path, errors) {
  validateString(value, path, errors, { pattern: ISO_DATETIME_RE });
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {{ path: string, message: string }[]} errors
 */
function validateProgress(value, path, errors) {
  if (!isRecord(value)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  const progress = /** @type {Record<string, unknown>} */ (value);
  validateObjectKeys(progress, ["ratio", "stage", "message"], ["ratio", "stage"], path, errors);
  if (
    typeof progress.ratio !== "number" ||
    !Number.isFinite(progress.ratio) ||
    progress.ratio < 0 ||
    progress.ratio > 1
  ) {
    errors.push({ path: `${path}/ratio`, message: "must be between 0 and 1" });
  }
  validateString(progress.stage, `${path}/stage`, errors, { min: 1, max: 64 });
  if (progress.message !== undefined) {
    validateString(progress.message, `${path}/message`, errors, {
      max: 256,
      allowEmpty: true,
    });
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {{ path: string, message: string }[]} errors
 */
function validateErrorObject(value, path, errors) {
  if (!isRecord(value)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  const error = /** @type {Record<string, unknown>} */ (value);
  validateObjectKeys(error, ["code", "message", "retriable"], ["code", "message"], path, errors);
  validateString(error.code, `${path}/code`, errors, { pattern: ERROR_CODE_RE });
  validateString(error.message, `${path}/message`, errors, { min: 1, max: 512 });
  if (error.retriable !== undefined && typeof error.retriable !== "boolean") {
    errors.push({ path: `${path}/retriable`, message: "must be boolean" });
  }
}

/**
 * @param {unknown} body
 * @param {{ jobId?: string, idempotencyKey?: string }} [expected]
 */
function validateJobStatusResponse(body, expected = {}) {
  /** @type {{ path: string, message: string }[]} */
  const errors = [];
  if (!isRecord(body)) {
    return [{ path: "#", message: "must be an object" }];
  }
  const status = /** @type {Record<string, unknown>} */ (body);
  const allowed = [
    "schemaVersion",
    "jobId",
    "idempotencyKey",
    "state",
    "progress",
    "createdAt",
    "updatedAt",
    "cancelRequested",
    "startedAt",
    "finishedAt",
    "error",
    "manifestId",
    "eventCount",
  ];
  validateObjectKeys(
    status,
    allowed,
    [
      "schemaVersion",
      "jobId",
      "idempotencyKey",
      "state",
      "progress",
      "createdAt",
      "updatedAt",
      "cancelRequested",
    ],
    "#",
    errors,
  );
  if (status.schemaVersion !== SCHEMA_VERSION) {
    errors.push({ path: "#/schemaVersion", message: "must be 1.0.0" });
  }
  validateString(status.jobId, "#/jobId", errors, { pattern: JOB_ID_RE });
  validateString(status.idempotencyKey, "#/idempotencyKey", errors, {
    pattern: IDEMPOTENCY_KEY_RE,
  });
  if (!JOB_STATES.includes(/** @type {string} */ (status.state))) {
    errors.push({ path: "#/state", message: "unknown job state" });
  }
  validateProgress(status.progress, "#/progress", errors);
  validateTimestamp(status.createdAt, "#/createdAt", errors);
  validateTimestamp(status.updatedAt, "#/updatedAt", errors);
  for (const field of ["startedAt", "finishedAt"]) {
    if (status[field] !== undefined) {
      validateTimestamp(status[field], `#/${field}`, errors);
    }
  }
  if (typeof status.cancelRequested !== "boolean") {
    errors.push({ path: "#/cancelRequested", message: "must be boolean" });
  }
  if (
    status.eventCount !== undefined &&
    (!Number.isInteger(status.eventCount) || status.eventCount < 0)
  ) {
    errors.push({ path: "#/eventCount", message: "must be a non-negative integer" });
  }
  if (status.error !== undefined) validateErrorObject(status.error, "#/error", errors);
  if (status.manifestId !== undefined) {
    validateString(status.manifestId, "#/manifestId", errors, {
      pattern: MANIFEST_ID_RE,
    });
  }

  if (expected.jobId !== undefined && status.jobId !== expected.jobId) {
    errors.push({ path: "#/jobId", message: "does not match requested job" });
  }
  if (
    expected.idempotencyKey !== undefined &&
    status.idempotencyKey !== expected.idempotencyKey
  ) {
    errors.push({
      path: "#/idempotencyKey",
      message: "does not match submitted request",
    });
  }

  const forbid = (fields) => {
    for (const field of fields) {
      if (Object.hasOwn(status, field)) {
        errors.push({ path: `#/${field}`, message: `forbidden for ${status.state}` });
      }
    }
  };
  const require = (fields) => {
    for (const field of fields) {
      if (!Object.hasOwn(status, field)) {
        errors.push({ path: `#/${field}`, message: `required for ${status.state}` });
      }
    }
  };
  if (status.state === "CREATED") {
    if (status.cancelRequested !== false) {
      errors.push({ path: "#/cancelRequested", message: "must be false for CREATED" });
    }
    if (isRecord(status.progress) && status.progress.ratio !== 0) {
      errors.push({ path: "#/progress/ratio", message: "must be 0 for CREATED" });
    }
    forbid(["finishedAt", "error", "manifestId"]);
  } else if (
    ACTIVE_JOB_STATES.includes(/** @type {string} */ (status.state))
  ) {
    forbid(["finishedAt", "error", "manifestId"]);
  } else if (status.state === "SUCCEEDED") {
    require(["finishedAt", "manifestId"]);
    forbid(["error"]);
    if (status.cancelRequested !== false) {
      errors.push({ path: "#/cancelRequested", message: "must be false for SUCCEEDED" });
    }
    if (isRecord(status.progress) && status.progress.ratio !== 1) {
      errors.push({ path: "#/progress/ratio", message: "must be 1 for SUCCEEDED" });
    }
  } else if (status.state === "FAILED") {
    require(["finishedAt", "error"]);
    forbid(["manifestId"]);
    if (status.cancelRequested !== false) {
      errors.push({ path: "#/cancelRequested", message: "must be false for FAILED" });
    }
  } else if (status.state === "CANCELLED") {
    require(["finishedAt"]);
    forbid(["error", "manifestId"]);
    if (status.cancelRequested !== true) {
      errors.push({ path: "#/cancelRequested", message: "must be true for CANCELLED" });
    }
  } else if (status.state === "EXPIRED") {
    require(["finishedAt"]);
    forbid(["error", "manifestId"]);
    if (status.cancelRequested !== false) {
      errors.push({ path: "#/cancelRequested", message: "must be false for EXPIRED" });
    }
  }
  return errors;
}

/**
 * @param {unknown} body
 * @param {number} status
 * @param {{ jobId?: string, idempotencyKey?: string }} expected
 */
function assertValidJobStatusResponse(body, status, expected) {
  const errors = validateJobStatusResponse(body, expected);
  if (errors.length > 0) throwInvalidResponse("JobStatus", status, errors);
}

/**
 * @param {unknown} body
 * @param {AssetDescriptor} requestDescriptor
 * @param {number} status
 */
function assertValidAssetResponse(body, requestDescriptor, status) {
  const validation = validateAssetDescriptor(body);
  const errors = [...validation.errors];
  if (isRecord(body)) {
    const descriptor = /** @type {Record<string, unknown>} */ (body);
    if (descriptor.assetId !== requestDescriptor.assetId) {
      errors.push({ path: "#/assetId", message: "does not match submitted asset" });
    }
    if (descriptor.digest !== requestDescriptor.digest) {
      errors.push({ path: "#/digest", message: "does not match submitted asset" });
    }
  }
  if (errors.length > 0) throwInvalidResponse("AssetDescriptor", status, errors);
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {{ path: string, message: string }[]} errors
 */
function validateVerifiedAssetRef(value, path, errors) {
  if (!isRecord(value)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  const ref = /** @type {Record<string, unknown>} */ (value);
  validateObjectKeys(ref, ["assetId", "digest"], ["assetId", "digest"], path, errors);
  validateString(ref.assetId, `${path}/assetId`, errors, { pattern: ASSET_ID_RE });
  validateString(ref.digest, `${path}/digest`, errors, { pattern: DIGEST_RE });
}

/**
 * @param {unknown} value
 * @param {string} expectedJobId
 * @param {number} index
 */
function validateJobEvent(value, expectedJobId, index) {
  const path = `#/events/${index}`;
  /** @type {{ path: string, message: string }[]} */
  const errors = [];
  if (!isRecord(value)) return [{ path, message: "must be an object" }];
  const event = /** @type {Record<string, unknown>} */ (value);
  validateObjectKeys(
    event,
    [
      "schemaVersion",
      "eventId",
      "jobId",
      "sequence",
      "type",
      "state",
      "timestamp",
      "progress",
      "message",
      "error",
      "assetRef",
      "manifestId",
    ],
    ["schemaVersion", "eventId", "jobId", "sequence", "type", "state", "timestamp"],
    path,
    errors,
  );
  if (event.schemaVersion !== SCHEMA_VERSION) {
    errors.push({ path: `${path}/schemaVersion`, message: "must be 1.0.0" });
  }
  validateString(event.eventId, `${path}/eventId`, errors, {
    pattern: FROZEN_EVENT_ID_RE,
  });
  validateString(event.jobId, `${path}/jobId`, errors, { pattern: JOB_ID_RE });
  if (event.jobId !== expectedJobId) {
    errors.push({ path: `${path}/jobId`, message: "does not match envelope job" });
  }
  if (!Number.isInteger(event.sequence) || event.sequence < 0) {
    errors.push({ path: `${path}/sequence`, message: "must be a non-negative integer" });
  }
  if (!JOB_EVENT_TYPES.includes(/** @type {string} */ (event.type))) {
    errors.push({ path: `${path}/type`, message: "unknown event type" });
  }
  if (!JOB_STATES.includes(/** @type {string} */ (event.state))) {
    errors.push({ path: `${path}/state`, message: "unknown job state" });
  }
  validateTimestamp(event.timestamp, `${path}/timestamp`, errors);
  if (event.message !== undefined) {
    validateString(event.message, `${path}/message`, errors, {
      max: 256,
      allowEmpty: true,
    });
  }

  const payloadFields = ["progress", "error", "assetRef", "manifestId"];
  const requirePayload = (field) => {
    if (!Object.hasOwn(event, field)) {
      errors.push({ path: `${path}/${field}`, message: `required for ${event.type}` });
    }
  };
  const forbidPayloads = (allowed = []) => {
    for (const field of payloadFields) {
      if (!allowed.includes(field) && Object.hasOwn(event, field)) {
        errors.push({ path: `${path}/${field}`, message: `forbidden for ${event.type}` });
      }
    }
  };

  if (event.type === "state_changed") {
    forbidPayloads();
  } else if (event.type === "progress") {
    requirePayload("progress");
    forbidPayloads(["progress"]);
    if (!ACTIVE_JOB_STATES.includes(/** @type {string} */ (event.state))) {
      errors.push({ path: `${path}/state`, message: "progress requires active state" });
    }
    validateEventProgress(event.progress, `${path}/progress`, errors);
  } else if (event.type === "asset_ready") {
    requirePayload("assetRef");
    forbidPayloads(["assetRef"]);
    if (!ACTIVE_JOB_STATES.includes(/** @type {string} */ (event.state))) {
      errors.push({ path: `${path}/state`, message: "asset_ready requires active state" });
    }
    validateVerifiedAssetRef(event.assetRef, `${path}/assetRef`, errors);
  } else if (event.type === "manifest_ready") {
    requirePayload("manifestId");
    forbidPayloads(["manifestId"]);
    if (event.state !== "SUCCEEDED") {
      errors.push({ path: `${path}/state`, message: "manifest_ready requires SUCCEEDED" });
    }
    validateString(event.manifestId, `${path}/manifestId`, errors, {
      pattern: MANIFEST_ID_RE,
    });
  } else if (event.type === "cancel_accepted") {
    forbidPayloads();
    if (event.state !== "CANCELLED") {
      errors.push({ path: `${path}/state`, message: "cancel_accepted requires CANCELLED" });
    }
  } else if (event.type === "error") {
    requirePayload("error");
    forbidPayloads(["error"]);
    if (event.state !== "FAILED") {
      errors.push({ path: `${path}/state`, message: "error requires FAILED" });
    }
    validateErrorObject(event.error, `${path}/error`, errors);
  }
  return errors;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {{ path: string, message: string }[]} errors
 */
function validateEventProgress(value, path, errors) {
  if (!isRecord(value)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  const progress = /** @type {Record<string, unknown>} */ (value);
  validateObjectKeys(progress, ["ratio", "stage"], ["ratio"], path, errors);
  if (
    typeof progress.ratio !== "number" ||
    !Number.isFinite(progress.ratio) ||
    progress.ratio < 0 ||
    progress.ratio > 1
  ) {
    errors.push({ path: `${path}/ratio`, message: "must be between 0 and 1" });
  }
  if (progress.stage !== undefined) {
    validateString(progress.stage, `${path}/stage`, errors, {
      max: 64,
      allowEmpty: true,
    });
  }
}

/**
 * @param {unknown} body
 * @param {string} expectedJobId
 * @param {number} afterSequence
 * @param {number} status
 */
function assertValidJobEventsResponse(body, expectedJobId, afterSequence, status) {
  /** @type {{ path: string, message: string }[]} */
  const errors = [];
  if (!isRecord(body)) {
    throwInvalidResponse("JobEventsResponse", status, [
      { path: "#", message: "must be an object" },
    ]);
  }
  const envelope = /** @type {Record<string, unknown>} */ (body);
  validateObjectKeys(envelope, ["jobId", "events"], ["jobId", "events"], "#", errors);
  validateString(envelope.jobId, "#/jobId", errors, { pattern: JOB_ID_RE });
  if (envelope.jobId !== expectedJobId) {
    errors.push({ path: "#/jobId", message: "does not match requested job" });
  }
  if (!Array.isArray(envelope.events)) {
    errors.push({ path: "#/events", message: "must be an array" });
  } else {
    let previous = afterSequence;
    const seenEventIds = new Set();
    envelope.events.forEach((event, index) => {
      errors.push(...validateJobEvent(event, expectedJobId, index));
      if (isRecord(event) && typeof event.eventId === "string") {
        if (seenEventIds.has(event.eventId)) {
          errors.push({
            path: `#/events/${index}/eventId`,
            message: "must be unique within the response",
          });
        }
        seenEventIds.add(event.eventId);
      }
      if (isRecord(event) && Number.isInteger(event.sequence)) {
        if (event.sequence <= previous) {
          errors.push({
            path: `#/events/${index}/sequence`,
            message: "must be strictly ordered after the cursor",
          });
        }
        previous = /** @type {number} */ (event.sequence);
      }
    });
  }
  if (errors.length > 0) throwInvalidResponse("JobEventsResponse", status, errors);
}

/**
 * @param {unknown} body
 * @param {string} expectedJobId
 * @param {number} status
 */
function assertValidManifestResponse(body, expectedJobId, status) {
  const validation = validateLayerManifest(body);
  const errors = [...validation.errors];
  if (isRecord(body) && body.jobId !== expectedJobId) {
    errors.push({ path: "#/jobId", message: "does not match requested job" });
  }
  if (errors.length > 0) throwInvalidResponse("LayerManifest", status, errors);
}

/**
 * @param {string} kind
 * @param {number} status
 * @param {{ path: string, message: string }[]} errors
 * @returns {never}
 */
function throwInvalidResponse(kind, status, errors) {
  throw new CinevfxApiError(`invalid ${kind} response`, {
    status,
    code: "invalid_response",
    body: { errors: errors.slice(0, 32) },
  });
}

/** @param {unknown} body */
function redactJobStatusText(body) {
  const status = /** @type {Record<string, unknown>} */ (body);
  const safe = { ...status };
  if (isRecord(status.progress)) {
    const progress = /** @type {Record<string, unknown>} */ (status.progress);
    safe.progress = {
      ...progress,
      ...(typeof progress.stage === "string"
        ? { stage: redactBoundedText(progress.stage, 64) }
        : {}),
      ...(typeof progress.message === "string"
        ? { message: redactBoundedText(progress.message, 256) }
        : {}),
    };
  }
  if (isRecord(status.error)) {
    const error = /** @type {Record<string, unknown>} */ (status.error);
    safe.error = {
      ...error,
      ...(typeof error.message === "string"
        ? { message: redactBoundedText(error.message, 512) }
        : {}),
    };
  }
  return safe;
}

/** @param {unknown} body */
function redactJobEventsText(body) {
  const envelope = /** @type {Record<string, unknown>} */ (body);
  const events = /** @type {unknown[]} */ (envelope.events);
  const safeEvents = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = /** @type {Record<string, unknown>} */ (events[index]);
    const safeEvent = {
      ...event,
      ...(typeof event.message === "string"
        ? { message: redactBoundedText(event.message, 256) }
        : {}),
    };
    if (isRecord(event.progress)) {
      const progress = /** @type {Record<string, unknown>} */ (event.progress);
      safeEvent.progress = {
        ...progress,
        ...(typeof progress.stage === "string"
          ? { stage: redactBoundedText(progress.stage, 64) }
          : {}),
        ...(typeof progress.message === "string"
          ? { message: redactBoundedText(progress.message, 256) }
          : {}),
      };
    }
    if (isRecord(event.error)) {
      const error = /** @type {Record<string, unknown>} */ (event.error);
      safeEvent.error = {
        ...error,
        ...(typeof error.message === "string"
          ? { message: redactBoundedText(error.message, 512) }
          : {}),
      };
    }
    safeEvents.push(safeEvent);
  }
  return { ...envelope, events: safeEvents };
}

/**
 * Redaction can expand placeholders, so re-apply the frozen field bound.
 * @param {string} value
 * @param {number} maxLength
 */
function redactBoundedText(value, maxLength) {
  const safe = redactString(value);
  if (safe.length <= maxLength) return safe;
  if (maxLength <= 3) return safe.slice(0, maxLength);
  return `${safe.slice(0, maxLength - 3)}...`;
}


/**
 * @param {unknown} err
 */
function isAbortError(err) {
  if (!err || typeof err !== "object") return false;
  const name = /** @type {{ name?: string }} */ (err).name;
  return name === "AbortError" || name === "TimeoutError";
}

/** @param {AbortSignal} signal */
function abortApiError(signal) {
  const reason = signal.reason;
  const timedOut =
    reason === "timeout" ||
    (reason &&
      typeof reason === "object" &&
      /** @type {{ name?: string }} */ (reason).name === "TimeoutError");
  return new CinevfxApiError(
    timedOut ? "request timed out" : "request aborted",
    { status: 0, code: timedOut ? "timeout" : "aborted" },
  );
}

/**
 * Combine an optional external AbortSignal with a bounded timeout.
 * @param {AbortSignal | undefined} external
 * @param {number} timeoutMs
 * @returns {{ signal: AbortSignal | undefined, cleanup: () => void }}
 */
function combineAbortSignals(external, timeoutMs) {
  if (external?.aborted) {
    return { signal: external, cleanup: () => {} };
  }

  const controller = new AbortController();
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = setTimeout(() => {
    timer = null;
    try {
      controller.abort(
        typeof DOMException !== "undefined"
          ? new DOMException("request timed out", "TimeoutError")
          : "timeout",
      );
    } catch {
      controller.abort("timeout");
    }
  }, timeoutMs);

  /** @type {(() => void) | null} */
  let onExternalAbort = null;
  if (external) {
    onExternalAbort = () => {
      try {
        controller.abort(external.reason ?? "aborted");
      } catch {
        controller.abort();
      }
    };
    if (typeof external.addEventListener === "function") {
      external.addEventListener("abort", onExternalAbort, { once: true });
    } else if (external.aborted) {
      onExternalAbort();
    }
  }

  const cleanup = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (external && onExternalAbort && typeof external.removeEventListener === "function") {
      external.removeEventListener("abort", onExternalAbort);
    }
  };

  return { signal: controller.signal, cleanup };
}

/**
 * @param {string} baseUrl
 */
function normalizeBaseUrl(baseUrl) {
  if (
    typeof baseUrl !== "string" ||
    baseUrl.length === 0 ||
    baseUrl.trim() !== baseUrl
  ) {
    throw new Error("baseUrl must match an allowed loopback origin exactly");
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("baseUrl must be an allowed absolute loopback origin");
  }
  if (
    !ALLOWED_API_ORIGINS.includes(parsed.origin) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.href !== `${parsed.origin}/`
  ) {
    throw new Error("baseUrl must match an allowed loopback origin exactly");
  }
  return parsed.origin;
}

/**
 * Capture the exact JSON graph once. Accessors are rejected so validation,
 * serialization, and response identity checks cannot observe different values.
 * @param {unknown} value
 * @param {string} code
 * @param {string} label
 * @returns {unknown}
 */
function snapshotRequestMetadata(value, code, label) {
  try {
    const dataOnly = cloneDataOnlyGraph(value);
    const json = assertBoundedJsonBody(dataOnly);
    if (typeof json !== "string") {
      throw new Error("request metadata is not JSON-serializable");
    }
    return JSON.parse(json);
  } catch (error) {
    throw new CinevfxApiError(
      `invalid ${label}: ${error instanceof Error ? error.message : String(error)}`,
      { status: 400, code },
    );
  }
}

/**
 * Snapshot primitive call options without cloning AbortSignal. Accessors and
 * unknown keys are rejected before any async boundary.
 * @param {unknown} value
 * @param {string[]} allowedKeys
 * @returns {Record<string, any>}
 */
function snapshotCallOptions(value, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CinevfxApiError("call options must be an object", {
      status: 400,
      code: "invalid_call_options",
    });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CinevfxApiError("call options must be a plain object", {
      status: 400,
      code: "invalid_call_options",
    });
  }
  const allowed = new Set(allowedKeys);
  const snapshot = Object.create(null);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new CinevfxApiError(`unknown call option ${key}`, {
        status: 400,
        code: "invalid_call_options",
      });
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new CinevfxApiError(`call option ${key} must be data-only`, {
        status: 400,
        code: "invalid_call_options",
      });
    }
    snapshot[key] = descriptor.value;
  }
  if (
    snapshot.timeoutMs !== undefined &&
    (typeof snapshot.timeoutMs !== "number" ||
      !Number.isFinite(snapshot.timeoutMs) ||
      snapshot.timeoutMs <= 0)
  ) {
    throw new CinevfxApiError("timeoutMs must be a positive finite number", {
      status: 400,
      code: "invalid_call_options",
    });
  }
  return snapshot;
}

/**
 * @param {unknown} jobId
 */
function assertJobId(jobId) {
  /** @type {{ path: string, message: string }[]} */
  const errors = [];
  shapeRequireJobId(jobId, "jobId", errors);
  if (errors.length > 0 || typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) {
    throw new Error("jobId must be a job_* string");
  }
}

/**
 * @param {unknown} value
 */
function assertExpectedIdempotencyKey(value) {
  if (
    value !== undefined &&
    (typeof value !== "string" || !IDEMPOTENCY_KEY_RE.test(value))
  ) {
    throw new CinevfxApiError("expectedIdempotencyKey is invalid", {
      status: 400,
      code: "invalid_idempotency_key",
    });
  }
}
