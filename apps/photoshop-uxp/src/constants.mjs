/**
 * Shared constants for the UXP development shell.
 * Real marketplace plugin identity is UNVERIFIED / not claimed.
 */

export const SCHEMA_VERSION = "1.0.0";

export const DEFAULT_BASE_URL = "https://localhost:8787";

/** Exact loopback origins declared by manifest.json for the development API. */
export const ALLOWED_API_ORIGINS = Object.freeze([
  "https://localhost:8787",
  "https://127.0.0.1:8787",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
]);

/** Development-only plugin id from manifest.json — not a signed marketplace id. */
export const DEV_PLUGIN_ID = "com.cinevfx.dev.shell";

export const MOCK_ENDPOINTS = Object.freeze([
  "POST /v1/assets",
  "POST /v1/jobs",
  "GET /v1/jobs/{id}",
  "GET /v1/jobs/{id}/events",
  "POST /v1/jobs/{id}/cancel",
  "GET /v1/jobs/{id}/manifest",
]);

export const FORBIDDEN_SOURCE_OPS = Object.freeze([
  "modify_pixels",
  "move",
  "transform",
  "resize",
  "replace",
  "warp",
  "delete",
]);

export const TASK_STATES = Object.freeze({
  IDLE: "idle",
  PLANNING_PROXY: "planning_proxy",
  SUBMITTING: "submitting",
  POLLING: "polling",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELLED: "cancelled",
  IMPORT_PLANNED: "import_planned",
});

export const ACTIVE_JOB_STATES = Object.freeze([
  "CREATED",
  "VALIDATING",
  "QUEUED",
  "PREPROCESSING",
  "RENDERING",
  "POSTPROCESSING",
  "EXPORTING",
]);

export const TERMINAL_JOB_STATES = Object.freeze([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
]);

/** Capabilities that remain UNVERIFIED in this development shell. */
export const UNVERIFIED = Object.freeze({
  photoshopProxyExport: true,
  executeAsModalHistoryUndo: true,
  layerPlacement: true,
  sourcePreservationRuntime: true,
  windowsRuntime: true,
  oneClickSignedInstall: true,
  realPluginId: true,
  marketplaceCompatibility: true,
  runtimeSuccess: true,
});
