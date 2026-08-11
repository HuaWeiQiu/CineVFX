import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  documentSchemas,
  forbiddenExamplePatterns,
  mockEndpoints,
  packageRoot,
  repoRoot,
  schemaFiles,
  schemaForExampleFileName,
} from "./catalog.mjs";
import { validateAgainstSchema } from "../src/validate-json-schema.mjs";
import { validateManifestSemantics } from "../src/manifest.mjs";
import { validateJobRequestSemantics } from "../src/job-request.mjs";
import { validateJobEventSemantics, validateJobEventStream } from "../src/job-event.mjs";
import {
  isAllowedJobTransition,
  ACTIVE_JOB_STATES,
  ALTERNATIVE_TERMINAL_STATES,
} from "../src/job-state.mjs";
import { buildGeneratedTypesText, buildMetaJson } from "./generate-types.mjs";

const errors = [];

function fail(message) {
  errors.push(message);
}

async function mustExist(relativePath, root = packageRoot) {
  const absolute = path.join(root, relativePath);
  try {
    await access(absolute);
  } catch {
    fail(`Missing required file: ${path.relative(repoRoot, absolute)}`);
  }
  return absolute;
}

async function readJson(absolutePath) {
  return JSON.parse(await readFile(absolutePath, "utf8"));
}

async function validateExample(fileName, data, kind) {
  const schemaName = schemaForExampleFileName(fileName);
  const result = await validateAgainstSchema(data, schemaName);
  const errorsLocal = [...result.errors];

  if (fileName.startsWith("layer-manifest.")) {
    errorsLocal.push(...validateManifestSemantics(data).errors);
  }
  if (fileName.startsWith("job-request.")) {
    errorsLocal.push(...validateJobRequestSemantics(data).errors);
  }
  if (fileName.startsWith("job-event.")) {
    errorsLocal.push(...validateJobEventSemantics(data).errors);
  }

  if (kind === "valid" && errorsLocal.length > 0) {
    fail(
      `Valid example ${fileName} failed: ${JSON.stringify(errorsLocal.slice(0, 4))}`,
    );
  }
  if (kind === "invalid" && errorsLocal.length === 0) {
    fail(`Invalid example ${fileName} unexpectedly validated`);
  }
  return errorsLocal.length === 0;
}

