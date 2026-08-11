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

export function createStore(limits = DEFAULT_LIMITS) {
  return {
    limits: { ...DEFAULT_LIMITS, ...limits },
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
