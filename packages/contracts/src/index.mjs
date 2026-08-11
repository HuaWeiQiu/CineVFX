export {
  ACTIVE_JOB_STATES,
  ALTERNATIVE_TERMINAL_STATES,
  SUCCESS_TERMINAL_STATE,
  TERMINAL_JOB_STATES,
  JOB_STATES,
  isAllowedJobTransition,
  isTerminalJobState,
  requiresManifest,
  allowedNextStates,
} from "./job-state.mjs";
export {
  loadSchema,
  validateAgainstSchema,
  clearSchemaCache,
} from "./validate-json-schema.mjs";
export { validateManifestSemantics } from "./manifest.mjs";
export {
  validateJobRequestSemantics,
  validateIdempotencyKeyPair,
} from "./job-request.mjs";
export {
  validateJobEventSemantics,
  validateJobEventStream,
} from "./job-event.mjs";
export { validateDocument } from "./validate-document.mjs";

export const CONTRACT_SCHEMA_VERSION = "1.0.0";

export const SCHEMA_FILES = Object.freeze({
  EffectSpec: "effect-spec.schema.json",
  AssetDescriptor: "asset-descriptor.schema.json",
  JobRequest: "job-request.schema.json",
  JobStatus: "job-status.schema.json",
  JobEvent: "job-event.schema.json",
  LayerManifest: "layer-manifest.schema.json",
});

export const MOCK_ENDPOINTS = Object.freeze([
  "POST /v1/assets",
  "POST /v1/jobs",
  "GET /v1/jobs/{id}",
  "GET /v1/jobs/{id}/events",
  "POST /v1/jobs/{id}/cancel",
  "GET /v1/jobs/{id}/manifest",
]);