async function main() {
  for (const schema of schemaFiles) {
    await mustExist(path.join("schemas", schema));
  }
  await mustExist("openapi/openapi.json", repoRoot);
  await mustExist("docs/contracts/README.md", repoRoot);
  await mustExist("docs/contracts/state-machine.md", repoRoot);

  for (const schema of schemaFiles) {
    const absolute = path.join(packageRoot, "schemas", schema);
    try {
      const doc = await readJson(absolute);
      if (schema !== "common.schema.json" && doc.title == null) {
        fail(`${schema} must declare title`);
      }
      if (documentSchemas.includes(schema)) {
        if (doc.$schema !== "https://json-schema.org/draft/2020-12/schema") {
          fail(`${schema} must use draft 2020-12`);
        }
        if (doc.type !== "object") {
          fail(`${schema} root must be object`);
        }
      }
      // Relative $id keeps package-local $ref resolution standards-compliant.
      if (doc.$id && String(doc.$id).startsWith("https://")) {
        fail(`${schema} must use a relative $id, got ${doc.$id}`);
      }
    } catch (error) {
      fail(`Schema parse failed for ${schema}: ${error.message}`);
    }
  }

  const validDir = path.join(packageRoot, "examples/valid");
  const invalidDir = path.join(packageRoot, "examples/invalid");
  const validFiles = (await readdir(validDir)).filter((name) => name.endsWith(".json")).sort();
  const invalidFiles = (await readdir(invalidDir)).filter((name) => name.endsWith(".json")).sort();

  if (validFiles.length < 10) {
    fail(`Expected at least 10 valid examples, found ${validFiles.length}`);
  }
  if (invalidFiles.length < 8) {
    fail(`Expected at least 8 invalid examples, found ${invalidFiles.length}`);
  }

  const requiredInvalidSubstrings = [
    "malformed-version",
    "bad-digest",
    "missing-idempotency",
    "illegal-transition-state",
    "succeeded-without-manifest",
    "error-without-payload",
    "non-editable-pass",
    "unverified-asset",
    "digest-mismatch",
    "empty-passes",
    "missing-referenced-asset",
    "cancel-in-created",
    "reordered-passes",
    "status-created-with-manifest",
    "duplicate-sequence",
  ];
  for (const fragment of requiredInvalidSubstrings) {
    if (!invalidFiles.some((name) => name.includes(fragment))) {
      fail(`Missing invalid example covering ${fragment}`);
    }
  }

  for (const fileName of validFiles) {
    const absolute = path.join(validDir, fileName);
    const text = await readFile(absolute, "utf8");
    for (const pattern of forbiddenExamplePatterns) {
      if (pattern.regex.test(text)) {
        fail(`Valid example ${fileName} contains forbidden ${pattern.name}`);
      }
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      fail(`Valid example ${fileName} is not JSON: ${error.message}`);
      continue;
    }
    await validateExample(fileName, data, "valid");
    if (fileName.startsWith("layer-manifest.")) {
      if (!Array.isArray(data.passes) || data.passes.length === 0) {
        fail(`Successful manifest example ${fileName} must include editable passes`);
      }
    }
    if (fileName.includes("golden-magic") || fileName.includes("golden_magic")) {
      if (!text.includes("benchmark")) {
        fail(`Golden magic example ${fileName} must be labeled as a benchmark fixture`);
      }
    }
  }

  for (const fileName of invalidFiles) {
    const absolute = path.join(invalidDir, fileName);
    const text = await readFile(absolute, "utf8");
    for (const pattern of forbiddenExamplePatterns) {
      if (pattern.regex.test(text)) {
        fail(`Invalid example ${fileName} contains forbidden ${pattern.name}`);
      }
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      fail(`Invalid example ${fileName} is not JSON: ${error.message}`);
      continue;
    }
    // Stream-level invalid fixture
    if (fileName.includes("duplicate-sequence") && data.events) {
      const stream = validateJobEventStream(data.events);
      if (stream.valid) {
        fail(`Invalid example ${fileName} unexpectedly validated as event stream`);
      }
      continue;
    }
    await validateExample(fileName, data, "invalid");
  }

  // OpenAPI must cover all six Mock endpoints and reference schemas.
  const openapiPath = path.join(repoRoot, "openapi/openapi.json");
  const openapi = await readJson(openapiPath);
  if (openapi.openapi !== "3.1.0") {
    fail("OpenAPI version must be 3.1.0");
  }
  for (const endpoint of mockEndpoints) {
    const pathItem = openapi.paths?.[endpoint.path];
    if (!pathItem) {
      fail(`OpenAPI missing path ${endpoint.path}`);
      continue;
    }
    const operation = pathItem[endpoint.method];
    if (!operation) {
      fail(`OpenAPI missing ${endpoint.method.toUpperCase()} ${endpoint.path}`);
      continue;
    }
    if (operation.operationId !== endpoint.operationId) {
      fail(
        `OpenAPI operationId for ${endpoint.method.toUpperCase()} ${endpoint.path} expected ${endpoint.operationId}, got ${operation.operationId}`,
      );
    }
  }

  // createJob 200 replay must include JobStatus body and idempotency semantics.
  const createJob = openapi.paths["/v1/jobs"]?.post;
  const replay200 = createJob?.responses?.["200"];
  const replaySchema = replay200?.content?.["application/json"]?.schema;
  if (!replaySchema || !JSON.stringify(replaySchema).includes("JobStatus")) {
    fail("OpenAPI createJob 200 replay response must declare JobStatus schema");
  }
  if (!String(createJob?.description ?? "").includes("idempotencyKey")) {
    fail("OpenAPI createJob must document body/header idempotencyKey equality");
  }

  const requiredComponentSchemas = [
    "EffectSpec",
    "AssetDescriptor",
    "JobRequest",
    "JobStatus",
    "JobEvent",
    "LayerManifest",
  ];
  for (const name of requiredComponentSchemas) {
    const schema = openapi.components?.schemas?.[name];
    if (!schema) {
      fail(`OpenAPI components.schemas missing ${name}`);
      continue;
    }
    const expected =
      name === "EffectSpec"
        ? "effect-spec"
        : name === "AssetDescriptor"
          ? "asset-descriptor"
          : name === "JobRequest"
            ? "job-request"
            : name === "JobStatus"
              ? "job-status"
              : name === "JobEvent"
                ? "job-event"
                : "layer-manifest";
    if (!schema.$ref || !String(schema.$ref).includes(`/schemas/${expected}.schema.json`)) {
      fail(`OpenAPI schema ${name} must $ref the packages/contracts schema file`);
    }
  }

  // Lifecycle matrix.
  for (let i = 0; i < ACTIVE_JOB_STATES.length - 1; i += 1) {
    const from = ACTIVE_JOB_STATES[i];
    const to = ACTIVE_JOB_STATES[i + 1];
    if (!isAllowedJobTransition(from, to)) {
      fail(`Expected allowed transition ${from} -> ${to}`);
    }
    if (i + 2 < ACTIVE_JOB_STATES.length) {
      const skip = ACTIVE_JOB_STATES[i + 2];
      if (isAllowedJobTransition(from, skip)) {
        fail(`Expected disallowed skip transition ${from} -> ${skip}`);
      }
    }
  }
  if (isAllowedJobTransition("CREATED", "SUCCEEDED")) {
    fail("CREATED -> SUCCEEDED must be disallowed");
  }
  if (isAllowedJobTransition("RENDERING", "SUCCEEDED")) {
    fail("RENDERING -> SUCCEEDED must be disallowed");
  }
  if (!isAllowedJobTransition("EXPORTING", "SUCCEEDED")) {
    fail("EXPORTING -> SUCCEEDED must be allowed");
  }
  for (const active of ACTIVE_JOB_STATES) {
    for (const alt of ALTERNATIVE_TERMINAL_STATES) {
      if (!isAllowedJobTransition(active, alt)) {
        fail(`${active} -> ${alt} must be allowed`);
      }
    }
  }
  if (isAllowedJobTransition("SUCCEEDED", "FAILED")) {
    fail("Terminal states must not transition");
  }

  // Generated types must be up to date without rewriting (read-only safe).
  try {
    const expectedTypes = await buildGeneratedTypesText();
    const actualTypes = await readFile(
      path.join(packageRoot, "generated/types.d.ts"),
      "utf8",
    );
    if (actualTypes !== expectedTypes) {
      fail("generated/types.d.ts is stale; run packages/contracts build");
    }
    const expectedMeta = buildMetaJson();
    const actualMeta = await readFile(
      path.join(packageRoot, "generated/meta.json"),
      "utf8",
    );
    if (actualMeta !== expectedMeta) {
      fail("generated/meta.json is stale; run packages/contracts build");
    }
    if (!actualTypes.includes("export type JobStatus =")) {
      fail("generated types must include discriminated JobStatus");
    }
    if (!actualTypes.includes('type: "manifest_ready"')) {
      fail("generated types must include discriminated JobEvent");
    }
  } catch (error) {
    fail(`Generated type drift check failed: ${error.message}`);
  }

  // Golden magic is not a schema discriminator.
  const effectSpec = await readJson(path.join(packageRoot, "schemas/effect-spec.schema.json"));
  const effectSpecText = JSON.stringify(effectSpec);
  if (/magic-only|mode.*magic|effectMode/i.test(effectSpecText)) {
    fail("EffectSpec schema must not hard-code magic as a product mode");
  }

  if (errors.length > 0) {
    console.error("Contract check failed:");
    for (const error of errors) {
      console.error(` - ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Contracts check passed: ${schemaFiles.length} schemas, ${validFiles.length} valid examples, ${invalidFiles.length} invalid examples, ${mockEndpoints.length} OpenAPI endpoints.`,
  );
}

await main();
