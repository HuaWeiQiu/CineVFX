/**
 * In-memory store for Mock API resources.
 * Bounded resource counts prevent unbounded growth in long-running local use.
 */

import { cloneJson } from "./util.mjs";

export const DEFAULT_LIMITS = Object.freeze({
  maxAssets: 256,
  maxJobs: 128,
  maxEventsPerJob: 256,
  maxBodyBytes: 256 * 1024,
});

const LIMIT_NAMES = Object.freeze(Object.keys(DEFAULT_LIMITS));

function normalizeLimits(limits) {
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    throw new TypeError("limits must be an object");
  }
  for (const key of Object.keys(limits)) {
    if (!LIMIT_NAMES.includes(key)) {
      throw new TypeError(`unknown resource limit ${key}`);
    }
  }
  const resolved = { ...DEFAULT_LIMITS, ...limits };
  for (const name of LIMIT_NAMES) {
    if (
      !Number.isSafeInteger(resolved[name]) ||
      resolved[name] < 1 ||
      resolved[name] > DEFAULT_LIMITS[name]
    ) {
      throw new TypeError(
        `${name} must be a positive safe integer no greater than ${DEFAULT_LIMITS[name]}`,
      );
    }
  }
  return resolved;
}

export function createStore(limits = DEFAULT_LIMITS) {
  return {
    limits: Object.freeze(normalizeLimits(limits)),
    assetsById: new Map(),
    jobsById: new Map(),
    jobsByIdempotencyKey: new Map(),
    eventsByJobId: new Map(),
    manifestsByJobId: new Map(),
    counters: {
      jobs: 0,
      events: 0,
    },
  };
}

export function snapshotStatus(job) {
  return cloneJson(job.status);
}

export function listEvents(store, jobId, afterSequence = -1) {
  const events = store.eventsByJobId.get(jobId) ?? [];
  return events
    .filter((event) => event.sequence > afterSequence)
    .map((event) => cloneJson(event));
}

export function getManifest(store, jobId) {
  const manifest = store.manifestsByJobId.get(jobId);
  return manifest ? cloneJson(manifest) : null;
}
