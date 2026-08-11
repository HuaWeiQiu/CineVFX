import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");

export const packageRoot = PACKAGE_ROOT;
export const repoRoot = REPO_ROOT;

export const schemaFiles = [
  "common.schema.json",
  "effect-spec.schema.json",
  "asset-descriptor.schema.json",
  "job-request.schema.json",
  "job-status.schema.json",
  "job-event.schema.json",
  "layer-manifest.schema.json",
];

/** Map example file prefix to schema file. */
export const exampleSchemaByPrefix = {
  "effect-spec": "effect-spec.schema.json",
  "asset-descriptor": "asset-descriptor.schema.json",
  "job-request": "job-request.schema.json",
  "job-status": "job-status.schema.json",
  "job-event": "job-event.schema.json",
  "layer-manifest": "layer-manifest.schema.json",
};

export const documentSchemas = [
  "effect-spec.schema.json",
  "asset-descriptor.schema.json",
  "job-request.schema.json",
  "job-status.schema.json",
  "job-event.schema.json",
  "layer-manifest.schema.json",
];

export const mockEndpoints = [
  { method: "post", path: "/v1/assets", operationId: "createAsset" },
  { method: "post", path: "/v1/jobs", operationId: "createJob" },
  { method: "get", path: "/v1/jobs/{id}", operationId: "getJob" },
  { method: "get", path: "/v1/jobs/{id}/events", operationId: "listJobEvents" },
  { method: "post", path: "/v1/jobs/{id}/cancel", operationId: "cancelJob" },
  { method: "get", path: "/v1/jobs/{id}/manifest", operationId: "getJobManifest" },
];

export const forbiddenExamplePatterns = [
  { name: "data-url-image-bytes", regex: /data:image\//i },
  { name: "base64-blob", regex: /"content"\s*:\s*"[A-Za-z0-9+/]{80,}={0,2}"/ },
  { name: "prompt-field", regex: /"prompt"\s*:/i },
  { name: "password-field", regex: /"password"\s*:/i },
  { name: "api-key-field", regex: /"api[_-]?key"\s*:/i },
  { name: "absolute-unix-path", regex: /"(?:\/Users\/|\/home\/|\/var\/|\/tmp\/)/ },
  { name: "absolute-windows-path", regex: /"[A-Za-z]:\\\\/ },
  { name: "bearer-token", regex: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/i },
];

export function schemaForExampleFileName(fileName) {
  const prefix = Object.keys(exampleSchemaByPrefix).find((key) => fileName.startsWith(`${key}.`));
  if (!prefix) {
    throw new Error(`No schema mapping for example ${fileName}`);
  }
  return exampleSchemaByPrefix[prefix];
}
