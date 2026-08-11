/**
 * Deterministic monotonic job lifecycle for the Mock API.
 * Success path advances one active step at a time, then EXPORTING -> SUCCEEDED.
 */

import {
  ACTIVE_JOB_STATES,
  isAllowedJobTransition,
  isTerminalJobState,
} from "../../../packages/contracts/src/index.mjs";
import { buildFixedLayerManifest } from "./manifest-factory.mjs";
import { cloneJson, formatIsoUtc, padCounter } from "./util.mjs";

const STAGE_BY_STATE = Object.freeze({
  CREATED: "accepted",
  VALIDATING: "validating",
  QUEUED: "queued",
  PREPROCESSING: "preprocessing",
  RENDERING: "render_passes",
  POSTPROCESSING: "postprocessing",
  EXPORTING: "exporting",
  SUCCEEDED: "complete",
  FAILED: "failed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
});

const PROGRESS_BY_STATE = Object.freeze({
  CREATED: 0,
  VALIDATING: 0.05,
  QUEUED: 0.1,
  PREPROCESSING: 0.25,
  RENDERING: 0.55,
  POSTPROCESSING: 0.8,
  EXPORTING: 0.95,
  SUCCEEDED: 1,
});

function nextSequence(job) {
  const next = job.nextSequence;
  job.nextSequence += 1;
  return next;
}

