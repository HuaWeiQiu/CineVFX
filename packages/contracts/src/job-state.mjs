/** Monotonic active lifecycle for Mock jobs. */
export const ACTIVE_JOB_STATES = Object.freeze([
  "CREATED",
  "VALIDATING",
  "QUEUED",
  "PREPROCESSING",
  "RENDERING",
  "POSTPROCESSING",
  "EXPORTING",
]);

/** Successful completion is only reachable from EXPORTING. */
export const SUCCESS_TERMINAL_STATE = "SUCCEEDED";

/** Terminal alternatives from any active state (not success). */
export const ALTERNATIVE_TERMINAL_STATES = Object.freeze([
  "FAILED",
  "CANCELLED",
  "EXPIRED",
]);

export const TERMINAL_JOB_STATES = Object.freeze([
  SUCCESS_TERMINAL_STATE,
  ...ALTERNATIVE_TERMINAL_STATES,
]);

export const JOB_STATES = Object.freeze([
  ...ACTIVE_JOB_STATES,
  ...TERMINAL_JOB_STATES,
]);

const ACTIVE_INDEX = new Map(ACTIVE_JOB_STATES.map((state, index) => [state, index]));

/**
 * Returns true when `to` is a legal next state from `from`.
 *
 * Rules:
 * - Active states advance only one step forward.
 * - Success is permitted only from EXPORTING -> SUCCEEDED.
 * - FAILED, CANCELLED, and EXPIRED are alternatives from any active state.
 * - Terminal states have no successors (except self for idempotent snapshots).
 */
export function isAllowedJobTransition(from, to) {
  if (!JOB_STATES.includes(from) || !JOB_STATES.includes(to)) {
    return false;
  }
  if (from === to) {
    return true;
  }
  if (TERMINAL_JOB_STATES.includes(from)) {
    return false;
  }
  if (to === SUCCESS_TERMINAL_STATE) {
    return from === "EXPORTING";
  }
  if (ALTERNATIVE_TERMINAL_STATES.includes(to)) {
    return true;
  }
  const fromIndex = ACTIVE_INDEX.get(from);
  const toIndex = ACTIVE_INDEX.get(to);
  return fromIndex !== undefined && toIndex !== undefined && toIndex === fromIndex + 1;
}

export function isTerminalJobState(state) {
  return TERMINAL_JOB_STATES.includes(state);
}

export function requiresManifest(state) {
  return state === SUCCESS_TERMINAL_STATE;
}

/**
 * Full transition matrix helper for tests and documentation.
 * Returns a map of fromState -> allowed next states (excluding self).
 */
export function allowedNextStates(from) {
  return JOB_STATES.filter((to) => to !== from && isAllowedJobTransition(from, to));
}
