/**
 * Mock API domain service: asset registration, job lifecycle, idempotency,
 * cancellation, events, and manifest publication.
 */

import {
  isTerminalJobState,
  validateDocument,
  validateIdempotencyKeyPair,
  validateJobEventStream,
  validateJobRequestSemantics,
  validateManifestSemantics,
} from "../../../packages/contracts/src/index.mjs";
import { HttpError } from "./errors.mjs";
import {
  advanceToExpired,
  advanceToFailure,
  advanceToSuccess,
  createInitialJobRecord,
  emitCreatedEvent,
  transitionJob,
} from "./lifecycle.mjs";
import { createLogger } from "./redact.mjs";
import { createStore, getManifest, listEvents, snapshotStatus } from "./store.mjs";
import { cloneJson, deepEqual, formatIsoUtc, padCounter, stableStringify } from "./util.mjs";

const IDEMPOTENCY_KEY_PATTERN = /^idem_[A-Za-z0-9_-]{8,128}$/;
const JOB_ID_PATTERN = /^job_[a-z0-9_]{1,58}$/;
const ASSET_ID_PATTERN = /^asset_[a-z0-9_]{1,56}$/;

/** Mock-only options that steer deterministic terminal outcomes. */
function mockOutcomeFromRequest(request) {
  const options = request.options ?? {};
  // Prefer explicit mockOutcome when present (tests); ignore unknown fields
  // only if schema allowed them — schema forbids extra props, so use labels.
  if (options.dryRun === true) {
    return { type: "created_only" };
  }
  const label = request.effectSpec?.label ?? "";
  if (typeof label === "string") {
    if (label.includes("force-fail") || label.includes("mock-fail")) {
      return {
        type: "fail",
        error: {
          code: "MOCK_FORCED_FAILURE",
          message: "Mock failure path requested by effect label",
          retriable: false,
        },
      };
    }
    if (label.includes("force-expire") || label.includes("mock-expire")) {
      return { type: "expire", message: "Mock expiry path requested by effect label" };
    }
    if (label.includes("force-hold") || label.includes("mock-hold")) {
      // Leave job active after CREATED so cancel can be exercised mid-flight.
      return { type: "hold", advanceTo: "RENDERING" };
    }
  }
  // Schema min is 60; treat the minimum allowed TTL as the Mock expiry path.
  if (options.ttlSeconds !== undefined && options.ttlSeconds <= 60) {
    return { type: "expire", message: "TTL elapsed before start" };
  }
  return { type: "success" };
}