function eventId(jobId, sequence) {
  const suffix = padCounter(sequence, 4);
  const base = `evt_${jobId}_${suffix}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return base.slice(0, 62);
}

function pushEvent(store, job, event) {
  const list = store.eventsByJobId.get(job.status.jobId);
  if (!list) {
    throw new Error(`event list missing for job ${job.status.jobId}`);
  }
  if (list.length >= store.limits.maxEventsPerJob) {
    throw new Error(
      `event limit of ${store.limits.maxEventsPerJob} reached for job ${job.status.jobId}`,
    );
  }

  const sequence = nextSequence(job);
  const full = {
    schemaVersion: "1.0.0",
    eventId: eventId(job.status.jobId, sequence),
    jobId: job.status.jobId,
    sequence,
    timestamp: event.timestamp ?? job.clock(),
    type: event.type,
    state: event.state,
  };
  if (event.message !== undefined) full.message = event.message;
  if (event.progress !== undefined) full.progress = event.progress;
  if (event.error !== undefined) full.error = event.error;
  if (event.assetRef !== undefined) full.assetRef = event.assetRef;
  if (event.manifestId !== undefined) full.manifestId = event.manifestId;

  list.push(full);
  job.status.eventCount = list.length;
  job.status.updatedAt = full.timestamp;
  return full;
}

function setActiveProgress(job, state, message) {
  job.status.state = state;
  job.status.progress = {
    ratio: PROGRESS_BY_STATE[state] ?? 0,
    stage: STAGE_BY_STATE[state] ?? state.toLowerCase(),
  };
  if (message) {
    job.status.progress.message = message;
  }
}

/**
 * Append events and update status for an allowed transition.
 */
export function transitionJob(store, job, toState, options = {}) {
  const from = job.status.state;
  if (!isAllowedJobTransition(from, toState) || from === toState) {
    throw new Error(`illegal transition ${from} -> ${toState}`);
  }
  if (isTerminalJobState(from)) {
    throw new Error(`terminal job cannot transition from ${from}`);
  }

  const timestamp = options.timestamp ?? job.clock();
  const message = options.message ?? `Entered ${toState.toLowerCase()}`;

  if (toState === "SUCCEEDED") {
    const manifestId =
      options.manifestId ?? `manifest_${job.status.jobId.replace(/^job_/, "")}`;
    const manifest = buildFixedLayerManifest({
      jobId: job.status.jobId,
      manifestId,
      canvas: job.request.effectSpec.canvas,
      protectedSource: job.request.protectedSource,
      createdAt: timestamp,
      jobSuffix: job.idSuffix,
    });
    store.manifestsByJobId.set(job.status.jobId, manifest);

    for (const pass of manifest.passes) {
      pushEvent(store, job, {
        type: "asset_ready",
        state: "EXPORTING",
        timestamp,
        assetRef: {
          assetId: pass.asset.assetId,
          digest: pass.asset.digest,
        },
        message: `${pass.name} pass asset ready`,
      });
    }

    job.status.state = "SUCCEEDED";
    job.status.progress = {
      ratio: 1,
      stage: "complete",
      message: options.successMessage ?? "Manifest ready",
    };
    job.status.finishedAt = timestamp;
    job.status.updatedAt = timestamp;
    job.status.manifestId = manifestId;
    job.status.cancelRequested = false;
    delete job.status.error;

    pushEvent(store, job, {
      type: "state_changed",
      state: "SUCCEEDED",
      timestamp,
      message: "Job succeeded",
    });
    pushEvent(store, job, {
      type: "manifest_ready",
      state: "SUCCEEDED",
      timestamp,
      manifestId,
      message: "Validated Layer Manifest published",
    });
    job.terminal = true;
    return;
  }

  if (toState === "FAILED") {
    const error = options.error ?? {
      code: "JOB_FAILED",
      message: "Job failed",
      retriable: false,
    };
    job.status.state = "FAILED";
    job.status.progress = {
      ratio: options.progressRatio ?? job.status.progress?.ratio ?? 0.3,
      stage: options.stage ?? STAGE_BY_STATE.FAILED,
      message: error.message,
    };
    job.status.finishedAt = timestamp;
    job.status.updatedAt = timestamp;
    job.status.cancelRequested = false;
    job.status.error = cloneJson(error);
    delete job.status.manifestId;

    pushEvent(store, job, {
      type: "state_changed",
      state: "FAILED",
      timestamp,
      message: "Job failed",
    });
    pushEvent(store, job, {
      type: "error",
      state: "FAILED",
      timestamp,
      error: cloneJson(error),
      message: error.message,
    });
    job.terminal = true;
    return;
  }

  if (toState === "CANCELLED") {
    job.status.state = "CANCELLED";
    job.status.cancelRequested = true;
    job.status.progress = {
      ratio: options.progressRatio ?? job.status.progress?.ratio ?? 0.4,
      stage: options.stage ?? STAGE_BY_STATE.CANCELLED,
      message: options.message ?? "Cancellation accepted",
    };
    job.status.finishedAt = timestamp;
    job.status.updatedAt = timestamp;
    delete job.status.error;
    delete job.status.manifestId;

    pushEvent(store, job, {
      type: "state_changed",
      state: "CANCELLED",
      timestamp,
      message: "Job cancelled",
    });
    pushEvent(store, job, {
      type: "cancel_accepted",
      state: "CANCELLED",
      timestamp,
      message: "Cancellation completed",
    });
    job.terminal = true;
    return;
  }

  if (toState === "EXPIRED") {
    job.status.state = "EXPIRED";
    job.status.cancelRequested = false;
    job.status.progress = {
      ratio: options.progressRatio ?? job.status.progress?.ratio ?? 0,
      stage: options.stage ?? STAGE_BY_STATE.EXPIRED,
      message: options.message ?? "TTL elapsed before completion",
    };
    job.status.finishedAt = timestamp;
    job.status.updatedAt = timestamp;
    delete job.status.error;
    delete job.status.manifestId;

    pushEvent(store, job, {
      type: "state_changed",
      state: "EXPIRED",
      timestamp,
      message: options.message ?? "Job expired",
    });
    job.terminal = true;
    return;
  }

  if (!ACTIVE_JOB_STATES.includes(toState)) {
    throw new Error(`unknown target state ${toState}`);
  }

  setActiveProgress(job, toState, message);
  job.status.updatedAt = timestamp;
  if (!job.status.startedAt && toState !== "CREATED") {
    job.status.startedAt = timestamp;
  }

  pushEvent(store, job, {
    type: "state_changed",
    state: toState,
    timestamp,
    message,
  });

  if (toState === "RENDERING") {
    pushEvent(store, job, {
      type: "progress",
      state: "RENDERING",
      timestamp,
      progress: {
        ratio: PROGRESS_BY_STATE.RENDERING,
        stage: STAGE_BY_STATE.RENDERING,
      },
      message: "Rendering editable passes",
    });
  }
}

/**
 * Advance a job along the full success path in one deterministic pass.
 */
export function advanceToSuccess(store, job) {
  const path = [
    "VALIDATING",
    "QUEUED",
    "PREPROCESSING",
    "RENDERING",
    "POSTPROCESSING",
    "EXPORTING",
    "SUCCEEDED",
  ];
  for (const state of path) {
    if (isTerminalJobState(job.status.state)) {
      break;
    }
    transitionJob(store, job, state);
  }
}

export function advanceToFailure(store, job, error) {
  if (job.status.state === "CREATED") {
    transitionJob(store, job, "VALIDATING", { message: "Validating input assets" });
  }
  if (!isTerminalJobState(job.status.state)) {
    transitionJob(store, job, "FAILED", {
      error,
      progressRatio: 0.3,
      stage: "validating",
    });
  }
}

export function advanceToExpired(store, job, message = "TTL elapsed before start") {
  if (!isTerminalJobState(job.status.state)) {
    transitionJob(store, job, "EXPIRED", {
      message,
      progressRatio: 0,
      stage: "queued",
    });
  }
}

export function createInitialJobRecord({
  jobId,
  idSuffix,
  request,
  clock = formatIsoUtc,
}) {
  const now = clock();
  return {
    jobId,
    idSuffix,
    request: cloneJson(request),
    requestCanonical: null,
    clock,
    nextSequence: 0,
    terminal: false,
    status: {
      schemaVersion: "1.0.0",
      jobId,
      idempotencyKey: request.idempotencyKey,
      state: "CREATED",
      progress: {
        ratio: 0,
        stage: "accepted",
        message: "Job accepted",
      },
      createdAt: now,
      updatedAt: now,
      cancelRequested: false,
      eventCount: 0,
    },
  };
}

export function emitCreatedEvent(store, job) {
  pushEvent(store, job, {
    type: "state_changed",
    state: "CREATED",
    message: "Job accepted",
  });
}

export { STAGE_BY_STATE, PROGRESS_BY_STATE };
