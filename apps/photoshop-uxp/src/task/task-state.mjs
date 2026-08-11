/**
 * Panel task state machine for the Mock vertical slice.
 */

import { TASK_STATES } from "../constants.mjs";

const TRANSITIONS = Object.freeze({
  [TASK_STATES.IDLE]: new Set([
    TASK_STATES.PLANNING_PROXY,
    TASK_STATES.SUBMITTING,
  ]),
  [TASK_STATES.PLANNING_PROXY]: new Set([
    TASK_STATES.IDLE,
    TASK_STATES.SUBMITTING,
    TASK_STATES.FAILED,
  ]),
  [TASK_STATES.SUBMITTING]: new Set([
    TASK_STATES.POLLING,
    TASK_STATES.SUCCEEDED,
    TASK_STATES.FAILED,
    TASK_STATES.CANCELLED,
  ]),
  [TASK_STATES.POLLING]: new Set([
    TASK_STATES.SUCCEEDED,
    TASK_STATES.FAILED,
    TASK_STATES.CANCELLED,
  ]),
  [TASK_STATES.SUCCEEDED]: new Set([
    TASK_STATES.IMPORT_PLANNED,
    TASK_STATES.IDLE,
  ]),
  [TASK_STATES.FAILED]: new Set([TASK_STATES.IDLE, TASK_STATES.SUBMITTING]),
  [TASK_STATES.CANCELLED]: new Set([TASK_STATES.IDLE, TASK_STATES.SUBMITTING]),
  [TASK_STATES.IMPORT_PLANNED]: new Set([TASK_STATES.IDLE]),
});

/**
 * @typedef {typeof TASK_STATES[keyof typeof TASK_STATES]} TaskState
 */

/**
 * @typedef {{
 *   state: TaskState,
 *   jobId: string | null,
 *   manifestId: string | null,
 *   progress: { ratio: number, stage: string, message?: string },
 *   lastError: { code?: string, message: string } | null,
 *   effectLabel: string,
 *   cancelRequested: boolean,
 *   proxyPlan: unknown | null,
 *   importPlan: unknown | null,
 *   updatedAt: string,
 * }} TaskSnapshot
 */

/**
 * @param {Partial<TaskSnapshot>} [seed]
 */
export function createTaskController(seed = {}) {
  /** @type {TaskSnapshot} */
  let snapshot = {
    state: TASK_STATES.IDLE,
    jobId: null,
    manifestId: null,
    progress: { ratio: 0, stage: "ready" },
    lastError: null,
    effectLabel: "effect",
    cancelRequested: false,
    proxyPlan: null,
    importPlan: null,
    updatedAt: nowIso(),
    ...seed,
  };

  /** @type {Set<(s: TaskSnapshot) => void>} */
  const listeners = new Set();

  function emit() {
    const frozen = getSnapshot();
    for (const listener of listeners) listener(frozen);
  }

  function getSnapshot() {
    return {
      ...snapshot,
      progress: { ...snapshot.progress },
      lastError: snapshot.lastError ? { ...snapshot.lastError } : null,
    };
  }

  /**
   * @param {TaskState} next
   * @param {Partial<TaskSnapshot>} [patch]
   */
  function transition(next, patch = {}) {
    const allowed = TRANSITIONS[snapshot.state];
    if (!allowed || !allowed.has(next)) {
      throw new Error(`illegal task transition ${snapshot.state} -> ${next}`);
    }
    snapshot = {
      ...snapshot,
      ...patch,
      state: next,
      updatedAt: nowIso(),
    };
    emit();
    return getSnapshot();
  }

  /**
   * @param {Partial<TaskSnapshot>} patch
   */
  function patch(patchFields) {
    snapshot = {
      ...snapshot,
      ...patchFields,
      progress: patchFields.progress
        ? { ...patchFields.progress }
        : snapshot.progress,
      updatedAt: nowIso(),
    };
    emit();
    return getSnapshot();
  }

  return {
    getSnapshot,
    /**
     * @param {(s: TaskSnapshot) => void} listener
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /**
     * @param {unknown} proxyPlan
     */
    beginProxyPlanning(proxyPlan) {
      return transition(TASK_STATES.PLANNING_PROXY, {
        proxyPlan,
        lastError: null,
      });
    },
    finishProxyPlanning() {
      if (snapshot.state === TASK_STATES.PLANNING_PROXY) {
        return transition(TASK_STATES.IDLE, {});
      }
      return getSnapshot();
    },
    /**
     * @param {{ effectLabel?: string }} [opts]
     */
    beginSubmit(opts = {}) {
      return transition(TASK_STATES.SUBMITTING, {
        effectLabel: opts.effectLabel ?? snapshot.effectLabel,
        lastError: null,
        cancelRequested: false,
        jobId: null,
        manifestId: null,
        importPlan: null,
        progress: { ratio: 0, stage: "submit" },
      });
    },
    /**
     * @param {{ jobId: string, progress?: TaskSnapshot['progress'] }} info
     */
    markPolling(info) {
      return transition(TASK_STATES.POLLING, {
        jobId: info.jobId,
        progress: info.progress ?? { ratio: 0.05, stage: "queued" },
      });
    },
    /**
     * @param {TaskSnapshot['progress']} progress
     */
    updateProgress(progress) {
      if (
        snapshot.state !== TASK_STATES.POLLING &&
        snapshot.state !== TASK_STATES.SUBMITTING
      ) {
        return getSnapshot();
      }
      return patch({ progress });
    },
    /**
     * @param {{ jobId: string, manifestId: string }} info
     */
    markSucceeded(info) {
      return transition(TASK_STATES.SUCCEEDED, {
        jobId: info.jobId,
        manifestId: info.manifestId,
        progress: { ratio: 1, stage: "succeeded" },
        lastError: null,
        cancelRequested: false,
      });
    },
    /**
     * @param {{ code?: string, message: string }} error
     */
    markFailed(error) {
      return transition(TASK_STATES.FAILED, {
        lastError: { code: error.code, message: error.message },
        progress: {
          ratio: snapshot.progress.ratio,
          stage: "failed",
          message: error.message,
        },
      });
    },
    markCancelRequested() {
      return patch({ cancelRequested: true });
    },
    markCancelled() {
      return transition(TASK_STATES.CANCELLED, {
        progress: { ratio: snapshot.progress.ratio, stage: "cancelled" },
      });
    },
    /**
     * @param {unknown} importPlan
     */
    markImportPlanned(importPlan) {
      return transition(TASK_STATES.IMPORT_PLANNED, { importPlan });
    },
    reset() {
      const from = snapshot.state;
      if (from === TASK_STATES.IDLE) return getSnapshot();
      // Allow reset only from terminal-ish UI states via explicit transitions.
      if (
        from === TASK_STATES.SUCCEEDED ||
        from === TASK_STATES.FAILED ||
        from === TASK_STATES.CANCELLED ||
        from === TASK_STATES.IMPORT_PLANNED ||
        from === TASK_STATES.PLANNING_PROXY
      ) {
        snapshot = {
          state: TASK_STATES.IDLE,
          jobId: null,
          manifestId: null,
          progress: { ratio: 0, stage: "ready" },
          lastError: null,
          effectLabel: snapshot.effectLabel,
          cancelRequested: false,
          proxyPlan: snapshot.proxyPlan,
          importPlan: null,
          updatedAt: nowIso(),
        };
        // Use direct assignment for multi-origin reset then emit.
        emit();
        return getSnapshot();
      }
      throw new Error(`cannot reset from ${from}`);
    },
  };
}

function nowIso() {
  return new Date().toISOString();
}

export { TASK_STATES, TRANSITIONS };