export function createMockApi(options = {}) {
  const store = options.store ?? createStore(options.limits);
  const logger = options.logger ?? createLogger({ sink: options.logSink });
  const clock = options.clock ?? formatIsoUtc;
  const autoAdvance = options.autoAdvance !== false;
  let mutationTail = Promise.resolve();

  function runMutationExclusive(operation) {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function requireJob(jobId) {
    if (!JOB_ID_PATTERN.test(jobId)) {
      throw new HttpError(400, "INVALID_JOB_ID", "job id format is invalid", {
        retriable: false,
      });
    }
    const job = store.jobsById.get(jobId);
    if (!job) {
      throw new HttpError(404, "JOB_NOT_FOUND", `job ${jobId} not found`, {
        retriable: false,
      });
    }
    return job;
  }

  async function createAssetUnlocked(descriptor) {
    const validation = await validateDocument("AssetDescriptor", descriptor);
    if (!validation.valid) {
      logger.warn("asset validation failed", {
        assetId: descriptor?.assetId,
        errorCount: validation.errors.length,
      });
      throw new HttpError(400, "INVALID_ASSET", summarizeErrors(validation.errors), {
        retriable: false,
      });
    }

    if (!ASSET_ID_PATTERN.test(descriptor.assetId)) {
      throw new HttpError(400, "INVALID_ASSET_ID", "assetId format is invalid", {
        retriable: false,
      });
    }

    const existing = store.assetsById.get(descriptor.assetId);
    if (existing) {
      if (existing.digest !== descriptor.digest) {
        throw new HttpError(
          409,
          "ASSET_DIGEST_CONFLICT",
          `asset ${descriptor.assetId} already exists with a different digest`,
          { retriable: false },
        );
      }
      // OpenAPI exposes only 201 for a successful asset registration, including replay.
      if (!deepEqual(existing, descriptor)) {
        // Same digest but conflicting metadata fields.
        throw new HttpError(
          409,
          "ASSET_CONFLICT",
          `asset ${descriptor.assetId} already exists with conflicting metadata`,
          { retriable: false },
        );
      }
      logger.info("asset replay", { assetId: descriptor.assetId });
      return { status: 201, body: cloneJson(existing) };
    }

    if (store.assetsById.size >= store.limits.maxAssets) {
      throw new HttpError(
        400,
        "RESOURCE_LIMIT",
        `asset limit of ${store.limits.maxAssets} reached`,
        { retriable: false },
      );
    }

    const stored = cloneJson(descriptor);
    store.assetsById.set(stored.assetId, stored);
    logger.info("asset created", {
      assetId: stored.assetId,
      purpose: stored.purpose,
      digest: stored.digest,
    });
    return { status: 201, body: cloneJson(stored) };
  }

  function createAsset(descriptor) {
    return runMutationExclusive(() => createAssetUnlocked(descriptor));
  }

  function validateRegisteredAssets(request) {
    const errors = [];
    for (const [index, ref] of request.inputAssets.entries()) {
      const registered = store.assetsById.get(ref.assetId);
      if (!registered) {
        errors.push({
          path: `#/inputAssets/${index}/assetId`,
          message: `asset ${ref.assetId} is not registered`,
        });
        continue;
      }
      if (registered.digest !== ref.digest) {
        errors.push({
          path: `#/inputAssets/${index}/digest`,
          message: `declared digest does not match registered asset ${ref.assetId}`,
        });
      }
      if (registered.purpose !== ref.purpose) {
        errors.push({
          path: `#/inputAssets/${index}/purpose`,
          message: `declared purpose does not match registered asset ${ref.assetId}`,
        });
      }
    }
    return errors;
  }

  async function createJobUnlocked(request, headerIdempotencyKey) {
    // Header/body key agreement and format first so conflict detection can run
    // before full schema validation of potentially invalid replay bodies.
    const keyPair = validateIdempotencyKeyPair(
      request?.idempotencyKey,
      headerIdempotencyKey,
    );
    if (!keyPair.valid) {
      throw new HttpError(400, "IDEMPOTENCY_KEY_MISMATCH", summarizeErrors(keyPair.errors), {
        retriable: false,
      });
    }
    if (typeof request?.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(request.idempotencyKey)) {
      throw new HttpError(400, "INVALID_IDEMPOTENCY_KEY", "idempotencyKey format is invalid", {
        retriable: false,
      });
    }

    // Once a key has created a job, any different body is a conflict even when
    // the new body fails schema/semantic validation.
    const existingJobId = store.jobsByIdempotencyKey.get(request.idempotencyKey);
    if (existingJobId) {
      const existing = store.jobsById.get(existingJobId);
      if (!existing) {
        throw new HttpError(500, "INTERNAL", "idempotency index corrupted", {
          retriable: true,
        });
      }
      if (!deepEqual(existing.request, request)) {
        throw new HttpError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "idempotency key reused with a different request body",
          { retriable: false },
        );
      }
      // Exact replay still requires a schema-valid body (matches the stored one).
      const replayValidation = await validateDocument("JobRequest", request);
      if (!replayValidation.valid) {
        throw new HttpError(400, "INVALID_JOB_REQUEST", summarizeErrors(replayValidation.errors), {
          retriable: false,
        });
      }
      logger.info("job replay", {
        jobId: existing.jobId,
        state: existing.status.state,
      });
      return { status: 200, body: snapshotStatus(existing) };
    }

    const validation = await validateDocument("JobRequest", request);
    if (!validation.valid) {
      logger.warn("job request validation failed", {
        idempotencyKey: request?.idempotencyKey,
        errorCount: validation.errors.length,
      });
      throw new HttpError(400, "INVALID_JOB_REQUEST", summarizeErrors(validation.errors), {
        retriable: false,
      });
    }

    const semantic = validateJobRequestSemantics(request);
    if (!semantic.valid) {
      throw new HttpError(400, "INVALID_JOB_REQUEST", summarizeErrors(semantic.errors), {
        retriable: false,
      });
    }

    if (store.jobsById.size >= store.limits.maxJobs) {
      throw new HttpError(
        400,
        "RESOURCE_LIMIT",
        `job limit of ${store.limits.maxJobs} reached`,
        { retriable: false },
      );
    }

    // Asset registration + digest agreement.
    const assetErrors = validateRegisteredAssets(request);
    if (assetErrors.length > 0) {
      throw new HttpError(400, "ASSET_VALIDATION_FAILED", summarizeErrors(assetErrors), {
        retriable: false,
      });
    }

    // Build and validate on a provisional store so partial state is never
    // published when lifecycle/event/manifest generation fails.
    const provisional = createProvisionalStore(store);
    const nextJobCounter = store.counters.jobs + 1;
    const idSuffix = `mock_${padCounter(nextJobCounter, 4)}`;
    const jobId = `job_${idSuffix}`;
    const job = createInitialJobRecord({
      jobId,
      idSuffix,
      request,
      clock,
    });
    job.requestCanonical = stableStringify(request);

    provisional.jobsById.set(jobId, job);
    provisional.jobsByIdempotencyKey.set(request.idempotencyKey, jobId);
    provisional.eventsByJobId.set(jobId, []);
    provisional.counters.jobs = nextJobCounter;

    try {
      emitCreatedEvent(provisional, job);

      const outcome = mockOutcomeFromRequest(request);
      if (autoAdvance) {
        if (outcome.type === "success") {
          advanceToSuccess(provisional, job);
        } else if (outcome.type === "fail") {
          advanceToFailure(provisional, job, outcome.error);
        } else if (outcome.type === "expire") {
          advanceToExpired(provisional, job, outcome.message);
        } else if (outcome.type === "hold") {
          const path = ["VALIDATING", "QUEUED", "PREPROCESSING", "RENDERING"];
          for (const state of path) {
            if (state === outcome.advanceTo || !isTerminalJobState(job.status.state)) {
              transitionJob(provisional, job, state);
              if (state === outcome.advanceTo) break;
            }
          }
        } else if (outcome.type === "created_only") {
          // dryRun: remain CREATED
        }
      }

      // Validate produced terminal documents when present.
      if (job.status.state === "SUCCEEDED") {
        const manifest = provisional.manifestsByJobId.get(jobId);
        const manifestValidation = await validateDocument("LayerManifest", manifest);
        if (!manifestValidation.valid) {
          throw new HttpError(
            500,
            "MANIFEST_INVALID",
            summarizeErrors(manifestValidation.errors),
            { retriable: false },
          );
        }
        const manifestSemantic = validateManifestSemantics(manifest);
        if (!manifestSemantic.valid) {
          throw new HttpError(500, "MANIFEST_INVALID", summarizeErrors(manifestSemantic.errors), {
            retriable: false,
          });
        }
      }

      const stream = provisional.eventsByJobId.get(jobId);
      const streamCheck = validateJobEventStream(stream, { requireContiguousFrom: 0 });
      if (!streamCheck.valid) {
        throw new HttpError(500, "EVENT_STREAM_INVALID", summarizeErrors(streamCheck.errors), {
          retriable: false,
        });
      }
    } catch (error) {
      // Provisional maps are discarded; live store is untouched.
      if (error instanceof HttpError) {
        throw error;
      }
      // Lifecycle/event limit failures become resource errors without publication.
      throw new HttpError(
        400,
        "RESOURCE_LIMIT",
        error?.message ?? "job generation failed resource limits",
        { retriable: false },
      );
    }

    // Atomic publication after full validation.
    store.counters.jobs = nextJobCounter;
    store.jobsById.set(jobId, job);
    store.jobsByIdempotencyKey.set(request.idempotencyKey, jobId);
    store.eventsByJobId.set(jobId, provisional.eventsByJobId.get(jobId));
    const manifest = provisional.manifestsByJobId.get(jobId);
    if (manifest) {
      store.manifestsByJobId.set(jobId, manifest);
    }

    // Never log user-controlled effect labels or other protected content.
    logger.info("job created", {
      jobId,
      state: job.status.state,
      idempotencyKey: request.idempotencyKey,
      hasEffectSpec: Boolean(request.effectSpec),
    });

    return { status: 201, body: snapshotStatus(job) };
  }

  function createJob(request, headerIdempotencyKey) {
    return runMutationExclusive(() => createJobUnlocked(request, headerIdempotencyKey));
  }

  function requireEventCapacity(job, count) {
    const events = store.eventsByJobId.get(job.status.jobId);
    if (!events) {
      throw new HttpError(500, "INTERNAL", "event index corrupted", { retriable: true });
    }
    if (events.length + count > store.limits.maxEventsPerJob) {
      throw new HttpError(
        400,
        "RESOURCE_LIMIT",
        `event limit of ${store.limits.maxEventsPerJob} reached for job ${job.status.jobId}`,
        { retriable: false },
      );
    }
  }

  function getJob(jobId) {
    const job = requireJob(jobId);
    return { status: 200, body: snapshotStatus(job) };
  }

  function getJobEvents(jobId, afterSequence = -1) {
    const job = requireJob(jobId);
    if (!Number.isInteger(afterSequence) || afterSequence < -1) {
      throw new HttpError(400, "INVALID_QUERY", "afterSequence must be an integer >= -1", {
        retriable: false,
      });
    }
    return {
      status: 200,
      body: {
        jobId: job.jobId,
        events: listEvents(store, jobId, afterSequence),
      },
    };
  }

  function cancelJob(jobId) {
    const job = requireJob(jobId);
    if (job.status.state === "CANCELLED") {
      // Idempotent cancellation: return current terminal snapshot.
      return { status: 200, body: snapshotStatus(job) };
    }
    if (isTerminalJobState(job.status.state)) {
      throw new HttpError(
        409,
        "JOB_TERMINAL",
        `job ${jobId} is already terminal in state ${job.status.state}`,
        { retriable: false },
      );
    }

    requireEventCapacity(job, 2);
    transitionJob(store, job, "CANCELLED", {
      message: "Cancellation accepted",
      progressRatio: job.status.progress?.ratio ?? 0.4,
      stage: job.status.progress?.stage ?? "cancelled",
    });
    logger.info("job cancelled", { jobId, state: job.status.state });
    return { status: 200, body: snapshotStatus(job) };
  }

  function getJobManifest(jobId) {
    const job = requireJob(jobId);
    if (job.status.state !== "SUCCEEDED") {
      throw new HttpError(
        409,
        "MANIFEST_UNAVAILABLE",
        `job ${jobId} has not succeeded; manifest unavailable`,
        { retriable: false },
      );
    }
    const manifest = getManifest(store, jobId);
    if (!manifest) {
      throw new HttpError(404, "MANIFEST_NOT_FOUND", `manifest for job ${jobId} not found`, {
        retriable: false,
      });
    }
    return { status: 200, body: manifest };
  }

  /**
   * Test/helper: force a non-success terminal path on an existing active job.
   * Not exposed over HTTP.
   */
  function forceFail(jobId, error) {
    const job = requireJob(jobId);
    if (isTerminalJobState(job.status.state)) {
      throw new HttpError(409, "JOB_TERMINAL", "job already terminal", { retriable: false });
    }
    requireEventCapacity(job, job.status.state === "CREATED" ? 3 : 2);
    advanceToFailure(store, job, error);
    return snapshotStatus(job);
  }

  function forceExpire(jobId, message) {
    const job = requireJob(jobId);
    if (isTerminalJobState(job.status.state)) {
      throw new HttpError(409, "JOB_TERMINAL", "job already terminal", { retriable: false });
    }
    requireEventCapacity(job, 1);
    advanceToExpired(store, job, message);
    return snapshotStatus(job);
  }

  return {
    store,
    createAsset,
    createJob,
    getJob,
    getJobEvents,
    cancelJob,
    getJobManifest,
    forceFail,
    forceExpire,
    logger,
  };
}

/**
 * Shallow-isolated store view that shares limits and asset registry but uses
 * provisional maps for job publication so failed creates leave no residue.
 */
function createProvisionalStore(live) {
  return {
    limits: live.limits,
    assetsById: live.assetsById,
    jobsById: new Map(),
    jobsByIdempotencyKey: new Map(),
    eventsByJobId: new Map(),
    manifestsByJobId: new Map(),
    counters: { ...live.counters },
  };
}

function summarizeErrors(errors) {

  if (!Array.isArray(errors) || errors.length === 0) {
    return "validation failed";
  }
  return errors
    .slice(0, 5)
    .map((error) => `${error.path ?? "#"}: ${error.message}`)
    .join("; ")
    .slice(0, 512);
}

export { mockOutcomeFromRequest };
