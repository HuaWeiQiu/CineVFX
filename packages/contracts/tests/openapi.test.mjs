import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  mockEndpoints,
  schemaForExampleFileName,
} from "../scripts/catalog.mjs";
import { validateAgainstSchema } from "../src/validate-json-schema.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("OpenAPI covers the six Mock endpoints and six document schemas", async () => {
  const openapi = JSON.parse(
    await readFile(path.join(repoRoot, "openapi/openapi.json"), "utf8"),
  );
  assert.equal(openapi.openapi, "3.1.0");
  assert.equal(mockEndpoints.length, 6);

  for (const endpoint of mockEndpoints) {
    const operation = openapi.paths?.[endpoint.path]?.[endpoint.method];
    assert.ok(operation, `${endpoint.method} ${endpoint.path}`);
    assert.equal(operation.operationId, endpoint.operationId);
  }

  for (const name of [
    "EffectSpec",
    "AssetDescriptor",
    "JobRequest",
    "JobStatus",
    "JobEvent",
    "LayerManifest",
  ]) {
    const schema = openapi.components.schemas[name];
    assert.ok(schema?.$ref, name);
    assert.match(schema.$ref, /packages\/contracts\/schemas\//);
  }
});

test("OpenAPI examples reference package fixtures", async () => {
  const openapi = JSON.parse(
    await readFile(path.join(repoRoot, "openapi/openapi.json"), "utf8"),
  );
  const examples = openapi.components.examples;
  assert.ok(examples.JobRequestMock);
  assert.ok(examples.LayerManifestSucceeded);
  assert.ok(examples.JobStatusCancelled);
  for (const example of Object.values(examples)) {
    assert.ok(example.externalValue);
    assert.match(example.externalValue, /packages\/contracts\/examples\/valid\//);
  }
});

test("OpenAPI external schema and example references resolve", async () => {
  const openapiPath = path.join(repoRoot, "openapi/openapi.json");
  const openapiDir = path.dirname(openapiPath);
  const openapi = JSON.parse(await readFile(openapiPath, "utf8"));

  for (const [name, schemaRef] of Object.entries(openapi.components.schemas)) {
    if (!schemaRef.$ref?.startsWith("../")) continue;
    const schemaPath = path.resolve(openapiDir, schemaRef.$ref);
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    assert.ok(schema.title, `${name} external schema should resolve`);
    assert.equal(
      String(schema.$id).startsWith("https://"),
      false,
      `${name} must keep relative schema identifiers resolvable`,
    );
  }

  for (const [name, exampleRef] of Object.entries(openapi.components.examples)) {
    const examplePath = path.resolve(openapiDir, exampleRef.externalValue);
    const example = JSON.parse(await readFile(examplePath, "utf8"));
    const schemaFile = schemaForExampleFileName(path.basename(examplePath));
    const result = await validateAgainstSchema(example, schemaFile);
    assert.equal(
      result.valid,
      true,
      `${name} should validate: ${JSON.stringify(result.errors)}`,
    );
  }
});
